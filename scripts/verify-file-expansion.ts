/**
 * Lock down generalized file expansion.
 *
 * `extractFileReferencesFromText` returns image AND text-file references
 * with their kind; `inlineTextFile` renders text references as
 * <file path="…">…</file> blocks with per-file and cumulative byte caps.
 *
 * Together these let users drop arbitrary file paths into the composer
 * and have the agent see the contents — same shortcut pi has via its
 * `processFileArguments` flow.
 */

import { mkdirSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  extractFileReferencesFromText,
  extractImagePathsFromText,
  inlineTextFile,
  isTextFilePath,
} from "@meer/ai/attachments.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// Tiny PNG header bytes are good enough — we just need a file with an
// image extension that exists on disk.
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000005000100" +
    "0d0a2db40000000049454e44ae426082",
  "hex"
);

const workDir = join(tmpdir(), `meer-fileexp-${randomUUID()}`);
mkdirSync(workDir, { recursive: true });

const imagePath = join(workDir, "diagram.png");
const tsPath = join(workDir, "module.ts");
const mdPath = join(workDir, "README.md");
const envPath = join(workDir, ".env");
const lockPath = join(workDir, "package-lock.json");
const bigPath = join(workDir, "huge.log");

writeFileSync(imagePath, PNG_BYTES);
writeFileSync(tsPath, "export const x = 1;\n");
writeFileSync(mdPath, "# Hello\nThis is a doc.\n");
writeFileSync(envPath, "SECRET=hunter2\n");
writeFileSync(lockPath, "{}\n");
writeFileSync(bigPath, "x".repeat(250 * 1024)); // 250KB > per-file cap (100KB)

// --- isTextFilePath -------------------------------------------------------
assert(isTextFilePath("foo.ts"), "ts is a text file");
assert(isTextFilePath("README.md"), "md is a text file");
assert(!isTextFilePath("foo.png"), "png is NOT a text file (it's an image)");
assert(!isTextFilePath(".env"), "env is NOT auto-inlined (secret risk)");
// .json IS on the allowlist — the size cap is what protects against
// huge lockfiles, not the extension check. Same for .yaml/.toml.
assert(isTextFilePath("package-lock.json"), "any .json is text");
assert(!isTextFilePath("binary"), "no extension → not text");
assert(!isTextFilePath("image.unknownext"), "unknown ext → not text");

// --- extractFileReferencesFromText classifies kinds correctly -------------
{
  const text = `look at ${tsPath} and ${imagePath} please`;
  const { files, residualText } = extractFileReferencesFromText(text, workDir);
  assert(files.length === 2, `detected 2 files (got ${files.length})`);
  const kinds = files.map((f) => f.kind).sort();
  assert(
    kinds[0] === "image" && kinds[1] === "text",
    `kinds: ${kinds.join(",")}`
  );
  assert(
    residualText === "look at and please",
    `residual text stripped (got "${residualText}")`
  );
}

// --- Backward-compat wrapper still returns image-only --------------------
{
  const text = `${tsPath} ${imagePath}`;
  const { paths } = extractImagePathsFromText(text, workDir);
  assert(paths.length === 1, "image-only wrapper returns one path");
  assert(paths[0] === imagePath, "the image path");
}

// --- inlineTextFile renders correct wrapper ------------------------------
{
  const refs = extractFileReferencesFromText(`see ${mdPath}`, workDir);
  const ref = refs.files[0];
  const result = inlineTextFile(ref);
  assert(result !== null, "got a block");
  assert(
    (result as { block: string }).block.startsWith(`<file path="${mdPath}">`),
    "starts with <file> wrapper"
  );
  assert(
    (result as { block: string }).block.includes("# Hello"),
    "contents inlined"
  );
  assert(
    (result as { block: string }).block.endsWith("</file>"),
    "ends with </file>"
  );
}

// --- inlineTextFile enforces per-file cap with tail-keeping --------------
{
  const refs = extractFileReferencesFromText(`see ${bigPath}`, workDir);
  const ref = refs.files[0];
  const result = inlineTextFile(ref);
  assert(result !== null, "oversized file still inlines");
  const block = (result as { block: string }).block;
  assert(block.includes("truncated"), "truncation note present");
  assert(
    Buffer.byteLength(block, "utf8") < 200 * 1024,
    "tail keeps the block under ~200KB"
  );
}

// --- inlineTextFile rejects after cumulative budget exhausted ------------
{
  const refs = extractFileReferencesFromText(`see ${tsPath}`, workDir);
  const ref = refs.files[0];
  const result = inlineTextFile(ref, { bytesUsedSoFar: 500 * 1024 });
  assert(result === null, "blocked once budget exhausted");
}

// --- inlineTextFile rejects image references -----------------------------
{
  const refs = extractFileReferencesFromText(`see ${imagePath}`, workDir);
  const ref = refs.files[0];
  const result = inlineTextFile(ref);
  assert(result === null, "image refs aren't inlined as text");
}

// Cleanup
unlinkSync(imagePath);
unlinkSync(tsPath);
unlinkSync(mdPath);
unlinkSync(envPath);
unlinkSync(lockPath);
unlinkSync(bigPath);
rmSync(workDir, { recursive: true, force: true });

console.log("file expansion verification passed");
