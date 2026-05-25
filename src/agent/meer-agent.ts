import { randomUUID } from "crypto";
import type { Provider, ChatMessage } from "../providers/base.js";
import { ProviderWrapper } from "../providers/provider-wrapper.js";
import { memory } from "../memory/index.js";
import { MCPManager } from "../mcp/manager.js";
import type { MCPTool } from "../mcp/types.js";
import type { SessionTracker } from "../session/tracker.js";
import { buildNativeSystemPrompt } from "./prompts/nativeSystemPrompt.js";
import { createMeerAgentTools } from "./tools/agent.js";
import type { AgentTool } from "./core/types.js";
import { runLoop } from "./core/loop.js";
import type { AgentEvent } from "./core/types.js";
import type { AgentMessage as CoreAgentMessage } from "./core/types.js";
import { generateDiff, type FileEdit } from "../tools/index.js";

// Re-export the config type so cli.ts can use it
export interface MeerAgentConfig {
  provider: Provider;
  cwd: string;
  maxIterations?: number;
  enableMemory?: boolean;
  autoCollectContext?: boolean;
  providerType?: string;
  model?: string;
  sessionTracker?: SessionTracker;
  compaction?: {
    enabled: boolean;
    maxVisibleMessages: number;
    maxVisibleChars: number;
    keepRecentMessages: number;
  };
  onStreamingStart?: () => void;
  onStreamingChunk?: (chunk: string) => void;
  onStreamingEnd?: () => void;
  onAssistantMessage?: (content: string) => void;
  onCotMessage?: (content: string) => void;
  onTurnStart?: () => void;
  onTurnEnd?: (result?: { success: boolean; error?: string }) => void;
  onIterationChange?: (current: number, max: number) => void;
  onWorkflowStageStart?: (name: string) => void;
  onWorkflowStageComplete?: (name: string) => void;
  onWorkflowStageFail?: (name: string) => void;
  onToolStart?: (tool: string, args: unknown) => void;
  onToolUpdate?: (tool: string, status: string, result?: string) => void;
  onToolMessage?: (
    tool: string,
    result: string,
    metadata?: { toolCallId?: string; isError?: boolean }
  ) => void;
  onToolEnd?: () => void;
  onStatusChange?: (status: string) => void;
  onQueueUpdate?: (queue: {
    steering: string[];
    followUp: string[];
    changes?: Array<{
      action: "queued" | "delivered";
      mode: "steer" | "followUp";
      message: string;
    }>;
  }) => void;
  onError?: (error: Error) => void;
  promptChoice?: (
    message: string,
    choices: Array<{ label: string; value: string }>,
    defaultChoice?: string
  ) => Promise<string>;
}

export interface MeerAgentInitOptions {
  contextPrompt?: string;
  priorMessages?: ChatMessage[];
}

export class MeerAgent {
  private config: MeerAgentConfig;
  private provider: Provider;
  private cwd: string;
  private mcpManager = MCPManager.getInstance();
  private mcpTools: MCPTool[] = [];
  private conversationHistory: CoreAgentMessage[] = [];
  private abortController: AbortController | null = null;
  private isRunning = false;
  private enableMemory: boolean;
  private providerType: string;
  private model: string;
  private sessionTracker?: SessionTracker;
  private compaction?: {
    enabled: boolean;
    maxVisibleMessages: number;
    maxVisibleChars: number;
    keepRecentMessages: number;
  };
  private editedFiles = new Set<string>();
  private currentTurnId: string | null = null;
  private steeringQueue: CoreAgentMessage[] = [];
  private followUpQueue: CoreAgentMessage[] = [];

  constructor(config: MeerAgentConfig) {
    this.config = config;
    this.provider = new ProviderWrapper(config.provider, {
      name: config.providerType ?? "Provider",
    });
    this.cwd = config.cwd;
    this.enableMemory = config.enableMemory ?? true;
    this.providerType = config.providerType ?? "unknown";
    this.model = config.model ?? "unknown";
    this.sessionTracker = config.sessionTracker;
    this.compaction = config.compaction;
    if (this.compaction?.enabled && this.compaction.maxVisibleChars > 0) {
      this.sessionTracker?.setContextLimit(
        Math.ceil(this.compaction.maxVisibleChars / 4)
      );
    }
  }

