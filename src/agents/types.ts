import type { ChatMessage } from "../providers/base.js";

/**
 * Sub-agent definition loaded from markdown files
 */
export interface SubAgentDefinition {
  // Metadata
  name: string; // Unique identifier (lowercase, no spaces)
  description: string; // Purpose and when to use

  // Behavior
  model?: 'inherit' | 'sonnet' | 'opus' | 'haiku';
  tools?: string[]; // Tool whitelist (undefined = all tools)
  enabled?: boolean; // Can be disabled without deletion

  // Advanced
  maxIterations?: number; // Override default iteration limit
  temperature?: number; // Override model temperature
  systemPrompt: string; // Main prompt (markdown body)

  // Metadata
  author?: string;
  version?: string;
  tags?: string[];
}

/**
 * Result returned by a sub-agent after execution
 */
export interface SubAgentResult {
  success: boolean;
  output: string; // Full output from the agent
  summary?: string; // Condensed version for main context
  metadata: {
    tokensUsed: number;
    duration: number; // milliseconds
    toolCalls: number;
    toolsUsed: string[];
    errors?: string[];
  };
  error?: string;
}

/**
 * Status of a running sub-agent
 */
export type AgentStatus = 'idle' | 'running' | 'completed' | 'failed';

/**
 * Sub-agent status information
 */
export interface SubAgentStatusInfo {
  id: string;
  name: string;
  status: AgentStatus;
  startTime?: number;
  endTime?: number;
  currentTask?: string;
  progress?: number; // 0-100
}

/**
 * Request to delegate a task to a sub-agent
 */
export interface DelegationRequest {
  agentName: string;
  task: string;
  context?: {
    files?: string[];
    cwd?: string;
    metadata?: Record<string, any>;
  };
  options?: DelegationOptions;
}

/**
 * Options for task delegation
 */
export interface DelegationOptions {
  timeout?: number; // milliseconds
  maxTokens?: number;
  priority?: number;
  parallel?: boolean; // Allow parallel execution
}

/**
 * Report from sub-agent to orchestrator
 */
export interface SubAgentReport {
  agentId: string;
  agentName: string;
  task: string;
  status: 'success' | 'partial' | 'failed';
  output: string;
  summary: string; // Condensed version for main context
  metadata: {
    tokensUsed: number;
    duration: number;
    toolsUsed: string[];
    errors?: string[];
  };
}

/**
 * Parallel delegation task
 */
export interface ParallelTask {
  agent: string;
  task: string;
  options?: DelegationOptions;
}

/**
 * Agent scope for storage
 */
export type AgentScope = 'user' | 'project';

/**
 * Agent discovery result
 */
export interface AgentDiscoveryResult {
  definition: SubAgentDefinition;
  filePath: string;
  scope: AgentScope;
  lastModified: Date;
}

/**
 * Agent execution context
 */
export interface AgentExecutionContext {
  cwd: string;
  messages: ChatMessage[];
  files?: string[];
  metadata?: Record<string, any>;
}

/**
 * Agent performance metrics
 */
export interface AgentMetrics {
  executionCount: number;
  successCount: number;
  failureCount: number;
  averageDuration: number;
  totalTokensUsed: number;
  averageTokensPerExecution: number;
}
