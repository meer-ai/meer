import { fetchWithTimeout, STREAM_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from "../utils/fetch.js";
import type {
  Provider,
  ChatMessage,
  ChatOptions,
  EmbedOptions,
  ProviderMetadata,
  ProviderEvent,
  ProviderStructuredTurn,
  AgentMessage,
  ToolDefinition,
} from "./base.js";
import { parseStructuredTurn, textStreamToStructuredEvents } from "./structured.js";
import { createProviderToolNameRegistry } from "./toolNames.js";
import { buildOpenAIUserContent } from "./openai.js";

export interface OpenRouterConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  siteName?: string;
  siteUrl?: string;
}

export class OpenRouterProvider implements Provider {
  private config: OpenRouterConfig;
  private modelsCache: { models: string[]; timestamp: number } | null = null;
  private readonly CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

  constructor(config: OpenRouterConfig) {
    this.config = {
      apiKey: config.apiKey || process.env.OPENROUTER_API_KEY || "",
      baseURL: config.baseURL || "https://openrouter.ai/api",
      model: config.model,
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 8192,
      siteName: config.siteName || "MeerAI CLI",
      siteUrl: config.siteUrl || "https://github.com/anthropics/meer",
    };
  }

  private shouldPreferStructuredTurns(): boolean {
    return true;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    const signal = options?.signal as AbortSignal | undefined;
    const responseFormat = this.shouldPreferStructuredTurns()
      ? { type: "json_object" }
      : undefined;

    const payload: Record<string, unknown> = {
      model: this.config.model,
      messages: this.convertMessages(messages),
      temperature: options?.temperature ?? this.config.temperature,
      max_tokens: options?.maxTokens ?? this.config.maxTokens,
      stream: false,
    };

    if (responseFormat) {
      payload.response_format = responseFormat;
    }

    const response = await this.makeRequest("/v1/chat/completions", {
      ...payload,
    }, signal);

    return response.choices?.[0]?.message?.content || "";
  }

  async *stream(
    messages: ChatMessage[],
    options?: ChatOptions
  ): AsyncIterable<string> {
    const signal = options?.signal as AbortSignal | undefined;
    const responseFormat = this.shouldPreferStructuredTurns()
      ? { type: "json_object" }
      : undefined;

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: this.convertMessages(messages),
      temperature: options?.temperature ?? this.config.temperature,
      max_tokens: options?.maxTokens ?? this.config.maxTokens,
      stream: true,
    };

    if (responseFormat) {
      body.response_format = responseFormat;
    }

