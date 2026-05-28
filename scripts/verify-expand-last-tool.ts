/**
 * Lock down getLastToolOutput's locator contract.
 *
 * ^E hands the most recent tool's full output to the system pager. The
 * locator prefers a real on-disk path (so the pager mmaps the full file
 * instead of getting the truncated in-memory tail) but falls back to
 * the inline message content when no temp file was produced.
 */

// Silence Ink's non-TTY noise.
const stdinAsTty = process.stdin as NodeJS.ReadStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => NodeJS.ReadStream;
};
if (!stdinAsTty.isTTY) {
  stdinAsTty.isTTY = true;
  stdinAsTty.setRawMode = ((_mode: boolean) => stdinAsTty) as never;
}
const _origConsoleError = console.error;
console.error = () => {};

import { InkChatAdapter } from "../src/ui/ink/InkChatAdapter.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function makeAdapter() {
  const adapter = new InkChatAdapter({
    provider: "test",
    model: "test-model",
    cwd: process.cwd(),
  });
  (adapter as unknown as { instance: { unmount: () => void; rerender: () => void } }).instance = {
    unmount: () => {},
    rerender: () => {},
  };
  return adapter;
}

// --- Empty session ---------------------------------------------------------
{
  const adapter = makeAdapter();
  assert(adapter.getLastToolOutput() === null, "empty session returns null");
  adapter.destroy();
}

// --- Tool widget (run_command-style) with no temp file → inline content ---
{
  const adapter = makeAdapter();
  const id = adapter.addTool("read_file", { path: "x.ts" }, "call-1");
  adapter.startTool(id);
  adapter.completeTool(id, "console.log('hi')");

  const last = adapter.getLastToolOutput();
  assert(last !== null, "live tool widget surfaced");
  assert(last!.toolName === "read_file", "tool name preserved");
  assert(last!.filePath === undefined, "no temp file path");
  assert(last!.content.includes("console.log"), "inline content available");

  adapter.destroy();
}

// --- Tool widget WITH fullOutputPath → uses the path ---------------------
{
  const adapter = makeAdapter();
  const id = adapter.addTool("run_command", { command: "npm test" }, "call-2");
  adapter.startTool(id);
  adapter.completeTool(id, "...truncated tail...", {
    fullOutputPath: "/tmp/meer-command-xxx.log",
    durationMs: 5000,
  });

  const last = adapter.getLastToolOutput();
  assert(last !== null, "tool found");
  assert(last!.toolName === "run_command", "name preserved");
  assert(
    last!.filePath === "/tmp/meer-command-xxx.log",
    `fullOutputPath surfaces (got ${JSON.stringify(last!.filePath)})`
  );
  assert(last!.content.includes("truncated tail"), "content still present");

  adapter.destroy();
}

// --- Mutation tool messages (which DO land in chat) are also locatable ----
{
  const adapter = makeAdapter();
  adapter.appendToolMessage(
    "apply_edit",
    "Tool: apply_edit\nResult:\nUpdated src/foo.ts",
    false,
    { toolCallId: "call-3" }
  );

  const last = adapter.getLastToolOutput();
  assert(last !== null, "mutation tool message found");
  assert(
    last!.toolName === "apply_edit",
    `mutation tool name (got "${last!.toolName}")`
  );
  assert(last!.content.includes("Updated"), "mutation content available");

  adapter.destroy();
}

// --- Most-recent-wins across both sources ---------------------------------
{
  const adapter = makeAdapter();
  // First: a mutation message (older — timestamp will be earlier).
  adapter.appendToolMessage(
    "apply_edit",
    "first (a mutation)",
    false,
    { toolCallId: "call-A" }
  );
  // Force a small time gap so endTime > timestamp deterministically.
  await new Promise((r) => setTimeout(r, 5));
  // Then: a run_command (lives in this.tools).
  const id = adapter.addTool("run_command", { command: "ls" }, "call-B");
  adapter.startTool(id);
  adapter.completeTool(id, "second (run_command)");

  const last = adapter.getLastToolOutput();
  assert(last !== null, "found a tool");
  assert(
    last!.toolName === "run_command",
    `most recent tool wins (got "${last!.toolName}")`
  );
  assert(
    last!.content.includes("second"),
    "content of the most recent tool returned"
  );

  adapter.destroy();
}

// --- User-only / assistant-only sessions return null ---------------------
{
  const adapter = makeAdapter();
  adapter.appendUserMessage("hi");
  adapter.beginTurn();
  adapter.startAssistantMessage();
  adapter.settleAssistantMessage("hello");
  adapter.endTurn();

  assert(
    adapter.getLastToolOutput() === null,
    "no tool messages → null even with user + assistant present"
  );

  adapter.destroy();
}

console.error = _origConsoleError;
console.log("expand-last-tool verification passed");
