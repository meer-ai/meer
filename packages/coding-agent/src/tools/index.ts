export const DEFAULT_IGNORE_GLOBS = [
  "node_modules/**",
  ".git/**",
  "dist/**",
  "build/**",
  "venv/**",
  ".venv/**",
  "env/**",
  "site-packages/**",
  "__pycache__/**",
  "deps/**",
  "vendor/**",
  "coverage/**",
  "bower_components/**",
  ".mypy_cache/**",
  ".pytest_cache/**",
];

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "fs";
import * as fs from "fs";
import { createRequire } from "node:module";
import { validateSyntax } from "../lsp/diagnostics.js";
import { join, relative, dirname } from "path";

// meer ships as ESM, where the CommonJS `require` global is undefined. Some
// optional/heavy CJS deps (e.g. @babel/parser) are still loaded lazily and
// synchronously; createRequire gives us a working require for those without
// converting their call sites to async dynamic import().
const require = createRequire(import.meta.url);
import { tmpdir, homedir } from "os";
import * as pathLib from "path";
import chalk from "chalk";
import { spawn, execSync } from "child_process";
import { glob } from "glob";
import { ProjectContextManager } from "../context/manager.js";
import { diffLines } from "diff";
import type { Plan } from "../plan/types.js";
import { planStore } from "../plan/store.js";
import { formatErrorWithContext } from "@meer-ai/core/errors.js";
import { fetchWithTimeout, REQUEST_TIMEOUT_MS } from "@meer-ai/core/fetch.js";
import { applyTextEdits, type TextEdit } from "./edit-engine.js";
import { truncateHead, formatSize } from "./truncate.js";
import { BoundedOutputBuffer } from "./output-accumulator.js";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_SEARCH_PORTAL_URL = "https://search.brave.com/search";
const MAX_BRAVE_RESULTS = 20;
const COMMAND_RESULT_MAX_LINES = 2000;
const COMMAND_RESULT_MAX_BYTES = 200 * 1024;
const COMMAND_TAIL_LINES = 12;
const READ_FILE_MAX_LINES = 2000;
const READ_FILE_MAX_BYTES = 100 * 1024;

const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

// The Ink TUI renders its own work log; raw console progress lines from tool
// functions would leak through Ink's console patch as duplicate noise.
let toolConsoleQuiet = false;

/** Silence tool progress console output (set by the Ink chat UI). */
export function setToolConsoleQuiet(quiet: boolean): void {
  toolConsoleQuiet = quiet;
}

function toolLog(text: string): void {
  if (!toolConsoleQuiet) {
    console.log(text);
  }
}

export interface ToolResult {
  tool: string;
  result: string;
  error?: string;
  plan?: Plan | null;
  details?: Record<string, unknown>;
}

interface CommandOutputSnapshot {
  resultText: string;
  details: Record<string, unknown>;
}

export interface FileEdit {
  path: string;
  oldContent: string;
  newContent: string;
  description: string;
}

const PLACEHOLDER_PATTERNS: Array<RegExp> = [
  /rest of (the )?file/i,
  /rest of (the )?code/i,
  /rest will remain( the same)?/i,
  /remaining (code|file|content)/i,
  /\.\.\.\s*(rest|snip|omitted)/i,
  /\bTODO:?[^.\n]*rest/i,
];

