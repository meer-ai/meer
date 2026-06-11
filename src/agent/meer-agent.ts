import type { Provider, ChatMessage } from "../providers/base.js";
import { ProviderWrapper } from "../providers/provider-wrapper.js";
import { memory } from "../memory/index.js";
import { MCPManager } from "../mcp/manager.js";
import type { MCPTool } from "../mcp/types.js";
import { createMeerAgentTools } from "./tools/agent.js";
import type { AgentTool } from "./core/types.js";
import type { AgentToolCallResult } from "./runtime/types.js";
import { runLoop } from "./core/loop.js";
import type { AgentEvent } from "./core/types.js";
import type { AgentMessage as CoreAgentMessage } from "./core/types.js";
import { generateDiff, type FileEdit } from "../tools/index.js";
import { backgroundTerminals } from "../runtime/backgroundTerminals.js";
import {
  formatSkillInvocation,
  loadSkillsForCwd,
  type Skill,
  type SkillDiagnostic,
} from "../skills/index.js";
import type {
  RuntimeExecutionEvent,
  RuntimeProcessResult,
} from "./agent-session.js";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeToolOutput } from "../utils/output-sanitize.js";

// Re-export the config type so cli.ts can use it
export interface MeerAgentConfig {
  provider: Provider;
  cwd: string;
  maxIterations?: number;
  enableMemory?: boolean;
  autoCollectContext?: boolean;
  providerType?: string;
  model?: string;
  onStreamingStart?: () => void;
  onStreamingChunk?: (chunk: string) => void;
  onStreamingEnd?: () => void;
  onAssistantMessage?: (content: string) => void;
  onCotMessage?: (content: string) => void;
  onToolStart?: (
    tool: string,
    args: unknown,
    metadata?: { toolCallId?: string }
  ) => void;
  onToolCallDelta?: (
    tool: string | undefined,
    inputTextDelta: string,
    metadata: { toolCallId: string }
  ) => void;
  onToolUpdate?: (
    tool: string,
    status: string,
    result?: string,
    metadata?: { toolCallId?: string; details?: Record<string, unknown> }
  ) => void;
  onToolMessage?: (
    tool: string,
    result: string,
    metadata?: { toolCallId?: string; isError?: boolean; details?: Record<string, unknown> }
  ) => void;
  onToolEnd?: () => void;
  onError?: (error: Error) => void;
  promptChoice?: (
    message: string,
    choices: Array<{ label: string; value: string }>,
    defaultChoice?: string
  ) => Promise<string>;
  promptForm?: (
    title: string,
    questions: Array<{
      id: string;
      label: string;
      type: "select" | "multiselect";
      required?: boolean;
      options: Array<{ label: string; value: string; description?: string }>;
    }>,
    submitLabel?: string
  ) => Promise<Record<string, string | string[]>>;
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
  private abortController: AbortController | null = null;
  private isRunning = false;
  private enableMemory: boolean;
  private providerType: string;
  private model: string;
  private skills: Skill[] = [];
  private skillDiagnostics: SkillDiagnostic[] = [];
  private editedFiles = new Set<string>();
  /**
   * Session-level shell cwd. Each `run_command` call lands in here by
   * default; bare `cd <path>` commands update it instead of running. Pi
   * has a full persistent-bash backend; this is the light approximation
   * that covers the common "cd foo / npm test" workflow.
   */
  private shellCwd: string = "";
  private externalQueueAccessors:
    | {
        takeQueuedMessages: (mode: "steer" | "followUp") => CoreAgentMessage[];
      }
    | null = null;
  private sessionEventSink:
    | ((event: import("./agent-session.js").AgentSessionEvent) => void)
    | null = null;
  private executionEventSink: ((event: RuntimeExecutionEvent) => void) | null = null;

  constructor(config: MeerAgentConfig) {
    this.config = config;
    this.provider = new ProviderWrapper(config.provider, {
      name: config.providerType ?? "Provider",
    });
    this.cwd = config.cwd;
    this.shellCwd = config.cwd;
    this.enableMemory = config.enableMemory ?? true;
    this.providerType = config.providerType ?? "unknown";
    this.model = config.model ?? "unknown";
  }

  /** Current session-level shell cwd. Defaults to the project cwd. */
  getShellCwd(): string {
    return this.shellCwd || this.cwd;
  }

