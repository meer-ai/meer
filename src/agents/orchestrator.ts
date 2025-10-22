import chalk from "chalk";
import { AgentWorkflowV2, type AgentConfig } from "../agent/workflow-v2.js";
import { logVerbose } from "../logger.js";
import { SubAgent } from "./subagent.js";
import { AgentRegistry } from "./registry.js";
import type {
  SubAgentDefinition,
  SubAgentResult,
  SubAgentStatusInfo,
  DelegationRequest,
  DelegationOptions,
  ParallelTask,
  AgentExecutionContext,
} from "./types.js";

/**
 * AgentOrchestrator - Coordinates multiple sub-agents
 *
 * The orchestrator is the central hub that:
 * - Manages the main agent workflow
 * - Delegates tasks to specialized sub-agents
 * - Executes multiple agents in parallel
 * - Monitors agent status and health
 * - Aggregates results from sub-agents
 */
export class AgentOrchestrator {
  private mainAgent: AgentWorkflowV2;
  private registry: AgentRegistry;
  private activeSubAgents: Map<string, SubAgent> = new Map();
  private config: AgentConfig;
  private cwd: string;

  constructor(config: AgentConfig) {
    this.config = config;
    this.cwd = config.cwd;
    this.mainAgent = new AgentWorkflowV2(config);
    this.registry = new AgentRegistry(this.cwd);

    logVerbose(chalk.blue('[AgentOrchestrator] Initialized'));
  }

  /**
   * Initialize the orchestrator and load agents
   */
  async initialize(contextPrompt?: string): Promise<void> {
    // Initialize main agent
    await this.mainAgent.initialize(contextPrompt);

    // Load all available agents
    await this.registry.loadAgents();

    const agentCount = this.registry.getAllAgents().length;
    logVerbose(chalk.green(`[AgentOrchestrator] Ready with ${agentCount} available agents`));
  }

  /**
   * Process a message (delegates to main agent or sub-agents as needed)
   */
  async processMessage(
    userMessage: string,
    options?: Parameters<AgentWorkflowV2['processMessage']>[1]
  ): Promise<string> {
    // For now, delegate to main agent
    // TODO: Add intelligent delegation based on message content
    return await this.mainAgent.processMessage(userMessage, options);
  }

