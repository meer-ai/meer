/**
 * Core agent types — adapted from the pi agent architecture.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolCallBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Attachments rides alongside the user's text rather than rewriting the
 * `content` field, so every existing consumer that reads `message.content`
 * as a string keeps working untouched. Only provider adapters and the submit
 * path need to know about attachments.
 *
 * Source variants:
 *  - `{ type: "path", path }` — lazy, the provider reads + base64-encodes at
 *    send time. Preferred for persistence (sessions stay small).
 *  - `{ type: "base64", data }` — already loaded into memory. Used right
 *    after a clipboard paste or when round-tripping in-flight.
 */
export interface MessageAttachment {
  kind: "image";
  mimeType: string;
  source:
    | { type: "path"; path: string }
    | { type: "base64"; data: string };
  /** Original filename or hint for display in the transcript. */
  name?: string;
  /** Approximate decoded byte size when known. */
  sizeBytes?: number;
}

export type AgentMessage =
  | {
      role: "user";
      content: string;
      attachments?: MessageAttachment[];
      timestamp?: number;
    }
  | { role: "system"; content: string; timestamp?: number }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCallBlock[];
      reasoningContent?: string;
      timestamp?: number;
    }
  | {
      role: "tool_result";
      toolCallId: string;
      toolName: string;
      content: string;
      isError?: boolean;
      details?: Record<string, unknown>;
      timestamp?: number;
    };

export interface ToolResult {
  content: string;
  isError?: boolean;
  details?: Record<string, unknown>;
  /** When true, the loop stops after this tool batch. */
  terminate?: boolean;
}

export interface AgentTool<TInput = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  execute(
    toolCallId: string,
    input: TInput,
    signal?: AbortSignal,
    onUpdate?: (partial: string) => void
  ): Promise<ToolResult>;
  requiresApproval?:
    | boolean
    | ((input: TInput) => boolean | Promise<boolean>);
}

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "text_delta"; text: string }
  | {
      type: "tool_call_delta";
      toolCallId: string;
      toolName?: string;
      inputTextDelta: string;
    }
  | {
      type: "tool_start";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_update";
      toolCallId: string;
      toolName: string;
      partial: string;
    }
  | {
      type: "tool_end";
      toolCallId: string;
      toolName: string;
      result: ToolResult;
      isError: boolean;
    }
  | { type: "error"; error: Error }
  | { type: "usage"; promptTokens?: number; completionTokens?: number }
  | { type: "reasoning"; content: string }
  | { type: "aborted" };

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;