  async initialize(
    options?: string | MeerAgentInitOptions
  ): Promise<void> {
    if (!this.mcpManager.isInitialized()) {
      await this.mcpManager.initialize();
    }
    this.mcpTools = this.mcpManager.listAllTools();
    await this.reloadSkills();
  }

  async processMessage(
    userMessage: string,
    options?: {
      persistUserMessage?: boolean;
      turnId?: string;
      preparedMessages?: CoreAgentMessage[];
      systemPrompt?: string;
      attachments?: import("./core/types.js").MessageAttachment[];
    }
  ): Promise<RuntimeProcessResult> {
    if (this.isRunning) {
      throw new Error("Agent is already running");
    }

    this.isRunning = true;
    this.abortController = new AbortController();

    try {
      const turnId = options?.turnId;
      if (options?.persistUserMessage !== false) {
        this.persistUserMessage(userMessage, turnId);
      }
        this.sessionEventSink?.({ type: "turn_start" });
        this.sessionEventSink?.({ type: "status_change", status: "Thinking…" });

        const inputMessages: CoreAgentMessage[] =
          options?.preparedMessages?.length
            ? options.preparedMessages
            : [
                {
                  role: "user",
                  content: userMessage,
                  attachments: options?.attachments,
                  timestamp: Date.now(),
                },
              ];

        // When preparedMessages is provided (already-built history), attach
        // images to its last user message — that's the one we're sending now.
        if (
          options?.preparedMessages?.length &&
          options.attachments?.length
        ) {
          for (let i = inputMessages.length - 1; i >= 0; i--) {
            const msg = inputMessages[i];
            if (msg.role === "user") {
              inputMessages[i] = {
                ...msg,
                attachments: [
                  ...(msg.attachments ?? []),
                  ...options.attachments,
                ],
              };
              break;
            }
          }
        }

        let finalAssistantText = "";
        let currentAssistantText = "";
        // Text the model streamed before its first tool call in a given turn.
        // Not committed immediately — held until the turn's final assistant
        // message arrives so we can prepend it, avoiding orphaned one-liners
        // like "## List" appearing as stranded standalone fragments mid-turn.
        let preToolPreamble = "";
        const settledAssistantMessages = new Set<string>();
        let streamStarted = false;
        let turnCount = 0;
        let loopError: Error | null = null;
        let wasAborted = false;
        let toolsCleared = false;

        const agentTools = this.buildAgentTools();

        const systemPrompt =
          options?.systemPrompt ??
          `You are Meer AI, a coding assistant. Use the provided messages and tools to complete the task.`;

        const clearToolUi = () => {
          if (toolsCleared) return;
          toolsCleared = true;
          this.config.onToolEnd?.();
        };

        // Stops the streaming animation and optionally commits text to the
        // permanent message history.
        // toolInterrupt=true: called because a tool call is starting — stop
        //   the animation but save the text as a preamble to prepend to the
        //   final response rather than committing it as a standalone message.
        // toolInterrupt=false (default): normal settle between turns — commit.
        const settleCurrentAssistantText = (toolInterrupt = false) => {
          if (streamStarted) {
            this.config.onStreamingEnd?.();
            streamStarted = false;
          }

          const text = currentAssistantText.trim();
          currentAssistantText = "";

          if (!text) return;

          if (toolInterrupt) {
            // Keep the preamble visible in the draft while tools run;
            // it will be merged into the final committed message later.
            if (!preToolPreamble) {
              preToolPreamble = text;
            }
            return;
          }

          if (!settledAssistantMessages.has(text)) {
            this.config.onAssistantMessage?.(text);
            settledAssistantMessages.add(text);
            this.saveAssistantToMemory(text, turnId);
          }
        };

        const emit = async (event: AgentEvent): Promise<void> => {
          switch (event.type) {
            case "text_delta":
              if (!streamStarted) {
                streamStarted = true;
                this.config.onStreamingStart?.();
              }
              currentAssistantText += event.text;
              finalAssistantText = currentAssistantText;
              this.config.onStreamingChunk?.(event.text);
              break;

            case "turn_start":
              turnCount++;
              this.executionEventSink?.({
                type: "iteration",
                current: turnCount,
                max: this.config.maxIterations,
              });
              if (turnCount > 1) {
                settleCurrentAssistantText(); // commit, not a tool interrupt
                preToolPreamble = "";         // new turn — preamble no longer relevant
                finalAssistantText = "";
              }
              break;

            case "turn_end":
              break;

            case "tool_call_delta":
              settleCurrentAssistantText(true); // stop stream, hold as preamble
              this.config.onToolCallDelta?.(
                event.toolName,
                event.inputTextDelta,
                { toolCallId: event.toolCallId }
              );
              break;

            case "tool_start":
              settleCurrentAssistantText(true); // stop stream, hold as preamble
              this.executionEventSink?.({
                type: "tool_start",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
              });
              this.config.onToolStart?.(event.toolName, event.args, {
                toolCallId: event.toolCallId,
              });
              this.config.onToolUpdate?.(event.toolName, "running", undefined, {
                toolCallId: event.toolCallId,
              });
              break;

            case "tool_update":
              this.config.onToolUpdate?.(
                event.toolName,
                "running",
                previewContent(event.partial),
                { toolCallId: event.toolCallId }
              );
              break;

            case "tool_end": {
              this.executionEventSink?.({
                type: "tool_end",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                success: !event.isError,
              });
              const preview = previewContent(event.result.content);
              this.config.onToolUpdate?.(
                event.toolName,
                event.isError ? "failed" : "succeeded",
                preview,
                { toolCallId: event.toolCallId, details: event.result.details }
              );
              const transcriptResult = formatToolTranscript(
                event.toolName,
                event.result.content
              );
              this.config.onToolMessage?.(event.toolName, transcriptResult, {
                toolCallId: event.toolCallId,
                isError: event.isError,
                details: event.result.details,
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
                    turnId,
                  },
                });
              }
              break;
            }

            case "error":
              loopError = event.error;
              this.sessionEventSink?.({ type: "status_change", status: "" });
              if (streamStarted) {
                this.config.onStreamingEnd?.();
                streamStarted = false;
              }
              break;

            case "aborted":
              wasAborted = true;
              this.sessionEventSink?.({ type: "status_change", status: "" });
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
              maxTurns: this.config.maxIterations,
              getSteeringMessages: async () => this.takeQueuedMessages("steer"),
              getFollowUpMessages: async () => this.takeQueuedMessages("followUp"),
            },
            emit,
            this.abortController.signal
          );

