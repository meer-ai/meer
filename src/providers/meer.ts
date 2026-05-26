import { fetch } from "undici";
import type {
  Provider,
  ChatMessage,
  ChatOptions,
  ProviderMetadata,
} from "./base.js";
import { AuthClient } from "../auth/client.js";
import { AuthStorage } from "../auth/storage.js";

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
  private readonly authStorage = new AuthStorage();
  private readonly authClient: AuthClient;

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
    this.authClient = new AuthClient(this.config.apiUrl);
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
    const token = await this.resolveAuthToken();
    const headers: Record<string, string> = {
      ...((init.headers as Record<string, string>) || {}),
      Authorization: `Bearer ${token}`,
    };

    const response = await fetch(`${this.config.apiUrl}${path}`, {
      ...(init as any),
      headers,
    });

    if (response.status === 401) {
      throw new Error(
        "Meer provider rejected your credentials. Run `meer login` again or configure an API key with `meer setup`."
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

  private async resolveAuthToken(): Promise<string> {
    if (this.config.apiKey && this.config.apiKey.trim().length > 0) {
      return this.config.apiKey.trim();
    }

    const envKey = process.env.MEER_API_KEY;
    if (envKey && envKey.trim().length > 0) {
      this.config.apiKey = envKey.trim();
      return this.config.apiKey;
    }

    const auth = this.authStorage.load();
    if (auth?.access_token) {
      const expiresAt = auth.expires_at ? new Date(auth.expires_at) : null;
      const refreshBeforeExpiryMs = 60_000;
      const isExpired =
        expiresAt instanceof Date &&
        Number.isFinite(expiresAt.getTime()) &&
        expiresAt.getTime() <= Date.now() + refreshBeforeExpiryMs;

      if (!isExpired) {
        return auth.access_token;
      }
    }

    if (auth?.refresh_token) {
      try {
        const refreshed = await this.authClient.refreshToken(auth.refresh_token);
        this.authStorage.save({
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token,
          user: refreshed.user,
          expires_at: new Date(
            Date.now() + refreshed.expires_in * 1000
          ).toISOString(),
        });
        return refreshed.access_token;
      } catch (error) {
        throw new Error(
          `Meer login has expired and refresh failed. Run \`meer login\` again. ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    throw new Error(
      "Meer managed provider is not authenticated. Run `meer login`, set MEER_API_KEY, or run `meer setup` to add an API key."
    );
  }
}
