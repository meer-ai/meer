#!/usr/bin/env node
/**
 * Lockstep version setter for the meer monorepo.
 *
 * Writes the same version into the root `meerai` package and every
 * `packages/*` workspace package. The packages depend on each other via
 * `workspace:*`, so they MUST ship at one identical version — otherwise the
 * published `meerai` pins a `@meer/coding-agent` version that doesn't exist
 * (exactly the bug that broke `npm i -g meerai`).
 *
 *   node scripts/set-version.mjs 0.6.39
 *   node scripts/set-version.mjs patch    # bump root's patch, apply to all
 *   node scripts/set-version.mjs minor
 *   node scripts/set-version.mjs major
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}
function write(file, json) {
  writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
}

function bump(version, kind) {
  const [maj, min, pat] = version.split(".").map(Number);
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  if (kind === "patch") return `${maj}.${min}.${pat + 1}`;
  return null;
}

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: node scripts/set-version.mjs <version|patch|minor|major>");
  process.exit(1);
}

const rootFile = join(repoRoot, "package.json");
const root = read(rootFile);
const target = ["patch", "minor", "major"].includes(arg) ? bump(root.version, arg) : arg;

if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(target)) {
  console.error(`Invalid version: ${target}`);
  process.exit(1);
}

const packagesDir = join(repoRoot, "packages");
const files = [
  rootFile,
  ...readdirSync(packagesDir).map((name) => join(packagesDir, name, "package.json")),
];

for (const file of files) {
  const json = read(file);
  json.version = target;
  write(file, json);
  console.log(`${json.name} → ${target}`);
}

console.log(`\nAll packages set to ${target} (lockstep).`);
