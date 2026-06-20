/**
 * Verifies the pi-tui chat renderer (TuiChatAdapter) end to end.
 *
 * Unlike the Ink tests, this needs no mocking tricks and no timing tolerance
 * for a React reconciler: components render to plain string arrays, so we
 * assert directly on the TUI's rendered lines — fully deterministic.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import stripAnsiImport from "strip-ansi";
import type { Terminal } from "../src/ui/tui/terminal.js";
import { TuiChatAdapter } from "../src/ui/tui-adapter/TuiChatAdapter.js";
import { DEFAULT_UI_SETTINGS, type UISettingsInput } from "../src/ui/ui-settings.js";

const stripAnsi = stripAnsiImport as unknown as (text: string) => string;

/** In-memory Terminal: captures writes, lets tests inject keystrokes. */
class FakeTerminal implements Terminal {
  written = "";
  private inputHandler: ((data: string) => void) | null = null;
  private resizeHandler: (() => void) | null = null;
  startCount = 0;
  stopCount = 0;
  drainCount = 0;
  hideCursorCount = 0;
  showCursorCount = 0;
  progressStates: boolean[] = [];

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.startCount++;
    this.inputHandler = onInput;
    this.resizeHandler = onResize;
  }
  stop(): void {
    this.stopCount++;
    this.inputHandler = null;
    this.resizeHandler = null;
  }
  async drainInput(): Promise<void> {
    this.drainCount++;
  }
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
  hideCursor(): void {
    this.hideCursorCount++;
  }
  showCursor(): void {
    this.showCursorCount++;
  }
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(active: boolean): void {
    this.progressStates.push(active);
  }

  type(data: string): void {
    this.inputHandler?.(data);
  }

  resize(): void {
    this.resizeHandler?.();
  }

  get acceptingInput(): boolean {
    return this.inputHandler !== null;
  }
}

