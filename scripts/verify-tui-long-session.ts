/**
 * Stress-checks the custom TUI renderer with large transcripts.
 *
 * The goal is not pixel-perfect snapshots; it is catching production failure
 * classes: lost ordering, runaway line width, slow pure renders, and long
 * tool/diff output that floods the terminal.
 */

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import stripAnsiImport from "strip-ansi";
import type { Terminal } from "../src/ui/tui/terminal.js";
import { TuiChatAdapter } from "../src/ui/tui-adapter/TuiChatAdapter.js";
import { visibleWidth } from "../src/ui/tui/tui.js";

const stripAnsi = stripAnsiImport as unknown as (text: string) => string;

class FakeTerminal implements Terminal {
  written = "";
  private inputHandler: ((data: string) => void) | null = null;
  private resizeHandler: (() => void) | null = null;

  constructor(
    private readonly width: number,
    private readonly height: number
  ) {}

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput;
    this.resizeHandler = onResize;
  }
  stop(): void {
    this.inputHandler = null;
    this.resizeHandler = null;
  }
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.written += data;
  }
  get columns(): number {
    return this.width;
  }
  get rows(): number {
    return this.height;
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

  resize(): void {
    this.resizeHandler?.();
  }

  type(data: string): void {
    this.inputHandler?.(data);
  }
}

function makeAdapter(width: number, height = 32): TuiChatAdapter {
  return new TuiChatAdapter({
    provider: "stress",
    model: "stress-model",
    cwd: process.cwd(),
    terminal: new FakeTerminal(width, height),
  });
}

function renderLines(adapter: TuiChatAdapter, width: number): string[] {
  const ui = (adapter as unknown as { ui: { render(width: number): string[] } }).ui;
  return ui.render(width).map((line) => stripAnsi(line));
}

function assertLineWidths(lines: string[], width: number): void {
  const allowedOverflow = 4;
  const bad = lines
    .map((line, index) => ({ line, index, width: visibleWidth(line) }))
    .filter((item) => item.width > width + allowedOverflow);
  assert.deepEqual(
    bad.slice(0, 5),
    [],
    `rendered lines should fit terminal width ${width}`
  );
}

function assertOrdered(text: string, needles: string[]): void {
  let previous = -1;
  for (const needle of needles) {
    const index = text.indexOf(needle);
    assert.ok(index > previous, `expected ${needle} after previous marker`);
    previous = index;
  }
}

function findLine(lines: string[], predicate: (line: string) => boolean): number {
  return lines.findIndex(predicate);
}

function assertFullShellLayout(lines: string[], width: number, height: number): void {
  assert.ok(lines.length <= height, `rendered shell should fit terminal height ${height}, got ${lines.length}`);
  assertLineWidths(lines, width);

  const header = findLine(lines, (line) => line.includes("≋ meer"));
  const overflow = findLine(lines, (line) => line.includes("earlier transcript lines"));
  const tailUser = findLine(lines, (line) => line.includes("user-marker-179"));
  const tailAssistant = findLine(lines, (line) => line.includes("assistant-marker-179"));
  const finalTurnTail = findLine(
    lines,
    (line) => line.includes("assistant-marker-179") || line.includes("module-179") || line.includes("value179")
  );
  const editorBorder = findLine(lines, (line) => /^─{8,}/.test(line.trim()));
  const footerStatus = findLine(lines, (line) => line.includes("meer · stress/stress-model"));
  const footerHints = findLine(lines, (line) => line.includes("Enter send"));

  assert.equal(header, 0, "status header should remain the first shell line");
  assert.ok(overflow > header, "transcript overflow marker should appear below header");
  assert.ok(finalTurnTail > overflow, "latest turn tail should appear after overflow marker");
  if (width >= 80) {
    assert.ok(tailUser > overflow, "wide shell should keep latest user message visible");
    assert.ok(tailAssistant > tailUser, "wide shell should preserve latest user to assistant order");
  }
  assert.ok(editorBorder > finalTurnTail, "composer border should appear after transcript tail");
  assert.ok(footerStatus > editorBorder, "footer status should remain below composer");
  assert.ok(footerHints > footerStatus, "footer shortcuts should remain below footer status");
  assert.ok(lines[0].includes("stress/stress-model") || lines[footerStatus].includes("stress/stress-model"), "provider/model should remain visible");
  if (width >= 80) {
    assert.ok(lines[0].includes("~32.0k / 512.0k ctx"), "wide header should show context usage");
  }
}

