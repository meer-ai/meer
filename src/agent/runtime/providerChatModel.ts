import type {
  ChatMessage,
  ChatOptions,
  Provider,
  ProviderEvent,
  ProviderStructuredTurn,
} from "../../providers/base.js";
import {
  parseStructuredTurn,
  textStreamToStructuredEvents,
} from "../../providers/structured.js";

export interface ProviderChatModelOptions {
  model?: string;
  providerType?: string;
}

export class ProviderChatModel {
  private provider: Provider;
  private options: ProviderChatModelOptions;

  constructor(provider: Provider, options: ProviderChatModelOptions = {}) {
    this.provider = provider;
    this.options = options;
  }

  getProvider(): Provider {
    return this.provider;
  }

  getProviderType(): string {
    return this.options.providerType ?? "unknown";
  }

  async chat(
    messages: ChatMessage[],
    options?: ChatOptions
  ): Promise<string> {
    return this.provider.chat(messages, options);
  }

  async *streamText(
    messages: ChatMessage[],
    options?: ChatOptions
  ): AsyncIterable<string> {
    yield* this.provider.stream(messages, options);
  }

  async chatStructuredTurn(
    messages: ChatMessage[],
    options?: ChatOptions
  ): Promise<ProviderStructuredTurn> {
    if (this.provider.chatStructured) {
      return this.provider.chatStructured(messages, options);
    }

    const response = await this.provider.chat(messages, options);
    return parseStructuredTurn(String(response));
  }

  async *streamProviderEvents(
    messages: ChatMessage[],
    options?: ChatOptions
  ): AsyncIterable<ProviderEvent> {
    if (this.provider.streamEvents) {
      yield* this.provider.streamEvents(messages, options);
      return;
    }

    yield* textStreamToStructuredEvents(this.provider.stream(messages, options));
  }
}
