/**
 * Locks down progressive-commit streaming:
 *
 *  - planStreamCommit: fence-aware paragraph splitting (pure helper)
 *  - InkChatAdapter: streamed responses are committed to scrollback as parts
 *    (header on the first, continuation after), tool rows land AFTER the
 *    text that preceded them, and /copy reconstructs the full response.
 */

// Silence Ink's non-TTY warnings so the test output stays clean.
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

import assert from "node:assert/strict";
import {
  collapseWhitespace,
  planFinishCommit,
  planStreamCommit,
} from "../src/ui/ink/streamCommit.js";
import { InkChatAdapter } from "../src/ui/ink/InkChatAdapter.js";

type AdapterMessages = Array<{
  id: string;
  role: string;
  content: string;
  streamGroupId?: string;
  isContinuation?: boolean;
  streamGroupFull?: string;
  toolName?: string;
}>;

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

function messagesOf(adapter: InkChatAdapter): AdapterMessages {
  return (adapter as unknown as { messages: AdapterMessages }).messages;
}

// ===========================================================================
// planStreamCommit (pure)
// ===========================================================================

// No boundary yet — nothing to commit
{
  const plan = planStreamCommit("still streaming this paragraph", null);
  assert.equal(plan.consumed, 0);
}

// Paragraph boundary — committed up to the boundary, tail stays live
{
  const plan = planStreamCommit("para one\n\npara two is stream", null);
  assert.ok(plan.consumed > 0);
  assert.equal(plan.commitText, "para one");
  assert.equal("para one\n\npara two is stream".slice(plan.consumed), "para two is stream");
  assert.equal(plan.openFenceAfter, null);
}

// Multiple boundaries — commits through the LAST one in one shot
{
  const source = "a\n\nb\n\nc tail";
  const plan = planStreamCommit(source, null);
  assert.equal(source.slice(plan.consumed), "c tail");
  assert.equal(plan.commitText, "a\n\nb");
}

// Blank line INSIDE an open code fence is not a boundary
{
  const source = "```ts\nconst a = 1;\n\nconst b = 2;\nstill code";
  const plan = planStreamCommit(source, null);
  assert.equal(plan.consumed, 0, "must not split inside an open fence");
}

// Closed fence followed by a blank line commits the whole block
{
  const source = "```ts\ncode\n```\n\nafter text";
  const plan = planStreamCommit(source, null);
  assert.equal(source.slice(plan.consumed), "after text");
  assert.match(plan.commitText, /^```ts\ncode\n```$/);
}

// Re-opened fence: pending starts inside a fence from a previous commit
{
  const plan = planStreamCommit("more code\n```\n\ndone", "```py");
  assert.equal(plan.openFenceAfter, null);
  assert.match(plan.commitText, /^```py\nmore code\n```$/);
}

// Force-commit: giant single block splits at a line boundary, fence re-opens
{
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
  const source = "```\n" + lines.join("\n");
  const plan = planStreamCommit(source, null, { maxLiveLines: 40, keepLiveLines: 10 });
  assert.ok(plan.consumed > 0, "giant fence should force-commit");
  assert.equal(plan.openFenceAfter, "```", "fence state carries into the live tail");
}

assert.equal(collapseWhitespace("  a\n\n b\tc  "), "a b c");

// ===========================================================================
// planFinishCommit (tool-interrupt flush)
// ===========================================================================

// Dangling fragment ("#" before a tool call) is HELD, not committed
{
  const plan = planFinishCommit("#", null);
  assert.equal(plan.consumed, 0, "lone fragment must stay live");
}
{
  const plan = planFinishCommit("Now I'll", null);
  assert.equal(plan.consumed, 0, "unfinished clause must stay live");
}

// Complete sentence flushes fully
{
  const plan = planFinishCommit("Let me check the file.", null);
  assert.equal(plan.consumed, "Let me check the file.".length);
  assert.equal(plan.commitText, "Let me check the file.");
}

// Multi-line with dangling last line: flush complete lines, hold the tail
{
  const source = "First paragraph done.\nNow I'll";
  const plan = planFinishCommit(source, null);
  assert.equal(source.slice(plan.consumed), "Now I'll");
  assert.equal(plan.commitText, "First paragraph done.");
}

// Long single line flushes even without terminal punctuation
{
  const longLine = "x".repeat(80);
  const plan = planFinishCommit(longLine, null);
  assert.equal(plan.consumed, 80);
}

// ===========================================================================
// InkChatAdapter integration
// ===========================================================================

// Short response: one part, header shown, /copy intact
{
  const adapter = makeAdapter();
  adapter.beginTurn();
  adapter.startAssistantMessage();
  adapter.appendAssistantChunk("hello world");
  adapter.finishAssistantMessage();
  adapter.settleAssistantMessage("hello world");
  adapter.endTurn();

  const assistant = messagesOf(adapter).filter((m) => m.role === "assistant");
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].content, "hello world");
  assert.ok(!assistant[0].isContinuation, "single part keeps its header");
  assert.equal(adapter.getLastAssistantContent(), "hello world");
  adapter.destroy();
}

