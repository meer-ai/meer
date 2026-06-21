/**
 * Provider Wrapper with Retry and Rate-Limit Handling
 *
 * Wraps any provider to add:
 * - Automatic retry with exponential backoff
 * - Rate limit handling
 * - Network error recovery
 * - Request timeout management
 */

import type {
  Provider,
  ChatMessage,
  ChatOptions,
  EmbedOptions,
  ProviderMetadata,
  ProviderEvent,
  ProviderStructuredTurn,
  AgentMessage,
  ToolDefinition,
} from '../base.js';
import { retryWithBackoff, RetryPredicates } from '@meer-ai/core/retry.js';
import { isContextOverflowError } from '@meer-ai/core/provider-errors.js';
import { parseStructuredTurn, textStreamToStructuredEvents } from './structured.js';
import chalk from 'chalk';
import { contextualError } from '@meer-ai/core/errors.js';

export interface ProviderWrapperConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default: 1000) */
  baseDelay?: number;
  /** Maximum delay in ms (default: 30000) */
  maxDelay?: number;
  /** Request timeout in ms (default: 60000) */
  timeout?: number;
  /** Provider name for logging */
  name?: string;
}

/**
 * Wrap a provider with retry and rate-limit handling
 */
export class ProviderWrapper implements Provider {
  private provider: Provider;
  private config: Required<ProviderWrapperConfig>;

  constructor(provider: Provider, config: ProviderWrapperConfig = {}) {
    this.provider = provider;
    this.config = {
      maxRetries: config.maxRetries ?? 3,
      baseDelay: config.baseDelay ?? 1000,
      maxDelay: config.maxDelay ?? 30000,
      timeout: config.timeout ?? 60000,
      name: config.name ?? 'Provider',
    };
  }

