import { randomUUID } from "crypto";
import type { ChatMessage, Provider } from "../providers/base.js";
import type { AgentMessage } from "./core/types.js";
import type { SessionTracker } from "../session/tracker.js";
import { memory } from "../memory/index.js";
import type { CompactionSummaryInput } from "../session/store.js";
import {
  buildInitialConversationHistory,
  describeInitialWorkflowStage,
  describeToolWorkflowStage,
  prepareTurnInput,
  trimConversationHistory,
} from "./session-heuristics.js";
import { buildNativeSystemPrompt } from "./prompts/nativeSystemPrompt.js";
import { generateCompactionSummaryWithProvider } from "./session-compaction.js";
import {
  isContextOverflowError,
  isRetryableProviderError,
} from "../utils/provider-errors.js";
import type { MCPTool } from "../mcp/types.js";
import type { Skill } from "../skills/index.js";

export interface RuntimeProcessResult {
  response: string;
  conversationHistory: AgentMessage[];
}

export type RuntimeExecutionEvent =
  | {
      type: "iteration";
      current: number;
      max?: number;
    }
  | {
      type: "tool_start";
      toolCallId?: string;
      toolName: string;
    }
  | {
      type: "tool_end";
      toolCallId?: string;
      toolName: string;
      success: boolean;
    };

export interface SessionAgentRuntime {
  initialize(
    options?: string | { contextPrompt?: string; priorMessages?: ChatMessage[] }
  ): Promise<void>;
  processMessage(
    userMessage: string,
    options?: {
      persistUserMessage?: boolean;
      turnId?: string;
      preparedMessages?: AgentMessage[];
      systemPrompt?: string;
      attachments?: import("./core/types.js").MessageAttachment[];
    }
  ): Promise<RuntimeProcessResult>;
  abort?(): void;
  isProcessing?(): boolean;
  persistQueuedUserMessage?(content: string, options?: { turnId?: string }): void;
  recordQueueChange?(change: {
    action: "queued" | "delivered";
    mode: "steer" | "followUp";
    message: string;
  }, options?: { turnId?: string }): void;
  setSessionEventSink?(sink: (event: AgentSessionEvent) => void): void;
  setExecutionEventSink?(sink: (event: RuntimeExecutionEvent) => void): void;
  setQueueAccessors?(accessors: {
    takeQueuedMessages: (mode: "steer" | "followUp") => AgentMessage[];
  }): void;
  getProviderIdentity?(): { providerType: string; model: string };
  getProvider?(): Provider;
  getPromptContext?(): {
    cwd: string;
    mcpTools: MCPTool[];
    providerType: string;
    skills?: Skill[];
  };
  refreshPromptContext?(): Promise<void>;
  getContextStats?(): { visibleMessages: number; totalChars: number } | null;
  compactSession?(options: {
    keepRecentMessages: number;
    summaryGenerator?: (
      input: CompactionSummaryInput
    ) => Promise<string> | string;
  }): Promise<boolean>;
}

export interface SessionRetryConfig {
  attempts: number;
  delayMs: number;
  backoffFactor: number;
}

export type AgentSessionEvent =
  | {
      type: "turn_start";
    }
  | {
      type: "iteration_change";
      current: number;
      max?: number;
    }
  | {
      type: "workflow_stage";
      name: string;
      status: "started" | "completed" | "failed";
    }
  | {
      type: "turn_end";
      success: boolean;
      error?: string;
    }
  | {
      type: "status_change";
      status: string;
    }
  | {
      type: "queue_update";
      steering: string[];
      followUp: string[];
      changes?: Array<{
        action: "queued" | "delivered";
        mode: "steer" | "followUp";
        message: string;
      }>;
    }
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | {
      type: "auto_retry_end";
      success: boolean;
      attempt: number;
      finalError?: string;
    };

export interface AgentSessionConfig {
  runtime: SessionAgentRuntime;
  retry?: SessionRetryConfig;
  sessionTracker?: SessionTracker;
  compaction?: {
    enabled: boolean;
    maxVisibleMessages: number;
    maxVisibleChars: number;
    keepRecentMessages: number;
  };
  onEvent?: (event: AgentSessionEvent) => void;
}

function isRetryableError(error: Error): boolean {
  if (error.name === "AbortError") {
    return false;
  }
  return isRetryableProviderError(error);
}

