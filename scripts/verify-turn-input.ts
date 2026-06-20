/**
 * Verifies how a turn's message list is assembled from conversation history.
 *
 * Regression for "the agent re-answers the previous question before the new
 * one": a plain conversational follow-up must NOT inject a "Recent Evidence"
 * system block that re-feeds the previous answer. The earlier answer is already
 * present as a proper assistant turn; restating it ahead of the new question
 * made the model treat the follow-up as a continuation and re-answer the prior
 * question first (especially on Anthropic, where a mid-conversation system
 * message is replayed as a user message).
 */

import assert from "node:assert/strict";
import type { AgentMessage } from "../src/agent/core/types.js";
import {
  buildRecentEvidenceSummary,
  prepareTurnInput,
} from "../src/agent/session-heuristics.js";

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

// ── Plain conversational follow-up: no evidence block, no re-fed answer ──────
{
  const history: AgentMessage[] = [
    userMsg("What is the capital of France?"),
    assistantMsg("The capital of France is Paris."),
  ];

  assert.equal(
    buildRecentEvidenceSummary(history, "What about Germany?"),
    null,
    "a tool-free history must not produce a Recent Evidence block"
  );

  const prepared = prepareTurnInput(history, "What about Germany?", "anthropic", "claude-x");
  assert.equal(prepared.length, 3, "no system evidence block should be inserted");
  assert.deepEqual(
    prepared.map((m) => m.role),
    ["user", "assistant", "user"],
    "history should be [user, assistant, user] with the new question last"
  );
  const combined = prepared.map((m) => m.content).join("\n");
  assert.ok(
    !combined.includes("Recent Evidence"),
    "the previous answer must not be re-fed as evidence on a plain follow-up"
  );
  assert.equal(prepared[2].content, "What about Germany?", "new question is the trailing user message");
}

// ── Tool-using history: evidence block IS injected (tool results only) ───────
{
  const history: AgentMessage[] = [
    userMsg("Audit the repo for issues."),
    toolResultMsg("grep", "found 3 TODO markers in src/"),
    assistantMsg("I found some TODOs."),
  ];

  const summary = buildRecentEvidenceSummary(history, "now fix them");
  assert.ok(summary, "a tool-using history should still produce an evidence block");
  assert.ok(summary!.includes("Recent Evidence"), "evidence block keeps its header");
  assert.ok(summary!.includes("grep"), "evidence block summarizes recent tool results");
  assert.ok(
    !summary!.includes("Latest assistant conclusions"),
    "the previous answer must never be re-fed as a conclusions section"
  );

  const prepared = prepareTurnInput(history, "now fix them", "anthropic", "claude-x");
  assert.equal(
    prepared.filter((m) => m.role === "system").length,
    1,
    "exactly one system evidence block is inserted for tool flows"
  );
  assert.equal(prepared.at(-1)?.content, "now fix them", "new question stays trailing");
}

console.log("turn-input assembly verification passed");
