import { fetch } from "undici";
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
import type { MessageAttachment } from "../agent/core/types.js";
import { readAttachmentBase64 } from "../utils/attachments.js";

/**
 * Build the `content` field for an Anthropic user message. When there are no
 * image attachments we return the raw string (the API accepts that shape).
 * With attachments we emit Anthropic's multi-block format:
 *   [{ type: "text", text }, { type: "image", source: { type: "base64", media_type, data } }, ...]
 */
function buildAnthropicUserContent(
  text: string,
  attachments?: MessageAttachment[]
): unknown {
  if (!attachments?.length) {
    return text;
  }
  const blocks: unknown[] = [];
  if (text) {
    blocks.push({ type: "text", text });
  }
  for (const attachment of attachments) {
    if (attachment.kind !== "image") continue;
    const { mimeType, data } = readAttachmentBase64(attachment);
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: mimeType, data },
    });
  }
  if (blocks.length === 0) {
    return text;
  }
  return blocks;
}

export interface AnthropicConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export class AnthropicProvider implements Provider {
  private config: AnthropicConfig;

  constructor(config: AnthropicConfig) {
    this.config = {
      apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY || "",
      baseURL: config.baseURL || "https://api.anthropic.com",
      model: config.model,
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 8192,
    };
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    const response = await this.makeRequest("/v1/messages", {
      model: this.config.model,
      max_tokens: options?.maxTokens ?? this.config.maxTokens,
      messages: this.convertMessages(messages),
      temperature: options?.temperature ?? this.config.temperature,
      stream: false,
    });

    return response.content?.[0]?.text || "";
  }

