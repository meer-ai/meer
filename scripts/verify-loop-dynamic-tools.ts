import assert from "node:assert/strict";
import { runLoop } from "@meer-ai/agent/loop.js";
import type { AgentTool } from "@meer-ai/agent/types.js";
import type { ChatMessage, Provider, ProviderEvent } from "@meer-ai/ai/base.js";

// Turn 1 → call tool_a; turn 2 → call tool_b; turn 3 → finish.
class TwoStepProvider implements Provider {
  calls = 0;
  async chat(_m: ChatMessage[]): Promise<string> { return "unused"; }
  async *stream(_m: ChatMessage[]): AsyncIterable<string> { yield "unused"; }
  async *streamWithTools(): AsyncIterable<ProviderEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      const id = "a";
      yield { type: "tool-call", toolCall: { id, name: "tool_a", input: {} } };
      yield { type: "done", rawText: "", turn: { assistantMessage: "", rawText: "", toolCalls: [{ id, name: "tool_a", input: {} }] } };
      return;
    }
    if (this.calls === 2) {
      const id = "b";
      yield { type: "tool-call", toolCall: { id, name: "tool_b", input: {} } };
      yield { type: "done", rawText: "", turn: { assistantMessage: "", rawText: "", toolCalls: [{ id, name: "tool_b", input: {} }] } };
      return;
    }
    yield { type: "text-delta", text: "done" };
    yield { type: "done", rawText: "done" };
  }
}

let aRan = false;
const toolA: AgentTool = {
  name: "tool_a", description: "a",
  inputSchema: { type: "object", properties: {} },
  async execute() { aRan = true; return { content: "a-ran" }; },
};
const toolB: AgentTool = {
  name: "tool_b", description: "b",
  inputSchema: { type: "object", properties: {} },
  async execute() { return { content: "b-ran" }; },
};

// tool_b only becomes available AFTER tool_a has run — proves the loop
// re-reads the resolver between turns.
const resolver = () => (aRan ? [toolA, toolB] : [toolA]);

const provider = new TwoStepProvider();
const messages = await runLoop(
  [{ role: "user", content: "go" }],
  resolver,
  provider,
  { systemPrompt: "test", maxTurns: 5 },
  async () => {},
);
const contents = messages
  .filter((m) => m.role === "tool_result")
  .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
assert.ok(contents.some((c) => c.includes("a-ran")), "tool_a runs on turn 1");
assert.ok(contents.some((c) => c.includes("b-ran")), "tool_b callable on turn 2 (resolver re-read)");

// Backward-compat: the array form still executes tools.
aRan = false;
const arrProvider = new TwoStepProvider();
const arrMessages = await runLoop(
  [{ role: "user", content: "go" }],
  [toolA, toolB],
  arrProvider,
  { systemPrompt: "test", maxTurns: 5 },
  async () => {},
);
assert.ok(
  arrMessages.filter((m) => m.role === "tool_result").length >= 1,
  "array form still executes tools",
);

console.log("loop dynamic tools verification passed");
