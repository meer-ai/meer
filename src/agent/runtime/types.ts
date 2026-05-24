import type { ChatMessage } from "../../providers/base.js";

export type AgentMessage = ChatMessage;

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call(input: unknown): Promise<string>;
}