// Multi-paragraph response: split into parts, continuation after the first
{
  const adapter = makeAdapter();
  adapter.beginTurn();
  adapter.startAssistantMessage();
  adapter.appendAssistantChunk("first paragraph\n\nsecond paragraph\n\nthird");
  adapter.finishAssistantMessage();
  adapter.settleAssistantMessage("first paragraph\n\nsecond paragraph\n\nthird");
  adapter.endTurn();

  const assistant = messagesOf(adapter).filter((m) => m.role === "assistant");
  assert.ok(assistant.length >= 2, "long response splits into parts");
  assert.ok(!assistant[0].isContinuation, "first part has the header");
  for (const part of assistant.slice(1)) {
    assert.ok(part.isContinuation, "later parts are continuations");
  }
  assert.equal(
    adapter.getLastAssistantContent(),
    "first paragraph\n\nsecond paragraph\n\nthird",
    "/copy reconstructs the full response"
  );
  adapter.destroy();
}

// Tool interrupt: preceding text lands in scrollback BEFORE the tool row
{
  const adapter = makeAdapter();
  adapter.beginTurn();
  adapter.startAssistantMessage();
  adapter.appendAssistantChunk("Let me check the file.");
  adapter.finishAssistantMessage(); // tool batch starting
  adapter.addTool("read_file", { path: "src/x.ts" }, "tc-1");
  adapter.completeTool("read_file", true, "tc-1");
  adapter.appendToolMessage("read_file", "file contents", false, {
    toolCallId: "tc-1",
    details: { durationMs: 120 },
  });
  adapter.startAssistantMessage(); // streaming resumes
  adapter.appendAssistantChunk("The file looks fine.");
  adapter.finishAssistantMessage();
  adapter.settleAssistantMessage("Let me check the file.\n\nThe file looks fine.");
  adapter.endTurn();

  const messages = messagesOf(adapter);
  const introIdx = messages.findIndex((m) => m.content.includes("Let me check"));
  const toolIdx = messages.findIndex((m) => m.role === "tool");
  const followIdx = messages.findIndex((m) => m.content.includes("looks fine"));
  assert.ok(introIdx >= 0 && toolIdx >= 0 && followIdx >= 0, "all pieces present");
  assert.ok(introIdx < toolIdx, "intro text precedes the tool row");
  assert.ok(toolIdx < followIdx, "tool row precedes the follow-up text");
  assert.ok(
    messages[followIdx].isContinuation,
    "post-tool text continues the same block (no duplicate header)"
  );
  assert.equal(
    adapter.getLastAssistantContent(),
    "Let me check the file.\n\nThe file looks fine."
  );
  adapter.destroy();
}

// Settled content that never streamed still lands in the transcript
{
  const adapter = makeAdapter();
  adapter.beginTurn();
  adapter.startAssistantMessage();
  adapter.appendAssistantChunk("streamed text");
  adapter.finishAssistantMessage();
  adapter.settleAssistantMessage("completely different settled text");
  adapter.endTurn();

  assert.equal(
    adapter.getLastAssistantContent(),
    "completely different settled text",
    "/copy returns the settled content"
  );
  const assistant = messagesOf(adapter).filter((m) => m.role === "assistant");
  assert.ok(
    assistant.some((m) => m.content.includes("completely different")),
    "unstreamed settle content is pushed"
  );
  adapter.destroy();
}

// Dangling fragment before a tool call: never stranded as its own piece in
// scrollback (the Screenshot-2026-06-11 "#" bug)
{
  const adapter = makeAdapter();
  adapter.beginTurn();
  adapter.startAssistantMessage();
  adapter.appendAssistantChunk("#");
  adapter.finishAssistantMessage(); // tool batch starting — "#" must be held
  {
    const assistant = messagesOf(adapter).filter((m) => m.role === "assistant");
    assert.equal(assistant.length, 0, "fragment is not committed to scrollback");
  }
  adapter.appendToolMessage("read_file", "contents", false, {
    toolCallId: "tc-frag",
    details: { durationMs: 50 },
  });
  adapter.startAssistantMessage(); // streaming resumes
  adapter.appendAssistantChunk("Here's the plan.");
  adapter.finishAssistantMessage();
  adapter.settleAssistantMessage("#\n\nHere's the plan.");
  adapter.endTurn();

  const assistant = messagesOf(adapter).filter((m) => m.role === "assistant");
  assert.ok(
    !assistant.some((m) => m.content.trim() === "#"),
    "no assistant piece contains only the stranded fragment"
  );
  assert.ok(
    assistant.some((m) => m.content.includes("Here's the plan.")),
    "resumed text is present"
  );
  assert.equal(adapter.getLastAssistantContent(), "#\n\nHere's the plan.");
  adapter.destroy();
}

// Code fence streaming: parts never split an open fence at paragraph bounds
{
  const adapter = makeAdapter();
  adapter.beginTurn();
  adapter.startAssistantMessage();
  adapter.appendAssistantChunk("Here is code:\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nDone.");
  adapter.finishAssistantMessage();
  adapter.settleAssistantMessage("Here is code:\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nDone.");
  adapter.endTurn();

  const assistant = messagesOf(adapter).filter((m) => m.role === "assistant");
  const codePart = assistant.find((m) => m.content.includes("```ts"));
  assert.ok(codePart, "code part exists");
  assert.match(
    codePart!.content,
    /```ts\nconst a = 1;\n\nconst b = 2;\n```/,
    "fence stays intact in one part"
  );
  adapter.destroy();
}

console.error = _origConsoleError;
console.log("stream-commit verification passed");
