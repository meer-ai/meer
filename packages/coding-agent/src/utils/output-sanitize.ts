/**
 * Strip terminal-corrupting bytes from arbitrary tool output before we
 * commit it to scrollback or hand it to the LLM.
 *
 * Without this, a tool that emits raw NUL bytes, backspaces, or escape
 * sequences (e.g. `cat` on a binary file, a misbehaving subprocess, a
 * malicious-or-buggy MCP server) can:
 *   - Clear the terminal mid-render
 *   - Reset terminal modes (raw-mode, cursor visibility, color)
 *   - Smuggle control characters into the prompt that confuse the model
 *
 * We keep a narrow allowlist of *known-safe* control characters
 * (newline, carriage return, tab) and drop everything else under 0x20
 * plus the C1 control range (0x7f–0x9f). ANSI CSI / OSC sequences get
 * removed wholesale.
 */

// Match CSI sequences (ESC [ … <final byte 0x40-0x7e>), OSC sequences
// (ESC ] … BEL or ESC \), and a handful of single-character ESC commands.
const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

// Allow:
//  - HT  (0x09) — tabs are common in code output
//  - LF  (0x0a) — line breaks
//  - CR  (0x0d) — windows line endings (normalized below)
// Drop everything else under 0x20, plus DEL (0x7f) and C1 (0x80–0x9f).
const NON_PRINTABLE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

export interface SanitizeOptions {
  /** When true (default), strip ANSI/CSI escape sequences. */
  stripAnsi?: boolean;
  /** When true (default), normalize CR/CRLF to LF. */
  normalizeNewlines?: boolean;
  /** When true (default), drop disallowed control characters. */
  stripControlChars?: boolean;
}

/**
 * Returns a copy of the input with terminal-corrupting bytes removed.
 * Always safe to call — never throws, even on non-UTF-8 input.
 */
export function sanitizeToolOutput(
  input: string,
  options?: SanitizeOptions
): string {
  if (!input) return input;
  let out = input;

  if (options?.normalizeNewlines !== false) {
    out = out.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }
  if (options?.stripAnsi !== false) {
    out = out.replace(ANSI_PATTERN, "");
  }
  if (options?.stripControlChars !== false) {
    out = out.replace(NON_PRINTABLE, "");
  }
  return out;
}
