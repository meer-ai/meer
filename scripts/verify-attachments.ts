/**
 * Round-trip the attachment helpers.
 *
 *  - saveAttachmentBytes + readAttachmentBase64 produce matching bytes
 *  - attachmentFromFile points at a real file with the right MIME
 *  - extractImagePathsFromText pulls a path out of typed text and removes it
 *  - oversized buffers throw before reaching a provider
 */

import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  attachmentFromFile,
  extractImagePathsFromText,
  extensionForMimeType,
  mimeTypeForExtension,
  readAttachmentBase64,
  saveAttachmentBytes,
} from "@meer/ai/attachments.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// A tiny in-memory PNG (1x1 transparent). Good enough for byte-equality tests.
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000005000100" +
    "0d0a2db40000000049454e44ae426082",
  "hex"
);

// --- MIME helpers ----------------------------------------------------------
assert(mimeTypeForExtension(".png") === "image/png", "png mime");
assert(mimeTypeForExtension(".JPG") === "image/jpeg", "jpg mime case-insensitive");
assert(mimeTypeForExtension(".txt") === null, "non-image mime");
assert(extensionForMimeType("image/png") === "png", "png ext");
assert(extensionForMimeType("image/jpeg; charset=binary") === "jpg", "jpeg ext with params");

// --- saveAttachmentBytes round-trip ---------------------------------------
const saved = saveAttachmentBytes(PNG_BYTES, "image/png", "test.png");
assert(saved.kind === "image", "kind is image");
assert(saved.mimeType === "image/png", "mime preserved");
assert(saved.source.type === "path", "source is path");
assert(saved.name === "test.png", "name preserved");
assert(saved.sizeBytes === PNG_BYTES.length, "size matches");

const decoded = readAttachmentBase64(saved);
assert(decoded.mimeType === "image/png", "round-trip mime");
assert(
  Buffer.from(decoded.data, "base64").equals(PNG_BYTES),
  "round-trip bytes match"
);

// Path-based attachment from disk.
const onDisk = join(tmpdir(), `meer-test-${randomUUID()}.png`);
writeFileSync(onDisk, PNG_BYTES);
const fromFile = attachmentFromFile(onDisk);
assert(fromFile.source.type === "path", "fromFile path source");
assert(fromFile.mimeType === "image/png", "fromFile mime");
const fromFileDecoded = readAttachmentBase64(fromFile);
assert(
  Buffer.from(fromFileDecoded.data, "base64").equals(PNG_BYTES),
  "fromFile bytes match"
);
unlinkSync(onDisk);

// --- Oversized buffer rejection -------------------------------------------
try {
  const huge = Buffer.alloc(21 * 1024 * 1024); // 21MB > 20MB cap
  saveAttachmentBytes(huge, "image/png");
  assert(false, "should have thrown on oversized buffer");
} catch (err) {
  assert(
    err instanceof Error && /exceeds limit/i.test(err.message),
    "oversized error message"
  );
}

// --- extractImagePathsFromText --------------------------------------------
const workDir = join(tmpdir(), `meer-extract-${randomUUID()}`);
mkdirSync(workDir, { recursive: true });
const imageA = join(workDir, "diagram.png");
const imageB = join(workDir, "with space.png");
writeFileSync(imageA, PNG_BYTES);
writeFileSync(imageB, PNG_BYTES);

const detected = extractImagePathsFromText(
  `look at ${imageA} and tell me what's wrong`,
  workDir
);
assert(detected.paths.length === 1, "detected one path");
assert(detected.paths[0] === imageA, "detected absolute path");
assert(
  detected.residualText === "look at and tell me what's wrong",
  `residual text stripped (got "${detected.residualText}")`
);

// macOS-style backslash-escaped space in the pasted path.
const escapedToken = imageB.replace(/ /g, "\\ ");
const detected2 = extractImagePathsFromText(
  `here is the screenshot: ${escapedToken}`,
  workDir
);
assert(detected2.paths.length === 1, "detected escaped-space path");
assert(detected2.paths[0] === imageB, "detected path with space");

// Plain text with no path is untouched.
const detected3 = extractImagePathsFromText("hello world", workDir);
assert(detected3.paths.length === 0, "no paths in plain text");
assert(detected3.residualText === "hello world", "plain text preserved");

// A token that LOOKS like a path but doesn't exist is left in residual.
const detected4 = extractImagePathsFromText(
  `/tmp/definitely-does-not-exist-${randomUUID()}.png report this`,
  workDir
);
assert(detected4.paths.length === 0, "missing file does not attach");

unlinkSync(imageA);
unlinkSync(imageB);
assert(!existsSync(imageA), "cleanup ok");

console.log("attachments verification passed");
