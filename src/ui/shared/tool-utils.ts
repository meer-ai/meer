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
