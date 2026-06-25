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
    return "This scaffold command is likely interactive. Add non-interactive flags such as --yes / --defaults so Meer can run it safely.";
  }

  return null;
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

export function updatePlan(
  input: {
    op?: string;
    title?: string;
    tasks?: unknown;
    taskId?: string;
    status?: string;
    notes?: string;
  },
  cwd: string
): ToolResult {
  const op = String(input.op ?? "set");
  if (op === "clear") return clearPlan();
  if (op === "update") {
    const status = (input.status ?? "pending") as
      "pending" | "in_progress" | "completed" | "skipped";
    return updatePlanTask(String(input.taskId), status,
      typeof input.notes === "string" ? input.notes : undefined);
  }
  // op === "set"
  const tasksInput = input.tasks;
  const tasks = Array.isArray(tasksInput)
    ? tasksInput.map((t) =>
        typeof t === "object" && t !== null && "description" in t
          ? { description: String((t as { description: unknown }).description) }
          : { description: String(t) })
    : typeof tasksInput === "string"
    ? tasksInput.split(",").map((t) => t.trim()).filter(Boolean)
        .map((description) => ({ description }))
    : [];
  return setPlan(String(input.title ?? "Plan"), tasks, cwd);
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
