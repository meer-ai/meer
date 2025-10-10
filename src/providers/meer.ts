import { fetch } from "undici";
import type {
  Provider,
  ChatMessage,
  ChatOptions,
  ProviderMetadata,
} from "./base.js";

interface MeerProviderConfig {
  apiKey?: string;
  apiUrl?: string;
  model?: string;
  temperature?: number;
}

interface MeerChatSuccessResponse {
  success: boolean;
  data?: {
    content: string;
    model: string;
    tier?: string;
    was_fallback?: boolean;
  };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost_usd?: number;
  };
  error?: string;
  message?: string;
}

interface MeerModelsResponse {
  models: Array<{
    id: string;
    name: string;
    provider: string;
    tier: string;
    input_cost_per_million: number;
    output_cost_per_million: number;
    context_window: number | null;
  }>;
}

interface MeerSubscriptionResponse {
  subscription?: {
    plan: {
      name: string;
      display_name: string;
      requests_per_month: number;
      allowed_tiers: string[];
    };
    usage?: {
      requests_this_month: number;
      quota: number;
      remaining: number;
    };
  };
}

export class MeerProvider implements Provider {
  private readonly config: {
    apiUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
  };
  private currentModel: string;

  constructor(config: MeerProviderConfig = {}) {
    const model = config.model || "auto";
    this.config = {
      apiUrl: (
        config.apiUrl ||
        process.env.MEERAI_API_URL ||
        "https://api.meerai.dev"
      ).replace(/\/$/, ""),
      apiKey: config.apiKey || process.env.MEER_API_KEY || "",
      model,
      temperature: config.temperature ?? 0.7,
    };
    this.currentModel = model;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    const response = await this.sendChat(messages, options);
    return response.data?.content ?? "";
  }

  async *stream(
    messages: ChatMessage[],
    options?: ChatOptions
  ): AsyncIterable<string> {
    const response = await this.sendChat(messages, options);
    if (response.data?.content) {
      yield response.data.content;
    }
  }

  async metadata(): Promise<ProviderMetadata> {
    const [models, subscription] = await Promise.all([
      this.fetchWithAuth<MeerModelsResponse>("/api/usage/models"),
      this.fetchWithAuth<MeerSubscriptionResponse>(
        "/api/subscription/current"
      ).catch(() => null),
    ]);

    const planName =
      subscription?.subscription?.plan.display_name || "Unknown Plan";
    const quota = subscription?.subscription?.usage?.quota;

    return {
      name: "Meer Managed Provider",
      version: "1.0.0",
      capabilities: ["chat", "stream"],
      models: models.models.map((model) => ({
        id: model.id,
        name: model.name,
        tier: model.tier,
        provider: model.provider,
      })),
      currentModel: this.currentModel,
      plan: planName,
      quota,
    };
  }

  getCurrentModel(): string {
    return this.currentModel;
  }

  switchModel(model: string): void {
    this.currentModel = model;
  }

  private async sendChat(
    messages: ChatMessage[],
    options?: ChatOptions
  ): Promise<MeerChatSuccessResponse> {
    const body = {
      messages,
      model: this.config.model !== "auto" ? this.config.model : undefined,
      options: {
        temperature: options?.temperature ?? this.config.temperature,
        maxTokens: options?.maxTokens,
        topP: options?.topP,
      },
    };

    const response = await this.fetchWithAuth<MeerChatSuccessResponse>(
      "/api/meer/chat",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    if (!response.success) {
      const message =
        response.message ||
        "Meer provider failed to generate a response. Please try again.";
      throw new Error(message);
    }

    if (response.data?.model) {
      this.currentModel = response.data.model;
    }

    return response;
  }

  private async fetchWithAuth<T>(
    path: string,
    init: RequestInit = {}
  ): Promise<T> {
    const apiKey = this.resolveApiKey();
    const headers: Record<string, string> = {
      ...((init.headers as Record<string, string>) || {}),
      Authorization: `Bearer ${apiKey}`,
    };

    const response = await fetch(`${this.config.apiUrl}${path}`, {
      ...(init as any),
      headers,
    });

    if (response.status === 401) {
      throw new Error(
        "Meer provider rejected the API key. Set MEER_API_KEY or configure it via `meer setup`."
      );
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Meer provider request failed (${response.status}): ${
          errorText || response.statusText
        }`
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private resolveApiKey(): string {
    if (this.config.apiKey && this.config.apiKey.trim().length > 0) {
      return this.config.apiKey.trim();
    }

    const envKey = process.env.MEER_API_KEY;
    if (envKey && envKey.trim().length > 0) {
      this.config.apiKey = envKey.trim();
      return this.config.apiKey;
    }

    throw new Error(
      "Meer provider requires an API key. Set MEER_API_KEY or run `meer setup` to add it."
    );
  }
}
