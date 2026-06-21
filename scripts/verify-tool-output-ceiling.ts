/**
 * Lock down the universal hard ceiling on tool results.
 *
 * Before this, only `run_command` truncated its own output. Other tools
 * could return arbitrarily large strings (a Grep across a million-line
 * file, a misbehaving custom tool, a misbehaving MCP server) and the
 * whole blob would land in the agent's conversation history → blow past
 * the context window and crash the message renderer.
 *
 * `formatToolTranscript` now caps every result and offloads overflow to
 * a temp file, mirroring the run_command pattern.
 */

import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { formatToolTranscript } from "@meer-ai/coding-agent/agent/meer-agent.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// --- Small result passes through untouched ---------------------------------
{
  const formatted = formatToolTranscript("custom_tool", "hello world");
  assert(
    formatted === "Tool: custom_tool\nResult:\nhello world",
    `small result preserved (got "${formatted}")`
  );
}

// --- Empty result -> placeholder ------------------------------------------
{
  const formatted = formatToolTranscript("custom_tool", "   ");
  assert(
    formatted === "Tool: custom_tool\nResult: (empty)",
    `empty placeholder (got "${formatted}")`
  );
}

// --- read_file uses the existing head-first preview ------------------------
{
  const huge = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  const formatted = formatToolTranscript("read_file", huge);
  assert(formatted.startsWith("Tool: read_file"), "read_file label");
  assert(formatted.includes("line 0"), "head preserved");
  assert(formatted.includes("more lines omitted"), "omitted hint");
  assert(!formatted.includes(`line 499`), "tail dropped for read_file");
}

// --- Generic tool past line ceiling -> tail + temp file --------------------
{
  // Generate > 4000 lines.
  const lines = Array.from({ length: 5000 }, (_, i) => `output ${i}`);
  const result = lines.join("\n");
  const formatted = formatToolTranscript("grep", result);

  assert(formatted.startsWith("Tool: grep\nResult:\n"), "generic tool header");
  assert(formatted.includes("exceeded ceiling"), "shows ceiling hint");
  assert(formatted.includes("Showing tail lines"), "describes tail");
  assert(!formatted.includes("output 0"), "head dropped");
  assert(formatted.includes("output 4999"), "tail preserved");

  // Extract the temp file path from the hint and verify the full content
  // was written.
  const match = formatted.match(/Full output: (\S+\.log)\]/);
  assert(match !== null, "temp file path mentioned");
  const tempPath = (match as RegExpMatchArray)[1];
  assert(existsSync(tempPath), `temp file exists at ${tempPath}`);
  const written = readFileSync(tempPath, "utf8");
  assert(written.startsWith("output 0"), "temp file has full head");
  assert(written.endsWith("output 4999"), "temp file has full tail");
  unlinkSync(tempPath);
}

// --- Generic tool past byte ceiling -> tail + temp file --------------------
{
  // 500KB > 400KB ceiling but only ~3 lines.
  const long = "x".repeat(500 * 1024);
  const result = `${long}\nmiddle\nend`;
  const formatted = formatToolTranscript("custom_blob", result);

  assert(formatted.includes("exceeded ceiling"), "shows ceiling hint for bytes");
  assert(formatted.includes("end"), "tail preserved");

  const match = formatted.match(/Full output: (\S+\.log)\]/);
  assert(match !== null, "temp file path mentioned for byte overflow");
  unlinkSync((match as RegExpMatchArray)[1]);
}

console.log("tool-output ceiling verification passed");
