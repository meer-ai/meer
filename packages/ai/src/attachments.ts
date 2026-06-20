/**
 * Image attachment helpers.
 *
 * Attachments are stored under `~/.meer/attachments/<uuid>.<ext>` so they
 * survive across sessions and process restarts. Messages reference them by
 * `MessageAttachment.source = { type: "path", path }`; the provider reads +
 * base64-encodes lazily when sending to the LLM, which keeps the on-disk
 * session shape small.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import type { MessageAttachment } from "./types.js";

export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"] as const;

/**
 * Allowlist of "text-like" extensions that get inlined into the user message
 * as <file path="…">contents</file> blocks. We use a strict allowlist
 * rather than "is it text?" content-sniffing because:
 *   - .env files are technically text but commonly hold secrets
 *   - .key / .pem / .crt look text-ish too — same problem
 *   - lockfiles (package-lock.json, yarn.lock) are huge and almost never
 *     what the user means when they reference a path
 *
 * Everything outside both this list and IMAGE_EXTENSIONS gets left in the
 * residual text so the user can deal with it explicitly.
 */
export const TEXT_FILE_EXTENSIONS = [
  // Code
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyi", ".go", ".rs", ".java", ".kt", ".kts", ".scala", ".swift",
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx",
  ".rb", ".php", ".pl", ".lua", ".r", ".jl", ".dart",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd",
  ".sql", ".graphql", ".gql", ".proto",
  // Web / markup
  ".html", ".htm", ".css", ".scss", ".sass", ".less",
  ".vue", ".svelte", ".astro",
  // Data / config (curated)
  ".json", ".jsonc", ".json5", ".yaml", ".yml", ".toml", ".xml",
  ".ini", ".cfg", ".conf", ".properties",
  // Docs / text
  ".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc",
  // Common dotfiles & misc
  ".gitignore", ".gitattributes", ".editorconfig", ".dockerignore",
  ".log", ".csv", ".tsv",
] as const;

/**
 * Provider image limits are typically ~5MB (Anthropic, OpenAI) up to ~20MB.
 * We cap at 20MB so a single oversized screenshot doesn't reach the wire and
 * generate a confusing 4xx. If/when we want to auto-resize, plug a pure-JS
 * resizer (e.g. lazy-loaded jimp) into the path right before this check
 * inside saveAttachmentBytes/attachmentFromFile.
 */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export function getAttachmentsDir(): string {
  const dir = join(homedir(), ".meer", "attachments");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function mimeTypeForExtension(ext: string): string | null {
  switch (ext.toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return null;
  }
}

export function extensionForMimeType(mime: string): string | null {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (base) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return null;
  }
}

export function isImagePath(value: string): boolean {
  return IMAGE_EXTENSIONS.includes(
    extname(value).toLowerCase() as (typeof IMAGE_EXTENSIONS)[number]
  );
}

export function isTextFilePath(value: string): boolean {
  const ext = extname(value).toLowerCase();
  // Files with no extension that match a known dotfile (e.g. "Dockerfile")
  // are NOT auto-inlined to avoid the lock-file problem.
  if (!ext) return false;
  return TEXT_FILE_EXTENSIONS.includes(
    ext as (typeof TEXT_FILE_EXTENSIONS)[number]
  );
}

export type FileReferenceKind = "image" | "text";

export interface FileReference {
  /** Absolute, resolved filesystem path. */
  path: string;
  kind: FileReferenceKind;
  /** Original token the user typed (may be relative / use `~/`). */
  rawToken: string;
}

/**
 * Persist arbitrary image bytes (e.g. from clipboard) to the attachments
 * directory and return a MessageAttachment pointing at the saved file.
 *
 * Throws if the bytes exceed MAX_ATTACHMENT_BYTES so we don't silently
 * send a 200MB screenshot to a provider.
 */
