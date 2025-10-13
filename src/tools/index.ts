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
import { join, relative, dirname } from "path";
import chalk from "chalk";
import { spawn, execSync } from "child_process";
import { glob } from "glob";
import { ProjectContextManager } from "../context/manager.js";
import { diffLines } from "diff";

export interface ToolResult {
  tool: string;
  result: string;
  error?: string;
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
 * Tool: Google Search for research and documentation
 */
export function googleSearch(
  query: string,
  options: {
    maxResults?: number;
    site?: string;
  } = {}
): ToolResult {
  try {
    console.log(chalk.gray(`  🌐 Searching Google for: "${query}"`));

    // Note: This is a placeholder implementation
    // In a real implementation, you would use Google's Custom Search API
    // or a web scraping approach (with proper rate limiting and respect for robots.txt)

    const searchUrl = options.site
      ? `https://www.google.com/search?q=site:${
          options.site
        } ${encodeURIComponent(query)}`
      : `https://www.google.com/search?q=${encodeURIComponent(query)}`;

    return {
      tool: "google_search",
      result: `Google Search Results for "${query}":\n\n🔗 Search URL: ${searchUrl}\n\nNote: This is a placeholder implementation. In a real CLI, you would:\n1. Use Google Custom Search API with proper API key\n2. Parse and return actual search results\n3. Include snippets, titles, and URLs\n4. Handle rate limiting and API quotas\n\nFor now, you can manually visit the URL above to see results.`,
    };
  } catch (error) {
    return {
      tool: "google_search",
      result: "",
      error: error instanceof Error ? error.message : String(error),
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
      const branchName = line.replace("*", "").trim();

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
 * Interface for a task in the plan
 */
export interface PlanTask {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "skipped";
  notes?: string;
}

/**
 * Interface for the plan
 */
export interface Plan {
  title: string;
  tasks: PlanTask[];
  createdAt: number;
  updatedAt: number;
}

// In-memory storage for the current plan
let currentPlan: Plan | null = null;

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
    currentPlan = {
      title,
      tasks: tasks.map((task, index) => ({
        id: `task-${index + 1}`,
        description: task.description,
        status: "pending",
      })),
      createdAt: now,
      updatedAt: now,
    };

    // Format output
    const output = [
      chalk.bold.blue(`\n📋 Plan Created: ${title}`),
      "",
      ...currentPlan.tasks.map((task, index) => {
        const statusIcon = "⏳";
        return `  ${chalk.gray(`${index + 1}.`)} ${statusIcon} ${task.description}`;
      }),
      "",
      chalk.gray(`Total tasks: ${currentPlan.tasks.length}`),
    ].join("\n");

    return {
      tool: "set_plan",
      result: output,
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
    if (!currentPlan) {
      return {
        tool: "update_plan_task",
        result: "",
        error: "No active plan. Use set_plan to create a plan first.",
      };
    }

    const task = currentPlan.tasks.find((t) => t.id === taskId);
    if (!task) {
      return {
        tool: "update_plan_task",
        result: "",
        error: `Task ${taskId} not found in the plan.`,
      };
    }

    task.status = status;
    if (notes) {
      task.notes = notes;
    }
    currentPlan.updatedAt = Date.now();

    // Format output
    const statusIcon =
      status === "completed"
        ? "✅"
        : status === "in_progress"
        ? "🔄"
        : status === "skipped"
        ? "⏭️"
        : "⏳";

    const output = [
      chalk.bold.blue(`\n📋 Plan Updated: ${currentPlan.title}`),
      "",
      ...currentPlan.tasks.map((t, index) => {
        const icon =
          t.status === "completed"
            ? "✅"
            : t.status === "in_progress"
            ? "🔄"
            : t.status === "skipped"
            ? "⏭️"
            : "⏳";
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
        `Progress: ${currentPlan.tasks.filter((t) => t.status === "completed").length}/${currentPlan.tasks.length} tasks completed`
      ),
    ].join("\n");

    return {
      tool: "update_plan_task",
      result: output,
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
    if (!currentPlan) {
      return {
        tool: "show_plan",
        result: "No active plan.",
      };
    }

    const output = [
      chalk.bold.blue(`\n📋 Current Plan: ${currentPlan.title}`),
      "",
      ...currentPlan.tasks.map((task, index) => {
        const icon =
          task.status === "completed"
            ? "✅"
            : task.status === "in_progress"
            ? "🔄"
            : task.status === "skipped"
            ? "⏭️"
            : "⏳";
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
        `Progress: ${currentPlan.tasks.filter((t) => t.status === "completed").length}/${currentPlan.tasks.length} tasks completed`
      ),
    ].join("\n");

    return {
      tool: "show_plan",
      result: output,
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
    if (!currentPlan) {
      return {
        tool: "clear_plan",
        result: "No active plan to clear.",
      };
    }

    const title = currentPlan.title;
    currentPlan = null;

    return {
      tool: "clear_plan",
      result: chalk.green(`✓ Plan "${title}" has been cleared.`),
    };
  } catch (error) {
    return {
      tool: "clear_plan",
      result: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