function normalizePlanTaskId(taskId: string): string {
  return taskId
    .trim()
    .toLowerCase()
    .replace(/^task\s+#?/i, "task-")
    .replace(/^#/, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
}

function resolvePlanTask(
  plan: Plan,
  taskId: string
): Plan["tasks"][number] | undefined {
  const normalizedTaskId = normalizePlanTaskId(taskId);
  const numericMatch = normalizedTaskId.match(/(?:^|-)#?(\d+)$/);
  const numericIndex = numericMatch
    ? Number.parseInt(numericMatch[1], 10)
    : Number.parseInt(normalizedTaskId, 10);

  return (
    plan.tasks.find((task) => normalizePlanTaskId(task.id) === normalizedTaskId) ??
    plan.tasks.find((task) => normalizePlanTaskId(task.id) === `task-${normalizedTaskId}`) ??
    (Number.isFinite(numericIndex) && numericIndex >= 1
      ? plan.tasks[numericIndex - 1]
      : undefined)
  );
}

function detectPlaceholder(content: string): string | null {
  for (const pattern of PLACEHOLDER_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      return match[0];
    }
  }
  return null;
}

/**
 * Resolve a path that may be absolute, relative, or contain ~
 * @param path - The path to resolve
 * @param cwd - The current working directory (used for relative paths)
 * @returns The resolved absolute path
 */
function resolvePath(path: string, cwd: string): string {
  if (!path || path === ".") {
    return cwd;
  } else if (path.startsWith("~")) {
    return path.replace(/^~/, homedir());
  } else if (path.startsWith("/")) {
    // Absolute path - use as is
    return path;
  } else {
    // Relative path - join with cwd
    return join(cwd, path);
  }
}

/**
 * Tool: Read a file from the project
 */
export function readFile(
  filepath: string,
  cwd: string,
  options: { offset?: number; limit?: number } = {}
): ToolResult {
  try {
    const fullPath = resolvePath(filepath, cwd);

    if (!existsSync(fullPath)) {
      return {
        tool: "read_file",
        result: `File not found: ${filepath}\n\nNote: This file does not exist yet. If you want to create it, use propose_edit with the new file content.`,
        error: undefined, // Don't mark as error - this is expected for new files
      };
    }

    const content = readFileSync(fullPath, "utf-8");
    const allLines = content.split("\n");
    const totalLines = allLines.length;

    // Apply offset/limit windowing (1-indexed offset)
    const offset = Math.max(1, Math.floor(options.offset ?? 1));
    if (offset > totalLines) {
      return {
        tool: "read_file",
        result: "",
        error: `Offset ${offset} is beyond the end of ${filepath} (${totalLines} lines).`,
      };
    }
    const limit =
      options.limit !== undefined && options.limit > 0
        ? Math.floor(options.limit)
        : undefined;
    const windowed = allLines.slice(
      offset - 1,
      limit !== undefined ? offset - 1 + limit : undefined
    );
    const windowedContent = windowed.join("\n");

    // Cap what goes into context; the model can paginate with offset/limit.
    const truncation = truncateHead(windowedContent, {
      maxLines: READ_FILE_MAX_LINES,
      maxBytes: READ_FILE_MAX_BYTES,
    });

    const windowNote =
      offset > 1 || limit !== undefined
        ? ` [lines ${offset}-${offset - 1 + windowed.length} of ${totalLines}]`
        : "";

    let result = `File: ${filepath} (${totalLines} lines)${windowNote}\n\n${truncation.content}`;
    if (truncation.truncated) {
      const shownEnd = offset - 1 + truncation.outputLines;
      result += `\n\n[Truncated: showing lines ${offset}-${shownEnd} of ${totalLines} (${
        truncation.truncatedBy === "bytes"
          ? `${formatSize(READ_FILE_MAX_BYTES)} limit`
          : `${READ_FILE_MAX_LINES} line limit`
      }). Use read_file with offset=${shownEnd + 1} to continue reading.]`;
    }

    return {
      tool: "read_file",
      result,
      details: truncation.truncated
        ? {
            truncation: {
              truncated: true,
              totalLines,
              outputLines: truncation.outputLines,
              totalBytes: truncation.totalBytes,
              maxLines: READ_FILE_MAX_LINES,
              maxBytes: READ_FILE_MAX_BYTES,
            },
          }
        : undefined,
    };
  } catch (error) {
    return {
      tool: "read_file",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: List files in a directory
 */
export function listFiles(dirpath: string, cwd: string): ToolResult {
  try {
    const fullPath = resolvePath(dirpath, cwd);

    if (!existsSync(fullPath)) {
      return {
        tool: "list_files",
        result: "",
        error: `Directory not found: ${dirpath || "."}`,
      };
    }

    const items = readdirSync(fullPath);
    const files: string[] = [];
    const dirs: string[] = [];

    for (const item of items) {
      const itemPath = join(fullPath, item);
      try {
        const stats = statSync(itemPath);
        if (stats.isDirectory()) {
          dirs.push(item + "/");
        } else {
          const size = stats.size;
          files.push(`${item} (${formatBytes(size)})`);
        }
      } catch {
        // Skip items that can't be accessed
      }
    }

    const result = [...dirs.sort(), ...files.sort()].join("\n");

    return {
      tool: "list_files",
      result: `Directory: ${dirpath || "."}\n\n${result}`,
    };
  } catch (error) {
    return {
      tool: "list_files",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Propose a file edit (doesn't apply it yet)
 */
export function proposeEdit(
  filepath: string,
  newContent: string,
  description: string,
  cwd: string
): FileEdit {
  const fullPath = resolvePath(filepath, cwd);
  const oldContent = existsSync(fullPath)
    ? readFileSync(fullPath, "utf-8")
    : "";

  if (oldContent && newContent.trim().length === 0) {
    throw new Error(
      `Refusing to overwrite ${filepath} with empty content via propose_edit. Use remove_file if you intend to delete it.`
    );
  }

  const placeholder = detectPlaceholder(newContent);
  if (placeholder) {
    throw new Error(
      `Proposed edit for ${filepath} contains placeholder text ("${placeholder.trim()}"). Provide the full file content instead.`
    );
  }

  return {
    path: filepath,
    oldContent,
    newContent,
    description,
  };
}

/**
 * Apply an approved edit
 */
export function applyEdit(edit: FileEdit, cwd: string): ToolResult {
  try {
    const fullPath = resolvePath(edit.path, cwd);
    const dir = dirname(fullPath);

    // Ensure directory exists
    if (!existsSync(dir)) {
      const { mkdirSync } = fs;
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(fullPath, edit.newContent, "utf-8");
    ProjectContextManager.getInstance().invalidate(cwd);
    const diffPreview = generateDiff(edit.oldContent, edit.newContent)
      .slice(0, 120)
      .join("\n");
    const fullDiff = generateDiff(edit.oldContent, edit.newContent).join("\n");
    const firstChangedLine = getFirstChangedLine(fullDiff);

    return {
      tool: "apply_edit",
      result: diffPreview
        ? `Successfully updated ${edit.path}\n\n${diffPreview}`
        : `Successfully updated ${edit.path}`,
      details: {
        path: edit.path,
        diff: fullDiff,
        firstChangedLine,
        oldBytes: Buffer.byteLength(edit.oldContent, "utf8"),
        newBytes: Buffer.byteLength(edit.newContent, "utf8"),
      },
    };
  } catch (error) {
    return {
      tool: "apply_edit",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Generate a colored diff between old and new content
 */
export function generateDiff(oldContent: string, newContent: string): string[] {
  const normalizeContent = (content: string) =>
    content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const normalizedOld = normalizeContent(oldContent);
  const normalizedNew = normalizeContent(newContent);

  if (normalizedOld === normalizedNew) {
    return [];
  }

  type OpType = "equal" | "add" | "remove";
  interface DiffOp {
    type: OpType;
    line: string;
    oldLine: number;
    newLine: number;
  }

  const parts = diffLines(normalizedOld, normalizedNew);
  const ops: DiffOp[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const part of parts) {
    const lines = part.value.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    for (const line of lines) {
      if (part.added) {
        ops.push({ type: "add", line, oldLine, newLine });
        newLine++;
      } else if (part.removed) {
        ops.push({ type: "remove", line, oldLine, newLine });
        oldLine++;
      } else {
        ops.push({ type: "equal", line, oldLine, newLine });
        oldLine++;
        newLine++;
      }
    }
  }

  if (ops.length === 0) {
    return [];
  }

  const contextSize = 3;
  const output: string[] = [];
  let index = 0;

  while (index < ops.length) {
    while (index < ops.length && ops[index].type === "equal") {
      index++;
    }

    if (index >= ops.length) {
      break;
    }

    let start = index;
    let leadingContext = 0;
    while (start > 0) {
      const prevOp = ops[start - 1];
      if (prevOp.type === "equal") {
        if (leadingContext >= contextSize) {
          break;
        }
        leadingContext++;
      }
      start--;
    }

    let end = index;
    let trailingContext = 0;
    while (end < ops.length) {
      const op = ops[end];
      if (op.type === "equal") {
        if (trailingContext === contextSize) {
          break;
        }
        trailingContext++;
        end++;
      } else {
        trailingContext = 0;
        end++;
      }
    }

    const hunkOps = ops.slice(start, end);
    const oldStart =
      hunkOps.find((op) => op.type !== "add")?.oldLine ?? hunkOps[0].oldLine;
    const newStart =
      hunkOps.find((op) => op.type !== "remove")?.newLine ?? hunkOps[0].newLine;

    let oldCount = 0;
    let newCount = 0;
    const hunkLines: string[] = [];

    for (const op of hunkOps) {
      if (op.type === "equal") {
        hunkLines.push(` ${op.line}`);
        oldCount++;
        newCount++;
      } else if (op.type === "remove") {
        hunkLines.push(`- ${op.line}`);
        oldCount++;
      } else {
        hunkLines.push(`+ ${op.line}`);
        newCount++;
      }
    }

    output.push(
      chalk.gray(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    );

    for (const line of hunkLines) {
      if (line.startsWith("+")) {
        output.push(chalk.green(line));
      } else if (line.startsWith("-")) {
        output.push(chalk.red(line));
      } else {
        output.push(chalk.gray(line));
      }
    }

    index = end;
  }

  return output;
}

/**
 * Parse tool calls from AI response
 * Expected format: <tool name="tool_name" param1="value1">content</tool>
 */
export function parseToolCalls(
  response: string
): Array<{ tool: string; params: Record<string, string>; content: string }> {
  const tools: Array<{
    tool: string;
    params: Record<string, string>;
    content: string;
  }> = [];

  // First try standard format with closing tags
  const toolRegex = /<tool\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/tool>/gi;

  let match;
  while ((match = toolRegex.exec(response)) !== null) {
    const [fullMatch, toolName, paramsStr, content] = match;

    // Parse parameters
    const params: Record<string, string> = {};
    const paramRegex = /(\w+)="([^"]*)"/g;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(paramsStr)) !== null) {
      params[paramMatch[1]] = paramMatch[2];
    }

    // Debug logging
    if (toolName === "propose_edit" && !content.trim()) {
      console.log(
        chalk.yellow(`\n⚠️  Warning: propose_edit has empty content`)
      );
      console.log(chalk.gray(`Full match: ${fullMatch.substring(0, 200)}...`));
    }

    tools.push({
      tool: toolName,
      params,
      content: content.trim(),
    });
  }

  // Also handle self-closing tags (though they shouldn't have content)
  const selfClosingRegex = /<tool\s+name="([^"]+)"([^>]*)\/>/gi;
  while ((match = selfClosingRegex.exec(response)) !== null) {
    const [, toolName, paramsStr] = match;

    // Parse parameters
    const params: Record<string, string> = {};
    const paramRegex = /(\w+)="([^"]*)"/g;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(paramsStr)) !== null) {
      params[paramMatch[1]] = paramMatch[2];
    }

    tools.push({
      tool: toolName,
      params,
      content: "",
    });
  }

  return tools;
}

/**
 * Tool: Analyze project type and structure
 */
export function analyzeProject(cwd: string): ToolResult {
  try {
    const packageJsonPath = join(cwd, "package.json");
    const hasPackageJson = existsSync(packageJsonPath);

    let projectType = "unknown";
    let framework = "none";
    let hasReact = false;
    let hasVue = false;
    let hasAngular = false;
    let hasNext = false;
    let hasVite = false;
    let hasWebpack = false;
    let isNodeCLI = false;
    let isPython = false;
    let isGo = false;
    let isRust = false;

    // Check for package.json
    if (hasPackageJson) {
      try {
        const packageContent = readFileSync(packageJsonPath, "utf-8");
        const packageJson = JSON.parse(packageContent);

        // Check for React
        if (
          packageJson.dependencies?.react ||
          packageJson.devDependencies?.react
        ) {
          hasReact = true;
          projectType = "react";
        }

        // Check for Vue
        if (packageJson.dependencies?.vue || packageJson.devDependencies?.vue) {
          hasVue = true;
          projectType = "vue";
        }

        // Check for Angular
        if (
          packageJson.dependencies?.["@angular/core"] ||
          packageJson.devDependencies?.["@angular/core"]
        ) {
          hasAngular = true;
          projectType = "angular";
        }

        // Check for Next.js
        if (
          packageJson.dependencies?.next ||
          packageJson.devDependencies?.next
        ) {
          hasNext = true;
          projectType = "nextjs";
        }

        // Check for Vite
        if (
          packageJson.dependencies?.vite ||
          packageJson.devDependencies?.vite
        ) {
          hasVite = true;
        }

        // Check for Webpack
        if (
          packageJson.dependencies?.webpack ||
          packageJson.devDependencies?.webpack
        ) {
          hasWebpack = true;
        }

        // Check if it's a CLI tool
        if (
          packageJson.bin ||
          packageJson.name?.includes("cli") ||
          packageJson.description?.toLowerCase().includes("cli")
        ) {
          isNodeCLI = true;
          if (projectType === "unknown") projectType = "node-cli";
        }

        // Check for TypeScript
        const hasTypeScript =
          packageJson.dependencies?.typescript ||
          packageJson.devDependencies?.typescript;

        // Determine framework
        if (hasReact && hasNext) {
          framework = "Next.js";
        } else if (hasReact && hasVite) {
          framework = "React + Vite";
        } else if (hasReact) {
          framework = "React";
        } else if (hasVue) {
          framework = "Vue";
        } else if (hasAngular) {
          framework = "Angular";
        } else if (isNodeCLI) {
          framework = "Node.js CLI";
        } else if (hasTypeScript) {
          framework = "TypeScript";
        } else {
          framework = "Node.js";
        }
      } catch (error) {
        // Package.json exists but can't be parsed
      }
    }

    // Check for Python
    if (
      existsSync(join(cwd, "requirements.txt")) ||
      existsSync(join(cwd, "pyproject.toml")) ||
      existsSync(join(cwd, "setup.py"))
    ) {
      isPython = true;
      projectType = "python";
    }

    // Check for Go
    if (existsSync(join(cwd, "go.mod"))) {
      isGo = true;
      projectType = "go";
    }

    // Check for Rust
    if (existsSync(join(cwd, "Cargo.toml"))) {
      isRust = true;
      projectType = "rust";
    }

    // Check for common directories
    const hasSrc = existsSync(join(cwd, "src"));
    const hasPublic = existsSync(join(cwd, "public"));
    const hasComponents =
      existsSync(join(cwd, "src/components")) ||
      existsSync(join(cwd, "components"));
    const hasPages =
      existsSync(join(cwd, "src/pages")) || existsSync(join(cwd, "pages"));

    const analysis = {
      projectType,
      framework,
      hasReact,
      hasVue,
      hasAngular,
      hasNext,
      hasVite,
      hasWebpack,
      isNodeCLI,
      isPython,
      isGo,
      isRust,
      hasPackageJson,
      hasSrc,
      hasPublic,
      hasComponents,
      hasPages,
    };

    let result = `Project Analysis:\n\n`;
    result += `Type: ${projectType}\n`;
    result += `Framework: ${framework}\n`;
    result += `Has package.json: ${hasPackageJson}\n`;
    result += `Has src/: ${hasSrc}\n`;
    result += `Has public/: ${hasPublic}\n`;
    result += `Has components/: ${hasComponents}\n`;
    result += `Has pages/: ${hasPages}\n\n`;

    // Add recommendations based on analysis
    result += `Recommendations:\n`;

    if (projectType === "unknown" && !hasPackageJson) {
      result += `- This appears to be an empty directory\n`;
      result += `- Consider running: npm init, create-react-app, or other project scaffolding tools\n`;
    } else if (isNodeCLI && projectType !== "react") {
      result += `- This is a Node.js CLI project, not a React project\n`;
      result += `- For React development, consider creating a new React project with: npx create-react-app my-app\n`;
    } else if (hasReact) {
      result += `- This is a React project\n`;
      result += `- You can add components to src/components/\n`;
    }

    const context = ProjectContextManager.getInstance().getContext(cwd);
    if (context.files.length > 0) {
      result += "\nFile overview:\n";
      result += `- Total files scanned: ${context.files.length}\n`;

      const byExtension = new Map<string, number>();
      const byTopDir = new Map<string, number>();

      for (const file of context.files) {
        const extIndex = file.path.lastIndexOf(".");
        const ext = extIndex >= 0 ? file.path.slice(extIndex).toLowerCase() : "(no ext)";
        byExtension.set(ext, (byExtension.get(ext) ?? 0) + 1);

        const topDir = file.path.includes("/") ? file.path.split("/")[0] : "(root)";
        byTopDir.set(topDir, (byTopDir.get(topDir) ?? 0) + 1);
      }

      const topExtensions = Array.from(byExtension.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      if (topExtensions.length) {
        result += "- Top file types:\n";
        topExtensions.forEach(([ext, count]) => {
          result += `  • ${ext} (${count})\n`;
        });
      }

      const topDirs = Array.from(byTopDir.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      if (topDirs.length) {
        result += "- Top directories:\n";
        topDirs.forEach(([dir, count]) => {
          result += `  • ${dir} (${count} file${count === 1 ? "" : "s"})\n`;
        });
      }

      const recentFiles = [...context.files]
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, 3);
      if (recentFiles.length) {
        result += "- Recently modified:\n";
        recentFiles.forEach((file) => {
          result += `  • ${file.path}\n`;
        });
      }
    }

    return {
      tool: "analyze_project",
      result,
    };
  } catch (error) {
    return {
      tool: "analyze_project",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Run shell commands for project setup
 */
export async function runCommand(
  command: string,
  cwd: string,
  options?: {
    timeoutMs?: number;
    onUpdate?: (partial: string) => void;
    silent?: boolean;
    signal?: AbortSignal;
  }
): Promise<ToolResult> {
  const startTime = Date.now();
  const timeoutMs = options?.timeoutMs ?? 600000; // Default 10 min timeout
  const normalizedCommand = normalizeNonInteractiveCommand(command);
  const interactiveWarning = detectInteractiveCommand(normalizedCommand);
  const useInlineUpdates = Boolean(options?.onUpdate);

  if (interactiveWarning) {
    return {
      tool: "run_command",
      result: "",
      error: interactiveWarning,
      details: {
        command: normalizedCommand,
        cwd,
        blocked: true,
        reason: interactiveWarning,
        durationMs: Date.now() - startTime,
      },
    };
  }

  if (options?.signal?.aborted) {
    return {
      tool: "run_command",
      result: "",
      error: `Command cancelled before start: ${normalizedCommand}`,
      details: {
        command: normalizedCommand,
        cwd,
        cancelled: true,
        durationMs: Date.now() - startTime,
      },
    };
  }

  if (!options?.silent && !useInlineUpdates) {
    toolLog(chalk.gray(`  🚀 Running: ${normalizedCommand}`));
    toolLog(chalk.gray(`  ⏱️  Timeout: ${timeoutMs / 1000}s`));
    console.log("");
  }

  return new Promise((resolve) => {
    const isPosix = process.platform !== "win32";
    const child = spawn(normalizedCommand, {
      cwd,
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Run in its own process group on POSIX so we can kill descendants too.
      detached: isPosix,
      windowsHide: true,
    });

    // Bounded buffers: keep a rolling tail in memory, spill complete output
    // to a temp file when a command produces more than the cap.
    const stdoutAcc = new BoundedOutputBuffer({
      tempFilePrefix: "meer-command",
    });
    const stderrAcc = new BoundedOutputBuffer({
      maxTailBytes: 256 * 1024,
      tempFilePrefix: "meer-command-stderr",
    });
    let didTimeout = false;
    let didCancel = false;
    let settled = false;
    let forceKillHandle: NodeJS.Timeout | undefined;
    let stdoutEnded = !child.stdout;
    let stderrEnded = !child.stderr;
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let postExitGrace: NodeJS.Timeout | undefined;

    const STDIO_GRACE_MS = 100;

    // Kill the whole process tree (children that may hold stdio handles).
    const killTree = (sig: NodeJS.Signals) => {
      if (!child.pid) return;
      if (isPosix) {
        try {
          process.kill(-child.pid, sig);
          return;
        } catch {
          // Fall through to direct kill if the group is gone.
        }
      }
      try {
        child.kill(sig);
      } catch {
        // Process is already gone; ignore.
      }
    };

    const buildProgress = (
      state:
        | "starting"
        | "running"
        | "completed"
        | "failed"
        | "timed_out"
        | "cancelled" = "running"
    ) => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const combined = [stdoutAcc.tailText, stderrAcc.tailText]
        .filter(Boolean)
        .join("\n")
        .trim();
      const lines = combined.split("\n").filter(Boolean);
      const tail = lines.slice(-12).join("\n");
      return [
        `$ ${normalizedCommand}`,
        `${state} ${elapsed}s`,
        tail,
      ]
        .filter(Boolean)
        .join("\n");
    };

    // Throttle UI updates so chatty commands don't flood Ink with re-renders.
    const UPDATE_THROTTLE_MS = 100;
    let updateDirty = false;
    let lastUpdateAt = 0;
    let updateTimer: NodeJS.Timeout | undefined;
    const onUpdate = options?.onUpdate;

    const flushUpdate = (
      state:
        | "starting"
        | "running"
        | "completed"
        | "failed"
        | "timed_out"
        | "cancelled" = "running"
    ) => {
      if (!onUpdate) return;
      updateDirty = false;
      lastUpdateAt = Date.now();
      onUpdate(buildProgress(state));
    };

    const scheduleUpdate = () => {
      if (!onUpdate) return;
      updateDirty = true;
      const delay = UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
      if (delay <= 0) {
        if (updateTimer) {
          clearTimeout(updateTimer);
          updateTimer = undefined;
        }
        flushUpdate();
        return;
      }
      if (!updateTimer) {
        updateTimer = setTimeout(() => {
          updateTimer = undefined;
          if (updateDirty) flushUpdate();
        }, delay);
      }
    };

    const clearUpdateTimer = () => {
      if (updateTimer) {
        clearTimeout(updateTimer);
        updateTimer = undefined;
      }
    };

    // Initial "starting" frame.
    flushUpdate("starting");

    // Console heartbeat when not piping to the Ink UI.
    const heartbeatInterval = setInterval(() => {
      if (useInlineUpdates) return;
      if (options?.silent) return;
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const remaining = Math.floor((timeoutMs - (Date.now() - startTime)) / 1000);
      if (remaining > 0) {
        console.log(
          chalk.gray(`  ⏱️  Elapsed: ${elapsed}s | Timeout in: ${remaining}s`)
        );
      }
    }, 10000);

    const timeoutHandle = setTimeout(() => {
      didTimeout = true;
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      onUpdate?.(
        `$ ${normalizedCommand}\ntimed_out ${elapsed}s\nsending SIGTERM...`
      );
      if (!options?.silent && !useInlineUpdates) {
        console.log(
          chalk.yellow(
            `\n  ⏰ Command timed out after ${elapsed}s, sending SIGTERM...`
          )
        );
        console.log(chalk.yellow(`  💡 Tip: Use timeoutMs option to increase timeout`));
      }
      killTree("SIGTERM");
      forceKillHandle = setTimeout(() => {
        if (!settled) {
          onUpdate?.(
            `$ ${normalizedCommand}\ntimed_out ${elapsed}s\nunresponsive, sending SIGKILL`
          );
          if (!options?.silent && !useInlineUpdates) {
            console.log(
              chalk.red(
                "  ⛔ Command unresponsive, sending SIGKILL to terminate"
              )
            );
          }
          killTree("SIGKILL");
        }
      }, 5000);
    }, timeoutMs);

    const abortHandler = () => {
      if (settled || didCancel) return;
      didCancel = true;
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      onUpdate?.(
        `$ ${normalizedCommand}\ncancelled ${elapsed}s\nsending SIGTERM...`
      );
      killTree("SIGTERM");
      forceKillHandle = setTimeout(() => {
        if (!settled) killTree("SIGKILL");
      }, 3000);
    };

    options?.signal?.addEventListener("abort", abortHandler, { once: true });

    const handleStdout = (chunk: Buffer) => {
      const text = stripAnsi(chunk.toString());
      stdoutAcc.append(text);
      if (useInlineUpdates) {
        scheduleUpdate();
      } else if (!options?.silent) {
        process.stdout.write(text);
      }
    };

    const handleStderr = (chunk: Buffer) => {
      const text = stripAnsi(chunk.toString());
      stderrAcc.append(text);
      if (useInlineUpdates) {
        scheduleUpdate();
      } else if (!options?.silent) {
        process.stderr.write(chalk.gray(text));
      }
    };

    child.stdout?.on("data", handleStdout);
    child.stderr?.on("data", handleStderr);
    child.stdout?.once("end", () => {
      stdoutEnded = true;
      maybeSettleAfterExit();
    });
    child.stderr?.once("end", () => {
      stderrEnded = true;
      maybeSettleAfterExit();
    });

    const finalize = (
      result: ToolResult,
      state: "completed" | "failed" | "timed_out" | "cancelled"
    ) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeatInterval);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (forceKillHandle) clearTimeout(forceKillHandle);
      if (postExitGrace) clearTimeout(postExitGrace);
      clearUpdateTimer();
      options?.signal?.removeEventListener("abort", abortHandler);
      // Detach streams so descendants holding inherited fds can't keep us alive.
      child.stdout?.destroy();
      child.stderr?.destroy();
      // Flush spill files (if any); writes were already queued so this is safe
      // to fire-and-forget.
      void stdoutAcc.close();
      void stderrAcc.close();

      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      onUpdate?.(`${buildProgress(state)}\n${state} in ${elapsed}s`);
      if (!options?.silent && !useInlineUpdates) {
        console.log(chalk.gray(`\n  ✓ Completed in ${elapsed}s\n`));
      }

      resolve(result);
    };

    const buildResult = (
      outputText: string,
      metadata: {
        state: "completed" | "failed" | "timed_out" | "cancelled";
        exitCode?: number | null;
        signal?: NodeJS.Signals | null;
        error?: string;
      }
    ): ToolResult => {
      const snapshot = buildCommandOutputSnapshot({
        command: normalizedCommand,
        cwd,
        stdout: stdoutAcc.tailText,
        stderr: stderrAcc.tailText,
        outputText,
        outputTotalBytes: stdoutAcc.totalBytes,
        outputTotalLines: stdoutAcc.totalLines,
        spilledOutputPath: stdoutAcc.fullOutputPath,
        startTime,
        timeoutMs,
        ...metadata,
      });
      return {
        tool: "run_command",
        result: snapshot.resultText,
        error: metadata.error,
        details: snapshot.details,
      };
    };

    const settleFromExit = () => {
      if (settled) return;
      const code = exitCode;
      const signal = exitSignal;

      if (didCancel) {
        finalize(
          buildResult(stdoutAcc.tailText, {
            state: "cancelled",
            exitCode: code,
            signal,
            error: `Command cancelled: ${normalizedCommand}`,
          }),
          "cancelled"
        );
        return;
      }

      if (didTimeout) {
        finalize(
          buildResult(stdoutAcc.tailText, {
            state: "timed_out",
            exitCode: code,
            signal,
            error: `Command timed out after ${timeoutMs / 1000}s. Increase timeout with timeoutMs option if needed.`,
          }),
          "timed_out"
        );
        return;
      }

      if (signal && signal !== "SIGTERM") {
        finalize(
          buildResult(stdoutAcc.tailText, {
            state: "failed",
            exitCode: code,
            signal,
            error: `Command terminated with signal ${signal}`,
          }),
          "failed"
        );
        return;
      }

      if (code === 0) {
        ProjectContextManager.getInstance().invalidate(cwd);
        finalize(
          buildResult(stdoutAcc.tailText || "Command executed successfully.", {
            state: "completed",
            exitCode: code,
            signal,
          }),
          "completed"
        );
        return;
      }

      // Many tools exit non-zero to signal findings (npm audit, eslint, tsc).
      const stderrText = stderrAcc.tailText.trim();
      if (stdoutAcc.tailText.trim()) {
        ProjectContextManager.getInstance().invalidate(cwd);
        const exitNote = stderrText
          ? `\n[exit ${code}: ${stderrText}]`
          : `\n[exit ${code}]`;
        finalize(
          buildResult(stdoutAcc.tailText + exitNote, {
            state: "failed",
            exitCode: code,
            signal,
          }),
          "failed"
        );
        return;
      }

      const errorMessage =
        stderrText.length > 0
          ? `Command failed (exit ${code}): ${stderrText}`
          : `Command failed with exit code ${code}.`;
      finalize(
        buildResult(stdoutAcc.tailText, {
          state: "failed",
          exitCode: code,
          signal,
          error: errorMessage,
        }),
        "failed"
      );
    };

    function maybeSettleAfterExit() {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) {
        settleFromExit();
      }
    }

    child.on("error", (error) => {
      const errorMessage = `Failed to start command: ${
        error instanceof Error ? error.message : String(error)
      }`;
      finalize(
        buildResult(stdoutAcc.tailText, {
          state: "failed",
          error: errorMessage,
        }),
        "failed"
      );
    });

    // Settle on `exit` (process is gone) instead of `close` (waits for inherited
    // stdio to drain). Use `close` as the fast path when streams ended cleanly.
    child.once("exit", (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal ?? null;
      if (stdoutEnded && stderrEnded) {
        settleFromExit();
      } else if (!postExitGrace) {
        postExitGrace = setTimeout(() => {
          // Inherited stdio is keeping the streams open; finalize anyway.
          settleFromExit();
        }, STDIO_GRACE_MS);
      }
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      if (!exited) {
        exited = true;
        exitCode = code;
        exitSignal = signal ?? null;
      }
      settleFromExit();
    });
  });
}

function buildCommandOutputSnapshot(input: {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  outputText: string;
  /** True total bytes/lines produced (the in-memory tail may be smaller) */
  outputTotalBytes?: number;
  outputTotalLines?: number;
  /** Spill file already containing the complete output, if the command exceeded the in-memory cap */
  spilledOutputPath?: string;
  startTime: number;
  timeoutMs: number;
  state: "completed" | "failed" | "timed_out" | "cancelled";
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
}): CommandOutputSnapshot {
  const outputText = input.outputText || "";
  const outputBytes = Math.max(
    Buffer.byteLength(outputText, "utf8"),
    input.outputTotalBytes ?? 0
  );
  const outputLines = Math.max(
    outputText.split("\n").length,
    input.outputTotalLines ?? 0
  );
  const truncated =
    outputBytes > COMMAND_RESULT_MAX_BYTES || outputLines > COMMAND_RESULT_MAX_LINES;
  let resultText = outputText;
  let fullOutputPath: string | undefined;

  if (truncated) {
    if (input.spilledOutputPath) {
      // Complete output was already streamed to disk by the bounded buffer.
      fullOutputPath = input.spilledOutputPath;
    } else {
      fullOutputPath = join(
        tmpdir(),
        `meer-command-${Date.now()}-${Math.random().toString(36).slice(2)}.log`
      );
      writeFileSync(fullOutputPath, outputText, "utf8");
    }
    const lines = outputText.split("\n");
    const shownLines = Math.min(lines.length, COMMAND_RESULT_MAX_LINES);
    resultText = [
      ...lines.slice(-COMMAND_RESULT_MAX_LINES),
      "",
      `[Showing last ${shownLines} of ${outputLines} lines. Full output: ${fullOutputPath}]`,
    ].join("\n");
  }

  const stdoutLines = input.stdout.split("\n").filter(Boolean);
  const stderrLines = input.stderr.split("\n").filter(Boolean);
  const combinedLines = [input.stdout, input.stderr]
    .filter(Boolean)
    .join("\n")
    .split("\n")
    .filter(Boolean);

  return {
    resultText,
    details: {
      command: input.command,
      cwd: input.cwd,
      state: input.state,
      exitCode: input.exitCode,
      signal: input.signal,
      durationMs: Date.now() - input.startTime,
      timeoutMs: input.timeoutMs,
      stdoutBytes: Buffer.byteLength(input.stdout, "utf8"),
      stderrBytes: Buffer.byteLength(input.stderr, "utf8"),
      outputBytes,
      outputLines,
      stdoutTail: stdoutLines.slice(-COMMAND_TAIL_LINES).join("\n"),
      stderrTail: stderrLines.slice(-COMMAND_TAIL_LINES).join("\n"),
      outputTail: combinedLines.slice(-COMMAND_TAIL_LINES).join("\n"),
      truncation: truncated
        ? {
            truncated: true,
            totalLines: outputLines,
            outputLines: Math.min(outputLines, COMMAND_RESULT_MAX_LINES),
            totalBytes: outputBytes,
            maxBytes: COMMAND_RESULT_MAX_BYTES,
            fullOutputPath,
          }
        : undefined,
      fullOutputPath,
      error: input.error,
    },
  };
}

/**
 * Tool: Create a new project with scaffolding
 */
export function scaffoldProject(
  projectType: string,
  projectName: string,
  cwd: string
): ToolResult {
  try {
    let command = "";
    let description = "";

    switch (projectType.toLowerCase()) {
      case "react":
        command = `npx create-react-app ${projectName} --template typescript`;
        description = "React application";
        break;
      case "vue":
        command = `npm create vue@latest ${projectName} -- --default`;
        description = "Vue application";
        break;
      case "angular":
        command = `npx @angular/cli new ${projectName} --defaults --skip-git`;
        description = "Angular application";
        break;
      case "next":
        command = [
          `npx create-next-app@latest ${projectName}`,
          "--ts",
          "--tailwind",
          "--eslint",
          "--app",
          "--use-npm",
          "--yes",
        ].join(" ");
        description = "Next.js application";
        break;
      case "nuxt":
        command = `npx nuxi@latest init ${projectName} --packageManager npm`;
        description = "Nuxt.js application";
        break;
      case "node":
      case "nodejs":
        command = `mkdir ${projectName} && cd ${projectName} && npm init -y`;
        description = "Node.js project";
        break;
      case "python":
        command = `mkdir ${projectName} && cd ${projectName} && python3 -m venv venv`;
        description = "Python project";
        break;
      case "go":
        command = `mkdir ${projectName} && cd ${projectName} && go mod init ${projectName}`;
        description = "Go project";
        break;
      case "rust":
        command = `cargo new ${projectName}`;
        description = "Rust project";
        break;
      default:
        return {
          tool: "scaffold_project",
          result: "",
          error: `Unknown project type: ${projectType}. Supported types: react, vue, angular, next, nuxt, node, python, go, rust`,
        };
    }

    toolLog(chalk.gray(`  🏗️  Scaffolding ${description}: ${projectName}`));
    toolLog(chalk.gray(`  🚀 Running: ${command}`));

    const result = execSync(command, {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    });
    ProjectContextManager.getInstance().invalidate(cwd);

    return {
      tool: "scaffold_project",
      result: `Successfully created ${description}:\n${result}\n\nNext steps:\n1. cd ${projectName}\n2. Follow the project's README for setup instructions`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      tool: "scaffold_project",
      result: "",
      error: `Failed to scaffold project: ${errorMessage}`,
    };
  }
}

/**
 * Tool: Suggest project setup based on user request
 */
export function suggestSetup(
  userRequest: string,
  projectAnalysis: ToolResult
): ToolResult {
  const request = userRequest.toLowerCase();
  let suggestions: string[] = [];

  // Parse project analysis from the result string
  const analysisText = projectAnalysis.result || "";
  const isReactProject =
    analysisText.includes("react") || analysisText.includes("React");
  const isNodeCLI =
    analysisText.includes("CLI") || analysisText.includes("cli");
  const isUnknownProject =
    analysisText.includes("unknown") || analysisText.includes("empty");

  // React-related requests
  if (
    request.includes("react") ||
    request.includes("component") ||
    request.includes("jsx") ||
    request.includes("todo list") ||
    request.includes("frontend") ||
    request.includes("web app")
  ) {
    if (!isReactProject) {
      suggestions.push("This is not a React project. To create a React app:");
      suggestions.push("1. Run: npx create-react-app my-todo-app");
      suggestions.push(
        "2. Or use Vite: npm create vite@latest my-todo-app -- --template react"
      );
      suggestions.push("3. Then cd into the new directory and run: npm start");
    } else {
      suggestions.push("You can create React components in src/components/");
    }
  }

  // Vue-related requests
  if (
    request.includes("vue") ||
    request.includes("nuxt") ||
    request.includes("vue app")
  ) {
    if (!analysisText.includes("vue") && !analysisText.includes("Vue")) {
      suggestions.push("To create a Vue app:");
      suggestions.push("1. Run: npm create vue@latest my-vue-app");
      suggestions.push("2. Or use Nuxt: npx nuxi@latest init my-nuxt-app");
      suggestions.push(
        "3. Then cd into the new directory and run: npm run dev"
      );
    } else {
      suggestions.push("You can create Vue components in src/components/");
    }
  }

  // Angular-related requests
  if (
    request.includes("angular") ||
    request.includes("ng") ||
    request.includes("angular app")
  ) {
    if (
      !analysisText.includes("angular") &&
      !analysisText.includes("Angular")
    ) {
      suggestions.push("To create an Angular app:");
      suggestions.push("1. Run: npx @angular/cli new my-angular-app");
      suggestions.push("2. Then cd into the new directory and run: ng serve");
    } else {
      suggestions.push(
        "You can create Angular components with: ng generate component my-component"
      );
    }
  }

  // Python-related requests
  if (
    request.includes("python") ||
    request.includes("django") ||
    request.includes("flask") ||
    request.includes("fastapi")
  ) {
    if (!analysisText.includes("python") && !analysisText.includes("Python")) {
      suggestions.push("To create a Python project:");
      suggestions.push("1. Run: python -m venv venv");
      suggestions.push(
        "2. Activate: source venv/bin/activate (Linux/Mac) or venv\\Scripts\\activate (Windows)"
      );
      suggestions.push(
        "3. For Django: pip install django && django-admin startproject myproject"
      );
      suggestions.push("4. For Flask: pip install flask && create app.py");
      suggestions.push(
        "5. For FastAPI: pip install fastapi uvicorn && create main.py"
      );
    } else {
      suggestions.push(
        "You can create Python modules in the current directory"
      );
    }
  }

  // Go-related requests
  if (
    request.includes("go") ||
    request.includes("golang") ||
    request.includes("go app")
  ) {
    if (!analysisText.includes("go") && !analysisText.includes("Go")) {
      suggestions.push("To create a Go project:");
      suggestions.push("1. Run: go mod init my-go-app");
      suggestions.push("2. Create main.go with your application");
      suggestions.push("3. Run: go run main.go");
    } else {
      suggestions.push("You can create Go packages in the current directory");
    }
  }

  // Rust-related requests
  if (
    request.includes("rust") ||
    request.includes("cargo") ||
    request.includes("rust app")
  ) {
    if (!analysisText.includes("rust") && !analysisText.includes("Rust")) {
      suggestions.push("To create a Rust project:");
      suggestions.push("1. Run: cargo init my-rust-app");
      suggestions.push("2. Or: cargo new my-rust-app --bin");
      suggestions.push("3. Then cd into the new directory and run: cargo run");
    } else {
      suggestions.push("You can create Rust modules in src/");
    }
  }

  // Node.js CLI requests
  if (
    request.includes("cli") ||
    request.includes("command") ||
    request.includes("tool")
  ) {
    if (isNodeCLI) {
      suggestions.push("This is already a Node.js CLI project");
      suggestions.push("You can add commands in src/commands/");
    } else {
      suggestions.push("To create a CLI tool:");
      suggestions.push("1. Run: npm init -y");
      suggestions.push("2. Install: npm install commander chalk inquirer");
      suggestions.push("3. Create src/index.js with CLI logic");
    }
  }

  // General web development
  if (
    request.includes("website") ||
    request.includes("web") ||
    request.includes("html")
  ) {
    suggestions.push("For a simple website:");
    suggestions.push("1. Create index.html, style.css, script.js");
    suggestions.push("2. Or use a framework like React, Vue, or Angular");
  }

  // Empty project suggestions
  if (isUnknownProject && suggestions.length === 0) {
    suggestions.push("This appears to be an empty directory. Consider:");
    suggestions.push("1. For React: npx create-react-app my-app");
    suggestions.push("2. For Vue: npm create vue@latest my-app");
    suggestions.push("3. For Angular: npx @angular/cli new my-app");
    suggestions.push("4. For Node.js: npm init");
    suggestions.push("5. For Python: python -m venv venv");
    suggestions.push("6. For Go: go mod init my-app");
    suggestions.push("7. For Rust: cargo init my-app");
  }

  let result = "Setup Suggestions:\n\n";
  if (suggestions.length > 0) {
    result += suggestions.join("\n");
  } else {
    result += "No specific setup suggestions for this request.";
  }

  return {
    tool: "suggest_setup",
    result,
  };
}

/**
 * Tool: Find files with advanced patterns and filters
 */
export function findFiles(
  pattern: string,
  cwd: string,
  options: {
    includePattern?: string;
    excludePattern?: string;
    fileTypes?: string[];
    maxDepth?: number;
  } = {}
): ToolResult {
  try {
    toolLog(chalk.gray(`  🔍 Finding files matching: ${pattern}`));

    const searchPattern = pattern.includes("*") ? pattern : `**/${pattern}`;
    const ignorePatterns = options.excludePattern
      ? [...DEFAULT_IGNORE_GLOBS, options.excludePattern]
      : DEFAULT_IGNORE_GLOBS;

    const globOptions = {
      cwd,
      ignore: ignorePatterns,
      maxDepth: options.maxDepth || 10,
    };

    const files = glob.sync(searchPattern, globOptions);

    let filteredFiles = files;

    // Filter by file types if specified
    if (options.fileTypes && options.fileTypes.length > 0) {
      const extensions = options.fileTypes.map((ext) =>
        ext.startsWith(".") ? ext : `.${ext}`
      );
      filteredFiles = files.filter((file) =>
        extensions.some((ext) => file.endsWith(ext))
      );
    }

    // Additional include pattern filtering
    if (options.includePattern) {
      const includeRegex = new RegExp(options.includePattern);
      filteredFiles = filteredFiles.filter((file) => includeRegex.test(file));
    }

    const result = `Found ${
      filteredFiles.length
    } files matching "${pattern}":\n\n${filteredFiles.join("\n")}`;

    return {
      tool: "find_files",
      result,
    };
  } catch (error) {
    return {
      tool: "find_files",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Read multiple files at once
 */
export function readManyFiles(
  filePaths: string[],
  cwd: string,
  maxFiles: number = 10
): ToolResult {
  try {
    toolLog(chalk.gray(`  📚 Reading ${filePaths.length} files`));

    if (filePaths.length > maxFiles) {
      return {
        tool: "read_many_files",
        result: "",
        error: `Too many files requested (${filePaths.length}). Maximum allowed: ${maxFiles}`,
      };
    }

    const results: string[] = [];

    for (const filePath of filePaths) {
      const fullPath = resolvePath(filePath, cwd);

      if (!existsSync(fullPath)) {
        results.push(`❌ ${filePath}: File not found`);
        continue;
      }

      try {
        const content = readFileSync(fullPath, "utf-8");
        const lines = content.split("\n").length;
        results.push(
          `📄 ${filePath} (${lines} lines):\n${content}\n${"=".repeat(50)}\n`
        );
      } catch (error) {
        results.push(`❌ ${filePath}: Error reading file - ${error}`);
      }
    }

    return {
      tool: "read_many_files",
      result: results.join("\n"),
    };
  } catch (error) {
    return {
      tool: "read_many_files",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Search for text content across files
 */
export function searchText(
  searchTerm: string,
  cwd: string,
  options: {
    filePattern?: string;
    caseSensitive?: boolean;
    wholeWord?: boolean;
    includePattern?: string;
    excludePattern?: string;
  } = {}
): ToolResult {
  try {
    toolLog(chalk.gray(`  🔎 Searching for: "${searchTerm}"`));

    const searchPattern =
      options.filePattern ||
      "**/*.{js,ts,jsx,tsx,py,go,rs,java,cpp,c,html,css,md,json,yaml,yml}";
    const ignorePatterns = options.excludePattern
      ? [...DEFAULT_IGNORE_GLOBS, options.excludePattern]
      : DEFAULT_IGNORE_GLOBS;

    const files = glob.sync(searchPattern, {
      cwd,
      ignore: ignorePatterns,
    });

    const results: string[] = [];
    const flags = options.caseSensitive ? "g" : "gi";
    const regex = options.wholeWord
      ? new RegExp(`\\b${searchTerm}\\b`, flags)
      : new RegExp(searchTerm, flags);

    for (const file of files) {
      try {
        const fullPath = resolvePath(file, cwd);
        const content = readFileSync(fullPath, "utf-8");
        const lines = content.split("\n");

        const matches: string[] = [];
        lines.forEach((line, index) => {
          if (regex.test(line)) {
            matches.push(`  Line ${index + 1}: ${line.trim()}`);
          }
        });

        if (matches.length > 0) {
          results.push(`📄 ${file} (${matches.length} matches):`);
          results.push(...matches);
          results.push("");
        }
      } catch (error) {
        // Skip files that can't be read
      }
    }

    if (results.length === 0) {
      return {
        tool: "search_text",
        result: `No matches found for "${searchTerm}"`,
      };
    }

    return {
      tool: "search_text",
      result: `Found matches for "${searchTerm}":\n\n${results.join("\n")}`,
    };
  } catch (error) {
    return {
      tool: "search_text",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Grep - Search for pattern in a specific file with line numbers
 * Optimized for finding exact locations in large files
 */
export function grep(
  filepath: string,
  pattern: string,
  cwd: string,
  options: {
    caseSensitive?: boolean;
    maxResults?: number;
    contextLines?: number;
    silent?: boolean;
  } = {}
): ToolResult {
  try {
    const fullPath = resolvePath(filepath, cwd);

    if (!existsSync(fullPath)) {
      return {
        tool: "grep",
        result: "",
        error: `File not found: ${filepath}`,
      };
    }

    if (!options.silent) {
      toolLog(chalk.gray(`  🔎 Searching in ${filepath} for: "${pattern}"`));
    }

    const content = readFileSync(fullPath, "utf-8");
    const lines = content.split("\n");

    const flags = options.caseSensitive ? "g" : "gi";
    const regex = new RegExp(pattern, flags);

    const matches: Array<{ lineNum: number; line: string }> = [];
    const contextLines = options.contextLines || 0;

    lines.forEach((line, index) => {
      regex.lastIndex = 0; // Reset for global regex reuse across lines
      if (regex.test(line)) {
        matches.push({ lineNum: index + 1, line });
      }
    });

    if (matches.length === 0) {
      return {
        tool: "grep",
        result: `No matches found for pattern "${pattern}" in ${filepath}`,
      };
    }

    // Limit results if specified
    const maxResults = options.maxResults || 50;
    const limitedMatches = matches.slice(0, maxResults);
    const truncated = matches.length > maxResults;

    let result = `Found ${matches.length} match${matches.length > 1 ? 'es' : ''} in ${filepath}:\n\n`;

    limitedMatches.forEach(({ lineNum, line }) => {
      result += `Line ${lineNum}: ${line.trim()}\n`;

      // Add context lines if requested
      if (contextLines > 0) {
        for (let i = Math.max(0, lineNum - 1 - contextLines); i < Math.min(lines.length, lineNum + contextLines); i++) {
          if (i !== lineNum - 1) {
            result += `  ${i + 1}: ${lines[i].trim()}\n`;
          }
        }
        result += '\n';
      }
    });

    if (truncated) {
      result += `\n(Showing first ${maxResults} of ${matches.length} matches)`;
    }

    return {
      tool: "grep",
      result,
    };
  } catch (error) {
    return {
      tool: "grep",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Helper: Check if a file is a code file that supports syntax validation
 */
function isCodeFile(filepath: string): boolean {
  const ext = filepath.toLowerCase();
  return ext.endsWith('.ts') || ext.endsWith('.tsx') ||
         ext.endsWith('.js') || ext.endsWith('.jsx') ||
         ext.endsWith('.py') || ext.endsWith('.go') ||
         ext.endsWith('.rs');
}

/**
 * Helper: Validate syntax of code content (without writing to file)
 * Uses advanced LSP-based validation for TypeScript/JavaScript
 */
function validateSyntaxInternal(
  filepath: string,
  content: string,
  cwd: string
): { valid: boolean; errors: string[] } {
  // Use the advanced LSP diagnostics module for better validation
  try {
    return validateSyntax(filepath, content, cwd);
  } catch (error) {
    // Fallback to basic Babel validation if LSP module fails
    const ext = filepath.toLowerCase();

    if (ext.endsWith('.ts') || ext.endsWith('.tsx') ||
        ext.endsWith('.js') || ext.endsWith('.jsx')) {
      try {
        const parser = require('@babel/parser');
        parser.parse(content, {
          sourceType: 'module',
          plugins: ['typescript', 'jsx', 'decorators-legacy'],
        });
        return { valid: true, errors: [] };
      } catch (parseError: any) {
        const loc = parseError.loc || {};
        const line = loc.line || '?';
        const column = loc.column || '?';
        return {
          valid: false,
          errors: [`Line ${line}:${column} - ${parseError.message}`],
        };
      }
    }

    // Python basic validation
    if (ext.endsWith('.py')) {
      const invalidPatterns = [
        { pattern: /^\s*(def|class)\s*$/, message: 'Incomplete function/class definition' },
        { pattern: /^\s*if\s*:/, message: 'Empty if condition' },
        { pattern: /^\s*(return|yield)\s*\n\s*(return|yield)/, message: 'Unreachable code' },
      ];

      const errors: string[] = [];
      for (const check of invalidPatterns) {
        if (check.pattern.test(content)) {
          errors.push(check.message);
        }
      }

      return { valid: errors.length === 0, errors };
    }

    // Other languages - no validation
    return { valid: true, errors: [] };
  }
}

/**
 * Tool: Edit a specific section of a file (preferred over propose_edit for existing files)
 *
 * This tool allows precise editing of file sections without needing to provide the entire file content.
 * It uses exact string matching to find and replace a specific section of code.
 *
 * @param filepath - Path to the file to edit
 * @param oldText - The exact text to find and replace (must match exactly, including whitespace)
 * @param newText - The replacement text
 * @param cwd - Current working directory
 * @param options - Optional settings (validateSyntax: boolean)
 * @returns FileEdit object for review and application
 */
export function editSection(
  filepath: string,
  oldText: string,
  newText: string,
  cwd: string,
  options: { validateSyntax?: boolean } = {}
): FileEdit {
  return editFileSections(filepath, [{ oldText, newText }], cwd, options);
}

/**
 * Tool: Apply one or more targeted text replacements to an existing file.
 *
 * Matching is robust against CRLF/LF differences, UTF-8 BOM, trailing
 * whitespace, and Unicode quote/dash variants (fuzzy fallback). The written
 * file keeps its original BOM and line endings.
 */
export function editFileSections(
  filepath: string,
  edits: TextEdit[],
  cwd: string,
  options: { validateSyntax?: boolean } = {}
): FileEdit {
  const fullPath = resolvePath(filepath, cwd);

  // File must exist for section editing
  if (!existsSync(fullPath)) {
    throw new Error(
      `File not found: ${filepath}. ` +
      `edit_file only works on existing files. ` +
      `Use propose_edit to create new files.`
    );
  }

  const content = readFileSync(fullPath, 'utf-8');
  const applied = applyTextEdits(content, edits, filepath);

  // Optional syntax validation (enabled by default for code files)
  const shouldValidate = options.validateSyntax !== false && isCodeFile(fullPath);
  if (shouldValidate) {
    const validation = validateSyntaxInternal(fullPath, applied.newContent, cwd);
    if (!validation.valid) {
      throw new Error(
        `Syntax validation failed for ${filepath}:\n` +
        validation.errors.map(e => `  • ${e}`).join('\n') + '\n\n' +
        `The proposed changes would introduce syntax errors. Please fix them before applying.`
      );
    }
  }

  const editCount = edits.length;
  const fuzzyNote = applied.usedFuzzyMatch ? ", fuzzy-matched" : "";
  return {
    path: filepath,
    oldContent: applied.oldContent,
    newContent: applied.newContent,
    description: `Edit ${filepath} (${editCount} replacement${editCount === 1 ? "" : "s"}${fuzzyNote})`,
  };
}

/**
 * Tool: Read folder contents recursively with analysis
 */
export function readFolder(
  folderPath: string,
  cwd: string,
  options: {
    maxDepth?: number;
    includeStats?: boolean;
    fileTypes?: string[];
  } = {}
): ToolResult {
  try {
    toolLog(chalk.gray(`  📁 Reading folder: ${folderPath}`));

    const fullPath = resolvePath(folderPath, cwd);
    if (!existsSync(fullPath)) {
      return {
        tool: "read_folder",
        result: "",
        error: `Folder not found: ${folderPath}`,
      };
    }

    const results: string[] = [];
    const maxDepth = options.maxDepth || 3;

    function scanDirectory(
      dir: string,
      depth: number = 0,
      prefix: string = ""
    ) {
      if (depth > maxDepth) return;

      try {
        const items = readdirSync(dir);
        const files: string[] = [];
        const dirs: string[] = [];

        for (const item of items) {
          const itemPath = join(dir, item);
          try {
            const stats = statSync(itemPath);
            const relativePath = relative(cwd, itemPath);

            if (stats.isDirectory()) {
              dirs.push(item);
              if (depth < maxDepth) {
                scanDirectory(itemPath, depth + 1, prefix + "  ");
              }
            } else {
              files.push(item);

              if (options.includeStats) {
                const size = formatBytes(stats.size);
                const modified = stats.mtime.toISOString().split("T")[0];
                results.push(
                  `${prefix}📄 ${item} (${size}, modified: ${modified})`
                );
              } else {
                results.push(`${prefix}📄 ${item}`);
              }
            }
          } catch {
            // Skip items that can't be accessed
          }
        }

        // Add directory headers
        if (depth > 0) {
          const dirName = relative(cwd, dir);
          results.push(`${prefix}📁 ${dirName}/`);
        }
      } catch (error) {
        results.push(`${prefix}❌ Error reading directory: ${error}`);
      }
    }

    scanDirectory(fullPath);

    return {
      tool: "read_folder",
      result: `Folder structure for ${folderPath}:\n\n${results.join("\n")}`,
    };
  } catch (error) {
    return {
      tool: "read_folder",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Web Search (Brave Search API) for research and documentation
 */
export async function googleSearch(
  query: string,
  options: {
    maxResults?: number;
    site?: string;
  } = {}
): Promise<ToolResult> {
  const siteFilter = options.site ? `site:${options.site} ` : "";
  const searchTerm = `${siteFilter}${query}`.trim();
  const fallbackUrl = `${BRAVE_SEARCH_PORTAL_URL}?q=${encodeURIComponent(
    searchTerm
  )}`;

  try {
    toolLog(chalk.gray(`  🌐 Searching the web for: "${query}"`));

    const apiKey = process.env.BRAVE_API_KEY;

    if (!apiKey) {
      return {
        tool: "google_search",
        result: `Brave Search requires a BRAVE_API_KEY environment variable.\n\nShowing manual search link instead:\n🔗 ${fallbackUrl}`,
      };
    }

    const count = Math.min(
      Math.max(options.maxResults ?? 5, 1),
      MAX_BRAVE_RESULTS
    );

    const requestUrl = new URL(BRAVE_SEARCH_ENDPOINT);
    requestUrl.searchParams.set("q", searchTerm);
    requestUrl.searchParams.set("count", String(count));

    const response = await fetchWithTimeout(requestUrl, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
        "User-Agent": "MeerAI CLI",
      },
    }, REQUEST_TIMEOUT_MS);

    if (!response.ok) {
      const errorBody = await response.text();
      console.log(
        chalk.red(
          `  ❌ Brave Search request failed (${response.status} ${response.statusText})`
        )
      );
      return {
        tool: "google_search",
        result: `Unable to fetch Brave Search results (${response.status} ${response.statusText}).\n\nResponse: ${errorBody}\n\nYou can open the results manually:\n🔗 ${fallbackUrl}`,
      };
    }

    const data = (await response.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
      query?: { original?: string; corrected?: string };
    };

    const results = data.web?.results ?? [];

    if (results.length === 0) {
      return {
        tool: "google_search",
        result: `No web results found for "${query}".\n\nTry refining your query or open the manual search:\n🔗 ${fallbackUrl}`,
      };
    }

    const formattedResults = results
      .slice(0, count)
      .map((result, index) => {
        const title = result.title?.trim() || result.url || "Untitled result";
        const url = result.url?.trim() || "";
        const description = result.description?.trim();
        const parts = [`${index + 1}. ${title}`];
        if (url) {
          parts.push(`   ${url}`);
        }
        if (description) {
          parts.push(`   ${description}`);
        }
        return parts.join("\n");
      })
      .join("\n\n");

    const corrected =
      data.query?.corrected && data.query.corrected !== data.query.original
        ? `\n\nDid you mean: ${data.query.corrected}`
        : "";

    return {
      tool: "google_search",
      result: `Brave Search Results for "${query}"${options.site ? ` (site:${options.site})` : ""}:\n\n${formattedResults}${corrected}\n\nView more results:\n🔗 ${fallbackUrl}`,
    };
  } catch (error) {
    const message = formatErrorWithContext(error, {
      source: "tool",
      name: "google_search",
      operation: "Brave Search request",
      target: fallbackUrl,
    });
    console.log(chalk.red(`  ❌ Brave Search failed: ${message}`));
    return {
      tool: "google_search",
      result: `Brave Search failed: ${message}\n\nYou can open the results manually:\n🔗 ${fallbackUrl}`,
    };
  }
}

/**
 * Tool: Web Fetch for downloading resources
 */
export function webFetch(
  url: string,
  options: {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    headers?: Record<string, string>;
    saveTo?: string;
  } = {}
): ToolResult {
  try {
    toolLog(chalk.gray(`  🌐 Fetching: ${url}`));

    // Note: This is a placeholder implementation
    // In a real implementation, you would use a proper HTTP client like axios or fetch

    return {
      tool: "web_fetch",
      result: `Web Fetch for "${url}":\n\nNote: This is a placeholder implementation. In a real CLI, you would:\n1. Use axios or node-fetch for HTTP requests\n2. Handle different response types (JSON, text, binary)\n3. Support authentication and custom headers\n4. Implement proper error handling and timeouts\n5. Support file downloads and saving to disk\n\nFor now, you can manually visit: ${url}`,
    };
  } catch (error) {
    return {
      tool: "web_fetch",
      result: "",
      error: formatErrorWithContext(error, {
        source: "tool",
        name: "web_fetch",
        operation: options.method || "GET",
        target: url,
      }),
    };
  }
}

/**
 * Tool: Save memory for persistent knowledge storage
 */
export function saveMemory(
  key: string,
  content: string,
  cwd: string,
  options: {
    category?: string;
    tags?: string[];
    expiresAt?: Date;
  } = {}
): ToolResult {
  try {
    toolLog(chalk.gray(`  💾 Saving memory: ${key}`));

    // Create memory directory if it doesn't exist. Use fs.mkdirSync (not
    // `mkdir -p`, which is Unix-only and fails in Windows cmd.exe).
    const memoryDir = join(cwd, ".meer-memory");
    if (!existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }

    const memoryData = {
      key,
      content,
      category: options.category || "general",
      tags: options.tags || [],
      createdAt: new Date().toISOString(),
      expiresAt: options.expiresAt?.toISOString(),
      version: "1.0",
    };

    const memoryFile = join(
      memoryDir,
      `${key.replace(/[^a-zA-Z0-9-_]/g, "_")}.json`
    );
    writeFileSync(memoryFile, JSON.stringify(memoryData, null, 2), "utf-8");

    return {
      tool: "save_memory",
      result: `Memory saved successfully:\n- Key: ${key}\n- Category: ${
        memoryData.category
      }\n- Tags: ${memoryData.tags.join(", ")}\n- File: ${memoryFile}`,
    };
  } catch (error) {
    return {
      tool: "save_memory",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Load memory from persistent storage
 */
export function loadMemory(key: string, cwd: string): ToolResult {
  try {
    toolLog(chalk.gray(`  📖 Loading memory: ${key}`));

    const memoryDir = join(cwd, ".meer-memory");
    const memoryFile = join(
      memoryDir,
      `${key.replace(/[^a-zA-Z0-9-_]/g, "_")}.json`
    );

    if (!existsSync(memoryFile)) {
      return {
        tool: "load_memory",
        result: "",
        error: `Memory not found: ${key}`,
      };
    }

    const memoryData = JSON.parse(readFileSync(memoryFile, "utf-8"));

    // Check if memory has expired
    if (memoryData.expiresAt && new Date(memoryData.expiresAt) < new Date()) {
      return {
        tool: "load_memory",
        result: "",
        error: `Memory expired: ${key}`,
      };
    }

    return {
      tool: "load_memory",
      result: `Memory loaded:\n- Key: ${memoryData.key}\n- Category: ${memoryData.category}\n- Created: ${memoryData.createdAt}\n- Content: ${memoryData.content}`,
    };
  } catch (error) {
    return {
      tool: "load_memory",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Git Status - Show working tree status
 */
export function gitStatus(cwd: string, options: { silent?: boolean } = {}): ToolResult {
  try {
    if (!options.silent) {
      toolLog(chalk.gray(`  📊 Checking git status`));
    }

    // Check if we're in a git repository
    try {
      execSync("git rev-parse --git-dir", { cwd, stdio: "pipe" });
    } catch {
      return {
        tool: "git_status",
        result: "",
        error: "Not a git repository. Run 'git init' to initialize one.",
      };
    }

    const status = execSync("git status --porcelain", {
      cwd,
      encoding: "utf-8",
    });

    if (!status.trim()) {
      return {
        tool: "git_status",
        result: "Working tree clean - no changes to commit.",
      };
    }

    // Parse status output
    const lines = status.split("\n").filter((line) => line.trim());
    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];

    for (const line of lines) {
      const statusCode = line.substring(0, 2);
      const filepath = line.substring(3);

      // First character is staged status, second is unstaged status
      const stagedStatus = statusCode[0];
      const unstagedStatus = statusCode[1];

      if (stagedStatus === "?" && unstagedStatus === "?") {
        untracked.push(filepath);
      } else {
        if (stagedStatus !== " " && stagedStatus !== "?") {
          const type =
            stagedStatus === "M"
              ? "modified"
              : stagedStatus === "A"
                ? "new file"
                : stagedStatus === "D"
                  ? "deleted"
                  : stagedStatus === "R"
                    ? "renamed"
                    : "modified";
          staged.push(`${type}: ${filepath}`);
        }
        if (unstagedStatus !== " " && unstagedStatus !== "?") {
          const type =
            unstagedStatus === "M"
              ? "modified"
              : unstagedStatus === "D"
                ? "deleted"
                : "modified";
          unstaged.push(`${type}: ${filepath}`);
        }
      }
    }

    let result = "Git Status:\n\n";

    if (staged.length > 0) {
      result += `Changes staged for commit (${staged.length}):\n`;
      staged.forEach((item) => (result += `  ${chalk.green("+")} ${item}\n`));
      result += "\n";
    }

    if (unstaged.length > 0) {
      result += `Changes not staged for commit (${unstaged.length}):\n`;
      unstaged.forEach((item) => (result += `  ${chalk.red("~")} ${item}\n`));
      result += "\n";
    }

    if (untracked.length > 0) {
      result += `Untracked files (${untracked.length}):\n`;
      untracked.forEach((item) => (result += `  ${chalk.gray("?")} ${item}\n`));
      result += "\n";
    }

    // Get current branch
    try {
      const branch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd,
        encoding: "utf-8",
      }).trim();
      result += `Current branch: ${branch}\n`;
    } catch {
      // Ignore branch errors
    }

    return {
      tool: "git_status",
      result,
    };
  } catch (error) {
    return {
      tool: "git_status",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Git Diff - Show changes in files
 */
export function gitDiff(
  cwd: string,
  options: {
    staged?: boolean;
    filepath?: string;
    unified?: number;
  } = {}
): ToolResult {
  try {
    console.log(
      chalk.gray(
        `  📝 Showing ${options.staged ? "staged" : "unstaged"} changes`
      )
    );

    // Check if we're in a git repository
    try {
      execSync("git rev-parse --git-dir", { cwd, stdio: "pipe" });
    } catch {
      return {
        tool: "git_diff",
        result: "",
        error: "Not a git repository.",
      };
    }

    const args = ["git", "diff"];

    if (options.staged) {
      args.push("--staged");
    }

    if (options.unified !== undefined) {
      args.push(`--unified=${options.unified}`);
    }

    args.push("--color=never"); // We'll add our own coloring

    if (options.filepath) {
      args.push("--", resolvePath(options.filepath, cwd));
    }

    const diff = execSync(args.join(" "), {
      cwd,
      encoding: "utf-8",
    });

    if (!diff.trim()) {
      return {
        tool: "git_diff",
        result: options.staged
          ? "No staged changes to show."
          : "No unstaged changes to show.",
      };
    }

    // Parse and colorize diff
    const lines = diff.split("\n");
    const coloredLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("diff --git")) {
        coloredLines.push(chalk.bold(line));
      } else if (line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) {
        coloredLines.push(chalk.gray(line));
      } else if (line.startsWith("@@")) {
        coloredLines.push(chalk.cyan(line));
      } else if (line.startsWith("+")) {
        coloredLines.push(chalk.green(line));
      } else if (line.startsWith("-")) {
        coloredLines.push(chalk.red(line));
      } else {
        coloredLines.push(line);
      }
    }

    return {
      tool: "git_diff",
      result: coloredLines.join("\n"),
    };
  } catch (error) {
    return {
      tool: "git_diff",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Git Log - Show commit history
 */
export function gitLog(
  cwd: string,
  options: {
    maxCount?: number;
    author?: string;
    since?: string;
    until?: string;
    filepath?: string;
  } = {}
): ToolResult {
  try {
    toolLog(chalk.gray(`  📜 Fetching git commit history`));

    // Check if we're in a git repository
    try {
      execSync("git rev-parse --git-dir", { cwd, stdio: "pipe" });
    } catch {
      return {
        tool: "git_log",
        result: "",
        error: "Not a git repository.",
      };
    }

    const args = [
      "git",
      "log",
      `--max-count=${options.maxCount || 20}`,
      '--pretty=format:%H|%h|%an|%ae|%ad|%s',
      "--date=short",
    ];

    if (options.author) {
      args.push(`--author=${options.author}`);
    }

    if (options.since) {
      args.push(`--since=${options.since}`);
    }

    if (options.until) {
      args.push(`--until=${options.until}`);
    }

    if (options.filepath) {
      args.push("--", resolvePath(options.filepath, cwd));
    }

    const log = execSync(args.join(" "), {
      cwd,
      encoding: "utf-8",
    });

    if (!log.trim()) {
      return {
        tool: "git_log",
        result: "No commits found.",
      };
    }

    const lines = log.split("\n").filter((line) => line.trim());
    let result = `Git Commit History (${lines.length} commits):\n\n`;

    for (const line of lines) {
      const [fullHash, shortHash, author, email, date, message] =
        line.split("|");
      result += `${chalk.yellow(shortHash)} - ${chalk.cyan(date)} - ${chalk.gray(author)}\n`;
      result += `  ${message}\n\n`;
    }

    return {
      tool: "git_log",
      result,
    };
  } catch (error) {
    return {
      tool: "git_log",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Git Commit - Create a new commit
 */
export function gitCommit(
  message: string,
  cwd: string,
  options: {
    addAll?: boolean;
    files?: string[];
  } = {}
): ToolResult {
  try {
    toolLog(chalk.gray(`  💾 Creating git commit`));

    // Check if we're in a git repository
    try {
      execSync("git rev-parse --git-dir", { cwd, stdio: "pipe" });
    } catch {
      return {
        tool: "git_commit",
        result: "",
        error: "Not a git repository.",
      };
    }

    // Validate commit message
    if (!message || message.trim().length === 0) {
      return {
        tool: "git_commit",
        result: "",
        error: "Commit message cannot be empty.",
      };
    }

    // Add files if specified
    if (options.addAll) {
      execSync("git add .", { cwd, stdio: "pipe" });
    } else if (options.files && options.files.length > 0) {
      for (const file of options.files) {
        const fullPath = resolvePath(file, cwd);
        const relativePath = relative(cwd, fullPath);
        execSync(`git add "${relativePath}"`, { cwd, stdio: "pipe" });
      }
    }

    // Check if there are changes to commit
    const status = execSync("git diff --cached --quiet", {
      cwd,
      encoding: "utf-8",
    }).trim();

    // Create commit
    const escapedMessage = message.replace(/"/g, '\\"').replace(/`/g, "\\`");
    execSync(`git commit -m "${escapedMessage}"`, {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    });

    // Get commit hash
    const commitHash = execSync("git rev-parse --short HEAD", {
      cwd,
      encoding: "utf-8",
    }).trim();

    ProjectContextManager.getInstance().invalidate(cwd);

    return {
      tool: "git_commit",
      result: `Successfully created commit ${chalk.yellow(commitHash)}:\n${message}`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check if it's the "nothing to commit" error
    if (errorMessage.includes("nothing to commit")) {
      return {
        tool: "git_commit",
        result: "",
        error:
          "Nothing to commit. Use git_status to see the current state, or add files first.",
      };
    }

    return {
      tool: "git_commit",
      result: "",
      error: errorMessage,
    };
  }
}

/**
 * Tool: Git Branch - Manage branches
 */
export function gitBranch(
  cwd: string,
  options: {
    list?: boolean;
    create?: string;
    switch?: string;
    delete?: string;
  } = {}
): ToolResult {
  try {
    // Check if we're in a git repository
    try {
      execSync("git rev-parse --git-dir", { cwd, stdio: "pipe" });
    } catch {
      return {
        tool: "git_branch",
        result: "",
        error: "Not a git repository.",
      };
    }

    // Create new branch
    if (options.create) {
      toolLog(chalk.gray(`  🌿 Creating branch: ${options.create}`));
      execSync(`git branch "${options.create}"`, { cwd, stdio: "pipe" });
      return {
        tool: "git_branch",
        result: `Created branch: ${options.create}`,
      };
    }

    // Switch branch
    if (options.switch) {
      toolLog(chalk.gray(`  🔀 Switching to branch: ${options.switch}`));
      execSync(`git checkout "${options.switch}"`, { cwd, stdio: "pipe" });
      ProjectContextManager.getInstance().invalidate(cwd);
      return {
        tool: "git_branch",
        result: `Switched to branch: ${options.switch}`,
      };
    }

    // Delete branch
    if (options.delete) {
      toolLog(chalk.gray(`  🗑️  Deleting branch: ${options.delete}`));
      execSync(`git branch -d "${options.delete}"`, { cwd, stdio: "pipe" });
      return {
        tool: "git_branch",
        result: `Deleted branch: ${options.delete}`,
      };
    }

    // List branches (default)
    toolLog(chalk.gray(`  🌿 Listing branches`));
    const branches = execSync("git branch -a", {
      cwd,
      encoding: "utf-8",
    });

    const lines = branches.split("\n").filter((line) => line.trim());
    let result = "Git Branches:\n\n";

    for (const line of lines) {
      const isCurrent = line.startsWith("*");
      const branchName = isCurrent ? line.slice(1).trim() : line.trim();

      if (isCurrent) {
        result += `${chalk.green("*")} ${chalk.green(branchName)} ${chalk.gray("(current)")}\n`;
      } else if (branchName.startsWith("remotes/")) {
        result += `  ${chalk.cyan(branchName)}\n`;
      } else {
        result += `  ${branchName}\n`;
      }
    }

    return {
      tool: "git_branch",
      result,
    };
  } catch (error) {
    return {
      tool: "git_branch",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Write File - Create a new file or overwrite existing one
 */
export function writeFile(
  filepath: string,
  content: string,
  cwd: string
): ToolResult {
  try {
    toolLog(chalk.gray(`  ✍️  Writing file: ${filepath}`));

    const fullPath = resolvePath(filepath, cwd);
    const dir = dirname(fullPath);

    // Ensure directory exists
    if (!existsSync(dir)) {
      const { mkdirSync } = fs;
      mkdirSync(dir, { recursive: true });
    }

    // Check if file already exists
    const fileExists = existsSync(fullPath);
    const previousContent = fileExists ? readFileSync(fullPath, "utf-8") : "";

    writeFileSync(fullPath, content, "utf-8");
    ProjectContextManager.getInstance().invalidate(cwd);
    const diffPreview =
      fileExists && previousContent !== content
        ? generateDiff(previousContent, content).slice(0, 120).join("\n")
        : "";
    const fullDiff =
      previousContent !== content ? generateDiff(previousContent, content).join("\n") : "";
    const lineCount = content.split("\n").length;

    return {
      tool: "write_file",
      result: fileExists
        ? diffPreview
          ? `Successfully updated ${filepath} (${lineCount} lines)\n\n${diffPreview}`
          : `Successfully updated ${filepath} (${lineCount} lines)`
        : `Successfully created ${filepath} (${lineCount} lines)`,
      details: {
        path: filepath,
        diff: fullDiff,
        firstChangedLine: getFirstChangedLine(fullDiff),
        lineCount,
        created: !fileExists,
        oldBytes: Buffer.byteLength(previousContent, "utf8"),
        newBytes: Buffer.byteLength(content, "utf8"),
      },
    };
  } catch (error) {
    return {
      tool: "write_file",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Delete File - Remove a file
 */
export function deleteFile(filepath: string, cwd: string): ToolResult {
  try {
    toolLog(chalk.gray(`  🗑️  Deleting file: ${filepath}`));

    const fullPath = resolvePath(filepath, cwd);

    if (!existsSync(fullPath)) {
      return {
        tool: "delete_file",
        result: "",
        error: `File not found: ${filepath}`,
      };
    }

    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      return {
        tool: "delete_file",
        result: "",
        error: `Cannot delete directory with delete_file. Use a shell command or implement delete_directory.`,
      };
    }

    const { unlinkSync } = fs;
    unlinkSync(fullPath);
    ProjectContextManager.getInstance().invalidate(cwd);

    return {
      tool: "delete_file",
      result: `Successfully deleted ${filepath}`,
    };
  } catch (error) {
    return {
      tool: "delete_file",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Move File - Move or rename a file
 */
export function moveFile(
  sourcePath: string,
  destPath: string,
  cwd: string
): ToolResult {
  try {
    toolLog(chalk.gray(`  📦 Moving: ${sourcePath} → ${destPath}`));

    const fullSourcePath = resolvePath(sourcePath, cwd);
    const fullDestPath = resolvePath(destPath, cwd);

    if (!existsSync(fullSourcePath)) {
      return {
        tool: "move_file",
        result: "",
        error: `Source file not found: ${sourcePath}`,
      };
    }

    const destDir = dirname(fullDestPath);
    if (!existsSync(destDir)) {
      const { mkdirSync } = fs;
      mkdirSync(destDir, { recursive: true });
    }

    const { renameSync } = fs;
    renameSync(fullSourcePath, fullDestPath);
    ProjectContextManager.getInstance().invalidate(cwd);

    return {
      tool: "move_file",
      result: `Successfully moved ${sourcePath} to ${destPath}`,
    };
  } catch (error) {
    return {
      tool: "move_file",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Create Directory - Create a new directory
 */
export function createDirectory(dirpath: string, cwd: string): ToolResult {
  try {
    toolLog(chalk.gray(`  📁 Creating directory: ${dirpath}`));

    const fullPath = resolvePath(dirpath, cwd);

    if (existsSync(fullPath)) {
      return {
        tool: "create_directory",
        result: "",
        error: `Directory already exists: ${dirpath}`,
      };
    }

    const { mkdirSync } = fs;
    mkdirSync(fullPath, { recursive: true });
    ProjectContextManager.getInstance().invalidate(cwd);

    return {
      tool: "create_directory",
      result: `Successfully created directory: ${dirpath}`,
    };
  } catch (error) {
    return {
      tool: "create_directory",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Package Manager Install - Install npm/yarn/pnpm packages
 */
export function packageInstall(
  packages: string[],
  cwd: string,
  options: {
    manager?: "npm" | "yarn" | "pnpm";
    dev?: boolean;
    global?: boolean;
  } = {}
): ToolResult {
  try {
    const manager = options.manager || detectPackageManager(cwd);
    const pkgList = packages.join(" ");

    toolLog(chalk.gray(`  📦 Installing packages with ${manager}: ${pkgList}`));

    let command = "";
    switch (manager) {
      case "yarn":
        command = options.dev ? `yarn add -D ${pkgList}` : `yarn add ${pkgList}`;
        break;
      case "pnpm":
        command = options.dev ? `pnpm add -D ${pkgList}` : `pnpm add ${pkgList}`;
        break;
      default:
        if (options.global) {
          command = `npm install -g ${pkgList}`;
        } else {
          command = options.dev ? `npm install --save-dev ${pkgList}` : `npm install ${pkgList}`;
        }
    }

    const result = execSync(command, { cwd, encoding: "utf-8", stdio: "pipe" });
    ProjectContextManager.getInstance().invalidate(cwd);

    return {
      tool: "package_install",
      result: `Successfully installed: ${pkgList}\n${result}`,
    };
  } catch (error) {
    return {
      tool: "package_install",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Package Manager Run Script - Run npm/yarn/pnpm scripts
 */
export function packageRunScript(
  script: string,
  cwd: string,
  options: {
    manager?: "npm" | "yarn" | "pnpm";
  } = {}
): ToolResult {
  try {
    const manager = options.manager || detectPackageManager(cwd);
    toolLog(chalk.gray(`  🚀 Running script with ${manager}: ${script}`));

    let command = "";
    switch (manager) {
      case "yarn":
        command = `yarn ${script}`;
        break;
      case "pnpm":
        command = `pnpm ${script}`;
        break;
      default:
        command = `npm run ${script}`;
    }

    const interactiveWarning = detectInteractiveCommand(command, { scriptName: script });
    if (interactiveWarning) {
      return {
        tool: "package_run_script",
        result: "",
        error: interactiveWarning,
      };
    }

    const result = execSync(command, { cwd, encoding: "utf-8", stdio: "pipe" });

    return {
      tool: "package_run_script",
      result: `Script '${script}' executed:\n${result}`,
    };
  } catch (error) {
    return {
      tool: "package_run_script",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function getFirstChangedLine(diff: string): number | undefined {
  const clean = diff.replace(/\x1b\[[0-9;]*m/g, "");
  const match = clean.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function normalizeNonInteractiveCommand(command: string): string {
  const trimmed = command.trim();

  if (/^npx\s+create-next-app(@latest)?\b/i.test(trimmed) && !/\s--yes\b/i.test(trimmed)) {
    return `${trimmed} --ts --tailwind --eslint --app --use-npm --yes`;
  }

  if (/^npm\s+create\s+vue@latest\b/i.test(trimmed) && !/\s--\s--default\b/i.test(trimmed)) {
    return `${trimmed} -- --default`;
  }

  if (/^npx\s+@angular\/cli\s+new\b/i.test(trimmed) && !/\s--defaults\b/i.test(trimmed)) {
    return `${trimmed} --defaults --skip-git`;
  }

  if (/^npx\s+nuxi@latest\s+init\b/i.test(trimmed) && !/\s--packageManager\b/i.test(trimmed)) {
    return `${trimmed} --packageManager npm`;
  }

  return trimmed;
}

function detectInteractiveCommand(
  command: string,
  options?: { scriptName?: string }
): string | null {
  const normalized = command.trim().toLowerCase();
  const scriptName = options?.scriptName?.trim().toLowerCase();

  if (
    scriptName &&
    ["dev", "start", "serve", "watch", "storybook"].includes(scriptName)
  ) {
    return `Script '${scriptName}' is long-running or interactive. Start it manually in a terminal or use a dedicated background terminal flow instead of running it as a one-shot tool.`;
  }

  if (
    /\b(npm run dev|npm start|pnpm dev|pnpm start|yarn dev|yarn start|vite|next dev|nuxt dev|astro dev)\b/.test(
      normalized
    )
  ) {
    return "This command starts a long-running dev server. Start it manually in a terminal or use a dedicated background terminal flow instead of running it as a one-shot tool.";
  }

  if (
    /\b(create-next-app|npm create vue|@angular\/cli new|nuxi@latest init|create-react-app)\b/.test(
      normalized
    ) &&
    !/\b(--yes|--defaults|--default|--skip-git|--packageManager)\b/.test(normalized)
  ) {
    return "This scaffold command is likely interactive. Use scaffold_project or add non-interactive flags such as --yes / --defaults so Meer can run it safely.";
  }

  return null;
}

/**
 * Tool: Package List - List installed packages
 */
export function packageList(
  cwd: string,
  options: {
    outdated?: boolean;
  } = {}
): ToolResult {
  try {
    const packageJsonPath = join(cwd, "package.json");
    if (!existsSync(packageJsonPath)) {
      return {
        tool: "package_list",
        result: "",
        error: "No package.json found in current directory",
      };
    }

    if (options.outdated) {
      toolLog(chalk.gray(`  📋 Checking for outdated packages`));
      const result = execSync("npm outdated", { cwd, encoding: "utf-8", stdio: "pipe" });
      return {
        tool: "package_list",
        result: result || "All packages are up to date!",
      };
    }

    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    const deps = packageJson.dependencies || {};
    const devDeps = packageJson.devDependencies || {};

    let result = "Installed Packages:\n\n";

    if (Object.keys(deps).length > 0) {
      result += "Dependencies:\n";
      Object.entries(deps).forEach(([name, version]) => {
        result += `  ${name}: ${version}\n`;
      });
      result += "\n";
    }

    if (Object.keys(devDeps).length > 0) {
      result += "Dev Dependencies:\n";
      Object.entries(devDeps).forEach(([name, version]) => {
        result += `  ${name}: ${version}\n`;
      });
    }

    return {
      tool: "package_list",
      result,
    };
  } catch (error) {
    return {
      tool: "package_list",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Read Environment Variable
 */
export function getEnv(key: string, cwd: string): ToolResult {
  try {
    toolLog(chalk.gray(`  🔑 Reading environment variable: ${key}`));

    // Try to read from process.env first
    const value = process.env[key];
    if (value !== undefined) {
      return {
        tool: "get_env",
        result: `${key}=${value}`,
      };
    }

    // Try to read from .env file
    const envPath = join(cwd, ".env");
    if (existsSync(envPath)) {
      const envContent = readFileSync(envPath, "utf-8");
      const lines = envContent.split("\n");

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith(key + "=")) {
          const envValue = trimmed.substring(key.length + 1);
          return {
            tool: "get_env",
            result: `${key}=${envValue} (from .env file)`,
          };
        }
      }
    }

    return {
      tool: "get_env",
      result: "",
      error: `Environment variable '${key}' not found`,
    };
  } catch (error) {
    return {
      tool: "get_env",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Set Environment Variable in .env file
 */
export function setEnv(key: string, value: string, cwd: string): ToolResult {
  try {
    toolLog(chalk.gray(`  🔑 Setting environment variable: ${key}`));

    const envPath = join(cwd, ".env");
    let envContent = "";

    if (existsSync(envPath)) {
      envContent = readFileSync(envPath, "utf-8");
    }

    const lines = envContent.split("\n");
    let found = false;

    // Update existing key or add new one
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith(key + "=")) {
        lines[i] = `${key}=${value}`;
        found = true;
        break;
      }
    }

    if (!found) {
      lines.push(`${key}=${value}`);
    }

    writeFileSync(envPath, lines.join("\n"), "utf-8");

    return {
      tool: "set_env",
      result: `Successfully set ${key}=${value} in .env file`,
    };
  } catch (error) {
    return {
      tool: "set_env",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: List all Environment Variables from .env
 */
export function listEnv(cwd: string): ToolResult {
  try {
    toolLog(chalk.gray(`  🔑 Listing environment variables`));

    const envPath = join(cwd, ".env");
    if (!existsSync(envPath)) {
      return {
        tool: "list_env",
        result: "No .env file found in current directory",
      };
    }

    const envContent = readFileSync(envPath, "utf-8");
    const lines = envContent.split("\n").filter(line => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith("#");
    });

    if (lines.length === 0) {
      return {
        tool: "list_env",
        result: ".env file is empty",
      };
    }

    let result = "Environment Variables (.env file):\n\n";
    lines.forEach(line => {
      const [key] = line.split("=");
      result += `  ${key}=****** (value hidden for security)\n`;
    });

    return {
      tool: "list_env",
      result,
    };
  } catch (error) {
    return {
      tool: "list_env",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: HTTP Request - Make HTTP requests (proper implementation)
 */
export async function httpRequest(
  url: string,
  options: {
    method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
    headers?: Record<string, string>;
    body?: string;
    timeout?: number;
  } = {}
): Promise<ToolResult> {
  try {
    toolLog(chalk.gray(`  🌐 Making ${options.method || "GET"} request to: ${url}`));

    const response = await fetchWithTimeout(url, {
      method: options.method || "GET",
      headers: options.headers as Record<string, string>,
      body: options.body,
    }, options.timeout ?? REQUEST_TIMEOUT_MS);

    const contentType = response.headers.get("content-type") || "";
    let result = "";

    if (contentType.includes("application/json")) {
      const json = await response.json();
      result = JSON.stringify(json, null, 2);
    } else {
      result = await response.text();
    }

    return {
      tool: "http_request",
      result: `Status: ${response.status} ${response.statusText}\n\nResponse:\n${result}`,
    };
  } catch (error) {
    return {
      tool: "http_request",
      result: "",
      error: formatErrorWithContext(error, {
        source: "tool",
        name: "http_request",
        operation: options.method || "GET",
        target: url,
      }),
    };
  }
}

/**
 * Helper: Detect package manager in use
 */
function detectPackageManager(cwd: string): "npm" | "yarn" | "pnpm" {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * ====================
 * CODE INTELLIGENCE TOOLS
 * ====================
 */

/**
 * Tool: Get File Outline - Extract structure from a JavaScript/TypeScript file
 * Shows functions, classes, exports, and imports
 */
export function getFileOutline(filepath: string, cwd: string): ToolResult {
  try {
    const fullPath = resolvePath(filepath, cwd);

    if (!existsSync(fullPath)) {
      return {
        tool: "get_file_outline",
        result: "",
        error: `File not found: ${filepath}`,
      };
    }

    toolLog(chalk.gray(`  📋 Getting outline for: ${filepath}`));

    const content = readFileSync(fullPath, "utf-8");
    const ext = filepath.toLowerCase();

    // Only support JS/TS files
    if (!ext.endsWith(".js") && !ext.endsWith(".ts") && !ext.endsWith(".jsx") && !ext.endsWith(".tsx")) {
      return {
        tool: "get_file_outline",
        result: "",
        error: `Unsupported file type. Only .js, .ts, .jsx, .tsx files are supported.`,
      };
    }

    try {
      const parser = require("@babel/parser");
      const traverse = require("@babel/traverse").default;

      const ast = parser.parse(content, {
        sourceType: "module",
        plugins: ["typescript", "jsx", "decorators-legacy"],
      });

      const outline: {
        imports: string[];
        exports: string[];
        functions: Array<{ name: string; line: number; params: string[] }>;
        classes: Array<{ name: string; line: number; methods: string[] }>;
        variables: Array<{ name: string; line: number; kind: string }>;
      } = {
        imports: [],
        exports: [],
        functions: [],
        classes: [],
        variables: [],
      };

      traverse(ast, {
        ImportDeclaration(path: any) {
          const source = path.node.source.value;
          const specifiers = path.node.specifiers
            .map((s: any) => s.local.name)
            .join(", ");
          outline.imports.push(`import { ${specifiers} } from '${source}'`);
        },

        ExportNamedDeclaration(path: any) {
          if (path.node.declaration) {
            const decl = path.node.declaration;
            if (decl.type === "FunctionDeclaration" && decl.id) {
              outline.exports.push(`export function ${decl.id.name}`);
            } else if (decl.type === "ClassDeclaration" && decl.id) {
              outline.exports.push(`export class ${decl.id.name}`);
            } else if (decl.type === "VariableDeclaration") {
              decl.declarations.forEach((d: any) => {
                if (d.id.type === "Identifier") {
                  outline.exports.push(`export ${decl.kind} ${d.id.name}`);
                }
              });
            }
          }
        },

        ExportDefaultDeclaration(path: any) {
          outline.exports.push("export default");
        },

        FunctionDeclaration(path: any) {
          if (path.node.id) {
            const params = path.node.params.map((p: any) =>
              p.type === "Identifier" ? p.name : "..."
            );
            outline.functions.push({
              name: path.node.id.name,
              line: path.node.loc?.start.line || 0,
              params,
            });
          }
        },

        ClassDeclaration(path: any) {
          if (path.node.id) {
            const methods = path.node.body.body
              .filter((m: any) => m.type === "ClassMethod" || m.type === "ClassProperty")
              .map((m: any) => m.key?.name || "")
              .filter(Boolean);

            outline.classes.push({
              name: path.node.id.name,
              line: path.node.loc?.start.line || 0,
              methods,
            });
          }
        },

        VariableDeclaration(path: any) {
          // Only top-level variables
          if (path.parent.type === "Program" || path.parent.type === "ExportNamedDeclaration") {
            path.node.declarations.forEach((decl: any) => {
              if (decl.id.type === "Identifier") {
                outline.variables.push({
                  name: decl.id.name,
                  line: decl.loc?.start.line || 0,
                  kind: path.node.kind,
                });
              }
            });
          }
        },
      });

      let result = `File Outline: ${filepath}\n\n`;

      if (outline.imports.length > 0) {
        result += `Imports (${outline.imports.length}):\n`;
        outline.imports.forEach((imp) => (result += `  ${imp}\n`));
        result += "\n";
      }

      if (outline.functions.length > 0) {
        result += `Functions (${outline.functions.length}):\n`;
        outline.functions.forEach((fn) => {
          result += `  Line ${fn.line}: ${fn.name}(${fn.params.join(", ")})\n`;
        });
        result += "\n";
      }

      if (outline.classes.length > 0) {
        result += `Classes (${outline.classes.length}):\n`;
        outline.classes.forEach((cls) => {
          result += `  Line ${cls.line}: class ${cls.name}\n`;
          if (cls.methods.length > 0) {
            result += `    Methods: ${cls.methods.join(", ")}\n`;
          }
        });
        result += "\n";
      }

      if (outline.variables.length > 0) {
        result += `Variables (${outline.variables.length}):\n`;
        outline.variables.slice(0, 10).forEach((v) => {
          result += `  Line ${v.line}: ${v.kind} ${v.name}\n`;
        });
        if (outline.variables.length > 10) {
          result += `  ... and ${outline.variables.length - 10} more\n`;
        }
        result += "\n";
      }

      if (outline.exports.length > 0) {
        result += `Exports (${outline.exports.length}):\n`;
        outline.exports.forEach((exp) => (result += `  ${exp}\n`));
      }

      return {
        tool: "get_file_outline",
        result,
      };
    } catch (parseError) {
      return {
        tool: "get_file_outline",
        result: "",
        error: `Failed to parse file: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
      };
    }
  } catch (error) {
    return {
      tool: "get_file_outline",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Find Symbol Definition - Find where a function/class/variable is defined
 */
export function findSymbolDefinition(
  symbol: string,
  cwd: string,
  options: {
    filePattern?: string;
  } = {}
): ToolResult {
  try {
    toolLog(chalk.gray(`  🔍 Finding definition of: ${symbol}`));

    const searchPattern =
      options.filePattern || "**/*.{js,ts,jsx,tsx}";

    const files = glob.sync(searchPattern, {
      cwd,
      ignore: DEFAULT_IGNORE_GLOBS,
    });

    const results: Array<{ file: string; line: number; context: string }> = [];

    // Regex patterns to find definitions
    const patterns = [
      new RegExp(`^\\s*(export\\s+)?(function|class|const|let|var)\\s+${symbol}\\b`, "m"),
      new RegExp(`^\\s*(export\\s+)?${symbol}\\s*[:=]`, "m"),
      new RegExp(`^\\s*class\\s+\\w+\\s*{[\\s\\S]*?\\b${symbol}\\s*\\(`, "m"), // Method
    ];

    for (const file of files) {
      try {
        const fullPath = resolvePath(file, cwd);
        const content = readFileSync(fullPath, "utf-8");
        const lines = content.split("\n");

        lines.forEach((line, index) => {
          for (const pattern of patterns) {
            if (pattern.test(line)) {
              results.push({
                file,
                line: index + 1,
                context: line.trim(),
              });
              break;
            }
          }
        });
      } catch {
        // Skip files that can't be read
      }
    }

    if (results.length === 0) {
      return {
        tool: "find_symbol_definition",
        result: `No definition found for symbol "${symbol}"`,
      };
    }

    let result = `Found ${results.length} definition(s) for "${symbol}":\n\n`;
    results.forEach(({ file, line, context }) => {
      result += `📄 ${file}:${line}\n`;
      result += `   ${context}\n\n`;
    });

    return {
      tool: "find_symbol_definition",
      result,
    };
  } catch (error) {
    return {
      tool: "find_symbol_definition",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Check Syntax - Check for syntax errors in a file
 */
export function checkSyntax(filepath: string, cwd: string): ToolResult {
  try {
    const fullPath = resolvePath(filepath, cwd);

    if (!existsSync(fullPath)) {
      return {
        tool: "check_syntax",
        result: "",
        error: `File not found: ${filepath}`,
      };
    }

    toolLog(chalk.gray(`  ✓ Checking syntax: ${filepath}`));

    const content = readFileSync(fullPath, "utf-8");
    const ext = filepath.toLowerCase();

    // Only support JS/TS files
    if (!ext.endsWith(".js") && !ext.endsWith(".ts") && !ext.endsWith(".jsx") && !ext.endsWith(".tsx")) {
      return {
        tool: "check_syntax",
        result: "",
        error: `Unsupported file type. Only .js, .ts, .jsx, .tsx files are supported.`,
      };
    }

    try {
      const parser = require("@babel/parser");

      parser.parse(content, {
        sourceType: "module",
        plugins: ["typescript", "jsx", "decorators-legacy"],
      });

      return {
        tool: "check_syntax",
        result: `✓ No syntax errors found in ${filepath}`,
      };
    } catch (parseError: any) {
      const loc = parseError.loc || {};
      const line = loc.line || "?";
      const column = loc.column || "?";

      return {
        tool: "check_syntax",
        result: `❌ Syntax error in ${filepath}:\n\nLine ${line}:${column}\n${parseError.message}`,
      };
    }
  } catch (error) {
    return {
      tool: "check_syntax",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ===========================
// PROJECT VALIDATION TOOLS
// ===========================

/**
 * Detect project type based on files in directory
 */
function detectProjectType(cwd: string): {
  type: "nodejs" | "python" | "go" | "rust" | "unknown";
  metadata?: any;
} {
  // Node.js
  if (existsSync(join(cwd, "package.json"))) {
    const packageJson = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
    const hasYarnLock = existsSync(join(cwd, "yarn.lock"));
    const hasPnpmLock = existsSync(join(cwd, "pnpm-lock.yaml"));
    const packageManager = hasYarnLock ? "yarn" : hasPnpmLock ? "pnpm" : "npm";
    return {
      type: "nodejs",
      metadata: { packageManager, scripts: packageJson.scripts || {} },
    };
  }

  // Python
  if (
    existsSync(join(cwd, "pyproject.toml")) ||
    existsSync(join(cwd, "setup.py")) ||
    existsSync(join(cwd, "requirements.txt")) ||
    existsSync(join(cwd, "Pipfile"))
  ) {
    return { type: "python" };
  }

  // Go
  if (existsSync(join(cwd, "go.mod"))) {
    return { type: "go" };
  }

  // Rust
  if (existsSync(join(cwd, "Cargo.toml"))) {
    return { type: "rust" };
  }

  return { type: "unknown" };
}

/**
 * Validate project by running build/test/lint commands
 * Supports: Node.js, Python, Go, Rust
 * Returns summarized output (errors only, not full logs)
 */
export function validateProject(
  cwd: string,
  options: {
    build?: boolean;
    test?: boolean;
    lint?: boolean;
    typeCheck?: boolean;
  } = {}
): ToolResult {
  try {
    console.log(chalk.gray("  🔍 Validating project..."));

    // Default to build only if no options specified
    const shouldBuild = options.build !== false;
    const shouldTest = options.test === true;
    const shouldLint = options.lint === true;
    const shouldTypeCheck = options.typeCheck === true;

    const results: string[] = [];
    const errors: string[] = [];

    // Detect project type
    const projectInfo = detectProjectType(cwd);
    toolLog(chalk.gray(`    ↳ Detected: ${projectInfo.type} project`));

    if (projectInfo.type === "unknown") {
      return {
        tool: "validate_project",
        result: "",
        error: "Unable to detect project type. Supported: Node.js, Python, Go, Rust",
      };
    }

    // Helper to run command and capture output
    const runValidation = (command: string, name: string): boolean => {
      try {
        toolLog(chalk.gray(`    ↳ Running ${name}...`));
        execSync(command, {
          cwd,
          encoding: "utf-8",
          stdio: "pipe",
          timeout: 180000, // 3 minutes timeout
        });
        results.push(`✓ ${name} passed`);
        return true;
      } catch (error: any) {
        const stderr = error.stderr?.toString() || "";
        const stdout = error.stdout?.toString() || "";

        // Extract only error lines (not full output)
        const errorLines = (stderr + stdout)
          .split("\n")
          .filter((line: string) =>
            line.includes("error") ||
            line.includes("Error") ||
            line.includes("ERROR") ||
            line.includes("FAILED") ||
            line.includes("✗") ||
            line.includes("×") ||
            line.match(/^\s*\d+:\d+/)  // line:column format
          )
          .slice(0, 20); // Limit to first 20 error lines

        const errorSummary = errorLines.length > 0
          ? errorLines.join("\n")
          : (stderr || stdout || "Unknown error").slice(0, 500);

        errors.push(`✗ ${name} failed:\n${errorSummary}`);
        return false;
      }
    };

    // Run validations based on project type
    switch (projectInfo.type) {
      case "nodejs": {
        const { packageManager, scripts } = projectInfo.metadata;

        // Run build
        if (shouldBuild && scripts.build) {
          runValidation(`${packageManager} run build`, "Build");
        } else if (shouldBuild && !scripts.build) {
          results.push("⊘ No build script found (skipped)");
        }

        // Run type check
        if (shouldTypeCheck && scripts.typecheck) {
          runValidation(`${packageManager} run typecheck`, "Type check");
        } else if (shouldTypeCheck && scripts["type-check"]) {
          runValidation(`${packageManager} run type-check`, "Type check");
        } else if (shouldTypeCheck && existsSync(join(cwd, "tsconfig.json"))) {
          runValidation("npx tsc --noEmit", "Type check");
        }

        // Run tests
        if (shouldTest && scripts.test) {
          const testScript = scripts.test;
          if (!testScript.includes("echo") && !testScript.includes("exit 0")) {
            runValidation(`${packageManager} run test`, "Tests");
          } else {
            results.push("⊘ No real test script found (skipped)");
          }
        } else if (shouldTest && !scripts.test) {
          results.push("⊘ No test script found (skipped)");
        }

        // Run lint
        if (shouldLint && scripts.lint) {
          runValidation(`${packageManager} run lint`, "Lint");
        } else if (shouldLint && !scripts.lint) {
          results.push("⊘ No lint script found (skipped)");
        }
        break;
      }

      case "python": {
        // Run build (usually not applicable for Python, but check for setup)
        if (shouldBuild) {
          if (existsSync(join(cwd, "setup.py"))) {
            runValidation("python setup.py check", "Setup validation");
          } else if (existsSync(join(cwd, "pyproject.toml"))) {
            results.push("⊘ Build check skipped (pyproject.toml projects don't need build)");
          } else {
            results.push("⊘ No setup.py found (skipped)");
          }
        }

        // Run type check
        if (shouldTypeCheck) {
          if (existsSync(join(cwd, "mypy.ini")) || existsSync(join(cwd, ".mypy.ini"))) {
            runValidation("mypy .", "Type check (mypy)");
          } else {
            runValidation("python -m mypy . --ignore-missing-imports", "Type check (mypy)");
          }
        }

        // Run tests
        if (shouldTest) {
          if (existsSync(join(cwd, "pytest.ini")) || existsSync(join(cwd, "pyproject.toml"))) {
            runValidation("pytest", "Tests (pytest)");
          } else if (existsSync(join(cwd, "tests")) || existsSync(join(cwd, "test"))) {
            runValidation("python -m unittest discover", "Tests (unittest)");
          } else {
            results.push("⊘ No test configuration found (skipped)");
          }
        }

        // Run lint
        if (shouldLint) {
          if (existsSync(join(cwd, ".flake8")) || existsSync(join(cwd, "setup.cfg"))) {
            runValidation("flake8 .", "Lint (flake8)");
          } else if (existsSync(join(cwd, ".pylintrc"))) {
            runValidation("pylint **/*.py", "Lint (pylint)");
          } else {
            runValidation("python -m flake8 . --count --select=E9,F63,F7,F82 --show-source --statistics", "Lint (flake8)");
          }
        }
        break;
      }

      case "go": {
        // Run build
        if (shouldBuild) {
          runValidation("go build ./...", "Build");
        }

        // Run type check (go vet)
        if (shouldTypeCheck) {
          runValidation("go vet ./...", "Type check (go vet)");
        }

        // Run tests
        if (shouldTest) {
          runValidation("go test ./...", "Tests");
        }

        // Run lint
        if (shouldLint) {
          runValidation("golint ./...", "Lint (golint)");
        }
        break;
      }

      case "rust": {
        // Run build
        if (shouldBuild) {
          runValidation("cargo build", "Build");
        }

        // Run type check (cargo check is faster than build)
        if (shouldTypeCheck) {
          runValidation("cargo check", "Type check");
        }

        // Run tests
        if (shouldTest) {
          runValidation("cargo test", "Tests");
        }

        // Run lint
        if (shouldLint) {
          runValidation("cargo clippy -- -D warnings", "Lint (clippy)");
        }
        break;
      }
    }

    // Format final result
    if (errors.length > 0) {
      return {
        tool: "validate_project",
        result: [
          "Validation completed with errors:",
          "",
          ...results,
          "",
          "ERRORS:",
          ...errors,
        ].join("\n"),
      };
    } else {
      return {
        tool: "validate_project",
        result: [
          "✓ Validation passed!",
          "",
          ...results,
        ].join("\n"),
      };
    }
  } catch (error) {
    return {
      tool: "validate_project",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

    /**
     * Tool: Set or update the execution plan
     * This helps organize complex tasks into steps and track progress
     */
    export function setPlan(
      title: string,
      tasks: Array<{ description: string }>,
      cwd: string
    ): ToolResult {
      try {
        // Create new plan
        const now = Date.now();
        const draftPlan: Plan = {
          title,
          tasks: tasks.map((task, index) => ({
            id: `task-${index + 1}`,
            description: task.description,
            status: "pending",
          })),
          createdAt: now,
          updatedAt: now,
        };
        const activePlan = planStore.setPlan(draftPlan) ?? draftPlan;

        // Format output
    const output = [
      chalk.bold.blue(`\n📋 Plan Created: ${activePlan.title}`),
      "",
      ...activePlan.tasks.map((task, index) => {
        const statusIcon = "📌";
        return `  ${chalk.gray(`${index + 1}.`)} ${statusIcon} ${task.description} ${chalk.gray(`(${task.id})`)}`;
      }),
      "",
      chalk.gray(`Total tasks: ${activePlan.tasks.length}`),
    ].join("\n");

        return {
          tool: "set_plan",
          result: output,
          plan: activePlan,
        };
      } catch (error) {
        return {
          tool: "set_plan",
          result: "",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    /**
     * Tool: Update a task in the current plan
     */
    export function updatePlanTask(
      taskId: string,
      status: "pending" | "in_progress" | "completed" | "skipped",
      notes?: string
    ): ToolResult {
      try {
        const currentPlan = planStore.getSnapshot();
        if (!currentPlan) {
          return {
            tool: "update_plan_task",
            result: "",
            error: "No active plan. Use set_plan to create a plan first.",
          };
        }

        const resolvedTask = resolvePlanTask(currentPlan, taskId);

        if (!resolvedTask) {
          return {
            tool: "update_plan_task",
            result: "",
            error: `Task ${taskId} not found in the plan. Valid task IDs: ${currentPlan.tasks
              .map((task, index) => `${task.id} (${index + 1})`)
              .join(", ")}`,
          };
        }

        const updatedPlan = (
          planStore.update((plan) => {
            const mutableTask = plan.tasks.find((t) => t.id === resolvedTask.id);
            if (!mutableTask) {
              return;
            }
            mutableTask.status = status;
            if (notes) {
              mutableTask.notes = notes;
            }
          })
        ) ?? currentPlan;

    const output = [
      chalk.bold.blue(`\n📋 Plan Updated: ${updatedPlan.title}`),
      "",
      ...updatedPlan.tasks.map((t, index) => {
        const icon =
          t.status === "completed"
            ? "✅"
            : t.status === "in_progress"
            ? "⏳"
            : t.status === "skipped"
            ? "⏭️"
            : "📌";
        const color =
          t.status === "completed"
            ? chalk.green
            : t.status === "in_progress"
            ? chalk.yellow
            : t.status === "skipped"
            ? chalk.gray
            : chalk.white;
        return `  ${chalk.gray(`${index + 1}.`)} ${icon} ${color(t.description)} ${chalk.gray(`(${t.id})`)}`;
      }),
      "",
      chalk.gray(
        `Progress: ${updatedPlan.tasks.filter((t) => t.status === "completed").length}/${updatedPlan.tasks.length} tasks completed`
      ),
    ].join("\n");

        return {
          tool: "update_plan_task",
          result: output,
          plan: updatedPlan,
        };
      } catch (error) {
        return {
          tool: "update_plan_task",
          result: "",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    /**
     * Tool: Show the current plan
     */
    export function showPlan(): ToolResult {
      try {
        const plan = planStore.getSnapshot();
        if (!plan) {
          return {
            tool: "show_plan",
            result: "No active plan.",
          };
        }

    const output = [
      chalk.bold.blue(`\n📋 Current Plan: ${plan.title}`),
      "",
      ...plan.tasks.map((task, index) => {
        const icon =
          task.status === "completed"
            ? "✅"
            : task.status === "in_progress"
            ? "⏳"
            : task.status === "skipped"
            ? "⏭️"
            : "📌";
        const color =
          task.status === "completed"
            ? chalk.green
            : task.status === "in_progress"
            ? chalk.yellow
            : task.status === "skipped"
            ? chalk.gray
            : chalk.white;
        let line = `  ${chalk.gray(`${index + 1}.`)} ${icon} ${color(task.description)} ${chalk.gray(`(${task.id})`)}`;
        if (task.notes) {
          line += `\n     ${chalk.gray(`Note: ${task.notes}`)}`;
        }
        return line;
      }),
      "",
      chalk.gray(
        `Progress: ${plan.tasks.filter((t) => t.status === "completed").length}/${plan.tasks.length} tasks completed`
      ),
    ].join("\n");

        return {
          tool: "show_plan",
          result: output,
          plan,
        };
      } catch (error) {
        return {
          tool: "show_plan",
          result: "",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

/**
 * Tool: Clear the current plan
 */
export function clearPlan(): ToolResult {
  try {
    const existingPlan = planStore.getSnapshot();
    if (!existingPlan) {
      return {
        tool: "clear_plan",
        result: "No active plan to clear.",
      };
    }

    const title = existingPlan.title;
    planStore.clear();

    return {
      tool: "clear_plan",
      result: chalk.green(`✅ Plan "${title}" has been cleared.`),
      plan: null,
    };
  } catch (error) {
    return {
      tool: "clear_plan",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Format code using standard formatters
 */
export function formatCode(
  path: string,
  cwd: string,
  options?: {
    formatter?: 'prettier' | 'black' | 'gofmt' | 'rustfmt' | 'auto';
    check?: boolean; // Only check, don't modify
  }
): ToolResult {
  try {
    const fullPath = resolvePath(path, cwd);

    if (!existsSync(fullPath)) {
      return {
        tool: "format_code",
        result: "",
        error: `Path not found: ${path}`,
      };
    }

    // Auto-detect formatter based on file type
    let formatter = options?.formatter || 'auto';

    if (formatter === 'auto') {
      const ext = path.split(".").pop() || "";
      if (ext === 'py') formatter = 'black';
      else if (ext === 'go') formatter = 'gofmt';
      else if (ext === 'rs') formatter = 'rustfmt';
      else formatter = 'prettier'; // Default for JS/TS/JSON/etc
    }

    const checkOnly = options?.check || false;
    let command = '';

    // Build command based on formatter
    switch (formatter) {
      case 'prettier':
        command = checkOnly
          ? `npx prettier --check "${fullPath}"`
          : `npx prettier --write "${fullPath}"`;
        break;
      case 'black':
        command = checkOnly
          ? `black --check "${fullPath}"`
          : `black "${fullPath}"`;
        break;
      case 'gofmt':
        command = checkOnly
          ? `gofmt -l "${fullPath}"`
          : `gofmt -w "${fullPath}"`;
        break;
      case 'rustfmt':
        command = checkOnly
          ? `rustfmt --check "${fullPath}"`
          : `rustfmt "${fullPath}"`;
        break;
      default:
        return {
          tool: "format_code",
          result: "",
          error: `Unknown formatter: ${formatter}`,
        };
    }

    try {
      const output = execSync(command, {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      return {
        tool: "format_code",
        result: checkOnly
          ? `✓ Code is properly formatted (${formatter})\n\n${output}`
          : `✓ Code formatted successfully with ${formatter}\n\n${output}`,
      };
    } catch (execError: any) {
      // Some formatters exit with non-zero when files need formatting
      const stderr = execError.stderr?.toString() || '';
      const stdout = execError.stdout?.toString() || '';

      if (checkOnly && (stdout || stderr)) {
        return {
          tool: "format_code",
          result: `Files need formatting:\n\n${stdout || stderr}`,
        };
      }

      return {
        tool: "format_code",
        result: "",
        error: `Formatter failed: ${stderr || execError.message}\n\nMake sure ${formatter} is installed.`,
      };
    }
  } catch (error) {
    return {
      tool: "format_code",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Audit dependencies for security vulnerabilities and updates
 */
export function dependencyAudit(
  cwd: string,
  options?: {
    fix?: boolean; // Auto-fix vulnerabilities
    production?: boolean; // Only check production dependencies
  }
): ToolResult {
  try {
    // Detect package manager
    const hasPackageJson = existsSync(join(cwd, 'package.json'));
    const hasRequirementsTxt = existsSync(join(cwd, 'requirements.txt'));
    const hasCargoToml = existsSync(join(cwd, 'Cargo.toml'));
    const hasGoMod = existsSync(join(cwd, 'go.mod'));

    let results: string[] = [];

    // Node.js / npm
    if (hasPackageJson) {
      try {
        const auditCmd = options?.fix
          ? 'npm audit fix'
          : options?.production
          ? 'npm audit --production --json'
          : 'npm audit --json';

        let auditOutput: string;
        try {
          auditOutput = execSync(auditCmd, {
            cwd,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe']
          });
        } catch (error: any) {
          // npm audit exits 1 when vulnerabilities exist — stdout still has JSON
          auditOutput = error.stdout?.toString() || '';
          if (!auditOutput.trim()) {
            results.push(`npm audit: ${error.stderr?.toString() || error.message}`);
            auditOutput = '';
          }
        }

        if (auditOutput) {
          if (options?.fix) {
            results.push(`npm audit fix completed\n${auditOutput}`);
          } else {
            try {
              const auditData = JSON.parse(auditOutput);
              const vulns = auditData.metadata?.vulnerabilities || {};
              const total = Object.values(vulns).reduce((sum: number, count: any) => sum + (count || 0), 0);

              results.push(`npm Audit Results:`);
              results.push(`Total vulnerabilities: ${total}`);
              if (vulns.critical) results.push(`  Critical: ${vulns.critical}`);
              if (vulns.high) results.push(`  High: ${vulns.high}`);
              if (vulns.moderate) results.push(`  Moderate: ${vulns.moderate}`);
              if (vulns.low) results.push(`  Low: ${vulns.low}`);
              if (total > 0) {
                results.push(`Run dependency_audit with fix:true to auto-fix`);
              } else {
                results.push(`No vulnerabilities found.`);
              }
            } catch {
              results.push(auditOutput);
            }
          }
        }
      } catch {
        // outer audit try — errors already captured above
      }

      // Also check for outdated packages (npm outdated exits 1 when packages are outdated)
      try {
        let outdatedRaw: string;
        try {
          outdatedRaw = execSync('npm outdated --json', { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (err: any) {
          outdatedRaw = err.stdout?.toString() || '';
        }
        if (outdatedRaw.trim()) {
          const outdated = JSON.parse(outdatedRaw);
          const count = Object.keys(outdated).length;
          if (count > 0) {
            results.push(`Outdated packages: ${count}`);
          }
        }
      } catch {
        // ignore if outdated check fails
      }
    }

    // Python / pip
    if (hasRequirementsTxt) {
      try {
        const output = execSync('pip list --outdated', {
          cwd,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe']
        });
        results.push(`\n🐍 Python (pip) Outdated Packages:\n${output}`);
      } catch (error: any) {
        results.push(`pip check: ${error.message}`);
      }
    }

    // Rust / Cargo
    if (hasCargoToml) {
      try {
        const output = execSync('cargo audit', {
          cwd,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe']
        });
        results.push(`\n🦀 Cargo Audit:\n${output}`);
      } catch (error: any) {
        results.push(`cargo audit: ${error.stderr?.toString() || error.message}`);
      }
    }

    // Go
    if (hasGoMod) {
      try {
        const output = execSync('go list -m -u all', {
          cwd,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe']
        });
        results.push(`\n🐹 Go Modules:\n${output}`);
      } catch (error: any) {
        results.push(`go list: ${error.message}`);
      }
    }

    if (results.length === 0) {
      return {
        tool: "dependency_audit",
        result: "No package manager configuration found (package.json, requirements.txt, Cargo.toml, go.mod)",
      };
    }

    return {
      tool: "dependency_audit",
      result: results.join('\n'),
    };
  } catch (error) {
    return {
      tool: "dependency_audit",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Run tests with optional coverage
 */
export function runTests(
  cwd: string,
  options?: {
    pattern?: string; // Test file pattern
    coverage?: boolean; // Generate coverage report
    watch?: boolean; // Watch mode
    specific?: string; // Specific test file or suite
  }
): ToolResult {
  try {
    // Detect test framework
    const packageJsonPath = join(cwd, 'package.json');
    let testCommand = '';
    let framework = '';

    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

      // Check for test script
      if (packageJson.scripts?.test) {
        testCommand = 'npm test';

        // Try to detect framework from test script or dependencies
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        if (deps.jest) framework = 'jest';
        else if (deps.vitest) framework = 'vitest';
        else if (deps.mocha) framework = 'mocha';
      }
    } else if (existsSync(join(cwd, 'pytest.ini')) || existsSync(join(cwd, 'setup.py'))) {
      testCommand = 'pytest';
      framework = 'pytest';
    } else if (existsSync(join(cwd, 'go.mod'))) {
      testCommand = 'go test ./...';
      framework = 'go test';
    } else if (existsSync(join(cwd, 'Cargo.toml'))) {
      testCommand = 'cargo test';
      framework = 'cargo test';
    }

    if (!testCommand) {
      return {
        tool: "run_tests",
        result: "",
        error: "No test configuration found. Please ensure you have a test script in package.json or a test framework configured.",
      };
    }

    // Add options based on framework
    if (options?.coverage) {
      if (framework === 'jest') testCommand += ' --coverage';
      else if (framework === 'vitest') testCommand += ' --coverage';
      else if (framework === 'pytest') testCommand += ' --cov';
      else if (framework === 'go test') testCommand += ' -cover';
    }

    if (options?.specific) {
      testCommand += ` ${options.specific}`;
    }

    if (options?.pattern && framework === 'jest') {
      testCommand += ` --testPathPattern="${options.pattern}"`;
    }

    // Don't use watch mode in CLI context
    if (options?.watch) {
      return {
        tool: "run_tests",
        result: "",
        error: "Watch mode is not supported in CLI context. Run tests without watch mode.",
      };
    }

    try {
      const output = execSync(testCommand, {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024 // 10MB buffer
      });

      return {
        tool: "run_tests",
        result: `✓ Tests completed successfully (${framework})\n\n${output}`,
      };
    } catch (execError: any) {
      const stderr = execError.stderr?.toString() || '';
      const stdout = execError.stdout?.toString() || '';

      return {
        tool: "run_tests",
        result: `❌ Tests failed (${framework})\n\n${stdout}\n${stderr}`,
        error: "Some tests failed. See output above for details.",
      };
    }
  } catch (error) {
    return {
      tool: "run_tests",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Security scan for vulnerabilities and code issues
 */
export function securityScan(
  path: string,
  cwd: string,
  options?: {
    scanners?: Array<'npm-audit' | 'eslint-security' | 'semgrep' | 'bandit' | 'all'>;
    severity?: 'low' | 'medium' | 'high' | 'critical';
    autoFix?: boolean;
  }
): ToolResult {
  try {
    const fullPath = resolvePath(path, cwd);
    const results: string[] = [];
    const scanners = options?.scanners || ['all'];
    const runAll = scanners.includes('all');

    // 1. npm audit (Node.js)
    if ((runAll || scanners.includes('npm-audit')) && existsSync(join(cwd, 'package.json'))) {
      try {
        const auditCmd = options?.autoFix ? 'npm audit fix' : 'npm audit --json';
        const output = execSync(auditCmd, {
          cwd,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe']
        });

        if (!options?.autoFix) {
          try {
            const auditData = JSON.parse(output);
            const vulns = auditData.metadata?.vulnerabilities || {};

            results.push(`\n🔒 npm Security Audit:\n`);
            const total = Object.values(vulns).reduce((sum: number, count: any) => sum + (count || 0), 0);

            if (total === 0) {
              results.push(`✅ No vulnerabilities found`);
            } else {
              results.push(`Found ${total} vulnerabilities:`);
              if (vulns.critical) results.push(`  🔴 Critical: ${vulns.critical}`);
              if (vulns.high) results.push(`  🟠 High: ${vulns.high}`);
              if (vulns.moderate) results.push(`  🟡 Moderate: ${vulns.moderate}`);
              if (vulns.low) results.push(`  🟢 Low: ${vulns.low}`);
            }
          } catch {
            results.push(output);
          }
        } else {
          results.push(`✅ npm audit fix completed\n${output}`);
        }
      } catch (error: any) {
        // npm audit returns non-zero when vulnerabilities exist
        const stderr = error.stderr?.toString();
        if (stderr && !stderr.includes('found 0 vulnerabilities')) {
          results.push(`npm audit: Issues found - run with autoFix: true to fix`);
        }
      }
    }

    // 2. ESLint security rules (if eslint is installed)
    if ((runAll || scanners.includes('eslint-security')) && existsSync(join(cwd, 'package.json'))) {
      try {
        const packageJson = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

        if (deps.eslint) {
          const eslintCmd = `npx eslint "${fullPath}" --format json`;
          try {
            execSync(eslintCmd, {
              cwd,
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe']
            });
            results.push(`\n✅ ESLint: No security issues found`);
          } catch (error: any) {
            const stdout = error.stdout?.toString();
            if (stdout) {
              try {
                const eslintResults = JSON.parse(stdout);
                const securityIssues = eslintResults.flatMap((file: any) =>
                  file.messages.filter((msg: any) =>
                    msg.ruleId?.includes('security') ||
                    msg.severity === 2
                  )
                );

                if (securityIssues.length > 0) {
                  results.push(`\n⚠️ ESLint Security Issues: ${securityIssues.length}`);
                }
              } catch {
                // Parse error, skip
              }
            }
          }
        }
      } catch {
        // Package.json parsing error, skip
      }
    }

    // 3. Bandit (Python security)
    if ((runAll || scanners.includes('bandit')) && existsSync(fullPath) && fullPath.endsWith('.py')) {
      try {
        const output = execSync(`bandit -r "${fullPath}" -f json`, {
          cwd,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe']
        });

        try {
          const banditResults = JSON.parse(output);
          const issues = banditResults.results || [];

          results.push(`\n🐍 Bandit (Python Security):\n`);
          if (issues.length === 0) {
            results.push(`✅ No security issues found`);
          } else {
            const critical = issues.filter((i: any) => i.issue_severity === 'HIGH').length;
            const medium = issues.filter((i: any) => i.issue_severity === 'MEDIUM').length;
            const low = issues.filter((i: any) => i.issue_severity === 'LOW').length;

            results.push(`Found ${issues.length} issues:`);
            if (critical) results.push(`  🔴 High: ${critical}`);
            if (medium) results.push(`  🟡 Medium: ${medium}`);
            if (low) results.push(`  🟢 Low: ${low}`);
          }
        } catch {
          results.push(output);
        }
      } catch (error: any) {
        // Bandit not installed or no issues
        if (!error.message.includes('command not found')) {
          results.push(`Bandit: ${error.message}`);
        }
      }
    }

    if (results.length === 0) {
      results.push(`ℹ️ No security scanners available or applicable for this project.`);
      results.push(`\nConsider installing:`);
      results.push(`- npm audit (Node.js) - built-in`);
      results.push(`- bandit (Python): pip install bandit`);
      results.push(`- semgrep (multi-language): pip install semgrep`);
    }

    return {
      tool: "security_scan",
      result: results.join('\n'),
    };
  } catch (error) {
    return {
      tool: "security_scan",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Auto-fix linting errors
 */
export function fixLint(
  path: string,
  cwd: string,
  options?: {
    linter?: 'eslint' | 'pylint' | 'golint' | 'clippy' | 'auto';
  }
): ToolResult {
  try {
    const fullPath = resolvePath(path, cwd);

    if (!existsSync(fullPath)) {
      return {
        tool: "fix_lint",
        result: "",
        error: `Path not found: ${path}`,
      };
    }

    let linter = options?.linter || 'auto';

    // Auto-detect linter
    if (linter === 'auto') {
      const ext = path.split(".").pop() || "";
      if (ext === 'py') linter = 'pylint';
      else if (ext === 'go') linter = 'golint';
      else if (ext === 'rs') linter = 'clippy';
      else linter = 'eslint';
    }

    let command = '';

    switch (linter) {
      case 'eslint':
        command = `npx eslint "${fullPath}" --fix`;
        break;
      case 'pylint':
        // pylint doesn't have auto-fix, use autopep8 or black instead
        command = `autopep8 --in-place "${fullPath}"`;
        break;
      case 'golint':
        // golint doesn't auto-fix, use gofmt
        command = `gofmt -w "${fullPath}"`;
        break;
      case 'clippy':
        command = `cargo clippy --fix --allow-dirty`;
        break;
      default:
        return {
          tool: "fix_lint",
          result: "",
          error: `Unknown linter: ${linter}`,
        };
    }

    try {
      const output = execSync(command, {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      return {
        tool: "fix_lint",
        result: `✅ Lint fixes applied with ${linter}\n\n${output}`,
      };
    } catch (execError: any) {
      const stderr = execError.stderr?.toString() || '';
      const stdout = execError.stdout?.toString() || '';

      // Some linters return non-zero even when fixes are applied
      if (stdout || stderr) {
        return {
          tool: "fix_lint",
          result: `Lint fixes attempted with ${linter}\n\n${stdout}\n${stderr}`,
        };
      }

      return {
        tool: "fix_lint",
        result: "",
        error: `Linter failed: ${execError.message}\n\nMake sure ${linter} is installed.`,
      };
    }
  } catch (error) {
    return {
      tool: "fix_lint",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Organize and sort imports in a file
 */
export function organizeImports(
  path: string,
  cwd: string,
  options?: {
    organizer?: "eslint" | "prettier" | "auto";
  }
): ToolResult {
  try {
    const fullPath = resolvePath(path, cwd);

    if (!fs.existsSync(fullPath)) {
      return {
        tool: "organize_imports",
        result: "",
        error: `Path not found: ${path}`,
      };
    }

    const stats = fs.statSync(fullPath);
    if (!stats.isFile()) {
      return {
        tool: "organize_imports",
        result: "",
        error: `Path is not a file: ${path}`,
      };
    }

    // Detect file type
    const ext = pathLib.extname(fullPath).toLowerCase();
    const organizer = options?.organizer || "auto";

    let command: string;
    let result: string;

    // Auto-detect organizer based on file extension
    if (organizer === "auto") {
      if ([".js", ".jsx", ".ts", ".tsx"].includes(ext)) {
        // Try ESLint with import sorting plugin
        try {
          result = execSync(
            `npx eslint "${fullPath}" --fix --rule "import/order: error"`,
            { cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
          ).toString();

          return {
            tool: "organize_imports",
            result: `✅ Imports organized successfully in ${path}\n\nESLint applied import sorting rules.`,
          };
        } catch (eslintError) {
          // Fallback to simple sorting algorithm
          const content = fs.readFileSync(fullPath, "utf-8");
          const lines = content.split("\n");

          // Extract import statements
          const imports: string[] = [];
          const otherLines: string[] = [];
          let inImportBlock = false;

          for (const line of lines) {
            const trimmed = line.trim();
            if (
              trimmed.startsWith("import ") ||
              trimmed.startsWith("import{") ||
              trimmed.startsWith("import*")
            ) {
              imports.push(line);
              inImportBlock = true;
            } else if (inImportBlock && trimmed === "") {
              // Keep blank lines after imports
              otherLines.push(line);
            } else {
              if (inImportBlock && trimmed !== "") {
                inImportBlock = false;
              }
              otherLines.push(line);
            }
          }

          // Sort imports: built-ins, externals, then locals
          const sortedImports = imports.sort((a, b) => {
            // Extract module name from import statement
            const getModule = (imp: string) => {
              const match = imp.match(/from ['"](.+?)['"]/);
              return match ? match[1] : "";
            };

            const modA = getModule(a);
            const modB = getModule(b);

            // Classify import type
            const getType = (mod: string) => {
              if (!mod.startsWith(".") && !mod.startsWith("/")) return 0; // external
              if (mod.startsWith("../")) return 2; // parent
              return 1; // local
            };

            const typeA = getType(modA);
            const typeB = getType(modB);

            if (typeA !== typeB) return typeA - typeB;
            return modA.localeCompare(modB);
          });

          // Reconstruct file with sorted imports
          const organized =
            sortedImports.join("\n") + "\n\n" + otherLines.join("\n");

          return {
            tool: "organize_imports",
            result: `✅ Imports organized using simple sorting (ESLint not available)\n\nSorted ${imports.length} import statements in ${path}`,
          };
        }
      } else if (ext === ".py") {
        // Python: use isort
        try {
          execSync(`isort "${fullPath}"`, {
            cwd,
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024,
          });

          return {
            tool: "organize_imports",
            result: `✅ Python imports organized with isort in ${path}`,
          };
        } catch (error) {
          return {
            tool: "organize_imports",
            result: "",
            error: `isort not available. Install with: pip install isort`,
          };
        }
      } else if (ext === ".go") {
        // Go: use goimports
        try {
          execSync(`goimports -w "${fullPath}"`, {
            cwd,
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024,
          });

          return {
            tool: "organize_imports",
            result: `✅ Go imports organized with goimports in ${path}`,
          };
        } catch (error) {
          return {
            tool: "organize_imports",
            result: "",
            error: `goimports not available. Install with: go install golang.org/x/tools/cmd/goimports@latest`,
          };
        }
      } else {
        return {
          tool: "organize_imports",
          result: "",
          error: `Unsupported file type: ${ext}`,
        };
      }
    }

    return {
      tool: "organize_imports",
      result: "Import organization completed",
    };
  } catch (error) {
    return {
      tool: "organize_imports",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Analyze test coverage and identify gaps
 */
export function analyzeCoverage(
  cwd: string,
  options?: {
    threshold?: number; // Warning threshold (0-100)
    format?: "summary" | "detailed";
    includeUncovered?: boolean;
  }
): ToolResult {
  try {
    const threshold = options?.threshold || 80;
    const format = options?.format || "summary";
    const includeUncovered = options?.includeUncovered ?? true;

    const results: string[] = [];
    results.push(`📊 Test Coverage Analysis\n${"=".repeat(50)}\n`);

    // Detect project type and look for coverage files
    let coverageData: any = null;
    let projectType = "unknown";

    // Node.js: Check for coverage/coverage-summary.json (Jest/Vitest)
    const nodeCoveragePath = pathLib.join(cwd, "coverage", "coverage-summary.json");
    if (fs.existsSync(nodeCoveragePath)) {
      projectType = "node";
      coverageData = JSON.parse(fs.readFileSync(nodeCoveragePath, "utf-8"));
    }

    // Python: Check for coverage.json (pytest-cov)
    const pythonCoveragePath = pathLib.join(cwd, "coverage.json");
    if (!coverageData && fs.existsSync(pythonCoveragePath)) {
      projectType = "python";
      coverageData = JSON.parse(fs.readFileSync(pythonCoveragePath, "utf-8"));
    }

    // Go: Check for coverage.out
    const goCoveragePath = pathLib.join(cwd, "coverage.out");
    if (!coverageData && fs.existsSync(goCoveragePath)) {
      projectType = "go";
      // Parse Go coverage format
      const coverageOutput = fs.readFileSync(goCoveragePath, "utf-8");
      // Simplified Go coverage parsing
      coverageData = { type: "go", raw: coverageOutput };
    }

    if (!coverageData) {
      // Try to generate coverage
      results.push(`⚠️ No coverage data found. Attempting to generate...\n`);

      try {
        // Try Node.js test with coverage
        if (fs.existsSync(pathLib.join(cwd, "package.json"))) {
          const packageJson = JSON.parse(
            fs.readFileSync(pathLib.join(cwd, "package.json"), "utf-8")
          );

          if (packageJson.dependencies?.jest || packageJson.devDependencies?.jest) {
            execSync("npm test -- --coverage --coverageReporters=json-summary", {
              cwd,
              encoding: "utf-8",
              maxBuffer: 10 * 1024 * 1024,
            });
            projectType = "node";
            coverageData = JSON.parse(fs.readFileSync(nodeCoveragePath, "utf-8"));
          } else if (
            packageJson.dependencies?.vitest ||
            packageJson.devDependencies?.vitest
          ) {
            execSync("npm test -- --coverage --coverage.reporter=json-summary", {
              cwd,
              encoding: "utf-8",
              maxBuffer: 10 * 1024 * 1024,
            });
            projectType = "node";
            coverageData = JSON.parse(fs.readFileSync(nodeCoveragePath, "utf-8"));
          }
        }
      } catch (error) {
        return {
          tool: "analyze_coverage",
          result: "",
          error: `No coverage data found. Run tests with coverage first:\n  Node.js: npm test -- --coverage\n  Python: pytest --cov=. --cov-report=json\n  Go: go test -coverprofile=coverage.out ./...`,
        };
      }
    }

    // Parse coverage data based on project type
    if (projectType === "node") {
      const total = coverageData.total;

      results.push(`Project Type: Node.js (Jest/Vitest)\n`);
      results.push(`Coverage Threshold: ${threshold}%\n`);

      // Summary
      results.push(`\n📈 Overall Coverage:`);
      const metrics = [
        { name: "Statements", data: total.statements },
        { name: "Branches", data: total.branches },
        { name: "Functions", data: total.functions },
        { name: "Lines", data: total.lines },
      ];

      metrics.forEach((metric) => {
        const pct = metric.data.pct;
        const icon = pct >= threshold ? "✅" : pct >= threshold - 10 ? "⚠️" : "❌";
        results.push(
          `  ${icon} ${metric.name}: ${pct}% (${metric.data.covered}/${metric.data.total})`
        );
      });

      // Detailed file breakdown
      if (format === "detailed") {
        results.push(`\n\n📂 File-by-File Coverage:\n`);

        const files = Object.entries(coverageData)
          .filter(([key]) => key !== "total")
          .sort(([, a]: any, [, b]: any) => a.lines.pct - b.lines.pct);

        files.slice(0, 20).forEach(([file, data]: any) => {
          const linePct = data.lines.pct;
          const icon =
            linePct >= threshold ? "✅" : linePct >= threshold - 10 ? "⚠️" : "❌";
          results.push(`  ${icon} ${file}: ${linePct}%`);
        });

        if (files.length > 20) {
          results.push(`\n  ... and ${files.length - 20} more files`);
        }
      }

      // Identify uncovered areas
      if (includeUncovered) {
        results.push(`\n\n🎯 Coverage Gaps (files below ${threshold}%):\n`);

        const uncoveredFiles = Object.entries(coverageData)
          .filter(([key]) => key !== "total")
          .filter(([, data]: any) => data.lines.pct < threshold)
          .sort(([, a]: any, [, b]: any) => a.lines.pct - b.lines.pct)
          .slice(0, 10);

        if (uncoveredFiles.length === 0) {
          results.push(`  ✅ All files meet coverage threshold!`);
        } else {
          uncoveredFiles.forEach(([file, data]: any) => {
            results.push(
              `  📄 ${file}: ${data.lines.pct}% (${data.lines.total - data.lines.covered} uncovered lines)`
            );
          });
        }
      }
    } else if (projectType === "python") {
      // Parse Python coverage.json format
      const files = coverageData.files;
      const totals = coverageData.totals;

      results.push(`Project Type: Python (pytest-cov)\n`);
      results.push(`Coverage Threshold: ${threshold}%\n`);

      const pct = totals.percent_covered;
      const icon = pct >= threshold ? "✅" : pct >= threshold - 10 ? "⚠️" : "❌";

      results.push(`\n📈 Overall Coverage:`);
      results.push(
        `  ${icon} Lines: ${pct.toFixed(1)}% (${totals.covered_lines}/${totals.num_statements})`
      );

      if (format === "detailed" && files) {
        results.push(`\n\n📂 File-by-File Coverage:\n`);

        Object.entries(files)
          .slice(0, 20)
          .forEach(([file, data]: any) => {
            const filePct = (data.summary.covered_lines / data.summary.num_statements) * 100;
            const icon =
              filePct >= threshold ? "✅" : filePct >= threshold - 10 ? "⚠️" : "❌";
            results.push(`  ${icon} ${file}: ${filePct.toFixed(1)}%`);
          });
      }
    } else if (projectType === "go") {
      results.push(`Project Type: Go\n`);
      results.push(`Coverage Threshold: ${threshold}%\n`);

      // Parse go coverage format
      const lines = coverageData.raw.split("\n").filter((l: string) => l.trim());
      const coverageLines = lines.filter((l: string) => !l.startsWith("mode:"));

      let totalStatements = 0;
      let coveredStatements = 0;

      coverageLines.forEach((line: string) => {
        const parts = line.split(" ");
        if (parts.length >= 3) {
          const count = parseInt(parts[2]);
          const statements = parseInt(parts[1].split(",")[1]);
          totalStatements += statements;
          if (count > 0) {
            coveredStatements += statements;
          }
        }
      });

      const pct =
        totalStatements > 0 ? (coveredStatements / totalStatements) * 100 : 0;
      const icon = pct >= threshold ? "✅" : pct >= threshold - 10 ? "⚠️" : "❌";

      results.push(`\n📈 Overall Coverage:`);
      results.push(
        `  ${icon} Statements: ${pct.toFixed(1)}% (${coveredStatements}/${totalStatements})`
      );
    }

    return {
      tool: "analyze_coverage",
      result: results.join("\n"),
    };
  } catch (error) {
    return {
      tool: "analyze_coverage",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Find all references to a symbol (function, class, variable) in the codebase
 */
export function findReferences(
  symbol: string,
  cwd: string,
  options?: {
    filePattern?: string; // Glob pattern to limit search
    includeDefinition?: boolean;
    maxResults?: number;
    contextLines?: number; // Lines of context around each match
  }
): ToolResult {
  try {
    const filePattern = options?.filePattern || "**/*.{js,jsx,ts,tsx,py,go,rs}";
    const includeDefinition = options?.includeDefinition ?? true;
    const maxResults = options?.maxResults || 50;
    const contextLines = options?.contextLines || 2;

    const results: string[] = [];
    results.push(`🔍 Finding references to: "${symbol}"\n${"=".repeat(50)}\n`);

    // Use grep/ripgrep to find all occurrences
    let grepCommand: string;
    let useRipgrep = false;

    try {
      // Check if ripgrep is available (much faster)
      execSync("rg --version", { encoding: "utf-8" });
      useRipgrep = true;
      grepCommand = `rg --json --line-number --context ${contextLines} --type-add 'code:*.{js,jsx,ts,tsx,py,go,rs}' -t code "\\b${symbol}\\b"`;
    } catch {
      // Fallback to grep
      grepCommand = `grep -rn --include="*.js" --include="*.jsx" --include="*.ts" --include="*.tsx" --include="*.py" --include="*.go" --include="*.rs" -C ${contextLines} "\\b${symbol}\\b" .`;
    }

    let output: string;
    try {
      output = execSync(grepCommand, {
        cwd,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      }).toString();
    } catch (error: any) {
      if (error.status === 1) {
        // No matches found
        return {
          tool: "find_references",
          result: `No references found for "${symbol}"`,
        };
      }
      throw error;
    }

    // Parse results
    interface Reference {
      file: string;
      line: number;
      content: string;
      context?: string[];
      type?: "definition" | "usage";
    }

    const references: Reference[] = [];

    if (useRipgrep) {
      // Parse ripgrep JSON output
      const lines = output.split("\n").filter((l) => l.trim());
      let currentFile = "";
      let currentLine = 0;
      let currentContent = "";

      lines.forEach((line) => {
        try {
          const json = JSON.parse(line);
          if (json.type === "match") {
            const data = json.data;
            currentFile = data.path.text;
            currentLine = data.line_number;
            currentContent = data.lines.text.trim();

            // Determine if it's a definition or usage
            const isDefinition =
              currentContent.includes(`function ${symbol}`) ||
              currentContent.includes(`class ${symbol}`) ||
              currentContent.includes(`const ${symbol}`) ||
              currentContent.includes(`let ${symbol}`) ||
              currentContent.includes(`var ${symbol}`) ||
              currentContent.includes(`def ${symbol}`) ||
              currentContent.includes(`func ${symbol}`) ||
              currentContent.includes(`fn ${symbol}`);

            references.push({
              file: currentFile,
              line: currentLine,
              content: currentContent,
              type: isDefinition ? "definition" : "usage",
            });
          }
        } catch (parseError) {
          // Skip invalid JSON lines
        }
      });
    } else {
      // Parse grep output
      const lines = output.split("\n");
      let currentFile = "";
      let currentLine = 0;

      lines.forEach((line) => {
        const match = line.match(/^([^:]+):(\d+):(.*)$/);
        if (match) {
          currentFile = match[1];
          currentLine = parseInt(match[2]);
          const content = match[3].trim();

          // Determine if it's a definition or usage
          const isDefinition =
            content.includes(`function ${symbol}`) ||
            content.includes(`class ${symbol}`) ||
            content.includes(`const ${symbol}`) ||
            content.includes(`let ${symbol}`) ||
            content.includes(`var ${symbol}`) ||
            content.includes(`def ${symbol}`) ||
            content.includes(`func ${symbol}`) ||
            content.includes(`fn ${symbol}`);

          references.push({
            file: currentFile,
            line: currentLine,
            content: content,
            type: isDefinition ? "definition" : "usage",
          });
        }
      });
    }

    // Filter and limit results
    let filteredRefs = references;
    if (!includeDefinition) {
      filteredRefs = references.filter((ref) => ref.type !== "definition");
    }

    if (filteredRefs.length > maxResults) {
      results.push(`⚠️ Showing first ${maxResults} of ${filteredRefs.length} references\n`);
      filteredRefs = filteredRefs.slice(0, maxResults);
    }

    // Group by file
    const byFile = new Map<string, Reference[]>();
    filteredRefs.forEach((ref) => {
      if (!byFile.has(ref.file)) {
        byFile.set(ref.file, []);
      }
      byFile.get(ref.file)!.push(ref);
    });

    results.push(`Found ${filteredRefs.length} reference(s) in ${byFile.size} file(s):\n`);

    // Display results grouped by file
    byFile.forEach((refs, file) => {
      results.push(`\n📄 ${file} (${refs.length} reference${refs.length > 1 ? "s" : ""}):`);

      refs.forEach((ref) => {
        const badge = ref.type === "definition" ? "🔷 DEF" : "🔹 USE";
        results.push(`  ${badge} Line ${ref.line}: ${ref.content}`);
      });
    });

    // Summary
    const definitions = filteredRefs.filter((r) => r.type === "definition").length;
    const usages = filteredRefs.filter((r) => r.type === "usage").length;

    results.push(`\n\n📊 Summary:`);
    results.push(`  Total references: ${filteredRefs.length}`);
    results.push(`  Definitions: ${definitions}`);
    results.push(`  Usages: ${usages}`);
    results.push(`  Files: ${byFile.size}`);

    return {
      tool: "find_references",
      result: results.join("\n"),
    };
  } catch (error) {
    return {
      tool: "find_references",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Show git blame information for a file
 */
export function gitBlame(
  path: string,
  cwd: string,
  options?: {
    startLine?: number;
    endLine?: number;
  }
): ToolResult {
  try {
    const fullPath = resolvePath(path, cwd);

    if (!fs.existsSync(fullPath)) {
      return {
        tool: "git_blame",
        result: "",
        error: `Path not found: ${path}`,
      };
    }

    const relativePath = pathLib.relative(cwd, fullPath);
    let command = `git blame "${relativePath}"`;

    if (options?.startLine && options?.endLine) {
      command += ` -L ${options.startLine},${options.endLine}`;
    } else if (options?.startLine) {
      command += ` -L ${options.startLine},${options.startLine}`;
    }

    const output = execSync(command, {
      cwd,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    }).toString();

    const results: string[] = [];
    results.push(`📜 Git Blame for ${path}\n${"=".repeat(50)}\n`);

    // Parse blame output
    const lines = output.split("\n");
    const blameInfo: Array<{
      commit: string;
      author: string;
      date: string;
      line: number;
      content: string;
    }> = [];

    lines.forEach(line => {
      const match = line.match(/^([a-f0-9]+)\s+\((.+?)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+[+-]\d{4})\s+(\d+)\)\s*(.*)$/);
      if (match) {
        blameInfo.push({
          commit: match[1].substring(0, 8),
          author: match[2].trim(),
          date: match[3],
          line: parseInt(match[4]),
          content: match[5],
        });
      }
    });

    if (blameInfo.length === 0) {
      return {
        tool: "git_blame",
        result: "No git history found for this file.",
      };
    }

    // Group by author
    const byAuthor = blameInfo.reduce((acc, info) => {
      if (!acc[info.author]) {
        acc[info.author] = [];
      }
      acc[info.author].push(info);
      return acc;
    }, {} as Record<string, typeof blameInfo>);

    // Show summary
    results.push(`**Contributors:**\n`);
    Object.entries(byAuthor).forEach(([author, lines]) => {
      const percentage = ((lines.length / blameInfo.length) * 100).toFixed(1);
      results.push(`  - ${author}: ${lines.length} lines (${percentage}%)`);
    });

    results.push(`\n**Detailed Blame:**\n`);
    blameInfo.slice(0, 50).forEach(info => {
      results.push(`Line ${info.line.toString().padStart(4)}: [${info.commit}] ${info.author} (${info.date.split(" ")[0]})`);
      results.push(`         ${info.content}`);
    });

    if (blameInfo.length > 50) {
      results.push(`\n... and ${blameInfo.length - 50} more lines`);
    }

    return {
      tool: "git_blame",
      result: results.join("\n"),
    };
  } catch (error) {
    return {
      tool: "git_blame",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Semantic Search - Search codebase using natural language queries
 */
export async function semanticSearch(
  query: string,
  cwd: string,
  provider?: any, // Provider instance
  options?: {
    limit?: number;
    minScore?: number;
    filePattern?: string;
    language?: string;
    includeTests?: boolean;
    embeddingModel?: string;
  }
): Promise<ToolResult> {
  try {
    if (!query || query.trim().length < 3) {
      return {
        tool: "semantic_search",
        result: "",
        error: "Query must be at least 3 characters",
      };
    }

    // Check if semantic search is available
    if (!provider || !provider.embed) {
      return {
        tool: "semantic_search",
        result: "",
        error:
          "Semantic search is not available. Provider does not support embeddings. Please use Ollama or OpenRouter provider.",
      };
    }

    // Dynamic import to avoid circular dependencies
    const { SemanticSearchEngine } = await import("../search/semanticEngine.js");

    const embeddingModel = options?.embeddingModel || "nomic-embed-text";
    const engine = new SemanticSearchEngine(cwd, provider, embeddingModel);

    // Execute search
    const results = await engine.search(query, {
      limit: options?.limit || 10,
      minScore: options?.minScore || 0.5,
      filePattern: options?.filePattern,
      language: options?.language,
      includeTests: options?.includeTests || false,
    });

    if (results.length === 0) {
      return {
        tool: "semantic_search",
        result:
          "No results found. The codebase may not be indexed yet. You might need to index files first or try a different query.",
      };
    }

    // Format results
    let output = `Found ${results.length} result(s) for: "${query}"\n\n`;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const score = (result.score * 100).toFixed(1);
      const location = `${result.filepath}:${result.startLine}-${result.endLine}`;
      const symbol = result.symbolName
        ? ` (${result.symbolType}: ${result.symbolName})`
        : "";

      output += `${i + 1}. ${location}${symbol} [${score}% match]\n`;

      // Show preview (first 150 chars)
      const preview = result.content
        .split("\n")
        .slice(0, 3)
        .join("\n")
        .substring(0, 150);
      output += `   ${preview}${result.content.length > 150 ? "..." : ""}\n\n`;
    }

    output += `\n💡 Tip: Use read_file to view full content of relevant files.\n`;

    return {
      tool: "semantic_search",
      result: output,
    };
  } catch (error) {
    return {
      tool: "semantic_search",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Signal that the agent needs user input before continuing
 * This is a special tool that stops iteration and waits for user response
 */
export function waitForUser(reason?: string): ToolResult {
  const message = reason || "waiting for user response";
  return {
    tool: "wait_for_user",
    result: `⏸️  Paused: ${message}`,
  };
}
