/**
 * Fuzzy file finder backing the composer's `@` file picker.
 *
 * Cascade (best available wins, always degrades gracefully):
 *   1. fff   — @ff-labs/fff-node, opt-in via MEER_FILE_FINDER=fff. A resident
 *              in-memory index; ideal for per-keystroke search on huge repos.
 *              Not a dependency — loaded lazily; absent ⇒ skipped. (Provisional
 *              API call, pending real integration/testing.)
 *   2. fd    — discovered on PATH (`fd` or Debian's `fdfind`). Fast, ignore-aware.
 *   3. JS    — a bounded recursive walk. No binaries required, works everywhere.
 *
 * Returns paths relative to `basePath`; directory paths carry a trailing "/"
 * (matching `fd` output, which the autocomplete layer relies on).
 */

import { spawn, spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface FileEntry {
  path: string;
  isDirectory: boolean;
}

export interface FindFilesOptions {
  basePath: string;
  query: string;
  maxResults?: number;
  signal?: AbortSignal;
}

const DEFAULT_MAX_RESULTS = 100;
const JS_WALK_TIME_BUDGET_MS = 150;

const IGNORE_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", ".next", ".nuxt",
  "target", ".venv", "venv", "__pycache__", "coverage", ".cache",
  ".turbo", ".idea", ".gradle", "vendor",
]);

// ── fd discovery (cached for the process) ───────────────────────────────────
let cachedFd: string | null | undefined;

function discoverFd(): string | null {
  if (cachedFd !== undefined) return cachedFd;
  cachedFd = null;
  const locator = process.platform === "win32" ? "where" : "which";
  for (const bin of ["fd", "fdfind"]) {
    try {
      const result = spawnSync(locator, [bin], { timeout: 1000 });
      if (result.status === 0) {
        const first = String(result.stdout)
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)[0];
        cachedFd = first || bin;
        break;
      }
    } catch {
      // try next candidate
    }
  }
  return cachedFd;
}

/** Whether an `fd` binary is available (used by callers for diagnostics). */
export function isFdAvailable(): boolean {
  return discoverFd() !== null;
}

// ── fd backend ───────────────────────────────────────────────────────────────
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFdPathQuery(query: string): string {
  const normalized = query.replace(/\\/g, "/");
  if (!normalized.includes("/")) return normalized;
  const trimmed = normalized.replace(/^\/+|\/+$/g, "");
  if (!trimmed) return normalized;
  const segments = trimmed.split("/").filter(Boolean).map(escapeRegex);
  if (segments.length === 0) return normalized;
  let pattern = segments.join("[\\\\/]");
  if (normalized.endsWith("/")) pattern += "[\\\\/]";
  return pattern;
}

function walkWithFd(
  fdPath: string,
  baseDir: string,
  query: string,
  maxResults: number,
  signal: AbortSignal
): Promise<FileEntry[]> {
  const args = [
    "--base-directory", baseDir,
    "--max-results", String(maxResults),
    "--type", "f", "--type", "d",
    "--follow", "--hidden",
    "--exclude", ".git",
  ];
  if (query.replace(/\\/g, "/").includes("/")) args.push("--full-path");
  if (query) args.push(buildFdPathQuery(query));

  return new Promise((resolve) => {
    if (signal.aborted) return resolve([]);
    const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let settled = false;
    const finish = (entries: FileEntry[]) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(entries);
    };
    const onAbort = () => {
      if (child.exitCode === null) child.kill("SIGKILL");
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.on("error", () => finish([]));
    child.on("close", (code) => {
      if (signal.aborted || code !== 0 || !stdout) return finish([]);
      const entries: FileEntry[] = [];
      for (const line of stdout.trim().split("\n")) {
        if (!line) continue;
        const display = line.replace(/\\/g, "/");
        const isDirectory = display.endsWith("/");
        const normalized = isDirectory ? display.slice(0, -1) : display;
        if (normalized === ".git" || normalized.startsWith(".git/") || normalized.includes("/.git/")) continue;
        entries.push({ path: display, isDirectory });
      }
      finish(entries);
    });
  });
}

// ── JS fallback (bounded recursive walk) ─────────────────────────────────────
function walkWithJs(
  baseDir: string,
  query: string,
  maxResults: number,
  signal: AbortSignal
): FileEntry[] {
  const results: FileEntry[] = [];
  const needle = query.toLowerCase();
  const deadline = Date.now() + JS_WALK_TIME_BUDGET_MS;
  const stack: string[] = [baseDir];

  while (stack.length > 0) {
    if (results.length >= maxResults || signal.aborted || Date.now() > deadline) break;
    const dir = stack.pop()!;
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (results.length >= maxResults) break;
      const full = join(dir, dirent.name);
      let isDirectory = dirent.isDirectory();
      if (!isDirectory && dirent.isSymbolicLink()) {
        try { isDirectory = statSync(full).isDirectory(); } catch { /* broken link */ }
      }
      if (isDirectory && IGNORE_DIRS.has(dirent.name)) continue;
      const rel = relative(baseDir, full).split(sep).join("/");
      const matches =
        !needle ||
        rel.toLowerCase().includes(needle) ||
        dirent.name.toLowerCase().includes(needle);
      if (matches) {
        results.push({ path: isDirectory ? `${rel}/` : rel, isDirectory });
      }
      if (isDirectory) stack.push(full);
    }
  }
  return results;
}

// ── fff fast-path (opt-in, lazy, defensive) ──────────────────────────────────
// `undefined` = not yet tried, `null` = unavailable, otherwise the loaded module.
let fffModule: unknown | null | undefined;

async function walkWithFff(
  baseDir: string,
  query: string,
  maxResults: number
): Promise<FileEntry[] | null> {
  if (process.env.MEER_FILE_FINDER !== "fff") return null;
  if (fffModule === null) return null;
  if (fffModule === undefined) {
    try {
      // Variable specifier keeps tsc from resolving an optional, uninstalled dep.
      const spec = "@ff-labs/fff-node";
      fffModule = await import(spec);
    } catch {
      fffModule = null;
      return null;
    }
  }
  try {
    const mod = fffModule as Record<string, any>;
    const FileFinder = mod.FileFinder ?? mod.default?.FileFinder;
    if (!FileFinder) return null;
    const finder = FileFinder.create({ basePath: baseDir });
    // Provisional: adapt to the real fff-node API when integrating for real.
    const raw: unknown[] =
      (await finder.search?.(query, { limit: maxResults })) ??
      (await finder.find?.(query)) ??
      [];
    const entries = raw
      .map((m: any): FileEntry => {
        const p = typeof m === "string" ? m : (m?.path ?? m?.file ?? "");
        return { path: String(p).replace(/\\/g, "/"), isDirectory: false };
      })
      .filter((e) => e.path);
    return entries.length ? entries : null;
  } catch {
    return null;
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────
export async function findFilesFuzzy(opts: FindFilesOptions): Promise<FileEntry[]> {
  const { basePath, query } = opts;
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
  const signal = opts.signal ?? new AbortController().signal;

  const viaFff = await walkWithFff(basePath, query, maxResults);
  if (viaFff && viaFff.length > 0) return viaFff;

  const fdPath = discoverFd();
  if (fdPath) {
    const viaFd = await walkWithFd(fdPath, basePath, query, maxResults, signal);
    if (viaFd.length > 0 || signal.aborted) return viaFd;
    // fd ran but matched nothing — fall through to the JS walk as a backstop.
  }

  return walkWithJs(basePath, query, maxResults, signal);
}
