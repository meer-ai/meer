import { randomBytes } from "crypto";
import chalk from "chalk";
import { AgentWorkflowV2, type AgentConfig } from "../agent/workflow-v2.js";
import type { ChatMessage } from "../providers/base.js";
import { logVerbose } from "../logger.js";
import type {
  SubAgentDefinition,
  SubAgentResult,
  AgentStatus,
  SubAgentStatusInfo,
  AgentExecutionContext,
} from "./types.js";

/**
 * SubAgent - An isolated agent instance with its own context and lifecycle
 *
 * Each SubAgent wraps an AgentWorkflowV2 instance and maintains:
 * - Isolated message history
 * - Independent status tracking
 * - Tool access control
 * - Result aggregation
 */
export class SubAgent {
  private id: string;
  private definition: SubAgentDefinition;
  private workflow: AgentWorkflowV2;
  private messages: ChatMessage[] = [];
  private status: AgentStatus = 'idle';
  private result?: string;
  private error?: Error;
  private startTime?: number;
  private endTime?: number;
  private currentTask?: string;
  private tokensUsed = 0;
  private toolCalls = 0;
  private toolsUsed: Set<string> = new Set();

  constructor(definition: SubAgentDefinition, config: AgentConfig) {
    this.id = this.generateId();
    this.definition = definition;

    // Create isolated workflow instance
    this.workflow = new AgentWorkflowV2({
      ...config,
      maxIterations: definition.maxIterations || config.maxIterations || 10,
    });

    logVerbose(chalk.blue(`[SubAgent] Created: ${definition.name} (${this.id})`));
  }

  /**
   * Execute a task with this sub-agent
   */
  async execute(task: string, context?: AgentExecutionContext): Promise<SubAgentResult> {
    this.currentTask = task;
    this.status = 'running';
    this.startTime = Date.now();
    this.toolsUsed.clear();

    try {
      logVerbose(chalk.blue(`[SubAgent ${this.definition.name}] Starting task: ${task.substring(0, 50)}...`));

      // Initialize workflow with custom system prompt
      const systemPrompt = this.buildSystemPrompt(context);
      await this.workflow.initialize(systemPrompt);

      // Build task message with context
      const taskMessage = this.buildTaskMessage(task, context);

      // Process the task (AgentWorkflowV2 handles the iteration loop)
      const response = await this.workflow.processMessage(taskMessage, {
        disableAutoContext: true, // We provide context explicitly
      });

      // Mark as completed
      this.status = 'completed';
      this.endTime = Date.now();
      this.result = response;

      const result: SubAgentResult = {
        success: true,
        output: response,
        summary: this.generateSummary(response),
        metadata: {
          tokensUsed: this.estimateTokens(response),
          duration: this.endTime - this.startTime,
          toolCalls: this.toolCalls,
          toolsUsed: Array.from(this.toolsUsed),
        },
      };

      logVerbose(chalk.green(`[SubAgent ${this.definition.name}] Completed in ${result.metadata.duration}ms`));

      return result;
    } catch (error) {
      this.status = 'failed';
      this.endTime = Date.now();
      this.error = error as Error;

      logVerbose(chalk.red(`[SubAgent ${this.definition.name}] Failed: ${error}`));

      const duration = this.endTime - this.startTime;
      return {
        success: false,
        output: '',
        summary: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: {
          tokensUsed: this.tokensUsed,
          duration,
          toolCalls: this.toolCalls,
          toolsUsed: Array.from(this.toolsUsed),
          errors: [error instanceof Error ? error.message : String(error)],
        },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get current status information
   */
  getStatus(): SubAgentStatusInfo {
    return {
      id: this.id,
      name: this.definition.name,
      status: this.status,
      startTime: this.startTime,
      endTime: this.endTime,
      currentTask: this.currentTask,
      progress: this.calculateProgress(),
    };
  }

  /**
   * Get message history
   */
  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  /**
   * Abort execution (not implemented yet - requires workflow support)
   */
  abort(): void {
    logVerbose(chalk.yellow(`[SubAgent ${this.definition.name}] Abort requested`));
    this.status = 'failed';
    this.error = new Error('Aborted by user');
    // TODO: Implement workflow abortion when AgentWorkflowV2 supports it
  }

  /**
   * Get agent definition
   */
  getDefinition(): SubAgentDefinition {
    return this.definition;
  }

  /**
   * Get agent ID
   */
  getId(): string {
    return this.id;
  }

  // Private helper methods

  private generateId(): string {
    return `agent_${randomBytes(8).toString('hex')}`;
  }

  private buildSystemPrompt(context?: AgentExecutionContext): string {
    let prompt = this.definition.systemPrompt;

    // Add context information if provided
    if (context?.metadata) {
      const metadata = Object.entries(context.metadata)
        .map(([key, value]) => `- ${key}: ${value}`)
        .join('\n');
      prompt += `\n\n## Context\n${metadata}`;
    }

    return prompt;
  }

  private buildTaskMessage(task: string, context?: AgentExecutionContext): string {
    let message = task;

    // Add file context if provided
    if (context?.files && context.files.length > 0) {
      message += `\n\n## Relevant Files\n${context.files.map(f => `- ${f}`).join('\n')}`;
    }

    // Add CWD if provided
    if (context?.cwd) {
      message += `\n\n## Working Directory\n${context.cwd}`;
    }

    return message;
  }

  private generateSummary(output: string): string {
    // Simple summary: first 500 chars or first paragraph
    const lines = output.split('\n').filter(line => line.trim());

    // Try to find a natural break point
    let summary = '';
    let charCount = 0;

    for (const line of lines) {
      if (charCount + line.length > 500) {
        break;
      }
      summary += line + '\n';
      charCount += line.length;
    }

    if (summary.length < output.length) {
      summary += '\n[... output truncated ...]';
    }

    return summary.trim();
  }

  private estimateTokens(text: string): number {
    // Rough estimate: ~4 chars per token
    return Math.ceil(text.length / 4);
  }

  private calculateProgress(): number {
    if (this.status === 'idle') return 0;
    if (this.status === 'completed' || this.status === 'failed') return 100;

    // For running status, estimate based on time elapsed
    // This is a rough heuristic - could be improved with better metrics
    if (this.startTime) {
      const elapsed = Date.now() - this.startTime;
      const estimatedTotal = 30000; // Assume ~30s average task
      return Math.min(95, Math.floor((elapsed / estimatedTotal) * 100));
    }

    return 50; // Default mid-point for running tasks
  }
}
