import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "fs";
import { join, relative, dirname } from "path";
import chalk from "chalk";
import { execSync } from "child_process";
import { glob } from "glob";

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
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  // Simple two-pointer diff with minimal lookahead to detect inserts/deletes.
  // Produces unified diff-style hunks with a few context lines.
  const contextSize = 3;
  const output: string[] = [];

  let i = 0; // index in oldLines
  let j = 0; // index in newLines

  const hunks: Array<{
    oldStart: number;
    newStart: number;
    oldCount: number;
    newCount: number;
    lines: string[]; // prefixed with ' ', '+', '-'
  }> = [];

  function startHunk(oldStart: number, newStart: number) {
    hunks.push({ oldStart, newStart, oldCount: 0, newCount: 0, lines: [] });
  }

  function addContextLines(startOld: number, startNew: number, count: number) {
    if (count <= 0) return;
    const h = hunks[hunks.length - 1];
    for (let k = 0; k < count; k++) {
      const line = oldLines[startOld + k] ?? "";
      h.lines.push(` ${line}`);
      h.oldCount++;
      h.newCount++;
    }
    i = startOld + count;
    j = startNew + count;
  }

  // Helper to append a change line to the current hunk
  function pushChange(prefix: "+" | "-" | " ", line: string) {
    const h = hunks[hunks.length - 1];
    h.lines.push(`${prefix} ${line}`);
    if (prefix === "+") h.newCount++;
    else if (prefix === "-") h.oldCount++;
    else {
      h.newCount++;
      h.oldCount++;
    }
  }

  // Pre-compute equal blocks to know when to close hunks with trailing context
  const equalBlocks: Array<{
    oldIndex: number;
    newIndex: number;
    length: number;
  }> = [];
  {
    let a = 0,
      b = 0;
    while (a < oldLines.length && b < newLines.length) {
      if (oldLines[a] === newLines[b]) {
        const startA = a,
          startB = b;
        let len = 0;
        while (
          a < oldLines.length &&
          b < newLines.length &&
          oldLines[a] === newLines[b]
        ) {
          a++;
          b++;
          len++;
        }
        equalBlocks.push({ oldIndex: startA, newIndex: startB, length: len });
      } else {
        // Advance using simple lookahead
        const nextDel = oldLines[a + 1] === newLines[b];
        const nextIns = oldLines[a] === newLines[b + 1];
        if (nextDel) a++;
        else if (nextIns) b++;
        else {
          a++;
          b++;
        }
      }
    }
  }

  let equalIdx = 0;
  while (i < oldLines.length || j < newLines.length) {
    const equal = equalBlocks[equalIdx];
    const atEqual = equal && i === equal.oldIndex && j === equal.newIndex;

    if (atEqual) {
      // Large equal block: emit as context, but split hunks when necessary
      if (hunks.length > 0 && equal.length > contextSize * 2) {
        // Trailing context for the previous hunk
        const trailing = Math.min(contextSize, equal.length);
        addContextLines(i, j, trailing);
        // Skip middle of equal block
        i += equal.length - trailing;
        j += equal.length - trailing;
      } else {
        // Either no open hunk or small equal block: include all as context in hunk if exists
        if (hunks.length === 0) {
          // No hunk open, just advance (we only show context inside hunks)
          i += equal.length;
          j += equal.length;
        } else {
          addContextLines(i, j, equal.length);
        }
      }
      equalIdx++;
      continue;
    }

    // We are in a changed region; open a hunk if needed with leading context
    if (
      hunks.length === 0 ||
      (hunks[hunks.length - 1].lines.length > 0 &&
        hunks[hunks.length - 1].lines[
          hunks[hunks.length - 1].lines.length - 1
        ].startsWith(" "))
    ) {
      // Compute hunk header starts with some leading context
      const oldStart = Math.max(0, i - contextSize) + 1; // 1-based
      const newStart = Math.max(0, j - contextSize) + 1; // 1-based
      startHunk(oldStart, newStart);
      // Add leading context lines
      const lead = Math.min(contextSize, Math.min(i, j));
      if (lead > 0) {
        const startOld = i - lead;
        const startNew = j - lead;
        addContextLines(startOld, startNew, lead);
      }
    }

    // Decide the type of change using one-line lookahead
    const delNext =
      i < oldLines.length &&
      j < newLines.length &&
      oldLines[i + 1] === newLines[j];
    const insNext =
      i < oldLines.length &&
      j < newLines.length &&
      oldLines[i] === newLines[j + 1];

    if (i < oldLines.length && (j >= newLines.length || delNext)) {
      pushChange("-", oldLines[i] ?? "");
      i++;
      continue;
    }
    if (j < newLines.length && (i >= oldLines.length || insNext)) {
      pushChange("+", newLines[j] ?? "");
      j++;
      continue;
    }

    // Treat as modification (replace)
    if (i < oldLines.length) {
      pushChange("-", oldLines[i] ?? "");
    }
    if (j < newLines.length) {
      pushChange("+", newLines[j] ?? "");
    }
    i++;
    j++;
  }

  // Format hunks
  for (const h of hunks) {
    output.push(
      chalk.gray(
        `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`
      )
    );
    for (const line of h.lines) {
      if (line.startsWith("+")) output.push(chalk.green(line));
      else if (line.startsWith("-")) output.push(chalk.red(line));
      else output.push(chalk.gray(line));
    }
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
export function runCommand(command: string, cwd: string): ToolResult {
  try {
    console.log(chalk.gray(`  🚀 Running: ${command}`));
    const result = execSync(command, {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    });

    return {
      tool: "run_command",
      result: `Command executed successfully:\n${result}`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      tool: "run_command",
      result: "",
      error: `Command failed: ${errorMessage}`,
    };
  }
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
    const globOptions = {
      cwd,
      ignore: options.excludePattern
        ? [options.excludePattern]
        : ["node_modules/**", ".git/**", "dist/**", "build/**"],
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
    const files = glob.sync(searchPattern, {
      cwd,
      ignore: ["node_modules/**", ".git/**", "dist/**", "build/**"],
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
