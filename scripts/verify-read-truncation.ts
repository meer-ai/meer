import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "../src/tools/index.js";
import { truncateHead, truncateTail } from "../src/tools/truncate.js";

const dir = mkdtempSync(join(tmpdir(), "meer-read-test-"));

try {
  // --- Small file: read fully, no truncation note ---
  writeFileSync(join(dir, "small.txt"), "hello\nworld\n");
  {
    const result = readFile("small.txt", dir);
    assert.equal(result.error, undefined);
    assert.match(result.result, /hello\nworld/);
    assert.doesNotMatch(result.result, /Truncated/);
  }

  // --- Huge file: truncated with continuation hint ---
  const bigLines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`);
  writeFileSync(join(dir, "big.txt"), bigLines.join("\n"));
  {
    const result = readFile("big.txt", dir);
    assert.equal(result.error, undefined);
    assert.match(result.result, /line 1\n/);
    assert.match(result.result, /Truncated/);
    assert.match(result.result, /offset=/);
    assert.doesNotMatch(result.result, /line 4999/);
    assert.ok(result.details?.truncation, "truncation details should be set");
  }

  // --- Offset/limit pagination ---
  {
    const result = readFile("big.txt", dir, { offset: 100, limit: 3 });
    assert.equal(result.error, undefined);
    assert.match(result.result, /line 100\nline 101\nline 102/);
    assert.doesNotMatch(result.result, /line 103/);
    assert.match(result.result, /lines 100-102 of 5000/);
  }

  // --- Offset beyond EOF errors cleanly ---
  {
    const result = readFile("big.txt", dir, { offset: 99999 });
    assert.match(result.error ?? "", /beyond the end/);
  }

  // --- Byte-limit truncation (few but enormous lines) ---
  const wideLines = Array.from({ length: 50 }, () => "x".repeat(10_000));
  writeFileSync(join(dir, "wide.txt"), wideLines.join("\n"));
  {
    const result = readFile("wide.txt", dir);
    assert.match(result.result, /Truncated/);
    assert.ok(
      Buffer.byteLength(result.result, "utf8") < 120 * 1024,
      "result should respect the byte cap"
    );
  }

  // --- truncate helpers ---
  {
    const head = truncateHead("a\nb\nc\n", { maxLines: 2 });
    assert.equal(head.content, "a\nb");
    assert.equal(head.truncated, true);
    assert.equal(head.truncatedBy, "lines");

    const tail = truncateTail("a\nb\nc\n", { maxLines: 2 });
    assert.equal(tail.content, "b\nc");
    assert.equal(tail.truncated, true);

    const noop = truncateHead("a\nb\n");
    assert.equal(noop.truncated, false);
    assert.equal(noop.content, "a\nb\n");
  }

  console.log("✅ read_file truncation, pagination, and truncate helpers work.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
