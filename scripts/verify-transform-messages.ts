/**
 * Verifies the shared OpenAI message transform (@meer/ai/providers/transform-messages).
 *
 * This is the single converter now used by the OpenAI provider and the
 * OpenRouter provider (and, by inheritance, DeepSeek / Together / Opencode). It
 * encodes two subtle, easy-to-regress rules:
 *   - an orphan tool_result (no matching tool_call) becomes a `user` message,
 *     never a mid-conversation `system` message (Anthropic/Bedrock/Vertex reject
 *     inline system), and
 *   - reasoning-replay turns a plain assistant message into a `system`
 *     "Previous assistant response" message, but only when opted in.
 */

import assert from "node:assert/strict";
import type { AgentMessage } from "@meer/ai/types.js";
import {
  buildOpenAIUserContent,
  convertAgentMessagesToOpenAI,
} from "@meer/ai/providers/transform-messages.js";

type Row = { role: string; content: unknown; tool_call_id?: string; tool_calls?: unknown };

// ── A matched tool_call → tool_result becomes role "tool" ────────────────────
{
  const messages: AgentMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "do it" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "run", input: { x: 1 } }],
    },
    { role: "tool_result", toolCallId: "call_1", toolName: "run", content: "ok" },
  ];
  const out = convertAgentMessagesToOpenAI(messages) as Row[];
  assert.deepEqual(out.map((m) => m.role), ["system", "user", "assistant", "tool"]);
  assert.equal(out[3].tool_call_id, "call_1", "matched tool result keeps tool_call_id");
  assert.equal(out[3].content, "ok");
}

// ── An orphan tool_result (no matching call) becomes a USER message ──────────
{
  const messages: AgentMessage[] = [
    { role: "user", content: "hi" },
    { role: "tool_result", toolCallId: "ghost", toolName: "grep", content: "stuff", isError: true },
  ];
  const out = convertAgentMessagesToOpenAI(messages) as Row[];
  assert.deepEqual(out.map((m) => m.role), ["user", "user"], "orphan tool result is a user message, never system");
  assert.match(String(out[1].content), /Previous tool result \(grep, error\)/);
}

// ── reasoning-replay only rewrites plain assistant turns when opted in ───────
{
  const messages: AgentMessage[] = [{ role: "assistant", content: "the answer" }];

  const off = convertAgentMessagesToOpenAI(messages) as Row[];
  assert.equal(off[0].role, "assistant", "default keeps assistant role");

  const on = convertAgentMessagesToOpenAI(messages, { reasoningReplay: true }) as Row[];
  assert.equal(on[0].role, "system", "reasoningReplay rewrites a plain assistant turn to system");
  assert.match(String(on[0].content), /^Previous assistant response:/);

  // A tool-call assistant turn is NOT rewritten even with replay on.
  const withTools: AgentMessage[] = [
    { role: "assistant", content: "", toolCalls: [{ id: "c", name: "n", input: {} }] },
  ];
  const onTools = convertAgentMessagesToOpenAI(withTools, { reasoningReplay: true }) as Row[];
  assert.equal(onTools[0].role, "assistant", "tool-call turns are never replayed as system");
}

// ── buildOpenAIUserContent: plain string vs multi-part with images ───────────
{
  assert.equal(buildOpenAIUserContent("just text"), "just text", "no attachments → plain string");
  const parts = buildOpenAIUserContent("look", [
    { kind: "image", mimeType: "image/png", source: { type: "base64", data: "AAAA" } },
  ]) as Array<{ type: string }>;
  assert.ok(Array.isArray(parts), "with an image → multi-part array");
  assert.deepEqual(parts.map((p) => p.type), ["text", "image_url"]);
}

console.log("transform-messages verification passed");
