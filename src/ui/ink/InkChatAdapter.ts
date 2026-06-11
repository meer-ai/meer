/**
 * Adapter to integrate Ink-based UI with existing agent system
 * Provides the same interface as OceanChatUI but with beautiful modern TUI
 */

import { render } from "ink";
import React from "react";
import type { Timeline } from "../workflowTimeline.js";
import type { ToolCall } from "./components/tools/index.js";
import type { WorkflowStage } from "./components/workflow/index.js";
import { AppContainer } from "./AppContainer.js";
import {
  resolveUISettings,
  type ScreenReaderMode,
  type UISettings,
} from "../ui-settings.js";
import type { UITimelineEvent } from "./timelineTypes.js";
import type { Plan } from "../../plan/types.js";
import { planStore } from "../../plan/store.js";
import {
  AgentEventBus,
  type AgentLogEvent,
  type AgentTaskEvent,
  type AgentLogLevel,
  type AgentToolEvent,
  type AgentQueueEvent,
} from "../../agent/eventBus.js";
import { debounce } from "./utils/debounce.js";
import { getAllCommands } from "../../slash/registry.js";
import { isSlashCommandInput } from "../../slash/utils.js";
import { recordDiagnostic } from "../../utils/diagnostics.js";
import { clearLiveWorkState } from "./workState.js";
import {
  collapseWhitespace,
  planFinishCommit,
  planStreamCommit,
} from "./streamCommit.js";
import { setToolConsoleQuiet } from "../../tools/index.js";
import type { BackgroundTerminalSession } from "../../runtime/backgroundTerminals.js";

import type { Message } from "./contexts/ChatContext.js";

type CanonicalUIEvent =
  | {
      id: string;
      seq: number;
      type: "message";
      role: Message["role"];
      content: string;
      timestamp: number;
      toolName?: string;
      toolCallId?: string;
      toolArgs?: Record<string, unknown>;
      toolDetails?: Record<string, unknown>;
      isError?: boolean;
      isCot?: boolean;
    }
  | {
      id: string;
      seq: number;
      type: "assistant_delta";
      messageId: string;
      delta: string;
      timestamp: number;
    }
  | {
      id: string;
      seq: number;
      type: "tool";
      toolCallId: string;
      toolName: string;
      status: ToolCall["status"];
      timestamp: number;
      args?: Record<string, unknown>;
      details?: Record<string, unknown>;
      preview?: string;
      error?: string;
    }
  | {
      id: string;
      seq: number;
      type: "status";
      status: string;
      timestamp: number;
    }
  | {
      id: string;
      seq: number;
      type: "turn";
      phase: "begin" | "end";
      timestamp: number;
    };

type CanonicalUIEventInput = CanonicalUIEvent extends infer Event
  ? Event extends CanonicalUIEvent
    ? Omit<Event, "seq" | "timestamp"> & { timestamp?: number }
    : never
  : never;

interface ChoicePromptState {
  message: string;
  options: Array<{ label: string; value: string }>;
  defaultValue: string;
}

interface FormPromptQuestion {
  id: string;
  label: string;
  type: "select" | "multiselect";
  required?: boolean;
  options: Array<{ label: string; value: string; description?: string }>;
}

interface FormPromptState {
  title: string;
  questions: FormPromptQuestion[];
  submitLabel: string;
}

function isActionTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return (
    lower.includes("write") ||
    lower.includes("edit") ||
    lower.includes("move") ||
    lower.includes("rename") ||
    lower.includes("delete") ||
    lower.includes("create_directory")
  );
}

function shouldRenderToolTranscript(toolName: string, _isError?: boolean): boolean {
  const lower = toolName.toLowerCase();

  // Plan tools are fully represented by the PlanPanel — a transcript row
  // would duplicate it.
  if (
    lower.includes("set_plan") ||
    lower.includes("update_plan_task") ||
    lower.includes("show_plan") ||
    lower.includes("clear_plan")
  ) {
    return false;
  }

  // Everything else leaves a durable trail: mutations and failures render
  // full widgets, successful reads/searches/commands render as one-line
  // compact rows (decided in MessageView). This is what lets the user see
  // what the agent actually did after the live work panel clears.
  return true;
}

function buildToolNarration(
  toolName: string,
  content: string,
  args?: Record<string, unknown>,
  isError?: boolean
): string {
  const lower = toolName.toLowerCase();
  const body = content.replace(/^Tool:\s*\S+\s*\n(?:Result[^\n]*:\s*)?\n?/i, "").trim();

  const stringArg = (key: string): string => {
    const value = args?.[key];
    return typeof value === "string" ? value : "";
  };

  const firstLine = body.split("\n").find((line) => line.trim())?.trim() ?? "";

  if (lower.includes("set_plan")) {
    return isError ? body : firstLine || "Plan created.";
  }

  if (lower.includes("update_plan_task")) {
    const taskId = stringArg("taskId");
    const status = stringArg("status");
    if (isError) return body;
    return taskId
      ? `Task ${taskId}${status ? ` → ${status}` : ""}`
      : firstLine || "Plan task updated.";
  }

  if (lower.includes("package_install")) {
    const packages = args?.packages;
    const list = Array.isArray(packages)
      ? packages.join(", ")
      : typeof packages === "string"
        ? packages
        : "";
    if (isError) return body;
    return list ? `Installed ${list}` : firstLine || "Installed dependencies.";
  }

  if (lower.includes("scaffold_project")) {
    const projectType = stringArg("projectType");
    const projectName = stringArg("projectName");
    if (isError) return body;
    return [projectType, projectName].filter(Boolean).join(" ") || firstLine || "Project scaffolded.";
  }

  if (lower.includes("start_background_command")) {
    const command = stringArg("command");
    return command || firstLine || body || "Started background command.";
  }

  if (lower.includes("package_run_script")) {
    const script = stringArg("script");
    return script ? `Ran script ${script}` : firstLine || "Script finished.";
  }

  if (
    lower.includes("write") ||
    lower.includes("edit") ||
    lower.includes("move") ||
    lower.includes("rename") ||
    lower.includes("delete") ||
    lower.includes("create_directory")
  ) {
    return body;
  }

  return body;
}

function isTransientSystemTranscript(content: string): boolean {
  const normalized = content.trim();
  return (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^Resuming session\b/i.test(normalized) ||
    /^Reloading\b/i.test(normalized) ||
    /^Queued\b/i.test(normalized) ||
    /^Delivered\b/i.test(normalized) ||
    /^Ran\s+\//i.test(normalized)
  );
}

export interface InkChatConfig {
  provider: string;
  model: string;
  cwd: string;
  uiSettings?: UISettings;
  eventBus?: AgentEventBus;
}

type Mode = 'edit' | 'plan';

/**
 * Caps for unbounded UI state.
 *
 * Without these, a long-running session (think: an autonomous agent left
 * running overnight) can accumulate enough messages/tools/stages to slow
 * Ink reconciliation noticeably and bloat resident memory. Each cap is
 * generous enough that real interactive use never trims, but bounded
 * enough that runaway accumulation can't degrade the UI.
 *
 * Static's append-only contract IS respected by dropping from the front:
 * items already committed to terminal scrollback aren't re-emitted (verified
 * by reading ink/build/components/Static.js — it tracks an internal index
 * and resets when items.length shrinks).
 */
const MAX_STORED_MESSAGES = 2000;
const MAX_LIVE_TOOLS = 100;
const MAX_WORKFLOW_STAGES = 50;

export class InkChatAdapter {
  private config: InkChatConfig;
  private messages: Message[] = [];
  private droppedMessageCount = 0;
  private uiEvents: CanonicalUIEvent[] = [];
  private readonly maxUiEvents = 500;
  private uiEventSequence = 0;
  private draftAssistant: Message | null = null;
  private promptResolver: ((value: string) => void) | null = null;
  private promptRejecter: ((reason?: unknown) => void) | null = null;
  private promptActive = false;
  private choicePrompt: ChoicePromptState | null = null;
  private choiceResolver: ((value: string) => void) | null = null;
  private choiceRejecter: ((reason?: unknown) => void) | null = null;
  private formPrompt: FormPromptState | null = null;
  private formResolver:
    | ((value: Record<string, string | string[]>) => void)
    | null = null;
  private formRejecter: ((reason?: unknown) => void) | null = null;
  private instance: any = null;
  private turnActive = false;
  private isThinking = false;
  private statusMessage: string | null = null;
  private onSubmitCallback?: (
    text: string,
    attachments?: import("../../agent/core/types.js").MessageAttachment[]
  ) => void;
  private onInterruptCallback?: () => void;
  private mode: Mode = 'edit';
  private onModeChangeCallback?: (mode: Mode) => void;

