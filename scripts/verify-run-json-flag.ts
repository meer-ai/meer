/**
 * Regression: `meer run --json` must actually emit NDJSON on stdout.
 *
 * `--json`, `--model`, and `--cwd` are declared on BOTH the top-level program
 * (for `meer --print`) and the `run` subcommand. Because of that name
 * collision, Commander assigned `--json` (written after the subcommand, as
 * `meer run --json`) to the PARENT program, leaving the run command's
 * `options.json` false — so headless silently ran in TEXT mode. meer-code
 * spawns exactly `meer run --json …` and parses NDJSON, skipping every
 * non-`{` line; in text mode it saw zero events and the turn hung
 * ("works for some seconds then stops"). The run action now merges the global
 * opts so the flag is honored after the subcommand too.
 *
 * This drives the REAL CLI (commander parsing + action), which the
 * runHeadless-level tests deliberately bypass.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const binMeer = join(repoRoot, "bin", "meer.js");

// No prompt + --json → the run command exits fast (no network) and, when JSON
// mode is honored, emits run.error + run.completed as NDJSON on stdout. Uses
// meer-code's exact flag ordering: `run --json --yes --cwd <dir>`.
const run = spawnSync(
  process.execPath,
  [binMeer, "run", "--json", "--yes", "--cwd", repoRoot],
  { cwd: repoRoot, encoding: "utf8" }
);

const stdout = run.stdout ?? "";
const lines = stdout
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean);

assert.ok(
  lines.length > 0,
  `expected NDJSON on stdout, got nothing (text mode?). stderr: ${run.stderr}`
);

const events = lines.map((l) => {
  try {
    return JSON.parse(l) as { type?: string; exitCode?: number };
  } catch {
    return assert.fail(`stdout line is not JSON (text mode leaked): ${l}`);
  }
});

assert.ok(
  events.some((e) => e.type === "run.error"),
  "run --json emits a JSON run.error for a missing prompt"
);
const completed = events.find((e) => e.type === "run.completed");
assert.ok(completed, "run --json emits a JSON run.completed");
assert.equal(completed?.exitCode, 1, "missing-prompt run completes with exitCode 1");

console.log("run-json-flag verification passed");
