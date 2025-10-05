import { fetch } from "undici";
import type {
  Provider,
  ChatMessage,
  ChatOptions,
  EmbedOptions,
  ProviderMetadata,
} from "./base.js";

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
      maxTokens: config.maxTokens ?? 4096,
      siteName: config.siteName || "MeerAI CLI",
      siteUrl: config.siteUrl || "https://github.com/anthropics/meer",
    };
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    const response = await this.makeRequest("/v1/chat/completions", {
      model: this.config.model,
      messages: this.convertMessages(messages),
      temperature: options?.temperature ?? this.config.temperature,
      max_tokens: options?.maxTokens ?? this.config.maxTokens,
      stream: false,
    });

    return response.choices?.[0]?.message?.content || "";
  }

  async *stream(
    messages: ChatMessage[],
    options?: ChatOptions
  ): AsyncIterable<string> {
    const response = await fetch(`${this.config.baseURL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
        "HTTP-Referer": this.config.siteUrl || "",
        "X-Title": this.config.siteName || "",
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: this.convertMessages(messages),
        temperature: options?.temperature ?? this.config.temperature,
        max_tokens: options?.maxTokens ?? this.config.maxTokens,
        stream: true,
      }),
    });

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
      content: msg.content,
    }));
  }

  private async makeRequest(endpoint: string, data: any): Promise<any> {
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

    const response = await fetch(
      `${this.config.baseURL}${endpoint}`,
      requestOptions
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
