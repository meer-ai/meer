/**
 * Open a chunk of text in the user's $PAGER (falling back to `less -R`).
 *
 * The pager runs as a foreground child process with inherited stdio. The
 * caller is responsible for suspending whatever interactive UI is holding
 * the terminal (Ink, in our case) before invoking — otherwise the Ink
 * renderer's alternate-screen handling fights with less.
 *
 * Resolves once the user quits the pager.
 *
 * No-op when $PAGER is empty AND `less` is missing from $PATH — we just
 * print the content directly so the user still sees it.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FALLBACK_PAGER = "less";
const FALLBACK_ARGS = ["-R"]; // honour color codes if the caller didn't strip them

function which(bin: string): boolean {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", [bin], {
    timeout: 800,
  });
  return result.status === 0;
}

function resolvePager(): { command: string; args: string[] } | null {
  const fromEnv = process.env.PAGER?.trim();
  if (fromEnv) {
    const parts = fromEnv.split(/\s+/);
    return { command: parts[0], args: parts.slice(1) };
  }
  if (which(FALLBACK_PAGER)) {
    return { command: FALLBACK_PAGER, args: [...FALLBACK_ARGS] };
  }
  return null;
}

export interface OpenInPagerInput {
  /** Existing file on disk to view — preferred path (no copy needed). */
  filePath?: string;
  /** Inline content to view when no file is available. Written to a temp file. */
  content?: string;
  /** Header line prepended to the temp file when `content` is used. */
  header?: string;
}

/**
 * Page through the input. Returns the pager's exit code (typically 0 from
 * a clean quit). When neither `filePath` nor `content` is provided, prints
 * "(empty)" and returns 0.
 */
export async function openInPager(input: OpenInPagerInput): Promise<number> {
  let target = input.filePath;
  let tempPath: string | undefined;
  let tempDir: string | undefined;

  // No file? Stage the content in a temp file so the pager has something
  // to mmap. Header (if any) goes on top.
  if (!target) {
    const body = input.content ?? "";
    if (!body && !input.header) {
      process.stdout.write("(empty)\n");
      return 0;
    }
    tempDir = mkdtempSync(join(tmpdir(), "meer-pager-"));
    tempPath = join(tempDir, "view.txt");
    const composed = input.header ? `${input.header}\n\n${body}` : body;
    writeFileSync(tempPath, composed, "utf8");
    target = tempPath;
  }

  const pager = resolvePager();
  if (!pager) {
    // No pager available — dump to stdout.
    const fs = await import("node:fs");
    process.stdout.write(fs.readFileSync(target, "utf8"));
    if (tempPath && tempDir) {
      try {
        unlinkSync(tempPath);
        rmdirSync(tempDir);
      } catch {
        // Best-effort cleanup.
      }
    }
    return 0;
  }

  try {
    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn(pager.command, [...pager.args, target!], {
        stdio: "inherit",
      });
      child.on("error", () => resolve(1));
      child.on("close", (code) => resolve(code ?? 0));
    });
    return exitCode;
  } finally {
    if (tempPath && tempDir) {
      try {
        unlinkSync(tempPath);
        rmdirSync(tempDir);
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}
