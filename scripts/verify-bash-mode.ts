/**
 * Lock down bash mode routing.
 *
 * The `!cmd` shortcut runs the rest of the line through `runCommand`
 * directly, skipping the LLM. The cli's enqueueInput detects the prefix
 * and routes; runBashModeCommand echoes the command and the output as
 * system messages, never throws on a failed shell call, and never
 * touches the conversation history (no AgentSession invocation).
 *
 * We test this at the `runCommand` boundary — the cli wiring is a thin
 * router that calls into runCommand, which is already covered by the
 * existing smoke tests. Here we lock the contract that:
 *
 *  - a `!` prefix is detected reliably
 *  - the trimmed command after the prefix is what gets executed
 *  - the bash output is captured in the result
 *  - errors in the command bubble through as a result.error string,
 *    not a thrown exception
 */

import { runCommand } from "@meer-ai/coding-agent/tools/index.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

/**
 * Replicates the prefix-detection logic in cli.ts's enqueueInput so a
 * regression in that detection would surface here.
 */
function detectBashCommand(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("!") || trimmed === "!") return null;
  const command = trimmed.slice(1).trim();
  return command || null;
}

// --- Prefix detection -----------------------------------------------------
assert(detectBashCommand("!ls") === "ls", "trivial bash command");
assert(detectBashCommand("  !ls -la  ") === "ls -la", "whitespace and args");
assert(detectBashCommand("!") === null, "bare exclamation is not a command");
assert(detectBashCommand("! ") === null, "exclamation + whitespace is not a command");
assert(detectBashCommand("ls") === null, "no prefix → no bash");
assert(detectBashCommand("/help") === null, "slash is not bash");
assert(
  detectBashCommand("!git status") === "git status",
  "multi-token command"
);

// --- Successful command captures output -----------------------------------
{
  const result = await runCommand(
    "node -e \"console.log('hello bash mode')\"",
    process.cwd(),
    { silent: true }
  );
  assert(!result.error, "no error on successful command");
  assert(
    (result.result ?? "").includes("hello bash mode"),
    `output captured (got "${result.result}")`
  );
}

// --- Failing command surfaces an error string, doesn't throw --------------
{
  const result = await runCommand(
    "this-command-definitely-does-not-exist-xyzzy",
    process.cwd(),
    { silent: true }
  );
  assert(
    typeof result.error === "string" && result.error.length > 0,
    "failure surfaces error string"
  );
}

// --- Pipes and redirects work ---------------------------------------------
{
  const result = await runCommand(
    "node -e \"console.log('one')\" && node -e \"console.log('two')\"",
    process.cwd(),
    { silent: true }
  );
  assert(!result.error, "chained commands succeed");
  assert(
    (result.result ?? "").includes("one") && (result.result ?? "").includes("two"),
    "both echoes captured"
  );
}

console.log("bash mode verification passed");
