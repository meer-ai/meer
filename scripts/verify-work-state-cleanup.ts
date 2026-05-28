/**
 * Lock down the "the chat is stuck on Running…" class of bugs.
 *
 * At every terminal seam (turn_end, mid-turn error/abort, follow-up turns),
 * the work-log state must reach a clean zero — no stranded tools, workflow
 * stages, draft assistant, status text, or iteration counters.
 *
 * We test the pure `clearLiveWorkState` helper rather than the full
 * InkChatAdapter so we don't have to stand up a real Ink render in a
 * non-TTY environment. The adapter delegates to this helper, so locking
 * down the helper locks down the adapter's cleanup behavior.
 */

import {
  clearLiveWorkState,
  createEmptyWorkState,
  type LiveWorkState,
} from "../src/ui/ink/workState.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function populateBusyState(turnActive: boolean): LiveWorkState {
  const state = createEmptyWorkState();
  state.turnActive = turnActive;
  state.isThinking = true;
  state.draftAssistant = {
    id: "msg-draft",
    role: "assistant",
    content: "thinking…",
    timestamp: Date.now(),
  } as any;
  state.statusMessage = "Running command…";
  state.tools = [
    { id: "t1", name: "run_command", status: "running" } as any,
    { id: "t2", name: "read_file", status: "pending" } as any,
  ];
  state.workflowStages = [
    { name: "planning", status: "complete" } as any,
    { name: "execution", status: "running" } as any,
  ];
  state.currentIteration = 3;
  state.maxIterations = 10;
  return state;
}

// --- Scenario 1: normal turn end (turnActive: true → false) ---------------
{
  const state = populateBusyState(true);
  // Simulate endTurn: flip turnActive, then clear.
  state.turnActive = false;
  clearLiveWorkState(state);

  assert(state.draftAssistant === null, "draft cleared on endTurn");
  assert(!state.isThinking, "isThinking cleared on endTurn");
  assert(state.statusMessage === null, "status cleared on endTurn");
  assert(state.tools.length === 0, "tools cleared on endTurn");
  assert(state.workflowStages.length === 0, "stages cleared on endTurn");
  assert(state.currentIteration === undefined, "iteration cleared on endTurn");
  assert(state.maxIterations === undefined, "maxIterations cleared on endTurn");
  assert(!state.turnActive, "turnActive stays false");
}

// --- Scenario 2: mid-turn error (turnActive still true, no turn_end) ------
// Reproduces the bug where a thrown listener in meer-agent.catch prevented
// turn_end from emitting → endTurn never ran → tools stuck on screen.
// forceResetWorkState calls clearLiveWorkState WITHOUT flipping turnActive,
// so isThinking is preserved (still in-flight) but visible widgets clear.
{
  const state = populateBusyState(true);
  clearLiveWorkState(state);

  assert(state.tools.length === 0, "tools cleared on mid-turn reset");
  assert(state.workflowStages.length === 0, "stages cleared on mid-turn reset");
  assert(state.statusMessage === null, "status cleared on mid-turn reset");
  assert(state.draftAssistant === null, "draft cleared on mid-turn reset");
  assert(state.currentIteration === undefined, "iteration cleared");
  // turnActive stays true → isThinking stays true so the UI knows we're
  // not idle yet; the next turn_end will flip it.
  assert(state.turnActive, "turnActive preserved on mid-turn reset");
  assert(state.isThinking, "isThinking preserved on mid-turn reset");
}

// --- Scenario 3: keepDraft preserves the streaming draft ------------------
// `discardAssistantMessage` uses { keepDraft: false } — the draft IS dropped.
// But other callers may want to keep it (e.g., a future "tools cleared but
// streaming continues" scenario).
{
  const state = populateBusyState(true);
  clearLiveWorkState(state, { keepDraft: true });

  assert(state.draftAssistant !== null, "draft preserved with keepDraft");
  assert(state.tools.length === 0, "tools still cleared with keepDraft");
}

// --- Scenario 4: idempotent ----------------------------------------------
{
  const state = populateBusyState(false);
  state.turnActive = false;
  clearLiveWorkState(state);
  clearLiveWorkState(state);
  clearLiveWorkState(state);

  assert(state.tools.length === 0, "idempotent: tools clear");
  assert(!state.isThinking, "idempotent: isThinking clear");
  assert(state.statusMessage === null, "idempotent: status clear");
}

// --- Scenario 5: rapid back-to-back turns don't accumulate state ----------
// Simulates: begin → populate → end → begin → populate → end, 5 times.
{
  const state = createEmptyWorkState();
  for (let i = 0; i < 5; i++) {
    // begin
    state.turnActive = true;
    state.isThinking = true;
    state.tools.push({ id: `t-${i}`, name: "x", status: "running" } as any);
    state.workflowStages.push({ name: `s-${i}`, status: "running" } as any);
    state.statusMessage = `turn ${i}`;
    state.currentIteration = i;

    // end
    state.turnActive = false;
    clearLiveWorkState(state);

    assert(state.tools.length === 0, `turn ${i}: tools clear`);
    assert(state.workflowStages.length === 0, `turn ${i}: stages clear`);
    assert(state.statusMessage === null, `turn ${i}: status clear`);
    assert(!state.isThinking, `turn ${i}: isThinking clear`);
    assert(state.currentIteration === undefined, `turn ${i}: iteration clear`);
  }
}

console.log("work-state cleanup verification passed");