  // Cache most-recent args per tool name for inline block rendering
  private recentToolArgs = new Map<string, Record<string, unknown>>();
  private collapsedToolCount = 0;

  // Enhanced UI state
  private tools: ToolCall[] = [];
  private workflowStages: WorkflowStage[] = [];
  private currentIteration?: number;
  private maxIterations?: number;
  private tokens = { used: 0, limit: undefined as number | undefined };
  private cost = { current: 0, limit: undefined as number | undefined };
  private messageCount = 0;
  private sessionStartTime = Date.now();
  private uiSettings: UISettings;
  private uiOverrides: Partial<UISettings> = {};
  private timelineEvents: UITimelineEvent[] = [];
  private readonly maxTimelineEvents = 200;
  private timelineSequence = 0;
  private timelineTaskMetadata = new Map<string, { label: string }>();
  private eventBus?: AgentEventBus;
  private busUnsubscribers: Array<() => void> = [];
  private plan: Plan | null = null;
  private pendingUserMessages = new Set<string>();
  private queuedMessages: string[] = [];
  private queueMode: "steer" | "followUp" = "steer";
  private backgroundSessions: BackgroundTerminalSession[] = [];
  private stopBackgroundSessionHandler?: (id: string) => void;

  // Coalesce streaming updates to roughly one terminal frame. This mirrors the
  // Claude/Pi approach: keep token streaming live without rendering per-token.
  private debouncedUpdateUI = debounce(() => this.updateUI(), { delay: 8, maxWait: 32 });
  private pendingAssistantChunk = "";
  private assistantChunkTimer: NodeJS.Timeout | null = null;
  private readonly assistantChunkFlushMs = 24;
  private readonly assistantChunkFrameChars = 96;

  // Progressive-commit streaming state. Completed paragraphs are committed
  // to scrollback as "stream part" messages while the response streams; the
  // live draft only ever holds the in-progress tail (see streamCommit.ts).
  private streamLiveSource = "";
  private streamOpenFence: string | null = null;
  private streamGroupId: string | null = null;
  private streamPartCount = 0;
  private streamCommittedCollapsed = "";

  constructor(config: InkChatConfig) {
    this.config = config;
    this.uiSettings = resolveUISettings(config.uiSettings);
    this.eventBus = config.eventBus;
    // The work log renders tool progress; raw console lines from tool
    // functions would duplicate it through Ink's console patch.
    setToolConsoleQuiet(true);
    this.attachEventBus();
    this.renderUI();
  }

  private getSlashSuggestions() {
    return getAllCommands(this.config.cwd);
  }

  private recordUIEvent(event: CanonicalUIEventInput): void {
    this.uiEvents.push({
      ...event,
      seq: ++this.uiEventSequence,
      timestamp: event.timestamp ?? Date.now(),
    } as CanonicalUIEvent);
    if (this.uiEvents.length > this.maxUiEvents) {
      this.uiEvents = this.uiEvents.slice(-this.maxUiEvents);
    }
  }

  getUIEvents(limit?: number): CanonicalUIEvent[] {
    return typeof limit === "number" && limit > 0
      ? this.uiEvents.slice(-limit)
      : [...this.uiEvents];
  }

  setInterruptHandler(handler: () => void): void {
    this.onInterruptCallback = handler;
    this.updateUI();
  }

  setModeChangeHandler(handler: (mode: Mode) => void): void {
    this.onModeChangeCallback = handler;
    this.updateUI();
  }

  getMode(): Mode {
    return this.mode;
  }

  setMode(mode: Mode): void {
    if (this.mode !== mode) {
      this.mode = mode;
      const modeLabel = mode === 'plan' ? '📋 PLAN' : '✏️ EDIT';
      this.appendSystemMessage(`Switched to ${modeLabel} mode`);
      this.updateUI();
    }
  }

  setPlan(plan: Plan | null): void {
    const previous = this.plan;
    const noChange =
      (!previous && !plan) ||
      (previous &&
        plan &&
        previous.updatedAt === plan.updatedAt &&
        previous.tasks.length === plan.tasks.length);
    if (noChange) {
      return;
    }
    this.plan = plan ? this.clonePlan(plan) : null;
    this.updateUI();
  }

  private renderUI() {
    const handleMessage = (
      message: string,
      attachments?: import("../../agent/core/types.js").MessageAttachment[]
    ) => {
      if (this.promptResolver) {
        this.promptResolver(message);
        this.promptResolver = null;
        this.promptRejecter = null;
        this.promptActive = false;
      } else if (this.onSubmitCallback) {
        const trimmed = message.trim();
        if ((trimmed && !isSlashCommandInput(trimmed)) || attachments?.length) {
          this.appendUserMessage(trimmed, {
            optimistic: true,
            attachmentCount: attachments?.length,
          });
        }
        this.onSubmitCallback(message, attachments);
      }
    };

    const handleInterrupt = () => {
      if (this.onInterruptCallback) {
        this.onInterruptCallback();
      }
    };

    const handleModeChange = (mode: Mode) => {
      this.setMode(mode);
      if (this.onModeChangeCallback) {
        this.onModeChangeCallback(mode);
      }
    };

    const handleChoiceSelect = (value: string) => {
      if (!this.choiceResolver) {
        return;
      }
      const resolve = this.choiceResolver;
      this.choicePrompt = null;
      this.choiceResolver = null;
      this.choiceRejecter = null;
      resolve(value);
      this.updateUI();
    };

    const handleFormSubmit = (value: Record<string, string | string[]>) => {
      if (!this.formResolver) {
        return;
      }
      const resolve = this.formResolver;
      this.formPrompt = null;
      this.formResolver = null;
      this.formRejecter = null;
      resolve(value);
      this.updateUI();
    };

    const sessionUptime = (Date.now() - this.sessionStartTime) / 1000;

    const activeSettings = this.getActiveUiSettings();

    this.instance = render(
      React.createElement(AppContainer, {
        messages: this.messages,
        draftAssistant: this.draftAssistant ?? undefined,
        isThinking: this.isThinking,
        status: this.statusMessage || undefined,
        provider: this.config.provider,
        model: this.config.model,
        cwd: this.config.cwd,
        onMessage: handleMessage,
        onExit: () => this.destroy(),
        onInterrupt: handleInterrupt,
        onExpandLastTool: () => {
          void this.openLastToolOutputInPager();
        },
        mode: this.mode,
        onModeChange: handleModeChange,
        tools: this.tools.length > 0 ? this.tools : undefined,
        workflowStages: this.workflowStages.length > 0 ? this.workflowStages : undefined,
        currentIteration: this.currentIteration,
        maxIterations: this.maxIterations,
        tokens: this.tokens.used > 0 ? this.tokens : undefined,
        cost: this.cost.current > 0 ? this.cost : undefined,
        messageCount: this.messageCount,
        droppedMessageCount: this.droppedMessageCount,
        sessionUptime,
        timelineEvents: this.timelineEvents,
        plan: this.plan ?? undefined,
        queuedMessages: this.queuedMessages,
        queueMode: this.queueMode,
        backgroundSessions: this.backgroundSessions,
        onStopBackgroundSession: (id: string) =>
          this.stopBackgroundSessionHandler?.(id),
        onQueueModeChange: (mode: "steer" | "followUp") => {
          this.queueMode = mode;
          this.updateUI();
        },
        uiSettings: activeSettings,
        slashSuggestions: this.getSlashSuggestions(),
        choicePrompt: this.choicePrompt ?? undefined,
        onChoiceSelect: handleChoiceSelect,
        formPrompt: this.formPrompt ?? undefined,
        onFormSubmit: handleFormSubmit,
      }),
    );
  }

