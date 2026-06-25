import type { Provider, ChatMessage } from "@meer-ai/ai/base.js";
import { ProviderWrapper } from "@meer-ai/ai/providers/provider-wrapper.js";
import { memory } from "../memory/index.js";
import { MCPManager } from "../mcp/manager.js";
import type { MCPInitProgress } from "../mcp/manager.js";
import type { MCPTool } from "../mcp/types.js";
import { createMeerAgentTools } from "./tools/agent.js";
import type { AgentTool } from "@meer-ai/agent/types.js";
import type { AgentToolCallResult } from "./runtime/types.js";
import { runLoop } from "@meer-ai/agent/loop.js";
import type { AgentEvent } from "@meer-ai/agent/types.js";
import type { AgentMessage as CoreAgentMessage } from "@meer-ai/agent/types.js";
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
import { TrustStore, type TrustMode } from "../trust/store.js";
import { normalizeCommand } from "../trust/match.js";
import { classifyCommand } from "../trust/command-classifier.js";

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
  /** Real token usage reported by the provider for a completed response. */
  onUsage?: (usage: { promptTokens?: number; completionTokens?: number }) => void;
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
  /**
   * Project-trust mode for this session:
   *   - "trusted":    persisted allowlist active; "Always allow" writes to disk
   *   - "session":    in-memory allowlist only; "Always allow" lasts the session
   *   - "restricted": no allowlist; every command is prompted (no "Always allow")
   * Defaults to "trusted" when omitted.
   */
  trustMode?: TrustMode;
  /** Override the trust store location (primarily for testing). */
  trustStore?: TrustStore;
  /**
   * Whether interactive approval prompts are enabled for edits and shell
   * commands. When false, edits auto-apply and trusted/session commands run
   * without prompting (restricted-mode commands still prompt). Defaults to false.
   */
  approvalsEnabled?: boolean;
}

export interface MeerAgentInitOptions {
  contextPrompt?: string;
  priorMessages?: ChatMessage[];
}

/**
 * Session permission mode, cycled from the UI with Shift+Tab.
 *  - "normal":      prompt before edits and non-safe shell commands
 *  - "auto-accept": auto-apply edits; commands still follow approval/trust rules
 *  - "plan":        read-only — edits and mutating commands are blocked
 */
export type PermissionMode = "normal" | "auto-accept" | "plan";

