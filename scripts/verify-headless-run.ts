/**
 * End-to-end test of the headless runner with NO TUI, NO network, NO bin spawn.
 *
 * Drives `runHeadless` (the core shared by `meer run` and `meer --print`) with
 * the faux provider injected and a capturing stdout sink, then asserts the
 * emitted `--json` event stream. This is the first true end-to-end exercise of
 * headless mode through @meer-ai/coding-agent — config injection → MeerAgent →
 * the run-events emitter → the wire — the same path meer-code and the cloud
 * agent depend on.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FauxProvider } from "@meer-ai/ai/faux.js";
import { runHeadless } from "@meer-ai/coding-agent/commands/run.js";

const cwd = mkdtempSync(join(tmpdir(), "meer-headless-"));

// Capture the stdout JSON stream; discard stderr diagnostics.
const lines: string[] = [];
const write = (chunk: string) => {
  for (const part of chunk.split("\n")) {
    if (part.trim()) lines.push(part.trim());
  }
};

// A single scripted text turn — deterministic, no tools, no side effects.
const provider = new FauxProvider([{ text: "All done." }]);

const exitCode = await runHeadless(
  ["say hi"],
  { yes: true, json: true, cwd, maxSteps: 4 },
  {
    provider,
    providerType: "faux",
    model: "faux-model",
    write,
    writeErr: () => {},
    handleSignals: false,
  }
);

assert.equal(exitCode, 0, "headless run exits 0 for a clean faux turn");

const events = lines.map((l) => JSON.parse(l) as { type: string; [k: string]: unknown });
assert.ok(events.length >= 2, "emitted a JSON event stream");

for (const e of events) {
  assert.equal(typeof e.timestamp, "string", "every event carries a timestamp");
  assert.equal(typeof e.type, "string", "every event has a type");
}

const first = events[0];
assert.equal(first.type, "run.started", "stream starts with run.started");
assert.equal(first.protocolVersion, 1, "run.started carries the protocol version");
assert.equal(first.provider, "faux", "run.started reflects the injected provider");
assert.equal(first.model, "faux-model", "run.started reflects the injected model");

const last = events.at(-1);
assert.equal(last?.type, "run.completed", "stream ends with run.completed");
assert.equal(last?.exitCode, 0, "run.completed reports exitCode 0");

assert.ok(
  events.some((e) => e.type === "assistant.delta" || e.type === "assistant.message"),
  "assistant text surfaced as a delta or message"
);

// ── A missing prompt fails closed with a clean JSON error, exit 1 ────────────
{
  const errLines: string[] = [];
  const errWrite = (chunk: string) => {
    for (const part of chunk.split("\n")) if (part.trim()) errLines.push(part.trim());
  };
  const code = await runHeadless(
    [],
    { yes: true, json: true, cwd, maxSteps: 4 },
    {
      provider: new FauxProvider([{ text: "unused" }]),
      providerType: "faux",
      write: errWrite,
      writeErr: () => {},
      handleSignals: false,
    }
  );
  assert.equal(code, 1, "no prompt → exit 1");
  const evs = errLines.map((l) => JSON.parse(l) as { type: string; exitCode?: number });
  assert.equal(evs.at(-1)?.type, "run.completed", "error path still ends with run.completed");
  assert.equal(evs.at(-1)?.exitCode, 1, "run.completed reports exitCode 1");
  assert.ok(evs.some((e) => e.type === "run.error"), "a run.error precedes completion");
}

console.log("headless-run verification passed");

// runHeadless drives a real MeerAgent, which holds open handles (the injectable
// core deliberately never calls process.exit — the CLI action owns that, see
// commands/run.ts and cli.ts). So this test must exit explicitly, exactly as
// the production CLI does, or the process lingers until its handles drain.
process.exit(0);