  private updateUI() {
    if (!this.instance) return;

    const handleMessage = (
      message: string,
      attachments?: import("../../agent/core/types.js").MessageAttachment[]
    ) => {
      if (this.promptResolver) {
        this.promptResolver(message);
        this.promptResolver = null;
        this.promptRejecter = null;
        this.promptActive = false;
      } else if (this.onSubmitCallback) {
        const trimmed = message.trim();
        if ((trimmed && !isSlashCommandInput(trimmed)) || attachments?.length) {
          this.appendUserMessage(trimmed, {
            optimistic: true,
            attachmentCount: attachments?.length,
          });
        }
        this.onSubmitCallback(message, attachments);
      }
    };

    const handleInterrupt = () => {
      if (this.onInterruptCallback) {
        this.onInterruptCallback();
      }
    };

    const handleModeChange = (mode: Mode) => {
      this.setMode(mode);
      if (this.onModeChangeCallback) {
        this.onModeChangeCallback(mode);
      }
    };

    const handleChoiceSelect = (value: string) => {
      if (!this.choiceResolver) {
        return;
      }
      const resolve = this.choiceResolver;
      this.choicePrompt = null;
      this.choiceResolver = null;
      this.choiceRejecter = null;
      resolve(value);
      this.updateUI();
    };

    const handleFormSubmit = (value: Record<string, string | string[]>) => {
      if (!this.formResolver) {
        return;
      }
      const resolve = this.formResolver;
      this.formPrompt = null;
      this.formResolver = null;
      this.formRejecter = null;
      resolve(value);
      this.updateUI();
    };

    const sessionUptime = (Date.now() - this.sessionStartTime) / 1000;

    // Force re-render by unmounting and remounting
    const activeSettings = this.getActiveUiSettings();

    this.instance.rerender(
      React.createElement(AppContainer, {
        messages: this.messages,
        draftAssistant: this.draftAssistant ?? undefined,
        isThinking: this.isThinking,
        status: this.statusMessage || undefined,
        provider: this.config.provider,
        model: this.config.model,
        cwd: this.config.cwd,
        onMessage: handleMessage,
        onExit: () => this.destroy(),
        onInterrupt: handleInterrupt,
        onExpandLastTool: () => {
          void this.openLastToolOutputInPager();
        },
        mode: this.mode,
        onModeChange: handleModeChange,
        tools: this.tools.length > 0 ? this.tools : undefined,
        workflowStages: this.workflowStages.length > 0 ? this.workflowStages : undefined,
        currentIteration: this.currentIteration,
        maxIterations: this.maxIterations,
        tokens: this.tokens.used > 0 ? this.tokens : undefined,
        cost: this.cost.current > 0 ? this.cost : undefined,
        messageCount: this.messageCount,
        droppedMessageCount: this.droppedMessageCount,
        sessionUptime,
        plan: this.plan ?? undefined,
        timelineEvents: this.timelineEvents,
        queuedMessages: this.queuedMessages,
        queueMode: this.queueMode,
        backgroundSessions: this.backgroundSessions,
        onStopBackgroundSession: (id: string) =>
          this.stopBackgroundSessionHandler?.(id),
        onQueueModeChange: (mode: "steer" | "followUp") => {
          this.queueMode = mode;
          this.updateUI();
        },
        uiSettings: activeSettings,
        slashSuggestions: this.getSlashSuggestions(),
        choicePrompt: this.choicePrompt ?? undefined,
        onChoiceSelect: handleChoiceSelect,
        formPrompt: this.formPrompt ?? undefined,
        onFormSubmit: handleFormSubmit,
      }),
    );
  }

  private getActiveUiSettings(): UISettings {
    const active: UISettings = { ...this.uiSettings };
    if (this.uiOverrides.useAlternateBuffer !== undefined) {
      active.useAlternateBuffer = this.uiOverrides.useAlternateBuffer;
    }
    if (this.uiOverrides.screenReaderMode) {
      active.screenReaderMode = this.uiOverrides.screenReaderMode;
    }
    if (this.uiOverrides.virtualizedHistory) {
      active.virtualizedHistory = this.uiOverrides.virtualizedHistory;
    }
    return active;
  }

  setScreenReaderMode(mode: ScreenReaderMode): void {
    if (mode === "auto") {
      delete this.uiOverrides.screenReaderMode;
    } else {
      this.uiOverrides.screenReaderMode = mode;
    }
    this.updateUI();
  }

  setAlternateBufferMode(mode: "on" | "off" | "auto"): void {
    if (mode === "auto") {
      delete this.uiOverrides.useAlternateBuffer;
    } else {
      this.uiOverrides.useAlternateBuffer = mode === "on";
    }
    this.updateUI();
  }

  // Compatibility methods for existing agent system

  appendUserMessage(
    content: string,
    options?: {
      optimistic?: boolean;
      consumeOptimistic?: boolean;
      /** When non-zero, render an "📎 N image(s)" hint next to the text. */
      attachmentCount?: number;
    }
  ): void {
    const normalized = content.trim();
    const attachmentCount = options?.attachmentCount ?? 0;
    if (!normalized && attachmentCount === 0) return;

    if (options?.consumeOptimistic && this.pendingUserMessages.delete(normalized)) {
      return;
    }

    const lastMessage = this.messages[this.messages.length - 1];
    if (
      lastMessage?.role === "user" &&
      lastMessage.content.trim() === normalized &&
      Date.now() - (lastMessage.timestamp ?? 0) < 2500
    ) {
      return;
    }

    this.clearFinishedPlan();

    const displayed =
      attachmentCount > 0
        ? `${normalized}${normalized ? "\n\n" : ""}📎 ${attachmentCount} image${attachmentCount === 1 ? "" : "s"} attached`
        : normalized;

    this.messages.push({
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      role: "user",
      content: displayed,
      timestamp: Date.now(),
    });
    this.trimMessages();
    const message = this.messages[this.messages.length - 1];
    this.recordUIEvent({
      id: message.id,
      type: "message",
      role: "user",
      content: normalized,
      timestamp: message.timestamp,
    });
    if (options?.optimistic) {
      this.pendingUserMessages.add(normalized);
    }
    this.messageCount++;
    this.updateUI();
  }

