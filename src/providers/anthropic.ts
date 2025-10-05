import { fetch } from "undici";
import type {
  Provider,
  ChatMessage,
  ChatOptions,
  EmbedOptions,
  ProviderMetadata,
} from "./base.js";

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
      maxTokens: config.maxTokens ?? 4096,
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

  private convertMessages(messages: ChatMessage[]): any[] {
    // Anthropic expects messages without system role mixed in
    const systemMessages = messages.filter((m) => m.role === "system");
    const chatMessages = messages.filter((m) => m.role !== "system");

    const converted = chatMessages.map((msg) => ({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.content,
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
