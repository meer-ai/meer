/**
 * Locks the `meer run --json` headless event protocol
 * (@meer/coding-agent/runtime/run-events).
 *
 * This NDJSON stream is a live integration contract: meer-code's provider
 * adapter (apps/server/.../MeerAdapter.ts) switches on each event's `type` and
 * reads the fields asserted below. A rename here is a silent break there, so
 * this test pins the exact wire shape. Adding new optional fields / new event
 * types is fine (consumers ignore unknowns) — renaming or dropping is not.
 */

import assert from "node:assert/strict";
import {
  createRunEventEmitter,
  RUN_PROTOCOL_VERSION,
  type RunEvent,
} from "@meer/coding-agent/runtime/run-events.js";

type Line = Record<string, unknown> & { type: string; timestamp: string };

function capture(events: RunEvent[]): Line[] {
  const lines: string[] = [];
  const emitter = createRunEventEmitter((chunk) => {
    for (const part of chunk.split("\n")) {
      if (part.trim()) lines.push(part);
    }
  });
  for (const event of events) emitter.emit(event);
  return lines.map((l) => JSON.parse(l) as Line);
}

// ── Every event is one NDJSON line stamped with an ISO timestamp ─────────────
{
  const out = capture([
    { type: "assistant.started" },
    { type: "assistant.completed" },
  ]);
  assert.equal(out.length, 2, "one JSON line per event");
  for (const e of out) {
    assert.equal(typeof e.timestamp, "string", "every event carries a timestamp");
    assert.ok(!Number.isNaN(Date.parse(e.timestamp)), "timestamp is an ISO date");
  }
}

// ── run.started carries the protocol version meer-code can detect ────────────
{
  const [e] = capture([
    {
      type: "run.started",
      protocolVersion: RUN_PROTOCOL_VERSION,
      provider: "anthropic",
      model: "claude",
      cwd: "/repo",
      maxSteps: 50,
    },
  ]);
  assert.equal(e.type, "run.started");
  assert.equal(e.protocolVersion, RUN_PROTOCOL_VERSION, "version stamped on run.started");
  assert.equal(RUN_PROTOCOL_VERSION, 1, "current protocol version is 1");
  assert.equal(e.provider, "anthropic");
  assert.equal(e.cwd, "/repo");
}

// ── Assistant streaming events keep their exact field names ──────────────────
{
  const out = capture([
    { type: "assistant.delta", delta: "hel" },
    { type: "assistant.message", content: "hello" },
  ]);
  assert.equal(out[0].delta, "hel", "assistant.delta uses `delta`");
  assert.equal(out[1].content, "hello", "assistant.message uses `content`");
}

// ── reasoning.message uses `content` ─────────────────────────────────────────
{
  const [e] = capture([{ type: "reasoning.message", content: "thinking…" }]);
  assert.equal(e.type, "reasoning.message");
  assert.equal(e.content, "thinking…");
}

// ── Tool events: meer-code reads `tool`, `args`, `result`, `metadata.isError` ─
{
  const out = capture([
    { type: "tool.started", tool: "bash", args: { command: "ls" } },
    {
      type: "tool.message",
      tool: "bash",
      result: "file.txt",
      metadata: { isError: false },
    },
  ]);
  assert.equal(out[0].tool, "bash", "tool.started uses `tool`");
  assert.deepEqual(out[0].args, { command: "ls" }, "tool.started uses `args`");
  assert.equal(out[1].result, "file.txt", "tool.message uses `result`");
  assert.deepEqual(out[1].metadata, { isError: false }, "tool.message uses `metadata`");
  assert.equal(
    (out[1].metadata as { isError: boolean }).isError,
    false,
    "metadata.isError is the error flag meer-code reads"
  );
}

// ── run.error / run.completed keep `message` / `exitCode` ─────────────────────
{
  const out = capture([
    { type: "run.error", message: "boom" },
    { type: "run.completed", exitCode: 1 },
  ]);
  assert.equal(out[0].message, "boom", "run.error uses `message`");
  assert.equal(out[1].exitCode, 1, "run.completed uses `exitCode`");
}

console.log("run-protocol verification passed");
