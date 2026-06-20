/**
 * Guard against `require(...)` in ESM source.
 *
 * meer ships as ESM ("type": "module"). `tsc` passes `require()` calls through
 * literally, so any bare `require(...)` throws "require is not defined" at
 * runtime — but our tsx-based verify scripts run with a require shim and never
 * see it. This regression bit `run_command` (agent.ts used require() for the
 * shell-cd helper), breaking every shell command in the published build.
 *
 * Rule: a source file may use `require(` ONLY if it sets up a CommonJS shim via
 * `createRequire(import.meta.url)`. Otherwise it must use static/dynamic import.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = fileURLToPath(new URL("../packages/coding-agent/src", import.meta.url));

// `require(` followed by a string/backtick — i.e. an actual module load.
const REQUIRE_CALL = /(^|[^.\w])require\s*\(\s*["'`]/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const violations: string[] = [];

for (const file of walk(SRC_DIR)) {
  const text = readFileSync(file, "utf8");
  const hasShim = text.includes("createRequire(");
  if (hasShim) continue; // file legitimately bridges to CommonJS

  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    // Skip comments.
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      return;
    }
    if (REQUIRE_CALL.test(line)) {
      violations.push(`${file}:${i + 1}: ${trimmed}`);
    }
  });
}

if (violations.length > 0) {
  console.error(
    "verify-no-bare-require: found require() in ESM source without a createRequire shim:\n" +
      violations.map((v) => `  ${v}`).join("\n") +
      "\n\nUse a static `import`, a dynamic `import()`, or set up " +
      "`const require = createRequire(import.meta.url)` for sync CJS loads."
  );
  process.exit(1);
}

console.log("verify-no-bare-require: no bare require() in ESM source");
