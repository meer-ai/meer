import { OpenAIProvider, type OpenAIConfig } from "./openai.js";
import type { ProviderMetadata } from "./base.js";

// DeepSeek exposes an OpenAI-compatible API, so we reuse OpenAIProvider with a
// different base URL and key. https://api-docs.deepseek.com/
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";

// `deepseek-chat` and `deepseek-reasoner` are stable aliases that DeepSeek
// repoints at the latest generation (currently V4), so these IDs keep working
// across releases — the labels stay version-light to avoid going stale.
export const DEEPSEEK_MODELS = [
  { id: "deepseek-chat", name: "DeepSeek Chat (V4)" },
  { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
];

export const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";

export interface DeepSeekConfig {
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export class DeepSeekProvider extends OpenAIProvider {
  constructor(config: DeepSeekConfig) {
    const resolved: OpenAIConfig = {
      apiKey: config.apiKey || process.env.DEEPSEEK_API_KEY || "",
      baseURL: DEEPSEEK_BASE_URL,
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens ?? 8192,
    };
    if (!resolved.apiKey) {
      throw new Error(
        "DeepSeek API key is required. Set DEEPSEEK_API_KEY environment variable or provide it in config."
      );
    }
    super(resolved);
  }

  async metadata(): Promise<ProviderMetadata> {
    return {
      name: "DeepSeek",
      version: "1.0.0",
      capabilities: ["chat", "stream"],
      currentModel: this.getCurrentModel(),
    };
  }

  async listModels(): Promise<Array<{ name: string; id: string }>> {
    return DEEPSEEK_MODELS.map((m) => ({ name: m.name, id: m.id }));
  }
}
