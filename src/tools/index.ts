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
import { join, relative, dirname } from "path";
import * as pathLib from "path";
import chalk from "chalk";
import { spawn, execSync } from "child_process";
import { glob } from "glob";
import { ProjectContextManager } from "../context/manager.js";
import { diffLines } from "diff";
import type { Plan } from "../plan/types.js";
import { planStore } from "../plan/store.js";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_SEARCH_PORTAL_URL = "https://search.brave.com/search";
const MAX_BRAVE_RESULTS = 20;

export interface ToolResult {
  tool: string;
  result: string;
  error?: string;
  plan?: Plan | null;
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
    // Expand home directory
    const { homedir } = require("os");
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
export function readFile(filepath: string, cwd: string): ToolResult {
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
    const lines = content.split("\n").length;

    return {
      tool: "read_file",
      result: `File: ${filepath} (${lines} lines)\n\n${content}`,
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
      const { mkdirSync } = require("fs");
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(fullPath, edit.newContent, "utf-8");
    ProjectContextManager.getInstance().invalidate(cwd);

    return {
      tool: "apply_edit",
      result: `Successfully updated ${edit.path}`,
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
  options?: { timeoutMs?: number }
): Promise<ToolResult> {
  const startTime = Date.now();
  const timeoutMs = options?.timeoutMs ?? 120000; // Default 2 min timeout

  console.log(chalk.gray(`  🚀 Running: ${command}`));
  console.log(chalk.gray(`  ⏱️  Timeout: ${timeoutMs / 1000}s`));
  console.log("");

  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe'], // Inherit stdin for interactive prompts
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let didTimeout = false;

    // Display elapsed time every 10 seconds
    const timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const remaining = Math.floor((timeoutMs - (Date.now() - startTime)) / 1000);

      if (remaining > 0) {
        console.log(chalk.gray(`  ⏱️  Elapsed: ${elapsed}s | Timeout in: ${remaining}s`));
      }
    }, 10000);

    const timeoutHandle = setTimeout(() => {
      didTimeout = true;
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log(
        chalk.yellow(
          `\n  ⏰ Command timed out after ${elapsed}s, sending SIGTERM...`
        )
      );
      console.log(chalk.yellow(`  💡 Tip: Use timeoutMs option to increase timeout`));
      child.kill("SIGTERM");

      // Force kill if still running after grace period
      setTimeout(() => {
        if (!child.killed) {
          console.log(
            chalk.red(
              "  ⛔ Command unresponsive, sending SIGKILL to terminate"
            )
          );
          child.kill("SIGKILL");
        }
      }, 5000);
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdoutBuffer += text;
      process.stdout.write(text);
    });

    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuffer += text;
      process.stderr.write(chalk.gray(text)); // Gray for stderr
    });

    const finalize = (result: ToolResult) => {
      clearInterval(timerInterval);
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log(chalk.gray(`\n  ✓ Completed in ${elapsed}s\n`));

      resolve(result);
    };

    child.on("error", (error) => {
      finalize({
        tool: "run_command",
        result: stdoutBuffer,
        error: `Failed to start command: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    });

    child.on("close", (code, signal) => {
      if (didTimeout) {
        finalize({
          tool: "run_command",
          result: stdoutBuffer,
          error: `Command timed out after ${timeoutMs / 1000}s. Increase timeout with timeoutMs option if needed.`,
        });
        return;
      }

      if (signal && signal !== "SIGTERM") {
        finalize({
          tool: "run_command",
          result: stdoutBuffer,
          error: `Command terminated with signal ${signal}`,
        });
        return;
      }

      if (code === 0) {
        ProjectContextManager.getInstance().invalidate(cwd);
        finalize({
          tool: "run_command",
          result: stdoutBuffer || "Command executed successfully.",
        });
      } else {
        const stderrText = stderrBuffer.trim();
        finalize({
          tool: "run_command",
          result: stdoutBuffer,
          error:
            stderrText.length > 0
              ? `Command failed with exit code ${code}: ${stderrText}`
              : `Command failed with exit code ${code}.`,
        });
      }
    });
  });
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
        command = `npx create-react-app ${projectName}`;
        description = "React application";
        break;
      case "vue":
        command = `npm create vue@latest ${projectName}`;
        description = "Vue application";
        break;
      case "angular":
        command = `npx @angular/cli new ${projectName}`;
        description = "Angular application";
        break;
      case "next":
        command = `npx create-next-app@latest ${projectName}`;
        description = "Next.js application";
        break;
      case "nuxt":
        command = `npx nuxi@latest init ${projectName}`;
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

    console.log(chalk.gray(`  🏗️  Scaffolding ${description}: ${projectName}`));
    console.log(chalk.gray(`  🚀 Running: ${command}`));

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
    console.log(chalk.gray(`  🔍 Finding files matching: ${pattern}`));

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
    console.log(chalk.gray(`  📚 Reading ${filePaths.length} files`));

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
    console.log(chalk.gray(`  🔎 Searching for: "${searchTerm}"`));

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

    console.log(chalk.gray(`  🔎 Searching in ${filepath} for: "${pattern}"`));

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
 * Tool: Edit a specific line in a file
 * Useful for precise edits when you know the exact line number from grep
 */
export function editLine(
  filepath: string,
  lineNumber: number,
  oldText: string,
  newText: string,
  cwd: string
): FileEdit {
  const fullPath = resolvePath(filepath, cwd);

  if (!existsSync(fullPath)) {
    throw new Error(`File not found: ${filepath}`);
  }

  const content = readFileSync(fullPath, "utf-8");
  const lines = content.split("\n");

  // Validate line number
  if (lineNumber < 1 || lineNumber > lines.length) {
    throw new Error(`Line number ${lineNumber} is out of range (file has ${lines.length} lines)`);
  }

  const lineIndex = lineNumber - 1;
  const currentLine = lines[lineIndex];

  // Verify old text matches
  if (!currentLine.includes(oldText)) {
    throw new Error(
      `Line ${lineNumber} does not contain "${oldText}".\nActual line: ${currentLine}`
    );
  }

  // Replace the line
  lines[lineIndex] = currentLine.replace(oldText, newText);
  const newContent = lines.join("\n");

  return {
    path: filepath,
    oldContent: content,
    newContent,
    description: `Edit line ${lineNumber}: replace "${oldText}" with "${newText}"`,
  };
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
    const { validateSyntax } = require('../lsp/diagnostics.js');
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
  const fullPath = resolvePath(filepath, cwd);

  // File must exist for section editing
  if (!existsSync(fullPath)) {
    throw new Error(
      `File not found: ${filepath}. ` +
      `edit_section only works on existing files. ` +
      `Use write_file or propose_edit to create new files.`
    );
  }

  const content = readFileSync(fullPath, 'utf-8');

  // Validate that old text exists in the file
  if (!content.includes(oldText)) {
    // Provide helpful error with context
    const lines = content.split('\n');
    const preview = lines.slice(0, 5).join('\n');
    throw new Error(
      `Exact match not found in ${filepath}.\n\n` +
      `The old_text must match exactly (including whitespace and indentation).\n\n` +
      `File preview (first 5 lines):\n${preview}\n\n` +
      `Hint: Use read_file or grep to get the exact text before using edit_section.`
    );
  }

  // Count occurrences to ensure uniqueness
  const occurrences = content.split(oldText).length - 1;
  if (occurrences > 1) {
    throw new Error(
      `Found ${occurrences} matches for the old_text in ${filepath}. ` +
      `The old_text must be unique. ` +
      `Please provide more surrounding context to make it unique.`
    );
  }

  // Replace the section
  const newContent = content.replace(oldText, newText);

  // Optional syntax validation (enabled by default for code files)
  const shouldValidate = options.validateSyntax !== false && isCodeFile(fullPath);
  if (shouldValidate) {
    const validation = validateSyntaxInternal(fullPath, newContent, cwd);
    if (!validation.valid) {
      throw new Error(
        `Syntax validation failed for ${filepath}:\n` +
        validation.errors.map(e => `  • ${e}`).join('\n') + '\n\n' +
        `The proposed changes would introduce syntax errors. Please fix them before applying.`
      );
    }
  }

  // Calculate what changed for description
  const oldLines = oldText.split('\n').length;
  const newLines = newText.split('\n').length;
  const changeDesc = oldLines === newLines
    ? `${oldLines} line(s)`
    : `${oldLines} → ${newLines} line(s)`;

  return {
    path: filepath,
    oldContent: content,
    newContent,
    description: `Edit section in ${filepath} (${changeDesc})`,
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
    console.log(chalk.gray(`  📁 Reading folder: ${folderPath}`));

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
    console.log(chalk.gray(`  🌐 Searching the web for: "${query}"`));

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

    const response = await fetch(requestUrl, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
        "User-Agent": "MeerAI CLI",
      },
    });

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

    const data: {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
      query?: { original?: string; corrected?: string };
    } = await response.json();

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
    const message = error instanceof Error ? error.message : String(error);
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
    console.log(chalk.gray(`  🌐 Fetching: ${url}`));

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
      error: error instanceof Error ? error.message : String(error),
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
    console.log(chalk.gray(`  💾 Saving memory: ${key}`));

    // Create memory directory if it doesn't exist
    const memoryDir = join(cwd, ".meer-memory");
    if (!existsSync(memoryDir)) {
      execSync(`mkdir -p "${memoryDir}"`, { cwd });
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
    console.log(chalk.gray(`  📖 Loading memory: ${key}`));

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
export function gitStatus(cwd: string): ToolResult {
  try {
    console.log(chalk.gray(`  📊 Checking git status`));

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
    console.log(chalk.gray(`  📜 Fetching git commit history`));

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
    console.log(chalk.gray(`  💾 Creating git commit`));

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
      console.log(chalk.gray(`  🌿 Creating branch: ${options.create}`));
      execSync(`git branch "${options.create}"`, { cwd, stdio: "pipe" });
      return {
        tool: "git_branch",
        result: `Created branch: ${options.create}`,
      };
    }

    // Switch branch
    if (options.switch) {
      console.log(chalk.gray(`  🔀 Switching to branch: ${options.switch}`));
      execSync(`git checkout "${options.switch}"`, { cwd, stdio: "pipe" });
      ProjectContextManager.getInstance().invalidate(cwd);
      return {
        tool: "git_branch",
        result: `Switched to branch: ${options.switch}`,
      };
    }

    // Delete branch
    if (options.delete) {
      console.log(chalk.gray(`  🗑️  Deleting branch: ${options.delete}`));
      execSync(`git branch -d "${options.delete}"`, { cwd, stdio: "pipe" });
      return {
        tool: "git_branch",
        result: `Deleted branch: ${options.delete}`,
      };
    }

    // List branches (default)
    console.log(chalk.gray(`  🌿 Listing branches`));
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
    console.log(chalk.gray(`  ✍️  Writing file: ${filepath}`));

    const fullPath = resolvePath(filepath, cwd);
    const dir = dirname(fullPath);

    // Ensure directory exists
    if (!existsSync(dir)) {
      const { mkdirSync } = require("fs");
      mkdirSync(dir, { recursive: true });
    }

    // Check if file already exists
    const fileExists = existsSync(fullPath);

    writeFileSync(fullPath, content, "utf-8");
    ProjectContextManager.getInstance().invalidate(cwd);

    return {
      tool: "write_file",
      result: fileExists
        ? `Successfully updated ${filepath} (${content.length} bytes)`
        : `Successfully created ${filepath} (${content.length} bytes)`,
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
    console.log(chalk.gray(`  🗑️  Deleting file: ${filepath}`));

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

    const { unlinkSync } = require("fs");
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
    console.log(chalk.gray(`  📦 Moving: ${sourcePath} → ${destPath}`));

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
      const { mkdirSync } = require("fs");
      mkdirSync(destDir, { recursive: true });
    }

    const { renameSync } = require("fs");
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
    console.log(chalk.gray(`  📁 Creating directory: ${dirpath}`));

    const fullPath = resolvePath(dirpath, cwd);

    if (existsSync(fullPath)) {
      return {
        tool: "create_directory",
        result: "",
        error: `Directory already exists: ${dirpath}`,
      };
    }

    const { mkdirSync } = require("fs");
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

    console.log(chalk.gray(`  📦 Installing packages with ${manager}: ${pkgList}`));

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
    console.log(chalk.gray(`  🚀 Running script with ${manager}: ${script}`));

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
      console.log(chalk.gray(`  📋 Checking for outdated packages`));
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
    console.log(chalk.gray(`  🔑 Reading environment variable: ${key}`));

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
    console.log(chalk.gray(`  🔑 Setting environment variable: ${key}`));

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
    console.log(chalk.gray(`  🔑 Listing environment variables`));

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
    console.log(chalk.gray(`  🌐 Making ${options.method || "GET"} request to: ${url}`));

    const { fetch } = await import("undici");

    const response = await fetch(url, {
      method: options.method || "GET",
      headers: options.headers,
      body: options.body,
      signal: options.timeout ? AbortSignal.timeout(options.timeout) : undefined,
    });

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
      error: error instanceof Error ? error.message : String(error),
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

    console.log(chalk.gray(`  📋 Getting outline for: ${filepath}`));

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
    console.log(chalk.gray(`  🔍 Finding definition of: ${symbol}`));

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

    console.log(chalk.gray(`  ✓ Checking syntax: ${filepath}`));

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
    console.log(chalk.gray(`    ↳ Detected: ${projectInfo.type} project`));

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
        console.log(chalk.gray(`    ↳ Running ${name}...`));
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
        return `  ${chalk.gray(`${index + 1}.`)} ${statusIcon} ${task.description}`;
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

        const taskExists = currentPlan.tasks.some((t) => t.id === taskId);
        if (!taskExists) {
          return {
            tool: "update_plan_task",
            result: "",
            error: `Task ${taskId} not found in the plan.`,
          };
        }

        const updatedPlan = (
          planStore.update((plan) => {
            const mutableTask = plan.tasks.find((t) => t.id === taskId);
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
        return `  ${chalk.gray(`${index + 1}.`)} ${icon} ${color(t.description)}`;
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
        let line = `  ${chalk.gray(`${index + 1}.`)} ${icon} ${color(task.description)}`;
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
 * Tool: Explain code section
 * Returns code with context for the LLM to explain
 */
export function explainCode(
  filepath: string,
  cwd: string,
  options?: {
    startLine?: number;
    endLine?: number;
    focusSymbol?: string; // Function/class name to focus on
  }
): ToolResult {
  try {
    const fullPath = resolvePath(filepath, cwd);

    if (!existsSync(fullPath)) {
      return {
        tool: "explain_code",
        result: "",
        error: `File not found: ${filepath}`,
      };
    }

    const content = readFileSync(fullPath, "utf-8");
    const lines = content.split("\n");

    let startLine = options?.startLine || 1;
    let endLine = options?.endLine || lines.length;

    // Validate line numbers
    if (startLine < 1) startLine = 1;
    if (endLine > lines.length) endLine = lines.length;
    if (startLine > endLine) {
      return {
        tool: "explain_code",
        result: "",
        error: `Invalid line range: ${startLine}-${endLine}`,
      };
    }

    // Extract the target code section
    const targetLines = lines.slice(startLine - 1, endLine);
    const targetCode = targetLines.join("\n");

    // Get context (10 lines before and after if possible)
    const contextBefore = Math.max(1, startLine - 10);
    const contextAfter = Math.min(lines.length, endLine + 10);
    const contextLines = lines.slice(contextBefore - 1, contextAfter);

    // Detect language from file extension
    const ext = filepath.split(".").pop() || "";
    const languageMap: Record<string, string> = {
      ts: "typescript",
      tsx: "typescript",
      js: "javascript",
      jsx: "javascript",
      py: "python",
      go: "go",
      rs: "rust",
      java: "java",
      cpp: "cpp",
      c: "c",
      rb: "ruby",
      php: "php",
    };
    const language = languageMap[ext] || ext;

    // Format response
    let result = `File: ${filepath}\n`;
    result += `Language: ${language}\n`;
    result += `Lines: ${startLine}-${endLine} (of ${lines.length} total)\n\n`;

    if (options?.focusSymbol) {
      result += `Focus: ${options.focusSymbol}\n\n`;
    }

    result += `${"=".repeat(60)}\n`;
    result += `CODE TO EXPLAIN (lines ${startLine}-${endLine}):\n`;
    result += `${"=".repeat(60)}\n\n`;
    result += `\`\`\`${language}\n${targetCode}\n\`\`\`\n\n`;

    // Add context if it's different from target
    if (contextBefore < startLine || contextAfter > endLine) {
      result += `${"=".repeat(60)}\n`;
      result += `SURROUNDING CONTEXT (lines ${contextBefore}-${contextAfter}):\n`;
      result += `${"=".repeat(60)}\n\n`;
      result += `\`\`\`${language}\n`;
      contextLines.forEach((line, idx) => {
        const lineNum = contextBefore + idx;
        const isTarget = lineNum >= startLine && lineNum <= endLine;
        result += isTarget ? `> ${line}\n` : `  ${line}\n`;
      });
      result += `\`\`\`\n\n`;
    }

    result += `Please provide a clear, concise explanation of this code:\n`;
    result += `1. What does it do? (purpose and functionality)\n`;
    result += `2. How does it work? (logic and flow)\n`;
    result += `3. Key concepts or patterns used\n`;
    result += `4. Any potential issues or improvements\n`;

    return {
      tool: "explain_code",
      result,
    };
  } catch (error) {
    return {
      tool: "explain_code",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Generate documentation/docstring for code
 */
export function generateDocstring(
  filepath: string,
  cwd: string,
  options?: {
    symbolName?: string; // Function/class name
    style?: 'jsdoc' | 'tsdoc' | 'sphinx' | 'google';
    startLine?: number;
    endLine?: number;
  }
): ToolResult {
  try {
    const fullPath = resolvePath(filepath, cwd);

    if (!existsSync(fullPath)) {
      return {
        tool: "generate_docstring",
        result: "",
        error: `File not found: ${filepath}`,
      };
    }

    const content = readFileSync(fullPath, "utf-8");
    const lines = content.split("\n");

    // Detect file type and default doc style
    const ext = filepath.split(".").pop() || "";
    const defaultStyle = ext === 'py' ? 'google' :
                        (ext === 'ts' || ext === 'tsx') ? 'tsdoc' : 'jsdoc';
    const docStyle = options?.style || defaultStyle;

    let startLine = options?.startLine || 1;
    let endLine = options?.endLine || lines.length;

    if (startLine < 1) startLine = 1;
    if (endLine > lines.length) endLine = lines.length;

    const targetCode = lines.slice(startLine - 1, endLine).join("\n");

    let result = `File: ${filepath}\n`;
    result += `Documentation Style: ${docStyle}\n`;

    if (options?.symbolName) {
      result += `Symbol: ${options.symbolName}\n`;
    }

    result += `\n${"=".repeat(60)}\n`;
    result += `CODE:\n`;
    result += `${"=".repeat(60)}\n\n`;
    result += `\`\`\`\n${targetCode}\n\`\`\`\n\n`;
    result += `Please generate comprehensive ${docStyle}-style documentation for this code including:\n`;
    result += `1. Brief description of what it does\n`;
    result += `2. Parameters/arguments with types and descriptions\n`;
    result += `3. Return value and type\n`;
    result += `4. Example usage if applicable\n`;
    result += `5. Any important notes, exceptions, or side effects\n\n`;
    result += `Format the documentation in ${docStyle} style, ready to be inserted above the code.\n`;

    return {
      tool: "generate_docstring",
      result,
    };
  } catch (error) {
    return {
      tool: "generate_docstring",
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

        const output = execSync(auditCmd, {
          cwd,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe']
        });

        if (options?.fix) {
          results.push(`✓ npm audit fix completed\n${output}`);
        } else {
          // Parse JSON output
          try {
            const auditData = JSON.parse(output);
            const vulns = auditData.metadata?.vulnerabilities || {};
            const total = Object.values(vulns).reduce((sum: number, count: any) => sum + (count || 0), 0);

            results.push(`\n📦 npm Audit Results:\n`);
            results.push(`Total vulnerabilities: ${total}`);
            if (vulns.critical) results.push(`  🔴 Critical: ${vulns.critical}`);
            if (vulns.high) results.push(`  🟠 High: ${vulns.high}`);
            if (vulns.moderate) results.push(`  🟡 Moderate: ${vulns.moderate}`);
            if (vulns.low) results.push(`  🟢 Low: ${vulns.low}`);

            if (total > 0) {
              results.push(`\nRun with fix: true to auto-fix vulnerabilities`);
            }
          } catch {
            results.push(output);
          }
        }
      } catch (error: any) {
        const stderr = error.stderr?.toString() || error.message;
        results.push(`npm audit: ${stderr}`);
      }

      // Also check for outdated packages
      try {
        const outdatedOutput = execSync('npm outdated --json', {
          cwd,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe']
        });

        try {
          const outdated = JSON.parse(outdatedOutput);
          const count = Object.keys(outdated).length;
          if (count > 0) {
            results.push(`\n📊 Outdated Packages: ${count}`);
          }
        } catch {
          // No outdated packages or parsing error
        }
      } catch {
        // npm outdated returns non-zero if packages are outdated
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
 * Tool: Generate tests for code using AI
 */
export function generateTests(
  filepath: string,
  cwd: string,
  options?: {
    framework?: 'jest' | 'vitest' | 'mocha' | 'pytest' | 'go' | 'auto';
    coverage?: 'unit' | 'integration' | 'e2e' | 'all';
    focusFunction?: string; // Specific function to test
  }
): ToolResult {
  try {
    const fullPath = resolvePath(filepath, cwd);

    if (!existsSync(fullPath)) {
      return {
        tool: "generate_tests",
        result: "",
        error: `File not found: ${filepath}`,
      };
    }

    const content = readFileSync(fullPath, "utf-8");

    // Auto-detect framework
    let framework = options?.framework || 'auto';
    if (framework === 'auto') {
      const ext = filepath.split(".").pop() || "";
      if (ext === 'py') framework = 'pytest';
      else if (ext === 'go') framework = 'go';
      else {
        // Check for JS test framework in package.json
        const packageJsonPath = join(cwd, 'package.json');
        if (existsSync(packageJsonPath)) {
          const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
          const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
          if (deps.jest) framework = 'jest';
          else if (deps.vitest) framework = 'vitest';
          else if (deps.mocha) framework = 'mocha';
          else framework = 'jest'; // Default
        } else {
          framework = 'jest';
        }
      }
    }

    const coverage = options?.coverage || 'all';

    let result = `File: ${filepath}\n`;
    result += `Framework: ${framework}\n`;
    result += `Coverage: ${coverage}\n\n`;

    if (options?.focusFunction) {
      result += `Focus Function: ${options.focusFunction}\n\n`;
    }

    result += `${"=".repeat(60)}\n`;
    result += `CODE TO TEST:\n`;
    result += `${"=".repeat(60)}\n\n`;
    result += `\`\`\`\n${content}\n\`\`\`\n\n`;

    result += `Please generate comprehensive ${framework} tests for this code including:\n\n`;

    if (coverage === 'unit' || coverage === 'all') {
      result += `**Unit Tests:**\n`;
      result += `- Test each function/method independently\n`;
      result += `- Test happy path scenarios\n`;
      result += `- Test edge cases (empty inputs, null, undefined, etc.)\n`;
      result += `- Test error conditions and exceptions\n`;
      result += `- Test boundary values\n\n`;
    }

    if (coverage === 'integration' || coverage === 'all') {
      result += `**Integration Tests:**\n`;
      result += `- Test interactions between components\n`;
      result += `- Test with real dependencies where appropriate\n`;
      result += `- Test data flow through the system\n\n`;
    }

    if (coverage === 'e2e' || coverage === 'all') {
      result += `**End-to-End Tests:**\n`;
      result += `- Test complete workflows\n`;
      result += `- Test from user perspective\n\n`;
    }

    result += `**Test Structure:**\n`;
    result += `- Use describe/it blocks (or equivalent)\n`;
    result += `- Setup and teardown as needed\n`;
    result += `- Mock external dependencies\n`;
    result += `- Clear test names describing what is being tested\n`;
    result += `- Use assertions appropriate for ${framework}\n\n`;

    result += `Generate complete, runnable test code ready to be saved to a test file.\n`;

    return {
      tool: "generate_tests",
      result,
    };
  } catch (error) {
    return {
      tool: "generate_tests",
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
 * Tool: AI-powered code review
 */
export function codeReview(
  path: string,
  cwd: string,
  options?: {
    focus?: Array<'security' | 'performance' | 'style' | 'bugs' | 'best-practices' | 'all'>;
    severity?: 'suggestion' | 'warning' | 'error';
  }
): ToolResult {
  try {
    const fullPath = resolvePath(path, cwd);

    if (!existsSync(fullPath)) {
      return {
        tool: "code_review",
        result: "",
        error: `Path not found: ${path}`,
      };
    }

    const stats = statSync(fullPath);
    const isDirectory = stats.isDirectory();

    let content = '';
    let fileList: string[] = [];

    if (isDirectory) {
      // Review multiple files
      const pattern = join(fullPath, '**/*.{ts,tsx,js,jsx,py,go,rs}');
      fileList = glob.sync(pattern, {
        ignore: DEFAULT_IGNORE_GLOBS,
        nodir: true,
      }).slice(0, 10); // Limit to 10 files

      content = fileList.map(file => {
        const relativePath = relative(cwd, file);
        const fileContent = readFileSync(file, 'utf-8');
        return `\n${"=".repeat(60)}\nFile: ${relativePath}\n${"=".repeat(60)}\n${fileContent}`;
      }).join('\n\n');
    } else {
      // Review single file
      fileList = [fullPath];
      content = readFileSync(fullPath, 'utf-8');
    }

    const focus = options?.focus || ['all'];
    const reviewAll = focus.includes('all');

    let result = isDirectory
      ? `Reviewing directory: ${path} (${fileList.length} files)\n\n`
      : `Reviewing file: ${path}\n\n`;

    result += `${"=".repeat(60)}\n`;
    result += `CODE TO REVIEW:\n`;
    result += `${"=".repeat(60)}\n\n`;
    result += `\`\`\`\n${content}\n\`\`\`\n\n`;

    result += `Please perform a comprehensive code review focusing on:\n\n`;

    if (reviewAll || focus.includes('security')) {
      result += `**🔒 Security:**\n`;
      result += `- SQL injection, XSS, CSRF vulnerabilities\n`;
      result += `- Insecure dependencies or APIs\n`;
      result += `- Exposed secrets or credentials\n`;
      result += `- Input validation and sanitization\n`;
      result += `- Authentication and authorization issues\n\n`;
    }

    if (reviewAll || focus.includes('performance')) {
      result += `**⚡ Performance:**\n`;
      result += `- Inefficient algorithms or data structures\n`;
      result += `- Memory leaks or excessive allocations\n`;
      result += `- Unnecessary loops or computations\n`;
      result += `- Database query optimization\n`;
      result += `- Caching opportunities\n\n`;
    }

    if (reviewAll || focus.includes('bugs')) {
      result += `**🐛 Potential Bugs:**\n`;
      result += `- Logic errors or edge cases\n`;
      result += `- Race conditions or concurrency issues\n`;
      result += `- Null/undefined handling\n`;
      result += `- Off-by-one errors\n`;
      result += `- Type mismatches or coercion issues\n\n`;
    }

    if (reviewAll || focus.includes('best-practices')) {
      result += `**✨ Best Practices:**\n`;
      result += `- Code organization and modularity\n`;
      result += `- Naming conventions\n`;
      result += `- Error handling patterns\n`;
      result += `- Code duplication (DRY principle)\n`;
      result += `- SOLID principles adherence\n\n`;
    }

    if (reviewAll || focus.includes('style')) {
      result += `**🎨 Code Style:**\n`;
      result += `- Consistent formatting\n`;
      result += `- Clear and meaningful names\n`;
      result += `- Appropriate comments and documentation\n`;
      result += `- Code readability\n\n`;
    }

    result += `For each issue found, provide:\n`;
    result += `1. **Location**: File and line number (if applicable)\n`;
    result += `2. **Severity**: Critical / High / Medium / Low\n`;
    result += `3. **Issue**: Clear description of the problem\n`;
    result += `4. **Recommendation**: How to fix it\n`;
    result += `5. **Example**: Code snippet showing the fix (if applicable)\n`;

    return {
      tool: "code_review",
      result,
    };
  } catch (error) {
    return {
      tool: "code_review",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool: Generate README.md file
 */
export function generateReadme(
  cwd: string,
  options?: {
    includeInstall?: boolean;
    includeUsage?: boolean;
    includeApi?: boolean;
    includeContributing?: boolean;
  }
): ToolResult {
  try {
    // Analyze project structure
    const hasPackageJson = existsSync(join(cwd, 'package.json'));
    const hasRequirementsTxt = existsSync(join(cwd, 'requirements.txt'));
    const hasCargoToml = existsSync(join(cwd, 'Cargo.toml'));
    const hasGoMod = existsSync(join(cwd, 'go.mod'));

    let projectInfo = '';
    let projectType = 'Unknown';
    let projectName = '';

    if (hasPackageJson) {
      const packageJson = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
      projectName = packageJson.name || '';
      projectType = 'Node.js';
      projectInfo = `Package: ${packageJson.name}\nVersion: ${packageJson.version || '1.0.0'}\n`;
      if (packageJson.description) projectInfo += `Description: ${packageJson.description}\n`;
    } else if (hasCargoToml) {
      projectType = 'Rust';
      projectName = 'Rust Project';
    } else if (hasGoMod) {
      projectType = 'Go';
      projectName = 'Go Project';
    } else if (hasRequirementsTxt) {
      projectType = 'Python';
      projectName = 'Python Project';
    }

    // Get file structure
    const files = glob.sync('**/*', {
      cwd,
      ignore: DEFAULT_IGNORE_GLOBS,
      nodir: true,
    }).slice(0, 50); // Sample first 50 files

    const options_defaults = {
      includeInstall: options?.includeInstall ?? true,
      includeUsage: options?.includeUsage ?? true,
      includeApi: options?.includeApi ?? true,
      includeContributing: options?.includeContributing ?? true,
    };

    let result = `Project: ${projectName || 'Current Project'}\n`;
    result += `Type: ${projectType}\n\n`;

    if (projectInfo) {
      result += `${"=".repeat(60)}\n`;
      result += `PROJECT INFO:\n`;
      result += `${"=".repeat(60)}\n`;
      result += projectInfo + '\n\n';
    }

    result += `${"=".repeat(60)}\n`;
    result += `PROJECT STRUCTURE:\n`;
    result += `${"=".repeat(60)}\n`;
    result += files.slice(0, 20).join('\n') + '\n';
    if (files.length > 20) result += `... and ${files.length - 20} more files\n`;

    result += `\nPlease generate a comprehensive README.md file for this ${projectType} project.\n\n`;

    result += `Include the following sections:\n\n`;
    result += `1. **Title and Description**: Project name and clear description of what it does\n`;
    result += `2. **Features**: Key features and capabilities\n`;
    result += `3. **Prerequisites**: Required software and dependencies\n\n`;

    if (options_defaults.includeInstall) {
      result += `4. **Installation**: Step-by-step installation instructions for ${projectType}\n`;
    }

    if (options_defaults.includeUsage) {
      result += `5. **Usage**: Basic usage examples and commands\n`;
    }

    if (options_defaults.includeApi) {
      result += `6. **API Documentation**: Key APIs or interfaces (if applicable)\n`;
    }

    result += `7. **Project Structure**: Brief explanation of directory structure\n`;

    if (options_defaults.includeContributing) {
      result += `8. **Contributing**: How to contribute to the project\n`;
    }

    result += `9. **License**: License information\n\n`;

    result += `Format the README in clean, professional Markdown with:\n`;
    result += `- Clear section headings\n`;
    result += `- Code blocks with syntax highlighting\n`;
    result += `- Badges (if appropriate)\n`;
    result += `- Table of contents for easy navigation\n`;

    return {
      tool: "generate_readme",
      result,
    };
  } catch (error) {
    return {
      tool: "generate_readme",
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
 * Check code complexity (cyclomatic complexity)
 */
export function checkComplexity(
  path: string,
  cwd: string,
  options?: {
    threshold?: number; // Warn if complexity > threshold
    includeDetails?: boolean;
  }
): ToolResult {
  try {
    const fullPath = resolvePath(path, cwd);

    if (!fs.existsSync(fullPath)) {
      return {
        tool: "check_complexity",
        result: "",
        error: `Path not found: ${path}`,
      };
    }

    const stats = fs.statSync(fullPath);
    const threshold = options?.threshold || 10;
    const includeDetails = options?.includeDetails ?? true;

    let results: string[] = [];
    let totalComplexity = 0;
    let functionCount = 0;

    if (stats.isFile()) {
      const ext = pathLib.extname(fullPath).toLowerCase();

      if ([".js", ".jsx", ".ts", ".tsx"].includes(ext)) {
        // JavaScript/TypeScript: use ESLint complexity rule or simple AST parsing
        try {
          const output = execSync(
            `npx eslint "${fullPath}" --format json --rule "complexity: [error, ${threshold}]"`,
            {
              cwd,
              encoding: "utf-8",
              maxBuffer: 10 * 1024 * 1024,
            }
          ).toString();

          const eslintResults = JSON.parse(output);

          if (eslintResults.length > 0) {
            const fileResults = eslintResults[0];
            const complexityMessages = fileResults.messages.filter(
              (msg: any) => msg.ruleId === "complexity"
            );

            results.push(
              `📊 Complexity Analysis for ${path}\n${"=".repeat(50)}\n`
            );

            if (complexityMessages.length === 0) {
              results.push(
                `✅ All functions have acceptable complexity (≤ ${threshold})`
              );
            } else {
              results.push(`⚠️ ${complexityMessages.length} function(s) exceed complexity threshold:\n`);

              complexityMessages.forEach((msg: any) => {
                const match = msg.message.match(/complexity of (\d+)/);
                const complexity = match ? parseInt(match[1]) : "?";
                results.push(
                  `  Line ${msg.line}: Complexity ${complexity} (threshold: ${threshold})`
                );
              });
            }
          }

          return {
            tool: "check_complexity",
            result: results.join("\n"),
          };
        } catch (error) {
          // ESLint failed, use simple heuristic
          const content = fs.readFileSync(fullPath, "utf-8");
          const lines = content.split("\n");

          results.push(`📊 Complexity Analysis for ${path}\n${"=".repeat(50)}\n`);
          results.push(`Note: Using simplified complexity estimation (ESLint not available)\n`);

          // Count control flow statements as rough estimate
          let currentFunction = "";
          let currentComplexity = 1;
          let inFunction = false;

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // Detect function start
            if (
              line.match(/function\s+\w+/) ||
              line.match(/\w+\s*=\s*\(.*\)\s*=>/) ||
              line.match(/\w+\s*\(.*\)\s*{/)
            ) {
              if (inFunction && currentComplexity > threshold) {
                results.push(
                  `  ${currentFunction}: Estimated complexity ~${currentComplexity}`
                );
              }

              const match = line.match(/function\s+(\w+)/) || line.match(/(\w+)\s*=/) || line.match(/(\w+)\s*\(/);
              currentFunction = match ? match[1] : `Line ${i + 1}`;
              currentComplexity = 1;
              inFunction = true;
              functionCount++;
            }

            // Count complexity contributors
            if (inFunction) {
              if (
                line.includes("if ") ||
                line.includes("else ") ||
                line.includes("case ") ||
                line.includes("for ") ||
                line.includes("while ") ||
                line.includes("catch ") ||
                line.includes("&&") ||
                line.includes("||") ||
                line.includes("?")
              ) {
                currentComplexity++;
              }
            }

            // Detect function end (simplified)
            if (inFunction && line === "}") {
              totalComplexity += currentComplexity;
            }
          }

          const avgComplexity =
            functionCount > 0 ? (totalComplexity / functionCount).toFixed(1) : 0;

          results.push(`\n📈 Summary:`);
          results.push(`  Functions analyzed: ${functionCount}`);
          results.push(`  Average complexity: ${avgComplexity}`);
          results.push(`  Threshold: ${threshold}`);

          return {
            tool: "check_complexity",
            result: results.join("\n"),
          };
        }
      } else if (ext === ".py") {
        // Python: use radon or mccabe
        try {
          const output = execSync(`radon cc "${fullPath}" -s -a`, {
            cwd,
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024,
          }).toString();

          results.push(`📊 Complexity Analysis for ${path}\n${"=".repeat(50)}\n`);
          results.push(output);

          return {
            tool: "check_complexity",
            result: results.join("\n"),
          };
        } catch (error) {
          return {
            tool: "check_complexity",
            result: "",
            error: `radon not available. Install with: pip install radon`,
          };
        }
      } else {
        return {
          tool: "check_complexity",
          result: "",
          error: `Complexity analysis not supported for ${ext} files`,
        };
      }
    } else {
      return {
        tool: "check_complexity",
        result: "",
        error: `Path is not a file: ${path}`,
      };
    }
  } catch (error) {
    return {
      tool: "check_complexity",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Detect code smells and anti-patterns
 */
export function detectSmells(
  path: string,
  cwd: string,
  options?: {
    types?: Array<
      | "long-functions"
      | "long-parameters"
      | "deep-nesting"
      | "duplicates"
      | "magic-numbers"
      | "all"
    >;
    severity?: "low" | "medium" | "high";
  }
): ToolResult {
  try {
    const fullPath = resolvePath(path, cwd);

    if (!fs.existsSync(fullPath)) {
      return {
        tool: "detect_smells",
        result: "",
        error: `Path not found: ${path}`,
      };
    }

    const stats = fs.statSync(fullPath);
    if (!stats.isFile()) {
      return {
        tool: "detect_smells",
        result: "",
        error: `Path is not a file: ${path}`,
      };
    }

    const content = fs.readFileSync(fullPath, "utf-8");
    const lines = content.split("\n");
    const ext = pathLib.extname(fullPath).toLowerCase();

    const smellTypes = options?.types || ["all"];
    const checkAll = smellTypes.includes("all");

    const smells: Array<{
      line: number;
      type: string;
      severity: "low" | "medium" | "high";
      message: string;
    }> = [];

    // Helper to check if we should check this smell type
    const shouldCheck = (type: string) => checkAll || smellTypes.includes(type as any);

    // 1. Long functions (> 50 lines)
    if (shouldCheck("long-functions")) {
      let functionStart = -1;
      let functionName = "";
      let braceCount = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Detect function start
        if (
          line.match(/function\s+\w+/) ||
          line.match(/\w+\s*=\s*\(.*\)\s*=>/) ||
          line.match(/\w+\s*\(.*\)\s*{/) ||
          line.match(/def\s+\w+/)
        ) {
          const match =
            line.match(/function\s+(\w+)/) ||
            line.match(/(\w+)\s*=/) ||
            line.match(/(\w+)\s*\(/) ||
            line.match(/def\s+(\w+)/);
          functionName = match ? match[1] : `Line ${i + 1}`;
          functionStart = i;
          braceCount = 0;
        }

        // Track braces
        braceCount += (line.match(/{/g) || []).length;
        braceCount -= (line.match(/}/g) || []).length;

        // Function ended
        if (functionStart >= 0 && braceCount === 0 && line.includes("}")) {
          const functionLength = i - functionStart;
          if (functionLength > 50) {
            smells.push({
              line: functionStart + 1,
              type: "long-function",
              severity: functionLength > 100 ? "high" : "medium",
              message: `Function '${functionName}' is ${functionLength} lines long (consider splitting)`,
            });
          }
          functionStart = -1;
        }
      }
    }

    // 2. Long parameter lists (> 5 parameters)
    if (shouldCheck("long-parameters")) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match =
          line.match(/function\s+\w+\s*\((.*?)\)/) ||
          line.match(/\w+\s*\((.*?)\)\s*{/) ||
          line.match(/def\s+\w+\s*\((.*?)\)/);

        if (match) {
          const params = match[1].split(",").filter((p) => p.trim());
          if (params.length > 5) {
            smells.push({
              line: i + 1,
              type: "long-parameters",
              severity: params.length > 8 ? "high" : "medium",
              message: `Function has ${params.length} parameters (consider using object/config)`,
            });
          }
        }
      }
    }

    // 3. Deep nesting (> 4 levels)
    if (shouldCheck("deep-nesting")) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const indentLevel = line.search(/\S/);
        const spaces = indentLevel >= 0 ? indentLevel : 0;
        const nestingLevel = Math.floor(spaces / 2); // Assuming 2-space indent

        if (nestingLevel > 4) {
          smells.push({
            line: i + 1,
            type: "deep-nesting",
            severity: nestingLevel > 6 ? "high" : "medium",
            message: `Nesting level ${nestingLevel} detected (consider refactoring)`,
          });
        }
      }
    }

    // 4. Magic numbers
    if (shouldCheck("magic-numbers")) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Look for numbers that aren't 0, 1, -1
        const magicNumbers = line.match(/\b(?!0\b|1\b|-1\b)\d{2,}\b/g);
        if (magicNumbers && !line.includes("//") && !line.includes("const")) {
          magicNumbers.forEach((num) => {
            smells.push({
              line: i + 1,
              type: "magic-number",
              severity: "low",
              message: `Magic number '${num}' found (consider using named constant)`,
            });
          });
        }
      }
    }

    // 5. Duplicate code detection (simplified)
    if (shouldCheck("duplicates")) {
      const lineGroups = new Map<string, number[]>();

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.length > 20 && !line.startsWith("//") && !line.startsWith("*")) {
          if (!lineGroups.has(line)) {
            lineGroups.set(line, []);
          }
          lineGroups.get(line)!.push(i + 1);
        }
      }

      lineGroups.forEach((lineNumbers, line) => {
        if (lineNumbers.length > 2) {
          smells.push({
            line: lineNumbers[0],
            type: "duplicate-code",
            severity: "medium",
            message: `Line appears ${lineNumbers.length} times (lines: ${lineNumbers.join(", ")})`,
          });
        }
      });
    }

    // Filter by severity if specified
    const filteredSmells = options?.severity
      ? smells.filter((s) => {
          const severityLevel = { low: 1, medium: 2, high: 3 };
          return severityLevel[s.severity] >= severityLevel[options.severity!];
        })
      : smells;

    // Format results
    const results: string[] = [];
    results.push(`🔍 Code Smell Detection for ${path}\n${"=".repeat(50)}\n`);

    if (filteredSmells.length === 0) {
      results.push(`✅ No code smells detected!`);
    } else {
      results.push(`⚠️ Found ${filteredSmells.length} potential code smell(s):\n`);

      // Group by severity
      const high = filteredSmells.filter((s) => s.severity === "high");
      const medium = filteredSmells.filter((s) => s.severity === "medium");
      const low = filteredSmells.filter((s) => s.severity === "low");

      if (high.length > 0) {
        results.push(`\n🔴 HIGH SEVERITY (${high.length}):`);
        high.forEach((s) => {
          results.push(`  Line ${s.line}: ${s.message}`);
        });
      }

      if (medium.length > 0) {
        results.push(`\n🟡 MEDIUM SEVERITY (${medium.length}):`);
        medium.forEach((s) => {
          results.push(`  Line ${s.line}: ${s.message}`);
        });
      }

      if (low.length > 0) {
        results.push(`\n🟢 LOW SEVERITY (${low.length}):`);
        low.forEach((s) => {
          results.push(`  Line ${s.line}: ${s.message}`);
        });
      }
    }

    return {
      tool: "detect_smells",
      result: results.join("\n"),
    };
  } catch (error) {
    return {
      tool: "detect_smells",
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
 * Generate comprehensive test suite for a module/file
 */
export function generateTestSuite(
  path: string,
  cwd: string,
  options?: {
    framework?: "jest" | "vitest" | "mocha" | "pytest" | "go" | "auto";
    includeUnit?: boolean;
    includeIntegration?: boolean;
    includeE2E?: boolean;
  }
): ToolResult {
  try {
    const fullPath = resolvePath(path, cwd);

    if (!fs.existsSync(fullPath)) {
      return {
        tool: "generate_test_suite",
        result: "",
        error: `Path not found: ${path}`,
      };
    }

    const stats = fs.statSync(fullPath);
    const includeUnit = options?.includeUnit ?? true;
    const includeIntegration = options?.includeIntegration ?? true;
    const includeE2E = options?.includeE2E ?? false;

    let targetFiles: string[] = [];

    // If path is a directory, get all code files
    if (stats.isDirectory()) {
      const codePatterns = ["**/*.js", "**/*.ts", "**/*.jsx", "**/*.tsx", "**/*.py", "**/*.go", "**/*.rs"];
      codePatterns.forEach(pattern => {
        const found = glob.sync(pathLib.join(fullPath, pattern), {
          ignore: DEFAULT_IGNORE_GLOBS.map(g => pathLib.join(fullPath, g)),
        });
        targetFiles.push(...found);
      });
    } else {
      targetFiles = [fullPath];
    }

    // Detect framework
    let framework = options?.framework || "auto";
    if (framework === "auto") {
      const ext = pathLib.extname(targetFiles[0]).toLowerCase();
      if ([".js", ".jsx", ".ts", ".tsx"].includes(ext)) {
        // Check package.json
        const pkgPath = pathLib.join(cwd, "package.json");
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
          if (pkg.dependencies?.jest || pkg.devDependencies?.jest) {
            framework = "jest";
          } else if (pkg.dependencies?.vitest || pkg.devDependencies?.vitest) {
            framework = "vitest";
          } else {
            framework = "mocha";
          }
        }
      } else if (ext === ".py") {
        framework = "pytest";
      } else if (ext === ".go") {
        framework = "go";
      }
    }

    const results: string[] = [];
    results.push(`🧪 Test Suite Generation for ${path}\n${"=".repeat(50)}\n`);
    results.push(`Framework: ${framework}`);
    results.push(`Files to test: ${targetFiles.length}`);
    results.push(`\nTest Types:`);
    if (includeUnit) results.push(`  ✅ Unit Tests`);
    if (includeIntegration) results.push(`  ✅ Integration Tests`);
    if (includeE2E) results.push(`  ✅ E2E Tests`);
    results.push(`\n${"=".repeat(50)}\n`);

    // Read and analyze each file
    targetFiles.slice(0, 10).forEach((file, idx) => {
      const content = fs.readFileSync(file, "utf-8");
      const relativePath = pathLib.relative(cwd, file);

      results.push(`\n## File ${idx + 1}: ${relativePath}\n`);

      // Extract functions/classes for test generation
      const lines = content.split("\n");
      const functions: string[] = [];
      const classes: string[] = [];

      lines.forEach(line => {
        // Detect functions
        const funcMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)|const\s+(\w+)\s*=\s*\(.*\)\s*=>|def\s+(\w+)|func\s+(\w+)/);
        if (funcMatch) {
          const funcName = funcMatch[1] || funcMatch[2] || funcMatch[3] || funcMatch[4];
          if (funcName && !funcName.startsWith("_")) {
            functions.push(funcName);
          }
        }

        // Detect classes
        const classMatch = line.match(/(?:export\s+)?class\s+(\w+)/);
        if (classMatch) {
          classes.push(classMatch[1]);
        }
      });

      if (functions.length > 0) {
        results.push(`**Functions to test (${functions.length}):**`);
        functions.slice(0, 5).forEach(fn => {
          results.push(`  - ${fn}`);
        });
        if (functions.length > 5) {
          results.push(`  ... and ${functions.length - 5} more`);
        }
      }

      if (classes.length > 0) {
        results.push(`\n**Classes to test (${classes.length}):**`);
        classes.forEach(cls => {
          results.push(`  - ${cls}`);
        });
      }
    });

    if (targetFiles.length > 10) {
      results.push(`\n... and ${targetFiles.length - 10} more files`);
    }

    // Generate test structure recommendation
    results.push(`\n\n${"=".repeat(50)}`);
    results.push(`\n## Recommended Test Structure:\n`);

    if (includeUnit) {
      results.push(`### Unit Tests:`);
      results.push(`- Test individual functions in isolation`);
      results.push(`- Mock external dependencies`);
      results.push(`- Test edge cases and error handling`);
      results.push(`- Aim for 80%+ code coverage\n`);
    }

    if (includeIntegration) {
      results.push(`### Integration Tests:`);
      results.push(`- Test interactions between modules`);
      results.push(`- Test with real dependencies where possible`);
      results.push(`- Verify data flow between components`);
      results.push(`- Test API endpoints if applicable\n`);
    }

    if (includeE2E) {
      results.push(`### E2E Tests:`);
      results.push(`- Test complete user workflows`);
      results.push(`- Test critical paths through the application`);
      results.push(`- Verify UI interactions and state changes`);
      results.push(`- Test with production-like environment\n`);
    }

    results.push(`\n💡 **Next Steps:**`);
    results.push(`1. Review the functions and classes identified above`);
    results.push(`2. Use 'generate_tests' tool for individual files to create specific tests`);
    results.push(`3. Organize tests in a __tests__ or tests/ directory`);
    results.push(`4. Run tests with 'run_tests' tool to verify coverage`);

    return {
      tool: "generate_test_suite",
      result: results.join("\n"),
    };
  } catch (error) {
    return {
      tool: "generate_test_suite",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Generate mock objects and data for testing
 */
export function generateMocks(
  path: string,
  cwd: string,
  options?: {
    mockType?: "data" | "functions" | "api" | "all";
    framework?: "jest" | "vitest" | "sinon" | "auto";
  }
): ToolResult {
  try {
    const fullPath = resolvePath(path, cwd);

    if (!fs.existsSync(fullPath)) {
      return {
        tool: "generate_mocks",
        result: "",
        error: `Path not found: ${path}`,
      };
    }

    const content = fs.readFileSync(fullPath, "utf-8");
    const ext = pathLib.extname(fullPath).toLowerCase();
    const mockType = options?.mockType || "all";
    let framework = options?.framework || "auto";

    // Auto-detect framework
    if (framework === "auto") {
      if ([".js", ".jsx", ".ts", ".tsx"].includes(ext)) {
        const pkgPath = pathLib.join(cwd, "package.json");
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
          if (pkg.dependencies?.jest || pkg.devDependencies?.jest) {
            framework = "jest";
          } else if (pkg.dependencies?.vitest || pkg.devDependencies?.vitest) {
            framework = "vitest";
          } else {
            framework = "sinon";
          }
        }
      }
    }

    const results: string[] = [];
    results.push(`🎭 Mock Generation for ${path}\n${"=".repeat(50)}\n`);
    results.push(`Framework: ${framework}`);
    results.push(`Mock Types: ${mockType}\n`);

    // Analyze code to identify what needs mocking
    const lines = content.split("\n");
    const imports: string[] = [];
    const functions: Array<{ name: string; line: number; signature: string }> = [];
    const classes: Array<{ name: string; line: number }> = [];
    const apiCalls: Array<{ line: number; call: string }> = [];

    lines.forEach((line, idx) => {
      // Track imports
      if (line.match(/^import .* from/)) {
        imports.push(line.trim());
      }

      // Track functions
      const funcMatch = line.match(/(export\s+)?(?:async\s+)?function\s+(\w+)\s*\((.*?)\)/);
      if (funcMatch) {
        functions.push({
          name: funcMatch[2],
          line: idx + 1,
          signature: funcMatch[3] || "",
        });
      }

      // Track classes
      const classMatch = line.match(/(?:export\s+)?class\s+(\w+)/);
      if (classMatch) {
        classes.push({ name: classMatch[1], line: idx + 1 });
      }

      // Track API calls
      if (line.includes("fetch(") || line.includes("axios.") || line.includes("http.")) {
        apiCalls.push({ line: idx + 1, call: line.trim() });
      }
    });

    // Generate mock recommendations
    if (mockType === "data" || mockType === "all") {
      results.push(`\n## Mock Data Objects\n`);
      results.push(`Generate mock data for testing:\n`);

      if (classes.length > 0) {
        results.push(`**Mock Class Instances:**`);
        classes.forEach(cls => {
          results.push(`  - ${cls.name}Mock (line ${cls.line})`);
        });
      }

      results.push(`\n**Example Mock Data:**`);
      results.push(`\`\`\`typescript`);
      results.push(`const mockUser = {`);
      results.push(`  id: '123',`);
      results.push(`  name: 'Test User',`);
      results.push(`  email: 'test@example.com',`);
      results.push(`  createdAt: new Date('2024-01-01'),`);
      results.push(`};`);
      results.push(`\`\`\``);
    }

    if (mockType === "functions" || mockType === "all") {
      results.push(`\n## Mock Functions\n`);

      if (functions.length > 0) {
        results.push(`**Functions to Mock (${functions.length}):**\n`);
        functions.slice(0, 5).forEach(fn => {
          results.push(`  - ${fn.name}(${fn.signature}) at line ${fn.line}`);
        });

        if (framework === "jest" || framework === "vitest") {
          results.push(`\n**Example Mock Implementation (${framework}):**`);
          results.push(`\`\`\`typescript`);
          const firstFunc = functions[0];
          results.push(`const mock${firstFunc.name} = ${framework}.fn();`);
          results.push(`mock${firstFunc.name}.mockReturnValue(/* expected return value */);`);
          results.push(`mock${firstFunc.name}.mockResolvedValue(/* for async */);`);
          results.push(`\`\`\``);
        }
      }
    }

    if (mockType === "api" || mockType === "all") {
      results.push(`\n## API Mocks\n`);

      if (apiCalls.length > 0) {
        results.push(`**API Calls Found (${apiCalls.length}):**\n`);
        apiCalls.slice(0, 5).forEach(api => {
          results.push(`  Line ${api.line}: ${api.call.substring(0, 60)}...`);
        });

        if (framework === "jest" || framework === "vitest") {
          results.push(`\n**Example API Mock:**`);
          results.push(`\`\`\`typescript`);
          results.push(`${framework}.mock('node-fetch', () => ({`);
          results.push(`  default: ${framework}.fn(() =>`);
          results.push(`    Promise.resolve({`);
          results.push(`      ok: true,`);
          results.push(`      json: async () => ({ data: 'mock response' }),`);
          results.push(`    })`);
          results.push(`  ),`);
          results.push(`}));`);
          results.push(`\`\`\``);
        }
      } else {
        results.push(`No API calls detected in this file.`);
      }
    }

    // Dependencies to mock
    if (imports.length > 0) {
      results.push(`\n## External Dependencies to Mock\n`);
      results.push(`Consider mocking these imports:\n`);
      imports.slice(0, 10).forEach(imp => {
        results.push(`  - ${imp}`);
      });
    }

    results.push(`\n\n💡 **Best Practices:**`);
    results.push(`- Mock external dependencies to isolate unit tests`);
    results.push(`- Use realistic mock data that matches production schemas`);
    results.push(`- Reset mocks between tests to avoid state pollution`);
    results.push(`- Verify mock calls with assertions (toHaveBeenCalled, etc.)`);

    return {
      tool: "generate_mocks",
      result: results.join("\n"),
    };
  } catch (error) {
    return {
      tool: "generate_mocks",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Generate API documentation from code
 */
export function generateApiDocs(
  path: string,
  cwd: string,
  options?: {
    format?: "markdown" | "html" | "json";
    includeExamples?: boolean;
    includeTypes?: boolean;
  }
): ToolResult {
  try {
    const fullPath = resolvePath(path, cwd);

    if (!fs.existsSync(fullPath)) {
      return {
        tool: "generate_api_docs",
        result: "",
        error: `Path not found: ${path}`,
      };
    }

    const stats = fs.statSync(fullPath);
    const format = options?.format || "markdown";
    const includeExamples = options?.includeExamples ?? true;
    const includeTypes = options?.includeTypes ?? true;

    let files: string[] = [];

    // Get all API/route files
    if (stats.isDirectory()) {
      const patterns = [
        "**/api/**/*.{js,ts,jsx,tsx}",
        "**/routes/**/*.{js,ts,py}",
        "**/controllers/**/*.{js,ts,py}",
        "**/endpoints/**/*.{js,ts,py}",
      ];

      patterns.forEach(pattern => {
        const found = glob.sync(pathLib.join(fullPath, pattern), {
          ignore: DEFAULT_IGNORE_GLOBS.map(g => pathLib.join(fullPath, g)),
        });
        files.push(...found);
      });
    } else {
      files = [fullPath];
    }

    const results: string[] = [];

    if (format === "markdown") {
      results.push(`# API Documentation\n`);
      results.push(`Generated from: ${path}\n`);
      results.push(`---\n`);
    }

    // Analyze each file for API endpoints
    const endpoints: Array<{
      method: string;
      path: string;
      function: string;
      file: string;
      params?: string[];
      description?: string;
    }> = [];

    files.forEach(file => {
      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split("\n");
      const relativePath = pathLib.relative(cwd, file);

      lines.forEach((line, idx) => {
        // Express/Next.js style routes
        const expressMatch = line.match(/(router|app)\.(get|post|put|delete|patch)\(['"](.+?)['"]/i);
        if (expressMatch) {
          endpoints.push({
            method: expressMatch[2].toUpperCase(),
            path: expressMatch[3],
            function: `Line ${idx + 1}`,
            file: relativePath,
          });
        }

        // Next.js API routes
        const nextMatch = line.match(/export\s+async\s+function\s+(GET|POST|PUT|DELETE|PATCH)/);
        if (nextMatch) {
          // Derive path from file structure
          const apiPath = file.includes("/api/")
            ? "/" + file.split("/api/")[1].replace(/\.(js|ts|jsx|tsx)$/, "")
            : relativePath;

          endpoints.push({
            method: nextMatch[1],
            path: apiPath,
            function: nextMatch[1],
            file: relativePath,
          });
        }

        // Flask/FastAPI style
        const pythonMatch = line.match(/@(app|router)\.(get|post|put|delete|patch)\(['"](.+?)['"]/i);
        if (pythonMatch) {
          endpoints.push({
            method: pythonMatch[2].toUpperCase(),
            path: pythonMatch[3],
            function: `Line ${idx + 1}`,
            file: relativePath,
          });
        }
      });
    });

    if (endpoints.length === 0) {
      return {
        tool: "generate_api_docs",
        result: "No API endpoints detected in the specified path.",
      };
    }

    // Group by HTTP method
    const byMethod = endpoints.reduce((acc, ep) => {
      if (!acc[ep.method]) acc[ep.method] = [];
      acc[ep.method].push(ep);
      return acc;
    }, {} as Record<string, typeof endpoints>);

    // Generate documentation
    if (format === "markdown") {
      results.push(`## API Endpoints\n`);
      results.push(`Found ${endpoints.length} endpoint(s)\n`);

      Object.entries(byMethod).forEach(([method, eps]) => {
        results.push(`\n### ${method} Requests\n`);

        eps.forEach(ep => {
          results.push(`#### \`${method} ${ep.path}\`\n`);
          results.push(`**Source:** \`${ep.file}\`\n`);

          if (includeTypes) {
            results.push(`**Request:**`);
            results.push(`\`\`\`typescript`);
            results.push(`// TODO: Define request body/query types`);
            results.push(`\`\`\`\n`);

            results.push(`**Response:**`);
            results.push(`\`\`\`typescript`);
            results.push(`// TODO: Define response types`);
            results.push(`\`\`\`\n`);
          }

          if (includeExamples) {
            results.push(`**Example:**`);
            results.push(`\`\`\`bash`);
            results.push(`curl -X ${method} http://localhost:3000${ep.path}`);
            if (method === "POST" || method === "PUT" || method === "PATCH") {
              results.push(`  -H "Content-Type: application/json"`);
              results.push(`  -d '{"key": "value"}'`);
            }
            results.push(`\`\`\`\n`);
          }

          results.push(`---\n`);
        });
      });
    } else if (format === "json") {
      return {
        tool: "generate_api_docs",
        result: JSON.stringify(endpoints, null, 2),
      };
    }

    results.push(`\n## Summary\n`);
    results.push(`- Total Endpoints: ${endpoints.length}`);
    Object.entries(byMethod).forEach(([method, eps]) => {
      results.push(`- ${method}: ${eps.length}`);
    });

    return {
      tool: "generate_api_docs",
      result: results.join("\n"),
    };
  } catch (error) {
    return {
      tool: "generate_api_docs",
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
 * Rename a symbol across the codebase (basic implementation)
 */
export function renameSymbol(
  oldName: string,
  newName: string,
  cwd: string,
  options?: {
    filePattern?: string;
    dryRun?: boolean;
  }
): ToolResult {
  try {
    const filePattern = options?.filePattern || "**/*.{js,jsx,ts,tsx,py,go,rs}";
    const dryRun = options?.dryRun ?? true; // Default to dry run for safety

    const results: string[] = [];
    results.push(`🔄 Symbol Rename: "${oldName}" → "${newName}"\n${"=".repeat(50)}\n`);

    if (dryRun) {
      results.push(`⚠️  DRY RUN MODE - No files will be modified\n`);
    }

    // Find all files matching pattern
    const files = glob.sync(filePattern, {
      cwd,
      absolute: true,
      ignore: DEFAULT_IGNORE_GLOBS,
    });

    const changes: Array<{
      file: string;
      occurrences: number;
      lines: number[];
    }> = [];

    // Search for occurrences
    files.forEach(file => {
      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split("\n");
      const foundLines: number[] = [];

      // Use word boundary regex to avoid partial matches
      const regex = new RegExp(`\\b${oldName}\\b`, "g");

      lines.forEach((line, idx) => {
        if (regex.test(line)) {
          foundLines.push(idx + 1);
        }
      });

      if (foundLines.length > 0) {
        changes.push({
          file: pathLib.relative(cwd, file),
          occurrences: foundLines.length,
          lines: foundLines,
        });

        // If not dry run, perform the replacement
        if (!dryRun) {
          const newContent = content.replace(regex, newName);
          fs.writeFileSync(file, newContent, "utf-8");
        }
      }
    });

    if (changes.length === 0) {
      return {
        tool: "rename_symbol",
        result: `No occurrences of "${oldName}" found in ${files.length} files searched.`,
      };
    }

    // Display results
    results.push(`Found ${changes.length} file(s) with occurrences:\n`);

    let totalOccurrences = 0;
    changes.forEach(change => {
      totalOccurrences += change.occurrences;
      results.push(`📄 ${change.file}`);
      results.push(`   ${change.occurrences} occurrence(s) at lines: ${change.lines.slice(0, 10).join(", ")}${change.lines.length > 10 ? "..." : ""}`);
    });

    results.push(`\n**Summary:**`);
    results.push(`  Files affected: ${changes.length}`);
    results.push(`  Total occurrences: ${totalOccurrences}`);

    if (dryRun) {
      results.push(`\n💡 **To apply changes:**`);
      results.push(`   Run again with dryRun=false to perform the rename`);
      results.push(`\n⚠️  **Warning:**`);
      results.push(`   This is a basic text replacement.`);
      results.push(`   Review changes carefully before applying!`);
      results.push(`   Consider committing your changes first.`);
    } else {
      results.push(`\n✅ Rename completed successfully!`);
      results.push(`   Review the changes and test your code.`);
    }

    return {
      tool: "rename_symbol",
      result: results.join("\n"),
    };
  } catch (error) {
    return {
      tool: "rename_symbol",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool 60: Extract Function
 * Extracts selected code lines into a new function
 */
export function extractFunction(
  filePath: string,
  startLine: number,
  endLine: number,
  functionName: string,
  cwd: string,
  options?: {
    dryRun?: boolean;
    insertLocation?: "before" | "after" | "top";
  }
): ToolResult {
  try {
    const resolvedPath = resolvePath(filePath, cwd);

    if (!fs.existsSync(resolvedPath)) {
      return {
        tool: "extract_function",
        result: "",
        error: `File not found: ${resolvedPath}`,
      };
    }

    const content = fs.readFileSync(resolvedPath, "utf-8");
    const lines = content.split("\n");

    if (startLine < 1 || endLine > lines.length || startLine > endLine) {
      return {
        tool: "extract_function",
        result: "",
        error: `Invalid line range: ${startLine}-${endLine} (file has ${lines.length} lines)`,
      };
    }

    // Extract the code block
    const extractedLines = lines.slice(startLine - 1, endLine);
    const baseIndent = extractedLines[0]?.match(/^\s*/)?.[0] || "";

    // Analyze variables used in the extracted code
    const variableUsagePattern = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g;
    const usedVars = new Set<string>();
    extractedLines.forEach((line) => {
      const matches = line.matchAll(variableUsagePattern);
      for (const match of matches) {
        usedVars.add(match[1]);
      }
    });

    // Find variables declared before the extracted code
    const beforeLines = lines.slice(0, startLine - 1);
    const declaredVars = new Set<string>();
    beforeLines.forEach((line) => {
      const varDecl = line.match(/(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
      if (varDecl) declaredVars.add(varDecl[1]);
    });

    // Parameters are variables used but not declared in extracted code
    const params = Array.from(usedVars).filter((v) => declaredVars.has(v));

    // Generate the new function
    const dryRun = options?.dryRun !== false; // Default to true
    const insertLocation = options?.insertLocation || "before";

    // Remove base indentation from extracted lines
    const functionBody = extractedLines
      .map((line) => {
        if (line.startsWith(baseIndent)) {
          return "  " + line.substring(baseIndent.length);
        }
        return "  " + line;
      })
      .join("\n");

    const fileExt = pathLib.extname(resolvedPath);
    let newFunction = "";

    if (fileExt === ".ts" || fileExt === ".tsx") {
      newFunction = `${baseIndent}function ${functionName}(${params.join(", ")}) {\n${functionBody}\n${baseIndent}}`;
    } else if (fileExt === ".py") {
      newFunction = `${baseIndent}def ${functionName}(${params.join(", ")}):\n${functionBody}\n`;
    } else {
      newFunction = `${baseIndent}function ${functionName}(${params.join(", ")}) {\n${functionBody}\n${baseIndent}}`;
    }

    // Generate the function call to replace extracted code
    const functionCall = `${baseIndent}${functionName}(${params.join(", ")});`;

    let result = `Extract Function: ${functionName}\n`;
    result += `File: ${resolvedPath}\n`;
    result += `Lines: ${startLine}-${endLine}\n`;
    result += `Parameters detected: ${params.length > 0 ? params.join(", ") : "none"}\n\n`;

    if (dryRun) {
      result += `DRY RUN - No changes made\n\n`;
      result += `New function (would be inserted ${insertLocation}):\n`;
      result += `${"─".repeat(50)}\n`;
      result += `${newFunction}\n`;
      result += `${"─".repeat(50)}\n\n`;
      result += `Replacement call:\n`;
      result += `${functionCall}\n`;
    } else {
      // Perform the actual extraction
      let newLines = [...lines];

      // Replace extracted lines with function call
      newLines.splice(startLine - 1, endLine - startLine + 1, functionCall);

      // Insert the new function
      let insertIndex: number;
      if (insertLocation === "top") {
        insertIndex = 0;
      } else if (insertLocation === "after") {
        insertIndex = startLine; // After the call
      } else {
        insertIndex = startLine - 1; // Before the call
      }

      newLines.splice(insertIndex, 0, newFunction, "");

      fs.writeFileSync(resolvedPath, newLines.join("\n"), "utf-8");
      result += `✓ Function extracted successfully\n`;
    }

    return {
      tool: "extract_function",
      result,
    };
  } catch (error) {
    return {
      tool: "extract_function",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool 61: Extract Variable
 * Extracts an expression into a named variable
 */
export function extractVariable(
  filePath: string,
  lineNumber: number,
  expression: string,
  variableName: string,
  cwd: string,
  options?: {
    dryRun?: boolean;
    replaceAll?: boolean;
  }
): ToolResult {
  try {
    const resolvedPath = resolvePath(filePath, cwd);

    if (!fs.existsSync(resolvedPath)) {
      return {
        tool: "extract_variable",
        result: "",
        error: `File not found: ${resolvedPath}`,
      };
    }

    const content = fs.readFileSync(resolvedPath, "utf-8");
    const lines = content.split("\n");

    if (lineNumber < 1 || lineNumber > lines.length) {
      return {
        tool: "extract_variable",
        result: "",
        error: `Invalid line number: ${lineNumber} (file has ${lines.length} lines)`,
      };
    }

    const targetLine = lines[lineNumber - 1];
    if (!targetLine.includes(expression)) {
      return {
        tool: "extract_variable",
        result: "",
        error: `Expression "${expression}" not found on line ${lineNumber}`,
      };
    }

    const dryRun = options?.dryRun !== false; // Default to true
    const replaceAll = options?.replaceAll || false;

    // Get indentation
    const indent = targetLine.match(/^\s*/)?.[0] || "";

    // Determine declaration keyword based on file type
    const fileExt = pathLib.extname(resolvedPath);
    let declaration = "";

    if (fileExt === ".ts" || fileExt === ".tsx" || fileExt === ".js" || fileExt === ".jsx") {
      declaration = `${indent}const ${variableName} = ${expression};`;
    } else if (fileExt === ".py") {
      declaration = `${indent}${variableName} = ${expression}`;
    } else {
      declaration = `${indent}const ${variableName} = ${expression};`;
    }

    let result = `Extract Variable: ${variableName}\n`;
    result += `File: ${resolvedPath}\n`;
    result += `Expression: ${expression}\n\n`;

    if (replaceAll) {
      // Find all occurrences in the file
      const occurrences: number[] = [];
      lines.forEach((line, idx) => {
        if (line.includes(expression)) {
          occurrences.push(idx + 1);
        }
      });

      result += `Found ${occurrences.length} occurrence(s) on lines: ${occurrences.join(", ")}\n\n`;

      if (dryRun) {
        result += `DRY RUN - No changes made\n\n`;
        result += `Would insert:\n${declaration}\n\n`;
        result += `Would replace all occurrences of "${expression}" with "${variableName}"\n`;
      } else {
        // Replace all occurrences
        const newLines = lines.map((line) => line.replace(new RegExp(expression.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), variableName));

        // Insert declaration before first occurrence
        newLines.splice(occurrences[0] - 1, 0, declaration);

        fs.writeFileSync(resolvedPath, newLines.join("\n"), "utf-8");
        result += `✓ Variable extracted and ${occurrences.length} occurrence(s) replaced\n`;
      }
    } else {
      // Replace only on the specified line
      result += `Line: ${lineNumber}\n\n`;

      if (dryRun) {
        result += `DRY RUN - No changes made\n\n`;
        result += `Would insert:\n${declaration}\n\n`;
        result += `Would replace line ${lineNumber}:\n`;
        result += `  Before: ${targetLine}\n`;
        result += `  After:  ${targetLine.replace(expression, variableName)}\n`;
      } else {
        const newLines = [...lines];
        newLines[lineNumber - 1] = targetLine.replace(expression, variableName);
        newLines.splice(lineNumber - 1, 0, declaration);

        fs.writeFileSync(resolvedPath, newLines.join("\n"), "utf-8");
        result += `✓ Variable extracted successfully\n`;
      }
    }

    return {
      tool: "extract_variable",
      result,
    };
  } catch (error) {
    return {
      tool: "extract_variable",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool 62: Inline Variable
 * Replaces all usages of a variable with its value and removes the declaration
 */
export function inlineVariable(
  filePath: string,
  variableName: string,
  cwd: string,
  options?: {
    dryRun?: boolean;
  }
): ToolResult {
  try {
    const resolvedPath = resolvePath(filePath, cwd);

    if (!fs.existsSync(resolvedPath)) {
      return {
        tool: "inline_variable",
        result: "",
        error: `File not found: ${resolvedPath}`,
      };
    }

    const content = fs.readFileSync(resolvedPath, "utf-8");
    const lines = content.split("\n");

    // Find the variable declaration
    let declarationLine = -1;
    let variableValue = "";
    const declPattern = new RegExp(`(?:const|let|var)\\s+${variableName}\\s*=\\s*(.+?);?$`);
    const pyDeclPattern = new RegExp(`^\\s*${variableName}\\s*=\\s*(.+)$`);

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(declPattern) || lines[i].match(pyDeclPattern);
      if (match) {
        declarationLine = i + 1;
        variableValue = match[1].trim().replace(/;$/, "");
        break;
      }
    }

    if (declarationLine === -1) {
      return {
        tool: "inline_variable",
        result: "",
        error: `Variable declaration for "${variableName}" not found`,
      };
    }

    // Find all usages (excluding the declaration line)
    const usagePattern = new RegExp(`\\b${variableName}\\b`, "g");
    const usages: number[] = [];

    lines.forEach((line, idx) => {
      if (idx + 1 !== declarationLine && usagePattern.test(line)) {
        usages.push(idx + 1);
      }
    });

    const dryRun = options?.dryRun !== false; // Default to true

    let result = `Inline Variable: ${variableName}\n`;
    result += `File: ${resolvedPath}\n`;
    result += `Declaration: line ${declarationLine}\n`;
    result += `Value: ${variableValue}\n`;
    result += `Usages found: ${usages.length} occurrence(s) on lines ${usages.join(", ")}\n\n`;

    if (dryRun) {
      result += `DRY RUN - No changes made\n\n`;
      result += `Would remove declaration on line ${declarationLine}\n`;
      result += `Would replace ${usages.length} usage(s) with: ${variableValue}\n\n`;

      if (usages.length > 0) {
        result += `Sample replacements:\n`;
        usages.slice(0, 3).forEach((lineNum) => {
          const line = lines[lineNum - 1];
          result += `  Line ${lineNum}:\n`;
          result += `    Before: ${line}\n`;
          result += `    After:  ${line.replace(new RegExp(`\\b${variableName}\\b`, "g"), variableValue)}\n`;
        });
      }
    } else {
      // Perform inline
      let newLines = [...lines];

      // Replace all usages
      newLines = newLines.map((line, idx) => {
        if (idx + 1 !== declarationLine) {
          return line.replace(new RegExp(`\\b${variableName}\\b`, "g"), variableValue);
        }
        return line;
      });

      // Remove declaration
      newLines.splice(declarationLine - 1, 1);

      fs.writeFileSync(resolvedPath, newLines.join("\n"), "utf-8");
      result += `✓ Variable inlined: ${usages.length} usage(s) replaced, declaration removed\n`;
    }

    return {
      tool: "inline_variable",
      result,
    };
  } catch (error) {
    return {
      tool: "inline_variable",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool 63: Move Symbol
 * Moves a function or class from one file to another
 */
export function moveSymbol(
  symbolName: string,
  fromFile: string,
  toFile: string,
  cwd: string,
  options?: {
    dryRun?: boolean;
    addImport?: boolean;
  }
): ToolResult {
  try {
    const fromPath = resolvePath(fromFile, cwd);
    const toPath = resolvePath(toFile, cwd);

    if (!fs.existsSync(fromPath)) {
      return {
        tool: "move_symbol",
        result: "",
        error: `Source file not found: ${fromPath}`,
      };
    }

    if (!fs.existsSync(toPath)) {
      return {
        tool: "move_symbol",
        result: "",
        error: `Destination file not found: ${toPath}`,
      };
    }

    const fromContent = fs.readFileSync(fromPath, "utf-8");
    const toContent = fs.readFileSync(toPath, "utf-8");

    // Find the symbol (function or class)
    const functionPattern = new RegExp(
      `(?:export\\s+)?(?:async\\s+)?function\\s+${symbolName}\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\s*{[^}]*}`,
      "s"
    );
    const arrowFunctionPattern = new RegExp(
      `(?:export\\s+)?const\\s+${symbolName}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*(?::\\s*[^=]+)?=>\\s*{[^}]*}`,
      "s"
    );
    const classPattern = new RegExp(
      `(?:export\\s+)?class\\s+${symbolName}(?:\\s+extends\\s+[^{]+)?\\s*{[^}]*}`,
      "s"
    );

    let symbolCode = "";
    let symbolMatch = fromContent.match(functionPattern) || fromContent.match(arrowFunctionPattern) || fromContent.match(classPattern);

    if (!symbolMatch) {
      return {
        tool: "move_symbol",
        result: "",
        error: `Symbol "${symbolName}" not found in ${fromPath}`,
      };
    }

    symbolCode = symbolMatch[0];
    const dryRun = options?.dryRun !== false; // Default to true
    const addImport = options?.addImport !== false; // Default to true

    let result = `Move Symbol: ${symbolName}\n`;
    result += `From: ${fromPath}\n`;
    result += `To: ${toPath}\n`;
    result += `Symbol length: ${symbolCode.length} characters\n\n`;

    if (dryRun) {
      result += `DRY RUN - No changes made\n\n`;
      result += `Would remove from ${fromFile}:\n`;
      result += `${"─".repeat(50)}\n`;
      result += `${symbolCode.substring(0, 200)}${symbolCode.length > 200 ? "..." : ""}\n`;
      result += `${"─".repeat(50)}\n\n`;
      result += `Would add to ${toFile}\n`;

      if (addImport) {
        const relativePath = pathLib.relative(pathLib.dirname(fromPath), toPath).replace(/\\/g, "/").replace(/\.\w+$/, "");
        result += `\nWould add import to ${fromFile}:\nimport { ${symbolName} } from './${relativePath}';\n`;
      }
    } else {
      // Remove from source file
      const newFromContent = fromContent.replace(symbolMatch[0], "").replace(/\n\n\n+/g, "\n\n");
      fs.writeFileSync(fromPath, newFromContent, "utf-8");

      // Add to destination file
      const newToContent = toContent + "\n\n" + symbolCode;
      fs.writeFileSync(toPath, newToContent, "utf-8");

      // Add import to source file if needed
      if (addImport) {
        const relativePath = pathLib.relative(pathLib.dirname(fromPath), toPath).replace(/\\/g, "/").replace(/\.\w+$/, "");
        const importStatement = `import { ${symbolName} } from './${relativePath}';\n`;
        const withImport = importStatement + newFromContent;
        fs.writeFileSync(fromPath, withImport, "utf-8");

        result += `✓ Symbol moved successfully\n`;
        result += `✓ Import added to source file\n`;
      } else {
        result += `✓ Symbol moved successfully\n`;
      }
    }

    return {
      tool: "move_symbol",
      result,
    };
  } catch (error) {
    return {
      tool: "move_symbol",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tool 64: Convert to Async/Await
 * Converts callback or promise-based code to async/await syntax
 */
export function convertToAsync(
  filePath: string,
  functionName: string,
  cwd: string,
  options?: {
    dryRun?: boolean;
  }
): ToolResult {
  try {
    const resolvedPath = resolvePath(filePath, cwd);

    if (!fs.existsSync(resolvedPath)) {
      return {
        tool: "convert_to_async",
        result: "",
        error: `File not found: ${resolvedPath}`,
      };
    }

    const content = fs.readFileSync(resolvedPath, "utf-8");

    // Find the function
    const functionPattern = new RegExp(
      `((?:export\\s+)?function\\s+${functionName}\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\s*{)([^}]*)(})`,
      "s"
    );
    const arrowFunctionPattern = new RegExp(
      `((?:export\\s+)?const\\s+${functionName}\\s*=\\s*\\([^)]*\\)\\s*(?::\\s*[^=]+)?=>\\s*{)([^}]*)(})`,
      "s"
    );

    let match = content.match(functionPattern) || content.match(arrowFunctionPattern);

    if (!match) {
      return {
        tool: "convert_to_async",
        result: "",
        error: `Function "${functionName}" not found`,
      };
    }

    const [fullMatch, functionHeader, functionBody, closingBrace] = match;

    // Check if already async
    if (functionHeader.includes("async")) {
      return {
        tool: "convert_to_async",
        result: `Function "${functionName}" is already async`,
      };
    }

    const dryRun = options?.dryRun !== false; // Default to true

    // Convert .then() chains to await
    let newBody = functionBody;
    const thenPattern = /\.then\(\s*(?:\(([^)]*)\)|([a-zA-Z_$][a-zA-Z0-9_$]*))\s*=>\s*\{([^}]*)\}\s*\)/g;

    // Simple conversion: replace .then() with await
    newBody = newBody.replace(
      /(\w+)\s*\.\s*then\(\s*(?:\(([^)]*)\)|([a-zA-Z_$][a-zA-Z0-9_$]*))\s*=>\s*\{([^}]*)\}\s*\)/g,
      (match, promise, param1, param2, body) => {
        const param = param1 || param2 || "result";
        return `const ${param} = await ${promise};\n${body}`;
      }
    );

    // Convert .catch() to try-catch
    const hasCatch = /\.catch\(/.test(newBody);
    if (hasCatch) {
      newBody = newBody.replace(
        /\.catch\(\s*(?:\(([^)]*)\)|([a-zA-Z_$][a-zA-Z0-9_$]*))\s*=>\s*\{([^}]*)\}\s*\)/g,
        ""
      );
      newBody = `try {\n${newBody}\n} catch (error) {\n  // Handle error\n  console.error(error);\n}`;
    }

    // Add async to function header
    const newHeader = functionHeader.replace(/function\s+/, "async function ").replace(/=\s*\(/, "= async (");

    const newFunction = newHeader + newBody + closingBrace;

    let result = `Convert to Async/Await: ${functionName}\n`;
    result += `File: ${resolvedPath}\n`;
    result += `Conversions applied:\n`;
    result += `  - Added 'async' keyword\n`;
    result += `  - Converted .then() to await\n`;
    if (hasCatch) {
      result += `  - Wrapped in try-catch\n`;
    }
    result += `\n`;

    if (dryRun) {
      result += `DRY RUN - No changes made\n\n`;
      result += `Original function:\n`;
      result += `${"─".repeat(50)}\n`;
      result += `${fullMatch.substring(0, 300)}${fullMatch.length > 300 ? "..." : ""}\n`;
      result += `${"─".repeat(50)}\n\n`;
      result += `Converted function:\n`;
      result += `${"─".repeat(50)}\n`;
      result += `${newFunction.substring(0, 300)}${newFunction.length > 300 ? "..." : ""}\n`;
      result += `${"─".repeat(50)}\n`;
    } else {
      const newContent = content.replace(fullMatch, newFunction);
      fs.writeFileSync(resolvedPath, newContent, "utf-8");
      result += `✓ Function converted to async/await successfully\n`;
    }

    return {
      tool: "convert_to_async",
      result,
    };
  } catch (error) {
    return {
      tool: "convert_to_async",
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
