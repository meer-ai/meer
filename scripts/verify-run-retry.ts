/**
 * Regression: headless `meer run` must auto-retry transient provider failures,
 * matching the interactive CLI's AgentSession retry.
 *
 * Bug: headless called `agent.processMessage` directly (no AgentSession), so a
 * one-off first-request timeout (common with DeepSeek's cold TLS connect)
 * failed the whole run. Consumers like meer-code spawn a fresh `meer run` per
 * turn, so every follow-up hit the same cold-start timeout with no recovery.
 *
 * This drives `runHeadless` with a provider that throws a retryable
 * connect-timeout once, then succeeds — and asserts the run recovers.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FauxProvider } from "@meer-ai/ai/faux.js";
import type { AgentMessage, ProviderEvent, ToolDefinition } from "@meer-ai/ai/base.js";
import { runHeadless } from "@meer-ai/coding-agent/commands/run.js";

const cwd = mkdtempSync(join(tmpdir(), "meer-run-retry-"));
const retry = { attempts: 3, delayMs: 0, backoffFactor: 1 };

const DEEPSEEK_TIMEOUT =
  "provider deepseek tool stream failed Target: model deepseek-chat Reason: " +
  "fetch failed · cause: Connect Timeout Error " +
  "(attempted address: api.deepseek.com:443, timeout: 10000ms)";

/** Throws a retryable connect-timeout for its first `failures` turns, then replays the script. */
class FlakyProvider extends FauxProvider {
  callCount = 0;
  constructor(turns: { text?: string }[], private failures: number) {
    super(turns);
  }
  async *streamWithTools(
    messages: AgentMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal
  ): AsyncIterable<ProviderEvent> {
    this.callCount += 1;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error(DEEPSEEK_TIMEOUT);
    }
    yield* super.streamWithTools(messages, tools, signal);
  }
}

function sinks() {
  const out: string[] = [];
  const err: string[] = [];
  const push = (acc: string[]) => (chunk: string) => {
    for (const part of chunk.split("\n")) if (part.trim()) acc.push(part.trim());
  };
  return { out, err, write: push(out), writeErr: push(err) };
}

// ── 1) One transient timeout → retried → succeeds with exit 0 ────────────────
{
  const provider = new FlakyProvider([{ text: "Recovered." }], 1);
  const { out, err, write, writeErr } = sinks();
  const exitCode = await runHeadless(
    ["hi"],
    { yes: true, json: true, cwd, maxSteps: 4 },
    { provider, providerType: "faux", model: "faux", retry, write, writeErr, handleSignals: false }
  );
  assert.equal(exitCode, 0, "headless run recovers from a transient provider timeout");
  assert.equal(provider.callCount, 2, "the model was called twice (fail, then retry)");
  const events = out.map((l) => JSON.parse(l) as { type: string; exitCode?: number });
  assert.equal(events.at(-1)?.type, "run.completed", "stream ends with run.completed");
  assert.equal(events.at(-1)?.exitCode, 0, "run.completed reports exit 0 after retry");
  assert.ok(
    events.some((e) => e.type === "assistant.delta" || e.type === "assistant.message"),
    "assistant text surfaced after the retry"
  );
  assert.ok(err.some((l) => /retry/i.test(l)), "a retry notice was written to stderr");
  // The retried (recovered) attempt must NOT emit a terminal run.error — that's
  // what made meer-code show a failure and stop mid-retry.
  assert.ok(
    !events.some((e) => e.type === "run.error"),
    "no run.error is emitted when the retry recovers"
  );
}

// ── 2) Failures exceed attempts → throws (caller maps to run.error/exit 1) ────
{
  const provider = new FlakyProvider([{ text: "never" }], 99);
  const { write, writeErr } = sinks();
  let threw = false;
  try {
    await runHeadless(
      ["hi"],
      { yes: true, json: true, cwd, maxSteps: 4 },
      { provider, providerType: "faux", model: "faux", retry, write, writeErr, handleSignals: false }
    );
  } catch {
    threw = true;
  }
  assert.ok(threw, "exhausted retries surface as a thrown error");
  assert.equal(provider.callCount, retry.attempts + 1, "tried initial + N retries, then gave up");
}

// ── 3) Non-retryable error → NOT retried (fails fast, single attempt) ─────────
{
  class AuthFail extends FauxProvider {
    callCount = 0;
    async *streamWithTools(): AsyncIterable<ProviderEvent> {
      this.callCount += 1;
      throw new Error("authentication rejected: bad credentials");
    }
  }
  const provider = new AuthFail([{ text: "x" }]);
  const { write, writeErr } = sinks();
  let threw = false;
  try {
    await runHeadless(
      ["hi"],
      { yes: true, json: true, cwd, maxSteps: 4 },
      { provider, providerType: "faux", model: "faux", retry, write, writeErr, handleSignals: false }
    );
  } catch {
    threw = true;
  }
  assert.ok(threw, "non-retryable error fails the run");
  assert.equal(provider.callCount, 1, "a non-retryable error is not retried");
}

// ── 4) No retry config (injected runs default) → no retry on transient error ──
{
  const provider = new FlakyProvider([{ text: "unused" }], 1);
  const { write, writeErr } = sinks();
  let threw = false;
  try {
    await runHeadless(
      ["hi"],
      { yes: true, json: true, cwd, maxSteps: 4 },
      { provider, providerType: "faux", model: "faux", write, writeErr, handleSignals: false }
    );
  } catch {
    threw = true;
  }
  assert.ok(threw, "without a retry config the transient error is not retried");
  assert.equal(provider.callCount, 1, "no retry config → single attempt");
}

console.log("run-retry verification passed");

// runHeadless drives a real MeerAgent with open handles and never calls
// process.exit (the CLI action owns that) — exit explicitly like the CLI does.
process.exit(0);
