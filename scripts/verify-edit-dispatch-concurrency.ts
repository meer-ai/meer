import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editFileSections, applyEdit } from "@meer-ai/coding-agent/tools/index.js";
import { withFileMutationQueue } from "@meer-ai/coding-agent/tools/file-mutation-queue.js";

const dir = mkdtempSync(join(tmpdir(), "meer-editdisp-"));
const file = join(dir, "src.txt");
const relFile = "src.txt";
writeFileSync(file, "line-one\nline-two\n", "utf-8");

// Two disjoint edits issued concurrently, each computed against current
// disk content then written — mirroring the dispatch read→compute→write.
async function runEdit(oldText: string, newText: string): Promise<void> {
  await withFileMutationQueue(file, async () => {
    const edit = editFileSections(relFile, [{ oldText, newText }], dir);
    if (edit.error) throw new Error(edit.error);
    await new Promise((r) => setTimeout(r, 5)); // widen race window
    const res = applyEdit(edit, dir);
    if (res.error) throw new Error(res.error);
  });
}

await Promise.all([
  runEdit("line-one", "LINE-ONE"),
  runEdit("line-two", "LINE-TWO"),
]);

const out = readFileSync(file, "utf-8");
assert.equal(out, "LINE-ONE\nLINE-TWO\n", `lost update: ${JSON.stringify(out)}`);

console.log("edit dispatch concurrency verification passed");
