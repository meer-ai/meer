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

export type AgentMessage =
  | { role: "user"; content: string; timestamp?: number }
  | { role: "system"; content: string; timestamp?: number }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCallBlock[];
      timestamp?: number;
    }
  | {
      role: "tool_result";
      toolCallId: string;
      toolName: string;
      content: string;
      isError?: boolean;
      timestamp?: number;
    };

export interface ToolResult {
  content: string;
  isError?: boolean;
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
  | { type: "aborted" };

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;
