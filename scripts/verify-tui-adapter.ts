/**
 * Verifies the pi-tui chat renderer (TuiChatAdapter) end to end.
 *
 * Unlike the Ink tests, this needs no mocking tricks and no timing tolerance
 * for a React reconciler: components render to plain string arrays, so we
 * assert directly on the TUI's rendered lines — fully deterministic.
 */

import assert from "node:assert/strict";
import stripAnsiImport from "strip-ansi";
import type { Terminal } from "../src/ui/tui/terminal.js";
import { TuiChatAdapter } from "../src/ui/tui-adapter/TuiChatAdapter.js";

const stripAnsi = stripAnsiImport as unknown as (text: string) => string;

/** In-memory Terminal: captures writes, lets tests inject keystrokes. */
class FakeTerminal implements Terminal {
  written = "";
  private inputHandler: ((data: string) => void) | null = null;

  start(onInput: (data: string) => void, _onResize: () => void): void {
    this.inputHandler = onInput;
  }
  stop(): void {
    this.inputHandler = null;
  }
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.written += data;
  }
  get columns(): number {
    return 100;
  }
  get rows(): number {
    return 30;
  }
  get kittyProtocolActive(): boolean {
    return false;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  type(data: string): void {
    this.inputHandler?.(data);
  }
}

function makeAdapter(): { adapter: TuiChatAdapter; terminal: FakeTerminal } {
  const terminal = new FakeTerminal();
  const adapter = new TuiChatAdapter({
    provider: "test",
    model: "test-model",
    cwd: process.cwd(),
    terminal,
  });
  return { adapter, terminal };
}

