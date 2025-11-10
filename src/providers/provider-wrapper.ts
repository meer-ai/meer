/**
 * Provider Wrapper with Retry and Rate-Limit Handling
 *
 * Wraps any provider to add:
 * - Automatic retry with exponential backoff
 * - Rate limit handling
 * - Network error recovery
 * - Request timeout management
 */

import type { Provider, ChatMessage, ChatOptions, EmbedOptions, ProviderMetadata } from './base.js';
import { retryWithBackoff, RetryPredicates } from '../utils/retry.js';
import chalk from 'chalk';

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
    return retryWithBackoff(
      () => this.chatWithTimeout(messages, options),
      {
        maxRetries: this.config.maxRetries,
        baseDelay: this.config.baseDelay,
        maxDelay: this.config.maxDelay,
        shouldRetry: this.shouldRetryError.bind(this),
        name: `${this.config.name} chat`,
      }
    );
  }

  /**
   * Stream with automatic retry (only retries connection establishment)
   */
  async *stream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string> {
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

  /**
   * Chat with timeout
   */
  private async chatWithTimeout(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    return Promise.race([
      this.provider.chat(messages, options),
      this.createTimeout(this.config.timeout),
    ]);
  }

  /**
   * Create a timeout promise
   */
  private createTimeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Request timed out after ${ms}ms`));
      }, ms);
    });
  }

  /**
   * Determine if an error should trigger a retry
   */
  private shouldRetryError(error: Error): boolean {
    const message = error.message.toLowerCase();

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