function buildLargeTranscript(adapter: TuiChatAdapter, count: number): void {
  for (let i = 0; i < count; i++) {
    adapter.appendUserMessage(
      `user-marker-${i} Please inspect src/module-${i}.ts and compare behavior around ${"x".repeat(36)}`
    );
    adapter.beginTurn();
    adapter.settleAssistantMessage(
      [
        `assistant-marker-${i}`,
        `Summary for src/module-${i}.ts with markdown **bold-${i}** and a long identifier module_${i}_${"y".repeat(42)}.`,
        "",
        "```ts",
        `export const value${i} = "${"z".repeat(30)}";`,
        "```",
      ].join("\n")
    );
    adapter.endTurn();

    if (i % 25 === 0) {
      const id = adapter.addTool("run_command", {
        command: `node -e "console.log('${i}')"`
      }, `stress-tool-${i}`);
      adapter.startTool(id);
      adapter.updateToolProgress(
        id,
        Array.from({ length: 18 }, (_, line) => `tool-${i}-progress-${line} ${"o".repeat(60)}`).join("\n")
      );
      adapter.completeTool(id, "ok");
    }

    if (i % 40 === 0) {
      const editId = adapter.addTool("edit_file", { path: `src/module-${i}.ts` }, `stress-edit-${i}`);
      adapter.completeTool(
        editId,
        "ok",
        {
          path: `src/module-${i}.ts`,
          diff: Array.from(
            { length: 24 },
            (_, line) => `${line % 2 === 0 ? "+" : "-"}changed-${i}-${line}-${"d".repeat(80)}`
          ).join("\n"),
        }
      );
    }
  }
}

const widths = [40, 80, 120];
for (const width of widths) {
  const height = width === 40 ? 18 : 32;
  const adapter = makeAdapter(width, height);
  try {
    buildLargeTranscript(adapter, 180);
    adapter.updateTokens(32000, 512000, true);

    const started = performance.now();
    const lines = renderLines(adapter, width);
    const elapsed = performance.now() - started;
    const text = lines.join("\n");

    assertFullShellLayout(lines, width, height);
    assert.ok(elapsed < 1500, `pure render at width ${width} should stay under 1500ms, got ${elapsed.toFixed(1)}ms`);
    assert.ok(text.includes("earlier transcript lines"), "hidden transcript history should be indicated");
    assert.ok(!text.includes("user-marker-0"), "old transcript head should be hidden from the active viewport");
    if (text.includes("user-marker-179") && text.includes("assistant-marker-179")) {
      assertOrdered(text, ["user-marker-179", "assistant-marker-179"]);
    } else {
      assert.ok(
        text.includes("assistant-marker-179") || text.includes("module-179") || text.includes("value179"),
        "latest turn tail should remain visible"
      );
    }
    assert.ok(text.includes("stress/stress-model"), "footer/header model identity should remain present");
  } finally {
    adapter.destroy();
  }
}

// Repeated render after resize-like width changes should remain deterministic.
{
  const adapter = makeAdapter(100);
  try {
    buildLargeTranscript(adapter, 75);
    adapter.updateTokens(32000, 512000, true);
    const first = renderLines(adapter, 100).join("\n");
    const narrow = renderLines(adapter, 42).join("\n");
    const wide = renderLines(adapter, 120).join("\n");
    assert.ok(first.includes("assistant-marker-74"), "baseline render includes tail message");
    assert.ok(narrow.includes("assistant-marker-74"), "narrow render includes tail message");
    assert.ok(wide.includes("assistant-marker-74"), "wide render includes tail message");
    assertLineWidths(narrow.split("\n"), 42);
    assertLineWidths(wide.split("\n"), 120);
  } finally {
    adapter.destroy();
  }
}

console.log("tui long-session stress verification passed");
