import { fetch } from "undici";
import type {
  Provider,
  ChatMessage,
  ChatOptions,
  EmbedOptions,
  ProviderMetadata,
} from "./base.js";

/**
 * Z.ai Provider - GLM (General Language Model) Family
 *
 * Z.ai (formerly Zhipu AI) provides the GLM model family:
 * - GLM-4: Flagship model, 200K context (recommended)
 * - GLM-4-Plus: Enhanced capability tier
 * - GLM-4-Air / GLM-4-AirX: Cost-effective, fast options
 * - GLM-4-Flash: Free tier, fast performance
 * - GLM-4V: Vision multimodal capabilities
 *
 * API Endpoints:
 * - Coding Plan (subscription): https://api.z.ai/api/coding/paas/v4 (default)
 * - Standard API (pay-as-you-go): https://api.z.ai/api/paas/v4
 *
 * API Pricing: ~$0.2 per 1M input tokens, $1.1 per 1M output tokens
 * Context: 128K-200K tokens, Max output: 96K tokens
 *
 * Capabilities: Reasoning, coding, agentic tasks, function calling
 * Compatible with: Cline, Claude Code, OpenCode, and other OpenAI-compatible tools
 */
export interface ZaiConfig {
  apiKey: string;
  baseURL?: string;
  embeddingBaseURL?: string;
  model: string;
  temperature?: number;
}

export const DEFAULT_ZAI_MODEL = "glm-4";
const EMBEDDING_MODEL_FALLBACKS = [
  "embedding-3",
  "embeddings-3",
  "text-embedding-3-large",
  "text-embedding-3-small",
  "embedding-2",
  "embeddings-2",
  "text-embedding-ada-002",
];
const LEGACY_MODEL_MAP: Record<string, string> = {
  "glm-4.6": "glm-4",
  "glm-4.5": "glm-4-plus",
  "glm-4.5-air": "glm-4-air",
  "glm-4.5-airx": "glm-4-airx",
  "glm-4.5-x": "glm-4-airx",
  "glm-4.5-flash": "glm-4-flash",
  "glm-4.5v": "glm-4v",
};

const isUnknownModelError = (error: unknown): boolean =>
  error instanceof Error && error.message.toLowerCase().includes("unknown model");

export class ZaiProvider implements Provider {
  private config: ZaiConfig;
  private availableModelsCache?: string[];
  private embeddingBaseURL: string;

  constructor(config: ZaiConfig) {
    const model = ZaiProvider.normalizeModel(config.model);
    const baseURL =
      config.baseURL || process.env.ZAI_BASE_URL || "https://api.z.ai/api/coding/paas/v4";

    this.config = {
      apiKey: config.apiKey || process.env.ZAI_API_KEY || "",
      // Default to Coding Plan API (supports Cline/Claude Code/etc.)
      baseURL,
      model,
      temperature: config.temperature ?? 0.7,
    };
    this.embeddingBaseURL =
      config.embeddingBaseURL ||
      this.resolveEmbeddingBaseURL(baseURL) ||
      "https://api.z.ai/api/paas/v4";

    if (!this.config.apiKey) {
      throw new Error(
        "Z.ai API key is required. Set ZAI_API_KEY environment variable or provide it in config."
      );
    }
  }

  static normalizeModel(model?: string): string {
    const trimmed = model?.trim();
    if (!trimmed) {
      return DEFAULT_ZAI_MODEL;
    }

    const lower = trimmed.toLowerCase();
    return LEGACY_MODEL_MAP[lower] ?? trimmed;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    const response = await this.executeWithChatModels(async (model) => {
      return this.makeRequest("/chat/completions", {
        model,
        messages,
        temperature: options?.temperature ?? this.config.temperature,
        max_tokens: options?.maxTokens,
        top_p: options?.topP,
      });
    });

    return response.choices?.[0]?.message?.content || "";
  }

