import { OpenAIProvider, type OpenAIConfig } from "./openai.js";
import type { ProviderMetadata } from "../base.js";

// Together AI exposes an OpenAI-compatible API. https://docs.together.ai/
const TOGETHER_BASE_URL = "https://api.together.xyz/v1";

// A curated set of strong coding/general models. Together's full catalog is
// large and changes often, so listModels() queries the live /v1/models endpoint
// (inherited from OpenAIProvider) rather than hard-coding everything.
export const TOGETHER_MODELS = [
  { id: "deepseek-ai/DeepSeek-V3", name: "DeepSeek V3" },
  { id: "deepseek-ai/DeepSeek-R1", name: "DeepSeek R1" },
  { id: "Qwen/Qwen2.5-Coder-32B-Instruct", name: "Qwen2.5 Coder 32B" },
  { id: "Qwen/Qwen2.5-72B-Instruct-Turbo", name: "Qwen2.5 72B Turbo" },
  { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", name: "Llama 3.3 70B Turbo" },
  { id: "mistralai/Mixtral-8x7B-Instruct-v0.1", name: "Mixtral 8x7B" },
];

export const DEFAULT_TOGETHER_MODEL = "deepseek-ai/DeepSeek-V3";

export interface TogetherConfig {
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export class TogetherProvider extends OpenAIProvider {
  constructor(config: TogetherConfig) {
    const resolved: OpenAIConfig = {
      apiKey: config.apiKey || process.env.TOGETHER_API_KEY || "",
      baseURL: TOGETHER_BASE_URL,
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens ?? 8192,
    };
    if (!resolved.apiKey) {
      throw new Error(
        "Together API key is required. Set TOGETHER_API_KEY environment variable or provide it in config."
      );
    }
    super(resolved);
  }

  async metadata(): Promise<ProviderMetadata> {
    return {
      name: "Together AI",
      version: "1.0.0",
      capabilities: ["chat", "stream"],
      currentModel: this.getCurrentModel(),
    };
  }
}
