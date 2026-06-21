/**
 * Verifies that the live plan (the task panel) is persisted to the session and
 * restored on resume — so an unfinished plan picks up where it left off.
 *
 * Regression: plan state lived only in an in-memory `planStore` singleton, so
 * `meer --resume` showed an empty panel and lost the in-progress plan. Plans
 * are now appended to the session JSONL as `type: "plan"` entries; the latest
 * one wins on load.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempHome = mkdtempSync(join(tmpdir(), "meer-session-plan-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const { Memory } = await import("@meer-ai/coding-agent/memory/index.js");
const memory = new Memory();

const cwd = join(tempHome, "project");
mkdirSync(cwd, { recursive: true });

const started = memory.startSession(cwd);

// ── No plan recorded yet → null ──────────────────────────────────────────────
assert.equal(memory.loadLatestPlan(started.sessionPath), null, "no plan recorded yet");

const planV1 = {
  title: "Build Calendar View",
  tasks: [
    { id: "t1", description: "Create component", status: "completed" as const },
    { id: "t2", description: "Integrate into dashboard", status: "in_progress" as const },
    { id: "t3", description: "Add animations", status: "pending" as const },
  ],
  createdAt: 1,
  updatedAt: 1,
};
memory.recordPlan(planV1, cwd);

// ── A later snapshot supersedes the earlier one ──────────────────────────────
const planV2 = {
  ...planV1,
  tasks: planV1.tasks.map((t) =>
    t.id === "t2"
      ? { ...t, status: "completed" as const }
      : t.id === "t3"
        ? { ...t, status: "in_progress" as const }
        : t
  ),
  updatedAt: 2,
};
memory.recordPlan(planV2, cwd);

const latest = memory.loadLatestPlan(started.sessionPath);
assert.ok(latest, "latest plan is restored");
assert.equal(latest.title, "Build Calendar View", "title round-trips");
assert.equal(latest.tasks.length, 3, "all tasks restored");
assert.equal(
  latest.tasks.find((t) => t.id === "t2")?.status,
  "completed",
  "latest snapshot wins (t2 completed)"
);
assert.equal(
  latest.tasks.find((t) => t.id === "t3")?.status,
  "in_progress",
  "latest snapshot wins (t3 in_progress)"
);

// ── Plan survives an actual resume (openSession) ─────────────────────────────
const resumed = memory.resumeSession(started.sessionPath);
assert.ok(resumed, "session resumes");
assert.equal(
  memory.loadLatestPlan(resumed.sessionPath)?.tasks.length,
  3,
  "plan intact after resume"
);

// ── Clearing the plan is recorded and wins ───────────────────────────────────
memory.recordPlan(null, cwd);
assert.equal(memory.loadLatestPlan(started.sessionPath), null, "a cleared plan returns null");

console.log("session-plan verification passed");
