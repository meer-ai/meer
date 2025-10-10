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
 * Tool: Read a file from the project
 */
export function readFile(filepath: string, cwd: string): ToolResult {
  try {
    const fullPath = join(cwd, filepath);

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
    const fullPath = dirpath ? join(cwd, dirpath) : cwd;

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
  const fullPath = join(cwd, filepath);
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
    const fullPath = join(cwd, edit.path);
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
  console.log(chalk.gray(`  🚀 Running: ${command}`));

  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let didTimeout = false;

    const timeoutMs = options?.timeoutMs ?? 0;
    const timeoutHandle =
      timeoutMs > 0
        ? setTimeout(() => {
            didTimeout = true;
            console.log(
              chalk.yellow(
                `  ⏰ Command timed out after ${timeoutMs / 1000}s, sending SIGTERM...`
              )
            );
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
          }, timeoutMs)
        : null;

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdoutBuffer += text;
      process.stdout.write(text);
    });

    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuffer += text;
      process.stderr.write(text);
    });

    const finalize = (result: ToolResult) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
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
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      if (didTimeout) {
        finalize({
          tool: "run_command",
          result: stdoutBuffer,
          error: `Command timed out after ${timeoutMs}ms`,
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
      const fullPath = join(cwd, filePath);

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
        const fullPath = join(cwd, file);
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
    const fullPath = join(cwd, filepath);

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
  const fullPath = join(cwd, filepath);

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

    const fullPath = join(cwd, folderPath);
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