  replayTranscript(
    entries: Array<{
      role: 'user' | 'assistant' | 'system' | 'tool';
      content: string;
      timestamp?: number;
      metadata?: {
        toolName?: string;
      };
    }>
  ): void {
    const restored = entries
      .filter(
        (entry) =>
          entry.content.trim().length > 0 &&
          !(entry.role === "system" && isTransientSystemTranscript(entry.content))
      )
      .map((entry) => ({
        id: `msg-${entry.timestamp ?? Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        role: entry.role,
        content: entry.content,
        toolName: entry.metadata?.toolName,
        timestamp: entry.timestamp ?? Date.now(),
      }));

    if (restored.length === 0) {
      return;
    }

    this.messages.push(...restored);
    this.trimMessages();
    this.messageCount += restored.length;
    this.updateUI();
  }

  beginTurn(): void {
    this.flushAssistantChunks();
    this.debouncedUpdateUI.cancel();
    this.recordUIEvent({ id: `turn-${Date.now()}`, type: "turn", phase: "begin" });
    this.turnActive = true;
    this.draftAssistant = null;
    this.resetStreamGroup();
    this.isThinking = true;
    this.statusMessage = null;
    this.tools = [];
    this.workflowStages = [];
    this.currentIteration = undefined;
    this.maxIterations = undefined;
    this.timelineEvents = [];
    this.timelineTaskMetadata.clear();
    this.collapsedToolCount = 0;
    this.updateUI();
  }

  endTurn(): void {
    this.recordUIEvent({ id: `turn-${Date.now()}`, type: "turn", phase: "end" });
    this.turnActive = false;
    this.resetLiveWorkState({ keepDraft: false, skipRender: true });
    this.updateUI();
  }

  /**
   * Force-clear every transient work-log indicator (running tools, workflow
   * stages, status text, streaming buffers, iteration counters). Safe to
   * call multiple times; safe to call mid-turn (it leaves `turnActive`
   * alone). The cli.ts error/abort handlers call this defensively so a
   * thrown event-sink listener can't strand "Running…" on the screen.
   */
  forceResetWorkState(): void {
    this.resetLiveWorkState({ keepDraft: false, skipRender: false });
  }

  private resetLiveWorkState(options?: {
    keepDraft?: boolean;
    skipRender?: boolean;
  }): void {
    // Streaming buffers/timers — silence in-flight chunk drains so a
    // settled message can't be overwritten by a late frame.
    try {
      this.flushAssistantChunks();
    } catch (err) {
      recordDiagnostic("ui.resetLiveWorkState.flush", err);
    }
    try {
      this.debouncedUpdateUI.cancel();
    } catch (err) {
      recordDiagnostic("ui.resetLiveWorkState.debounce", err);
    }

    // Pure helper does the field zeroing — same fn is exercised in tests.
    clearLiveWorkState(this as unknown as Parameters<typeof clearLiveWorkState>[0], {
      keepDraft: options?.keepDraft,
    });
    // Close any open stream group. Already-committed pieces stay in
    // scrollback (matching what the user saw stream), but state resets so
    // the next response starts a fresh block.
    if (!options?.keepDraft) {
      this.resetStreamGroup();
    }
    this.timelineTaskMetadata.clear();

    if (!options?.skipRender) {
      this.updateUI();
    }
  }

  startAssistantMessage(): void {
    this.isThinking = true;
    // When a stream group is already open (parts committed to scrollback but
    // not yet settled — e.g. text resuming after a tool batch), the new draft
    // is a continuation of the same response block: no fresh header.
    const continuing =
      this.streamGroupId !== null || this.streamLiveSource.trim().length > 0;
    if (!continuing) {
      this.resetStreamGroup();
    } else if (this.streamLiveSource.trim()) {
      // A held fragment from before the tool batch. Join with a single
      // newline (not a paragraph break) so the paragraph committer keeps the
      // fragment glued to the text that follows — a blank line here would
      // immediately strand it as its own piece in scrollback.
      this.streamLiveSource = `${this.streamLiveSource.replace(/\s+$/, "")}\n`;
    }
    this.draftAssistant = {
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      role: 'assistant',
      content: this.streamLiveDisplay(),
      timestamp: Date.now(),
      isContinuation: (continuing && this.streamGroupId !== null) || undefined,
    };
    this.recordUIEvent({
      id: this.draftAssistant.id,
      type: "message",
      role: "assistant",
      content: "",
      timestamp: this.draftAssistant.timestamp,
    });
    this.updateUI();
  }

  private resetStreamGroup(): void {
    this.streamLiveSource = "";
    this.streamOpenFence = null;
    this.streamGroupId = null;
    this.streamPartCount = 0;
    this.streamCommittedCollapsed = "";
  }

  /** Display form of the live tail (re-opens a fence split by a commit). */
  private streamLiveDisplay(): string {
    return this.streamOpenFence
      ? `${this.streamOpenFence}\n${this.streamLiveSource}`
      : this.streamLiveSource;
  }

  /** Push one committed piece of the streaming response into scrollback. */
  private pushStreamPart(displayText: string): void {
    const trimmed = displayText.replace(/\s+$/, "");
    if (!trimmed.trim()) {
      return;
    }
    const isFirst = this.streamGroupId === null;
    if (isFirst) {
      this.streamGroupId =
        this.draftAssistant?.id ??
        `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    this.messages.push({
      id: `${this.streamGroupId}-part-${++this.streamPartCount}`,
      role: "assistant",
      content: trimmed,
      timestamp:
        isFirst && this.draftAssistant
          ? this.draftAssistant.timestamp
          : Date.now(),
      streamGroupId: this.streamGroupId ?? undefined,
      isContinuation: !isFirst || undefined,
    });
    this.trimMessages();
    if (this.draftAssistant) {
      this.draftAssistant.isContinuation = true;
    }
  }

  /** Commit completed paragraphs out of the live tail into scrollback. */
  private maybeCommitStreamParts(): void {
    const plan = planStreamCommit(this.streamLiveSource, this.streamOpenFence);
    if (plan.consumed === 0) {
      return;
    }
    const consumedRaw = this.streamLiveSource.slice(0, plan.consumed);
    this.pushStreamPart(plan.commitText);
    this.streamCommittedCollapsed = `${this.streamCommittedCollapsed} ${collapseWhitespace(consumedRaw)}`.trim();
    this.streamLiveSource = this.streamLiveSource.slice(plan.consumed);
    this.streamOpenFence = plan.openFenceAfter;
  }

  /**
   * Commit whatever is left in the live tail. Called when streaming stops
   * (tool batch starting, or response complete) so the text lands in
   * scrollback BEFORE tool widgets print — keeping reading order correct.
   */
  private commitStreamRemainder(): void {
    if (!this.streamLiveSource.trim()) {
      this.streamLiveSource = "";
      return;
    }
    const display = this.streamLiveDisplay();
    this.streamCommittedCollapsed = `${this.streamCommittedCollapsed} ${collapseWhitespace(this.streamLiveSource)}`.trim();
    this.pushStreamPart(display);
    this.streamLiveSource = "";
    this.streamOpenFence = null;
  }

  appendAssistantChunk(chunk: string): void {
    if (!this.draftAssistant) {
      this.startAssistantMessage();
    }

    if (this.draftAssistant) {
      this.pendingAssistantChunk += chunk;
      if (!this.assistantChunkTimer) {
        this.assistantChunkTimer = setInterval(() => {
          this.drainAssistantChunkFrame();
        }, this.assistantChunkFlushMs);
      }
    }
  }

  private drainAssistantChunkFrame(): void {
    if (!this.pendingAssistantChunk || !this.draftAssistant) {
      if (this.assistantChunkTimer) {
        clearInterval(this.assistantChunkTimer);
        this.assistantChunkTimer = null;
      }
      this.pendingAssistantChunk = "";
      return;
    }

    const frame = this.pendingAssistantChunk.slice(0, this.assistantChunkFrameChars);
    this.pendingAssistantChunk = this.pendingAssistantChunk.slice(frame.length);
    this.appendAssistantFrame(frame);

    if (!this.pendingAssistantChunk && this.assistantChunkTimer) {
      clearInterval(this.assistantChunkTimer);
      this.assistantChunkTimer = null;
    }
  }

  private appendAssistantFrame(chunk: string): void {
    if (!chunk || !this.draftAssistant) {
      return;
    }
    this.streamLiveSource += chunk;
    this.maybeCommitStreamParts();
    this.draftAssistant.content = this.streamLiveDisplay();
    this.recordUIEvent({
      id: `delta-${this.draftAssistant.id}-${this.uiEventSequence + 1}`,
      type: "assistant_delta",
      messageId: this.draftAssistant.id,
      delta: chunk,
    });
    this.updateUI();
  }

  private flushAssistantChunks(): void {
    if (this.assistantChunkTimer) {
      clearInterval(this.assistantChunkTimer);
      this.assistantChunkTimer = null;
    }

    if (!this.pendingAssistantChunk || !this.draftAssistant) {
      this.pendingAssistantChunk = "";
      return;
    }

    const chunk = this.pendingAssistantChunk;
    this.pendingAssistantChunk = "";
    this.appendAssistantFrame(chunk);
  }

  finishAssistantMessage(): void {
    this.flushAssistantChunks();
    // Streaming stopped (tool batch starting or response complete). Flush
    // completed text to scrollback now so any tool widgets that follow print
    // AFTER the text that preceded them. Dangling fragments the model emits
    // right before a tool call ("#", "Now I'll") stay in the live draft —
    // committing them would strand a half-line in scrollback.
    if (this.streamLiveSource.trim() || this.streamGroupId !== null) {
      const plan = planFinishCommit(this.streamLiveSource, this.streamOpenFence);
      if (plan.consumed > 0) {
        const consumedRaw = this.streamLiveSource.slice(0, plan.consumed);
        this.pushStreamPart(plan.commitText);
        this.streamCommittedCollapsed =
          `${this.streamCommittedCollapsed} ${collapseWhitespace(consumedRaw)}`.trim();
        this.streamLiveSource = this.streamLiveSource.slice(plan.consumed);
        this.streamOpenFence = plan.openFenceAfter;
      }
      if (!this.streamLiveSource.trim()) {
        this.streamLiveSource = "";
        this.streamOpenFence = null;
        this.draftAssistant = null;
      } else if (this.draftAssistant) {
        // Held fragment stays visible in the live region.
        this.draftAssistant.content = this.streamLiveDisplay();
      }
    }
    this.isThinking = this.turnActive;
    // Cancel any pending debounced updates and render final state immediately
    this.debouncedUpdateUI.cancel();
    this.updateUI();
  }

  settleAssistantMessage(content: string): void {
    this.flushAssistantChunks();

    const groupActive =
      this.streamGroupId !== null || this.streamLiveSource.trim().length > 0;

    if (groupActive) {
      this.settleStreamGroup(content);
      return;
    }

    const normalized = content.trim() || this.draftAssistant?.content.trim() || "";
    if (!normalized) {
      return;
    }

    const lastMessage = this.messages[this.messages.length - 1];
    if (
      lastMessage?.role === "assistant" &&
      !lastMessage.isCot &&
      lastMessage.content.trim() === normalized
    ) {
      this.draftAssistant = null;
      this.isThinking = this.turnActive;
      this.updateUI();
      return;
    }

    const draft = this.draftAssistant;
    this.messages.push({
      id: draft?.id ?? `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      role: "assistant",
      content: normalized,
      timestamp: draft?.timestamp ?? Date.now(),
    });
    this.trimMessages();
    const message = this.messages[this.messages.length - 1];
    this.recordUIEvent({
      id: message.id,
      type: "message",
      role: "assistant",
      content: normalized,
      timestamp: message.timestamp,
    });
    this.draftAssistant = null;
    this.isThinking = this.turnActive;
    this.updateUI();
  }

  /**
   * Close an open stream group: commit the live tail, verify the settled
   * content was covered by what streamed, and stamp the final piece with the
   * full reconciled text (for /copy and history readers).
   */
  private settleStreamGroup(content: string): void {
    this.commitStreamRemainder();

    const normalized = content.trim();
    const want = collapseWhitespace(normalized);
    const covered = this.streamCommittedCollapsed;

    // The settled content normally equals (or is contained in) what streamed
    // — possibly with extra whitespace from preamble merging. If the settle
    // carries text that never streamed (rare), push it so nothing is lost.
    if (want && !covered.includes(want) && !want.includes(covered)) {
      this.pushStreamPart(normalized);
      recordDiagnostic(
        "ui.settleStreamGroup.mismatch",
        new Error("settled content not covered by streamed parts"),
        { wantChars: want.length, coveredChars: covered.length }
      );
    }

    // Stamp the last piece with the full response text.
    if (this.streamGroupId !== null) {
      for (let i = this.messages.length - 1; i >= 0; i--) {
        const msg = this.messages[i];
        if (msg.streamGroupId === this.streamGroupId) {
          msg.streamGroupFull = normalized || undefined;
          this.recordUIEvent({
            id: msg.id,
            type: "message",
            role: "assistant",
            content: normalized || msg.content,
            timestamp: msg.timestamp,
          });
          break;
        }
      }
    }

    this.resetStreamGroup();
    this.draftAssistant = null;
    this.isThinking = this.turnActive;
    this.updateUI();
  }

  discardAssistantMessage(): void {
    // Drops the in-flight draft AND every transient work indicator. cli.ts
    // calls this on the error/abort path; before this consolidation, the
    // tools list and workflowStages could survive a thrown turn and the
    // user would see "Running …" stranded on screen after the agent died.
    this.resetLiveWorkState({ keepDraft: false });
  }

  appendSystemMessage(content: string): void {
    const normalized = content.trim();
    if (!normalized) {
      return;
    }

    if (isSlashCommandInput(normalized)) {
      this.setStatus(`Ran ${normalized}`);
      return;
    }

    const message = { id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, role: 'system' as const, content, timestamp: Date.now() };
    this.messages.push(message);
    this.trimMessages();
    this.recordUIEvent({
      id: message.id,
      type: "message",
      role: "system",
      content: normalized,
      timestamp: message.timestamp,
    });
    this.updateUI();
  }

  addCotMessage(content: string): void {
    const normalized = content.trim();
    if (!normalized) return;
    this.statusMessage = sanitizeStatusText(normalized) || normalized;
    this.recordUIEvent({
      id: `status-${Date.now()}`,
      type: "status",
      status: this.statusMessage,
    });
    this.updateUI();
  }

  appendToolMessage(
    toolName: string,
    content: string,
    isError?: boolean,
    metadata?: { toolCallId?: string; details?: Record<string, unknown> }
  ): void {
    const toolArgs = this.recentToolArgs.get(toolName);
    const tool =
      [...this.tools]
        .reverse()
        .find((entry) =>
          metadata?.toolCallId
            ? entry.id === metadata.toolCallId
            : entry.name === toolName
        ) ?? null;

    if (tool) {
      tool.result = content;
      tool.details = metadata?.details ?? tool.details;
      if (isError) {
        tool.error = content;
      }
    }

    const shouldRenderTranscript = shouldRenderToolTranscript(toolName, isError);

    if (!shouldRenderTranscript) {
      this.collapsedToolCount += 1;
      this.updateUI();
      return;
    }

    const renderedContent = buildToolNarration(toolName, content, toolArgs, isError);
    const id = metadata?.toolCallId
      ? `tool-message-${metadata.toolCallId}`
      : `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const existingIndex = this.messages.findIndex((message) => message.id === id);
    const message: Message = {
      id,
      role: 'tool',
      content: renderedContent,
      toolName,
      toolCallId: metadata?.toolCallId,
      toolArgs,
      toolDetails: metadata?.details,
      isError,
      timestamp: Date.now(),
    };

    if (existingIndex >= 0) {
      this.messages[existingIndex] = {
        ...this.messages[existingIndex],
        ...message,
        timestamp: this.messages[existingIndex].timestamp,
      };
    } else {
      this.messages.push(message);
      this.trimMessages();
    }
    this.recordUIEvent({
      id,
      type: "message",
      role: "tool",
      content: renderedContent,
      toolName,
      toolCallId: metadata?.toolCallId,
      toolArgs,
      toolDetails: metadata?.details,
      isError,
      timestamp: message.timestamp,
    });
    this.updateUI();
  }

  /**
   * Drop the oldest messages once the buffer exceeds MAX_STORED_MESSAGES.
   * Called after every push site that adds to `this.messages`. Static's
   * internal index handles the front-drop cleanly.
   */
  private trimMessages(): void {
    const overflow = this.messages.length - MAX_STORED_MESSAGES;
    if (overflow <= 0) return;
    this.messages.splice(0, overflow);
    this.droppedMessageCount += overflow;
  }

  private trimTools(): void {
    const overflow = this.tools.length - MAX_LIVE_TOOLS;
    if (overflow > 0) {
      this.tools.splice(0, overflow);
    }
  }

  private trimWorkflowStages(): void {
    const overflow = this.workflowStages.length - MAX_WORKFLOW_STAGES;
    if (overflow > 0) {
      this.workflowStages.splice(0, overflow);
    }
  }

  /** Exposed for the chat surface so it can show "+N earlier dropped" hints. */
  getDroppedMessageCount(): number {
    return this.droppedMessageCount;
  }

  /**
   * Return the most recent settled assistant message (excludes the live
   * streaming draft, since draft content can be incomplete). Used by /copy
   * to put the latest model output on the clipboard.
   */
  getLastAssistantContent(): string | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role !== "assistant" || msg.isCot || !msg.content.trim()) {
        continue;
      }
      // Progressively committed responses are split into pieces; the settle
      // stamp on the final piece holds the full reconciled text.
      if (msg.streamGroupFull?.trim()) {
        return msg.streamGroupFull;
      }
      if (msg.streamGroupId) {
        const parts = this.messages
          .filter((m) => m.streamGroupId === msg.streamGroupId)
          .map((m) => m.content.trim())
          .filter(Boolean);
        if (parts.length > 0) {
          return parts.join("\n\n");
        }
      }
      return msg.content;
    }
    return null;
  }

  /**
   * Locate the most recent tool result and return the best-available
   * full content for it. We check two sources:
   *
   *  - `this.tools` — the live widget list. Includes run_command,
   *    read_file, grep, etc., even when they're filtered out of the
   *    chat transcript by `shouldRenderToolTranscript`.
   *  - `this.messages` — committed tool transcript blocks (mutations,
   *    errors, anything that survived the filter).
   *
   * Whichever has a more recent `endTime` (or, for messages, timestamp)
   * wins. If the tool wrote a temp file (run_command + the universal
   * tool-output ceiling), we prefer that path so the pager mmaps the
   * full file instead of getting the truncated tail.
   */
  getLastToolOutput(): {
    toolName: string;
    filePath?: string;
    content: string;
  } | null {
    let bestToolTime = -1;
    let bestTool: { toolName: string; filePath?: string; content: string } | null = null;

    for (let i = this.tools.length - 1; i >= 0; i--) {
      const tool = this.tools[i];
      if (tool.status !== "success" && tool.status !== "error") continue;
      const when = tool.endTime ?? tool.startTime ?? 0;
      if (when <= bestToolTime) continue;
      const details = tool.details as Record<string, unknown> | undefined;
      const filePath =
        details && typeof details.fullOutputPath === "string"
          ? details.fullOutputPath
          : undefined;
      bestToolTime = when;
      bestTool = {
        toolName: tool.name,
        filePath,
        content: tool.result ?? tool.error ?? "",
      };
      break;
    }

    let bestMessageTime = -1;
    let bestMessage: { toolName: string; filePath?: string; content: string } | null = null;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role !== "tool") continue;
      const when = msg.timestamp ?? 0;
      if (when <= bestMessageTime) continue;
      const details = (msg as { toolDetails?: Record<string, unknown> }).toolDetails;
      const filePath =
        details && typeof details.fullOutputPath === "string"
          ? details.fullOutputPath
          : undefined;
      bestMessageTime = when;
      bestMessage = {
        toolName: (msg as { toolName?: string }).toolName ?? "tool",
        filePath,
        content: msg.content ?? "",
      };
      break;
    }

    if (!bestTool && !bestMessage) return null;
    if (!bestTool) return bestMessage;
    if (!bestMessage) return bestTool;
    return bestToolTime >= bestMessageTime ? bestTool : bestMessage;
  }

