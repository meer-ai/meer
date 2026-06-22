/**
 * Regression for "Backspace doesn't delete on Windows".
 *
 * On Windows, Node delivers plain Backspace as raw 0x08 (BS) UNLESS the console
 * has ENABLE_VIRTUAL_TERMINAL_INPUT enabled (then plain Backspace arrives as
 * 0x7f and Ctrl+Backspace as 0x08). meer enables VT input via a native helper —
 * but the helper can be absent or fail (piped stdin, no console handle).
 *
 * The bug: in a Windows Terminal session (WT_SESSION set) the parser mapped
 * 0x08 → "ctrl+backspace" purely from the env var, ignoring whether VT input
 * was actually on. With VT input OFF, plain Backspace IS 0x08, so it was
 * misread as an unbound Ctrl+Backspace and deleted nothing.
 *
 * Fix: gate the 0x08 → ctrl+backspace heuristic on the real VT-input state.
 */

import assert from "node:assert/strict";
import {
  parseKey,
  matchesKey,
  setWindowsVtInputActive,
} from "@meer-ai/tui/keys.js";

// Simulate a Windows Terminal session (not over SSH).
process.env.WT_SESSION = "1";
delete process.env.SSH_CONNECTION;
delete process.env.SSH_CLIENT;
delete process.env.SSH_TTY;

// ── VT input OFF (native helper missing / not a real console) ────────────────
// This is the broken scenario. Plain Backspace arrives as 0x08 and MUST delete.
setWindowsVtInputActive(false);

assert.equal(parseKey("\x7f"), "backspace", "0x7f is always plain Backspace");
assert.ok(matchesKey("\x7f", "backspace"), "0x7f matches backspace");

assert.equal(
  parseKey("\x08"),
  "backspace",
  "with VT input OFF, 0x08 must be plain Backspace (not ctrl+backspace)"
);
assert.ok(
  matchesKey("\x08", "backspace"),
  "with VT input OFF, 0x08 must match the backspace binding"
);

// ── VT input ON (native helper enabled it) ───────────────────────────────────
// Proper xterm mode: 0x7f = Backspace, 0x08 = Ctrl+Backspace. Keep that split.
setWindowsVtInputActive(true);

assert.equal(parseKey("\x7f"), "backspace", "VT on: 0x7f still plain Backspace");
assert.equal(
  parseKey("\x08"),
  "ctrl+backspace",
  "VT on: 0x08 is Ctrl+Backspace"
);
assert.ok(matchesKey("\x08", "ctrl+backspace"), "VT on: 0x08 matches ctrl+backspace");

// ── Non-Windows-Terminal: 0x08 is plain Backspace regardless of VT state ─────
delete process.env.WT_SESSION;
setWindowsVtInputActive(false);
assert.equal(parseKey("\x08"), "backspace", "no WT session: 0x08 is plain Backspace");
setWindowsVtInputActive(true);
assert.equal(parseKey("\x08"), "backspace", "no WT session: 0x08 stays plain Backspace");

console.log("backspace-windows verification passed");
