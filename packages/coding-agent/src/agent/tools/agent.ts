import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { resolve } from "node:path";
import type { FileEdit, ToolResult } from "../../tools/index.js";
import * as tools from "../../tools/index.js";
import type { Provider } from "@meer-ai/ai/base.js";
import type { MCPTool } from "../../mcp/types.js";
import type { AgentTool, AgentToolCallResult } from "../runtime/types.js";
import { extractLeadingCd } from "../../utils/shell-cd.js";
import { withFileMutationQueue } from "../../tools/file-mutation-queue.js";
export interface MeerAgentToolContext {
  cwd: string;
  provider?: Provider;
  /**
   * Required for tools that generate FileEdit payloads (propose_edit).
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
  /**
   * Ask the user before a mutating tool action (delete_file, move_file, …).
   * Keyed by tool name so an "always allow" decision can be remembered per tool.
   */
  confirmToolAction?: (toolName: string, action: string) => Promise<boolean>;
  /**
   * Ask the user a structured set of questions through the active UI.
   */
  promptForm?: (
    title: string,
    questions: Array<{
      id: string;
      label: string;
      type: "select" | "multiselect";
      required?: boolean;
      options: Array<{ label: string; value: string; description?: string }>;
    }>,
    submitLabel?: string
  ) => Promise<Record<string, string | string[]>>;
  startBackgroundCommand?: (
    command: string,
    cwd: string
  ) => Promise<{
    id: string;
    status: "running" | "exited" | "failed";
    command: string;
    cwd: string;
  }>;
  /**
   * Read the session-level "current shell directory." `cd` commands from
   * the agent persist here so a follow-up `run_command` lands in the
   * expected directory even though each invocation spawns a fresh shell.
   * Falls back to `context.cwd` when no `cd` has happened yet.
   */
  getShellCwd?: () => string;
  /**
   * Persist a new shell cwd. Called by the run_command path after parsing
   * `cd` prefixes out of the agent's commands. Implementations should
   * resolve relative paths and validate the directory exists before
   * accepting the change.
   */
  setShellCwd?: (path: string) => void;
}

export interface MeerAgentToolOptions {
  mcpTools?: MCPTool[];
}

type ToolExecutor<TInput> = (
  input: TInput,
  context: MeerAgentToolContext,
  onUpdate?: (partial: string) => void,
  signal?: AbortSignal
) => Promise<string | AgentToolCallResult>;

interface ToolDefinition<TSchema extends z.ZodTypeAny> {
  name: string;
  description: string;
  schema: TSchema;
  execute: ToolExecutor<z.infer<TSchema>>;
}

const FALLBACK_SCHEMA = z.object({}).catchall(z.any());

type ToolName = string;

const PRIMITIVE_INPUT_COERCIONS: Record<
  ToolName,
  (value: string) => Record<string, unknown>
> = {
  read_file: (value) => ({ path: value }),
  list_files: (value) => ({ path: value }),
  run_command: (value) => ({ command: value }),
  find_files: (value) => ({ pattern: value }),
  grep: (value) => {
    const [path, pattern] = value.split(/\s+/, 2);
    if (pattern) {
      return { path, pattern };
    }
    return { path: ".", pattern: value };
  },
};

function parseJsonIfPossible(raw: string): unknown {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through
    }
  }
  return raw;
}

function coercePrimitiveInput(name: string, raw: unknown): unknown {
  if (typeof raw !== "string") {
    return raw;
  }
  const jsonCandidate = parseJsonIfPossible(raw);
  if (jsonCandidate !== raw) {
    return jsonCandidate;
  }

  const coercer = PRIMITIVE_INPUT_COERCIONS[name];
  if (coercer) {
    return coercer(raw.trim());
  }

  return raw;
}

function normalizeToolInputValue(name: string, raw: unknown): unknown {
  if (raw === null || raw === undefined) {
    return {};
  }

  if (
    typeof raw === "object" &&
    raw !== null &&
    "action_input" in (raw as Record<string, unknown>)
  ) {
    const actionInput = (raw as Record<string, unknown>).action_input;
    return normalizeToolInputValue(name, actionInput);
  }

  return coercePrimitiveInput(name, raw);
}

