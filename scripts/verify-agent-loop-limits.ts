import assert from "node:assert/strict";
import { runLoop } from "../src/agent/core/loop.js";
import type { AgentTool } from "../src/agent/core/types.js";
import type {
  ChatMessage,
  Provider,
  ProviderEvent,
} from "@meer/ai/base.js";

class ProgressProvider implements Provider {
  calls = 0;

  async chat(_messages: ChatMessage[]): Promise<string> {
    return "unused";
  }

  async *stream(_messages: ChatMessage[]): AsyncIterable<string> {
    yield "unused";
  }

  async *streamWithTools(messages: any[]): AsyncIterable<ProviderEvent> {
    this.calls += 1;
    const toolResults = messages.filter((message) => message.role === "tool_result");
    if (toolResults.length >= 30) {
      yield { type: "text-delta", text: "finished after sustained progress" };
      yield { type: "done", rawText: "finished after sustained progress" };
      return;
    }

    const id = `tool-${this.calls}`;
    yield {
      type: "tool-call",
      toolCall: {
        id,
        name: "progress_tool",
        input: { step: this.calls },
      },
    };
    yield {
      type: "done",
      rawText: "",
      turn: {
        assistantMessage: "",
        rawText: "",
        toolCalls: [{ id, name: "progress_tool", input: { step: this.calls } }],
      },
    };
  }
}

const progressTool: AgentTool = {
  name: "progress_tool",
  description: "Returns unique progress.",
  inputSchema: {
    type: "object",
    properties: {
      step: { type: "number" },
    },
  },
  async execute(_toolCallId, input) {
    return { content: `progress:${input.step}` };
  },
};

const provider = new ProgressProvider();
const messages = await runLoop(
  [{ role: "user", content: "keep going while progress happens" }],
  [progressTool],
  provider,
  { systemPrompt: "test" },
  async () => {},
);

const toolResults = messages.filter((message) => message.role === "tool_result");
const finalAssistant = [...messages]
  .reverse()
  .find((message) => message.role === "assistant");

assert.equal(toolResults.length, 30, "loop should not stop at the old 25-turn default");
assert.equal(
  finalAssistant?.content,
  "finished after sustained progress",
  "loop should continue until the model produces a final answer"
);
assert(provider.calls > 25, "provider should be called beyond the old implicit cap");

const cappedProvider = new ProgressProvider();
const cappedMessages = await runLoop(
  [{ role: "user", content: "respect explicit cap" }],
  [progressTool],
  cappedProvider,
  { systemPrompt: "test", maxTurns: 3 },
  async () => {},
);

assert.equal(
  cappedMessages.filter((message) => message.role === "tool_result").length,
  3,
  "explicit maxTurns should still act as a safety cap"
);

console.log("agent loop limit verification passed");
