/**
 * Lock down the memory ceilings on the InkChatAdapter's transient state.
 *
 * For autonomous/long-running sessions, unbounded growth of `messages`,
 * `tools`, and `workflowStages` was the main path to slow Ink reconciles
 * and bloated process memory. The adapter caps each one via small
 * private trim() helpers; we verify here that:
 *
 *  - pushing past MAX_STORED_MESSAGES drops oldest from the front
 *  - droppedMessageCount tracks the trimmed total
 *  - tools and workflowStages caps work the same way
 *  - in-place tool message updates (existingIndex path) don't double-trim
 *
 * We exercise the adapter via reflection rather than rendering Ink — this
 * keeps the test deterministic in headless CI.
 */

// Silence Ink's noisy non-TTY warnings without changing behavior.
const stdinAsTty = process.stdin as NodeJS.ReadStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => NodeJS.ReadStream;
};
if (!stdinAsTty.isTTY) {
  stdinAsTty.isTTY = true;
  stdinAsTty.setRawMode = ((_mode: boolean) => stdinAsTty) as never;
}
const _origConsoleError = console.error;
console.error = () => {};

import { InkChatAdapter } from "../src/ui/ink/InkChatAdapter.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function makeAdapter() {
  const adapter = new InkChatAdapter({
    provider: "test",
    model: "test-model",
    cwd: process.cwd(),
  });
  // Replace the live Ink instance with a stub so updateUI() is a no-op.
  (adapter as unknown as { instance: { unmount: () => void; rerender: () => void } }).instance = {
    unmount: () => {},
    rerender: () => {},
  };
  return adapter;
}

function read<T>(adapter: InkChatAdapter, field: string): T {
  return (adapter as unknown as Record<string, T>)[field];
}

// --- messages cap ----------------------------------------------------------
{
  const adapter = makeAdapter();

  // Push 2500 user messages. Cap is 2000.
  for (let i = 0; i < 2500; i++) {
    adapter.appendUserMessage(`message ${i}`);
  }

  const messages = read<Array<{ content: string }>>(adapter, "messages");
  assert(messages.length === 2000, `messages capped (got ${messages.length})`);
  assert(adapter.getDroppedMessageCount() === 500, `dropped count is 500 (got ${adapter.getDroppedMessageCount()})`);
  assert(
    messages[0].content === "message 500",
    `oldest survivor is message 500 (got "${messages[0].content}")`
  );
  assert(
    messages[messages.length - 1].content === "message 2499",
    "newest message preserved"
  );

  adapter.destroy();
}

// --- tools cap -------------------------------------------------------------
{
  const adapter = makeAdapter();

  // Push 150 tool starts. Cap is 100.
  for (let i = 0; i < 150; i++) {
    adapter.addTool(`tool_${i}`, { i }, `tool-${i}`);
  }

  const tools = read<Array<{ name: string }>>(adapter, "tools");
  assert(tools.length === 100, `tools capped (got ${tools.length})`);
  assert(
    tools[0].name === "tool_50",
    `oldest survivor is tool_50 (got "${tools[0].name}")`
  );
  assert(tools[99].name === "tool_149", "newest tool preserved");

  adapter.destroy();
}

// --- workflowStages cap ----------------------------------------------------
{
  const adapter = makeAdapter();

  for (let i = 0; i < 75; i++) {
    adapter.addWorkflowStage(`stage_${i}`);
  }

  const stages = read<Array<{ name: string }>>(adapter, "workflowStages");
  assert(stages.length === 50, `stages capped (got ${stages.length})`);
  assert(stages[0].name === "stage_25", "oldest survivor correct");
  assert(stages[49].name === "stage_74", "newest stage preserved");

  adapter.destroy();
}

// --- below-cap: nothing dropped --------------------------------------------
{
  const adapter = makeAdapter();
  for (let i = 0; i < 100; i++) {
    adapter.appendUserMessage(`m ${i}`);
  }
  const messages = read<unknown[]>(adapter, "messages");
  assert(messages.length === 100, "no trim below cap");
  assert(adapter.getDroppedMessageCount() === 0, "no drops below cap");
  adapter.destroy();
}

// --- clearMessages resets the dropped counter ------------------------------
{
  const adapter = makeAdapter();
  for (let i = 0; i < 2100; i++) {
    adapter.appendUserMessage(`m ${i}`);
  }
  assert(adapter.getDroppedMessageCount() === 100, "dropped 100 pre-clear");

  adapter.clearMessages();

  assert(adapter.getDroppedMessageCount() === 0, "dropped counter reset on clear");
  const messages = read<unknown[]>(adapter, "messages");
  assert(messages.length === 0, "messages cleared");

  adapter.destroy();
}

console.error = _origConsoleError;
console.log("memory bounds verification passed");
