/**
 * Lock down real provider token-usage plumbing.
 *
 * When a provider's `done` event carries `usage`, the agent loop must surface it
 * as a `usage` AgentEvent so the session tracker can record billed tokens and
 * cost (footer shows "tok"/"$" instead of the "~ctx" estimate).
 */

import assert from "node:assert/strict";
import { runLoop } from "@meer/agent/loop.js";
import type { AgentEvent } from "@meer/agent/types.js";
import type { ChatMessage, Provider, ProviderEvent } from "@meer/ai/base.js";
import { SessionTracker } from "@meer/coding-agent/session/tracker.js";

class UsageProvider implements Provider {
  async chat(): Promise<string> {
    return "unused";
  }
  async *stream(): AsyncIterable<string> {
    yield "unused";
  }
  async *streamWithTools(_messages: ChatMessage[]): AsyncIterable<ProviderEvent> {
    yield { type: "text-delta", text: "done thinking" };
    yield {
      type: "done",
      rawText: "done thinking",
      usage: { promptTokens: 1200, completionTokens: 340 },
    };
  }
}

// --- loop surfaces usage as an AgentEvent ----------------------------------
{
  const events: AgentEvent[] = [];
  await runLoop(
    [{ role: "user", content: "hello" }],
    [],
    new UsageProvider(),
    { systemPrompt: "test" },
    async (event) => {
      events.push(event);
    }
  );

  const usageEvents = events.filter((e) => e.type === "usage");
  assert.equal(usageEvents.length, 1, "exactly one usage event emitted");
  const u = usageEvents[0] as Extract<AgentEvent, { type: "usage" }>;
  assert.equal(u.promptTokens, 1200, "prompt tokens surfaced");
  assert.equal(u.completionTokens, 340, "completion tokens surfaced");
}

// --- a provider that reports no usage emits no usage event -----------------
{
  class NoUsageProvider implements Provider {
    async chat(): Promise<string> {
      return "x";
    }
    async *stream(): AsyncIterable<string> {
      yield "x";
    }
    async *streamWithTools(): AsyncIterable<ProviderEvent> {
      yield { type: "done", rawText: "x" };
    }
  }
  const events: AgentEvent[] = [];
  await runLoop(
    [{ role: "user", content: "hi" }],
    [],
    new NoUsageProvider(),
    { systemPrompt: "test" },
    async (event) => {
      events.push(event);
    }
  );
  assert.ok(!events.some((e) => e.type === "usage"), "no usage event without provider usage");
}

// --- tracker accumulates usage into billed tokens + cost -------------------
{
  const tracker = new SessionTracker("openai", "gpt-4o");
  assert.equal(tracker.getTokenUsage().total, 0, "starts at zero");
  tracker.trackPromptTokens(1200);
  tracker.trackCompletionTokens(340);
  // A second request bills its full prompt again — usage accumulates.
  tracker.trackPromptTokens(1500);
  tracker.trackCompletionTokens(200);
  const usage = tracker.getTokenUsage();
  assert.equal(usage.prompt, 2700, "prompt tokens accumulate across requests");
  assert.equal(usage.completion, 540, "completion tokens accumulate");
  assert.equal(usage.total, 3240, "total is prompt+completion");
}

console.log("verify-usage-tracking: all assertions passed");
