#!/usr/bin/env node
/**
 * Publishes the meer monorepo to npm, in dependency order, idempotently.
 *
 * Why a script (not plain `pnpm -r publish`): we need to (1) publish in a
 * strict order so each `workspace:*` dependency already exists on npm when the
 * next package references it, (2) SKIP any package@version already published
 * (so a re-run after a partial failure is safe), and (3) enforce that all
 * packages share one version (lockstep) before anything goes out.
 *
 * We shell out to `pnpm publish` (not `npm publish`) because only pnpm rewrites
 * the `workspace:*` protocol into the concrete version when packing.
 *
 *   node scripts/publish.mjs            # publish (provenance auto-on in CI)
 *   node scripts/publish.mjs --dry-run  # pack + validate, publish nothing
 *
 * Assumes `pnpm run build` already ran (CI does this); publishes built dist.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Dependency order: a package is published only after everything it depends on.
// The root `meerai` (thin bin → @meer-ai/coding-agent) goes last.
const packages = [
  { dir: "packages/core", needsDist: true },
  { dir: "packages/ai", needsDist: true },
  { dir: "packages/agent", needsDist: true },
  { dir: "packages/tui", needsDist: true },
  { dir: "packages/coding-agent", needsDist: true },
  { dir: ".", needsDist: false }, // meerai (publishes bin/, not dist/)
];

const dryRun = process.argv.includes("--dry-run");
// Provenance needs npm's OIDC, which only exists in CI (id-token: write).
const provenance = process.env.CI === "true" || process.argv.includes("--provenance");

function manifest(dir) {
  return JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8"));
}

function isPublished(name, version) {
  try {
    execFileSync("npm", ["view", `${name}@${version}`, "version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// ── Lockstep guard ───────────────────────────────────────────────────────────
const manifests = packages.map((p) => ({ ...p, json: manifest(p.dir) }));
const versions = [...new Set(manifests.map((m) => m.json.version))];
if (versions.length !== 1) {
  console.error(
    `Refusing to publish: packages are not lockstep-versioned: ${manifests
      .map((m) => `${m.json.name}@${m.json.version}`)
      .join(", ")}`
  );
  process.exit(1);
}
const version = versions[0];
console.log(`Publishing meer @ ${version}${dryRun ? " (dry run)" : ""}${provenance ? " [provenance]" : ""}\n`);

// ── dist guard ───────────────────────────────────────────────────────────────
for (const m of manifests) {
  if (m.needsDist && !existsSync(join(repoRoot, m.dir, "dist"))) {
    console.error(`${m.dir}/dist is missing — run \`pnpm run build\` first.`);
    process.exit(1);
  }
}

// ── Publish in order, skipping already-published versions ────────────────────
for (const m of manifests) {
  const { name } = m.json;
  if (isPublished(name, version)) {
    console.log(`• ${name}@${version} already published — skipping.`);
    continue;
  }
  const args = ["publish", "--access", "public", "--no-git-checks"];
  if (provenance) args.push("--provenance");
  if (dryRun) args.push("--dry-run");
  console.log(`→ publishing ${name}@${version} …`);
  execFileSync("pnpm", args, { cwd: join(repoRoot, m.dir), stdio: "inherit" });
}

console.log(`\nDone${dryRun ? " (dry run)" : ""}.`);
