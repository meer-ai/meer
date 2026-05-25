import { fetch } from "undici";
import type {
  Provider,
  ChatMessage,
  ChatOptions,
  ProviderMetadata,
  ProviderEvent,
  ProviderStructuredTurn,
  AgentMessage,
  ToolDefinition,
} from "./base.js";
import { parseStructuredTurn, textStreamToStructuredEvents } from "./structured.js";

export interface OpenAIConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  temperature?: number;
  organization?: string;
  maxTokens?: number;
}

export class OpenAIProvider implements Provider {
  private config: OpenAIConfig;

  constructor(config: OpenAIConfig) {
    this.config = {
      apiKey: config.apiKey || process.env.OPENAI_API_KEY || "",
      baseURL: config.baseURL || "https://api.openai.com/v1",
      model: config.model,
      temperature: config.temperature ?? 0.7,
      organization: config.organization,
      maxTokens: config.maxTokens ?? 8192,
    };

    if (!this.config.apiKey) {
      throw new Error(
        "OpenAI API key is required. Set OPENAI_API_KEY environment variable or provide it in config."
      );
    }
  }

  // o-series and gpt-5+ models require max_completion_tokens and reject temperature/top_p
  private isReasoningModel(): boolean {
    const m = this.config.model.toLowerCase();
    return /^o\d/.test(m) || /^gpt-[5-9]/.test(m) || /^gpt-\d{2,}/.test(m);
  }

  private tokenParam(override?: number): Record<string, number> {
    const tokens = override ?? this.config.maxTokens ?? 8192;
    return this.isReasoningModel()
      ? { max_completion_tokens: tokens }
      : { max_tokens: tokens };
  }

  private temperatureParams(override?: number): Record<string, number> {
    if (this.isReasoningModel()) return {}; // reasoning models fix temperature=1
    const t = override ?? this.config.temperature ?? 0.7;
    return { temperature: t };
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    const response = await this.makeRequest("/chat/completions", {
      model: this.config.model,
      messages,
      ...this.temperatureParams(options?.temperature),
      ...this.tokenParam(options?.maxTokens),
    });

    return response.choices?.[0]?.message?.content || "";
  }

