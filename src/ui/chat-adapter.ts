/**
 * Renderer-agnostic chat UI seam.
 *
 * Everything outside src/ui that drives the interactive chat UI talks to this
 * interface. The sole implementation is TuiChatAdapter (src/ui/tui-adapter),
 * built on the vendored pi-tui differential renderer. The interface is kept as
 * a seam so the renderer can be swapped or mocked without touching callers.
 */

import type { MessageAttachment } from "../agent/core/types.js";
import type { Plan } from "../plan/types.js";
import type { BackgroundTerminalSession } from "../runtime/backgroundTerminals.js";
import type { UITimelineEvent } from "./shared/timelineTypes.js";

export type ChatMode = "edit" | "plan";

export interface TranscriptEntry {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp?: number;
  metadata?: {
    toolName?: string;
  };
}

export interface ChoiceOption<T extends string = string> {
  label: string;
  value: T;
}

export interface FormQuestion {
  id: string;
  label: string;
  type: "select" | "multiselect";
  required?: boolean;
  options: Array<{ label: string; value: string; description?: string }>;
}

export interface ChatAdapter {
  // ── Lifecycle ────────────────────────────────────────────────────────────
  destroy(): void;

  // ── Turn boundaries ──────────────────────────────────────────────────────
  beginTurn(): void;
  endTurn(): void;
  forceResetWorkState(): void;

  // ── Transcript ───────────────────────────────────────────────────────────
  appendUserMessage(
    content: string,
    options?: {
      optimistic?: boolean;
      consumeOptimistic?: boolean;
      attachmentCount?: number;
    }
  ): void;
  appendSystemMessage(content: string): void;
  addCotMessage(content: string): void;
  appendToolMessage(
    toolName: string,
    content: string,
    isError?: boolean,
    metadata?: { toolCallId?: string; details?: Record<string, unknown> }
  ): void;
  replayTranscript(entries: TranscriptEntry[]): void;
  clearMessages(): void;
  getLastAssistantContent(): string | null;

  // ── Assistant streaming ──────────────────────────────────────────────────
  startAssistantMessage(): void;
  appendAssistantChunk(chunk: string): void;
  finishAssistantMessage(): void;
  settleAssistantMessage(content: string): void;

  // ── Tool lifecycle ───────────────────────────────────────────────────────
  addTool(
    toolName: string,
    args?: Record<string, unknown>,
    idOverride?: string
  ): string;
  previewToolCall(id: string, toolName?: string, inputTextDelta?: string): void;
  startTool(id: string): void;
  updateToolProgress(id: string, partial?: string): void;
  completeTool(id: string, result?: string, details?: Record<string, unknown>): void;
  failTool(id: string, error: string, details?: Record<string, unknown>): void;
  clearTools(): void;

  // ── Workflow stages / iterations ─────────────────────────────────────────
  addWorkflowStage(name: string): void;
  startWorkflowStage(name: string): void;
  completeWorkflowStage(name: string): void;
  failWorkflowStage(name: string): void;
  setIteration(current: number, max?: number): void;

  // ── Status / footer ──────────────────────────────────────────────────────
  setStatus(text: string): void;
  updateTokens(used: number, limit?: number, estimated?: boolean): void;
  updateCost(current: number, limit?: number): void;
  incrementMessageCount(): void;

  // ── Queue ────────────────────────────────────────────────────────────────
  setQueueState(queue: { steering: string[]; followUp: string[] }): void;
  getQueueMode(): "steer" | "followUp";

  // ── Input ────────────────────────────────────────────────────────────────
  enableContinuousChat(
    onSubmit: (text: string, attachments?: MessageAttachment[]) => void
  ): void;
  prompt(): Promise<string>;
  /** Like prompt(), but masks input for secrets (API keys) and never stores it in history. */
  promptSecret(): Promise<string>;
  promptChoice<T extends string>(
    message: string,
    options: Array<ChoiceOption<T>>,
    defaultValue: T
  ): Promise<T>;
  promptForm(
    title: string,
    questions: FormQuestion[],
    submitLabel?: string
  ): Promise<Record<string, string | string[]>>;
  setInterruptHandler(handler: () => void): void;
  setModeChangeHandler(handler: (mode: ChatMode) => void): void;
  getMode(): ChatMode;
  setMode(mode: ChatMode): void;
  setPlan(plan: Plan | null): void;

  // ── Environment ──────────────────────────────────────────────────────────
  setBackgroundSessions(sessions: BackgroundTerminalSession[]): void;
  setBackgroundSessionStopHandler(handler: (id: string) => void): void;
  captureConsole(): void;
  restoreConsole(): void;
  runWithTerminal<T>(task: () => Promise<T>): Promise<T>;
  setScreenReaderMode(mode: "auto" | "on" | "off"): void;
  setAlternateBufferMode(mode: "on" | "off" | "auto"): void;
  getTimelineEvents(limit?: number): UITimelineEvent[];
}