  /**
   * Suspend Ink, open the most recent tool's full output in the user's
   * $PAGER (falling back to `less -R`), then resume the UI. Called from
   * MeerChat's ^E keybind. Quietly appends a system message if there's
   * nothing to view yet.
   */
  async openLastToolOutputInPager(): Promise<void> {
    const target = this.getLastToolOutput();
    if (!target) {
      this.appendSystemMessage("No tool output to view yet.");
      return;
    }
    const { openInPager } = await import("../../utils/pager.js");
    await this.runWithTerminal(async () => {
      await openInPager({
        filePath: target.filePath,
        content: target.filePath ? undefined : target.content,
        header: `# ${target.toolName} — full output`,
      });
    });
  }

  clearMessages(): void {
    this.messages = [];
    this.draftAssistant = null;
    this.messageCount = 0;
    this.droppedMessageCount = 0;
    this.updateUI();
  }

  setStatus(text: string): void {
    this.statusMessage = sanitizeStatusText(text ?? "") || null;
    this.recordUIEvent({
      id: `status-${Date.now()}`,
      type: "status",
      status: this.statusMessage ?? "",
    });
    this.updateUI();
  }

  setQueueState(queue: { steering: string[]; followUp: string[] }): void {
    this.queuedMessages = [
      ...queue.steering.map((message) => `[steer] ${message}`),
      ...queue.followUp.map((message) => `[follow-up] ${message}`),
    ];
    this.updateUI();
  }