          if (streamStarted) {
            this.config.onStreamingEnd?.();
            streamStarted = false;
          }

          const updatedConversationHistory = [...inputMessages, ...newMessages];

          if (wasAborted || this.abortController.signal.aborted) {
            clearToolUi();
            this.sessionEventSink?.({ type: "status_change", status: "" });
            const abortError = new Error("Interrupted");
            abortError.name = "AbortError";
            throw abortError;
          }

          // TS can't see the emit-closure assignment, so read through a copy.
          const streamFailure = loopError as Error | null;
          if (streamFailure) {
            if (!finalAssistantText) {
              throw streamFailure;
            }
            // The stream failed after partial output. Don't report the turn as
            // a clean success — append a visible notice so the user knows the
            // response is incomplete and why.
            const notice = `\n\n[Provider error after partial response: ${streamFailure.message}. The answer above may be incomplete — send a follow-up to continue.]`;
            finalAssistantText = `${finalAssistantText}${notice}`;
            this.config.onStreamingStart?.();
            this.config.onStreamingChunk?.(notice);
            this.config.onStreamingEnd?.();
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
          const terminalAssistantMessages = newMessages.filter(
            (
              message
            ): message is Extract<CoreAgentMessage, { role: "assistant" }> =>
              message.role === "assistant" &&
              !message.toolCalls?.length &&
              message.content.trim().length > 0
          );
          if (!finalAssistantText && lastMsg?.role === "tool_result") {
            if (this.config.maxIterations && turnCount >= this.config.maxIterations) {
              const limit = this.config.maxIterations;
              finalAssistantText = `Reached the configured safety limit of ${limit} turns. The task may be incomplete — send a follow-up message to continue.`;
              this.config.onStreamingStart?.();
              this.config.onStreamingChunk?.(finalAssistantText);
              this.config.onStreamingEnd?.();
              streamStarted = false;
            }
          }

          if (!finalAssistantText && !hadToolCalls) {
            finalAssistantText =
              "(No response — the model returned empty content. Try rephrasing your request.)";
            this.config.onStreamingStart?.();
            this.config.onStreamingChunk?.(finalAssistantText);
            this.config.onStreamingEnd?.();
          }

          // Tools ran but the model never produced a final response (some
          // providers return empty content after tool results). Without this
          // notice the turn ends in dead silence — the #1 "meer suddenly
          // stopped working" report.
          if (!finalAssistantText && hadToolCalls) {
            finalAssistantText =
              "The model ended the turn after running tools without a final response. This usually means the provider returned empty content — send a follow-up (e.g. “continue”) to keep going.";
            this.config.onStreamingStart?.();
            this.config.onStreamingChunk?.(finalAssistantText);
            this.config.onStreamingEnd?.();
            streamStarted = false;
          }

          // If the model opened with text before calling tools (e.g. "## List"),
          // that text was held as preToolPreamble rather than committed.
          // Prepend it to the final assistant message so it appears as one
          // coherent block rather than a stranded fragment.
          if (preToolPreamble && !settledAssistantMessages.has(preToolPreamble)) {
            if (finalAssistantText && !finalAssistantText.startsWith(preToolPreamble)) {
              finalAssistantText = `${preToolPreamble}\n\n${finalAssistantText}`;
            } else if (!finalAssistantText) {
              finalAssistantText = preToolPreamble;
            }
          }

          if (finalAssistantText) {
            const intermediateAssistantMessages = terminalAssistantMessages.slice(0, -1);
            for (const message of intermediateAssistantMessages) {
              const text = message.content.trim();
              if (!settledAssistantMessages.has(text)) {
                this.config.onAssistantMessage?.(text);
                this.saveAssistantToMemory(text, turnId);
                settledAssistantMessages.add(text);
              }
            }
            if (!settledAssistantMessages.has(finalAssistantText)) {
              this.config.onAssistantMessage?.(finalAssistantText);
              this.saveAssistantToMemory(finalAssistantText, turnId);
              settledAssistantMessages.add(finalAssistantText);
            }
          }
          clearToolUi();
          this.sessionEventSink?.({ type: "status_change", status: "" });
          this.sessionEventSink?.({ type: "turn_end", success: true });
          return {
            response: finalAssistantText,
            conversationHistory: updatedConversationHistory,
          };
        } catch (error) {
          // Each cleanup step is isolated. Without this, a thrown listener
          // on (say) onStreamingEnd would prevent the turn_end emit, which
          // is what makes the UI clear `tools`/`workflowStages` — so the
          // chat would end up frozen with stale "Running …" widgets.
          const safeRun = (label: string, fn: () => void) => {
            try {
              fn();
            } catch (cleanupErr) {
              // Don't import diagnostics here to avoid a cycle; the cli.ts
              // and InkChatAdapter layers record via their own boundaries.
              // We just swallow so cleanup continues.
              void label;
              void cleanupErr;
            }
          };

          if (streamStarted) {
            safeRun("onStreamingEnd", () => this.config.onStreamingEnd?.());
          }
          safeRun("clearToolUi", () => clearToolUi());
          safeRun("status_change", () =>
            this.sessionEventSink?.({ type: "status_change", status: "" })
          );
          const message = error instanceof Error ? error.message : String(error);
          safeRun("turn_end", () =>
            this.sessionEventSink?.({
              type: "turn_end",
              success: false,
              error: message,
            })
          );
          if (!(error instanceof Error && error.name === "AbortError")) {
            safeRun("onError", () => this.config.onError?.(error as Error));
          }
          throw error;
        }
    } finally {
      this.isRunning = false;
      this.abortController = null;
    }
  }

  abort(): void {
    this.abortController?.abort();
  }

  isProcessing(): boolean {
    return this.isRunning;
  }

  setQueueAccessors(accessors: {
    takeQueuedMessages: (mode: "steer" | "followUp") => CoreAgentMessage[];
  }): void {
    this.externalQueueAccessors = accessors;
  }

  getProviderIdentity(): { providerType: string; model: string } {
    return {
      providerType: this.providerType,
      model: this.model,
    };
  }

  getProvider(): Provider {
    return this.provider;
  }

  async refreshPromptContext(): Promise<void> {
    await this.reloadSkills();
  }

  getPromptContext(): {
    cwd: string;
    mcpTools: MCPTool[];
    providerType: string;
    skills: Skill[];
  } {
    return {
      cwd: this.cwd,
      mcpTools: [...this.mcpTools],
      providerType: this.providerType,
      skills: [...this.skills],
    };
  }

  setSessionEventSink(
    sink: (event: import("./agent-session.js").AgentSessionEvent) => void
  ): void {
    this.sessionEventSink = sink;
  }

  setExecutionEventSink(sink: (event: RuntimeExecutionEvent) => void): void {
    this.executionEventSink = sink;
  }

  recordQueueChange(change: {
    action: "queued" | "delivered";
    mode: "steer" | "followUp";
    message: string;
  }, options?: { turnId?: string }): void {
    if (!this.enableMemory) {
      return;
    }
    memory.addToSession({
      timestamp: Date.now(),
      role: "system",
      content: `${change.action === "queued" ? "Queued" : "Delivered"} ${
        change.mode === "followUp" ? "follow-up" : "steer"
      }: ${change.message}`,
      metadata: {
        provider: this.providerType,
        model: this.model,
        turnId: options?.turnId,
        queueAction: change.action,
        queueMode: change.mode,
      },
    });
  }

  persistQueuedUserMessage(content: string, options?: { turnId?: string }): void {
    this.persistUserMessage(content, options?.turnId);
  }

  private saveAssistantToMemory(content: string, turnId?: string): void {
    if (!this.enableMemory || !content.trim()) return;
    memory.addToSession({
      timestamp: Date.now(),
      role: "assistant",
      content,
      metadata: {
        provider: this.providerType,
        model: this.model,
        turnId,
      },
    });
  }

  private persistUserMessage(content: string, turnId?: string): void {
    if (!this.enableMemory || !content.trim()) return;
    memory.addToSession({
      timestamp: Date.now(),
      role: "user",
      content,
      metadata: {
        provider: this.providerType,
        model: this.model,
        turnId,
      },
    });
  }

  private takeQueuedMessages(mode: "steer" | "followUp"): CoreAgentMessage[] {
    return this.externalQueueAccessors?.takeQueuedMessages(mode) ?? [];
  }

  getContextStats(): { visibleMessages: number; totalChars: number } | null {
    return memory.getCurrentSessionContextStats(this.cwd);
  }

  async compactSession(options: {
    keepRecentMessages: number;
    summaryGenerator?: (input: import("../session/store.js").CompactionSummaryInput) => Promise<string> | string;
  }): Promise<boolean> {
    const result = await memory.compactCurrentSession(this.cwd, options);
    return Boolean(result);
  }

  private async reviewFileEdit(edit: FileEdit): Promise<boolean> {
    if (!this.config.promptChoice) {
      this.editedFiles.add(edit.path);
      return true;
    }

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
    const skillTools = this.buildSkillTools();
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
        promptForm: (title, questions, submitLabel) => {
          if (!this.config.promptForm) {
            throw new Error("Structured user input is unavailable in this UI.");
          }
          return this.config.promptForm(title, questions, submitLabel);
        },
        startBackgroundCommand: async (command, cwd) => {
          const session = backgroundTerminals.start(command, cwd);
          return {
            id: session.id,
            status: session.status,
            command: session.command,
            cwd: session.cwd,
          };
        },
        getShellCwd: () => this.shellCwd || this.cwd,
        setShellCwd: (path: string) => {
          this.shellCwd = path;
        },
      },
      { mcpTools: this.mcpTools }
    );

    return [
      ...skillTools,
      ...legacyTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as AgentTool["inputSchema"],
        async execute(
          _toolCallId: string,
          input: Record<string, unknown>,
          _signal?: AbortSignal,
          _onUpdate?: (partial: string) => void
        ) {
          try {
            const output = await tool.call(input, _onUpdate, _signal);
            const normalized = normalizeToolCallOutput(output);
            return { ...normalized, isError: normalized.isError ?? false };
          } catch (err) {
            return {
              content: err instanceof Error ? err.message : String(err),
              isError: true,
            };
          }
        },
      })),
    ];
  }

  private async reloadSkills(): Promise<void> {
    const result = await loadSkillsForCwd(this.cwd);
    this.skills = result.skills;
    this.skillDiagnostics = result.diagnostics;
  }

  private buildSkillTools(): AgentTool[] {
    return [
      {
        name: "load_skill",
        description:
          "Load the full instructions for an available Meer agent skill by name. Use this before acting when a task matches a listed skill description.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Skill name from the available_skills list.",
            },
          },
          required: ["name"],
        },
        execute: async (_toolCallId, input) => {
          const rawName = String(input.name ?? "").trim();
          if (!rawName) {
            return {
              content: "load_skill requires a skill name.",
              isError: true,
            };
          }
          const skill = this.skills.find(
            (candidate) => candidate.name.toLowerCase() === rawName.toLowerCase()
          );
          if (!skill) {
            const visible = this.skills
              .filter((candidate) => !candidate.disableModelInvocation)
              .map((candidate) => candidate.name)
              .sort();
            return {
              content:
                visible.length > 0
                  ? `Skill "${rawName}" not found. Available skills: ${visible.join(", ")}`
                  : `Skill "${rawName}" not found. No skills are loaded.`,
              isError: true,
            };
          }
          return {
            content: formatSkillInvocation(skill),
            details: {
              skillName: skill.name,
              source: skill.source,
              filePath: skill.filePath,
              diagnostics: this.skillDiagnostics.length,
            },
          };
        },
      },
    ];
  }
}