  async initialize(
    options?: string | MeerAgentInitOptions
  ): Promise<void> {
    const normalized =
      typeof options === "string" ? { contextPrompt: options } : options ?? {};

    if (!this.mcpManager.isInitialized()) {
      await this.mcpManager.initialize();
    }
    this.mcpTools = this.mcpManager.listAllTools();

    this.conversationHistory = [];

    if (normalized.contextPrompt?.trim()) {
      this.conversationHistory.push({
        role: "user",
        content: `[Context from previous sessions]\n${normalized.contextPrompt}`,
        timestamp: Date.now(),
      });
    }

    if (normalized.priorMessages?.length) {
      for (const msg of normalized.priorMessages) {
        if (msg.role === "user" || msg.role === "assistant" || msg.role === "system") {
          this.conversationHistory.push({
            role: msg.role,
            content: msg.content,
            timestamp: Date.now(),
          });
        }
      }
    }
  }

  async processMessage(userMessage: string): Promise<string> {
    if (this.isRunning) {
      throw new Error("Agent is already running");
    }

    this.isRunning = true;
    this.abortController = new AbortController();
    let currentUserMessage = userMessage;
    let lastAssistantResponse = "";
    let shouldPersistCurrentMessage = true;

    try {
      while (currentUserMessage) {
        this.currentTurnId = randomUUID();
        if (shouldPersistCurrentMessage) {
          this.persistUserMessage(currentUserMessage);
        }
        this.config.onTurnStart?.();
        this.config.onStatusChange?.("Thinking…");

        const userMsg: CoreAgentMessage = {
          role: "user",
          content: currentUserMessage,
          timestamp: Date.now(),
        };

        const recentEvidenceSummary = this.buildRecentEvidenceSummary(
          this.conversationHistory,
          currentUserMessage
        );

        const inputMessages: CoreAgentMessage[] = [
          ...this.conversationHistory,
          ...(recentEvidenceSummary
            ? [
                {
                  role: "system" as const,
                  content: recentEvidenceSummary,
                  timestamp: Date.now(),
                },
              ]
            : []),
          userMsg,
        ];

        let finalAssistantText = "";
        let streamStarted = false;
        let turnCount = 0;
        let loopError: Error | null = null;
        let wasAborted = false;
        let activeWorkflowStage: string | null = null;
        let sawToolActivity = false;
        let toolsCleared = false;

        const agentTools = this.buildAgentTools();

        const systemPrompt = buildNativeSystemPrompt({
          cwd: this.cwd,
          mcpTools: this.mcpTools,
          providerType: this.providerType,
        });

        const startWorkflowStage = (name: string) => {
          activeWorkflowStage = name;
          this.config.onWorkflowStageStart?.(name);
        };

        const clearToolUi = () => {
          if (toolsCleared) return;
          toolsCleared = true;
          this.config.onToolEnd?.();
        };

        const completeWorkflowStage = (name = activeWorkflowStage) => {
          if (!name) return;
          this.config.onWorkflowStageComplete?.(name);
          if (activeWorkflowStage === name) {
            activeWorkflowStage = null;
          }
        };

        const failWorkflowStage = (name = activeWorkflowStage) => {
          if (!name) return;
          this.config.onWorkflowStageFail?.(name);
          if (activeWorkflowStage === name) {
            activeWorkflowStage = null;
          }
        };

        const emit = async (event: AgentEvent): Promise<void> => {
          switch (event.type) {
            case "text_delta":
              if (!streamStarted) {
                streamStarted = true;
                this.config.onStreamingStart?.();
              }
              finalAssistantText += event.text;
              this.config.onStreamingChunk?.(event.text);
              break;

            case "turn_start":
              turnCount++;
              this.config.onIterationChange?.(
                turnCount,
                this.config.maxIterations ?? 50
              );
              if (turnCount > 1) {
                if (streamStarted) {
                  this.config.onStreamingEnd?.();
                  if (finalAssistantText) {
                    this.config.onCotMessage?.(finalAssistantText);
                  }
                  streamStarted = false;
                  finalAssistantText = "";
                }
              }
              if (!activeWorkflowStage) {
                startWorkflowStage(
                  turnCount === 1
                    ? this.describeInitialWorkflowStage(currentUserMessage)
                    : "Plan next step"
                );
              }
              break;

            case "turn_end":
              break;

            case "tool_start":
              sawToolActivity = true;
              completeWorkflowStage();
              startWorkflowStage(this.describeToolWorkflowStage(event.toolName));
              this.config.onStatusChange?.(`Running ${event.toolName}…`);
              this.config.onToolStart?.(event.toolName, event.args);
              this.config.onToolUpdate?.(event.toolName, "running");
              break;

            case "tool_update":
              break;

            case "tool_end": {
              if (event.isError) {
                failWorkflowStage();
              } else {
                completeWorkflowStage();
              }
              const preview = previewContent(event.result.content);
              this.config.onToolUpdate?.(
                event.toolName,
                event.isError ? "failed" : "succeeded",
                preview
              );
              const transcriptResult = formatToolTranscript(
                event.toolName,
                event.result.content
              );
              this.config.onToolMessage?.(event.toolName, transcriptResult, {
                toolCallId: event.toolCallId,
                isError: event.isError,
              });
              if (this.enableMemory) {
                memory.addToSession({
                  timestamp: Date.now(),
                  role: "tool",
                  content: transcriptResult,
                  metadata: {
                    toolName: event.toolName,
                    isError: event.isError,
                    toolCallId: event.toolCallId,
                    turnId: this.currentTurnId ?? undefined,
                  },
                });
              }
              break;
            }

            case "error":
              loopError = event.error;
              failWorkflowStage();
              this.config.onStatusChange?.("");
              if (streamStarted) {
                this.config.onStreamingEnd?.();
                streamStarted = false;
              }
              break;

            case "aborted":
              wasAborted = true;
              failWorkflowStage();
              this.config.onStatusChange?.("");
              if (streamStarted) {
                this.config.onStreamingEnd?.();
                streamStarted = false;
              }
              break;

            case "agent_end":
              break;
          }
        };

        try {
          const newMessages = await runLoop(
            inputMessages,
            agentTools,
            this.provider,
            {
              systemPrompt,
              maxTurns: this.config.maxIterations ?? 50,
              getSteeringMessages: async () => this.takeQueuedMessages("steer"),
            },
            emit,
            this.abortController.signal
          );

          if (streamStarted) {
            this.config.onStreamingEnd?.();
            streamStarted = false;
          }

          this.conversationHistory = [...inputMessages, ...newMessages];
          this.trimConversationHistory();

          if (wasAborted || this.abortController.signal.aborted) {
            clearToolUi();
            this.config.onStatusChange?.("");
            const abortError = new Error("Interrupted");
            abortError.name = "AbortError";
            throw abortError;
          }

          if (loopError && !finalAssistantText) {
            throw loopError;
          }

          const lastAssistantMessage = [...newMessages]
            .reverse()
            .find(
              (message): message is Extract<CoreAgentMessage, { role: "assistant" }> =>
                message.role === "assistant"
            );
          if (!finalAssistantText && lastAssistantMessage?.content.trim()) {
            finalAssistantText = lastAssistantMessage.content.trim();
          }

          const hadToolCalls = newMessages.some((m) => m.role === "tool_result");
          const lastMsg = newMessages[newMessages.length - 1];
          if (!finalAssistantText && lastMsg?.role === "tool_result") {
            const limit = this.config.maxIterations ?? 50;
            finalAssistantText = `Reached the maximum of ${limit} iterations. The task may be incomplete — send a follow-up message to continue.`;
            this.config.onStreamingStart?.();
            this.config.onStreamingChunk?.(finalAssistantText);
            this.config.onStreamingEnd?.();
            streamStarted = false;
          }

          if (!finalAssistantText && !hadToolCalls) {
            finalAssistantText =
              "(No response — the model returned empty content. Try rephrasing your request.)";
            this.config.onStreamingStart?.();
            this.config.onStreamingChunk?.(finalAssistantText);
            this.config.onStreamingEnd?.();
          }

          if (finalAssistantText) {
            completeWorkflowStage();
            if (sawToolActivity) {
              startWorkflowStage("Summarize findings");
              completeWorkflowStage("Summarize findings");
            }
            this.config.onAssistantMessage?.(finalAssistantText);
          }
          this.saveAssistantToMemory(finalAssistantText);
          this.refreshContextUsage();
          await this.maybeAutoCompactSession();
          clearToolUi();
          this.config.onStatusChange?.("");
          this.config.onTurnEnd?.({ success: true });
          lastAssistantResponse = finalAssistantText;
        } catch (error) {
          if (activeWorkflowStage) {
            failWorkflowStage(activeWorkflowStage);
          }
          if (streamStarted) {
            this.config.onStreamingEnd?.();
          }
          clearToolUi();
          this.config.onStatusChange?.("");
          const message = error instanceof Error ? error.message : String(error);
          this.config.onTurnEnd?.({ success: false, error: message });
          if (!(error instanceof Error && error.name === "AbortError")) {
            this.config.onError?.(error as Error);
          }
          throw error;
        }

        const nextQueuedMessage = this.takeNextFollowUpMessage();
        currentUserMessage = nextQueuedMessage?.content ?? "";
        shouldPersistCurrentMessage = false;
      }

      return lastAssistantResponse;
    } finally {
      this.isRunning = false;
      this.abortController = null;
      this.currentTurnId = null;
    }
  }