function adaptSchemaForAgent(
  name: string,
  schema: z.ZodTypeAny
): {
  schema: z.ZodTypeAny;
  validate: (raw: unknown) => any;
} {
  const baseSchema =
    schema instanceof z.ZodObject
      ? schema.catchall(z.any()).passthrough()
      : schema;

  const validate = (raw: unknown) => {
    const normalized = normalizeToolInputValue(name, raw);
    return baseSchema.parse(normalized);
  };

  return {
    schema: z.any(),
    validate,
  };
}

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

function unwrapStructured(result: ToolResult): AgentToolCallResult {
  if (result.error) {
    throw new Error(result.error);
  }
  return {
    content: result.result ?? "",
    details: result.details,
  };
}

async function ensureEditApproval(
  context: MeerAgentToolContext,
  edit: FileEdit
): Promise<boolean> {
  if (!context.reviewFileEdit) {
    throw new Error(
      "reviewFileEdit callback is required to execute editing tools safely."
    );
  }
  return context.reviewFileEdit(edit);
}

/**
 * Normalize edit_file input into a clean TextEdit[].
 * Handles model quirks observed in the wild (ported from pi):
 * - `edits` sent as a JSON string instead of an array
 * - legacy single `oldText`/`newText` pair instead of an `edits` array
 */
function normalizeEditFileEdits(
  input: Record<string, unknown>
): Array<{ oldText: string; newText: string }> {
  let rawEdits = input.edits;

  if (typeof rawEdits === "string") {
    try {
      const parsed = JSON.parse(rawEdits);
      if (Array.isArray(parsed)) rawEdits = parsed;
    } catch {
      // fall through to validation error below
    }
  }

  const edits: Array<{ oldText: string; newText: string }> = [];
  if (Array.isArray(rawEdits)) {
    for (const entry of rawEdits) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as Record<string, unknown>).oldText === "string" &&
        typeof (entry as Record<string, unknown>).newText === "string"
      ) {
        edits.push({
          oldText: (entry as Record<string, string>).oldText,
          newText: (entry as Record<string, string>).newText,
        });
      }
    }
  }

  if (typeof input.oldText === "string" && typeof input.newText === "string") {
    edits.push({ oldText: input.oldText, newText: input.newText });
  }

  if (edits.length === 0) {
    throw new Error(
      "edit_file requires an edits array of { oldText, newText } replacements."
    );
  }
  return edits;
}

async function ensureCommandApproval(
  context: MeerAgentToolContext,
  command: string
): Promise<boolean> {
  if (!context.confirmCommand) {
    throw new Error(
      "confirmCommand callback is required to execute shell commands safely."
    );
  }
  return context.confirmCommand(command);
}

async function ensureToolActionApproval(
  context: MeerAgentToolContext,
  toolName: string,
  action: string
): Promise<boolean> {
  // Prefer the tool-aware approval path (supports per-tool "always allow").
  // Fall back to the shell-command confirm callback for back-compat.
  if (context.confirmToolAction) {
    return context.confirmToolAction(toolName, action);
  }
  if (!context.confirmCommand) {
    throw new Error(
      `An approval callback is required to execute dangerous operations safely (${action}).`
    );
  }
  return context.confirmCommand(action);
}

async function requestStructuredUserInput(
  context: MeerAgentToolContext,
  input: {
    title?: string;
    submitLabel?: string;
    questions: Array<{
      id: string;
      label: string;
      type: "select" | "multiselect";
      required?: boolean;
      options: Array<{ label: string; value: string; description?: string }>;
    }>;
  }
): Promise<string> {
  if (!context.promptForm) {
    throw new Error("Structured user input is unavailable in this UI.");
  }

  const answers = await context.promptForm(
    input.title?.trim() || "Help me decide",
    input.questions,
    input.submitLabel
  );

  return JSON.stringify({ answers }, null, 2);
}

async function startBackgroundCommand(
  context: MeerAgentToolContext,
  input: {
    command: string;
    cwd?: string;
  }
): Promise<string> {
  if (!context.startBackgroundCommand) {
    throw new Error("Background terminal support is unavailable in this UI.");
  }
  const command = input.command.trim();
  if (!command) {
    throw new Error("command is required");
  }
  const session = await context.startBackgroundCommand(
    command,
    input.cwd?.trim() || context.cwd
  );
  return [
    `Started background terminal ${session.id}.`,
    `Command: ${session.command}`,
    `Directory: ${session.cwd}`,
    "Use /ps to inspect running background terminals and /stop <id> to stop one.",
  ].join("\n");
}

