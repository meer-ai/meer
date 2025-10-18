import { fetch } from "undici";
import type {
  Provider,
  ChatMessage,
  ChatOptions,
  EmbedOptions,
  ProviderMetadata,
} from "./base.js";

export interface ZaiConfig {
  apiKey: string;
  baseURL?: string;
  embeddingBaseURL?: string;
  model: string;
  temperature?: number;
}

export const DEFAULT_ZAI_MODEL = "glm-4";

const DEFAULT_CAPABILITIES = ["chat", "stream", "embeddings"];
const DEFAULT_STANDARD_BASE_URL = "https://api.z.ai/api/paas/v4";
const DEFAULT_CODING_PLAN_BASE_URL = "https://api.z.ai/api/coding/paas/v4";

type ZaiProviderVariant = "coding-plan" | "credit";

interface ZaiProviderOptions {
  defaultBaseURL: string;
  defaultEmbeddingBaseURL: string;
  metadata: ProviderMetadata;
  envBaseURLVar?: string;
  envApiKeyVar?: string;
}

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

class ZaiProviderBase implements Provider {
  protected config: ZaiConfig;
  protected availableModelsCache?: string[];
  protected embeddingBaseURL: string;
  private readonly metadataInfo: ProviderMetadata;

  constructor(config: ZaiConfig, options: ZaiProviderOptions) {
    const model = ZaiProviderBase.normalizeModel(config.model);
    const envApiKey =
      (options.envApiKeyVar && process.env[options.envApiKeyVar]) ?? process.env.ZAI_API_KEY;
    const resolvedApiKey = config.apiKey || envApiKey || "";

    if (!resolvedApiKey) {
      throw new Error(
        "Z.ai API key is required. Set ZAI_API_KEY environment variable or provide it in config."
      );
    }

    const envBaseURL =
      (options.envBaseURLVar && process.env[options.envBaseURLVar]) ?? process.env.ZAI_BASE_URL;
    const resolvedBaseURL = config.baseURL || envBaseURL || options.defaultBaseURL;

    this.config = {
      apiKey: resolvedApiKey,
      baseURL: resolvedBaseURL,
      model,
      temperature: config.temperature ?? 0.7,
    };

    const resolvedEmbedding =
      config.embeddingBaseURL ||
      this.resolveEmbeddingBaseURL(resolvedBaseURL) ||
      options.defaultEmbeddingBaseURL;

    this.embeddingBaseURL = resolvedEmbedding;
    this.metadataInfo = {
      ...options.metadata,
      capabilities: options.metadata.capabilities ?? DEFAULT_CAPABILITIES,
    };
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

  async *stream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string> {
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
          stream: true,
          temperature: options?.temperature ?? this.config.temperature,
          max_tokens: options?.maxTokens,
          top_p: options?.topP,
        }),
      });

      if (!res.ok || !res.body) {
        const error = await res.text();
        throw new Error(`Z.ai streaming API error: ${res.status} ${error}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      return async function* (): AsyncIterable<string> {
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          let newlineIndex: number;
          while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);

            if (!line || !line.startsWith("data:")) continue;

            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              return;
            }

            try {
              const json = JSON.parse(data);
              const delta = json.choices?.[0]?.delta?.content;
              if (typeof delta === "string") {
                yield delta;
              } else if (Array.isArray(delta)) {
                for (const item of delta) {
                  if (item.type === "text" && typeof item.text === "string") {
                    yield item.text;
                  }
                }
              }
            } catch {
              // ignore malformed chunk and continue streaming
            }
          }
        }
      };
    });

    if (typeof response === "function") {
      yield* response();
    }
  }

  async embed(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    const model = options?.model || EMBEDDING_MODEL_FALLBACKS[0];

    const tried: string[] = [];
    let lastUnknownModelError: Error | null = null;

    for (const embeddingModel of EMBEDDING_MODEL_FALLBACKS) {
      tried.push(embeddingModel);

      try {
        const response = await this.makeRequest(
          "/embeddings",
          {
            model: embeddingModel,
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
        `Failed to find a supported Z.ai embedding model (tried: ${tried.join(
          ", "
        )}). Last error: ${lastUnknownModelError.message}`
      );
    }

    throw new Error("Z.ai embedding request failed without a specific error.");
  }

  async metadata(): Promise<ProviderMetadata> {
    return {
      ...this.metadataInfo,
      currentModel: this.config.model,
    };
  }

  async listModels(): Promise<Array<{ name: string; id: string }>> {
    try {
      const response = await this.makeRequest("/models", {}, "GET");
      const models = response.data || [];

      const glmModels = models
        .filter((m: any) => typeof m.id === "string" && m.id.toLowerCase().includes("glm"))
        .map((m: any) => ({
          name: m.id,
          id: m.id,
        }));

      return glmModels;
    } catch (error) {
      throw new Error(
        `Failed to fetch Z.ai models: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  switchModel(modelName: string): void {
    this.config.model = ZaiProviderBase.normalizeModel(modelName);
  }

  getCurrentModel(): string {
    return this.config.model;
  }

  private async executeWithChatModels<T>(executor: (model: string) => Promise<T>): Promise<T> {
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

    return undefined;
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

const BASE_METADATA: ProviderMetadata = {
  name: "Z.ai",
  version: "1.0.0",
  capabilities: DEFAULT_CAPABILITIES,
};

export class ZaiCodingPlanProvider extends ZaiProviderBase {
  constructor(config: ZaiConfig) {
    super(config, {
      defaultBaseURL: DEFAULT_CODING_PLAN_BASE_URL,
      defaultEmbeddingBaseURL: DEFAULT_STANDARD_BASE_URL,
      metadata: {
        ...BASE_METADATA,
        name: "Z.ai Coding Plan",
        plan: "coding-plan",
      },
      envBaseURLVar: "ZAI_CODING_BASE_URL",
    });
  }
}

export class ZaiCreditProvider extends ZaiProviderBase {
  constructor(config: ZaiConfig) {
    super(config, {
      defaultBaseURL: DEFAULT_STANDARD_BASE_URL,
      defaultEmbeddingBaseURL: DEFAULT_STANDARD_BASE_URL,
      metadata: {
        ...BASE_METADATA,
        name: "Z.ai Credit",
        plan: "credit",
      },
      envBaseURLVar: "ZAI_CREDIT_BASE_URL",
    });
  }
}

/**
 * Legacy export for backward compatibility. Historically the CLI only exposed
 * the coding-plan endpoint, so we keep this alias to avoid breaking imports.
 */
export const ZaiProvider = ZaiCodingPlanProvider;

export const normalizeZaiModel = ZaiProviderBase.normalizeModel;

export function getZaiDefaultBaseURL(variant: ZaiProviderVariant): string {
  return variant === "credit" ? DEFAULT_STANDARD_BASE_URL : DEFAULT_CODING_PLAN_BASE_URL;
}
