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
import {
  AgentEventBus,
  type AgentLogEvent,
  type AgentTaskEvent,
  type AgentLogLevel,
  type AgentToolEvent,
} from "../../agent/eventBus.js";
import { debounce } from "./utils/debounce.js";
import { getAllCommands } from "../../slash/registry.js";

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  isError?: boolean;
  isCot?: boolean;
  timestamp?: number;
}

interface ChoicePromptState {
  message: string;
  options: Array<{ label: string; value: string }>;
  defaultValue: string;
}

export interface InkChatConfig {
  provider: string;
  model: string;
  cwd: string;
  uiSettings?: UISettings;
  eventBus?: AgentEventBus;
}

type Mode = 'edit' | 'plan';

export class InkChatAdapter {
  private config: InkChatConfig;
  private messages: Message[] = [];
  private draftAssistant: Message | null = null;
  private promptResolver: ((value: string) => void) | null = null;
  private promptRejecter: ((reason?: unknown) => void) | null = null;
  private promptActive = false;
  private choicePrompt: ChoicePromptState | null = null;
  private choiceResolver: ((value: string) => void) | null = null;
  private choiceRejecter: ((reason?: unknown) => void) | null = null;
  private instance: any = null;
  private isThinking = false;
  private statusMessage: string | null = null;
  private onSubmitCallback?: (text: string) => void;
  private onInterruptCallback?: () => void;
  private mode: Mode = 'edit';
  private onModeChangeCallback?: (mode: Mode) => void;

  // Cache most-recent args per tool name for inline block rendering
  private recentToolArgs = new Map<string, Record<string, unknown>>();

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

  // Debounced updateUI for streaming - reduces re-renders from 100+/sec to ~20/sec
  private debouncedUpdateUI = debounce(() => this.updateUI(), { delay: 50, maxWait: 200 });

  constructor(config: InkChatConfig) {
    this.config = config;
    this.uiSettings = resolveUISettings(config.uiSettings);
    this.eventBus = config.eventBus;
    this.attachEventBus();
    this.renderUI();
  }