  async *stream(
    messages: ChatMessage[],
    options?: ChatOptions
  ): AsyncIterable<string> {
    const response = await fetch(`${this.config.baseURL}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: options?.maxTokens ?? this.config.maxTokens,
        messages: this.convertMessages(messages),
        temperature: options?.temperature ?? this.config.temperature,
        stream: true,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Anthropic API error: ${response.status} ${response.statusText}`
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
              if (parsed.type === "content_block_delta" && parsed.delta?.text) {
                yield parsed.delta.text;
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

  async embed(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    // Anthropic doesn't have a dedicated embeddings API
    // This could be implemented using Claude to generate embeddings or throw an error
    throw new Error("Anthropic provider does not support embeddings");
  }

  async metadata(): Promise<ProviderMetadata> {
    // Try to fetch latest models from API
    const models = await this.getAvailableModels();

    return {
      name: "Anthropic",
      version: "1.0.0",
      capabilities: ["chat", "stream"],
      models,
      currentModel: this.config.model,
    };
  }

  /**
   * Get available models from Anthropic's models API with caching
   */
  private async getAvailableModels(): Promise<string[]> {
    try {
      const response = await this.makeRequest("/v1/models", {}, "GET");
      const models = response.data?.map((m: any) => m.id) || [];

      if (models.length === 0) {
        throw new Error("No models returned from API");
      }

      // Sort models by relevance (latest versions first)
      return this.sortModelsByRelevance(models);
    } catch (error) {
      throw new Error(
        `Failed to fetch Anthropic models: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Sort models by relevance (latest versions and popular models first)
   */
  private sortModelsByRelevance(models: string[]): string[] {
    const preferredOrder = [
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
      "claude-3-opus-20240229",
      "claude-3-sonnet-20240229",
      "claude-3-haiku-20240307",
    ];

    const preferred = models.filter((m) => preferredOrder.includes(m));
    const others = models.filter((m) => !preferredOrder.includes(m)).sort();

    return [...preferred, ...others];
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

  async *streamWithTools(
    messages: AgentMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal
  ): AsyncIterable<ProviderEvent> {
    const toolRegistry = createProviderToolNameRegistry(tools);
    const { system, messages: converted } = this.convertAgentMessages(
      toolRegistry.convertAgentMessages(messages)
    );

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      messages: converted,
      stream: true,
    };
    if (system) body.system = system;
    if (toolRegistry.providerTools.length > 0) {
      body.tools = toolRegistry.providerTools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }

    const response = await fetch(`${this.config.baseURL}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: signal as any,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(
        `Anthropic API error: ${response.status} ${response.statusText}\n${errText}`
      );
    }

    type ToolBlock = { id: string; name: string; inputBuffer: string };
    const toolBlocks = new Map<number, ToolBlock>();
    let rawText = "";
    let stopReason = "";

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // Flush any remaining bytes in the TextDecoder
          const tail = decoder.decode(undefined, { stream: false });
          if (tail) buffer += tail;
          break;
        }
        if (signal?.aborted) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data || data === "[DONE]") continue;

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }

          const eventType = parsed.type as string;

          if (eventType === "content_block_start") {
            const block = parsed.content_block as Record<string, unknown>;
            if (block?.type === "tool_use") {
              toolBlocks.set(parsed.index as number, {
                id: block.id as string,
                name: block.name as string,
                inputBuffer: "",
              });
            }
          } else if (eventType === "content_block_delta") {
            const delta = parsed.delta as Record<string, unknown>;
            if (delta?.type === "text_delta") {
              const text = delta.text as string;
              rawText += text;
              yield { type: "text-delta", text };
            } else if (delta?.type === "input_json_delta") {
              const partial = delta.partial_json as string;
              const block = toolBlocks.get(parsed.index as number);
              if (block && partial) {
                block.inputBuffer += partial;
                yield {
                  type: "tool-call-delta",
                  toolCallId: block.id,
                  toolName: toolRegistry.toOriginalName(block.name),
                  inputTextDelta: partial,
                };
              }
            }
          } else if (eventType === "content_block_stop") {
            const block = toolBlocks.get(parsed.index as number);
            if (block) {
              let input: Record<string, unknown> = {};
              try {
                input = JSON.parse(block.inputBuffer) as Record<string, unknown>;
              } catch {
                input = { raw: block.inputBuffer };
              }
              yield {
                type: "tool-call",
                toolCall: {
                  id: block.id,
                  name: toolRegistry.toOriginalName(block.name),
                  input,
                },
              };
              toolBlocks.delete(parsed.index as number);
            }
          } else if (eventType === "message_delta") {
            const delta = parsed.delta as Record<string, unknown>;
            if (delta?.stop_reason) {
              stopReason = delta.stop_reason as string;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Drain any remaining buffer content (e.g. partial line flushed by the decoder)
    if (buffer.trim()) {
      for (const line of buffer.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          if (parsed.type === "message_delta") {
            const delta = parsed.delta as Record<string, unknown>;
            if (delta?.stop_reason) stopReason = delta.stop_reason as string;
          }
        } catch { /* ignore */ }
      }
    }

    // When the model hits the token limit, append a visible continuation note
    if (stopReason === "max_tokens") {
      const note = "\n\n*(Response cut short — token limit reached. Send a follow-up to continue.)*";
      rawText += note;
      yield { type: "text-delta", text: note };
    }

    yield { type: "done", rawText };
  }

  private convertAgentMessages(messages: AgentMessage[]): {
    system: string;
    messages: unknown[];
  } {
    const systemParts: string[] = [];
    const converted: unknown[] = [];

    let i = 0;
    while (i < messages.length) {
      const msg = messages[i];

      if (msg.role === "system") {
        systemParts.push(msg.content);
        i++;
        continue;
      }

      if (msg.role === "user") {
        converted.push({
          role: "user",
          content: buildAnthropicUserContent(msg.content, msg.attachments),
        });
        i++;
        continue;
      }

      if (msg.role === "assistant") {
        const content: unknown[] = [];
        if (msg.content) {
          content.push({ type: "text", text: msg.content });
        }
        for (const tc of msg.toolCalls ?? []) {
          content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
        }
        converted.push({
          role: "assistant",
          content: content.length ? content : [{ type: "text", text: "" }],
        });
        i++;
        continue;
      }

      if (msg.role === "tool_result") {
        const batch: unknown[] = [];
        while (i < messages.length && messages[i].role === "tool_result") {
          const tr = messages[i] as Extract<AgentMessage, { role: "tool_result" }>;
          batch.push({
            type: "tool_result",
            tool_use_id: tr.toolCallId,
            content: tr.content,
            ...(tr.isError ? { is_error: true } : {}),
          });
          i++;
        }
        converted.push({ role: "user", content: batch });
        continue;
      }

      i++;
    }

    return { system: systemParts.join("\n\n"), messages: converted };
  }

  private convertMessages(messages: ChatMessage[]): any[] {
    // Anthropic expects messages without system role mixed in
    const systemMessages = messages.filter((m) => m.role === "system");
    const chatMessages = messages.filter((m) => m.role !== "system");

    const converted = chatMessages.map((msg) => ({
      role: msg.role === "assistant" ? "assistant" : "user",
      content:
        msg.role === "user"
          ? buildAnthropicUserContent(msg.content, msg.attachments)
          : msg.content,
    }));

    // If there are system messages, we need to prepend them as user messages
    // or handle them according to Anthropic's system parameter
    if (systemMessages.length > 0) {
      const systemContent = systemMessages.map((m) => m.content).join("\n\n");
      converted.unshift({
        role: "user",
        content: `System: ${systemContent}\n\nPlease follow the above instructions.`,
      });
    }

    return converted;
  }

  private async makeRequest(
    endpoint: string,
    data: any,
    method: "GET" | "POST" = "POST"
  ): Promise<any> {
    const requestOptions: any = {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
      },
    };

    if (method === "POST") {
      requestOptions.body = JSON.stringify(data);
    }

    const response = await fetch(
      `${this.config.baseURL}${endpoint}`,
      requestOptions
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Anthropic API error: ${response.status} ${response.statusText}\n${errorText}`
      );
    }

    return await response.json();
  }
}
