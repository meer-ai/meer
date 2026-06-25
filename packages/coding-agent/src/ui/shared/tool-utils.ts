export const FILE_MAX_LINES = 30;
export const SHELL_MAX_LINES = 20;
export const GENERIC_MAX_CHARS = 400;
export const WRITE_PREVIEW_LINES = 10;

export function isMutationTool(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("write") ||
    lower.includes("edit") ||
    lower.includes("propose_edit") ||
    lower.includes("apply_edit") ||
    lower.includes("move") ||
    lower.includes("rename") ||
    lower.includes("delete") ||
    lower.includes("create_directory")
  );
}

export function classifyTool(name: string): "mutation" | "file" | "shell" | "generic" {
  const lower = name.toLowerCase();
  if (/run_command|bash|exec|package_run_script/.test(lower)) return "shell";
  if (isMutationTool(lower)) return "mutation";
  if (/read_file|read_folder|read_many|list_files|find_files/.test(lower)) {
    return "file";
  }
  return "generic";
}

export function stripToolHeader(content: string): string {
  return content.replace(/^Tool:\s*\S+\s*\n(?:Result[^\n]*:\s*)?\n?/i, "").trim();
}

export function getFilePath(args?: Record<string, unknown>): string {
  if (!args) return "";
  const value = args.path ?? args.filePath ?? args.file ?? args.directory ?? args.filepath ?? "";
  return typeof value === "string" ? value : "";
}

export function getCommand(args?: Record<string, unknown>): string {
  if (!args) return "";
  const value = args.command ?? args.cmd ?? args.script ?? args.args ?? "";
  return typeof value === "string" ? value : Array.isArray(value) ? value.join(" ") : "";
}

function firstString(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function asList(value: unknown): string {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .join(", ");
  }
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean).join(", ");
  }
  return "";
}

function firstNumber(args: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value);
  }
  return undefined;
}

function formatLineRange(args: Record<string, unknown>): string {
  const start = firstNumber(args, ["startLine", "lineStart", "start", "from", "offset"]);
  const end = firstNumber(args, ["endLine", "lineEnd", "end", "to"]);
  const limit = firstNumber(args, ["limit", "lineCount", "lines"]);
  if (start !== undefined && end !== undefined) return `:${start}-${end}`;
  if (start !== undefined && limit !== undefined) return `:${start}-${start + Math.max(0, limit - 1)}`;
  if (start !== undefined) return `:${start}`;
  return "";
}

/**
 * A concise, human-readable summary of what a tool call is doing, shown after
 * the tool name in its worklog row. Falls back to file path / search pattern,
 * then to nothing.
 */
export function getToolSummary(toolName: string, args?: Record<string, unknown>): string {
  const lower = toolName.toLowerCase();
  const a = args ?? {};

  if (/run_command|bash|exec|package_run_script/.test(lower)) {
    const command = getCommand(args);
    return command ? `$ ${command}` : "";
  }
  if (/read_file|read_file_range|read/.test(lower)) {
    const path = getFilePath(args);
    if (path) return `${path}${formatLineRange(a)}`;
  }
  if (/list_files|read_folder|list_dir|directory/.test(lower)) {
    const path = getFilePath(args) || firstString(a, ["cwd", "root"]);
    const pattern = firstString(a, ["pattern", "glob", "includePattern"]);
    if (path && pattern) return `${path} · ${pattern}`;
    if (path) return path;
  }
  if (/grep|search|find_files|ripgrep|semantic/.test(lower)) {
    const pattern = firstString(a, ["pattern", "term", "query", "search"]);
    const path = getFilePath(args) || firstString(a, ["cwd", "root", "includePattern"]);
    if (pattern && path) return `"${pattern}" in ${path}`;
    if (pattern) return `"${pattern}"`;
  }
  if (/http_request|fetch|web_request|web_fetch|curl/.test(lower)) {
    const url = firstString(a, ["url", "endpoint", "uri"]);
    if (url) {
      const method = firstString(a, ["method"]).toUpperCase() || "GET";
      return `${method} ${url}`;
    }
  }
  if (/package_install|install_package|add_dependency/.test(lower)) {
    const pkgs = asList(a.packages ?? a.package ?? a.dependencies);
    if (pkgs) return pkgs;
  }
  if (/commit/.test(lower)) {
    const message = firstString(a, ["message", "msg"]);
    if (message) return `"${message}"`;
  }
  if (/symbol|reference|rename|definition/.test(lower)) {
    const symbol = firstString(a, ["symbol", "symbolName", "name", "oldName", "identifier"]);
    if (symbol) return symbol;
  }
  if (/set_plan|create_plan/.test(lower)) {
    const title = firstString(a, ["title", "goal", "name"]);
    if (title) return title;
  }
  if (/memory/.test(lower)) {
    const key = firstString(a, ["key", "query", "name", "title"]);
    if (key) return key;
  }
  const path = getFilePath(args);
  if (path) return path;

  const pattern = firstString(a, ["pattern", "term", "query", "includePattern", "search"]);
  if (pattern) return `"${pattern}"`;

  return "";
}