  setQueueMode(mode: "steer" | "followUp"): void {
    this.queueMode = mode;
    this.updateUI();
  }

  setBackgroundSessions(sessions: BackgroundTerminalSession[]): void {
    this.backgroundSessions = sessions;
    this.updateUI();
  }

  setBackgroundSessionStopHandler(handler: (id: string) => void): void {
    this.stopBackgroundSessionHandler = handler;
    this.updateUI();
  }

  getQueueMode(): "steer" | "followUp" {
    return this.queueMode;
  }

  enableContinuousChat(
    onSubmit: (
      text: string,
      attachments?: import("../../agent/core/types.js").MessageAttachment[]
    ) => void
  ): void {
    this.onSubmitCallback = onSubmit;
    this.updateUI();
  }

  async prompt(): Promise<string> {
    if (this.promptResolver) {
      throw new Error('Prompt already active');
    }

    this.promptActive = true;
    this.updateUI();

    return new Promise((resolve, reject) => {
      this.promptResolver = resolve;
      this.promptRejecter = reject;
    });
  }

  async promptChoice<T extends string>(
    message: string,
    options: Array<{ label: string; value: T }>,
    defaultValue: T
  ): Promise<T> {
    if (this.choiceResolver || this.promptResolver) {
      throw new Error("Prompt already active");
    }

    this.choicePrompt = {
      message,
      options: options.map((option) => ({
        label: option.label,
        value: option.value,
      })),
      defaultValue,
    };
    this.updateUI();

    return new Promise<T>((resolve, reject) => {
      this.choiceResolver = (value) => resolve(value as T);
      this.choiceRejecter = reject;
    });
  }

  async promptForm(
    title: string,
    questions: Array<{
      id: string;
      label: string;
      type: "select" | "multiselect";
      required?: boolean;
      options: Array<{ label: string; value: string; description?: string }>;
    }>,
    submitLabel = "Submit answers"
  ): Promise<Record<string, string | string[]>> {
    if (this.choiceResolver || this.promptResolver || this.formResolver) {
      throw new Error("Prompt already active");
    }

    this.formPrompt = {
      title,
      questions,
      submitLabel,
    };
    this.updateUI();

    return new Promise<Record<string, string | string[]>>((resolve, reject) => {
      this.formResolver = resolve;
      this.formRejecter = reject;
    });
  }

  captureConsole(): void {
    // Ink handles console output automatically
  }

  restoreConsole(): void {
    // Ink handles console output automatically
  }

  private async executeWithTerminal<T>(
    task: () => Promise<T>,
    options: { capture?: boolean } = {}
  ): Promise<{ result: T; stdout: string; stderr: string }> {
    const capture = Boolean(options.capture);
    let stdoutBuffer = '';
    let stderrBuffer = '';

    // Temporarily unmount UI for terminal access
    if (this.instance) {
      this.instance.unmount();
    }

    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);

    const wrapWriter =
      <TWriter extends typeof process.stdout.write>(
        writer: TWriter,
        collector: (chunk: string) => void
      ): TWriter =>
        ((chunk: any, encoding?: any, callback?: any) => {
          const normalizedEncoding =
            typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined;
          const normalized =
            typeof chunk === 'string'
              ? chunk
              : Buffer.isBuffer(chunk)
                ? chunk.toString(
                  normalizedEncoding ?? 'utf8'
                )
                : String(chunk);

          collector(normalized);
          return (writer as unknown as (...args: any[]) => boolean)(
            chunk,
            normalizedEncoding,
            callback
          );
        }) as TWriter;

    if (capture) {
      process.stdout.write = wrapWriter(
        originalStdoutWrite,
        (chunk) => (stdoutBuffer += chunk)
      );
      process.stderr.write = wrapWriter(
        originalStderrWrite,
        (chunk) => (stderrBuffer += chunk)
      );
    }

