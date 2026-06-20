/**
 * Lock down the file-edit diff preview helpers and their rendering in a tool row.
 *
 * - parseDiffStat counts +/- lines (ignoring @@ headers), tolerant of ANSI color.
 * - buildDiffPreview returns the first N tagged lines + a hidden count.
 * - In expanded display mode, a completed file-edit tool row shows a +N/-M stat
 *   and the diff body, while a non-edit tool row stays stat-free.
 */

import assert from "node:assert/strict";
import stripAnsiImport from "strip-ansi";
import type { Terminal } from "@meer/tui/terminal.js";
import { TuiChatAdapter } from "@meer/coding-agent/ui/tui-adapter/TuiChatAdapter.js";
import { DEFAULT_UI_SETTINGS } from "@meer/coding-agent/ui/ui-settings.js";
import {
  parseDiffStat,
  buildDiffPreview,
  buildToolOutputPreview,
  getToolSummary,
  extractStreamingArgPreview,
} from "@meer/coding-agent/ui/shared/tool-utils.js";

const stripAnsi = stripAnsiImport as unknown as (text: string) => string;

// A unified diff the way generateDiff emits it (here without color).
const DIFF = [
  "@@ -12,4 +12,7 @@",
  "-  const port = 3000",
  "+  const port = process.env.PORT",
  "+    ? Number(process.env.PORT)",
  "+    : 3000",
  "   app.listen(port)",
  "+  log('up')",
  "+  log('again')",
  "+  log('more')",
].join("\n");

// --- parseDiffStat ---------------------------------------------------------
{
  const stat = parseDiffStat(DIFF);
  assert.equal(stat.added, 6, "counts added lines");
  assert.equal(stat.removed, 1, "counts removed lines");

  // ANSI-colored diff yields the same counts.
  const colored = `\x1b[32m+ added\x1b[39m\n\x1b[31m- removed\x1b[39m`;
  const cstat = parseDiffStat(colored);
  assert.equal(cstat.added, 1, "ANSI added counted");
  assert.equal(cstat.removed, 1, "ANSI removed counted");
}

// --- buildDiffPreview ------------------------------------------------------
{
  const { lines, hiddenLines } = buildDiffPreview(DIFF, 7);
  assert.equal(lines.length, 7, "caps preview to maxLines");
  assert.equal(hiddenLines, 2, "reports hidden remainder (9 - 7)");
  assert.equal(lines[0].kind, "meta", "@@ tagged meta");
  assert.equal(lines[1].kind, "remove", "- tagged remove");
  assert.equal(lines[2].kind, "add", "+ tagged add");
  assert.equal(lines[5].kind, "context", "context line tagged context");
}

// --- buildToolOutputPreview ------------------------------------------------
{
  // Mutation tools render a diff instead → no output preview.
  assert.equal(buildToolOutputPreview("edit_file", "Successfully updated x"), null, "edits have no output preview");
  assert.equal(buildToolOutputPreview("run_command", "   \n  "), null, "blank output → null");

  const out = buildToolOutputPreview("run_command", "line1\nline2\nline3", 2);
  assert.ok(out && out.lines.length === 2, "caps output lines");
  assert.equal(out?.hiddenLines, 1, "reports hidden output lines");
  const narrow = buildToolOutputPreview("run_command", "abcdefghijklmnopqrstuvwxyz", 1, 8);
  assert.equal(narrow?.lines[0], "abcdefg…", "caps output line width");

  // ANSI-colored output is stripped.
  const colored = buildToolOutputPreview("grep", "\x1b[1msrc/a.ts\x1b[0m:1 hit");
  assert.ok(colored && colored.lines[0] === "src/a.ts:1 hit", "strips ANSI from output");
}

// --- getToolSummary: richer args ------------------------------------------
{
  assert.equal(getToolSummary("run_command", { command: "npm test" }), "$ npm test", "command");
  assert.equal(getToolSummary("http_request", { url: "https://api.x/v1", method: "post" }), "POST https://api.x/v1", "http method+url");
  assert.equal(getToolSummary("http_request", { url: "https://api.x/v1" }), "GET https://api.x/v1", "http defaults to GET");
  assert.equal(getToolSummary("package_install", { packages: ["react", "zod"] }), "react, zod", "package array");
  assert.equal(getToolSummary("package_install", { packages: "react, zod" }), "react, zod", "package csv string");
  assert.equal(getToolSummary("git_commit", { message: "fix: retry" }), '"fix: retry"', "commit message");
  assert.equal(getToolSummary("find_references", { symbol: "handleAuth" }), "handleAuth", "symbol");
  assert.equal(getToolSummary("set_plan", { title: "Ship it", tasks: [] }), "Ship it", "plan title");
  assert.equal(getToolSummary("read_file", { path: "src/x.ts" }), "src/x.ts", "path fallback");
  assert.equal(getToolSummary("analyze_project", {}), "", "no args → empty");
}

// --- extractStreamingArgPreview: partial JSON ------------------------------
{
  assert.equal(extractStreamingArgPreview('{"command":"npm ru'), "npm ru", "partial command (unterminated)");
  assert.equal(extractStreamingArgPreview('{"path":"src/server.ts"}'), "src/server.ts", "complete path");
  assert.equal(extractStreamingArgPreview('{"url":"https://a.b'), "https://a.b", "partial url");
  assert.equal(extractStreamingArgPreview('{"unknown":"x"'), "", "unrecognized key → empty");
  assert.equal(extractStreamingArgPreview("{"), "", "no value yet → empty");
}

// --- rendering in a tool row -----------------------------------------------
class FakeTerminal implements Terminal {
  written = "";
  private inputHandler: ((data: string) => void) | null = null;
  start(onInput: (data: string) => void): void {
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

function renderedText(adapter: TuiChatAdapter): string {
  const ui = (adapter as unknown as { ui: { render(width: number): string[] } }).ui;
  return ui.render(100).map((line) => stripAnsi(line)).join("\n");
}

{
  const adapter = new TuiChatAdapter({
    provider: "test",
    model: "test-model",
    cwd: process.cwd(),
    ui: {
      ...DEFAULT_UI_SETTINGS,
      toolDisplay: "expanded",
      toolOutput: {
        ...DEFAULT_UI_SETTINGS.toolOutput,
        maxDiffPreviewLines: 3,
      },
    },
    terminal: new FakeTerminal(),
  });

  adapter.addTool("edit_file", { path: "src/server.ts" }, "tc-1");
  adapter.startTool("tc-1");
  adapter.completeTool("tc-1", "ok", { path: "src/server.ts", diff: DIFF });

  const text = renderedText(adapter);
  assert.ok(text.includes("edit_file"), "edit row renders");
  assert.ok(/\+6\s+-1/.test(text), `stat +6 -1 shown (got: ${text.replace(/\n/g, "⏎")})`);
  assert.ok(text.includes("const port = process.env.PORT"), "diff body rendered");
  assert.ok(text.includes("6 more lines"), "configured diff line budget controls hidden-lines footer");

  // A non-edit tool stays a single line (no diff body).
  adapter.addTool("read_file", { path: "src/server.ts" }, "tc-2");
  adapter.completeTool("tc-2", "ok", { path: "src/server.ts" });
  const text2 = renderedText(adapter);
  const readIdx = text2.indexOf("read_file");
  assert.ok(readIdx >= 0, "read row renders");
  assert.ok(!/read_file[^\n]*\+\d+\s+-\d+/.test(text2), "read row has no stat");

  adapter.destroy();
}

console.log("verify-diff-preview: all assertions passed");
