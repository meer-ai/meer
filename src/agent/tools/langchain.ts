import {
  DynamicStructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";
import { z } from "zod";
import type { FileEdit, ToolResult } from "../../tools/index.js";
import * as tools from "../../tools/index.js";
import type { Provider } from "../../providers/base.js";
import type { MCPTool } from "../../mcp/types.js";
export interface MeerLangChainToolContext {
  cwd: string;
  provider?: Provider;
  /**
   * Required for tools that generate FileEdit payloads (propose_edit, edit_line).
   */
  reviewFileEdit?: (edit: FileEdit) => Promise<boolean>;
  /**
   * Execute an MCP tool when available.
   */
  executeMcpTool?: (
    toolName: string,
    input: Record<string, unknown>
  ) => Promise<string>;
  /**
   * Ask the user before running shell commands.
   */
  confirmCommand?: (command: string) => Promise<boolean>;
}

export interface MeerLangChainToolOptions {
  mcpTools?: MCPTool[];
}

type ToolExecutor<TInput> = (
  input: TInput,
  context: MeerLangChainToolContext
) => Promise<string>;

interface ToolDefinition<TSchema extends z.ZodTypeAny> {
  name: string;
  description: string;
  schema: TSchema;
  execute: ToolExecutor<z.infer<TSchema>>;
}

const FALLBACK_SCHEMA = z.object({}).catchall(z.any());

function jsonSchemaToZod(schema?: MCPTool["inputSchema"]): z.ZodTypeAny {
  if (!schema) {
    return FALLBACK_SCHEMA;
  }

  const required = new Set(schema.required ?? []);

  const convert = (node: any): z.ZodTypeAny => {
    if (!node || typeof node !== "object") {
      return z.any();
    }

    switch (node.type) {
      case "string":
        return z.string();
      case "number":
        return z.number();
      case "integer":
        return z.number().int();
      case "boolean":
        return z.boolean();
      case "array": {
        if (node.items) {
          return z.array(convert(node.items));
        }
        return z.array(z.any());
      }
      case "object": {
        const properties = node.properties ?? {};
        const shape: Record<string, z.ZodTypeAny> = {};
        for (const [key, value] of Object.entries(properties)) {
          const propertySchema = convert(value);
          shape[key] = required.has(key)
            ? propertySchema
            : propertySchema.optional();
        }
        return z.object(shape).passthrough();
      }
      default:
        return z.any();
    }
  };

  const root = convert(schema);
  return root instanceof z.ZodObject ? root.passthrough() : root;
}

function unwrap(result: ToolResult): string {
  if (result.error) {
    throw new Error(result.error);
  }
  return result.result ?? "";
}

async function ensureEditApproval(
  context: MeerLangChainToolContext,
  edit: FileEdit
): Promise<boolean> {
  if (!context.reviewFileEdit) {
    throw new Error(
      "reviewFileEdit callback is required to execute editing tools safely."
    );
  }
  return context.reviewFileEdit(edit);
}

async function ensureCommandApproval(
  context: MeerLangChainToolContext,
  command: string
): Promise<boolean> {
  if (!context.confirmCommand) {
    return true;
  }
  return context.confirmCommand(command);
}
async function callMeerTool(
  name: string,
  input: Record<string, unknown>,
  context: MeerLangChainToolContext
): Promise<string> {
  switch (name) {
    case "analyze_project": {
      return unwrap(tools.analyzeProject(context.cwd));
    }
    case "read_file": {
      return unwrap(tools.readFile(String(input.path), context.cwd));
    }
    case "list_files": {
      const rawPath = input.path;
      const path =
        typeof rawPath === "string" && rawPath.trim().length > 0
          ? rawPath
          : ".";
      return unwrap(tools.listFiles(path, context.cwd));
    }
    case "propose_edit": {
      const path = String(input.path);
      const contents = String(input.contents ?? input.content ?? "");
      const description =
        typeof input.description === "string"
          ? input.description
          : "Edit file";
      const edit = tools.proposeEdit(path, contents, description, context.cwd);
      if (!(await ensureEditApproval(context, edit))) {
        return `⏭️ Edit skipped for ${edit.path}`;
      }
      return unwrap(tools.applyEdit(edit, context.cwd));
    }
    case "run_command": {
      const rawCommand = input.command;
      const command = typeof rawCommand === "string" ? rawCommand.trim() : "";
      if (!command) {
        throw new Error("run_command requires a command string.");
      }
      if (!(await ensureCommandApproval(context, command))) {
        return `⚠️ Command cancelled: ${command}`;
      }
      const timeoutMs =
        input.timeoutMs !== undefined ? Number(input.timeoutMs) : undefined;
      const result = await tools.runCommand(command, context.cwd, {
        timeoutMs,
      });
      return unwrap(result);
    }
    case "find_files": {
      const pattern = String(input.pattern ?? "*");
      const fileTypesInput = input.fileTypes;
      const fileTypes =
        typeof fileTypesInput === "string"
          ? fileTypesInput
              .split(",")
              .map((f) => f.trim())
              .filter(Boolean)
          : Array.isArray(fileTypesInput)
          ? fileTypesInput.map((f) => String(f))
          : undefined;
      const includePattern =
        typeof input.includePattern === "string" ? input.includePattern : undefined;
      const excludePattern =
        typeof input.excludePattern === "string" ? input.excludePattern : undefined;
      const maxDepth =
        input.maxDepth !== undefined ? Number(input.maxDepth) : undefined;
      return unwrap(
        tools.findFiles(pattern, context.cwd, {
          includePattern,
          excludePattern,
          fileTypes,
          maxDepth,
        })
      );
    }
    case "read_many_files": {
      const filesInput = input.files;
      const files =
        typeof filesInput === "string"
          ? filesInput.split(",").map((f) => f.trim()).filter(Boolean)
          : Array.isArray(filesInput)
          ? filesInput.map((f) => String(f))
          : [];
      const maxFiles =
        input.maxFiles !== undefined ? Number(input.maxFiles) : undefined;
      return unwrap(
        tools.readManyFiles(files, context.cwd, maxFiles ?? 10)
      );
    }
    case "search_text": {
      const term = String(input.term);
      const filePattern =
        typeof input.filePattern === "string" ? input.filePattern : undefined;
      const includePattern =
        typeof input.includePattern === "string" ? input.includePattern : undefined;
      const excludePattern =
        typeof input.excludePattern === "string" ? input.excludePattern : undefined;
      const caseSensitive =
        input.caseSensitive !== undefined
          ? Boolean(input.caseSensitive)
          : undefined;
      const wholeWord =
        input.wholeWord !== undefined ? Boolean(input.wholeWord) : undefined;
      return unwrap(
        tools.searchText(term, context.cwd, {
          filePattern,
          includePattern,
          excludePattern,
          caseSensitive,
          wholeWord,
        })
      );
    }
    case "read_folder": {
      const path = input.path ? String(input.path) : ".";
      const maxDepth =
        input.maxDepth !== undefined ? Number(input.maxDepth) : undefined;
      const includeStats =
        input.includeStats !== undefined ? Boolean(input.includeStats) : undefined;
      const fileTypesInput = input.fileTypes;
      const fileTypes =
        typeof fileTypesInput === "string"
          ? fileTypesInput.split(",").map((f) => f.trim()).filter(Boolean)
          : Array.isArray(fileTypesInput)
          ? fileTypesInput.map((f) => String(f))
          : undefined;
      return unwrap(
        tools.readFolder(path, context.cwd, {
          maxDepth,
          includeStats,
          fileTypes,
        })
      );
    }
    case "google_search": {
      const query = String(input.query);
      const maxResults =
        input.maxResults !== undefined ? Number(input.maxResults) : undefined;
      const site =
        typeof input.site === "string" ? input.site : undefined;
      return unwrap(
        tools.googleSearch(query, {
          maxResults,
          site,
        })
      );
    }
    case "web_fetch": {
      const url = String(input.url);
      const method =
        typeof input.method === "string" ? (input.method as any) : undefined;
      const headers =
        typeof input.headers === "object" && input.headers !== null
          ? (input.headers as Record<string, string>)
          : undefined;
      const saveTo =
        typeof input.saveTo === "string" ? input.saveTo : undefined;
      return unwrap(
        tools.webFetch(url, {
          method,
          headers,
          saveTo,
        })
      );
    }
    case "save_memory": {
      const key = String(input.key);
      const content = String(input.content ?? "");
      const category =
        typeof input.category === "string" ? input.category : undefined;
      const tagsInput = input.tags;
      const tags =
        typeof tagsInput === "string"
          ? tagsInput.split(",").map((t) => t.trim()).filter(Boolean)
          : Array.isArray(tagsInput)
          ? tagsInput.map((t) => String(t))
          : undefined;
      const expiresAt =
        typeof input.expiresAt === "string" ? new Date(input.expiresAt) : undefined;
      return unwrap(
        tools.saveMemory(key, content, context.cwd, {
          category,
          tags,
          expiresAt,
        })
      );
    }
    case "load_memory": {
      const key = String(input.key);
      return unwrap(tools.loadMemory(key, context.cwd));
    }
    case "scaffold_project": {
      const projectType = String(input.projectType ?? input.type ?? "").trim();
      const projectName = String(
        input.projectName ?? input.name ?? ""
      ).trim();
      if (!projectType || !projectName) {
        throw new Error(
          "scaffold_project requires both projectType and projectName."
        );
      }
      return unwrap(
        tools.scaffoldProject(projectType, projectName, context.cwd)
      );
    }
    case "suggest_setup": {
      const request = String(input.request ?? input.userRequest ?? "").trim();
      if (!request) {
        throw new Error("suggest_setup requires a non-empty request.");
      }
      const analysis = tools.analyzeProject(context.cwd);
      return unwrap(tools.suggestSetup(request, analysis));
    }
    case "semantic_search": {
      const query = String(input.query ?? input.term ?? "").trim();
      if (!query) {
        throw new Error("semantic_search requires a non-empty query.");
      }
      if (!context.provider || typeof context.provider.embed !== "function") {
        throw new Error(
          "semantic_search requires a provider with embedding support."
        );
      }
      const options = {
        limit:
          input.limit !== undefined && input.limit !== null
            ? Number(input.limit)
            : undefined,
        minScore:
          input.minScore !== undefined && input.minScore !== null
            ? Number(input.minScore)
            : undefined,
        filePattern:
          typeof input.filePattern === "string" ? input.filePattern : undefined,
        language:
          typeof input.language === "string" ? input.language : undefined,
        includeTests:
          input.includeTests !== undefined
            ? ["true", "1"].includes(String(input.includeTests).toLowerCase()) ||
              input.includeTests === true
            : undefined,
        embeddingModel:
          typeof input.embeddingModel === "string"
            ? input.embeddingModel
            : undefined,
      };
      const result = await tools.semanticSearch(
        query,
        context.cwd,
        context.provider,
        options
      );
      return unwrap(result);
    }
    case "grep": {
      const path = String(input.path ?? "");
      const pattern = String(input.pattern ?? "");
      const caseSensitive =
        input.caseSensitive !== undefined ? Boolean(input.caseSensitive) : undefined;
      const maxResults =
        input.maxResults !== undefined ? Number(input.maxResults) : undefined;
      const contextLines =
        input.contextLines !== undefined ? Number(input.contextLines) : undefined;
      return unwrap(
        tools.grep(path, pattern, context.cwd, {
          caseSensitive,
          maxResults,
          contextLines,
        })
      );
    }
    case "edit_line": {
      const path = String(input.path);
      const lineNumber = Number(input.lineNumber);
      const oldText = String(input.oldText ?? "");
      const newText = String(input.newText ?? "");
      const edit = tools.editLine(
        path,
        lineNumber,
        oldText,
        newText,
        context.cwd
      );
      if (!(await ensureEditApproval(context, edit))) {
        return `⏭️ Line edit skipped for ${edit.path}`;
      }
      return unwrap(tools.applyEdit(edit, context.cwd));
    }
    case "git_status": {
      return unwrap(tools.gitStatus(context.cwd));
    }
    case "git_diff": {
      const staged =
        input.staged !== undefined ? Boolean(input.staged) : undefined;
      const filepath =
        typeof input.filepath === "string" ? input.filepath : undefined;
      const unified =
        input.unified !== undefined ? Number(input.unified) : undefined;
      return unwrap(
        tools.gitDiff(context.cwd, {
          staged,
          filepath,
          unified,
        })
      );
    }
    case "git_log": {
      const maxCount =
        input.maxCount !== undefined ? Number(input.maxCount) : undefined;
      const author =
        typeof input.author === "string" ? input.author : undefined;
      const since =
        typeof input.since === "string" ? input.since : undefined;
      const until =
        typeof input.until === "string" ? input.until : undefined;
      const filepath =
        typeof input.filepath === "string" ? input.filepath : undefined;
      return unwrap(
        tools.gitLog(context.cwd, {
          maxCount,
          author,
          since,
          until,
          filepath,
        })
      );
    }
    case "git_commit": {
      const message = String(input.message);
      const addAll =
        input.addAll !== undefined ? Boolean(input.addAll) : undefined;
      const filesInput = input.files;
      const files =
        typeof filesInput === "string"
          ? filesInput.split(",").map((f) => f.trim()).filter(Boolean)
          : Array.isArray(filesInput)
          ? filesInput.map((f) => String(f))
          : undefined;
      return unwrap(
        tools.gitCommit(message, context.cwd, {
          addAll,
          files,
        })
      );
    }
    case "git_branch": {
      const list =
        input.list !== undefined ? Boolean(input.list) : undefined;
      const create =
        typeof input.create === "string" ? input.create : undefined;
      const switchTo =
        typeof input.switch === "string" ? input.switch : undefined;
      const deleteBranch =
        typeof input.delete === "string" ? input.delete : undefined;
      return unwrap(
        tools.gitBranch(context.cwd, {
          list,
          create,
          switch: switchTo,
          delete: deleteBranch,
        })
      );
    }
    case "write_file": {
      const path = String(input.path);
      const contents = String(input.contents ?? input.content ?? "");
      return unwrap(tools.writeFile(path, contents, context.cwd));
    }
    case "delete_file": {
      const path = String(input.path);
      return unwrap(tools.deleteFile(path, context.cwd));
    }
    case "move_file": {
      const source = String(input.source);
      const dest = String(input.dest);
      return unwrap(tools.moveFile(source, dest, context.cwd));
    }
    case "create_directory": {
      const path = String(input.path);
      return unwrap(tools.createDirectory(path, context.cwd));
    }
    case "package_install": {
      const packagesInput = input.packages;
      const packages =
        typeof packagesInput === "string"
          ? packagesInput.split(",").map((p) => p.trim()).filter(Boolean)
          : Array.isArray(packagesInput)
          ? packagesInput.map((p) => String(p))
          : [];
      const manager =
        typeof input.manager === "string"
          ? (input.manager as "npm" | "yarn" | "pnpm")
          : undefined;
      const dev =
        input.dev !== undefined ? Boolean(input.dev) : undefined;
      const globalInstall =
        input.global !== undefined ? Boolean(input.global) : undefined;
      return unwrap(
        tools.packageInstall(packages, context.cwd, {
          manager,
          dev,
          global: globalInstall,
        })
      );
    }
    case "package_run_script": {
      const script = String(input.script);
      const manager =
        typeof input.manager === "string"
          ? (input.manager as "npm" | "yarn" | "pnpm")
          : undefined;
      return unwrap(
        tools.packageRunScript(script, context.cwd, {
          manager,
        })
      );
    }
    case "package_list": {
      const outdated =
        input.outdated !== undefined ? Boolean(input.outdated) : undefined;
      return unwrap(
        tools.packageList(context.cwd, {
          outdated,
        })
      );
    }
    case "get_env": {
      const key = String(input.key);
      return unwrap(tools.getEnv(key, context.cwd));
    }
    case "set_env": {
      const key = String(input.key);
      const value = String(input.value ?? "");
      return unwrap(tools.setEnv(key, value, context.cwd));
    }
    case "list_env": {
      return unwrap(tools.listEnv(context.cwd));
    }
    case "http_request": {
      const url = String(input.url);
      const method =
        typeof input.method === "string" ? (input.method as any) : undefined;
      const headers =
        typeof input.headers === "object" && input.headers !== null
          ? (input.headers as Record<string, string>)
          : undefined;
      const body =
        typeof input.body === "string" ? input.body : undefined;
      const timeout =
        input.timeout !== undefined ? Number(input.timeout) : undefined;
      const result = await tools.httpRequest(url, {
        method,
        headers,
        body,
        timeout,
      });
      return unwrap(result);
    }
    case "get_file_outline": {
      const path = String(input.path);
      return unwrap(tools.getFileOutline(path, context.cwd));
    }
    case "find_symbol_definition": {
      const symbol = String(input.symbol);
      const filePattern =
        typeof input.filePattern === "string" ? input.filePattern : undefined;
      return unwrap(
        tools.findSymbolDefinition(symbol, context.cwd, {
          filePattern,
        })
      );
    }
    case "check_syntax": {
      const path = String(input.path);
      return unwrap(tools.checkSyntax(path, context.cwd));
    }
    case "validate_project": {
      return unwrap(tools.validateProject(context.cwd, input));
    }
    case "set_plan": {
      const title =
        typeof input.title === "string" ? input.title : "Task Plan";
      const tasksInput = input.tasks;
      const tasks =
        Array.isArray(tasksInput)
          ? tasksInput.map((task) =>
              typeof task === "object" && task !== null && "description" in task
                ? { description: String((task as any).description) }
                : { description: String(task) }
            )
          : typeof tasksInput === "string"
          ? tasksInput
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
              .map((description) => ({ description }))
          : [];
      return unwrap(tools.setPlan(title, tasks, context.cwd));
    }
    case "update_plan_task": {
      const taskId = String(input.taskId);
      const status = String(input.status ?? "pending") as
        | "pending"
        | "in_progress"
        | "completed"
        | "skipped";
      const notes =
        typeof input.notes === "string" ? input.notes : undefined;
      return unwrap(tools.updatePlanTask(taskId, status, notes));
    }
    case "show_plan": {
      return unwrap(tools.showPlan());
    }
    case "clear_plan": {
      return unwrap(tools.clearPlan());
    }
    case "explain_code": {
      const path = String(input.path);
      const startLine =
        input.startLine !== undefined ? Number(input.startLine) : undefined;
      const endLine =
        input.endLine !== undefined ? Number(input.endLine) : undefined;
      const focusSymbol =
        typeof input.focusSymbol === "string" ? input.focusSymbol : undefined;
      return unwrap(
        tools.explainCode(path, context.cwd, {
          startLine,
          endLine,
          focusSymbol,
        })
      );
    }
    case "generate_docstring": {
      const path = String(input.path);
      return unwrap(tools.generateDocstring(path, context.cwd, input));
    }
    case "format_code": {
      const path = String(input.path);
      return unwrap(tools.formatCode(path, context.cwd, input));
    }
    case "dependency_audit": {
      return unwrap(tools.dependencyAudit(context.cwd, input));
    }
    case "run_tests": {
      return unwrap(tools.runTests(context.cwd, input));
    }
    case "generate_tests": {
      const path = String(input.path ?? "");
      return unwrap(tools.generateTests(path, context.cwd, input));
    }
    case "security_scan": {
      const path = String(input.path ?? "");
      return unwrap(tools.securityScan(path, context.cwd, input));
    }
    case "code_review": {
      const path = String(input.path ?? "");
      return unwrap(tools.codeReview(path, context.cwd, input));
    }
    case "generate_readme": {
      return unwrap(tools.generateReadme(context.cwd, input));
    }
    case "fix_lint": {
      const path = String(input.path ?? "");
      return unwrap(tools.fixLint(path, context.cwd, input));
    }
    case "organize_imports": {
      const path = String(input.path ?? "");
      return unwrap(tools.organizeImports(path, context.cwd, input));
    }
    case "check_complexity": {
      const path = String(input.path ?? "");
      return unwrap(tools.checkComplexity(path, context.cwd, input));
    }
    case "detect_smells": {
      const path = String(input.path ?? "");
      return unwrap(tools.detectSmells(path, context.cwd, input));
    }
    case "analyze_coverage": {
      return unwrap(tools.analyzeCoverage(context.cwd, input));
    }
    case "find_references": {
      const symbol = String(input.symbol);
      return unwrap(tools.findReferences(symbol, context.cwd, input));
    }
    case "generate_test_suite": {
      const path = String(input.path ?? "");
      return unwrap(tools.generateTestSuite(path, context.cwd, input));
    }
    case "generate_mocks": {
      const path = String(input.path ?? "");
      return unwrap(tools.generateMocks(path, context.cwd, input));
    }
    case "generate_api_docs": {
      const path = String(input.path ?? "");
      return unwrap(tools.generateApiDocs(path, context.cwd, input));
    }
    case "git_blame": {
      const path = String(input.path);
      return unwrap(tools.gitBlame(path, context.cwd, input));
    }
    case "rename_symbol": {
      const oldName = String(input.oldName);
      const newName = String(input.newName);
      return unwrap(
        tools.renameSymbol(oldName, newName, context.cwd, input)
      );
    }
    case "extract_function": {
      const filePath = String(input.filePath);
      const startLine = Number(input.startLine);
      const endLine = Number(input.endLine);
      const functionName = String(input.functionName);
      return unwrap(
        tools.extractFunction(
          filePath,
          startLine,
          endLine,
          functionName,
          context.cwd,
          input
        )
      );
    }
    case "extract_variable": {
      const filePath = String(input.filePath);
      const lineNumber = Number(input.lineNumber);
      const expression = String(input.expression);
      const variableName = String(input.variableName);
      return unwrap(
        tools.extractVariable(
          filePath,
          lineNumber,
          expression,
          variableName,
          context.cwd,
          input
        )
      );
    }
    case "inline_variable": {
      const filePath = String(input.filePath);
      const variableName = String(input.variableName);
      return unwrap(
        tools.inlineVariable(filePath, variableName, context.cwd, input)
      );
    }
    case "move_symbol": {
      const symbolName = String(input.symbolName);
      const fromFile = String(input.fromFile);
      const toFile = String(input.toFile);
      return unwrap(
        tools.moveSymbol(
          symbolName,
          fromFile,
          toFile,
          context.cwd,
          input
        )
      );
    }
    case "convert_to_async": {
      const filePath = String(input.filePath);
      const functionName = String(input.functionName);
      return unwrap(
        tools.convertToAsync(filePath, functionName, context.cwd, input)
      );
    }
    default: {
      throw new Error(`Unsupported tool: ${name}`);
    }
  }
}

const baseToolDefinitions: Array<ToolDefinition<z.ZodTypeAny>> = [
  {
    name: "analyze_project",
    description: "Analyze the current project structure and technology stack.",
    schema: z.object({}),
    execute: (input, context) =>
      callMeerTool("analyze_project", input as Record<string, unknown>, context),
  },
  {
    name: "suggest_setup",
    description:
      "Offer setup recommendations based on the user request and project analysis.",
    schema: z.object({
      request: z
        .string()
        .min(1, "request is required")
        .describe("The user request to guide setup suggestions."),
    }),
    execute: (input, context) =>
      callMeerTool("suggest_setup", input as Record<string, unknown>, context),
  },
  {
    name: "read_file",
    description: "Read the contents of a file in the workspace.",
    schema: z.object({
      path: z.string().min(1, "path is required"),
    }),
    execute: (input, context) =>
      callMeerTool("read_file", input as Record<string, unknown>, context),
  },
  {
    name: "list_files",
    description: "List files and folders in a directory.",
    schema: z.object({
      path: z.string().optional(),
    }),
    execute: (input, context) =>
      callMeerTool("list_files", input as Record<string, unknown>, context),
  },
  {
    name: "propose_edit",
    description:
      "Propose full-file content for creation or modification. Content must include the entire file.",
    schema: z.object({
      path: z.string().min(1, "path is required"),
      contents: z.string().min(1, "contents must include the full file"),
      description: z.string().optional(),
    }),
    execute: (input, context) =>
      callMeerTool("propose_edit", input as Record<string, unknown>, context),
  },
  {
    name: "run_command",
    description: "Execute a shell command inside the project workspace.",
    schema: z.object({
      command: z.string().min(1, "command is required"),
      timeoutMs: z.coerce.number().positive().optional(),
    }),
    execute: (input, context) =>
      callMeerTool("run_command", input as Record<string, unknown>, context),
  },
  {
    name: "find_files",
    description: "Find files matching glob patterns with optional filters.",
    schema: z.object({
      pattern: z.string().default("*"),
      includePattern: z.string().optional(),
      excludePattern: z.string().optional(),
      fileTypes: z.union([z.string(), z.array(z.string())]).optional(),
      maxDepth: z.coerce.number().int().positive().optional(),
    }),
    execute: (input, context) =>
      callMeerTool("find_files", input as Record<string, unknown>, context),
  },
  {
    name: "read_many_files",
    description:
      "Read multiple files at once for quick context gathering. Limited to 10 files by default.",
    schema: z.object({
      files: z.union([z.string(), z.array(z.string())]),
      maxFiles: z.coerce.number().int().positive().optional(),
    }),
    execute: (input, context) =>
      callMeerTool("read_many_files", input as Record<string, unknown>, context),
  },
  {
    name: "search_text",
    description: "Search for a text term across the workspace.",
    schema: z.object({
      term: z.string().min(1, "term is required"),
      filePattern: z.string().optional(),
      caseSensitive: z.union([z.boolean(), z.string()]).optional(),
      wholeWord: z.union([z.boolean(), z.string()]).optional(),
      includePattern: z.string().optional(),
      excludePattern: z.string().optional(),
    }),
    execute: (input, context) =>
      callMeerTool("search_text", input as Record<string, unknown>, context),
  },
  {
    name: "semantic_search",
    description:
      "Run a semantic (embedding-powered) search across the workspace.",
    schema: z.object({
      query: z
        .string()
        .min(3, "query must be at least 3 characters")
        .describe("Natural language search query."),
      limit: z.coerce
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe("Maximum number of results to return (default 10)."),
      minScore: z.coerce
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Minimum similarity score threshold (0-1)."),
      filePattern: z.string().optional(),
      language: z.string().optional(),
      includeTests: z.union([z.boolean(), z.string()]).optional(),
      embeddingModel: z.string().optional(),
    }),
    execute: (input, context) =>
      callMeerTool("semantic_search", input as Record<string, unknown>, context),
  },
  {
    name: "read_folder",
    description: "Recursively inspect a folder structure.",
    schema: z.object({
      path: z.string().optional(),
      maxDepth: z.coerce.number().int().positive().optional(),
      includeStats: z.union([z.boolean(), z.string()]).optional(),
      fileTypes: z.union([z.string(), z.array(z.string())]).optional(),
    }),
    execute: (input, context) =>
      callMeerTool("read_folder", input as Record<string, unknown>, context),
  },
  {
    name: "google_search",
    description: "Perform a Google search (placeholder implementation).",
    schema: z.object({
      query: z.string().min(1, "query is required"),
      maxResults: z.coerce.number().int().positive().optional(),
      site: z.string().optional(),
    }),
    execute: (input, context) =>
      callMeerTool("google_search", input as Record<string, unknown>, context),
  },
  {
    name: "web_fetch",
    description: "Fetch a URL (placeholder implementation).",
    schema: z.object({
      url: z.string().min(1, "url is required"),
      method: z
        .enum(["GET", "POST", "PUT", "DELETE"])
        .optional(),
      headers: z.record(z.string()).optional(),
      saveTo: z.string().optional(),
    }),
    execute: (input, context) =>
      callMeerTool("web_fetch", input as Record<string, unknown>, context),
  },
  {
    name: "save_memory",
    description: "Persist structured memory for later retrieval.",
    schema: z.object({
      key: z.string().min(1, "key is required"),
      content: z.string().default(""),
      category: z.string().optional(),
      tags: z.union([z.string(), z.array(z.string())]).optional(),
      expiresAt: z.string().optional(),
    }),
    execute: (input, context) =>
      callMeerTool("save_memory", input as Record<string, unknown>, context),
  },
  {
    name: "load_memory",
    description: "Load previously saved memory by key.",
    schema: z.object({
      key: z.string().min(1, "key is required"),
    }),
    execute: (input, context) =>
      callMeerTool("load_memory", input as Record<string, unknown>, context),
  },
  {
    name: "grep",
    description:
      "Search within a specific file and return matching line numbers.",
    schema: z.object({
      path: z.string().min(1, "path is required"),
      pattern: z.string().min(1, "pattern is required"),
      caseSensitive: z.union([z.boolean(), z.string()]).optional(),
      maxResults: z.coerce.number().int().positive().optional(),
      contextLines: z.coerce.number().int().nonnegative().optional(),
    }),
    execute: (input, context) =>
      callMeerTool("grep", input as Record<string, unknown>, context),
  },
  {
    name: "edit_line",
    description:
      "Edit a specific line in a file after confirming the change.",
    schema: z.object({
      path: z.string().min(1, "path is required"),
      lineNumber: z.coerce.number().int().positive(),
      oldText: z.string().default(""),
      newText: z.string().default(""),
    }),
    execute: (input, context) =>
      callMeerTool("edit_line", input as Record<string, unknown>, context),
  },
  {
    name: "git_status",
    description: "Show current git working tree status.",
    schema: z.object({}),
    execute: (input, context) =>
      callMeerTool("git_status", input as Record<string, unknown>, context),
  },
  {
    name: "git_diff",
    description: "Show git diff for staged or unstaged changes.",
    schema: z.object({
      staged: z.union([z.boolean(), z.string()]).optional(),
      filepath: z.string().optional(),
      unified: z.coerce.number().int().nonnegative().optional(),
    }),
    execute: (input, context) =>
      callMeerTool("git_diff", input as Record<string, unknown>, context),
  },
  {
    name: "git_log",
    description: "Show git commit history with optional filters.",
    schema: z.object({
      maxCount: z.coerce.number().int().positive().optional(),
      author: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      filepath: z.string().optional(),
    }),
    execute: (input, context) =>
      callMeerTool("git_log", input as Record<string, unknown>, context),
  },
  {
    name: "git_commit",
    description: "Create a git commit with optional staging behaviour.",
    schema: z.object({
      message: z.string().min(1, "message is required"),
      addAll: z.union([z.boolean(), z.string()]).optional(),
      files: z.union([z.string(), z.array(z.string())]).optional(),
    }),
    execute: (input, context) =>
      callMeerTool("git_commit", input as Record<string, unknown>, context),
  },
  {
    name: "git_branch",
    description: "Manage git branches (list/create/switch/delete).",
    schema: z.object({
      list: z.union([z.boolean(), z.string()]).optional(),
      create: z.string().optional(),
      switch: z.string().optional(),
      delete: z.string().optional(),
    }),
    execute: (input, context) =>
      callMeerTool("git_branch", input as Record<string, unknown>, context),
  },
  {
    name: "write_file",
    description: "Write a file with the provided contents.",
    schema: z.object({
      path: z.string().min(1, "path is required"),
      contents: z.string().min(1, "contents is required"),
    }),
    execute: (input, context) =>
      callMeerTool("write_file", input as Record<string, unknown>, context),
  },
  {
    name: "delete_file",
    description: "Delete a file from the workspace.",
    schema: z.object({
      path: z.string().min(1, "path is required"),
    }),
    execute: (input, context) =>
      callMeerTool("delete_file", input as Record<string, unknown>, context),
  },
  {
    name: "move_file",
    description: "Move or rename a file.",
    schema: z.object({
      source: z.string().min(1, "source is required"),
      dest: z.string().min(1, "dest is required"),
    }),
    execute: (input, context) =>
      callMeerTool("move_file", input as Record<string, unknown>, context),
  },
  {
    name: "create_directory",
    description: "Create a new directory recursively.",
    schema: z.object({
      path: z.string().min(1, "path is required"),
    }),
    execute: (input, context) =>
      callMeerTool(
        "create_directory",
        input as Record<string, unknown>,
        context
      ),
  },
  {
    name: "package_install",
    description: "Install packages with npm, yarn, or pnpm.",
    schema: z.object({
      packages: z.union([z.string(), z.array(z.string())]),
      manager: z.enum(["npm", "yarn", "pnpm"]).optional(),
      dev: z.union([z.boolean(), z.string()]).optional(),
      global: z.union([z.boolean(), z.string()]).optional(),
    }),
    execute: (input, context) =>
      callMeerTool(
        "package_install",
        input as Record<string, unknown>,
        context
      ),
  },
  {
    name: "package_run_script",
    description: "Run a package.json script with the preferred manager.",
    schema: z.object({
      script: z.string().min(1, "script is required"),
      manager: z.enum(["npm", "yarn", "pnpm"]).optional(),
    }),
    execute: (input, context) =>
      callMeerTool(
        "package_run_script",
        input as Record<string, unknown>,
        context
      ),
  },
  {
    name: "package_list",
    description: "List installed packages or check for outdated ones.",
    schema: z.object({
      outdated: z.union([z.boolean(), z.string()]).optional(),
    }),
    execute: (input, context) =>
      callMeerTool("package_list", input as Record<string, unknown>, context),
  },
  {
    name: "scaffold_project",
    description:
      "Scaffold a new project such as React, Vue, Next.js, Node, Python, Go, or Rust.",
    schema: z.object({
      projectType: z
        .string()
        .min(1, "projectType is required")
        .describe(
          "Project type to scaffold (react, vue, angular, next, nuxt, node, python, go, rust)."
        ),
      projectName: z
        .string()
        .min(1, "projectName is required")
        .describe("Directory name for the new project."),
    }),
    execute: (input, context) =>
      callMeerTool("scaffold_project", input as Record<string, unknown>, context),
  },
  {
    name: "get_env",
    description: "Read an environment variable from process or .env file.",
    schema: z.object({
      key: z.string().min(1, "key is required"),
    }),
    execute: (input, context) =>
      callMeerTool("get_env", input as Record<string, unknown>, context),
  },
  {
    name: "set_env",
    description: "Set or update a key in the .env file.",
    schema: z.object({
      key: z.string().min(1, "key is required"),
      value: z.string().default(""),
    }),
    execute: (input, context) =>
      callMeerTool("set_env", input as Record<string, unknown>, context),
  },
  {
    name: "list_env",
    description: "List keys stored in the .env file (values hidden).",
    schema: z.object({}),
    execute: (input, context) =>
      callMeerTool("list_env", input as Record<string, unknown>, context),
  },
  {
    name: "http_request",
    description: "Make an HTTP request using undici.",
    schema: z.object({
      url: z.string().min(1, "url is required"),
      method: z
        .enum(["GET", "POST", "PUT", "DELETE", "PATCH"])
        .optional(),
      headers: z.record(z.string()).optional(),
      body: z.string().optional(),
      timeout: z.coerce.number().int().positive().optional(),
    }),
    execute: (input, context) =>
      callMeerTool("http_request", input as Record<string, unknown>, context),
  },
  {
    name: "get_file_outline",
    description:
      "Generate an outline of a JS/TS file including imports, exports, and functions.",
    schema: z.object({
      path: z.string().min(1, "path is required"),
    }),
    execute: (input, context) =>
      callMeerTool(
        "get_file_outline",
        input as Record<string, unknown>,
        context
      ),
  },
  {
    name: "find_symbol_definition",
    description: "Locate where a symbol is defined in the codebase.",
    schema: z.object({
      symbol: z.string().min(1, "symbol is required"),
      filePattern: z.string().optional(),
    }),
    execute: (input, context) =>
      callMeerTool(
        "find_symbol_definition",
        input as Record<string, unknown>,
        context
      ),
  },
  {
    name: "check_syntax",
    description: "Validate JavaScript/TypeScript syntax for a file.",
    schema: z.object({
      path: z.string().min(1, "path is required"),
    }),
    execute: (input, context) =>
      callMeerTool("check_syntax", input as Record<string, unknown>, context),
  },
  {
    name: "validate_project",
    description:
      "Run build/test/lint/type-check validation tailored to the project type.",
    schema: z.object({
      build: z.union([z.boolean(), z.string()]).optional(),
      test: z.union([z.boolean(), z.string()]).optional(),
      lint: z.union([z.boolean(), z.string()]).optional(),
      typeCheck: z.union([z.boolean(), z.string()]).optional(),
    }),
    execute: (input, context) =>
      callMeerTool(
        "validate_project",
        input as Record<string, unknown>,
        context
      ),
  },
  {
    name: "set_plan",
    description: "Create or reset an execution plan with tasks.",
    schema: z.object({
      title: z.string().optional(),
      tasks: z
        .union([
          z.string(),
          z.array(
            z.union([
              z.string(),
              z.object({
                description: z.string(),
              }),
            ])
          ),
        ])
        .optional(),
    }),
    execute: (input, context) =>
      callMeerTool("set_plan", input as Record<string, unknown>, context),
  },
  {
    name: "update_plan_task",
    description: "Update the status of a plan task.",
    schema: z.object({
      taskId: z.string().min(1, "taskId is required"),
      status: z
        .enum(["pending", "in_progress", "completed", "skipped"])
        .default("pending"),
      notes: z.string().optional(),
    }),
    execute: (input, context) =>
      callMeerTool(
        "update_plan_task",
        input as Record<string, unknown>,
        context
      ),
  },
  {
    name: "show_plan",
    description: "Display the current execution plan.",
    schema: z.object({}),
    execute: (input, context) =>
      callMeerTool("show_plan", input as Record<string, unknown>, context),
  },
  {
    name: "clear_plan",
    description: "Clear the active execution plan.",
    schema: z.object({}),
    execute: (input, context) =>
      callMeerTool("clear_plan", input as Record<string, unknown>, context),
  },
  {
    name: "explain_code",
    description: "Extract a code section with context for explanation.",
    schema: z.object({
      path: z.string().min(1, "path is required"),
      startLine: z.coerce.number().int().positive().optional(),
      endLine: z.coerce.number().int().positive().optional(),
      focusSymbol: z.string().optional(),
    }),
    execute: (input, context) =>
      callMeerTool("explain_code", input as Record<string, unknown>, context),
  },
  {
    name: "generate_docstring",
    description: "Prepare context for generating documentation or docstrings.",
    schema: z.object({
      path: z.string().min(1, "path is required"),
      symbolName: z.string().optional(),
      style: z.string().optional(),
      startLine: z.coerce.number().int().positive().optional(),
      endLine: z.coerce.number().int().positive().optional(),
    }),
    execute: (input, context) =>
      callMeerTool(
        "generate_docstring",
        input as Record<string, unknown>,
        context
      ),
  },
  {
    name: "format_code",
    description: "Format code using project-aware formatters.",
    schema: z.object({
      path: z.string().min(1, "path is required"),
      formatter: z.string().optional(),
      check: z.union([z.boolean(), z.string()]).optional(),
    }),
    execute: (input, context) =>
      callMeerTool("format_code", input as Record<string, unknown>, context),
  },
  {
    name: "dependency_audit",
    description: "Audit project dependencies for vulnerabilities.",
    schema: z.object({
      fix: z.union([z.boolean(), z.string()]).optional(),
      production: z.union([z.boolean(), z.string()]).optional(),
    }),
    execute: (input, context) =>
      callMeerTool(
        "dependency_audit",
        input as Record<string, unknown>,
        context
      ),
  },
  {
    name: "run_tests",
    description: "Run the project test suite with optional coverage.",
    schema: z.object({
      coverage: z.union([z.boolean(), z.string()]).optional(),
      specific: z.string().optional(),
      pattern: z.string().optional(),
    }),
    execute: (input, context) =>
      callMeerTool("run_tests", input as Record<string, unknown>, context),
  },
  {
    name: "generate_tests",
    description: "Generate test suggestions for a path.",
    schema: z.object({
      path: z.string().default(""),
      framework: z.string().optional(),
      coverage: z.string().optional(),
      focusFunction: z.string().optional(),
    }),
    execute: (input, context) =>
      callMeerTool(
        "generate_tests",
        input as Record<string, unknown>,
        context
      ),
  },
  {
    name: "security_scan",
    description: "Run security scanners across the project.",
    schema: z.object({
      path: z.string().default(""),
      scanners: z.string().optional(),
      severity: z.string().optional(),
      autoFix: z.union([z.boolean(), z.string()]).optional(),
    }),
    execute: (input, context) =>
      callMeerTool(
        "security_scan",
        input as Record<string, unknown>,
        context
      ),
  },
  {
    name: "code_review",
    description: "Perform AI-assisted code review on a path.",
    schema: z.object({
      path: z.string().default(""),
      focus: z.string().optional(),
      severity: z.string().optional(),
    }),
    execute: (input, context) =>
      callMeerTool("code_review", input as Record<string, unknown>, context),
  },
  {
    name: "generate_readme",
    description: "Generate README content for the current project.",
    schema: z.object({
      includeInstall: z.union([z.boolean(), z.string()]).optional(),
      includeUsage: z.union([z.boolean(), z.string()]).optional(),
      includeApi: z.union([z.boolean(), z.string()]).optional(),
      includeContributing: z.union([z.boolean(), z.string()]).optional(),
    }),
    execute: (input, context) =>
      callMeerTool(
        "generate_readme",
        input as Record<string, unknown>,
        context
      ),
  },
  {
    name: "fix_lint",
    description: "Auto-fix lint issues for a path.",
    schema: z.object({
      path: z.string().default(""),
      linter: z.string().optional(),
    }),
    execute: (input, context) =>
      callMeerTool("fix_lint", input as Record<string, unknown>, context),
  },
  {
    name: "organize_imports",
    description: "Organize imports within a file.",
    schema: z.object({
      path: z.string().default(""),
      organizer: z.string().optional(),
    }),
    execute: (input, context) =>
      callMeerTool(
        "organize_imports",
        input as Record<string, unknown>,
        context
      ),
  },
  {
    name: "check_complexity",
    description: "Analyze code complexity thresholds.",
    schema: z.object({
      path: z.string().default(""),
      threshold: z.coerce.number().int().positive().optional(),
      includeDetails: z.union([z.boolean(), z.string()]).optional(),
    }),
    execute: (input, context) =>
      callMeerTool(
        "check_complexity",
        input as Record<string, unknown>,
        context
      ),
  },
  {
    name: "detect_smells",
    description: "Detect code smells and anti-patterns.",
    schema: z.object({
      path: z.string().default(""),
      types: z.string().optional(),
      severity: z.string().optional(),
    }),
    execute: (input, context) =>
      callMeerTool(
        "detect_smells",
        input as Record<string, unknown>,
        context
      ),
  },
  {
    name: "analyze_coverage",
    description: "Analyze test coverage reports and highlight gaps.",
    schema: z.object({
      threshold: z.coerce.number().int().positive().optional(),
      format: z.string().optional(),
      includeUncovered: z.union([z.boolean(), z.string()]).optional(),
    }),
    execute: (input, context) =>
      callMeerTool(
        "analyze_coverage",
        input as Record<string, unknown>,
        context
      ),
  },
  {
    name: "find_references",
    description: "Find references to a symbol across the project.",
    schema: z.object({
      symbol: z.string().min(1, "symbol is required"),
      filePattern: z.string().optional(),
      includeDefinition: z.union([z.boolean(), z.string()]).optional(),
      maxResults: z.coerce.number().int().positive().optional(),
      contextLines: z.coerce.number().int().nonnegative().optional(),
    }),
    execute: (input, context) =>
      callMeerTool(
        "find_references",
        input as Record<string, unknown>,
        context
      ),
  },
  {
    name: "generate_test_suite",
    description: "Generate a comprehensive test suite plan for a module.",
    schema: z.object({
      path: z.string().default(""),
      framework: z.string().optional(),
      includeUnit: z.union([z.boolean(), z.string()]).optional(),
      includeIntegration: z.union([z.boolean(), z.string()]).optional(),
      includeE2E: z.union([z.boolean(), z.string()]).optional(),
    }),
    execute: (input, context) =>
      callMeerTool(
        "generate_test_suite",
        input as Record<string, unknown>,
        context
      ),
  },
  {
    name: "generate_mocks",
    description: "Generate mock data/functions for testing contexts.",
    schema: z.object({
      path: z.string().default(""),
      mockType: z.string().optional(),
      framework: z.string().optional(),
    }),
    execute: (input, context) =>
      callMeerTool(
        "generate_mocks",
        input as Record<string, unknown>,
        context
      ),
  },
  {
    name: "generate_api_docs",
    description: "Generate API documentation scaffolding for a path.",
    schema: z.object({
      path: z.string().default(""),
      format: z.string().optional(),
      includeExamples: z.union([z.boolean(), z.string()]).optional(),
      includeTypes: z.union([z.boolean(), z.string()]).optional(),
    }),
    execute: (input, context) =>
      callMeerTool(
        "generate_api_docs",
        input as Record<string, unknown>,
        context
      ),
  },
  {
    name: "git_blame",
    description: "Display git blame information for a file.",
    schema: z.object({
      path: z.string().min(1, "path is required"),
      startLine: z.coerce.number().int().positive().optional(),
      endLine: z.coerce.number().int().positive().optional(),
    }),
    execute: (input, context) =>
      callMeerTool("git_blame", input as Record<string, unknown>, context),
  },
  {
    name: "rename_symbol",
    description: "Rename a symbol across the codebase (text-based).",
    schema: z.object({
      oldName: z.string().min(1, "oldName is required"),
      newName: z.string().min(1, "newName is required"),
      filePattern: z.string().optional(),
      dryRun: z.union([z.boolean(), z.string()]).optional(),
    }),
    execute: (input, context) =>
      callMeerTool(
        "rename_symbol",
        input as Record<string, unknown>,
        context
      ),
  },
  {
    name: "extract_function",
    description: "Extract code into a new function.",
    schema: z.object({
      filePath: z.string().min(1, "filePath is required"),
      startLine: z.coerce.number().int().positive(),
      endLine: z.coerce.number().int().positive(),
      functionName: z.string().min(1, "functionName is required"),
      insertLocation: z.string().optional(),
      dryRun: z.union([z.boolean(), z.string()]).optional(),
    }),
    execute: (input, context) =>
      callMeerTool(
        "extract_function",
        input as Record<string, unknown>,
        context
      ),
  },
  {
    name: "extract_variable",
    description: "Extract an expression into a new variable.",
    schema: z.object({
      filePath: z.string().min(1, "filePath is required"),
      lineNumber: z.coerce.number().int().positive(),
      expression: z.string().min(1, "expression is required"),
      variableName: z.string().min(1, "variableName is required"),
      replaceAll: z.union([z.boolean(), z.string()]).optional(),
      dryRun: z.union([z.boolean(), z.string()]).optional(),
    }),
    execute: (input, context) =>
      callMeerTool(
        "extract_variable",
        input as Record<string, unknown>,
        context
      ),
  },
  {
    name: "inline_variable",
    description: "Inline a variable into its usages.",
    schema: z.object({
      filePath: z.string().min(1, "filePath is required"),
      variableName: z.string().min(1, "variableName is required"),
      dryRun: z.union([z.boolean(), z.string()]).optional(),
    }),
    execute: (input, context) =>
      callMeerTool(
        "inline_variable",
        input as Record<string, unknown>,
        context
      ),
  },
  {
    name: "move_symbol",
    description: "Move a symbol from one file to another.",
    schema: z.object({
      symbolName: z.string().min(1, "symbolName is required"),
      fromFile: z.string().min(1, "fromFile is required"),
      toFile: z.string().min(1, "toFile is required"),
      addImport: z.union([z.boolean(), z.string()]).optional(),
      dryRun: z.union([z.boolean(), z.string()]).optional(),
    }),
    execute: (input, context) =>
      callMeerTool("move_symbol", input as Record<string, unknown>, context),
  },
  {
    name: "convert_to_async",
    description: "Convert promise/callback based code to async/await.",
    schema: z.object({
      filePath: z.string().min(1, "filePath is required"),
      functionName: z.string().min(1, "functionName is required"),
      dryRun: z.union([z.boolean(), z.string()]).optional(),
    }),
    execute: (input, context) =>
      callMeerTool(
        "convert_to_async",
        input as Record<string, unknown>,
        context
      ),
  },
];

export function createMeerLangChainTools(
  context: MeerLangChainToolContext,
  options: MeerLangChainToolOptions = {}
): StructuredToolInterface[] {
  const builtinTools = baseToolDefinitions.map(
    ({ name, description, schema, execute }) =>
      new DynamicStructuredTool({
        name,
        description,
        schema:
          schema instanceof z.ZodObject
            ? schema.catchall(z.any()).passthrough()
            : schema,
        func: async (input) =>
          execute(input as Record<string, unknown>, context),
      })
  );

  const mcpTools = (options.mcpTools ?? []).map((tool) => {
    const schema =
      tool.inputSchema?.type === "object"
        ? (jsonSchemaToZod(tool.inputSchema) as z.ZodTypeAny)
        : FALLBACK_SCHEMA;
    const description =
      tool.description && tool.description.trim().length > 0
        ? `${tool.description} (MCP:${tool.serverName})`
        : `MCP tool from ${tool.serverName}`;

    return new DynamicStructuredTool({
      name: tool.name,
      description,
      schema:
        schema instanceof z.ZodObject
          ? schema.catchall(z.any()).passthrough()
          : schema,
      func: async (input) => {
        if (!context.executeMcpTool) {
          throw new Error(
            `MCP execution is unavailable for tool "${tool.name}".`
          );
        }
        return context.executeMcpTool(
          tool.name,
          (input as Record<string, unknown>) ?? {}
        );
      },
    });
  });

  return [...builtinTools, ...mcpTools];
}
