import type { ChatMessage } from "../providers/base.js";
import {
  MeerAgent,
  type MeerAgentConfig,
  type MeerAgentInitOptions,
} from "./meer-agent.js";

export interface StructuredAgentConfig extends MeerAgentConfig {}

export interface StructuredWorkflowInitializationOptions
  extends MeerAgentInitOptions {}

/**
 * Legacy compatibility wrapper.
 *
 * The old structured workflow previously maintained its own independent agent
 * loop, which drifted out of sync with the live Meer runtime. Keep the class
 * name for compatibility, but delegate to MeerAgent so there is only one real
 * implementation to maintain.
 */
export class StructuredAgentWorkflow {
  private readonly delegate: MeerAgent;

  constructor(config: StructuredAgentConfig) {
    this.delegate = new MeerAgent(config);
  }

  async initialize(
    options?: string | StructuredWorkflowInitializationOptions
  ): Promise<void> {
    await this.delegate.initialize(
      options as string | MeerAgentInitOptions | undefined
    );
  }

  async processMessage(userMessage: string): Promise<string> {
    return this.delegate.processMessage(userMessage);
  }

  abort(): void {
    this.delegate.abort();
  }

  isProcessing(): boolean {
    return this.delegate.isProcessing();
  }

  queueMessage(userMessage: string, mode: "steer" | "followUp" = "steer"): boolean {
    return this.delegate.queueMessage(userMessage, mode);
  }
}

export type StructuredWorkflowMessage = ChatMessage;