  async *stream(
    messages: ChatMessage[],
    options?: ChatOptions
  ): AsyncIterable<string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
    };

    if (this.config.organization) {
      headers["OpenAI-Organization"] = this.config.organization;
    }

    const response = await fetch(`${this.config.baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.config.model,
        messages,
        ...this.temperatureParams(options?.temperature),
        ...this.tokenParam(options?.maxTokens),
        stream: true,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Failed to get response reader");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;

          if (trimmed.startsWith("data: ")) {
            try {
              const data = JSON.parse(trimmed.slice(6));
              const content = data.choices?.[0]?.delta?.content;
              if (content) {
                yield content;
              }
            } catch (e) {
              // Skip invalid JSON
              continue;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async chatStructured(
    messages: ChatMessage[],
    options?: ChatOptions
  ): Promise<ProviderStructuredTurn> {
    return parseStructuredTurn(await this.chat(messages, options));
  }

  async *streamEvents(
    messages: ChatMessage[],
    options?: ChatOptions
  ): AsyncIterable<ProviderEvent> {
    yield* textStreamToStructuredEvents(this.stream(messages, options));
  }

  async *streamWithTools(
    messages: AgentMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal
  ): AsyncIterable<ProviderEvent> {
    const converted = this.convertAgentMessages(messages);

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: converted,
      ...this.temperatureParams(),
      ...this.tokenParam(),
      stream: true,
    };
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
      body.tool_choice = "auto";
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
    };
    if (this.config.organization) {
      headers["OpenAI-Organization"] = this.config.organization;
    }

    const response = await fetch(`${this.config.baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: signal as any,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${errText}`);
    }

    type ToolEntry = { id: string; name: string; argumentsBuffer: string };
    const pendingTools = new Map<number, ToolEntry>();
    let rawText = "";
    let hitLengthLimit = false;

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    const processLine = async function* (
      line: string
    ): AsyncGenerator<ProviderEvent> {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "data: [DONE]") return;
      if (!trimmed.startsWith("data: ")) return;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed.slice(6)) as Record<string, unknown>;
      } catch {
        return;
      }

      const choices = parsed.choices as Array<Record<string, unknown>>;
      const choice = choices?.[0];
      if (!choice) return;

      const delta = choice.delta as Record<string, unknown>;
      if (delta) {
        if (typeof delta.content === "string" && delta.content) {
          rawText += delta.content;
          yield { type: "text-delta", text: delta.content };
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
            const idx = (tc.index as number) ?? 0;
            const fn = tc.function as Record<string, unknown> | undefined;

            if (tc.id) {
              pendingTools.set(idx, {
                id: tc.id as string,
                name: (fn?.name as string) ?? "",
                argumentsBuffer: (fn?.arguments as string) ?? "",
              });
              if (fn?.name) {
                yield {
                  type: "tool-call-delta",
                  toolCallId: tc.id as string,
                  toolName: fn.name as string,
                  inputTextDelta: "",
                };
              }
            } else {
              const existing = pendingTools.get(idx);
              if (existing && fn?.arguments) {
                existing.argumentsBuffer += fn.arguments as string;
                yield {
                  type: "tool-call-delta",
                  toolCallId: existing.id,
                  toolName: existing.name,
                  inputTextDelta: fn.arguments as string,
                };
              }
            }
          }
        }
      }

      const finishReason = choice.finish_reason as string | null;

      if (finishReason === "tool_calls") {
        for (const [, tc] of pendingTools) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.argumentsBuffer) as Record<string, unknown>;
          } catch {
            input = { raw: tc.argumentsBuffer };
          }
          yield {
            type: "tool-call",
            toolCall: { id: tc.id, name: tc.name, input },
          };
        }
        pendingTools.clear();
      } else if (finishReason === "length") {
        hitLengthLimit = true;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          const tail = decoder.decode(undefined, { stream: false });
          if (tail) buffer += tail;
          break;
        }
        if (signal?.aborted) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          yield* processLine(line);
        }
      }

      // Drain any remaining buffer content after stream ends
      if (buffer.trim()) {
        for (const line of buffer.split("\n")) {
          yield* processLine(line);
        }
        buffer = "";
      }
    } finally {
      reader.releaseLock();
    }

    // Emit any tool calls that arrived without a finish_reason: "tool_calls" chunk
    if (pendingTools.size > 0) {
      for (const [, tc] of pendingTools) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.argumentsBuffer) as Record<string, unknown>;
        } catch {
          input = { raw: tc.argumentsBuffer };
        }
        yield {
          type: "tool-call",
          toolCall: { id: tc.id, name: tc.name, input },
        };
      }
    }

    if (hitLengthLimit) {
      const note = "\n\n*(Response cut short — token limit reached. Send a follow-up to continue.)*";
      rawText += note;
      yield { type: "text-delta", text: note };
    }

    yield { type: "done", rawText };
  }

  private convertAgentMessages(messages: AgentMessage[]): unknown[] {
    const converted: unknown[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        converted.push({ role: "system", content: msg.content });
      } else if (msg.role === "user") {
        converted.push({ role: "user", content: msg.content });
      } else if (msg.role === "assistant") {
        if (msg.toolCalls?.length) {
          converted.push({
            role: "assistant",
            content: msg.content || null,
            tool_calls: msg.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: JSON.stringify(tc.input) },
            })),
          });
        } else {
          converted.push({ role: "assistant", content: msg.content });
        }
      } else if (msg.role === "tool_result") {
        converted.push({
          role: "tool",
          content: msg.content,
          tool_call_id: msg.toolCallId,
        });
      }
    }

    return converted;
  }

  async metadata(): Promise<ProviderMetadata> {
    return {
      name: "OpenAI",
      version: "1.0.0",
      capabilities: ["chat", "stream"],
      currentModel: this.config.model,
    };
  }

  async listModels(): Promise<Array<{ name: string; id: string }>> {
    try {
      const response = await this.makeRequest("/models", {}, "GET");
      const models = response.data || [];

      // Filter to only chat models
      const chatModels = models
        .filter((m: any) => m.id.includes("gpt") || m.id.includes("o1"))
        .map((m: any) => ({
          name: m.id,
          id: m.id,
        }));

      return chatModels;
    } catch (error) {
      throw new Error(
        `Failed to fetch OpenAI models: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  switchModel(modelName: string): void {
    this.config.model = modelName;
  }

  getCurrentModel(): string {
    return this.config.model;
  }

  private async makeRequest(
    endpoint: string,
    data: any,
    method: string = "POST"
  ): Promise<any> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
    };

    if (this.config.organization) {
      headers["OpenAI-Organization"] = this.config.organization;
    }

    const options: any = {
      method,
      headers,
    };

    if (method === "POST") {
      options.body = JSON.stringify(data);
    }

    const response = await fetch(`${this.config.baseURL}${endpoint}`, options);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${error}`);
    }

    return await response.json();
  }
}
