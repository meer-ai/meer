/**
 * The provider contract: every meer LLM backend implements {@link Provider}.
 * This is part of `@meer-ai/ai` (the LLM I/O layer); the agent loop and the app
 * depend on it, never the other way around.
 */

import type {
  AgentMessage,
  MessageAttachment,
  ToolDefinition,
} from "./types.js";
export type { AgentMessage, MessageAttachment, ToolDefinition };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Image attachments — only meaningful on user messages. */
  attachments?: MessageAttachment[];
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

export interface ProviderToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ProviderStructuredTurn {
  assistantMessage: string;
  toolCalls: ProviderToolCall[];
  finalAnswer?: string;
  rawText: string;
  reasoningContent?: string;
}

/** Token usage reported by a provider for a single response, when available. */
export interface ProviderUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export type ProviderEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'assistant-message'; text: string }
  | { type: 'tool-call-delta'; toolCallId: string; toolName?: string; inputTextDelta: string }
  | { type: 'tool-call'; toolCall: ProviderToolCall }
  | { type: 'final-answer'; text: string }
  | { type: 'done'; rawText: string; turn?: ProviderStructuredTurn; reasoningContent?: string; usage?: ProviderUsage };

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
   * Return a parsed structured turn when the provider can produce one.
   * Falls back to parsing plain-text responses when implemented by adapters.
   */
  chatStructured?(
    messages: ChatMessage[],
    options?: ChatOptions
  ): Promise<ProviderStructuredTurn>;

  /**
   * Stream structured assistant events.
   * Providers may emit text deltas only, or richer turn/tool-call events.
   */
  streamEvents?(
    messages: ChatMessage[],
    options?: ChatOptions
  ): AsyncIterable<ProviderEvent>;

  /**
   * Generate embeddings for the given texts (optional)
   */
  embed?(texts: string[], options?: EmbedOptions): Promise<number[][]>;

  /**
   * Get provider metadata and capabilities
   */
  metadata?(): Promise<ProviderMetadata>;

  /**
   * Stream a response with native tool calling support.
   * Messages use structured AgentMessage format with tool call/result types.
   */
  streamWithTools?(
    messages: AgentMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal
  ): AsyncIterable<ProviderEvent>;
}
