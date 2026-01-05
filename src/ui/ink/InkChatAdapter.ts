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

interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolName?: string;
  timestamp?: number;
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
  private promptResolver: ((value: string) => void) | null = null;
  private promptRejecter: ((reason?: unknown) => void) | null = null;
  private promptActive = false;
  private instance: any = null;
  private isThinking = false;
  private statusMessage: string | null = null;
  private currentAssistantIndex: number | null = null;
  private onSubmitCallback?: (text: string) => void;
  private onInterruptCallback?: () => void;
  private mode: Mode = 'edit';
  private onModeChangeCallback?: (mode: Mode) => void;

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

  // Debounced updateUI for streaming - reduces re-renders from 100+/sec to ~20/sec
  private debouncedUpdateUI = debounce(() => this.updateUI(), { delay: 50, maxWait: 200 });

  constructor(config: InkChatConfig) {
    this.config = config;
    this.uiSettings = resolveUISettings(config.uiSettings);
    this.eventBus = config.eventBus;
    this.attachEventBus();
    this.renderUI();
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
      if (this.onSubmitCallback) {
        this.onSubmitCallback(message);
      } else if (this.promptActive && this.promptResolver) {
        this.promptResolver(message);
        this.promptResolver = null;
        this.promptRejecter = null;
        this.promptActive = false;
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

    const sessionUptime = (Date.now() - this.sessionStartTime) / 1000;

    const activeSettings = this.getActiveUiSettings();

    this.instance = render(
      React.createElement(AppContainer, {
        messages: this.messages,
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
      }),
    );
  }

  private updateUI() {
    if (!this.instance) return;

    const handleMessage = (message: string) => {
      if (this.onSubmitCallback) {
        this.onSubmitCallback(message);
      } else if (this.promptActive && this.promptResolver) {
        this.promptResolver(message);
        this.promptResolver = null;
        this.promptRejecter = null;
        this.promptActive = false;
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

    const sessionUptime = (Date.now() - this.sessionStartTime) / 1000;

    // Force re-render by unmounting and remounting
    const activeSettings = this.getActiveUiSettings();

    this.instance.rerender(
      React.createElement(AppContainer, {
        messages: this.messages,
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

  appendUserMessage(content: string): void {
    if (!content.trim()) return;
    this.messages.push({ role: 'user', content, timestamp: Date.now() });
    this.messageCount++;
    this.updateUI();
  }

  startAssistantMessage(): void {
    this.isThinking = true;
    this.currentAssistantIndex = this.messages.push({
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    }) - 1;
    this.updateUI();
  }

  appendAssistantChunk(chunk: string): void {
    if (this.currentAssistantIndex === null) {
      this.startAssistantMessage();
    }

    if (this.currentAssistantIndex === null) return;

    const message = this.messages[this.currentAssistantIndex];
    if (message) {
      message.content += chunk;
      // Use debounced updateUI for streaming to reduce re-renders
      this.debouncedUpdateUI();
    }
  }

  finishAssistantMessage(): void {
    this.isThinking = false;

    // If the assistant message is still empty (e.g., provider only streamed tool
    // calls or nothing at all), fill it with a friendly status so the UI isn't
    // blank.
    if (this.currentAssistantIndex !== null) {
      const msg = this.messages[this.currentAssistantIndex];
      if (msg && (!msg.content || msg.content.trim().length === 0)) {
        msg.content =
          this.statusMessage?.trim() ||
          "Waiting for user input…";
      }
    }

    this.currentAssistantIndex = null;
    // Cancel any pending debounced updates and render final state immediately
    this.debouncedUpdateUI.cancel();
    this.updateUI();
  }

  appendSystemMessage(content: string): void {
    this.messages.push({ role: 'system', content, timestamp: Date.now() });
    this.updateUI();
  }

  appendToolMessage(toolName: string, content: string): void {
    this.messages.push({
      role: 'tool',
      content,
      toolName,
      timestamp: Date.now(),
    });
    this.updateUI();
  }

  setStatus(text: string): void {
    this.statusMessage = text?.trim() || null;
    this.updateUI();
  }

  enableContinuousChat(onSubmit: (text: string) => void): void {
    this.onSubmitCallback = onSubmit;
    this.promptActive = true;
    this.updateUI();
  }

  async prompt(): Promise<string> {
    if (this.promptActive) {
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
    // Render a lightweight inline choice prompt in the transcript, then wait for
    // the user to type a selection (by label or value). Falls back to the
    // provided defaultValue on empty input.
    const choiceLine = options.map(o => `${o.label} [${o.value}]`).join(' | ');
    this.appendSystemMessage(`${message}\n${choiceLine}\nEnter choice (default: ${defaultValue}):`);

    const raw = await this.prompt();
    const input = raw.trim();
    if (!input) return defaultValue;

    const normalized = input.toLowerCase();
    const match =
      options.find(o => o.value.toLowerCase() === normalized) ||
      options.find(o => o.label.toLowerCase() === normalized);

    if (match) {
      return match.value;
    }

    // If the user typed a partial prefix, accept the first matching prefix.
    const prefixMatch =
      options.find(o => o.value.toLowerCase().startsWith(normalized)) ||
      options.find(o => o.label.toLowerCase().startsWith(normalized));
    if (prefixMatch) {
      return prefixMatch.value;
    }

    // Unrecognized input: return default to stay safe.
    return defaultValue;
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
        this.appendSystemMessage(`??  ${message}`);
      },
      note: (message: string) => {
        this.recordTimelineEvent({
          id: this.nextTimelineId("log"),
          type: "log",
          level: "note",
          message,
          timestamp: Date.now(),
        });
        this.appendSystemMessage(`?? ${message}`);
      },
      warn: (message: string) => {
        this.recordTimelineEvent({
          id: this.nextTimelineId("log"),
          type: "log",
          level: "warn",
          message,
          timestamp: Date.now(),
        });
        this.appendSystemMessage(`??  ${message}`);
      },
      error: (message: string) => {
        this.recordTimelineEvent({
          id: this.nextTimelineId("log"),
          type: "log",
          level: "error",
          message,
          timestamp: Date.now(),
        });
        this.appendSystemMessage(`? ${message}`);
      },
      close: () => {
        this.setStatus("");
      },
    };
  }

  // Enhanced UI tracking methods

  addTool(toolName: string): string {
    const id = `tool-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.tools.push({
      id,
      name: toolName,
      status: 'pending',
    });
    this.updateUI();
    return id;
  }

  startTool(id: string): void {
    const tool = this.tools.find(t => t.id === id);
    if (tool) {
      tool.status = 'running';
      tool.startTime = Date.now();
      this.updateUI();
    }
  }

  completeTool(id: string, result?: string): void {
    const tool = this.tools.find(t => t.id === id);
    if (tool) {
      tool.status = 'success';
      tool.endTime = Date.now();
      tool.result = result;
      this.updateUI();
    }
  }

  failTool(id: string, error: string): void {
    const tool = this.tools.find(t => t.id === id);
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

    this.onSubmitCallback = undefined;
    this.promptResolver = null;
    this.promptRejecter = null;
    this.promptActive = false;

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
    if (event.level === "info") {
      this.appendSystemMessage(`??  ${event.message}`);
    } else if (event.level === "note") {
      this.appendSystemMessage(`?? ${event.message}`);
    } else if (event.level === "warn") {
      this.appendSystemMessage(`??  ${event.message}`);
    } else {
      this.appendSystemMessage(`? ${event.message}`);
    }
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

export default InkChatAdapter;
