#!/usr/bin/env node
/**
 * Parallel test runner for the verify-*.ts suite.
 *
 * Replaces the 48-script `&&` chain in package.json. Each verify script is an
 * isolated `tsx` process (so global-state mutations like process.env.HOME don't
 * cross-contaminate), which makes running them concurrently safe. Wall-clock
 * drops from ~40s (48 serial cold starts) to a few seconds, bounded by the
 * slowest script and the concurrency pool rather than the sum.
 *
 * Discovery is by glob (`scripts/verify-*.ts`), so a new verify script is picked
 * up automatically — no need to append it to a list. Exits non-zero if any
 * script fails, printing the failing scripts' output last.
 *
 *   node scripts/run-verifications.mjs            # all
 *   node scripts/run-verifications.mjs trust mcp  # only names matching a filter
 */

import { spawn } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

// Resolve the local tsx bin so the runner works whether invoked via the npm
// script (PATH has node_modules/.bin) or directly with `node`.
const tsxBin = (() => {
  const local = join(repoRoot, "node_modules", ".bin", "tsx");
  return existsSync(local) ? local : "tsx";
})();

const filters = process.argv.slice(2);
const scripts = readdirSync(here)
  .filter((f) => /^verify-.*\.ts$/.test(f))
  .filter((f) => filters.length === 0 || filters.some((needle) => f.includes(needle)))
  .sort();

if (scripts.length === 0) {
  console.error(`No verify-*.ts scripts matched ${JSON.stringify(filters)}`);
  process.exit(1);
}

// A new tsx process per script is memory-hungry (each loads esbuild), so cap
// concurrency to the core count rather than launching all 48 at once.
const POOL = Math.max(2, Math.min(scripts.length, cpus().length));

// A script that passes its assertions but never exits (a leaked timer/handle)
// would otherwise hang the whole suite — and `pnpm publish` — forever. Cap each
// script so a hang becomes a loud failure instead.
const PER_SCRIPT_TIMEOUT_MS = 90_000;

const runOne = (script) =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(tsxBin, [join("scripts", script)], {
      cwd: repoRoot,
      env: process.env,
    });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PER_SCRIPT_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ script, code: 1, ms: Date.now() - startedAt, out: `${out}\n${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          script,
          code: 1,
          ms: Date.now() - startedAt,
          out: `${out}\n[runner] killed after ${PER_SCRIPT_TIMEOUT_MS / 1000}s — script did not exit (leaked handle? missing process.exit?)`,
        });
        return;
      }
      resolve({ script, code: code ?? 1, ms: Date.now() - startedAt, out });
    });
  });

const results = [];
let next = 0;
const startedAt = Date.now();

async function worker() {
  while (next < scripts.length) {
    const script = scripts[next++];
    const result = await runOne(script);
    results.push(result);
    const tag = result.code === 0 ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    const done = String(results.length).padStart(2);
    console.log(`${tag} [${done}/${scripts.length}] ${result.script} (${(result.ms / 1000).toFixed(1)}s)`);
  }
}

await Promise.all(Array.from({ length: POOL }, worker));

const failures = results.filter((r) => r.code !== 0);
const totalS = ((Date.now() - startedAt) / 1000).toFixed(1);

if (failures.length > 0) {
  console.error(`\n${"─".repeat(60)}`);
  for (const failure of failures) {
    console.error(`\n\x1b[31mFAILED: ${failure.script}\x1b[0m`);
    console.error(failure.out.trimEnd());
  }
  console.error(`\n\x1b[31m${failures.length}/${scripts.length} verify scripts failed\x1b[0m (${totalS}s)`);
  process.exit(1);
}

console.log(`\n\x1b[32mAll ${scripts.length} verify scripts passed\x1b[0m (${totalS}s, pool=${POOL})`);