export class MeerAgent {
  private config: MeerAgentConfig;
  private provider: Provider;
  private cwd: string;
  private trustStore: TrustStore;
  /** Commands the user chose to "always allow" for this session only. */
  private sessionAllowedCommands = new Set<string>();
  /** Tool actions the user chose to "always allow" for this session only. */
  private sessionAllowedTools = new Set<string>();
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
   * Session permission mode (Shift+Tab). Defaults so existing launch behavior is
   * preserved: a project launched with approvals on starts in "normal"; without
   * approvals it starts in "auto-accept" (edits auto-apply, commands stay
   * frictionless until the user opts into prompting by cycling to "normal").
   */
  private permissionMode: PermissionMode = "auto-accept";
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
    this.trustStore = config.trustStore ?? new TrustStore();
    this.enableMemory = config.enableMemory ?? true;
    this.providerType = config.providerType ?? "unknown";
    this.model = config.model ?? "unknown";
    this.permissionMode = config.approvalsEnabled ? "normal" : "auto-accept";
  }

  /** Current session permission mode. */
  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  /** Update the session permission mode (driven by Shift+Tab in the UI). */
  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
  }

  /**
   * Per-turn system-prompt suffix announcing the active mode. Only PLAN needs a
   * strong directive (read-only); the other modes don't constrain the model.
   */
  private permissionModeNote(): string {
    if (this.permissionMode === "plan") {
      return (
        "\n\nCURRENT MODE: 📋 PLAN (read-only). Do NOT modify files or run " +
        "mutating commands (no propose_edit, apply_edit, " +
        "run_command for non-read-only commands, delete_file, move_file). Investigate " +
        "and produce a clear, actionable plan instead. Tell the user to press " +
        "Shift+Tab to switch to edit mode when they're ready to apply changes."
      );
    }
    return "";
  }

  /** Current session-level shell cwd. Defaults to the project cwd. */
  getShellCwd(): string {
    return this.shellCwd || this.cwd;
  }

  async initialize(
    options?: string | MeerAgentInitOptions
  ): Promise<void> {
    if (!this.mcpManager.isInitialized()) {
      // Connect MCP servers in the BACKGROUND so the REPL and slash commands
      // (which don't need MCP) are usable immediately at startup. The first
      // model turn awaits readiness in processMessage before building tools.
      void this.mcpManager.initialize().catch(() => {});
    }
    this.mcpTools = this.mcpManager.listAllTools();
    await this.reloadSkills();
  }

  /**
   * Subscribe to MCP connection progress so the UI can surface a live
   * "Starting MCP servers …" indicator at startup. Returns an unsubscribe fn.
   */
  subscribeMcpInitProgress(
    listener: (progress: MCPInitProgress) => void
  ): () => void {
    return this.mcpManager.onInitProgress(listener);
  }

  async processMessage(
    userMessage: string,
    options?: {
      persistUserMessage?: boolean;
      turnId?: string;
      preparedMessages?: CoreAgentMessage[];
      systemPrompt?: string;
      attachments?: import("@meer-ai/agent/types.js").MessageAttachment[];
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

        // MCP servers connect in the background at startup (see initialize()).
        // Make sure that's finished — and pick up any freshly-connected tools —
        // before building the tool list for this turn, so the model can call
        // MCP tools even on the very first message.
        await this.mcpManager.whenReady().catch(() => {});
        this.mcpTools = this.mcpManager.listAllTools();

        const agentTools = this.buildAgentTools();

        const basePrompt =
          options?.systemPrompt ??
          `You are Meer AI, a coding assistant. Use the provided messages and tools to complete the task.`;
        const systemPrompt = basePrompt + this.permissionModeNote();

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

            case "usage":
              this.config.onUsage?.({
                promptTokens: event.promptTokens,
                completionTokens: event.completionTokens,
              });
              break;

            case "reasoning":
              this.config.onCotMessage?.(event.content);
              break;

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
              finalAssistantText = `Paused after ${limit} steps — this is the \`maxIterations\` limit in your meer config, not an error. The task may not be finished: reply to keep going, or raise \`maxIterations\` in ~/.meer/config.yaml to let it run longer.`;
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
    // Plan mode is read-only: edits are blocked outright (defense in depth — the
    // system prompt already instructs the model not to call edit tools here).
    if (this.permissionMode === "plan") {
      throw new Error(
        "Plan mode is read-only — switch to edit mode (Shift+Tab) to apply changes."
      );
    }

    // Auto-accept (or no chooser, e.g. headless) applies edits without prompting.
    // "normal" mode always prompts when a chooser is available, regardless of the
    // launch-time approvals flag.
    if (
      this.permissionMode === "auto-accept" ||
      !this.config.promptChoice
    ) {
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
    const mode: TrustMode = this.config.trustMode ?? "trusted";
    const promptChoice = this.config.promptChoice;
    const risk = classifyCommand(cmd);

    // Catastrophic, system-destroying commands are hard-denied regardless of
    // trust, approvals, or any allowlist.
    if (risk === "catastrophic") {
      return false;
    }

    // Plan mode is read-only: only safe (read-only) commands may run.
    if (this.permissionMode === "plan" && risk !== "safe") {
      return false;
    }

    // Dangerous but recoverable commands ALWAYS prompt before running, even in
    // a trusted project with approvals off. The decision is never remembered
    // (no "Always allow"), defaults to Cancel, and is denied in headless mode.
    if (risk === "dangerous") {
      if (!promptChoice) {
        return false;
      }
      const choice = await promptChoice(
        `**⚠️ Dangerous command — confirm to run:**\n\`\`\`\n${command}\n\`\`\``,
        [
          { label: "Run", value: "run" },
          { label: "Cancel", value: "cancel" },
        ],
        "cancel"
      );
      return choice === "run";
    }

    // Read-only / common dev-workflow commands are auto-approved.
    if (risk === "safe") return true;

    // Allowlist fast-path: commands the user previously chose to "always allow"
    // skip the prompt. Persisted rules apply only in trusted mode; the in-memory
    // session allowlist applies in trusted and session modes.
    const normalized = normalizeCommand(cmd);
    if (mode === "trusted" && this.trustStore.isCommandAllowed(this.cwd, cmd)) {
      return true;
    }
    if (mode !== "restricted" && this.sessionAllowedCommands.has(normalized)) {
      return true;
    }

    // Decide whether to prompt at all. Approval prompts are normally gated by
    // `approvalsEnabled`, but a restricted (untrusted) project forces prompting
    // even when approvals are otherwise off. With no chooser available
    // (headless), fall back to auto-approving non-destructive commands.
    const promptingEnabled =
      Boolean(promptChoice) &&
      (this.permissionMode === "normal" ||
        Boolean(this.config.approvalsEnabled) ||
        mode === "restricted");
    if (!promptChoice || !promptingEnabled) {
      return true;
    }

    // "Always allow" is only meaningful when we can remember the decision;
    // in restricted mode the user declined trust, so we never offer it.
    const choices =
      mode === "restricted"
        ? [
            { label: "Run", value: "run" },
            { label: "Cancel", value: "cancel" },
          ]
        : [
            { label: "Run", value: "run" },
            { label: "Always allow", value: "always" },
            { label: "Cancel", value: "cancel" },
          ];

    const choice = await promptChoice(
      `**Run shell command:**\n\`\`\`\n${command}\n\`\`\``,
      choices,
      "run"
    );

    if (choice === "always") {
      if (mode === "trusted") {
        this.trustStore.allowCommand(this.cwd, cmd);
      } else {
        this.sessionAllowedCommands.add(normalized);
      }
      return true;
    }

    return choice === "run";
  }

  /**
   * Approve a mutating tool action (delete_file, move_file). Mirrors
   * confirmCommand's trust semantics but is keyed by tool name so "Always allow"
   * remembers the whole tool, not a string.
   */
  private async confirmToolAction(toolName: string, action: string): Promise<boolean> {
    const mode: TrustMode = this.config.trustMode ?? "trusted";

    // Plan mode is read-only: mutating tool actions are blocked outright.
    if (this.permissionMode === "plan") {
      return false;
    }

    if (mode === "trusted" && this.trustStore.isToolAllowed(this.cwd, toolName)) {
      return true;
    }
    if (mode !== "restricted" && this.sessionAllowedTools.has(toolName)) {
      return true;
    }

    const promptChoice = this.config.promptChoice;
    const promptingEnabled =
      Boolean(promptChoice) &&
      (Boolean(this.config.approvalsEnabled) || mode === "restricted");
    if (!promptChoice || !promptingEnabled) {
      return true;
    }

    const choices =
      mode === "restricted"
        ? [
            { label: "Yes", value: "yes" },
            { label: "No", value: "no" },
          ]
        : [
            { label: "Yes", value: "yes" },
            { label: `Always allow ${toolName}`, value: "always" },
            { label: "No", value: "no" },
          ];

    const choice = await promptChoice(`**${action}**`, choices, "yes");

    if (choice === "always") {
      if (mode === "trusted") {
        this.trustStore.allowTool(this.cwd, toolName);
      } else {
        this.sessionAllowedTools.add(toolName);
      }
      return true;
    }

    return choice === "yes";
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
        confirmToolAction: (toolName, action) =>
          this.confirmToolAction(toolName, action),
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
  if (["read_file", "list_files", "read_many_files"].includes(toolName)) {
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
