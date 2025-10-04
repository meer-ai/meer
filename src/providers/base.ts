export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  repeatPenalty?: number;
  numCtx?: number;
  [key: string]: unknown;
}

export interface EmbedOptions {
  model?: string;
  [key: string]: unknown;
}

export interface ProviderMetadata {
  name: string;
  version?: string;
  capabilities: string[];
  [key: string]: unknown;
}

export interface Provider {
  /**
   * Send a chat request and return the complete response
   */
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;

  /**
   * Stream a chat response as an async iterable
   */
  stream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string>;

  /**
   * Generate embeddings for the given texts (optional)
   */
  embed?(texts: string[], options?: EmbedOptions): Promise<number[][]>;

  /**
   * Get provider metadata and capabilities
   */
  metadata?(): Promise<ProviderMetadata>;
}
