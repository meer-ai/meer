import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { BoundedOutputBuffer } from "@meer/coding-agent/tools/output-accumulator.js";
import { runCommand } from "@meer/coding-agent/tools/index.js";

// --- Small output stays fully in memory, no spill file ---
{
  const buf = new BoundedOutputBuffer({ maxTailBytes: 1024 });
  buf.append("hello\n");
  buf.append("world\n");
  assert.equal(buf.tailText, "hello\nworld\n");
  assert.equal(buf.totalBytes, 12);
  assert.equal(buf.totalLines, 2);
  assert.equal(buf.isTrimmed, false);
  assert.equal(buf.fullOutputPath, undefined);
  await buf.close();
}

// --- Large output: memory bounded, complete output preserved on disk ---
{
  const buf = new BoundedOutputBuffer({ maxTailBytes: 4096 });
  const line = "x".repeat(99) + "\n"; // 100 bytes per line
  for (let i = 0; i < 1000; i++) {
    buf.append(`${i}:${line}`);
  }
  assert.ok(
    Buffer.byteLength(buf.tailText, "utf8") <= 8192,
    "in-memory tail must stay bounded"
  );
  assert.equal(buf.totalLines, 1000);
  assert.equal(buf.isTrimmed, true);
  assert.ok(buf.fullOutputPath, "spill file should exist");
  await buf.close();

  const spilled = readFileSync(buf.fullOutputPath!, "utf8");
  assert.match(spilled, /^0:x/, "spill file must contain output from byte 0");
  assert.match(spilled, /999:x/, "spill file must contain the final output");
  // Exactly 1000 lines and no duplicated chunks around the spill point
  const spilledLines = spilled.split("\n").filter(Boolean);
  assert.equal(spilledLines.length, 1000, "spill file must not duplicate chunks");
  for (let i = 0; i < 1000; i++) {
    assert.ok(
      spilledLines[i].startsWith(`${i}:`),
      `spill file line ${i} should be in order, got: ${spilledLines[i].slice(0, 12)}`
    );
  }
  rmSync(buf.fullOutputPath!, { force: true });
}

// --- Tail starts at a line boundary after trimming ---
{
  const buf = new BoundedOutputBuffer({ maxTailBytes: 200 });
  for (let i = 0; i < 100; i++) {
    buf.append(`line-${String(i).padStart(4, "0")}\n`);
  }
  const tail = buf.tailText;
  assert.match(tail, /^line-\d{4}\n/, "tail should start at a line boundary");
  await buf.close();
  if (buf.fullOutputPath) rmSync(buf.fullOutputPath, { force: true });
}

// --- Counting partial (unterminated) last line ---
{
  const buf = new BoundedOutputBuffer();
  buf.append("a\nb\nc");
  assert.equal(buf.totalLines, 3);
  buf.append("\n");
  assert.equal(buf.totalLines, 3);
  await buf.close();
}

// --- runCommand still works end-to-end with bounded buffers ---
{
  const result = await runCommand(
    "node -e \"process.stdout.write('bounded-ok')\"",
    process.cwd(),
    { silent: true }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.result.trim(), "bounded-ok");
}

// --- runCommand with large output: result truncated, full output on disk ---
{
  const result = await runCommand(
    `node -e "for (let i = 0; i < 3000; i++) console.log('out-' + i)"`,
    process.cwd(),
    { silent: true }
  );
  assert.equal(result.error, undefined);
  assert.match(result.result, /Showing last \d+ of \d+ lines/);
  const fullOutputPath = (result.details as Record<string, unknown>)
    ?.fullOutputPath as string | undefined;
  assert.ok(fullOutputPath, "full output path should be reported");
  assert.ok(existsSync(fullOutputPath), "full output file should exist");
  const full = readFileSync(fullOutputPath, "utf8");
  assert.match(full, /out-0\b/);
  assert.match(full, /out-2999/);
  rmSync(fullOutputPath, { force: true });
}

console.log("✅ Bounded output accumulator and runCommand integration work.");
