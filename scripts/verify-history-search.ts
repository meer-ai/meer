/**
 * Verifies the editor's reverse incremental history search (Ctrl+R).
 *
 * The Editor renders to plain string arrays and takes raw keystrokes, so we can
 * drive it directly with a minimal in-memory terminal and assert deterministically.
 */

import assert from "node:assert/strict";
import stripAnsiImport from "strip-ansi";
import type { Terminal } from "@meer-ai/tui/terminal.js";
import { TUI } from "@meer-ai/tui/tui.js";
import { Editor } from "@meer-ai/tui/components/editor.js";
import { getEditorTheme } from "@meer-ai/coding-agent/ui/tui-adapter/theme.js";

const stripAnsi = stripAnsiImport as unknown as (text: string) => string;

const CTRL_R = "\x12";
const ESC = "\x1b";
const ENTER = "\r";
const BACKSPACE = "\x7f";

class FakeTerminal implements Terminal {
  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  get columns(): number {
    return 80;
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
}

function makeEditor(history: string[]): Editor {
  const tui = new TUI(new FakeTerminal());
  const editor = new Editor(tui, getEditorTheme());
  editor.focused = true;
  editor.setHistory(history);
  return editor;
}

function type(editor: Editor, text: string): void {
  for (const ch of text) editor.handleInput(ch);
}

function renderText(editor: Editor): string {
  return editor
    .render(80)
    .map((line) => stripAnsi(line))
    .join("\n");
}

// History is newest-first (index 0 = most recent), matching the store's load().
const history = [
  "git commit -m fix",
  "npm run build",
  "git push origin main",
  "npm run test",
];

// --- Ctrl+R enters search and typing filters to the best match ---
{
  const editor = makeEditor(history);
  editor.handleInput(CTRL_R);
  assert.equal(editor.isSearching(), true);
  type(editor, "build");
  assert.equal(editor.getText(), "npm run build");
  const screen = renderText(editor);
  assert.match(screen, /reverse-i-search/);
  assert.match(screen, /`build'/);
}

// --- Enter accepts the match into the editable buffer (no auto-submit) ---
{
  const editor = makeEditor(history);
  editor.handleInput(CTRL_R);
  type(editor, "push");
  editor.handleInput(ENTER);
  assert.equal(editor.isSearching(), false);
  assert.equal(editor.getText(), "git push origin main");
}

// --- Ctrl+R cycles to the next (older) match for the same query ---
{
  const editor = makeEditor(history);
  editor.handleInput(CTRL_R);
  type(editor, "git"); // matches both git entries; newest first
  assert.equal(editor.getText(), "git commit -m fix");
  editor.handleInput(CTRL_R); // → next older git match
  assert.equal(editor.getText(), "git push origin main");
  // Clamps at the last match — no wraparound.
  editor.handleInput(CTRL_R);
  assert.equal(editor.getText(), "git push origin main");
}

// --- Escape cancels and restores the pre-search buffer ---
{
  const editor = makeEditor(history);
  editor.setText("draft message");
  editor.handleInput(CTRL_R);
  type(editor, "npm");
  assert.notEqual(editor.getText(), "draft message");
  editor.handleInput(ESC);
  assert.equal(editor.isSearching(), false);
  assert.equal(editor.getText(), "draft message");
}

// --- Backspace shrinks the query and re-filters ---
{
  const editor = makeEditor(history);
  editor.handleInput(CTRL_R);
  type(editor, "buildx"); // no match
  assert.equal(editor.getSearchStatus(), null);
  assert.match(renderText(editor), /failed reverse-i-search/);
  editor.handleInput(BACKSPACE); // back to "build"
  assert.equal(editor.getText(), "npm run build");
  assert.notEqual(editor.getSearchStatus(), null);
}

// --- No-op on empty history: stays usable, no crash ---
{
  const editor = makeEditor([]);
  editor.handleInput(CTRL_R);
  assert.equal(editor.isSearching(), true);
  type(editor, "anything");
  assert.equal(editor.getSearchStatus(), null);
  editor.handleInput(ESC);
  assert.equal(editor.isSearching(), false);
}

console.log("verify-history-search: all assertions passed");