export function truncateLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1)}…`;
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

/** Threshold below which a tool is treated as "fast" and gets a compact one-line render. */
export const FAST_TOOL_DURATION_MS = 1000;

/** Above this many lines, even a fast tool gets the full widget (its output is too big to compact). */
export const FAST_TOOL_MAX_LINES = 4;

export function getDurationMs(details?: Record<string, unknown>): number | undefined {
  const raw = details?.durationMs;
  return typeof raw === "number" ? raw : undefined;
}

/**
 * Decide whether a completed tool result should render compact (a single
 * dim line: `→ tool args (12ms)`) or as a full widget. Keeps the chat
 * uncluttered when the agent fires many fast tools (read_file, grep, etc.)
 * but never hides a slow or error result.
 */
export function shouldRenderCompact(args: {
  duration?: number;
  isError?: boolean;
  body: string;
}): boolean {
  if (args.isError) return false;
  if (typeof args.duration !== "number") return false;
  if (args.duration >= FAST_TOOL_DURATION_MS) return false;
  const lineCount = args.body.split("\n").filter((l) => l.trim()).length;
  if (lineCount > FAST_TOOL_MAX_LINES) return false;
  return true;
}

/** Number of diff lines shown inline under a file-edit tool row. */
export const DIFF_PREVIEW_LINES = 7;

// Strip SGR color codes (chalk emits these) so we can re-style with the TUI theme.
const ANSI_SGR = /\x1b\[[0-9;]*m/g;

export function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_SGR, "");
}

export type DiffLineKind = "meta" | "add" | "remove" | "context";

export interface DiffPreviewLine {
  text: string;
  kind: DiffLineKind;
}

function classifyDiffLine(text: string): DiffLineKind {
  if (text.startsWith("@@")) return "meta";
  if (text.startsWith("+")) return "add";
  if (text.startsWith("-")) return "remove";
  return "context";
}

/** Count added/removed lines in a (possibly colored) unified diff. */
export function parseDiffStat(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const raw of stripAnsiCodes(diff).split("\n")) {
    if (raw.startsWith("@@")) continue;
    if (raw.startsWith("+")) added++;
    else if (raw.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** Clip a line to a max width without collapsing leading indentation. */
export function clipLine(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Turn a (possibly colored) unified diff into a short, structured preview:
 * the first `maxLines` non-empty diff lines tagged by kind, plus the count of
 * lines hidden after the cutoff. The caller colorizes using the TUI theme.
 */
export function buildDiffPreview(
  diff: string,
  maxLines: number = DIFF_PREVIEW_LINES,
  maxLineWidth: number = 120
): { lines: DiffPreviewLine[]; hiddenLines: number } {
  const all = stripAnsiCodes(diff)
    .split("\n")
    .filter((line) => line.length > 0);
  const preview = all.slice(0, maxLines).map((text): DiffPreviewLine => ({
    text: clipLine(text, maxLineWidth),
    kind: classifyDiffLine(text),
  }));
  return { lines: preview, hiddenLines: Math.max(0, all.length - preview.length) };
}

/**
 * Best-effort extraction of a tool argument from a *partial* JSON buffer (the
 * args streaming in before the call is complete). Returns the value of the
 * first recognized key, even if its closing quote hasn't arrived yet, so the
 * row can show the command/path "building up" live.
 */
export function extractStreamingArgPreview(buffer: string): string {
  const keys = ["command", "cmd", "script", "path", "filePath", "url", "query", "pattern", "message"];
  for (const key of keys) {
    const match = buffer.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`));
    if (match) {
      const value = match[1]
        .replace(/\\"/g, '"')
        .replace(/\\n/g, " ")
        .replace(/\\t/g, " ")
        .replace(/\\\\/g, "\\");
      if (value.trim()) return value;
    }
  }
  return "";
}

/** Lines of tool output shown inline under a (non-edit) tool row. */
export const TOOL_OUTPUT_PREVIEW_LINES = 10;

/**
 * Build a compact preview of a tool's textual output for inline display under
 * its row. Returns null when there's nothing worth showing: empty output, or a
 * mutation tool (those render a diff via the result details instead).
 */
export function buildToolOutputPreview(
  toolName: string,
  content: string,
  maxLines: number = TOOL_OUTPUT_PREVIEW_LINES,
  maxLineWidth: number = 120
): { lines: string[]; hiddenLines: number } | null {
  if (classifyTool(toolName) === "mutation") return null;
  const body = stripToolHeader(stripAnsiCodes(content)).replace(/\s+$/, "");
  if (!body.trim()) return null;
  const all = body.split("\n");
  const lines = all.slice(0, maxLines).map((line) => clipLine(line, maxLineWidth));
  return { lines, hiddenLines: Math.max(0, all.length - lines.length) };
}

export function extractDiffPreview(content: string): string | null {
  if (!content.includes("@@ ")) return null;
  const start = content.indexOf("@@ ");
  return start >= 0 ? content.slice(start).trim() : null;
}

export function getWriteContent(args?: Record<string, unknown>): string {
  if (!args) return "";
  const value = args.content ?? args.contents ?? args.newContent;
  return typeof value === "string" ? value.replace(/\r/g, "") : "";
}

export function formatWritePreview(content: string): {
  preview: string;
  hiddenLines: number;
  totalLines: number;
} {
  const lines = content.replace(/\t/g, "   ").split("\n");
  const trimmed = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  const previewLines = trimmed.slice(0, WRITE_PREVIEW_LINES);
  return {
    preview: previewLines.join("\n"),
    hiddenLines: Math.max(0, trimmed.length - previewLines.length),
    totalLines: trimmed.length,
  };
}
