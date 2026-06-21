/**
 * Verifies the faux provider drives the real agent loop deterministically.
 *
 * This is the safety-net substrate for the package split (docs/ARCHITECTURE.md):
 * once the agent loop can be exercised with no network and no shelling out, we
 * can move it between packages and trust the tests to catch regressions.
 *
 * The key assertion is on `provider.calls` — the exact message list that
 * reached the model on each turn — which is what pins conversation-history bugs
 * (a tool result must be fed back; a prior answer must NOT be re-sent as a new
 * user turn).
 */

import assert from "node:assert/strict";
import { runLoop } from "@meer-ai/agent/loop.js";
import type { AgentEvent, AgentMessage, AgentTool } from "@meer-ai/agent/types.js";
import { FauxProvider } from "@meer-ai/ai/faux.js";

function userMsg(content: string): AgentMessage {
  return { role: "user", content, timestamp: Date.now() };
}

/** A trivial echo tool so the loop has something to execute. */
const echoTool: AgentTool = {
  name: "echo",
  description: "Echo the provided text back.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  async execute(_id, input) {
    return { content: `echoed: ${String((input as { text?: string }).text ?? "")}` };
  },
};

async function drain(events: AgentEvent[], provider: FauxProvider, messages: AgentMessage[]) {
  return runLoop(
    messages,
    [echoTool],
    provider,
    { systemPrompt: "you are a test agent", maxTurns: 8 },
    (event) => {
      events.push(event);
    }
  );
}

// ── A tool call then a final answer: results must feed back into turn 2 ───────
{
  const provider = new FauxProvider([
    // Turn 1: call the echo tool.
    {
      toolCalls: [{ id: "call-1", name: "echo", input: { text: "hi" } }],
    },
    // Turn 2: final text answer.
    { text: "All done.", usage: { promptTokens: 10, completionTokens: 3 } },
  ]);

  const events: AgentEvent[] = [];
  const newMessages = await drain(events, provider, [userMsg("please echo hi")]);

  // The loop produced: assistant(tool call) → tool_result → assistant(text).
  const roles = newMessages.map((m) => m.role);
  assert.deepEqual(
    roles,
    ["assistant", "tool_result", "assistant"],
    "loop yields assistant tool-call, tool result, then final assistant text"
  );
  const finalText = newMessages.at(-1);
  assert.equal(finalText?.role, "assistant");
  assert.equal(
    (finalText as Extract<AgentMessage, { role: "assistant" }>).content,
    "All done.",
    "final assistant text is the scripted turn-2 answer"
  );
  const toolResult = newMessages[1] as Extract<AgentMessage, { role: "tool_result" }>;
  assert.equal(toolResult.content, "echoed: hi", "echo tool executed for real");

  // The provider saw two calls; the second must include the tool result so the
  // model can react to it. This is the message-plumbing invariant the whole
  // migration must preserve.
  assert.equal(provider.calls.length, 2, "model was called once per turn");
  const secondCallRoles = provider.calls[1].map((m) => m.role);
  assert.ok(
    secondCallRoles.includes("tool_result"),
    "the tool result is fed back into the model on the next turn"
  );

  // Streaming + tool lifecycle events surfaced.
  assert.ok(events.some((e) => e.type === "tool_start"), "tool_start emitted");
  assert.ok(events.some((e) => e.type === "tool_end"), "tool_end emitted");
  assert.ok(events.some((e) => e.type === "text_delta"), "assistant text streamed as deltas");
}

// ── Plain answer, no tools: a single model call, no phantom turns ────────────
{
  const provider = new FauxProvider([{ text: "Paris." }]);
  const events: AgentEvent[] = [];
  const newMessages = await drain(events, provider, [userMsg("capital of France?")]);

  assert.deepEqual(newMessages.map((m) => m.role), ["assistant"], "single assistant turn");
  assert.equal(provider.calls.length, 1, "exactly one model call for a tool-free answer");
}

// ── transformContext shapes the model call without mutating loop state ───────
{
  const provider = new FauxProvider([{ text: "ok" }]);
  const events: AgentEvent[] = [];
  const newMessages = await runLoop(
    [userMsg("hello")],
    [echoTool],
    provider,
    {
      systemPrompt: "sys",
      maxTurns: 4,
      // Inject a marker only into what the model sees.
      transformContext: (messages) => [
        ...messages,
        { role: "system", content: "INJECTED-MARKER", timestamp: Date.now() },
      ],
    },
    (event) => events.push(event)
  );

  // The model saw the injected marker...
  const sawMarker = provider.calls[0].some(
    (m) => m.role === "system" && m.content === "INJECTED-MARKER"
  );
  assert.ok(sawMarker, "transformContext output reaches the provider");

  // ...but it never leaked into the durable conversation (loop messages stay canonical).
  const leaked = newMessages.some((m) => m.content === "INJECTED-MARKER");
  assert.ok(!leaked, "transformContext does not mutate the loop's own messages");
}

console.log("faux-provider verification passed");