    const response = await fetchWithTimeout(`${this.config.baseURL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
        "HTTP-Referer": this.config.siteUrl || "",
        "X-Title": this.config.siteName || "",
      },
      body: JSON.stringify(body),
      signal,
    }, STREAM_TIMEOUT_MS);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenRouter API error: ${response.status} ${response.statusText}\n${errorText}`
      );
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
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
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") return;

            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) {
                yield content;
              }
            } catch (e) {
              // Skip invalid JSON lines
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
    const toolRegistry = createProviderToolNameRegistry(tools);
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: this.convertAgentMessages(
        toolRegistry.convertAgentMessages(messages)
      ),
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens,
      stream: true,
    };

    if (toolRegistry.providerTools.length > 0) {
      body.tools = toolRegistry.providerTools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
      body.tool_choice = "auto";
    }

    const response = await fetchWithTimeout(`${this.config.baseURL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
        "HTTP-Referer": this.config.siteUrl || "",
        "X-Title": this.config.siteName || "",
      },
      body: JSON.stringify(body),
      signal,
    }, STREAM_TIMEOUT_MS);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenRouter API error: ${response.status} ${response.statusText}\n${errorText}`
      );
    }

    type ToolEntry = { id: string; name: string; argumentsBuffer: string };
    const pendingTools = new Map<number, ToolEntry>();
    let rawText = "";
    let rawReasoningContent = "";
    let hitLengthLimit = false;

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }

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

        if (
          typeof delta.reasoning_content === "string" &&
          delta.reasoning_content
        ) {
          rawReasoningContent += delta.reasoning_content;
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
              if (existing) {
                if (fn?.name && !existing.name) {
                  existing.name = fn.name as string;
                }
                if (fn?.arguments) {
                  existing.argumentsBuffer += fn.arguments as string;
                }
                yield {
                  type: "tool-call-delta",
                  toolCallId: existing.id,
                  toolName: existing.name,
                  inputTextDelta:
                    typeof fn?.arguments === "string" ? (fn.arguments as string) : "",
                };
              }
            }
          }
        }
      }

      if (choice.finish_reason === "length") {
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
        buffer = lines.pop() || "";

        for (const line of lines) {
          for await (const event of processLine(line)) {
            yield event;
          }
        }
      }

      if (buffer.trim()) {
        for await (const event of processLine(buffer)) {
          yield event;
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (pendingTools.size > 0) {
      for (const tc of pendingTools.values()) {
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(tc.argumentsBuffer) as Record<string, unknown>;
        } catch {
          input = { raw: tc.argumentsBuffer };
        }
        yield {
          type: "tool-call",
          toolCall: {
            id: tc.id,
            name: toolRegistry.toOriginalName(tc.name),
            input,
          },
        };
      }
    }

    if (hitLengthLimit) {
      const note =
        "\n\n*(Response cut short — token limit reached. Send a follow-up to continue.)*";
      rawText += note;
      yield { type: "text-delta", text: note };
    }

    yield {
      type: "done",
      rawText,
      reasoningContent: rawReasoningContent || undefined,
    };
  }

  async embed(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    // OpenRouter supports embeddings through various models
    const embeddings: number[][] = [];

    for (const text of texts) {
      const response = await this.makeRequest("/v1/embeddings", {
        model: options?.model || "text-embedding-ada-002", // Default embedding model
        input: text,
      });

      embeddings.push(response.data?.[0]?.embedding || []);
    }

    return embeddings;
  }

  async metadata(): Promise<ProviderMetadata> {
    try {
      // OpenRouter provides a models endpoint
      const response = await this.makeRequest("/v1/models", {});
      const models = response.data || [];

      return {
        name: "OpenRouter",
        version: "1.0.0",
        capabilities: ["chat", "stream", "embed"],
        models: models.map((m: any) => m.id),
        currentModel: this.config.model,
      };
    } catch (error) {
      throw new Error(
        `Failed to fetch OpenRouter models: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  getCurrentModel(): string {
    return this.config.model;
  }

  switchModel(model: string): void {
    this.config.model = model;
  }

  async listModels(): Promise<string[]> {
    return await this.getAvailableModels();
  }

  /**
   * Get available models with caching to avoid frequent API calls
   */
  private async getAvailableModels(): Promise<string[]> {
    // Check cache first
    if (
      this.modelsCache &&
      Date.now() - this.modelsCache.timestamp < this.CACHE_DURATION
    ) {
      return this.modelsCache.models;
    }

    try {
      const response = await this.makeRequest("/v1/models", {});
      const models = response.data?.map((m: any) => m.id) || [];

      if (models.length === 0) {
        throw new Error("No models returned from API");
      }

      // Sort models for better UX (popular models first)
      const sortedModels = this.sortModelsByPopularity(models);

      // Cache the results
      this.modelsCache = {
        models: sortedModels,
        timestamp: Date.now(),
      };

      return sortedModels;
    } catch (error) {
      throw new Error(
        `Failed to fetch OpenRouter models: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Sort models by popularity/relevance
   */
  private sortModelsByPopularity(models: string[]): string[] {
    const popularModels = [
      "anthropic/claude-3.5-sonnet",
      "openai/gpt-4o",
      "anthropic/claude-3-opus",
      "openai/gpt-4o-mini",
      "meta-llama/llama-3.1-405b-instruct",
      "anthropic/claude-3-haiku",
      "google/gemini-pro-1.5",
      "openai/gpt-4-turbo",
      "meta-llama/llama-3.1-70b-instruct",
      "mistralai/mistral-large",
    ];

    const popular = models.filter((m) => popularModels.includes(m));
    const others = models.filter((m) => !popularModels.includes(m)).sort();

    // Return popular models first, then others alphabetically
    return [...popular, ...others];
  }

  private convertMessages(messages: ChatMessage[]): any[] {
    return messages.map((msg) => ({
      role: msg.role,
      content:
        msg.role === "user"
          ? buildOpenAIUserContent(msg.content, msg.attachments)
          : msg.content,
    }));
  }

  private convertAgentMessages(messages: AgentMessage[]): unknown[] {
    const converted: unknown[] = [];
    const pendingToolCallIds = new Set<string>();

    for (const msg of messages) {
      if (msg.role === "system") {
        pendingToolCallIds.clear();
        converted.push({ role: "system", content: msg.content });
      } else if (msg.role === "user") {
        pendingToolCallIds.clear();
        converted.push({
          role: "user",
          content: buildOpenAIUserContent(msg.content, msg.attachments),
        });
      } else if (msg.role === "assistant") {
        pendingToolCallIds.clear();
        if (msg.toolCalls?.length) {
          for (const tc of msg.toolCalls) {
            pendingToolCallIds.add(tc.id);
          }
          converted.push({
            role: "assistant",
            content: msg.content || null,
            ...(msg.reasoningContent
              ? { reasoning_content: msg.reasoningContent }
              : {}),
            tool_calls: msg.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.input),
              },
            })),
          });
        } else {
          converted.push({
            role: "assistant",
            content: msg.content,
            ...(msg.reasoningContent
              ? { reasoning_content: msg.reasoningContent }
              : {}),
          });
        }
      } else if (msg.role === "tool_result") {
        if (!msg.toolCallId || !pendingToolCallIds.has(msg.toolCallId)) {
          converted.push({
            role: "system",
            content: `Previous tool result (${msg.toolName}${msg.isError ? ", error" : ""}):\n${msg.content}`,
          });
          continue;
        }
        pendingToolCallIds.delete(msg.toolCallId);
        converted.push({
          role: "tool",
          content: msg.content,
          tool_call_id: msg.toolCallId,
        });
      }
    }

    return converted;
  }

  private async makeRequest(
    endpoint: string,
    data: any,
    signal?: AbortSignal
  ): Promise<any> {
    const method = endpoint.includes("/models") ? "GET" : "POST";
    const requestOptions: any = {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
        "HTTP-Referer": this.config.siteUrl || "",
        "X-Title": this.config.siteName || "",
      },
    };

    if (method === "POST") {
      requestOptions.body = JSON.stringify(data);
    }

    const response = await fetchWithTimeout(
      `${this.config.baseURL}${endpoint}`,
      { ...requestOptions, signal },
      REQUEST_TIMEOUT_MS
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenRouter API error: ${response.status} ${response.statusText}\n${errorText}`
      );
    }

    return await response.json();
  }
}
