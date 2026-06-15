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

// ── Plan panel renders tasks + live status updates ───────────────────────────
{
  const { adapter } = makeAdapter();
  const now = Date.now();
  adapter.setPlan({
    title: "Build calling agent",
    createdAt: now,
    updatedAt: now,
    tasks: [
      { id: "1", description: "scaffold project", status: "completed" },
      { id: "2", description: "wire telephony", status: "in_progress" },
      { id: "3", description: "add STT/TTS", status: "pending" },
      { id: "4", description: "drop legacy demo", status: "skipped" },
    ],
  });
  let text = renderedText(adapter);
  assert.ok(text.includes("Build calling agent"), "plan title renders");
  assert.ok(text.includes("(1/4)"), "completed/total counter renders");
  for (const desc of ["scaffold project", "wire telephony", "add STT/TTS", "drop legacy demo"]) {
    assert.ok(text.includes(desc), `task renders: ${desc}`);
  }
  assert.ok(text.includes("✓") && text.includes("◐") && text.includes("○") && text.includes("⊘"), "all status glyphs render");

  // A status update must re-render the panel (the bug: it never updated).
  adapter.setPlan({
    title: "Build calling agent",
    createdAt: now,
    updatedAt: now + 1,
    tasks: [
      { id: "1", description: "scaffold project", status: "completed" },
      { id: "2", description: "wire telephony", status: "completed" },
      { id: "3", description: "add STT/TTS", status: "in_progress" },
    ],
  });
  text = renderedText(adapter);
  assert.ok(text.includes("(2/3)"), "counter updates after task completion");

  // Clearing the plan empties the panel.
  adapter.setPlan(null);
  text = renderedText(adapter);
  assert.ok(!text.includes("Build calling agent"), "cleared plan removes the panel");
  adapter.destroy();
}

// ── A completed plan stops sticking once the user moves on ────────────────────
{
  const { adapter } = makeAdapter();
  const now = Date.now();
  const completedPlan = {
    title: "Ship feature",
    createdAt: now,
    updatedAt: now,
    tasks: [
      { id: "1", description: "write code", status: "completed" as const },
      { id: "2", description: "ship it", status: "completed" as const },
    ],
  };
  adapter.setPlan(completedPlan);
  let text = renderedText(adapter);
  assert.ok(text.includes("Ship feature"), "completed plan still visible right after finishing");

  // Next user turn → the finished plan is dismissed from the sticky panel.
  adapter.beginTurn();
  text = renderedText(adapter);
  assert.ok(!text.includes("Ship feature"), "completed plan dismissed on next turn");
  adapter.endTurn();

  // An UNFINISHED plan must persist across turns.
  adapter.setPlan({
    title: "Long task",
    createdAt: now,
    updatedAt: now,
    tasks: [
      { id: "1", description: "step one", status: "completed" as const },
      { id: "2", description: "step two", status: "in_progress" as const },
    ],
  });
  adapter.beginTurn();
  text = renderedText(adapter);
  assert.ok(text.includes("Long task"), "in-progress plan survives a new turn");
  adapter.destroy();
}

// ── Tool output renders (live progress + final result) ───────────────────────
{
  const { adapter } = makeAdapter();
  adapter.addTool("run_command", { command: "npm test" }, "tc-out");
  adapter.startTool("tc-out");

  // Live partial output appears while running.
  adapter.updateToolProgress("tc-out", "compiling…");
  let text = renderedText(adapter);
  assert.ok(text.includes("compiling…"), "live tool output renders");

  // Final result replaces it.
  adapter.appendToolMessage("run_command", "PASS 12 passed\nDone in 2.0s", false, { toolCallId: "tc-out" });
  adapter.completeTool("tc-out", "ok");
  text = renderedText(adapter);
  assert.ok(text.includes("PASS 12 passed"), "final tool output renders");
  assert.ok(!text.includes("compiling…"), "stale partial output cleared");

  // An edit shows a diff, not raw output text.
  adapter.addTool("edit_file", { path: "src/x.ts" }, "tc-edit");
  adapter.completeTool("tc-edit", "ok", { path: "src/x.ts", diff: "@@ -1,1 +1,1 @@\n-a\n+b" });
  adapter.appendToolMessage("edit_file", "Successfully updated src/x.ts", false, { toolCallId: "tc-edit" });
  text = renderedText(adapter);
  assert.ok(!text.includes("Successfully updated"), "edit result text is not shown (diff is)");
  adapter.destroy();
}

// ── Footer shows estimated context tokens ────────────────────────────────────
{
  const { adapter } = makeAdapter();
  adapter.updateTokens(12400, 200000, true);
  let text = renderedText(adapter);
  assert.ok(/~12\.4k\/200\.0k ctx/.test(text), `footer shows ~ctx estimate (got: ${text.split("\n").find((l) => l.includes("ctx")) ?? "no ctx line"})`);

  // Real billed usage renders without the ~ and as "tok", plus cost.
  adapter.updateTokens(12400, 200000, false);
  adapter.updateCost(0.0089);
  text = renderedText(adapter);
  assert.ok(/12\.4k\/200\.0k tok/.test(text) && !text.includes("~12.4k"), "real usage shows 'tok' without ~");
  assert.ok(text.includes("$0.0089"), "footer shows real cost");
  adapter.destroy();
}

// ── Streaming tool args show the call building live ──────────────────────────
{
  const { adapter } = makeAdapter();
  adapter.previewToolCall("tc-stream", "run_command", '{"command":"npm ru');
  let text = renderedText(adapter);
  assert.ok(text.includes("npm ru…"), "partial streamed command shows with ellipsis");
  adapter.previewToolCall("tc-stream", "run_command", 'n build"}');
  // Once finalized args arrive (tool start), the real summary takes over.
  adapter.addTool("run_command", { command: "npm run build" }, "tc-stream");
  adapter.startTool("tc-stream");
  text = renderedText(adapter);
  assert.ok(text.includes("$ npm run build"), "finalized command summary replaces the partial");
  adapter.destroy();
}

// ── Chain-of-thought is capped ───────────────────────────────────────────────
{
  const { adapter } = makeAdapter();
  const reasoning = Array.from({ length: 20 }, (_, i) => `reasoning line ${i + 1}`).join("\n");
  adapter.addCotMessage(reasoning);
  const text = renderedText(adapter);
  assert.ok(text.includes("reasoning line 1"), "first reasoning line shown");
  assert.ok(!text.includes("reasoning line 12"), "later reasoning lines collapsed");
  assert.ok(/\+\d+ more lines of reasoning/.test(text), "shows collapsed-reasoning footer");
  adapter.destroy();
}

// ── Truncated command output shows a 'full output' hint ──────────────────────
{
  const { adapter } = makeAdapter();
  adapter.addTool("run_command", { command: "npm test" }, "tc-trunc");
  adapter.completeTool("tc-trunc", "ok");
  adapter.appendToolMessage("run_command", "line a\nline b", false, {
    toolCallId: "tc-trunc",
    details: { truncation: { truncated: true, totalLines: 5000, fullOutputPath: "/tmp/meer-cmd-x.log" } },
  });
  const text = renderedText(adapter);
  assert.ok(text.includes("/tmp/meer-cmd-x.log"), "full-output path surfaced");
  assert.ok(text.includes("5000 lines"), "total line count surfaced");
  adapter.destroy();
}

// Allow any stray loader/ticker callbacks to settle, then confirm clean exit.
await sleep(50);
console.log("tui-adapter verification passed");
