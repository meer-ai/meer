import {
  AIMessage,
  type BaseMessage,
  type MessageContent,
} from "@langchain/core/messages";
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
} from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import type { ChatMessage, Provider } from "../../providers/base.js";

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

  async _generate(
    messages: BaseMessage[],
    options?: BaseChatModelCallOptions
  ): Promise<ChatResult> {
    const providerMessages = messages.map(toProviderMessage);
    const response = await this.provider.chat(providerMessages);

    return {
      generations: [
        {
          text: response,
          message: new AIMessage(response),
        },
      ],
    };
  }
}
