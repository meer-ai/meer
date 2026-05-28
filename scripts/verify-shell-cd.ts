/**
 * Lock the leading-cd parser used by C1 (persistent shell cwd).
 *
 * `run_command` calls extractLeadingCd before spawning a shell so the
 * agent's `cd foo` then `npm test` works the same way you'd type it in
 * a real shell — even though each tool invocation spawns fresh. The
 * parser handles common chains and bails on shapes it doesn't recognise
 * rather than silently mis-interpreting them.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractLeadingCd } from "../src/utils/shell-cd.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

const root = mkdtempSync(join(tmpdir(), "meer-shellcd-"));
const subA = join(root, "a");
const subAB = join(subA, "b");
const subC = join(root, "c");
import { mkdirSync } from "node:fs";
mkdirSync(subAB, { recursive: true });
mkdirSync(subC, { recursive: true });

// --- Bare cd → newCwd set, remainingCommand empty ------------------------
{
  const r = extractLeadingCd(`cd ${subA}`, root);
  assert(r.newCwd === subA, `bare cd absolute → ${r.newCwd}`);
  assert(r.remainingCommand === "", "no remaining command");
  assert(!r.error, "no error");
}

// --- Relative cd resolved against starting cwd ---------------------------
{
  const r = extractLeadingCd("cd a", root);
  assert(r.newCwd === subA, `relative cd resolved (got ${r.newCwd})`);
}

// --- cd && tail → cwd set, tail preserved --------------------------------
{
  const r = extractLeadingCd(`cd ${subA} && npm test`, root);
  assert(r.newCwd === subA, "cwd from leading cd");
  assert(r.remainingCommand === "npm test", `tail preserved (got "${r.remainingCommand}")`);
}

// --- Chained cd's all apply ----------------------------------------------
{
  const r = extractLeadingCd(`cd ${subA} && cd b && ls`, root);
  assert(r.newCwd === subAB, `chained cd lands at ${subAB} (got ${r.newCwd})`);
  assert(r.remainingCommand === "ls", "tail after chain");
}

// --- Semicolon separator handled -----------------------------------------
{
  const r = extractLeadingCd(`cd ${subA}; npm test`, root);
  assert(r.newCwd === subA, "semicolon separator");
  assert(r.remainingCommand === "npm test", "tail after semicolon");
}

// --- No-cd command → newCwd is null --------------------------------------
{
  const r = extractLeadingCd("npm test", root);
  assert(r.newCwd === null, "no cd → newCwd null");
  assert(r.remainingCommand === "npm test", "command unchanged");
}

// --- Trailing cd (after &&) is NOT peeled --------------------------------
// We deliberately only handle leading cd's so the parse is predictable.
{
  const r = extractLeadingCd(`echo hi && cd ${subA}`, root);
  assert(r.newCwd === null, "trailing cd not lifted");
  assert(
    r.remainingCommand === `echo hi && cd ${subA}`,
    "command preserved verbatim"
  );
}

// --- cd to missing dir → error, cwd NOT advanced --------------------------
{
  const missing = join(root, "definitely-missing-xyz");
  const r = extractLeadingCd(`cd ${missing} && rm -rf /`, root);
  assert(r.error !== undefined, "error surfaced");
  assert(r.newCwd === null, "no partial cd commit");
  assert(
    r.remainingCommand.includes("rm -rf"),
    "tail preserved so caller can decide what to do"
  );
}

// --- cd to a file (not directory) → error ---------------------------------
{
  // Create a file under root and try to cd into it.
  const { writeFileSync } = await import("node:fs");
  const filePath = join(root, "afile.txt");
  writeFileSync(filePath, "x");
  const r = extractLeadingCd(`cd ${filePath}`, root);
  assert(r.error !== undefined, "non-directory rejected");
}

// --- cd ~ expands to home -------------------------------------------------
{
  const { homedir } = await import("node:os");
  const r = extractLeadingCd("cd ~", root);
  assert(r.newCwd === homedir(), "bare tilde");
}

// --- cd with unsupported shape (e.g. `cd /a foo bar`) bails gracefully ---
{
  // After consuming `cd /a `, the rest is `foo bar` with no separator —
  // we leave it alone for the shell to interpret (it'll just be invalid).
  // The cd portion that IS valid still applies (we already advanced).
  const r = extractLeadingCd(`cd ${subA} foo bar`, root);
  assert(r.newCwd === subA, "valid leading cd still applies");
  assert(
    r.remainingCommand.startsWith("foo bar"),
    `unrecognised tail preserved (got "${r.remainingCommand}")`
  );
}

rmSync(root, { recursive: true, force: true });
console.log("shell-cd verification passed");