export function saveAttachmentBytes(
  bytes: Buffer | Uint8Array,
  mimeType: string,
  name?: string
): MessageAttachment {
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachment is ${(bytes.length / (1024 * 1024)).toFixed(1)}MB, exceeds limit of ${
        MAX_ATTACHMENT_BYTES / (1024 * 1024)
      }MB`
    );
  }

  const ext = extensionForMimeType(mimeType) ?? "png";
  const filename = `${randomUUID()}.${ext}`;
  const path = join(getAttachmentsDir(), filename);
  writeFileSync(path, bytes);

  return {
    kind: "image",
    mimeType,
    source: { type: "path", path },
    name: name ?? filename,
    sizeBytes: bytes.length,
  };
}

/**
 * Build a MessageAttachment from an existing file on disk. The file is NOT
 * copied into the attachments directory — we just reference it in place.
 * Callers should pass absolute paths; relative paths are resolved against
 * `cwd` (defaults to process.cwd()).
 */
export function attachmentFromFile(
  filePath: string,
  cwd: string = process.cwd()
): MessageAttachment {
  const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  if (!existsSync(absolute)) {
    throw new Error(`Attachment file not found: ${filePath}`);
  }

  const ext = extname(absolute).toLowerCase();
  const mimeType = mimeTypeForExtension(ext);
  if (!mimeType) {
    throw new Error(`Unsupported image extension "${ext}" for ${filePath}`);
  }

  const stats = statSync(absolute);
  if (stats.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `${filePath} is ${(stats.size / (1024 * 1024)).toFixed(1)}MB, exceeds limit of ${
        MAX_ATTACHMENT_BYTES / (1024 * 1024)
      }MB`
    );
  }

  return {
    kind: "image",
    mimeType,
    source: { type: "path", path: absolute },
    name: absolute.split("/").pop() ?? absolute,
    sizeBytes: stats.size,
  };
}

/**
 * Resolve an attachment to its base64-encoded bytes. Use this from provider
 * adapters at send time. Path-sourced attachments are read fresh each call,
 * which is fine — provider calls are infrequent compared to message ops.
 */
export function readAttachmentBase64(attachment: MessageAttachment): {
  mimeType: string;
  data: string;
} {
  if (attachment.source.type === "base64") {
    return { mimeType: attachment.mimeType, data: attachment.source.data };
  }

  const bytes = readFileSync(attachment.source.path);
  return { mimeType: attachment.mimeType, data: bytes.toString("base64") };
}

/**
 * Detect file-path tokens inside the user's typed text and classify each
 * by kind (image vs. text-file). Image references become multimodal
 * attachments; text-file references get inlined into the message as
 * <file path="…">contents</file> blocks at the call site.
 *
 * Handles macOS-style backslash-escaped spaces in pasted paths.
 * Tokens that look like paths but don't resolve to a real file — or whose
 * extension isn't on either allowlist — are left in the residual text so
 * the user can deal with them explicitly.
 */
export function extractFileReferencesFromText(
  text: string,
  cwd: string = process.cwd()
): { files: FileReference[]; residualText: string } {
  if (!text.includes("/") && !text.includes("\\")) {
    return { files: [], residualText: text };
  }

  // Placeholder MUST be whitespace-free so it survives tokenisation by
  // `split(/\s+/)`. Earlier versions used " __MEER_SPACE__ " (with
  // surrounding spaces) which the tokeniser stripped, leaving the
  // placeholder as a standalone token and breaking path reconstruction.
  const SPACE = " MEER_SPACE ";
  const prepared = text.replace(/\\ /g, SPACE);
  const tokens = prepared.split(/\s+/);

  const files: FileReference[] = [];
  const remaining: string[] = [];
  for (const raw of tokens) {
    if (!raw) continue;
    const token = raw.split(SPACE).join(" ");
    const kind: FileReferenceKind | null = isImagePath(token)
      ? "image"
      : isTextFilePath(token)
        ? "text"
        : null;
    if (!kind) {
      remaining.push(token);
      continue;
    }
    const candidate = token.startsWith("~/")
      ? join(homedir(), token.slice(2))
      : isAbsolute(token)
        ? token
        : resolve(cwd, token);
    if (existsSync(candidate)) {
      files.push({ path: candidate, kind, rawToken: token });
    } else {
      remaining.push(token);
    }
  }

  const residualText = remaining.join(" ").trim();
  return { files, residualText };
}

/**
 * Backward-compatible wrapper that returns just image paths. Kept so the
 * existing image-paste submit path doesn't need to change shape.
 */
export function extractImagePathsFromText(
  text: string,
  cwd: string = process.cwd()
): { paths: string[]; residualText: string } {
  const { files, residualText } = extractFileReferencesFromText(text, cwd);
  return {
    paths: files.filter((f) => f.kind === "image").map((f) => f.path),
    residualText,
  };
}

const MAX_INLINED_FILE_BYTES = 100 * 1024; // 100KB per file
const MAX_INLINED_TOTAL_BYTES = 500 * 1024; // 500KB across a single turn

/**
 * Read a text-file reference and format it as a <file path="…">…</file>
 * block suitable for inlining into the user message. Enforces per-file and
 * cumulative size caps; oversized files are tailed with a truncation
 * comment inside the block so the model knows the content is partial.
 *
 * Returns null when the file can't be read OR when the cumulative byte
 * budget is already exhausted — the caller should leave a visible hint
 * in the residual text so the user notices the skip.
 */
export function inlineTextFile(
  reference: FileReference,
  options?: { bytesUsedSoFar?: number }
): { block: string; bytes: number } | null {
  if (reference.kind !== "text") return null;
  const bytesUsedSoFar = options?.bytesUsedSoFar ?? 0;
  if (bytesUsedSoFar >= MAX_INLINED_TOTAL_BYTES) {
    return null;
  }

  let contents: string;
  try {
    contents = readFileSync(reference.path, "utf8");
  } catch {
    return null;
  }

  const fullBytes = Buffer.byteLength(contents, "utf8");
  const remainingBudget = MAX_INLINED_TOTAL_BYTES - bytesUsedSoFar;
  const perFileLimit = Math.min(MAX_INLINED_FILE_BYTES, remainingBudget);

  let body = contents;
  let truncated = false;
  if (fullBytes > perFileLimit) {
    const buf = Buffer.from(contents, "utf8");
    // Keep the tail so trailing log lines / errors / latest writes survive.
    let start = buf.length - perFileLimit;
    while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
      start++;
    }
    body = buf.subarray(start).toString("utf8");
    truncated = true;
  }

  const truncationNote = truncated
    ? `<!-- truncated: showing tail ${Buffer.byteLength(body, "utf8")} bytes of ${fullBytes} -->\n`
    : "";
  const block = `<file path="${reference.rawToken}">\n${truncationNote}${body}\n</file>`;
  return { block, bytes: Buffer.byteLength(block, "utf8") };
}
