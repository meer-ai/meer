import { OpenAIProvider, type OpenAIConfig } from "./openai.js";
import type { ProviderMetadata } from "../base.js";

const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const GO_BASE_URL = "https://opencode.ai/zen/go/v1";

export const OPENCODE_ZEN_MODELS = [
  { id: "big-pickle", name: "Big Pickle (free)" },
  { id: "deepseek-v4-flash-free", name: "DeepSeek V4 Flash (free)" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
  { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
  { id: "gpt-5.4", name: "GPT-5.4" },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
  { id: "gpt-5.4-nano", name: "GPT-5.4 Nano" },
  { id: "gpt-5.2", name: "GPT-5.2" },
  { id: "glm-5.1", name: "GLM-5.1" },
  { id: "glm-5", name: "GLM-5" },
  { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
  { id: "gemini-3-flash", name: "Gemini 3 Flash" },
];

export const OPENCODE_GO_MODELS = [
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
  { id: "kimi-k2.6", name: "Kimi K2.6" },
  { id: "kimi-k2.5", name: "Kimi K2.5" },
  { id: "qwen3.6-plus", name: "Qwen3.6 Plus" },
  { id: "qwen3.5-plus", name: "Qwen3.5 Plus" },
  { id: "minimax-m2.7", name: "MiniMax M2.7" },
  { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro" },
  { id: "mimo-v2.5", name: "MiMo V2.5" },
  { id: "glm-5.1", name: "GLM-5.1" },
  { id: "glm-5", name: "GLM-5" },
];

export const DEFAULT_OPENCODE_ZEN_MODEL = "big-pickle";
export const DEFAULT_OPENCODE_GO_MODEL = "deepseek-v4-flash";

export interface OpenCodeConfig {
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

class OpenCodeBase extends OpenAIProvider {
  private readonly providerName: string;
  private readonly knownModels: Array<{ id: string; name: string }>;

  constructor(
    config: OpenCodeConfig,
    baseURL: string,
    providerName: string,
    knownModels: Array<{ id: string; name: string }>,
    envKey = "OPENCODE_API_KEY"
  ) {
    const resolved: OpenAIConfig = {
      apiKey: config.apiKey || process.env[envKey] || "",
      baseURL,
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens ?? 32768,
    };

    if (!resolved.apiKey) {
      throw new Error(
        `OpenCode API key is required. Set ${envKey} environment variable or provide it in config.`
      );
    }

    super(resolved);
    this.providerName = providerName;
    this.knownModels = knownModels;
  }

  async metadata(): Promise<ProviderMetadata> {
    return {
      name: this.providerName,
      version: "1.0.0",
      capabilities: ["chat", "stream"],
      currentModel: this.getCurrentModel(),
    };
  }

  async listModels(): Promise<Array<{ name: string; id: string }>> {
    return this.knownModels.map((m) => ({ name: m.name, id: m.id }));
  }
}

export class OpenCodeZenProvider extends OpenCodeBase {
  constructor(config: OpenCodeConfig) {
    super(config, ZEN_BASE_URL, "OpenCode Zen", OPENCODE_ZEN_MODELS);
  }
}

export class OpenCodeGoProvider extends OpenCodeBase {
  constructor(config: OpenCodeConfig) {
    super(config, GO_BASE_URL, "OpenCode Go", OPENCODE_GO_MODELS);
  }
}
