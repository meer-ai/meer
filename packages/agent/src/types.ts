/**
 * Core agent types — adapted from the pi agent architecture.
 *
 * The LLM I/O contract (the conversation message model and tool schemas) now
 * lives in `@meer/ai`; it is re-exported here so the many `../agent/core/types`
 * importers keep working. This file owns only the agent-orchestration types
 * (tools with executable bodies, loop events) that sit *above* the LLM layer.
 */

export type {
  ToolDefinition,
  ToolCallBlock,
  MessageAttachment,
  AgentMessage,
  ToolResult,
} from "@meer/ai/types.js";

import type { AgentMessage, ToolResult } from "@meer/ai/types.js";

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