function normalizeToolCallOutput(
  output: string | AgentToolCallResult
): { content: string; isError?: boolean; details?: Record<string, unknown> } {
  if (typeof output === "string") {
    return { content: output };
  }
  return {
    content: String(output.content ?? ""),
    isError: output.isError,
    details: output.details,
  };
}

function previewContent(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 1200 ? `${normalized.slice(0, 1197)}...` : normalized;
}

// Universal hard ceiling for any tool result we hand back to the model.
// `run_command` enforces its own (matching) ceiling at exec time and writes
// the full output to a temp file already; this is the catch-all for every
// other tool so an unbounded blob can't be pushed into the conversation
// history and break the context window (or crash the renderer).
const TOOL_RESULT_HARD_LINE_CEILING = 4000;
const TOOL_RESULT_HARD_BYTE_CEILING = 400 * 1024;

export function formatToolTranscript(toolName: string, result: string): string {
  // Drop terminal-corrupting control characters before anything else
  // touches the result. A tool that emits raw NUL/BS/ESC can clear the
  // screen or reset terminal modes when this lands in Static scrollback.
  const sanitized = sanitizeToolOutput(result);
  const normalized = sanitized.trim();
  if (!normalized) return `Tool: ${toolName}\nResult: (empty)`;

  // Existing per-tool preview (file-read tools) — kept because it gives the
  // model a more useful "head" instead of a "tail" for files.
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

  // Hard ceiling for everything else. Drops to a tail-with-temp-file when a
  // tool result blows past the budget, mirroring run_command's behavior.
  const byteSize = Buffer.byteLength(normalized, "utf8");
  const lineCount = normalized.split("\n").length;
  if (byteSize <= TOOL_RESULT_HARD_BYTE_CEILING && lineCount <= TOOL_RESULT_HARD_LINE_CEILING) {
    return `Tool: ${toolName}\nResult:\n${normalized}`;
  }

  let tempPath: string | undefined;
  try {
    tempPath = join(
      tmpdir(),
      `meer-tool-${Date.now()}-${Math.random().toString(36).slice(2)}.log`
    );
    writeFileSync(tempPath, normalized, "utf8");
  } catch {
    // Couldn't write a temp file — keep the tail in-place anyway.
    tempPath = undefined;
  }

  // Take the line tail first, then enforce the byte budget on top.
  // Without the byte sweep, a single 500KB line would survive a line-slice
  // (since one line ≤ 4000 lines) and we'd leak the original blob.
  const lines = normalized.split("\n");
  const lineTail = lines.slice(-TOOL_RESULT_HARD_LINE_CEILING).join("\n");
  let keep = lineTail;
  if (Buffer.byteLength(keep, "utf8") > TOOL_RESULT_HARD_BYTE_CEILING) {
    const buf = Buffer.from(keep, "utf8");
    const start = buf.length - TOOL_RESULT_HARD_BYTE_CEILING;
    // Advance to next character boundary to avoid splitting a multi-byte char.
    let safeStart = start;
    while (safeStart < buf.length && (buf[safeStart] & 0xc0) === 0x80) {
      safeStart++;
    }
    keep = buf.subarray(safeStart).toString("utf8");
  }
  const tailBytes = Buffer.byteLength(keep, "utf8");
  const startLine = lineCount - Math.min(TOOL_RESULT_HARD_LINE_CEILING, lineCount) + 1;
  const tailNote = tempPath
    ? `[Tool output ${byteSize} bytes / ${lineCount} lines exceeded ceiling. Showing tail lines ${startLine}-${lineCount} (${tailBytes} bytes). Full output: ${tempPath}]`
    : `[Tool output ${byteSize} bytes / ${lineCount} lines exceeded ceiling. Showing tail lines ${startLine}-${lineCount} (${tailBytes} bytes).]`;

  return `Tool: ${toolName}\nResult:\n${keep}\n\n${tailNote}`;
}