async function callMeerTool(
  name: string,
  input: Record<string, unknown>,
  context: MeerAgentToolContext,
  onUpdate?: (partial: string) => void,
  signal?: AbortSignal
): Promise<string | AgentToolCallResult> {
  switch (name) {
    case "analyze_project": {
      return unwrap(tools.analyzeProject(context.cwd));
    }
    case "read_file": {
      const offset =
        input.offset !== undefined ? Number(input.offset) : undefined;
      const limit = input.limit !== undefined ? Number(input.limit) : undefined;
      return unwrap(
        tools.readFile(String(input.path), context.cwd, { offset, limit })
      );
    }
    case "list_files": {
      const rawPath = input.path;
      const path =
        typeof rawPath === "string" && rawPath.trim().length > 0
          ? rawPath
          : ".";
      const maxDepth =
        input.maxDepth !== undefined ? Number(input.maxDepth) : undefined;
      // When maxDepth is provided, route to readFolder for recursive listing.
      if (maxDepth !== undefined) {
        return unwrap(tools.readFolder(path, context.cwd, { maxDepth }));
      }
      return unwrap(tools.listFiles(path, context.cwd));
    }
    case "propose_edit": {
      const path = String(input.path);
      const contents = String(input.contents ?? input.content ?? "");
      const description =
        typeof input.description === "string" ? input.description : "Edit file";
      return withFileMutationQueue(resolve(context.cwd, path), async () => {
        const edit = tools.proposeEdit(path, contents, description, context.cwd);
        if (!(await ensureEditApproval(context, edit))) {
          return `⏭️ Edit skipped for ${edit.path}`;
        }
        return unwrapStructured(tools.applyEdit(edit, context.cwd));
      });
    }
    case "edit_file": {
      const path = String(input.path);
      return withFileMutationQueue(resolve(context.cwd, path), async () => {
        const edits = normalizeEditFileEdits(input);
        const edit = tools.editFileSections(path, edits, context.cwd);
        if (!(await ensureEditApproval(context, edit))) {
          return `⏭️ Edit skipped for ${edit.path}`;
        }
        return unwrapStructured(tools.applyEdit(edit, context.cwd));
      });
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

      // Peel leading `cd …` segments off the command. The agent's "cd foo"
      // then a follow-up "npm test" would otherwise run in two different
      // shells because each invocation spawns fresh. We:
      //   - resolve `cd <path>` against the session shell cwd
      //   - persist the new cwd via context.setShellCwd
      //   - execute whatever's left after the cd's (often empty for a
      //     bare `cd /path`, in which case we report success without
      //     spawning a shell at all)
      const sessionCwd = context.getShellCwd?.() ?? context.cwd;
      const cdParse = extractLeadingCd(command, sessionCwd);
      if (cdParse.error) {
        return {
          content: cdParse.error,
          isError: true,
        };
      }
      const effectiveCwd = cdParse.newCwd ?? sessionCwd;
      const remaining = cdParse.remainingCommand;

      // Commit the new cwd BEFORE running anything so that even if the
      // tail command throws, the cd's the model intended still stick.
      if (cdParse.newCwd && context.setShellCwd) {
        context.setShellCwd(cdParse.newCwd);
      }

      // Bare `cd /path` (no tail) — short-circuit, no shell spawn.
      if (!remaining) {
        return {
          content: `Changed directory to ${effectiveCwd}`,
          details: { shellCwd: effectiveCwd },
        };
      }

      const timeoutMs =
        input.timeoutMs !== undefined ? Number(input.timeoutMs) : undefined;
      const result = await tools.runCommand(remaining, effectiveCwd, {
        timeoutMs,
        onUpdate,
        signal,
      });
      return {
        content: result.result || result.error || "",
        isError: Boolean(result.error),
        details: {
          ...(result.details ?? {}),
          timeoutMs,
          shellCwd: effectiveCwd,
        },
      };
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
    case "google_search": {
      const query = String(input.query);
      const maxResults =
        input.maxResults !== undefined ? Number(input.maxResults) : undefined;
      const site =
        typeof input.site === "string" ? input.site : undefined;
      const result = await tools.googleSearch(query, {
        maxResults,
        site,
      });
      return unwrap(result);
    }
    case "web_fetch": {
      const url = String(input.url);
      const method =
        typeof input.method === "string" ? (input.method as any) : undefined;
      const headers =
        typeof input.headers === "object" && input.headers !== null
          ? (input.headers as Record<string, string>)
          : undefined;
      const body =
        typeof input.body === "string" ? input.body : undefined;
      const saveTo =
        typeof input.saveTo === "string" ? input.saveTo : undefined;
      // When body is provided (or method is non-GET), route to httpRequest
      // which has a real fetch implementation (webFetch is a placeholder).
      if (body !== undefined || (method && method !== "GET")) {
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
      const includePattern =
        typeof input.includePattern === "string" ? input.includePattern : undefined;
      const excludePattern =
        typeof input.excludePattern === "string" ? input.excludePattern : undefined;
      // When include/exclude patterns are provided, route to searchText which
      // handles glob-pattern file filtering natively (grep is single-file).
      if (includePattern !== undefined || excludePattern !== undefined) {
        return unwrap(
          tools.searchText(pattern, context.cwd, {
            filePattern: includePattern,
            excludePattern,
            caseSensitive,
          })
        );
      }
      return unwrap(
        tools.grep(path, pattern, context.cwd, {
          caseSensitive,
          maxResults,
          contextLines,
        })
      );
    }
    case "delete_file": {
      const path = String(input.path);
      if (!(await ensureToolActionApproval(context, "delete_file", `Delete file ${path}?`))) {
        return `⚠️ Delete cancelled: ${path}`;
      }
      return unwrap(tools.deleteFile(path, context.cwd));
    }
    case "move_file": {
      const source = String(input.source);
      const dest = String(input.dest);
      if (!(await ensureToolActionApproval(context, "move_file", `Move ${source} → ${dest}?`))) {
        return `⚠️ Move cancelled: ${source} → ${dest}`;
      }
      return unwrap(tools.moveFile(source, dest, context.cwd));
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
    case "find_references": {
      const symbol = String(input.symbol);
      return unwrap(tools.findReferences(symbol, context.cwd, input));
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
    name: "read_file",
    description:
      "Read the contents of a file in the workspace. Large files are truncated; use offset (1-indexed start line) and limit (max lines) to read specific ranges.",
    schema: z.object({
      path: z.string().min(1, "path is required"),
      offset: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().optional(),
    }),
    execute: (input, context) => {
      const normalized =
        typeof input === "string" ? { path: input } : (input ?? {});
      return callMeerTool(
        "read_file",
        normalized as Record<string, unknown>,
        context
      );
    },
  },
  {
    name: "list_files",
    description: "List files and folders in a directory. When maxDepth is provided, lists recursively up to that depth (absorbs read_folder capability).",
    schema: z.object({
      path: z.string().optional(),
      maxDepth: z.coerce.number().int().positive().optional(),
    }),
    execute: (input, context) => {
      const normalized =
        typeof input === "string" ? { path: input } : (input ?? {});
      return callMeerTool(
        "list_files",
        normalized as Record<string, unknown>,
        context
      );
    },
  },
  {
    name: "edit_file",
    description:
      "Make targeted text replacements in an existing file. Preferred over propose_edit for modifying existing files. Each edit replaces one unique occurrence of oldText with newText; oldText must match the file exactly (whitespace included) and be unique — include surrounding lines for context. Multiple edits are matched against the original file and must not overlap.",
    schema: z.object({
      path: z.string().min(1, "path is required"),
      // Lenient on purpose: some models send `edits` as a JSON string, or a
      // legacy top-level oldText/newText pair. normalizeEditFileEdits()
      // coerces these and produces actionable errors.
      edits: z
        .union([
          z.array(
            z.object({
              oldText: z
                .string()
                .describe(
                  "Exact text to replace. Must be unique in the file; include surrounding lines to disambiguate."
                ),
              newText: z.string().describe("Replacement text."),
            })
          ),
          z.string(),
        ])
        .optional(),
      oldText: z.string().optional(),
      newText: z.string().optional(),
    }),
    execute: (input, context) =>
      callMeerTool("edit_file", input as Record<string, unknown>, context),
  },
  {
    name: "propose_edit",
    description:
      "Propose full-file content for creation or modification. Content must include the entire file. Use for NEW files or full rewrites only — for changes to existing files, prefer edit_file.",
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
    name: "google_search",
    description:
      "Search the web using Brave Search (requires BRAVE_API_KEY) with a manual fallback link.",
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
    description: "Fetch a URL. Supports GET/POST/PUT/DELETE/PATCH with optional headers and body (absorbs http_request capability).",
    schema: z.object({
      url: z.string().min(1, "url is required"),
      method: z
        .enum(["GET", "POST", "PUT", "DELETE", "PATCH"])
        .optional(),
      headers: z.record(z.string()).optional(),
      body: z.string().optional(),
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
      "Search within a specific file and return matching line numbers. When includePattern or excludePattern is provided, searches across the workspace (absorbs search_text include/exclude capability).",
    schema: z.object({
      path: z.string().min(1, "path is required"),
      pattern: z.string().min(1, "pattern is required"),
      caseSensitive: z.union([z.boolean(), z.string()]).optional(),
      maxResults: z.coerce.number().int().positive().optional(),
      contextLines: z.coerce.number().int().nonnegative().optional(),
      includePattern: z.string().optional(),
      excludePattern: z.string().optional(),
    }),
    execute: (input, context) =>
      callMeerTool("grep", input as Record<string, unknown>, context),
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
    name: "request_user_input",
    description:
      "Ask the user a structured set of questions with dropdown or multi-select answers when a human decision is required.",
    schema: z.object({
      title: z.string().optional(),
      submitLabel: z.string().optional(),
      questions: z
        .array(
          z.object({
            id: z.string().min(1, "id is required"),
            label: z.string().min(1, "label is required"),
            type: z.enum(["select", "multiselect"]),
            required: z.boolean().optional(),
            options: z
              .array(
                z.object({
                  label: z.string().min(1, "label is required"),
                  value: z.string().min(1, "value is required"),
                  description: z.string().optional(),
                })
              )
              .min(1, "at least one option is required"),
          })
        )
        .min(1, "at least one question is required")
        .max(5, "keep structured user questionnaires concise"),
    }),
    execute: (input, context) =>
      requestStructuredUserInput(context, input),
  },
  {
    name: "start_background_command",
    description:
      "Start a long-running or interactive shell command in a managed background terminal session.",
    schema: z.object({
      command: z.string().min(1, "command is required"),
      cwd: z.string().optional(),
    }),
    execute: (input, context) =>
      startBackgroundCommand(context, input),
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
];

function toToolInputSchema(name: string, schema: z.ZodTypeAny): Record<string, unknown> {
  const jsonSchema = zodToJsonSchema(schema, {
    name,
    $refStrategy: "none",
  }) as Record<string, unknown>;

  if ("$ref" in jsonSchema && "definitions" in jsonSchema) {
    const definitions = jsonSchema.definitions as Record<string, unknown> | undefined;
    const named = definitions?.[name];
    if (named && typeof named === "object") {
      return named as Record<string, unknown>;
    }
  }

  return jsonSchema;
}

export function createMeerAgentTools(
  context: MeerAgentToolContext,
  options: MeerAgentToolOptions = {}
): AgentTool[] {
  const builtinTools = baseToolDefinitions.map(
    ({ name, description, schema, execute }) => {
      const { validate } = adaptSchemaForAgent(name, schema);
      return {
        name,
        description,
        inputSchema: toToolInputSchema(name, schema),
        call: async (
          input: unknown,
          onUpdate?: (partial: string) => void,
          signal?: AbortSignal
        ) => {
          const parsed = validate(input);
          return execute(
            parsed as Record<string, unknown>,
            context,
            onUpdate,
            signal
          );
        },
      };
    }
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

    return {
      name: tool.name,
      description,
      inputSchema: tool.inputSchema ?? toToolInputSchema(tool.name, schema),
      call: async (input: unknown) => {
        const normalized =
          typeof input === "object" && input !== null
            ? (input as Record<string, unknown>)
            : {};
        if (!context.executeMcpTool) {
          throw new Error(
            `MCP execution is unavailable for tool "${tool.name}".`
          );
        }
        return context.executeMcpTool(
          tool.name,
          normalized
        );
      },
    };
  });

  return [...builtinTools, ...mcpTools];
}