  abort(): void {
    this.abortController?.abort();
  }

  isProcessing(): boolean {
    return this.isRunning;
  }

  queueMessage(userMessage: string, mode: "steer" | "followUp" = "steer"): boolean {
    const trimmed = userMessage.trim();
    if (!trimmed) {
      return false;
    }

    const queuedMessage: CoreAgentMessage = {
      role: "user",
      content: trimmed,
      timestamp: Date.now(),
    };

    if (mode === "followUp") {
      this.followUpQueue.push(queuedMessage);
    } else {
      this.steeringQueue.push(queuedMessage);
    }

    this.persistUserMessage(trimmed);
    this.notifyQueueUpdate([
      {
        action: "queued",
        mode,
        message: trimmed,
      },
    ]);
    return true;
  }

  private describeInitialWorkflowStage(userMessage: string): string {
    const prompt = userMessage.toLowerCase();

    if (/\bsecurity\b|\baudit\b|\bvulnerab|\bscan\b/.test(prompt)) {
      return "Inspect project for security review";
    }
    if (/\btest\b|\bfail(?:ing|ed)?\b|\bbug\b|\berror\b/.test(prompt)) {
      return "Inspect failing area";
    }
    if (/\brefactor\b|\bedit\b|\bchange\b|\bimplement\b|\bfix\b/.test(prompt)) {
      return "Inspect code to change";
    }
    if (/\bexplain\b|\bunderstand\b|\bwhat is\b|\bcurrent project\b/.test(prompt)) {
      return "Inspect repository";
    }

    return "Inspect repository";
  }