    try {
      const result = await task();
      return { result, stdout: stdoutBuffer, stderr: stderrBuffer };
    } finally {
      if (capture) {
        process.stdout.write = originalStdoutWrite;
        process.stderr.write = originalStderrWrite;
        if (typeof console.clear === 'function') {
          console.clear();
        }
      }
      // Remount UI
      this.renderUI();
    }
  }

  async runWithTerminal<T>(task: () => Promise<T>): Promise<T> {
    const { result } = await this.executeWithTerminal(task);
    return result;
  }

  async runWithTerminalCapture<T>(
    task: () => Promise<T>
  ): Promise<{ result: T; stdout: string; stderr: string }> {
    return this.executeWithTerminal(task, { capture: true });
  }

  getTimelineAdapter(): Timeline {
    if (this.eventBus) {
      return this.createBusTimelineAdapter();
    }
    return this.createLocalTimelineAdapter();
  }

  getTimelineEvents(limit?: number): UITimelineEvent[] {
    if (typeof limit === "number" && limit > 0) {
      return this.timelineEvents.slice(-limit);
    }
    return [...this.timelineEvents];
  }

  private createBusTimelineAdapter(): Timeline {
    const bus = this.eventBus;
    if (!bus) {
      throw new Error("Agent event bus is not available");
    }
    return {
      startTask: (label: string, options?: { detail?: string }) => {
        const id = this.nextTimelineId("task");
        this.timelineTaskMetadata.set(id, { label });
        bus.emitTask({
          id,
          label,
          detail: options?.detail,
          status: "started",
          timestamp: Date.now(),
        });
        return id;
      },
      updateTask: (id: string, detail: string) => {
        const metadata = this.timelineTaskMetadata.get(id);
        bus.emitTask({
          id,
          label: metadata?.label ?? detail,
          detail,
          status: "updated",
          timestamp: Date.now(),
        });
      },
      succeed: (id: string, detail?: string) => {
        const metadata = this.timelineTaskMetadata.get(id);
        this.timelineTaskMetadata.delete(id);
        bus.emitTask({
          id,
          label: metadata?.label ?? detail ?? "",
          detail,
          status: "succeeded",
          timestamp: Date.now(),
        });
      },
      fail: (id: string, detail?: string) => {
        const metadata = this.timelineTaskMetadata.get(id);
        this.timelineTaskMetadata.delete(id);
        bus.emitTask({
          id,
          label: metadata?.label ?? detail ?? "",
          detail,
          status: "failed",
          timestamp: Date.now(),
        });
      },
      info: (message: string) => {
        this.emitBusLog("info", message);
      },
      note: (message: string) => {
        this.emitBusLog("note", message);
      },
      warn: (message: string) => {
        this.emitBusLog("warn", message);
      },
      error: (message: string) => {
        this.emitBusLog("error", message);
      },
      close: () => {
        for (const [id, metadata] of this.timelineTaskMetadata.entries()) {
          bus.emitTask({
            id,
            label: metadata.label,
            detail: "Aborted",
            status: "failed",
            timestamp: Date.now(),
          });
        }
        this.timelineTaskMetadata.clear();
        this.setStatus("");
      },
    };
  }

  private emitBusLog(level: AgentLogLevel, message: string): void {
    const bus = this.eventBus;
    if (!bus) return;
    bus.emitLog({
      id: this.nextTimelineId("log"),
      level,
      message,
      timestamp: Date.now(),
    });
  }

  private createLocalTimelineAdapter(): Timeline {
    return {
      startTask: (label: string, options?: { detail?: string }) => {
        const id = this.nextTimelineId("task");
        this.timelineTaskMetadata.set(id, { label });
        this.recordTimelineEvent({
          id,
          type: "task",
          status: "started",
          label,
          detail: options?.detail,
          timestamp: Date.now(),
        });
        this.setStatus(label);
        return id;
      },
      updateTask: (id: string, detail: string) => {
        const metadata = this.timelineTaskMetadata.get(id);
        this.recordTimelineEvent({
          id,
          type: "task",
          status: "updated",
          label: metadata?.label ?? detail,
          detail,
          timestamp: Date.now(),
        });
        this.setStatus(detail);
      },
      succeed: (id: string, detail?: string) => {
        const metadata = this.timelineTaskMetadata.get(id);
        this.timelineTaskMetadata.delete(id);
        this.recordTimelineEvent({
          id,
          type: "task",
          status: "succeeded",
          label: metadata?.label ?? detail ?? "",
          detail,
          timestamp: Date.now(),
        });
        this.setStatus(detail ?? "");
      },
      fail: (id: string, detail?: string) => {
        const metadata = this.timelineTaskMetadata.get(id);
        this.timelineTaskMetadata.delete(id);
        this.recordTimelineEvent({
          id,
          type: "task",
          status: "failed",
          label: metadata?.label ?? detail ?? "",
          detail,
          timestamp: Date.now(),
        });
        this.setStatus(detail ?? "");
      },
      info: (message: string) => {
        this.recordTimelineEvent({
          id: this.nextTimelineId("log"),
          type: "log",
          level: "info",
          message,
          timestamp: Date.now(),
        });
      },
      note: (message: string) => {
        this.recordTimelineEvent({
          id: this.nextTimelineId("log"),
          type: "log",
          level: "note",
          message,
          timestamp: Date.now(),
        });
      },
      warn: (message: string) => {
        this.recordTimelineEvent({
          id: this.nextTimelineId("log"),
          type: "log",
          level: "warn",
          message,
          timestamp: Date.now(),
        });
      },
      error: (message: string) => {
        this.recordTimelineEvent({
          id: this.nextTimelineId("log"),
          type: "log",
          level: "error",
          message,
          timestamp: Date.now(),
        });
      },
      close: () => {
        this.setStatus("");
      },
    };
  }

  // Enhanced UI tracking methods

  addTool(toolName: string, args?: Record<string, unknown>, idOverride?: string): string {
    this.flushAssistantChunks();
    const id = idOverride ?? `tool-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    if (args && Object.keys(args).length > 0) {
      this.recentToolArgs.set(toolName, args);
    }
    const existing = this.tools.find((tool) => tool.id === id);
    if (existing) {
      existing.name = toolName;
      existing.args = args;
      this.updateUI();
      return id;
    }
    this.tools.push({
      id,
      name: toolName,
      status: 'pending',
      args,
    });
    this.trimTools();
    this.recordUIEvent({
      id: `tool-${id}`,
      type: "tool",
      toolCallId: id,
      toolName,
      status: "pending",
      args,
    });
    this.updateUI();
    return id;
  }

  previewToolCall(
    id: string,
    toolName?: string,
    inputTextDelta?: string
  ): void {
    this.flushAssistantChunks();
    const name = toolName || "tool";
    const tool = this.findTool(id);
    const previous = tool?.result ?? "";
    const preview =
      inputTextDelta && inputTextDelta.length > 0
        ? `${previous}${inputTextDelta}`
        : previous;

    if (tool) {
      if (toolName && tool.name !== toolName) {
        tool.name = toolName;
      }
      tool.status = tool.status === "pending" ? "pending" : tool.status;
      if (preview) {
        tool.result = preview;
      }
    } else {
      this.tools.push({
        id,
        name,
        status: "pending",
        startTime: Date.now(),
        result: preview || undefined,
      });
      this.trimTools();
    }

    this.recordUIEvent({
      id: `tool-${id}-delta-${this.uiEventSequence + 1}`,
      type: "tool",
      toolCallId: id,
      toolName: name,
      status: "pending",
      preview: preview || undefined,
    });
    this.debouncedUpdateUI();
  }

  private findTool(handle: string): ToolCall | undefined {
    return (
      this.tools.find((tool) => tool.id === handle) ??
      [...this.tools]
        .reverse()
        .find(
          (tool) =>
            tool.name === handle &&
            (tool.status === "pending" || tool.status === "running")
        )
    );
  }

  startTool(id: string): void {
    this.flushAssistantChunks();
    const tool = this.findTool(id);
    if (tool) {
      tool.status = 'running';
      tool.startTime = Date.now();
      this.recordUIEvent({
        id: `tool-${id}-running-${Date.now()}`,
        type: "tool",
        toolCallId: tool.id,
        toolName: tool.name,
        status: "running",
        args: tool.args,
      });
      this.updateUI();
    }
  }

  updateToolProgress(id: string, partial?: string): void {
    if (!partial?.trim()) {
      return;
    }
    const tool = this.findTool(id);
    if (tool) {
      tool.result = partial.trim();
      this.recordUIEvent({
        id: `tool-${id}-progress-${this.uiEventSequence + 1}`,
        type: "tool",
        toolCallId: tool.id,
        toolName: tool.name,
        status: tool.status,
        args: tool.args,
        preview: tool.result,
      });
      this.debouncedUpdateUI();
    }
  }

  completeTool(id: string, result?: string, details?: Record<string, unknown>): void {
    const tool = this.findTool(id);
    if (tool) {
      tool.status = 'success';
      tool.endTime = Date.now();
      tool.result = result;
      tool.details = details ?? tool.details;
      this.recordUIEvent({
        id: `tool-${id}-success-${Date.now()}`,
        type: "tool",
        toolCallId: tool.id,
        toolName: tool.name,
        status: "success",
        args: tool.args,
        details: tool.details,
        preview: result,
      });
      // Cancel any pending throttled progress render — completeTool's
      // synchronous updateUI() below already shows the final state. Without
      // this cancel, the debounced render fires ~32ms later with the same
      // state and produces a redundant whole-tree reconcile.
      this.debouncedUpdateUI.cancel();
      this.updateUI();
    }
  }

  failTool(id: string, error: string, details?: Record<string, unknown>): void {
    const tool = this.findTool(id);
    if (tool) {
      tool.status = 'error';
      tool.endTime = Date.now();
      tool.error = error;
      tool.details = details ?? tool.details;
      this.recordUIEvent({
        id: `tool-${id}-error-${Date.now()}`,
        type: "tool",
        toolCallId: tool.id,
        toolName: tool.name,
        status: "error",
        args: tool.args,
        details: tool.details,
        error,
      });
      this.debouncedUpdateUI.cancel();
      this.updateUI();
    }
  }

  clearTools(): void {
    const retained = this.tools
      .filter((tool) => tool.status === "success" || tool.status === "error")
      .slice(-8);
    this.tools = retained;
    this.updateUI();
  }

  private findLatestWorkflowStage(
    name: string,
    statuses?: Array<WorkflowStage["status"]>
  ): WorkflowStage | undefined {
    for (let i = this.workflowStages.length - 1; i >= 0; i--) {
      const stage = this.workflowStages[i];
      if (stage.name !== name) {
        continue;
      }
      if (!statuses || statuses.includes(stage.status)) {
        return stage;
      }
    }
    return undefined;
  }

  addWorkflowStage(name: string): void {
    this.workflowStages.push({
      name,
      status: 'pending',
    });
    this.trimWorkflowStages();
    this.updateUI();
  }

  startWorkflowStage(name: string): void {
    const stage =
      this.findLatestWorkflowStage(name, ['pending']) ??
      this.findLatestWorkflowStage(name);
    if (stage) {
      stage.status = 'running';
      stage.startTime ??= Date.now();
      this.updateUI();
    }
  }

  completeWorkflowStage(name: string): void {
    const stage =
      this.findLatestWorkflowStage(name, ['running', 'pending']) ??
      this.findLatestWorkflowStage(name);
    if (stage) {
      stage.status = 'complete';
      stage.endTime = Date.now();
      this.updateUI();
    }
  }

  failWorkflowStage(name: string): void {
    const stage =
      this.findLatestWorkflowStage(name, ['running', 'pending']) ??
      this.findLatestWorkflowStage(name);
    if (stage) {
      stage.status = 'error';
      stage.endTime = Date.now();
      this.updateUI();
    }
  }

  clearWorkflowStages(): void {
    this.workflowStages = [];
    this.updateUI();
  }

  setIteration(current: number, max?: number): void {
    this.currentIteration = current;
    this.maxIterations = max;
    this.updateUI();
  }

  updateTokens(used: number, limit?: number): void {
    this.tokens = { used, limit };
    this.updateUI();
  }

  updateCost(current: number, limit?: number): void {
    this.cost = { current, limit };
    this.updateUI();
  }

  incrementMessageCount(): void {
    this.messageCount++;
    this.updateUI();
  }

  destroy(): void {
    this.flushAssistantChunks();
    this.debouncedUpdateUI.cancel();
    this.detachEventBus();
    if (this.promptActive && this.promptRejecter) {
      this.promptRejecter(new Error('UI destroyed'));
    }
    if (this.choiceRejecter) {
      this.choiceRejecter(new Error("UI destroyed"));
    }
    if (this.formRejecter) {
      this.formRejecter(new Error("UI destroyed"));
    }

    this.onSubmitCallback = undefined;
    this.promptResolver = null;
    this.promptRejecter = null;
    this.promptActive = false;
    this.choicePrompt = null;
    this.choiceResolver = null;
    this.choiceRejecter = null;
    this.formPrompt = null;
    this.formResolver = null;
    this.formRejecter = null;

    if (this.instance) {
      this.instance.unmount();
      this.instance = null;
    }
  }

  private attachEventBus(): void {
    if (!this.eventBus) {
      return;
    }
    this.detachEventBus();
    this.busUnsubscribers.push(
      this.eventBus.onTask((event) => this.handleTaskEvent(event)),
      this.eventBus.onLog((event) => this.handleLogEvent(event)),
      this.eventBus.onPlan(({ plan }) => this.setPlan(plan)),
      this.eventBus.onTool((event) => this.handleToolEvent(event)),
      this.eventBus.onQueue((event) => this.handleQueueEvent(event)),
    );
  }

  private detachEventBus(): void {
    if (this.busUnsubscribers.length === 0) {
      return;
    }
    for (const dispose of this.busUnsubscribers) {
      dispose();
    }
    this.busUnsubscribers = [];
  }

  private handleTaskEvent(event: AgentTaskEvent): void {
    this.recordTimelineEvent({
      id: event.id,
      type: "task",
      status: event.status,
      label: event.label,
      detail: event.detail,
      timestamp: event.timestamp,
    });
    if (event.status === "started" || event.status === "updated") {
      this.setStatus(event.detail ?? event.label);
    } else if (event.status === "succeeded") {
      this.setStatus(event.detail ?? "");
    } else {
      this.setStatus(event.detail ?? "");
    }
  }

  private handleLogEvent(event: AgentLogEvent): void {
    this.recordTimelineEvent({
      id: event.id,
      type: "log",
      level: event.level,
      message: event.message,
      timestamp: event.timestamp,
    });
  }

  private handleQueueEvent(event: AgentQueueEvent): void {
    this.recordTimelineEvent({
      id: event.id,
      type: "queue",
      action: event.action,
      mode: event.mode,
      message: event.message,
      pendingSteering: event.pendingSteering,
      pendingFollowUp: event.pendingFollowUp,
      timestamp: event.timestamp,
    });

    const modeLabel = event.mode === "followUp" ? "follow-up" : "steer";
    const verb = event.action === "queued" ? "Queued" : "Delivered";
    this.messages.push({
      id: `msg-${event.timestamp}-${event.id}`,
      role: "system",
      content: `${verb} ${modeLabel}: ${event.message}`,
      timestamp: event.timestamp,
    });
    this.trimMessages();
    this.updateUI();
  }

  private handleToolEvent(event: AgentToolEvent): void {
    const statusMap: Record<AgentToolEvent["status"], ToolCall["status"]> = {
      pending: "pending",
      running: "running",
      succeeded: "success",
      failed: "error",
    };
    const tool = this.tools.find((existing) => existing.id === event.id);
    if (tool) {
      tool.status = statusMap[event.status];
      if (event.resultPreview) {
        tool.result = event.resultPreview;
      }
      if (event.error) {
        tool.error = event.error;
      }
      if (event.status === "succeeded" || event.status === "failed") {
        tool.endTime = Date.now();
      }
    } else {
      this.tools.push({
        id: event.id,
        name: event.tool,
        status: statusMap[event.status],
        startTime: Date.now(),
        result: event.resultPreview,
        error: event.error,
      });
      this.trimTools();
    }
    this.updateUI();
  }

  private nextTimelineId(prefix: string): string {
    this.timelineSequence += 1;
    return `${prefix}-${this.timelineSequence}`;
  }

  private clonePlan(plan: Plan): Plan {
    return {
      ...plan,
      tasks: plan.tasks.map((task) => ({ ...task })),
    };
  }

  private isPlanFinished(plan: Plan | null): boolean {
    return Boolean(
      plan?.tasks.length &&
        plan.tasks.every(
          (task) => task.status === "completed" || task.status === "skipped"
        )
    );
  }

  private clearFinishedPlan(): void {
    if (!this.isPlanFinished(this.plan)) {
      return;
    }

    this.plan = null;
    planStore.clear();
  }

  private recordTimelineEvent(event: UITimelineEvent): void {
    const events = [...this.timelineEvents, event];
    if (events.length > this.maxTimelineEvents) {
      events.splice(0, events.length - this.maxTimelineEvents);
    }
    this.timelineEvents = events;
  }
}

function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

export default InkChatAdapter;
