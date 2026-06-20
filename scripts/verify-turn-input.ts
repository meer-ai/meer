/**
 * Verifies how a turn's message list is assembled from conversation history.
 *
 * Regression for "the agent re-answers the previous question before the new
 * one". The original fix narrowed a synthesized "Recent Evidence" system block;
 * the structural fix (Phase 3) removed that injection entirely. `prepareTurnInput`
 * now keeps the message history canonical and simply appends the new user
 * question — no synthesized system blocks, ever. Host-specific context shaping
 * belongs behind the loop's `transformContext` seam, not baked in here.
 */

import assert from "node:assert/strict";
import type { AgentMessage } from "@meer/agent/types.js";
import { prepareTurnInput } from "../src/agent/session-heuristics.js";

function userMsg(content: string): AgentMessage {
  return { role: "user", content, timestamp: Date.now() };
}
function assistantMsg(content: string): AgentMessage {
  return { role: "assistant", content, timestamp: Date.now() };
}
function toolResultMsg(toolName: string, content: string): AgentMessage {
  return {
    role: "tool_result",
    toolCallId: `${toolName}-1`,
    toolName,
    content,
    isError: false,
    timestamp: Date.now(),
  };
}

function assertNoSynthesizedBlocks(prepared: AgentMessage[], history: AgentMessage[], question: string): void {
  // The output is exactly the history followed by the new user question.
  assert.equal(prepared.length, history.length + 1, "exactly one message appended (the question)");
  assert.equal(prepared.at(-1)?.role, "user", "new question is the trailing user message");
  assert.equal(prepared.at(-1)?.content, question, "trailing message is the question text");
  const combined = prepared.map((m) => m.content).join("\n");
  assert.ok(!combined.includes("Recent Evidence"), "no synthesized 'Recent Evidence' block");
  assert.ok(!combined.includes("Latest assistant conclusions"), "the prior answer is never re-fed");
}

// ── Plain conversational follow-up: canonical history, nothing injected ──────
{
  const history: AgentMessage[] = [
    userMsg("What is the capital of France?"),
    assistantMsg("The capital of France is Paris."),
  ];
  const prepared = prepareTurnInput(history, "What about Germany?", "anthropic", "claude-x");
  assert.deepEqual(
    prepared.map((m) => m.role),
    ["user", "assistant", "user"],
    "history stays [user, assistant, user] with the new question last"
  );
  assertNoSynthesizedBlocks(prepared, history, "What about Germany?");
}

// ── Tool-using history: STILL no synthesized system block ────────────────────
// (Previously this path injected a "Recent Evidence" block; it no longer does.)
{
  const history: AgentMessage[] = [
    userMsg("Audit the repo for issues."),
    toolResultMsg("grep", "found 3 TODO markers in src/"),
    assistantMsg("I found some TODOs."),
  ];
  const prepared = prepareTurnInput(history, "now fix them", "anthropic", "claude-x");
  assert.equal(
    prepared.filter((m) => m.role === "system").length,
    0,
    "no system block is synthesized even for tool flows — the tool_result is already in history"
  );
  assertNoSynthesizedBlocks(prepared, history, "now fix them");
}

console.log("turn-input assembly verification passed");
