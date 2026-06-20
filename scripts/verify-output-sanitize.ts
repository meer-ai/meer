/**
 * Lock down sanitizeToolOutput's contract.
 *
 * Tool output that hits Static scrollback or the LLM transcript must be
 * stripped of terminal-corrupting bytes:
 *   - ANSI CSI sequences (color, cursor movement, screen clear)
 *   - ANSI OSC sequences (title set, hyperlinks)
 *   - C0 control characters (NUL, BS, BEL) except for HT/LF/CR
 *   - C1 control range (0x7f–0x9f)
 *
 * Newlines must be preserved; tabs must be preserved.
 */

import { sanitizeToolOutput } from "@meer/coding-agent/utils/output-sanitize.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// --- ANSI CSI (color, cursor moves, clear-screen) -------------------------
{
  const colored = "\x1b[31mred\x1b[0m text";
  assert(sanitizeToolOutput(colored) === "red text", "strips CSI color");

  const cleared = "before\x1b[2Jafter\x1b[Hpos";
  assert(
    sanitizeToolOutput(cleared) === "beforeafterpos",
    "strips clear-screen + cursor-move"
  );
}

// --- ANSI OSC (title set, hyperlinks) -------------------------------------
{
  // OSC with BEL terminator.
  const titled = "\x1b]0;Title\x07hello";
  assert(sanitizeToolOutput(titled) === "hello", "strips OSC title");
}

// --- C0 control characters dropped, newlines/tabs kept -------------------
{
  const mixed = "good\x00\x08stuff\x07\nnext\tline";
  assert(
    sanitizeToolOutput(mixed) === "goodstuff\nnext\tline",
    `kept tab+newline, dropped NUL/BS/BEL (got ${JSON.stringify(sanitizeToolOutput(mixed))})`
  );
}

// --- C1 (0x7f–0x9f) dropped -----------------------------------------------
{
  const c1 = "a\x7fb\x80c\x9fd";
  assert(sanitizeToolOutput(c1) === "abcd", "drops C1 control bytes");
}

// --- CRLF / CR normalised to LF -------------------------------------------
{
  assert(
    sanitizeToolOutput("a\r\nb\rc") === "a\nb\nc",
    "normalizes CRLF and stray CR"
  );
}

// --- Empty / no-op cases --------------------------------------------------
{
  assert(sanitizeToolOutput("") === "", "empty stays empty");
  assert(
    sanitizeToolOutput("just plain text") === "just plain text",
    "plain text untouched"
  );
}

// --- Real-world: `ls --color` output --------------------------------------
{
  const lsOutput =
    "\x1b[01;34msrc\x1b[0m  \x1b[01;34mdist\x1b[0m  package.json\n";
  assert(
    sanitizeToolOutput(lsOutput) === "src  dist  package.json\n",
    `ls --color sanitised cleanly (got ${JSON.stringify(sanitizeToolOutput(lsOutput))})`
  );
}

// --- Real-world: progress bar with CR overwrites -------------------------
{
  // Things like wget/curl/npm output where CR rewrites the line.
  const progress = "downloading\r 10%\r 50%\r 100%\n";
  assert(
    sanitizeToolOutput(progress) === "downloading\n 10%\n 50%\n 100%\n",
    "CR rewrites land as newlines"
  );
}

// --- Options: opt-out ----------------------------------------------------
{
  const colored = "\x1b[31mred\x1b[0m";
  // stripAnsi:false leaves ANSI patterns alone, but the C0 strip still
  // removes the ESC byte unless you also opt out of that. Both off →
  // full passthrough.
  assert(
    sanitizeToolOutput(colored, {
      stripAnsi: false,
      stripControlChars: false,
    }) === colored,
    "stripAnsi:false + stripControlChars:false is full passthrough"
  );
  // stripAnsi alone disables OSC/CSI detection but C0 strip still bites.
  const onlyAnsiOff = sanitizeToolOutput(colored, { stripAnsi: false });
  assert(
    !onlyAnsiOff.includes("\x1b"),
    "C0 strip still removes ESC even with stripAnsi off"
  );
}

console.log("output sanitize verification passed");