/** Full rendered screen as plain text (the TUI is itself a Container). */
function renderedText(adapter: TuiChatAdapter): string {
  const ui = (adapter as unknown as { ui: { render(width: number): string[] } }).ui;
  return ui
    .render(100)
    .map((line) => stripAnsi(line))
    .join("\n");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Transcript basics ────────────────────────────────────────────────────────
{
  const { adapter } = makeAdapter();

  adapter.appendUserMessage("alpha-prompt-7c1f");
  let text = renderedText(adapter);
  assert.ok(text.includes("alpha-prompt-7c1f"), "user prompt renders");
  assert.ok(text.includes("You"), "user header renders");

  // Streamed assistant turn with markdown
  adapter.beginTurn();
  adapter.startAssistantMessage();
  adapter.appendAssistantChunk("first **bold** paragraph");
  adapter.appendAssistantChunk("\n\nsecond paragraph tail");
  adapter.finishAssistantMessage();
  adapter.settleAssistantMessage("first **bold** paragraph\n\nsecond paragraph tail");
  adapter.endTurn();

  text = renderedText(adapter);
  assert.ok(text.includes("first bold paragraph"), "markdown bold rendered without asterisks");
  assert.ok(text.includes("second paragraph tail"), "second paragraph rendered");
  assert.ok(text.includes("Meer"), "assistant header rendered");
  assert.equal(
    adapter.getLastAssistantContent(),
    "first **bold** paragraph\n\nsecond paragraph tail",
    "/copy returns the settled content"
  );

  // Second prompt — the regression that motivated this renderer
  adapter.appendUserMessage("delta-prompt-9d24");
  text = renderedText(adapter);
  assert.ok(text.includes("delta-prompt-9d24"), "second user prompt renders");
  const firstIdx = text.indexOf("alpha-prompt-7c1f");
  const replyIdx = text.indexOf("first bold paragraph");
  const secondIdx = text.indexOf("delta-prompt-9d24");
  assert.ok(firstIdx < replyIdx && replyIdx < secondIdx, "transcript order preserved");

  adapter.destroy();
}

// ── Tool lifecycle ───────────────────────────────────────────────────────────
{
  const { adapter } = makeAdapter();
  adapter.beginTurn();
  adapter.startAssistantMessage();
  adapter.appendAssistantChunk("Let me check the file.");
  adapter.finishAssistantMessage();

  const id = adapter.addTool("read_file", { path: "src/x.ts" }, "tc-1");
  assert.equal(id, "tc-1");
  adapter.startTool("tc-1");
  let text = renderedText(adapter);
  assert.ok(text.includes("read_file"), "running tool row renders");
  assert.ok(text.includes("src/x.ts"), "tool summary shows the path");

  adapter.completeTool("tc-1");
  adapter.startAssistantMessage();
  adapter.appendAssistantChunk("The file looks fine.");
  adapter.finishAssistantMessage();
  adapter.settleAssistantMessage("Let me check the file.\n\nThe file looks fine.");
  adapter.endTurn();

  text = renderedText(adapter);
  assert.ok(text.includes("✓ read_file"), "completed tool row keeps its durable mark");
  const intro = text.indexOf("Let me check the file.");
  const tool = text.indexOf("✓ read_file");
  const follow = text.indexOf("The file looks fine.");
  assert.ok(intro >= 0 && tool >= 0 && follow >= 0, "all pieces rendered");
  assert.ok(intro < tool && tool < follow, "text → tool row → text order holds");

  // Failure path
  adapter.beginTurn();
  adapter.addTool("edit_file", { path: "src/y.ts" }, "tc-2");
  adapter.startTool("tc-2");
  adapter.failTool("tc-2", "old_string not found in file");
  adapter.endTurn();
  text = renderedText(adapter);
  assert.ok(text.includes("✗ edit_file"), "failed tool row marked");
  assert.ok(text.includes("old_string not found"), "error preview rendered");

  adapter.destroy();
}

// ── Editor submit + optimistic echo ─────────────────────────────────────────
{
  const { adapter, terminal } = makeAdapter();
  const submissions: string[] = [];
  adapter.enableContinuousChat((text) => submissions.push(text));

  for (const ch of "hello meer") terminal.type(ch);
  terminal.type("\r");

  assert.deepEqual(submissions, ["hello meer"], "submit fires the continuous-chat callback");
  const text = renderedText(adapter);
  assert.ok(text.includes("hello meer"), "submitted prompt echoes into the transcript");

  // The agent confirms the message later — optimistic echo must not duplicate.
  adapter.appendUserMessage("hello meer", { consumeOptimistic: true });
  const occurrences = renderedText(adapter).split("hello meer").length - 1;
  assert.equal(occurrences, 1, "optimistic echo not duplicated on confirmation");

  adapter.destroy();
}

// ── Image attachments ride along with the next submit ───────────────────────
// Ctrl+V capture reads the real clipboard (untestable here), so we seed a
// pending attachment directly and verify the submit wiring + UI indicator.
{
  const { adapter, terminal } = makeAdapter();
  const calls: Array<{ text: string; attachments?: unknown[] }> = [];
  adapter.enableContinuousChat((text, attachments) => calls.push({ text, attachments }));

  const fakeAttachment = {
    kind: "image",
    mimeType: "image/png",
    source: { type: "path", path: "/tmp/shot.png" },
    name: "shot.png",
  };
  (adapter as unknown as { pendingAttachments: unknown[] }).pendingAttachments.push(fakeAttachment);

  for (const ch of "look at this") terminal.type(ch);
  terminal.type("\r");

  assert.equal(calls.length, 1, "submit fired once");
  assert.ok(calls[0].attachments?.length === 1, "pending attachment passed to onSubmit");
  assert.ok(renderedText(adapter).includes("📎"), "attachment indicator shown in transcript");

  // Pending list is cleared after the turn so it doesn't leak into the next.
  assert.equal(
    (adapter as unknown as { pendingAttachments: unknown[] }).pendingAttachments.length,
    0,
    "pending attachments reset after submit"
  );

  // Attachment-only submit (no text) is allowed.
  (adapter as unknown as { pendingAttachments: unknown[] }).pendingAttachments.push(fakeAttachment);
  terminal.type("\r");
  assert.equal(calls.length, 2, "image-only submit fires without text");
  assert.equal(calls[1].text.trim(), "", "image-only submit carries empty text");
  assert.ok(calls[1].attachments?.length === 1, "image-only submit carries the attachment");

  adapter.destroy();
}

// ── Interrupt via Esc ────────────────────────────────────────────────────────
{
  const { adapter, terminal } = makeAdapter();
  let interrupted = 0;
  adapter.setInterruptHandler(() => interrupted++);
  adapter.beginTurn();
  terminal.type("\x1b");
  assert.equal(interrupted, 1, "Esc during a turn calls the interrupt handler");
  adapter.endTurn();
  adapter.destroy();
}

// ── Ctrl+C works in both raw and Kitty CSI-u form ───────────────────────────
// With the Kitty disambiguate flag active, Ctrl+C arrives as "\x1b[99;5u", not
// the raw "\x03" byte — the handler must match via matchesKey, not byte compare.
{
  for (const ctrlC of ["\x03", "\x1b[99;5u"]) {
    const { adapter, terminal } = makeAdapter();
    let interrupted = 0;
    adapter.setInterruptHandler(() => interrupted++);
    adapter.beginTurn();
    terminal.type(ctrlC);
    assert.equal(interrupted, 1, `Ctrl+C (${JSON.stringify(ctrlC)}) interrupts the active turn`);
    adapter.endTurn();
    adapter.destroy();
  }
}

// ── Choice prompt ────────────────────────────────────────────────────────────
{
  const { adapter, terminal } = makeAdapter();
  const pending = adapter.promptChoice(
    "Apply this edit?",
    [
      { label: "Yes", value: "yes" },
      { label: "No", value: "no" },
    ],
    "no"
  );
  let text = renderedText(adapter);
  assert.ok(text.includes("Apply this edit?"), "choice prompt renders");
  terminal.type("\x1b[B"); // down to "No"
  terminal.type("\r");
  const answer = await pending;
  assert.equal(answer, "no", "arrow + enter selects the choice");
  assert.ok(!renderedText(adapter).includes("Apply this edit?"), "prompt removed after answer");

  // Esc resolves the default
  const pending2 = adapter.promptChoice(
    "Continue?",
    [
      { label: "Yes", value: "yes" },
      { label: "No", value: "no" },
    ],
    "yes"
  );
  terminal.type("\x1b");
  assert.equal(await pending2, "yes", "Esc resolves the default choice");

  adapter.destroy();
}

// ── Key-repeat does not double-move the selection ───────────────────────────
// A single arrow tap on Windows Terminal/ConPTY can emit a press AND an
// immediate Kitty key-repeat (CSI ":2"); the repeat must not move again.
{
  const { adapter, terminal } = makeAdapter();
  const pending = adapter.promptChoice(
    "Pick one",
    [
      { label: "Alpha", value: "a" },
      { label: "Bravo", value: "b" },
      { label: "Charlie", value: "c" },
    ],
    "a"
  );
  terminal.type("\x1b[B"); // press: Alpha -> Bravo
  terminal.type("\x1b[1;1:2B"); // Kitty repeat of Down — must be ignored
  terminal.type("\r");
  assert.equal(await pending, "b", "a Down press + its repeat lands on the next item, not two down");
  adapter.destroy();
}

// ── Non-streamed settle ─────────────────────────────────────────────────────
{
  const { adapter } = makeAdapter();
  adapter.beginTurn();
  adapter.settleAssistantMessage("completely settled, never streamed");
  adapter.endTurn();
  assert.ok(
    renderedText(adapter).includes("completely settled, never streamed"),
    "settled-only content renders"
  );
  adapter.destroy();
}

// ── Transcript replay ────────────────────────────────────────────────────────
{
  const { adapter } = makeAdapter();
  adapter.replayTranscript([
    { role: "user", content: "restored question" },
    { role: "assistant", content: "restored answer" },
    { role: "tool", content: "result", metadata: { toolName: "read_file" } },
    { role: "system", content: "session restored" },
  ]);
  const text = renderedText(adapter);
  for (const expected of ["restored question", "restored answer", "read_file", "session restored"]) {
    assert.ok(text.includes(expected), `replayed entry renders: ${expected}`);
  }
  adapter.destroy();
}

// ── Console capture ──────────────────────────────────────────────────────────
{
  const { adapter } = makeAdapter();
  console.log("stray console noise %d", 42);
  const text = renderedText(adapter);
  assert.ok(text.includes("stray console noise 42"), "console output routed into transcript");
  adapter.destroy();
  // After destroy the console must be restored (this log goes to real stdout).
  console.log("");
}

// ── Inline prompt strips markdown ─────────────────────────────────────────────
{
  const { adapter } = makeAdapter();
  // Callers pass light markdown; the inline prompt must render it as plain text.
  void adapter.promptChoice(
    "**Trust this project folder?**\n`/Users/moe/widget`",
    [
      { label: "Trust", value: "trust" },
      { label: "Don't trust", value: "no" },
    ],
    "trust"
  );
  const text = renderedText(adapter);
  assert.ok(text.includes("Trust this project folder?"), "prompt message text renders");
  assert.ok(text.includes("/Users/moe/widget"), "prompt path renders");
  assert.ok(!text.includes("**"), "no raw bold markers in prompt");
  assert.ok(!text.includes("`"), "no raw backticks in prompt");
  adapter.destroy();
}

// ── Secret prompt masks input and keeps it out of the transcript ──────────────
{
  const { adapter, terminal } = makeAdapter();
  const secretValue = "sk-live-SECRET-7f3a";
  const pending = adapter.promptSecret();
  terminal.type(secretValue);
  let text = renderedText(adapter);
  assert.ok(!text.includes(secretValue), "secret value is not shown in plain text");
  assert.ok(text.includes("•"), "secret characters are masked");

  // Submit (Enter) resolves with the real value, but nothing leaks to the screen.
  terminal.type("\r");
  const resolved = await pending;
  assert.equal(resolved, secretValue, "promptSecret resolves with the real value");
  text = renderedText(adapter);
  assert.ok(!text.includes(secretValue), "secret never appears after submit");
  adapter.destroy();
}

// Allow any stray loader/ticker callbacks to settle, then confirm clean exit.
await sleep(50);
console.log("tui-adapter verification passed");