export class AgentSession {
  private readonly runtime: SessionAgentRuntime;
  private readonly retry?: SessionRetryConfig;
  private readonly sessionTracker?: SessionTracker;
  private readonly compaction?: {
    enabled: boolean;
    maxVisibleMessages: number;
    maxVisibleChars: number;
    keepRecentMessages: number;
  };
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  private retryAbortController: AbortController | null = null;
  private steeringQueue: AgentMessage[] = [];
  private followUpQueue: AgentMessage[] = [];
  private conversationHistory: AgentMessage[] = [];
  private activeTurnId: string | null = null;
  private activeUserMessage = "";
  private activeWorkflowStageName: string | null = null;
  private readonly toolStartTimes = new Map<string, number>();

  constructor(config: AgentSessionConfig) {
    this.runtime = config.runtime;
    this.retry = config.retry;
    this.sessionTracker = config.sessionTracker;
    this.compaction = config.compaction;
    if (config.onEvent) {
      this.listeners.add(config.onEvent);
    }
    if (this.compaction?.enabled && this.compaction.maxVisibleChars > 0) {
      this.sessionTracker?.setContextLimit(
        Math.ceil(this.compaction.maxVisibleChars / 4)
      );
    }
    this.runtime.setSessionEventSink?.((event) =>
      this.handleRuntimeSessionEvent(event)
    );
    this.runtime.setExecutionEventSink?.((event) =>
      this.handleExecutionEvent(event)
    );
    this.runtime.setQueueAccessors?.({
      takeQueuedMessages: (mode) => this.takeQueuedMessages(mode),
    });
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  async initialize(
    options?: string | { contextPrompt?: string; priorMessages?: ChatMessage[] }
  ): Promise<void> {
    this.conversationHistory = trimConversationHistory(
      buildInitialConversationHistory(options)
    );
    await this.runtime.initialize(options);
  }

  isProcessing(): boolean {
    return this.runtime.isProcessing?.() ?? false;
  }

  queueMessage(
    userMessage: string,
    mode: "steer" | "followUp" = "steer"
  ): boolean {
    const trimmed = userMessage.trim();
    if (!trimmed) {
      return false;
    }

    const queuedMessage: AgentMessage = {
      role: "user",
      content: trimmed,
      timestamp: Date.now(),
    };

    this.runtime.persistQueuedUserMessage?.(trimmed, {
      turnId: this.activeTurnId ?? undefined,
    });
    if (mode === "followUp") {
      this.followUpQueue.push(queuedMessage);
    } else {
      this.steeringQueue.push(queuedMessage);
    }

    const change = {
      action: "queued" as const,
      mode,
      message: trimmed,
    };
    this.runtime.recordQueueChange?.(change, {
      turnId: this.activeTurnId ?? undefined,
    });
    this.emit({
      type: "queue_update",
      steering: this.steeringQueue.map((message) => message.content),
      followUp: this.followUpQueue.map((message) => message.content),
      changes: [change],
    });
    return true;
  }

  abort(): void {
    this.emit({
      type: "status_change",
      status: "Interrupting…",
    });
    this.retryAbortController?.abort();
    this.retryAbortController = null;
    this.runtime.abort?.();
  }

  async prompt(
    userMessage: string,
    options?: {
      attachments?: import("./core/types.js").MessageAttachment[];
    }
  ): Promise<string> {
    const attachments = options?.attachments;
    const retries = Math.max(0, this.retry?.attempts ?? 0);
    const baseDelay = Math.max(0, this.retry?.delayMs ?? 0);
    const backoffFactor = Math.max(1, this.retry?.backoffFactor ?? 1);

    let attempt = 0;
    let lastError: Error | null = null;
    let hasPersistedUserMessage = false;
    let overflowRecoveryAttempted = false;
    this.activeUserMessage = userMessage;
    this.activeWorkflowStageName = null;
    const turnId = randomUUID();
    this.activeTurnId = turnId;

    try {
      while (attempt <= retries) {
        try {
          const providerIdentity = this.runtime.getProviderIdentity?.();
          const preparedMessages =
            providerIdentity
              ? prepareTurnInput(
                  this.conversationHistory,
                  userMessage,
                  providerIdentity.providerType,
                  providerIdentity.model
                )
              : undefined;
          await this.runtime.refreshPromptContext?.();
          const promptContext = this.runtime.getPromptContext?.();
          const systemPrompt = promptContext
            ? buildNativeSystemPrompt({
                cwd: promptContext.cwd,
                mcpTools: promptContext.mcpTools,
                providerType: promptContext.providerType,
                skills: promptContext.skills,
              })
            : undefined;
          const persistUserMessage = !hasPersistedUserMessage;
          hasPersistedUserMessage = true;
          const result = await this.runtime.processMessage(userMessage, {
            persistUserMessage,
            turnId,
            preparedMessages,
            systemPrompt,
            attachments,
          });
          this.conversationHistory = trimConversationHistory(
            result.conversationHistory
          );
          if (attempt > 0) {
            this.emit({
              type: "status_change",
              status: "",
            });
          this.emit({
            type: "auto_retry_end",
            success: true,
            attempt,
          });
        }
          await this.runPostTurnMaintenance();
          return result.response;
        } catch (error) {
          const normalized =
            error instanceof Error ? error : new Error(String(error));
          lastError = normalized;

          // Context overflow: compact the session and retry once instead of
          // failing (or blindly retrying the same oversized request).
          if (
            normalized.name !== "AbortError" &&
            !overflowRecoveryAttempted &&
            isContextOverflowError(normalized)
          ) {
            overflowRecoveryAttempted = true;
            this.emit({
              type: "status_change",
              status: "Context overflow — compacting session…",
            });
            const compacted = await this.forceCompactSession();
            if (compacted) {
              this.emit({
                type: "status_change",
                status: "Retrying after compaction…",
              });
              continue; // does not consume a retry attempt
            }
          }

          if (
            attempt >= retries ||
            !isRetryableError(normalized) ||
            normalized.name === "AbortError"
          ) {
            if (attempt > 0) {
              this.emit({
                type: "status_change",
                status: "",
              });
              this.emit({
                type: "auto_retry_end",
                success: false,
                attempt,
                finalError: normalized.message,
              });
            }
            throw normalized;
          }

          attempt += 1;
          const delayMs = Math.round(baseDelay * Math.pow(backoffFactor, attempt - 1));
          this.emit({
            type: "status_change",
            status: `Retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt}/${retries})…`,
          });
          this.emit({
            type: "auto_retry_start",
            attempt,
            maxAttempts: retries,
            delayMs,
            errorMessage: normalized.message,
          });

          const abortController = new AbortController();
          this.retryAbortController = abortController;
          try {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => {
                abortController.signal.removeEventListener("abort", onAbort);
                resolve();
              }, delayMs);
              const onAbort = () => {
                clearTimeout(timer);
                reject(Object.assign(new Error("Interrupted"), { name: "AbortError" }));
              };
              abortController.signal.addEventListener("abort", onAbort, { once: true });
            });
          } finally {
            if (this.retryAbortController === abortController) {
              this.retryAbortController = null;
            }
          }
        }
      }
    } finally {
      this.activeTurnId = null;
      this.activeUserMessage = "";
      this.activeWorkflowStageName = null;
    }

    throw lastError ?? new Error("Agent session failed");
  }

  private takeQueuedMessages(mode: "steer" | "followUp"): AgentMessage[] {
    const queue = mode === "followUp" ? this.followUpQueue : this.steeringQueue;
    const next = queue.shift();
    if (!next) {
      return [];
    }

    const change = {
      action: "delivered" as const,
      mode,
      message: next.content,
    };
    this.runtime.recordQueueChange?.(change, {
      turnId: this.activeTurnId ?? undefined,
    });
    this.emit({
      type: "queue_update",
      steering: this.steeringQueue.map((message) => message.content),
      followUp: this.followUpQueue.map((message) => message.content),
      changes: [change],
    });
    return [next];
  }

  private async runPostTurnMaintenance(): Promise<void> {
    const stats = this.runtime.getContextStats?.();
    if (stats) {
      this.sessionTracker?.trackContextUsage(Math.ceil(stats.totalChars / 4));
    }

    if (!this.compaction?.enabled || !stats) {
      return;
    }

    const shouldCompactByMessages =
      this.compaction.maxVisibleMessages > 0 &&
      stats.visibleMessages > this.compaction.maxVisibleMessages;
    const shouldCompactByChars =
      this.compaction.maxVisibleChars > 0 &&
      stats.totalChars > this.compaction.maxVisibleChars;

    if (!shouldCompactByMessages && !shouldCompactByChars) {
      return;
    }

    await this.forceCompactSession();
  }

  /**
   * Compact the session unconditionally (used by post-turn threshold checks
   * and by context-overflow recovery). Returns whether compaction happened.
   */
  private async forceCompactSession(): Promise<boolean> {
    const keepRecentMessages = this.compaction?.keepRecentMessages ?? 10;
    this.emit({
      type: "status_change",
      status: "Compacting session…",
    });
    const compacted =
      (await this.runtime.compactSession?.({
        keepRecentMessages,
        summaryGenerator: this.buildCompactionSummaryGenerator(),
      })) ?? false;
    if (compacted) {
      this.reloadConversationHistoryFromMemory(keepRecentMessages + 6);
      const compactedStats = this.runtime.getContextStats?.();
      if (compactedStats) {
        this.sessionTracker?.trackContextUsage(
          Math.ceil(compactedStats.totalChars / 4)
        );
      }
    }
    return compacted;
  }

  private buildCompactionSummaryGenerator():
    | ((input: CompactionSummaryInput) => Promise<string>)
    | undefined {
    const provider = this.runtime.getProvider?.();
    if (!provider) {
      return undefined;
    }
    return async (input: CompactionSummaryInput) =>
      generateCompactionSummaryWithProvider(provider, input);
  }

  private reloadConversationHistoryFromMemory(maxMessages: number): void {
    const sessionPath = memory.getCurrentSessionPath();
    if (!sessionPath) {
      return;
    }

    this.conversationHistory = trimConversationHistory(
      memory.loadChatMessages(sessionPath, { maxMessages }).map((message) => ({
        role: message.role,
        content: message.content,
        timestamp: Date.now(),
      }))
    );
  }

  private handleExecutionEvent(event: RuntimeExecutionEvent): void {
    if (event.type === "iteration") {
      this.emit({
        type: "iteration_change",
        current: event.current,
        max: event.max,
      });
      if (!this.activeWorkflowStageName) {
        this.startWorkflowStage(
          event.current === 1
            ? describeInitialWorkflowStage(this.activeUserMessage)
            : "Plan next step"
        );
      }
      return;
    }

    if (event.type === "tool_start") {
      this.toolStartTimes.set(event.toolCallId ?? event.toolName, Date.now());
      this.completeWorkflowStage();
      this.startWorkflowStage(describeToolWorkflowStage(event.toolName));
      this.emit({
        type: "status_change",
        status: `Running ${event.toolName}…`,
      });
      return;
    }

    if (event.type === "tool_end") {
      const key = event.toolCallId ?? event.toolName;
      const startedAt = this.toolStartTimes.get(key);
      const duration = startedAt ? Date.now() - startedAt : 0;
      this.toolStartTimes.delete(key);
      this.sessionTracker?.trackToolCall(event.toolName, event.success, duration);
      if (event.success) {
        this.completeWorkflowStage();
      } else {
        this.failWorkflowStage();
      }
    }
  }

  private handleRuntimeSessionEvent(event: AgentSessionEvent): void {
    if (event.type === "turn_end" && this.activeWorkflowStageName) {
      if (event.success) {
        this.completeWorkflowStage();
      } else {
        this.failWorkflowStage();
      }
    }
    this.emit(event);
  }

  private startWorkflowStage(name: string): void {
    this.activeWorkflowStageName = name;
    this.emit({
      type: "workflow_stage",
      name,
      status: "started",
    });
  }

  private completeWorkflowStage(name = this.activeWorkflowStageName): void {
    if (!name) {
      return;
    }
    this.emit({
      type: "workflow_stage",
      name,
      status: "completed",
    });
    if (this.activeWorkflowStageName === name) {
      this.activeWorkflowStageName = null;
    }
  }

  private failWorkflowStage(name = this.activeWorkflowStageName): void {
    if (!name) {
      return;
    }
    this.emit({
      type: "workflow_stage",
      name,
      status: "failed",
    });
    if (this.activeWorkflowStageName === name) {
      this.activeWorkflowStageName = null;
    }
  }
}
