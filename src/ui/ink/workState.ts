/**
 * Pure helpers for the work-log's transient state.
 *
 * Lives outside InkChatAdapter so we can unit-test the state machine
 * without standing up a real Ink render (which requires a TTY-shaped
 * stdin and rains React fiber stack traces on test output).
 *
 * The adapter holds the *actual* fields. This module just enforces the
 * "what should be cleared when" invariant.
 */

import type { ToolCall } from "./components/tools/index.js";
import type { WorkflowStage } from "./components/workflow/index.js";
import type { Message } from "./contexts/ChatContext.js";

/** The slice of InkChatAdapter that represents in-flight work indicators. */
export interface LiveWorkState {
  draftAssistant: Message | null;
  isThinking: boolean;
  turnActive: boolean;
  statusMessage: string | null;
  tools: ToolCall[];
  workflowStages: WorkflowStage[];
  currentIteration: number | undefined;
  maxIterations: number | undefined;
}

export function createEmptyWorkState(): LiveWorkState {
  return {
    draftAssistant: null,
    isThinking: false,
    turnActive: false,
    statusMessage: null,
    tools: [],
    workflowStages: [],
    currentIteration: undefined,
    maxIterations: undefined,
  };
}

/**
 * Clear all transient indicators. Does NOT change `turnActive` — that's the
 * caller's job (endTurn flips it, mid-turn error paths leave it alone).
 */
export function clearLiveWorkState(
  state: LiveWorkState,
  options?: { keepDraft?: boolean }
): void {
  if (!options?.keepDraft) {
    state.draftAssistant = null;
  }
  state.isThinking = state.turnActive;
  state.statusMessage = null;
  state.tools = [];
  state.workflowStages = [];
  state.currentIteration = undefined;
  state.maxIterations = undefined;
}
