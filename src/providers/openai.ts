import { fetch } from "undici";
import type {
  Provider,
  ChatMessage,
  ChatOptions,
  ProviderMetadata,
} from "./base.js";

export interface OpenAIConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  temperature?: number;
  organization?: string;
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
    };

    if (!this.config.apiKey) {
      throw new Error(
        "OpenAI API key is required. Set OPENAI_API_KEY environment variable or provide it in config."
      );
    }
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    const response = await this.makeRequest("/chat/completions", {
      model: this.config.model,
      messages,
      temperature: options?.temperature ?? this.config.temperature,
      max_tokens: options?.maxTokens,
      top_p: options?.topP,
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
        temperature: options?.temperature ?? this.config.temperature,
        max_tokens: options?.maxTokens,
        top_p: options?.topP,
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
