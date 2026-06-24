import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "@meer-ai/coding-agent/tools/file-mutation-queue.js";

const dir = mkdtempSync(join(tmpdir(), "meer-mutq-"));
const file = join(dir, "counter.txt");
writeFileSync(file, "0\n", "utf-8");

// Two concurrent read-modify-write operations on the SAME file.
// Each reads the current line count and appends one line. Without
// serialization they race on the stale read and one append is lost.
async function appendLine(tag: string): Promise<void> {
  await withFileMutationQueue(file, async () => {
    const current = readFileSync(file, "utf-8");
    // Yield to the event loop to widen the race window.
    await new Promise((r) => setTimeout(r, 5));
    writeFileSync(file, current + tag + "\n", "utf-8");
  });
}

await Promise.all([appendLine("a"), appendLine("b"), appendLine("c")]);

const lines = readFileSync(file, "utf-8").trim().split("\n");
// Original "0" plus three appends, none lost.
assert.equal(lines.length, 4, `expected 4 lines, got ${lines.length}: ${JSON.stringify(lines)}`);
assert.deepEqual(new Set(lines.slice(1)), new Set(["a", "b", "c"]));

// Different files run concurrently (no deadlock / no cross-file blocking).
const fileX = join(dir, "x.txt");
const fileY = join(dir, "y.txt");
let yStarted = false;
const xPromise = withFileMutationQueue(fileX, async () => {
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(yStarted, true, "different-file op should not be blocked by another file's lock");
});
const yPromise = withFileMutationQueue(fileY, async () => {
  yStarted = true;
});
await Promise.all([xPromise, yPromise]);

console.log("file-mutation-queue verification passed");
