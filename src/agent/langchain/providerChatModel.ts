import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  type MessageContent,
} from "@langchain/core/messages";
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
} from "@langchain/core/language_models/chat_models";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { ChatMessage, ChatOptions, Provider } from "../../providers/base.js";

export interface ProviderChatModelOptions {
  model?: string;
  providerType?: string;
}

function contentToString(content: MessageContent): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if ("text" in part && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:\w+)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  if (trimmed === "```json" || trimmed === "```") {
    return "";
  }
  return text;
}

function extractBalancedJson(text: string): string | null {
  const firstBrace = text.indexOf("{");
  if (firstBrace === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let result = "";

  for (let i = firstBrace; i < text.length; i++) {
    const char = text[i];
    result += char;

    if (char === '"' && text[i - 1] !== "\\") {
      inString = !inString;
      continue;
    }

    if (inString) {
      if (char === "\\") {
        i += 1;
        if (i < text.length) {
          result += text[i];
        }
      }
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return result;
      }
    }
  }

  return null;
}

function repairJsonString(raw: string): string {
  let inString = false;
  let repaired = "";

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];

    if (char === '"' && raw[i - 1] !== "\\") {
      inString = !inString;
      repaired += char;
      continue;
    }

    if (inString && (char === "\n" || char === "\r")) {
      repaired += "\\n";
      if (char === "\r" && raw[i + 1] === "\n") {
        i += 1;
      }
      continue;
    }

    repaired += char;
  }

  return repaired;
}

function sanitizeStructuredOutput(text: string): string {
  // Don't sanitize - let the model return natural responses
  // Tool calling will be handled through proper LangChain mechanisms
  return text;
}

function toProviderMessage(message: BaseMessage): ChatMessage {
  const content = contentToString(message.content);
  switch (message._getType()) {
    case "system":
      return { role: "system", content };
    case "human":
      return { role: "user", content };
    case "ai":
      return { role: "assistant", content };
    default:
      return { role: "user", content };
  }
}

export class ProviderChatModel extends BaseChatModel<BaseChatModelCallOptions> {
  private provider: Provider;
  private options: ProviderChatModelOptions;

  constructor(provider: Provider, options: ProviderChatModelOptions = {}) {
    super({});
    this.provider = provider;
    this.options = options;
  }

  _llmType(): string {
    const providerType = this.options?.providerType ?? "unknown";
    return `meer-provider:${providerType}`;
  }

  /**
   * Implements bindTools for LangChain 0.3+ compatibility.
   * For StructuredChatAgent, tools are handled through prompts rather than native tool calling,
   * so we return the same instance without modification.
   */
  bindTools(_tools: any[], _kwargs?: any): this {
    // StructuredChatAgent doesn't use native tool calling via bindTools
    // It formats tools in the prompt instead
    // So we simply return this instance without binding anything
    return this;
  }

  async _generate(
    messages: BaseMessage[],
    options?: BaseChatModelCallOptions
  ): Promise<ChatResult> {
    const providerMessages = messages.map(toProviderMessage);
    const chatOptions = this.buildChatOptions(options);
    const abortSignal = this.getAbortSignal(options);
    const response = await this.callWithAbort(
      () => this.provider.chat(providerMessages, chatOptions),
      abortSignal
    );
    const sanitized = sanitizeStructuredOutput(String(response));

    return {
      generations: [
        {
          text: sanitized,
          message: new AIMessage(sanitized),
        },
      ],
    };
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: BaseChatModelCallOptions,
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    const providerMessages = messages.map(toProviderMessage);
    const chatOptions = this.buildChatOptions(options);
    const abortSignal = this.getAbortSignal(options);

    if (abortSignal?.aborted) {
      throw new Error("AbortError: The operation was aborted.");
    }

    const stream = this.provider.stream(providerMessages, chatOptions);
    for await (const chunk of stream) {
      if (abortSignal?.aborted) {
        throw new Error("AbortError: The operation was aborted.");
      }
      const text = typeof chunk === "string" ? chunk : String(chunk ?? "");
      if (!text) {
        continue;
      }
      if (runManager) {
        await runManager.handleLLMNewToken(text);
      }
      yield new ChatGenerationChunk({
        text,
        message: new AIMessageChunk({ content: text }),
      });
    }
  }

  private buildChatOptions(
    options?: BaseChatModelCallOptions
  ): ChatOptions | undefined {
    if (!options) {
      return undefined;
    }
    const optionEntries = { ...(options as Record<string, unknown>) };
    return optionEntries as ChatOptions;
  }

  private getAbortSignal(
    options?: BaseChatModelCallOptions
  ): AbortSignal | undefined {
    if (!options) {
      return undefined;
    }
    const signal = (options as Record<string, unknown>).signal;
    if (
      signal &&
      typeof signal === "object" &&
      "aborted" in (signal as Record<string, unknown>)
    ) {
      return signal as AbortSignal;
    }
    return undefined;
  }

  private async callWithAbort<T>(
    factory: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (!signal) {
      return factory();
    }
    if (signal.aborted) {
      throw new Error("AbortError: The operation was aborted.");
    }
    return await new Promise<T>((resolve, reject) => {
      const abortHandler = () =>
        reject(new Error("AbortError: The operation was aborted."));
      signal.addEventListener("abort", abortHandler, { once: true });
      factory()
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abortHandler));
    });
  }
}