  async *stream(
    messages: ChatMessage[],
    options?: ChatOptions
  ): AsyncIterable<string> {
    const response = await this.executeWithChatModels(async (model) => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      };

      const res = await fetch(`${this.config.baseURL}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages,
          temperature: options?.temperature ?? this.config.temperature,
          max_tokens: options?.maxTokens,
          top_p: options?.topP,
          stream: true,
        }),
      });

      if (!res.ok) {
        const error = await res.text();
        throw new Error(`Z.ai API error: ${res.status} ${error}`);
      }

      return res;
    });

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

  async embed(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    // Z.ai has a maximum batch size of 64 texts per request
    // Callers should batch requests to stay under this limit
    if (texts.length > 64) {
      throw new Error(
        `Z.ai embedding API supports maximum 64 texts per batch. Received ${texts.length} texts. Please batch your requests.`
      );
    }

    // Z.ai embedding models: embedding-2, embedding-3 (supports dimensions parameter)
    const requestedModel = options?.model?.trim();
    const candidateModels = requestedModel
      ? [requestedModel, ...EMBEDDING_MODEL_FALLBACKS]
      : EMBEDDING_MODEL_FALLBACKS;
    const triedLowercase: string[] = [];
    const triedDisplay: string[] = [];

    let lastUnknownModelError: Error | null = null;

    for (const candidate of candidateModels) {
      const trimmedCandidate = candidate.trim();
      if (!trimmedCandidate) continue;

      const lower = trimmedCandidate.toLowerCase();
      if (triedLowercase.includes(lower)) continue;
      triedLowercase.push(lower);
      triedDisplay.push(trimmedCandidate);

      try {
        const response = await this.makeRequest(
          "/embeddings",
          {
            model: trimmedCandidate,
            input: texts,
          },
          "POST",
          this.embeddingBaseURL
        );

        if (!response.data || !Array.isArray(response.data)) {
          throw new Error("Invalid embedding response format");
        }

        return response.data.map((item: any) => item.embedding);
      } catch (error) {
        if (isUnknownModelError(error)) {
          lastUnknownModelError = error instanceof Error ? error : new Error(String(error));
          continue;
        }
        throw error;
      }
    }

    if (lastUnknownModelError) {
      throw new Error(
        `Failed to find a supported Z.ai embedding model (tried: ${triedDisplay.join(
          ", "
        )}). Last error: ${lastUnknownModelError.message}`
      );
    }

    throw new Error("Z.ai embedding request failed without a specific error.");
  }

  async metadata(): Promise<ProviderMetadata> {
    return {
      name: "Z.ai",
      version: "1.0.0",
      capabilities: ["chat", "stream", "embeddings"],
      currentModel: this.config.model,
    };
  }

  async listModels(): Promise<Array<{ name: string; id: string }>> {
    try {
      const response = await this.makeRequest("/models", {}, "GET");
      const models = response.data || [];

      // Filter to GLM models (Z.ai's primary model family)
      const glmModels = models
        .filter((m: any) => m.id.toLowerCase().includes("glm"))
        .map((m: any) => ({
          name: m.id,
          id: m.id,
        }));

      return glmModels;
    } catch (error) {
      throw new Error(
        `Failed to fetch Z.ai models: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  switchModel(modelName: string): void {
    this.config.model = ZaiProvider.normalizeModel(modelName);
  }

  getCurrentModel(): string {
    return this.config.model;
  }

  private async executeWithChatModels<T>(
    executor: (model: string) => Promise<T>
  ): Promise<T> {
    const candidateModels = await this.getChatModelCandidates(this.config.model);
    const tried: string[] = [];
    let lastUnknownModelError: Error | null = null;

    for (const model of candidateModels) {
      tried.push(model);

      try {
        const result = await executor(model);
        this.config.model = model;
        return result;
      } catch (error) {
        if (isUnknownModelError(error)) {
          lastUnknownModelError = error instanceof Error ? error : new Error(String(error));
          continue;
        }

        throw error;
      }
    }

    if (lastUnknownModelError) {
      throw new Error(
        `Failed to find a supported Z.ai chat model (tried: ${tried.join(
          ", "
        )}). Last error: ${lastUnknownModelError.message}`
      );
    }

    throw new Error("Z.ai chat request failed without a specific error.");
  }

  private async getChatModelCandidates(requestedModel?: string): Promise<string[]> {
    const manualCandidates = [
      requestedModel,
      requestedModel ? LEGACY_MODEL_MAP[requestedModel.trim().toLowerCase()] : undefined,
      DEFAULT_ZAI_MODEL,
      ...Object.values(LEGACY_MODEL_MAP),
      "glm-4-air",
      "glm-4-airx",
      "glm-4-plus",
      "glm-4-flash",
      "glm-4v",
    ];

    const available = await this.fetchAvailableModels();

    const uniqueLower = new Set<string>();
    const orderedCandidates: string[] = [];

    const addCandidate = (value?: string) => {
      if (!value) return;
      const trimmed = value.trim();
      if (!trimmed) return;

      const lower = trimmed.toLowerCase();
      if (uniqueLower.has(lower)) return;
      uniqueLower.add(lower);
      orderedCandidates.push(trimmed);

      const upper = trimmed.toUpperCase();
      const upperLower = upper.toLowerCase();
      if (!uniqueLower.has(upperLower)) {
        uniqueLower.add(upperLower);
        orderedCandidates.push(upper);
      }
    };

    for (const candidate of manualCandidates) {
      addCandidate(candidate);
    }

    for (const model of available) {
      addCandidate(model);
    }

    return orderedCandidates;
  }

  private async fetchAvailableModels(): Promise<string[]> {
    if (!this.availableModelsCache) {
      try {
        const response = await this.makeRequest("/models", {}, "GET");
        const models = Array.isArray(response.data) ? response.data : [];
        this.availableModelsCache = models
          .map((model: any) => model?.id ?? model?.name)
          .filter((id: any): id is string => typeof id === "string");
      } catch {
        this.availableModelsCache = [];
      }
    }

    return this.availableModelsCache ?? [];
  }

  private resolveEmbeddingBaseURL(baseURL: string): string | undefined {
    if (!baseURL) return undefined;

    if (baseURL.includes("/coding/")) {
      return baseURL.replace("/coding", "");
    }

    return baseURL;
  }

  private async makeRequest(
    endpoint: string,
    data: any,
    method: string = "POST",
    baseOverride?: string
  ): Promise<any> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
    };

    const options: any = {
      method,
      headers,
    };

    if (method === "POST") {
      options.body = JSON.stringify(data);
    }

    const baseURL = baseOverride || this.config.baseURL;
    const response = await fetch(`${baseURL}${endpoint}`, options);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Z.ai API error: ${response.status} ${error}`);
    }

    return await response.json();
  }
}