  private describeToolWorkflowStage(toolName: string): string {
    const name = toolName.toLowerCase();

    if (["analyze_project", "list_files", "find_files", "read_folder"].includes(name)) {
      return "Inspect repository layout";
    }
    if (["read_file", "read_many_files", "grep", "search_text", "semantic_search", "find_references", "get_file_outline", "find_symbol_definition", "explain_code"].includes(name)) {
      return "Inspect source code";
    }
    if (["dependency_audit", "package_list", "package_install"].includes(name)) {
      return "Audit dependencies";
    }
    if (["security_scan", "validate_project", "check_syntax", "code_review", "check_complexity", "detect_smells", "analyze_coverage", "run_tests"].includes(name)) {
      return "Scan project health";
    }
    if (["propose_edit", "edit_line", "write_file", "delete_file", "move_file", "create_directory", "format_code", "organize_imports", "fix_lint"].includes(name)) {
      return "Apply code changes";
    }
    if (name.startsWith("git_")) {
      return "Inspect git state";
    }
    if (["run_command", "package_run_script"].includes(name)) {
      return "Run project command";
    }

    return this.humanizeToolName(toolName);
  }

  private humanizeToolName(toolName: string): string {
    return toolName
      .split("_")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  private buildRecentEvidenceSummary(
    history: CoreAgentMessage[],
    userMessage: string
  ): string | null {
    if (history.length === 0) {
      return null;
    }

    const recentToolResults = history
      .filter(
        (message): message is Extract<CoreAgentMessage, { role: "tool_result" }> =>
          message.role === "tool_result"
      )
      .slice(-4);

    const recentAssistantMessages = history
      .filter(
        (message): message is Extract<CoreAgentMessage, { role: "assistant" }> =>
          message.role === "assistant"
      )
      .slice(-2)
      .map((message) => this.truncateForSummary(message.content, 220))
      .filter(Boolean);

    if (recentToolResults.length === 0 && recentAssistantMessages.length === 0) {
      return null;
    }

    const toolSummaryLines = recentToolResults.map((result) => {
      const preview = this.truncateForSummary(result.content, 220);
      const errorTag = result.isError ? " (error)" : "";
      return `- ${result.toolName}${errorTag}: ${preview}`;
    });

    const lowerUserMessage = userMessage.toLowerCase();
    const focusHint =
      /\bsecurity\b|\baudit\b|\breview\b|\bscan\b/.test(lowerUserMessage)
        ? "Focus on turning the gathered evidence into concrete findings and only gather more context if a specific gap remains."
        : /\bfix\b|\bedit\b|\bchange\b|\bimplement\b|\brefactor\b/.test(
              lowerUserMessage
            )
          ? "Use the gathered evidence to make the smallest coherent change, then verify it."
          : "Use the gathered evidence to choose the next most specific action instead of repeating broad inspection tools.";

    const sections: string[] = [
      "## Recent Evidence",
      "Use this as a compact memory of the latest verified context. Do not repeat the same broad tool calls unless the latest evidence clearly requires it.",
    ];

    if (toolSummaryLines.length > 0) {
      sections.push("Latest tool results:");
      sections.push(toolSummaryLines.join("\n"));
    }

    if (recentAssistantMessages.length > 0) {
      sections.push("Latest assistant conclusions:");
      sections.push(
        recentAssistantMessages.map((message) => `- ${message}`).join("\n")
      );
    }

    sections.push(`Next-step guidance: ${focusHint}`);
    return sections.join("\n\n");
  }

  private truncateForSummary(content: string, maxLength: number): string {
    const normalized = content.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return "";
    }
    if (normalized.length <= maxLength) {
      return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
  }

  private saveAssistantToMemory(content: string): void {
    if (!this.enableMemory || !content.trim()) return;
    memory.addToSession({
      timestamp: Date.now(),
      role: "assistant",
      content,
      metadata: {
        provider: this.providerType,
        model: this.model,
        turnId: this.currentTurnId ?? undefined,
      },
    });
  }

  private persistUserMessage(content: string): void {
    if (!this.enableMemory || !content.trim()) return;
    memory.addToSession({
      timestamp: Date.now(),
      role: "user",
      content,
      metadata: {
        provider: this.providerType,
        model: this.model,
        turnId: this.currentTurnId ?? undefined,
      },
    });
  }

  private takeQueuedMessages(mode: "steer" | "followUp"): CoreAgentMessage[] {
    const queue = mode === "followUp" ? this.followUpQueue : this.steeringQueue;
    const next = queue.shift();
    if (next) {
      this.notifyQueueUpdate([
        {
          action: "delivered",
          mode,
          message: next.content,
        },
      ]);
    }
    return next ? [next] : [];
  }

  private takeNextFollowUpMessage(): CoreAgentMessage | null {
    const next = this.followUpQueue.shift() ?? null;
    if (next) {
      this.notifyQueueUpdate([
        {
          action: "delivered",
          mode: "followUp",
          message: next.content,
        },
      ]);
    }
    return next;
  }

  private trimConversationHistory(): void {
    if (this.conversationHistory.length > 48) {
      this.conversationHistory = this.conversationHistory.slice(
        this.conversationHistory.length - 48
      );
    }
  }

  private refreshContextUsage(): void {
    const stats = memory.getCurrentSessionContextStats(this.cwd);
    if (!stats) {
      return;
    }
    const estimatedTokens = Math.ceil(stats.totalChars / 4);
    this.sessionTracker?.trackContextUsage(estimatedTokens);
  }

  private async maybeAutoCompactSession(): Promise<void> {
    if (!this.enableMemory || !this.compaction?.enabled) {
      return;
    }

    const stats = memory.getCurrentSessionContextStats(this.cwd);
    if (!stats) {
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

    this.config.onStatusChange?.("Compacting session…");
    const result = memory.compactCurrentSession(this.cwd, {
      keepRecentMessages: this.compaction.keepRecentMessages,
    });
    if (!result) {
      this.refreshContextUsage();
      return;
    }

    const sessionPath = memory.getCurrentSessionPath();
    if (sessionPath) {
      this.conversationHistory = memory
        .loadChatMessages(sessionPath, {
          maxMessages: this.compaction.keepRecentMessages + 6,
        })
        .map((message) => ({
          role: message.role,
          content: message.content,
          timestamp: Date.now(),
        }));
      this.trimConversationHistory();
    }
    this.refreshContextUsage();
  }

  private notifyQueueUpdate(
    changes?: Array<{
      action: "queued" | "delivered";
      mode: "steer" | "followUp";
      message: string;
    }>
  ): void {
    if (this.enableMemory) {
      for (const change of changes ?? []) {
        memory.addToSession({
          timestamp: Date.now(),
          role: "system",
          content: `${change.action === "queued" ? "Queued" : "Delivered"} ${
            change.mode === "followUp" ? "follow-up" : "steer"
          }: ${change.message}`,
          metadata: {
            provider: this.providerType,
            model: this.model,
            turnId: this.currentTurnId ?? undefined,
            queueAction: change.action,
            queueMode: change.mode,
          },
        });
      }
    }

    this.config.onQueueUpdate?.({
      steering: this.steeringQueue.map((message) => message.content),
      followUp: this.followUpQueue.map((message) => message.content),
      changes,
    });
  }

  private async reviewFileEdit(edit: FileEdit): Promise<boolean> {
    if (!this.config.promptChoice) return false;

    const diff = generateDiff(edit.oldContent, edit.newContent);
    const previewLines = diff.slice(0, 20);
    const more = diff.length > 20 ? `\n… ${diff.length - 20} more lines` : "";
    const diffBlock = previewLines.join("\n") + more;

    const choice = await this.config.promptChoice(
      `**Proposed edit:** \`${edit.path}\`\n${edit.description ?? ""}\n\`\`\`diff\n${diffBlock}\n\`\`\``,
      [
        { label: "Apply", value: "apply" },
        { label: "Skip", value: "skip" },
        { label: "Cancel all", value: "cancel" },
      ],
      "apply"
    );

    if (choice === "cancel") {
      throw new Error("Edit cancelled by user");
    }

    if (choice === "apply") {
      this.editedFiles.add(edit.path);
      return true;
    }

    return false;
  }

  private async confirmCommand(command: string): Promise<boolean> {
    const cmd = command.trim();

    // Block unambiguously destructive patterns regardless of anything else
    const blockedPatterns = [
      /rm\s+-[a-z]*r[a-z]*f|rm\s+-[a-z]*f[a-z]*r/i,    // rm -rf / rm -fr
      /\bformat\s+(c:|\/dev\/)/i,
      /\bmkfs\b/i,
      /\bdd\s+if=.*of=\/dev\//i,
      /\bshutdown\b|\breboot\b|\binit\s+0\b/i,
      /\bsudo\s+rm\b/i,
      /\bdel\s+\/[sf]/i,
      /\brd\s+\/s/i,
    ];
    if (blockedPatterns.some((p) => p.test(cmd))) {
      return false;
    }

    // Auto-approve read-only and common dev-workflow commands
    const safePatterns = [
      // git — all read operations
      /^git\s+(status|diff|log|branch|show|describe|rev-parse|shortlog|tag|ls-files|ls-remote|blame|stash list|remote|fetch\s+--dry-run|config\s+--list|reflog|cherry|check-ignore)/i,
      // npm — build, test, info, audit, listing
      /^npm\s+(run|test|build|install|i|ci|audit|ls|list|outdated|info|view|pack|version|help|fund|ping|prefix|bin)(\s|$)/i,
      // yarn — build, test, info, audit
      /^yarn(\s+(run|test|build|install|audit|list|outdated|info|versions|check|help|why|licenses|bin|config))?(\s|$)/i,
      // pnpm — build, test, info, audit
      /^pnpm\s+(run|test|build|install|audit|list|ls|outdated|info|why|licenses)(\s|$)/i,
      // npx for common read/check tools
      /^npx\s+(tsc|eslint|prettier|jest|vitest|mocha|ts-node|tsx|vite build|next build|nuxt build|rollup|esbuild|swc|turbo)(\s|$)/i,
      // runtime version / help queries
      /^(node|npm|npx|yarn|pnpm|bun|deno|go|python3?|ruby|java|rustc|cargo)\s+(--version|-v|--help|-h|version)(\s|$)/i,
      // OS read-only
      /^(ls|dir|cat|head|tail|grep|rg|find|fd|bat|less|more|type)\s/i,
      /^(ls|dir|pwd|echo|printf|env|whoami|hostname|uname|date|which|where|type)(\s|$)/i,
      // package.json scripts via node/bun
      /^(node|bun)\s+--?\w/i,
    ];

    if (safePatterns.some((p) => p.test(cmd))) return true;

    if (!this.config.promptChoice) {
      // No TUI prompt available — auto-approve non-destructive commands
      return true;
    }

    const choice = await this.config.promptChoice(
      `**Run shell command:**\n\`\`\`\n${command}\n\`\`\``,
      [
        { label: "Run", value: "run" },
        { label: "Cancel", value: "cancel" },
      ],
      "run"
    );

    return choice === "run";
  }

  private buildAgentTools(): AgentTool[] {
    const legacyTools = createMeerAgentTools(
      {
        cwd: this.cwd,
        provider: this.config.provider,
        reviewFileEdit: (edit) => this.reviewFileEdit(edit),
        executeMcpTool: async (toolName, input) => {
          const result = await this.mcpManager.executeTool(toolName, input);
          if (!result.success) {
            throw new Error(result.error ?? `Failed to execute MCP tool ${toolName}`);
          }
          return result.content
            .map((entry) => ("text" in entry ? entry.text : JSON.stringify(entry)))
            .join("\n") || "Tool completed.";
        },
        confirmCommand: (command) => this.confirmCommand(command),
      },
      { mcpTools: this.mcpTools }
    );

    return legacyTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as AgentTool["inputSchema"],
      async execute(_toolCallId, input, _signal, _onUpdate) {
        try {
          const content = await tool.call(input);
          return { content: String(content), isError: false };
        } catch (err) {
          return {
            content: err instanceof Error ? err.message : String(err),
            isError: true,
          };
        }
      },
    }));
  }
}

function previewContent(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function formatToolTranscript(toolName: string, result: string): string {
  const normalized = result.trim();
  if (!normalized) return `Tool: ${toolName}\nResult: (empty)`;

  if (["read_file", "list_files", "read_folder", "read_many_files"].includes(toolName)) {
    const lines = normalized.split("\n");
    if (normalized.length > 4000 || lines.length > 120) {
      const previewLines = lines.slice(0, 80).join("\n");
      const omittedLines = Math.max(0, lines.length - 80);
      return [
        `Tool: ${toolName}`,
        `Result (truncated - ${normalized.length} chars, ${lines.length} lines):`,
        previewLines,
        "",
        `[... ${omittedLines} more lines omitted. Read narrower sections if needed]`,
      ].join("\n");
    }
  }

  return `Tool: ${toolName}\nResult:\n${normalized}`;
}