function makeAdapter(options?: { ui?: UISettingsInput }): { adapter: TuiChatAdapter; terminal: FakeTerminal } {
  const terminal = new FakeTerminal();
  const adapter = new TuiChatAdapter({
    provider: "test",
    model: "test-model",
    cwd: process.cwd(),
    ui: options?.ui ? { ...DEFAULT_UI_SETTINGS, ...options.ui } : undefined,
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

async function renderedScreenText(adapter: TuiChatAdapter): Promise<string> {
  const ui = (adapter as unknown as { ui: { requestRender(force?: boolean): void; previousLines: string[] } }).ui;
  ui.requestRender(true);
  await sleep(0);
  return ui.previousLines.map((line) => stripAnsi(line)).join("\n");
}

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

// ── Long transcript is viewported, with hidden-history marker ────────────────
{
  const { adapter, terminal } = makeAdapter();
  for (let i = 0; i < 40; i++) {
    adapter.appendSystemMessage(`viewport-marker-${i}`);
  }
  let text = renderedText(adapter);
  assert.ok(text.includes("earlier transcript lines"), "viewport shows hidden-history marker");
  assert.ok(!text.includes("viewport-marker-0"), "old transcript head is hidden from active viewport");
  assert.ok(text.includes("viewport-marker-39"), "latest transcript tail remains visible");
  assert.ok(text.includes("test/test-model"), "status header remains visible with long transcript");

  terminal.type("\x1b[5;2~"); // Shift+PageUp
  text = renderedText(adapter);
  assert.ok(text.includes("viewport-marker-0"), "Shift+PageUp scrolls to older transcript rows");
  assert.ok(text.includes("newer transcript lines"), "scrolled transcript shows hidden-newer marker");
  assert.ok(text.includes("scroll:"), "footer shows transcript scroll offset");

  terminal.type("\x1b[1;2F"); // Shift+End
  text = renderedText(adapter);
  assert.ok(text.includes("viewport-marker-39"), "Shift+End returns to latest transcript rows");
  assert.ok(!text.includes("newer transcript lines"), "latest transcript has no hidden-newer marker");

  terminal.type("\x1b[5;2~"); // Shift+PageUp
  adapter.appendUserMessage("viewport-user-reset");
  text = renderedText(adapter);
  assert.ok(text.includes("viewport-user-reset"), "new user message resets transcript to latest");
  assert.ok(!text.includes("newer transcript lines"), "new user message clears scrolled-back state");
  adapter.destroy();
}

// ── Turn summary records duration, tool count, and token delta ───────────────
{
  const { adapter } = makeAdapter();
  adapter.updateTokens(1000, 200000, false);
  adapter.beginTurn();
  adapter.addTool("read_file", { path: "src/x.ts" }, "tc-turn-summary");
  adapter.completeTool("tc-turn-summary", "ok");
  adapter.updateTokens(1600, 200000, false);
  await sleep(5);
  adapter.endTurn();
  const text = renderedText(adapter);
  assert.ok(/Turn · \d+ms · 1 tool · \+600 tok/.test(text), "turn summary shows duration, tool count, and token delta");
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

// ── Shortcuts overlay lists active keys and closes predictably ───────────────
{
  const { adapter, terminal } = makeAdapter();
  terminal.type("?");
  let text = await renderedScreenText(adapter);
  assert.ok(text.includes("Shortcuts"), "? opens shortcuts overlay");
  assert.ok(text.includes("Ctrl+C"), "overlay lists global shortcuts");
  assert.ok(text.includes("Shift+Enter"), "overlay lists composer keybindings");
  assert.ok(text.includes("/tool"), "overlay lists tool detail slash command");

  terminal.type("?");
  text = await renderedScreenText(adapter);
  assert.ok(!text.includes("Shortcuts"), "? toggles shortcuts overlay closed");

  let interrupted = 0;
  adapter.setInterruptHandler(() => interrupted++);
  adapter.beginTurn();
  terminal.type("?");
  terminal.type("\x1b");
  text = await renderedScreenText(adapter);
  assert.ok(!text.includes("Shortcuts"), "Esc closes shortcuts overlay");
  assert.equal(interrupted, 0, "Esc closes shortcuts overlay before interrupting active turn");

  terminal.type("\x1b");
  assert.equal(interrupted, 1, "Esc still interrupts after overlay is closed");
  adapter.endTurn();
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

// ── Terminal lifecycle: release/resume/destroy cleanup ──────────────────────
{
  const originalLog = console.log;
  const resizeListenersBefore = process.stdout.listenerCount("resize");
  const { adapter, terminal } = makeAdapter();
  let submissions = 0;
  adapter.enableContinuousChat(() => submissions++);

  assert.equal(terminal.startCount, 1, "constructor starts the terminal once");
  assert.equal(terminal.stopCount, 0, "terminal is not stopped initially");
  assert.equal(terminal.acceptingInput, true, "terminal accepts input after start");
  assert.equal(
    process.stdout.listenerCount("resize"),
    resizeListenersBefore + 1,
    "adapter installs one resize listener"
  );
  assert.notEqual(console.log, originalLog, "console is captured while TUI owns terminal");

  const value = await adapter.runWithTerminal(async () => {
    assert.equal(console.log, originalLog, "console restored while terminal is released");
    assert.equal(terminal.stopCount, 1, "runWithTerminal stops the TUI");
    assert.equal(terminal.acceptingInput, false, "released terminal ignores TUI input");
    terminal.type("ignored while stopped\r");
    assert.equal(submissions, 0, "input while released is not submitted");
    return "released-ok";
  });
  assert.equal(value, "released-ok", "runWithTerminal returns task result");
  assert.equal(terminal.startCount, 2, "runWithTerminal restarts the TUI after success");
  assert.equal(terminal.acceptingInput, true, "terminal accepts input after resume");
  assert.notEqual(console.log, originalLog, "console recaptured after resume");

  await assert.rejects(
    adapter.runWithTerminal(async () => {
      assert.equal(console.log, originalLog, "console restored during failing released task");
      throw new Error("released-boom");
    }),
    /released-boom/,
    "runWithTerminal propagates task errors"
  );
  assert.equal(terminal.startCount, 3, "runWithTerminal restarts the TUI after failure");
  assert.equal(terminal.stopCount, 2, "failing runWithTerminal still stopped once");

  terminal.resize();
  adapter.destroy();
  assert.equal(terminal.stopCount, 3, "destroy stops the terminal once");
  assert.equal(terminal.acceptingInput, false, "destroyed terminal ignores input");
  assert.equal(console.log, originalLog, "destroy restores console");
  assert.equal(
    process.stdout.listenerCount("resize"),
    resizeListenersBefore,
    "destroy removes adapter resize listener"
  );
  assert.equal(terminal.hideCursorCount, terminal.startCount, "cursor hidden on every start");
  assert.equal(terminal.showCursorCount, terminal.stopCount, "cursor shown on every stop");

  adapter.destroy();
  assert.equal(terminal.stopCount, 3, "destroy is idempotent");
  terminal.type("ignored after destroy\r");
  assert.equal(submissions, 0, "input after destroy is ignored");
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
  const { adapter } = makeAdapter({ ui: { toolDisplay: "expanded" } });
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

// ── Compact tool display suppresses noisy previews by default ────────────────
{
  const { adapter } = makeAdapter();
  adapter.addTool("run_command", { command: "npm test" }, "tc-compact");
  adapter.startTool("tc-compact");
  adapter.updateToolProgress("tc-compact", "compiling…\nPASS 12 passed");
  adapter.completeTool("tc-compact", "ok");
  let text = renderedText(adapter);
  assert.ok(text.includes("run_command") && text.includes("$ npm test"), "compact row keeps command summary");
  assert.ok(!text.includes("compiling…"), "compact mode hides command output preview");

  adapter.setToolDisplayMode("expanded");
  adapter.addTool("run_command", { command: "npm run build" }, "tc-expanded");
  adapter.startTool("tc-expanded");
  adapter.updateToolProgress("tc-expanded", "building…");
  adapter.completeTool("tc-expanded", "ok");
  text = renderedText(adapter);
  assert.ok(text.includes("tools:expanded"), "expanded mode appears in footer");
  assert.ok(text.includes("building…"), "expanded mode shows command output preview");
  adapter.destroy();
}

// ── Tool detail panel expands on demand outside transcript ──────────────────
{
  const { adapter, terminal } = makeAdapter({
    ui: {
      toolOutput: {
        ...DEFAULT_UI_SETTINGS.toolOutput,
        maxPreviewLines: 1,
        maxPreviewLineWidth: 18,
        maxDetailLines: 1,
      },
    },
  });
  adapter.addTool("run_command", { command: "pnpm test" }, "tc-detail");
  adapter.startTool("tc-detail");
  adapter.updateToolProgress("tc-detail", "detail-output-line-1-is-long\ndetail-output-line-2");
  adapter.completeTool("tc-detail", "ok");
  let text = renderedText(adapter);
  assert.ok(!text.includes("detail-output-line-1"), "compact transcript hides output preview");

  assert.equal(adapter.showToolDetail("tc-detail"), true, "tool detail can be shown by id");
  text = renderedText(adapter);
  assert.ok(text.includes("Tool detail: run_command"), "tool detail panel renders");
  assert.ok(text.includes("detail-output-lin…"), "tool detail panel applies configured line width");
  assert.ok(text.includes("1 more line"), "tool detail panel applies configured line count");
  assert.ok(!text.includes("detail-output-line-2"), "tool detail panel hides lines beyond configured detail budget");
  assert.ok(text.includes("Esc or /tool hide"), "tool detail panel explains dismissal");

  terminal.type("\x1b");
  text = renderedText(adapter);
  assert.ok(!text.includes("Tool detail: run_command"), "Esc hides tool detail panel");
  adapter.destroy();
}

// ── Tool detail preserves structured media/artifact metadata ────────────────
{
  const { adapter } = makeAdapter({
    ui: {
      toolOutput: {
        ...DEFAULT_UI_SETTINGS.toolOutput,
        maxPreviewLines: 1,
        maxPreviewLineWidth: 80,
        maxDetailLines: 6,
      },
    },
  });
  adapter.addTool("generate_image", { prompt: "terminal lifecycle diagram" }, "tc-media");
  adapter.startTool("tc-media");
  adapter.appendToolMessage("generate_image", "render complete", false, {
    toolCallId: "tc-media",
    details: { seed: 42 },
  });
  adapter.completeTool("tc-media", "ok", {
    artifacts: [{ type: "image", mimeType: "image/png", path: "artifacts/tui-lifecycle.png" }],
    metadata: { width: 1024, height: 768 },
  });

  let text = renderedText(adapter);
  assert.ok(!text.includes("artifacts/tui-lifecycle.png"), "compact transcript hides artifact details");

  assert.equal(adapter.showToolDetail("tc-media"), true, "tool detail opens for structured tool");
  text = renderedText(adapter);
  assert.ok(text.includes("render complete"), "detail panel keeps textual output");
  assert.ok(text.includes("artifacts/tui-lifecycle.png"), "detail panel keeps artifact path");
  assert.ok(text.includes("image/png"), "detail panel keeps media type");
  assert.ok(text.includes("seed: 42"), "detail panel merges streamed metadata");
  assert.ok(text.includes('"width":1024'), "detail panel keeps structured metadata");
  adapter.destroy();
}

// ── Footer shows estimated context tokens ────────────────────────────────────
{
  const { adapter } = makeAdapter();
  adapter.updateTokens(12400, 200000, true);
  let text = renderedText(adapter);
  assert.ok(text.includes("test/test-model"), "status header shows provider/model");
  assert.ok(text.includes(process.cwd()), "status header shows cwd");
  assert.ok(/~12\.4k\/200\.0k ctx/.test(text), `footer shows ~ctx estimate (got: ${text.split("\n").find((l) => l.includes("ctx")) ?? "no ctx line"})`);

  // Real billed usage renders without the ~ and as "tok", plus cost.
  adapter.updateTokens(12400, 200000, false);
  adapter.updateCost(0.0089);
  text = renderedText(adapter);
  assert.ok(/12\.4k\/200\.0k tok/.test(text) && !text.includes("~12.4k"), "real usage shows 'tok' without ~");
  assert.ok(text.includes("$0.0089"), "footer shows real cost");
  adapter.destroy();
}

// ── Renderer mode hooks update footer + local timeline ──────────────────────
{
  const { adapter } = makeAdapter();
  adapter.setScreenReaderMode("on");
  adapter.setAlternateBufferMode("on");
  let text = renderedText(adapter);
  assert.ok(text.includes("sr:on"), "screen-reader mode appears in footer");
  assert.ok(text.includes("alt:on"), "alternate-buffer preference appears in footer");

  adapter.setAlternateBufferMode("auto");
  text = renderedText(adapter);
  assert.ok(!text.includes("alt:on"), "auto resets alternate-buffer preference to config default");

  const toolId = adapter.addTool("run_command", { command: "npm test" }, "timeline-tool");
  adapter.startTool(toolId);
  adapter.completeTool(toolId, "ok");

  const events = adapter.getTimelineEvents();
  assert.ok(events.some((event) => event.type === "log" && event.message.includes("Screen reader mode set to on")), "screen-reader hook records timeline event");
  assert.ok(events.some((event) => event.type === "task" && event.label === "Tool run_command" && event.status === "started"), "tool start recorded in local timeline");
  assert.ok(events.some((event) => event.type === "task" && event.label === "Tool run_command" && event.status === "succeeded"), "tool completion recorded in local timeline");
  assert.ok(events.some((event) => event.type === "log" && event.message.includes("layout=") && event.message.includes("terminal=")), "timeline includes current TUI layout diagnostics");
  assert.equal(adapter.getTimelineEvents(1).length, 1, "timeline limit returns bounded tail");
  adapter.destroy();
}

// ── TUI debug state and renderer snapshots are exportable ───────────────────
{
  const { adapter, terminal } = makeAdapter();
  for (let i = 0; i < 35; i++) {
    adapter.appendSystemMessage(`debug-marker-${i}`);
  }
  terminal.type("\x1b[5;2~"); // Shift+PageUp
  const state = adapter.getDebugState();
  assert.equal(state.renderer, "tui", "debug state identifies TUI renderer");
  assert.equal(state.terminal.columns, 100, "debug state records terminal width");
  assert.ok(state.viewport.transcriptLines > state.viewport.transcriptRows, "debug state records viewport pressure");
  assert.ok(state.viewport.scrollOffset > 0, "debug state records transcript scroll offset");
  assert.equal(state.layoutMode, "wide", "debug state records layout mode");

  const snapshotPath = adapter.saveRendererSnapshot("verify");
  assert.ok(snapshotPath.includes("renderer-snapshots"), "renderer snapshot path uses diagnostic directory");
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
    reason?: string;
    debugState?: { renderer?: string };
    rendered?: { currentBaseLines?: string[] };
  };
  assert.equal(snapshot.reason, "verify", "renderer snapshot records reason");
  assert.equal(snapshot.debugState?.renderer, "tui", "renderer snapshot embeds debug state");
  assert.ok((snapshot.rendered?.currentBaseLines?.length ?? 0) > 0, "renderer snapshot includes rendered lines");
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

// ── Completed tool rows keep elapsed duration visible ───────────────────────
{
  const { adapter } = makeAdapter();
  adapter.addTool("run_command", { command: "npm test" }, "tc-duration");
  adapter.startTool("tc-duration");
  await sleep(130);
  adapter.completeTool("tc-duration", "ok");
  const text = renderedText(adapter);
  assert.ok(/\(1\d\dms\)/.test(text), "completed tool row shows elapsed duration");
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

// ── Ctrl+O cycles inline tool-output verbosity ───────────────────────────────
{
  const { adapter, terminal } = makeAdapter(); // defaults to compact
  const modeOf = () =>
    (adapter as unknown as { toolDisplayMode: string }).toolDisplayMode;
  assert.equal(modeOf(), "compact", "starts in compact tool display");

  terminal.type("\x0f"); // Ctrl+O (raw control byte)
  assert.equal(modeOf(), "auto", "Ctrl+O advances compact → auto");
  terminal.type("\x0f");
  assert.equal(modeOf(), "expanded", "Ctrl+O advances auto → expanded");
  terminal.type("\x0f");
  assert.equal(modeOf(), "compact", "Ctrl+O wraps expanded → compact");

  const text = renderedText(adapter);
  assert.ok(text.includes("Tool output:"), "mode change is announced in the transcript");
  adapter.destroy();
}

// ── A tool still running at turn end is marked interrupted (not eternal) ─────
{
  const { adapter } = makeAdapter({ ui: { toolDisplay: "expanded" } });
  adapter.beginTurn();
  adapter.addTool("run_command", { command: "sleep 999" }, "tc-orphan");
  adapter.startTool("tc-orphan");
  let text = renderedText(adapter);
  assert.ok(!text.includes("interrupted"), "row is live while the turn is active");

  // Turn ends without the tool ever completing (interrupt / provider error).
  adapter.endTurn();
  text = renderedText(adapter);
  assert.ok(text.includes("interrupted"), "orphaned running row is finalized as interrupted");

  // The shared ticker must stop once nothing is active and the turn is over.
  const ticker = (adapter as unknown as { ticker: NodeJS.Timeout | null }).ticker;
  assert.equal(ticker, null, "ticker stops after the orphaned row is finalized");
  adapter.destroy();
}

// ── Transcript is bounded; trimmed tool rows are pruned from bookkeeping ──────
{
  const { adapter } = makeAdapter();
  const chat = (adapter as unknown as { chat: { children: unknown[] } }).chat;
  const toolRows = (adapter as unknown as { toolRows: Map<string, unknown> }).toolRows;

  // Seed a tool row that will later be pushed past the retention window.
  adapter.addTool("read_file", { path: "src/old.ts" }, "tc-evictee");
  adapter.completeTool("tc-evictee", "ok");
  assert.ok(toolRows.has("tc-evictee"), "tool row is tracked before eviction");

  // Flood well past the cap so the early component is trimmed from the front.
  for (let i = 0; i < 900; i++) {
    adapter.appendSystemMessage(`bound-marker-${i}`);
  }
  assert.ok(chat.children.length <= 800, "transcript components stay within the cap");
  assert.ok(!toolRows.has("tc-evictee"), "trimmed tool row is pruned from the toolRows map");
  adapter.destroy();
}

// Allow any stray loader/ticker callbacks to settle, then confirm clean exit.
await sleep(50);
console.log("tui-adapter verification passed");