  /**
   * Chat with automatic retry
   */
  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    try {
      return await retryWithBackoff(
        () => this.chatWithTimeout(messages, options),
        {
          maxRetries: this.config.maxRetries,
          baseDelay: this.config.baseDelay,
          maxDelay: this.config.maxDelay,
          shouldRetry: this.shouldRetryError.bind(this),
          name: `${this.config.name} chat`,
        }
      );
    } catch (error) {
      throw this.contextualizeProviderError(error, "chat");
    }
  }

  /**
   * Stream with automatic retry (only retries connection establishment)
   */
  async *stream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string> {
    try {
      // Retry the stream establishment
      const streamGenerator = await retryWithBackoff(
        async () => this.provider.stream(messages, options),
        {
          maxRetries: this.config.maxRetries,
          baseDelay: this.config.baseDelay,
          maxDelay: this.config.maxDelay,
          shouldRetry: this.shouldRetryError.bind(this),
          name: `${this.config.name} stream`,
        }
      ) as AsyncIterable<string>;

      // Yield chunks from the stream
      for await (const chunk of streamGenerator) {
        yield chunk;
      }
    } catch (error) {
      throw this.contextualizeProviderError(error, "stream");
    }
  }

  async chatStructured(
    messages: ChatMessage[],
    options?: ChatOptions
  ): Promise<ProviderStructuredTurn> {
    if (this.provider.chatStructured) {
      try {
        return await retryWithBackoff(
          () => this.provider.chatStructured!(messages, options),
          {
            maxRetries: this.config.maxRetries,
            baseDelay: this.config.baseDelay,
            maxDelay: this.config.maxDelay,
            shouldRetry: this.shouldRetryError.bind(this),
            name: `${this.config.name} structured chat`,
          }
        );
      } catch (error) {
        throw this.contextualizeProviderError(error, "structured chat");
      }
    }

    const text = await this.chat(messages, options);
    return parseStructuredTurn(text);
  }

  async *streamEvents(
    messages: ChatMessage[],
    options?: ChatOptions
  ): AsyncIterable<ProviderEvent> {
    if (this.provider.streamEvents) {
      try {
        const streamGenerator = await retryWithBackoff(
          async () => this.provider.streamEvents!(messages, options),
          {
            maxRetries: this.config.maxRetries,
            baseDelay: this.config.baseDelay,
            maxDelay: this.config.maxDelay,
            shouldRetry: this.shouldRetryError.bind(this),
            name: `${this.config.name} event stream`,
          }
        ) as AsyncIterable<ProviderEvent>;

        for await (const event of streamGenerator) {
          yield event;
        }
      } catch (error) {
        throw this.contextualizeProviderError(error, "event stream");
      }
      return;
    }

    yield* textStreamToStructuredEvents(this.stream(messages, options));
  }

  async *streamWithTools(
    messages: AgentMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal
  ): AsyncIterable<ProviderEvent> {
    try {
      if (this.provider.streamWithTools) {
        yield* this.provider.streamWithTools(messages, tools, signal);
        return;
      }

      // XML fallback: inject tool descriptions into system message, convert to ChatMessage[]
      const chatMessages = this.agentMessagesToChat(messages, tools);

      let rawText = "";
      let turn: ProviderStructuredTurn | undefined;

      for await (const event of this.provider.streamEvents
        ? this.provider.streamEvents(chatMessages, { signal } as ChatOptions)
        : textStreamToStructuredEvents(
            this.provider.stream(chatMessages, { signal } as ChatOptions)
          )) {
        if (event.type === "text-delta") {
          rawText += event.text;
        } else if (event.type === "tool-call") {
          yield event;
        } else if (event.type === "done") {
          turn = event.turn;
        } else if (event.type === "assistant-message") {
          yield { type: "text-delta", text: event.text };
          rawText = event.text;
        }
      }

      if (turn?.toolCalls?.length) {
        for (const toolCall of turn.toolCalls) {
          yield { type: "tool-call", toolCall };
        }
      }

      yield { type: "done", rawText, turn };
    } catch (error) {
      throw this.contextualizeProviderError(error, "tool stream");
    }
  }

  private agentMessagesToChat(
    messages: AgentMessage[],
    tools: ToolDefinition[]
  ): ChatMessage[] {
    const result: ChatMessage[] = [];
    const systemParts: string[] = [];

    if (tools.length > 0) {
      const toolsXml = tools
        .map(
          (t) =>
            `<tool name="${t.name}" description="${t.description}">\nInput schema: ${JSON.stringify(t.inputSchema)}\n</tool>`
        )
        .join("\n");
      systemParts.push(
        `## Available Tools\nCall tools using: <tool_call><tool_name>NAME</tool_name><tool_input>JSON</tool_input></tool_call>\n\n${toolsXml}`
      );
    }

    let i = 0;
    while (i < messages.length) {
      const msg = messages[i];

      if (msg.role === "system") {
        systemParts.push(msg.content);
        i++;
        continue;
      }

      if (msg.role === "user") {
        result.push({
          role: "user",
          content: msg.content,
          attachments: msg.attachments,
        });
        i++;
        continue;
      }

      if (msg.role === "assistant") {
        let content = msg.content;
        for (const tc of msg.toolCalls ?? []) {
          content += `\n<tool_call><tool_name>${tc.name}</tool_name><tool_input>${JSON.stringify(tc.input)}</tool_input></tool_call>`;
        }
        result.push({ role: "assistant", content });
        i++;
        continue;
      }

      if (msg.role === "tool_result") {
        const parts: string[] = [];
        while (i < messages.length && messages[i].role === "tool_result") {
          const tr = messages[i] as Extract<AgentMessage, { role: "tool_result" }>;
          parts.push(`Tool: ${tr.toolName ?? "unknown"}\nResult:\n${tr.content}`);
          i++;
        }
        result.push({ role: "user", content: parts.join("\n\n") });
        continue;
      }

      i++;
    }

    if (systemParts.length > 0) {
      result.unshift({ role: "system", content: systemParts.join("\n\n") });
    }

    return result;
  }

  /**
   * Embed with automatic retry
   */
  async embed(texts: string[], options?: EmbedOptions): Promise<number[][]> {
    if (!this.provider.embed) {
      throw new Error(`${this.config.name} provider does not support embeddings`);
    }

    return retryWithBackoff(
      () => this.provider.embed!(texts, options),
      {
        maxRetries: this.config.maxRetries,
        baseDelay: this.config.baseDelay,
        maxDelay: this.config.maxDelay,
        shouldRetry: this.shouldRetryError.bind(this),
        name: `${this.config.name} embed`,
      }
    );
  }

  /**
   * Get provider metadata
   */
  async metadata(): Promise<ProviderMetadata> {
    if (!this.provider.metadata) {
      return {
        name: this.config.name,
        capabilities: ['chat', 'stream'],
      };
    }

    return this.provider.metadata();
  }

  // Forward optional methods to the underlying provider so callers
  // (e.g. /model slash command) can reach them through the wrapper.

  async listModels(): Promise<Array<{ name: string; id: string }>> {
    const inner = this.provider as any;
    if (typeof inner.listModels === 'function') {
      return inner.listModels();
    }
    return [];
  }

  getCurrentModel(): string {
    const inner = this.provider as any;
    if (typeof inner.getCurrentModel === 'function') {
      return inner.getCurrentModel();
    }
    return '';
  }

  switchModel(modelName: string): void {
    const inner = this.provider as any;
    if (typeof inner.switchModel === 'function') {
      inner.switchModel(modelName);
    }
  }

  /**
   * Chat with timeout
   */
  private async chatWithTimeout(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    return this.withTimeout(
      this.provider.chat(messages, options),
      this.config.timeout
    );
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Request timed out after ${ms}ms`));
          }, ms);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private contextualizeProviderError(error: unknown, operation: string): Error {
    const currentModel = this.getCurrentModel();
    return contextualError(error, {
      source: "provider",
      name: this.config.name,
      operation,
      target: currentModel ? `model ${currentModel}` : undefined,
    });
  }

  /**
   * Determine if an error should trigger a retry
   */
  private shouldRetryError(error: Error): boolean {
    const message = error.message.toLowerCase();

    // Context overflow can never succeed on retry — the request is too big.
    // Recovery happens via session compaction at the agent-session level.
    if (isContextOverflowError(error)) {
      return false;
    }

    // Always retry on network errors
    if (RetryPredicates.networkErrors(error)) {
      return true;
    }

    // Always retry on timeout errors
    if (RetryPredicates.timeoutErrors(error)) {
      return true;
    }

    // Always retry on server errors (5xx)
    if (RetryPredicates.serverErrors(error)) {
      return true;
    }

    // Retry on rate limit errors (429) with longer delay
    if (RetryPredicates.rateLimitErrors(error)) {
      console.log(chalk.yellow('  ⚠️  Rate limit hit, backing off...'));
      return true;
    }

    // Retry on quota exceeded errors
    if (message.includes('quota') && message.includes('exceeded')) {
      console.log(chalk.yellow('  ⚠️  Quota exceeded, backing off...'));
      return true;
    }

    // Retry on temporary errors
    if (message.includes('temporary') || message.includes('try again')) {
      return true;
    }

    // Don't retry on client errors (4xx except 429)
    if (message.includes('400') || message.includes('401') ||
        message.includes('403') || message.includes('404')) {
      return false;
    }

    // Don't retry on authentication errors
    if (message.includes('unauthorized') || message.includes('authentication')) {
      return false;
    }

    // Default: retry for unknown errors (conservative approach)
    return true;
  }

  /**
   * Get the underlying provider
   */
  getProvider(): Provider {
    return this.provider;
  }
}

/**
 * Helper function to wrap a provider
 */
export function wrapProvider(provider: Provider, config?: ProviderWrapperConfig): Provider {
  return new ProviderWrapper(provider, config);
}