  /**
   * Delegate a task to a specific sub-agent
   */
  async delegateTask(
    agentName: string,
    task: string,
    options?: DelegationOptions
  ): Promise<SubAgentResult> {
    logVerbose(chalk.blue(`[AgentOrchestrator] Delegating to ${agentName}: ${task.substring(0, 50)}...`));

    // Get agent definition
    const definition = this.registry.getAgent(agentName);
    if (!definition) {
      throw new Error(`Agent not found: ${agentName}`);
    }

    if (!definition.enabled) {
      throw new Error(`Agent is disabled: ${agentName}`);
    }

    // Create sub-agent instance
    const subAgent = this.createSubAgent(definition);

    // Build execution context
    const context: AgentExecutionContext = {
      cwd: this.cwd,
      messages: [],
      metadata: options?.timeout ? { timeout: options.timeout } : undefined,
    };

    // Execute task
    try {
      const result = await this.executeWithTimeout(
        () => subAgent.execute(task, context),
        options?.timeout || 60000 // Default 60s timeout
      );

      logVerbose(chalk.green(`[AgentOrchestrator] Task completed by ${agentName}`));

      return result;
    } catch (error) {
      logVerbose(chalk.red(`[AgentOrchestrator] Task failed in ${agentName}: ${error}`));

      return {
        success: false,
        output: '',
        summary: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: {
          tokensUsed: 0,
          duration: 0,
          toolCalls: 0,
          toolsUsed: [],
          errors: [error instanceof Error ? error.message : String(error)],
        },
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      // Clean up sub-agent
      this.activeSubAgents.delete(subAgent.getId());
    }
  }

  /**
   * Delegate multiple tasks in parallel to different agents
   */
  async delegateParallel(tasks: ParallelTask[]): Promise<SubAgentResult[]> {
    logVerbose(chalk.blue(`[AgentOrchestrator] Running ${tasks.length} agents in parallel`));

    const promises = tasks.map(({ agent, task, options }) =>
      this.delegateTask(agent, task, options)
    );

    const results = await Promise.allSettled(promises);

    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        const taskInfo = tasks[index];
        return {
          success: false,
          output: '',
          summary: `Parallel execution failed: ${result.reason}`,
          metadata: {
            tokensUsed: 0,
            duration: 0,
            toolCalls: 0,
            toolsUsed: [],
            errors: [String(result.reason)],
          },
          error: String(result.reason),
        };
      }
    });
  }

  /**
   * List all available agents
   */
  listAvailableAgents(): SubAgentDefinition[] {
    return this.registry.getAllAgents();
  }

  /**
   * List all enabled agents
   */
  listEnabledAgents(): SubAgentDefinition[] {
    return this.registry.getEnabledAgents();
  }

  /**
   * Create a new agent
   */
  async createAgent(
    definition: SubAgentDefinition,
    scope: 'user' | 'project' = 'project'
  ): Promise<void> {
    await this.registry.saveAgent(definition, scope);
    logVerbose(chalk.green(`[AgentOrchestrator] Created agent: ${definition.name}`));
  }

  /**
   * Remove an agent
   */
  async removeAgent(name: string, scope: 'user' | 'project'): Promise<void> {
    await this.registry.deleteAgent(name, scope);
    logVerbose(chalk.yellow(`[AgentOrchestrator] Removed agent: ${name}`));
  }

  /**
   * Get status of a specific agent
   */
  getAgentStatus(id: string): SubAgentStatusInfo | null {
    const subAgent = this.activeSubAgents.get(id);
    return subAgent ? subAgent.getStatus() : null;
  }

  /**
   * Get status of all active agents
   */
  getAllActiveAgents(): SubAgentStatusInfo[] {
    return Array.from(this.activeSubAgents.values()).map(agent => agent.getStatus());
  }

  /**
   * Search for agents by query
   */
  searchAgents(query: string): SubAgentDefinition[] {
    return this.registry.searchAgents(query);
  }

  /**
   * Refresh agent registry (reload from disk)
   */
  async refreshRegistry(): Promise<void> {
    await this.registry.refreshAgents();
    logVerbose(chalk.green('[AgentOrchestrator] Registry refreshed'));
  }

  /**
   * Get agent definition by name
   */
  getAgentDefinition(name: string): SubAgentDefinition | null {
    return this.registry.getAgent(name);
  }

  // Private helper methods

  private createSubAgent(definition: SubAgentDefinition): SubAgent {
    // Create a new config for the sub-agent
    const subAgentConfig: AgentConfig = {
      ...this.config,
      maxIterations: definition.maxIterations || this.config.maxIterations || 10,
    };

    // TODO: Apply tool access control based on definition.tools
    // This will be implemented in the next phase

    const subAgent = new SubAgent(definition, subAgentConfig);

    // Track active agent
    this.activeSubAgents.set(subAgent.getId(), subAgent);

    return subAgent;
  }

  private async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return Promise.race([
      fn(),
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Task timeout after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  }

  /**
   * Aggregate results from multiple sub-agents
   */
  aggregateResults(results: SubAgentResult[]): string {
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    let summary = '';

    if (successful.length > 0) {
      summary += `## Successful Tasks (${successful.length})\n\n`;
      successful.forEach((result, index) => {
        summary += `### Task ${index + 1}\n${result.summary}\n\n`;
      });
    }

    if (failed.length > 0) {
      summary += `## Failed Tasks (${failed.length})\n\n`;
      failed.forEach((result, index) => {
        summary += `### Task ${index + 1}\n❌ ${result.error}\n\n`;
      });
    }

    // Add aggregate metrics
    const totalTokens = results.reduce((sum, r) => sum + r.metadata.tokensUsed, 0);
    const totalDuration = results.reduce((sum, r) => sum + r.metadata.duration, 0);
    const totalToolCalls = results.reduce((sum, r) => sum + r.metadata.toolCalls, 0);

    summary += `## Metrics\n`;
    summary += `- Total Tokens: ${totalTokens.toLocaleString()}\n`;
    summary += `- Total Duration: ${(totalDuration / 1000).toFixed(2)}s\n`;
    summary += `- Total Tool Calls: ${totalToolCalls}\n`;

    return summary;
  }
}