  private getSlashSuggestions() {
    return getAllCommands(this.config.cwd);
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
    const handleMessage = (message: string) => {
      if (this.promptResolver) {
        this.promptResolver(message);
        this.promptResolver = null;
        this.promptRejecter = null;
        this.promptActive = false;
      } else if (this.onSubmitCallback) {
        const trimmed = message.trim();
        if (trimmed && !trimmed.startsWith("/")) {
          this.appendUserMessage(trimmed, { optimistic: true });
        }
        this.onSubmitCallback(message);
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
        mode: this.mode,
        onModeChange: handleModeChange,
        tools: this.tools.length > 0 ? this.tools : undefined,
        workflowStages: this.workflowStages.length > 0 ? this.workflowStages : undefined,
        currentIteration: this.currentIteration,
        maxIterations: this.maxIterations,
        tokens: this.tokens.used > 0 ? this.tokens : undefined,
        cost: this.cost.current > 0 ? this.cost : undefined,
        messageCount: this.messageCount,
        sessionUptime,
        timelineEvents: this.timelineEvents,
        plan: this.plan ?? undefined,
        uiSettings: activeSettings,
        slashSuggestions: this.getSlashSuggestions(),
        choicePrompt: this.choicePrompt ?? undefined,
        onChoiceSelect: handleChoiceSelect,
      }),
    );
  }

  private updateUI() {
    if (!this.instance) return;

    const handleMessage = (message: string) => {
      if (this.promptResolver) {
        this.promptResolver(message);
        this.promptResolver = null;
        this.promptRejecter = null;
        this.promptActive = false;
      } else if (this.onSubmitCallback) {
        const trimmed = message.trim();
        if (trimmed && !trimmed.startsWith("/")) {
          this.appendUserMessage(trimmed, { optimistic: true });
        }
        this.onSubmitCallback(message);
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
        mode: this.mode,
        onModeChange: handleModeChange,
        tools: this.tools.length > 0 ? this.tools : undefined,
        workflowStages: this.workflowStages.length > 0 ? this.workflowStages : undefined,
        currentIteration: this.currentIteration,
        maxIterations: this.maxIterations,
        tokens: this.tokens.used > 0 ? this.tokens : undefined,
        cost: this.cost.current > 0 ? this.cost : undefined,
        messageCount: this.messageCount,
        sessionUptime,
        plan: this.plan ?? undefined,
        timelineEvents: this.timelineEvents,
        uiSettings: activeSettings,
        slashSuggestions: this.getSlashSuggestions(),
        choicePrompt: this.choicePrompt ?? undefined,
        onChoiceSelect: handleChoiceSelect,
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
    options?: { optimistic?: boolean; consumeOptimistic?: boolean }
  ): void {
    const normalized = content.trim();
    if (!normalized) return;

    if (options?.consumeOptimistic && this.pendingUserMessages.delete(normalized)) {
      return;
    }

    this.messages.push({
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      role: "user",
      content: normalized,
      timestamp: Date.now(),
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
      .filter((entry) => entry.content.trim().length > 0)
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
    this.messageCount += restored.length;
    this.updateUI();
  }

  beginTurn(): void {
    this.debouncedUpdateUI.cancel();
    this.draftAssistant = null;
    this.isThinking = true;
    this.statusMessage = null;
    this.tools = [];
    this.workflowStages = [];
    this.currentIteration = undefined;
    this.maxIterations = undefined;
    this.timelineEvents = [];
    this.timelineTaskMetadata.clear();
    this.updateUI();
  }

  endTurn(): void {
    this.debouncedUpdateUI.cancel();
    this.isThinking = false;
    this.statusMessage = null;
    this.tools = [];
    this.workflowStages = [];
    this.currentIteration = undefined;
    this.maxIterations = undefined;
    this.timelineTaskMetadata.clear();
    this.updateUI();
  }

  startAssistantMessage(): void {
    this.isThinking = true;
    this.draftAssistant = {
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };
    this.updateUI();
  }

  appendAssistantChunk(chunk: string): void {
    if (!this.draftAssistant) {
      this.startAssistantMessage();
    }

    if (this.draftAssistant) {
      this.draftAssistant.content += chunk;
      // Use debounced updateUI for streaming to reduce re-renders
      this.debouncedUpdateUI();
    }
  }

  finishAssistantMessage(): void {
    this.isThinking = false;
    // Cancel any pending debounced updates and render final state immediately
    this.debouncedUpdateUI.cancel();
    this.updateUI();
  }

  settleAssistantMessage(content: string): void {
    const normalized = content.trim() || this.draftAssistant?.content.trim() || "";
    if (!normalized) {
      return;
    }

    const draft = this.draftAssistant;
    this.messages.push({
      id: draft?.id ?? `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      role: "assistant",
      content: normalized,
      timestamp: draft?.timestamp ?? Date.now(),
    });
    this.draftAssistant = null;
    this.isThinking = false;
    this.updateUI();
  }

  discardAssistantMessage(): void {
    this.debouncedUpdateUI.cancel();
    this.draftAssistant = null;
    this.isThinking = false;
    this.updateUI();
  }

  appendSystemMessage(content: string): void {
    this.messages.push({ id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, role: 'system', content, timestamp: Date.now() });
    this.updateUI();
  }

  addCotMessage(content: string): void {
    const normalized = content.trim();
    if (!normalized) return;
    this.messages.push({
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      role: 'assistant',
      content: normalized,
      isCot: true,
      timestamp: Date.now(),
    });
    this.updateUI();
  }

  appendToolMessage(toolName: string, content: string, isError?: boolean): void {
    const toolArgs = this.recentToolArgs.get(toolName);
    this.messages.push({
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      role: 'tool',
      content,
      toolName,
      toolArgs,
      isError,
      timestamp: Date.now(),
    });
    this.updateUI();
  }

  clearMessages(): void {
    this.messages = [];
    this.draftAssistant = null;
    this.messageCount = 0;
    this.updateUI();
  }

  setStatus(text: string): void {
    this.statusMessage = sanitizeStatusText(text ?? "") || null;
    this.updateUI();
  }

  enableContinuousChat(onSubmit: (text: string) => void): void {
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
        this.setStatus(`?? ${label}`);
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
        this.setStatus(`?? ${detail}`);
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
        this.setStatus(detail ? `? ${detail}` : "");
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
        this.setStatus(detail ? `? ${detail}` : "");
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

  addTool(toolName: string, args?: Record<string, unknown>): string {
    const id = `tool-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    if (args && Object.keys(args).length > 0) {
      this.recentToolArgs.set(toolName, args);
    }
    this.tools.push({
      id,
      name: toolName,
      status: 'pending',
      args,
    });
    this.updateUI();
    return id;
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
    const tool = this.findTool(id);
    if (tool) {
      tool.status = 'running';
      tool.startTime = Date.now();
      this.updateUI();
    }
  }

  completeTool(id: string, result?: string): void {
    const tool = this.findTool(id);
    if (tool) {
      tool.status = 'success';
      tool.endTime = Date.now();
      tool.result = result;
      this.updateUI();
    }
  }

  failTool(id: string, error: string): void {
    const tool = this.findTool(id);
    if (tool) {
      tool.status = 'error';
      tool.endTime = Date.now();
      tool.error = error;
      this.updateUI();
    }
  }

  clearTools(): void {
    this.tools = [];
    this.updateUI();
  }

  addWorkflowStage(name: string): void {
    this.workflowStages.push({
      name,
      status: 'pending',
    });
    this.updateUI();
  }

  startWorkflowStage(name: string): void {
    const stage = this.workflowStages.find(s => s.name === name);
    if (stage) {
      stage.status = 'running';
      stage.startTime = Date.now();
      this.updateUI();
    }
  }

  completeWorkflowStage(name: string): void {
    const stage = this.workflowStages.find(s => s.name === name);
    if (stage) {
      stage.status = 'complete';
      stage.endTime = Date.now();
      this.updateUI();
    }
  }

  failWorkflowStage(name: string): void {
    const stage = this.workflowStages.find(s => s.name === name);
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

  setIteration(current: number, max: number): void {
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
    this.detachEventBus();
    if (this.promptActive && this.promptRejecter) {
      this.promptRejecter(new Error('UI destroyed'));
    }
    if (this.choiceRejecter) {
      this.choiceRejecter(new Error("UI destroyed"));
    }

    this.onSubmitCallback = undefined;
    this.promptResolver = null;
    this.promptRejecter = null;
    this.promptActive = false;
    this.choicePrompt = null;
    this.choiceResolver = null;
    this.choiceRejecter = null;

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
      this.setStatus(`?? ${event.detail ?? event.label}`);
    } else if (event.status === "succeeded") {
      this.setStatus(event.detail ? `? ${event.detail}` : "");
    } else {
      this.setStatus(event.detail ? `? ${event.detail}` : "");
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
