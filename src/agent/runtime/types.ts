import type { ChatMessage } from "../../providers/base.js";

export type AgentMessage = ChatMessage;

export interface AgentToolCallResult {
  content: string;
  isError?: boolean;
  details?: Record<string, unknown>;
}

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call(
    input: unknown,
    onUpdate?: (partial: string) => void,
    signal?: AbortSignal
  ): Promise<string | AgentToolCallResult>;
}
