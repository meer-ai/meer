/**
 * Locks down /copy's two primitives:
 *
 *  - getLastAssistantContent finds the most recent settled assistant
 *    message (ignoring CoT/internal messages and the live draft).
 *  - writeClipboardText never throws on any input — it returns false
 *    when the clipboard helper isn't available, so the caller can fall
 *    back to "the text is here, copy it yourself" UX.
 */

// Silence Ink's non-TTY warnings so the test output stays clean.
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
import { writeClipboardText } from "../src/utils/clipboard-write.js";

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
  (adapter as unknown as { instance: { unmount: () => void; rerender: () => void } }).instance = {
    unmount: () => {},
    rerender: () => {},
  };
  return adapter;
}

// --- Empty session: no assistant message ----------------------------------
{
  const adapter = makeAdapter();
  assert(adapter.getLastAssistantContent() === null, "empty session returns null");
  adapter.destroy();
}

// --- User-only session: no assistant message ------------------------------
{
  const adapter = makeAdapter();
  adapter.appendUserMessage("hello");
  adapter.appendUserMessage("are you there?");
  assert(
    adapter.getLastAssistantContent() === null,
    "user-only messages don't count"
  );
  adapter.destroy();
}

// --- Single assistant message ---------------------------------------------
{
  const adapter = makeAdapter();
  adapter.appendUserMessage("ping");
  adapter.beginTurn();
  adapter.startAssistantMessage();
  adapter.settleAssistantMessage("pong");
  adapter.endTurn();
  assert(
    adapter.getLastAssistantContent() === "pong",
    `latest assistant returned (got "${adapter.getLastAssistantContent()}")`
  );
  adapter.destroy();
}

// --- Multiple turns: returns the MOST RECENT settled assistant ------------
{
  const adapter = makeAdapter();
  for (let i = 0; i < 5; i++) {
    adapter.appendUserMessage(`q ${i}`);
    adapter.beginTurn();
    adapter.startAssistantMessage();
    adapter.settleAssistantMessage(`answer ${i}`);
    adapter.endTurn();
  }
  assert(
    adapter.getLastAssistantContent() === "answer 4",
    `latest assistant from 5 turns (got "${adapter.getLastAssistantContent()}")`
  );
  adapter.destroy();
}

// --- Trailing user message: previous assistant still wins -----------------
{
  const adapter = makeAdapter();
  adapter.appendUserMessage("hi");
  adapter.beginTurn();
  adapter.startAssistantMessage();
  adapter.settleAssistantMessage("the answer");
  adapter.endTurn();
  adapter.appendUserMessage("follow-up");
  assert(
    adapter.getLastAssistantContent() === "the answer",
    "trailing user message doesn't displace the last assistant"
  );
  adapter.destroy();
}

// --- Empty assistant content is skipped -----------------------------------
{
  const adapter = makeAdapter();
  adapter.beginTurn();
  adapter.startAssistantMessage();
  adapter.settleAssistantMessage("real answer");
  adapter.endTurn();
  adapter.beginTurn();
  adapter.startAssistantMessage();
  // No settle — the empty draft is never pushed to messages, so the
  // previous real answer is what /copy should grab.
  adapter.endTurn();
  assert(
    adapter.getLastAssistantContent() === "real answer",
    "empty assistant draft doesn't displace the prior real message"
  );
  adapter.destroy();
}

// --- writeClipboardText: never throws -------------------------------------
{
  // Should not throw on any of these — returns true/false depending on
  // whether the platform helper is available. We don't assert success
  // because CI environments often lack pbcopy/xclip/clip.
  for (const text of ["", "hello", "x".repeat(1000)]) {
    const ok = writeClipboardText(text);
    assert(typeof ok === "boolean", "always returns boolean");
  }
  // Oversized payload: returns false without throwing.
  const huge = "x".repeat(6 * 1024 * 1024);
  const ok = writeClipboardText(huge);
  assert(ok === false, "oversized payload rejected gracefully");
}

console.error = _origConsoleError;
console.log("copy-last-assistant verification passed");
