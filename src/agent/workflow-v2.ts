import chalk from "chalk";
import ora, { type Ora } from "ora";
import inquirer from "inquirer";
import type { Provider, ChatMessage } from "../providers/base.js";
import { parseToolCalls, type FileEdit, generateDiff } from "../tools/index.js";
import { memory } from "../memory/index.js";
import { logVerbose } from "../logger.js";
import { MCPManager } from "../mcp/manager.js";
import type { MCPTool } from "../mcp/types.js";
import type { SessionTracker } from "../session/tracker.js";
import { countTokens, countMessageTokens, getContextLimit } from "../token/utils.js";
import { OCEAN_SPINNER, type Timeline } from "../ui/workflowTimeline.js";
import { buildAgentSystemPrompt } from "./prompts/systemPrompt.js";
import { ContextPreprocessor } from "./context-preprocessor.js";
import { TransactionManager } from "./transaction-manager.js";
import { TestDetector } from "./test-detector.js";

export interface AgentConfig {
  provider: Provider;
  cwd: string;
  maxIterations?: number;
  enableMemory?: boolean;
  providerType?: string;
  model?: string;
  timeouts?: {
    chat?: number;
  };
  sessionTracker?: SessionTracker;
}

/**
 * Clean, agentic workflow that lets the LLM decide everything
 * No hardcoded plans, no forced context loading
 */
export class AgentWorkflowV2 {
  private provider: Provider;
  private cwd: string;
  private maxIterations: number;
  private messages: ChatMessage[] = [];
  private enableMemory: boolean;
  private providerType: string;
  private model: string;
  private mcpManager = MCPManager.getInstance();
  private mcpTools: MCPTool[] = [];
  private sessionTracker?: SessionTracker;
  private contextLimit?: number;
  private chatTimeout: number;
  private runWithTerminal?: <T>(fn: () => Promise<T>) => Promise<T>;
  private promptChoice?: (
    message: string,
    choices: Array<{ label: string; value: string }>,
    defaultValue: string
      ) => Promise<string>;
  private contextPreprocessor: ContextPreprocessor;
  private transactionManager: TransactionManager;
  private testDetector: TestDetector;
  private editedFiles: Set<string> = new Set();

  constructor(config: AgentConfig) {
    this.provider = config.provider;
    this.cwd = config.cwd;
    this.maxIterations = config.maxIterations || 10;
    this.enableMemory = config.enableMemory ?? true;
    this.providerType = config.providerType || "unknown";
    this.model = config.model || "unknown";
    this.sessionTracker = config.sessionTracker;
    this.contextLimit = getContextLimit(this.model);
    this.chatTimeout = config.timeouts?.chat || this.getDefaultChatTimeout(config.providerType);
    this.contextPreprocessor = new ContextPreprocessor(this.cwd);
    this.transactionManager = new TransactionManager(this.cwd);
    this.testDetector = new TestDetector(this.cwd);

    if (this.contextLimit) {
      this.sessionTracker?.setContextLimit(this.contextLimit);
    }
  }
  private lastPromptTokens = 0;
  private basePromptTokens = 0;

  private getDefaultChatTimeout(providerType?: string): number {
    switch (providerType?.toLowerCase()) {
      case "ollama": return 300000; // 5 min for local models
      case "anthropic": return 90000; // 1.5 min for Claude
      case "gemini": return 60000; // 1 min for Gemini
      default: return 60000;
    }
  }

  async initialize(contextPrompt?: string) {
    // Initialize MCP tools
    if (!this.mcpManager.isInitialized()) {
      try {
        await this.mcpManager.initialize();
        this.mcpTools = this.mcpManager.listAllTools();
        if (this.mcpTools.length > 0) {
          logVerbose(chalk.green(`✓ Loaded ${this.mcpTools.length} MCP tools`));
        }
      } catch (error) {
        logVerbose(chalk.yellow('⚠️ MCP initialization failed'));
      }
    } else {
      this.mcpTools = this.mcpManager.listAllTools();
    }

    // Simple system prompt - LLM decides everything
    const systemPrompt = this.getSystemPrompt();
    const fullPrompt = contextPrompt
      ? `${systemPrompt}\n\n${contextPrompt}`
      : systemPrompt;

    this.messages = [{ role: "system", content: fullPrompt }];
    this.basePromptTokens = countMessageTokens(this.model, this.messages);
    this.lastPromptTokens = 0;
  }

  /**
   * Simple agentic loop - no hardcoded workflows
   */
  async processMessage(
    userMessage: string,
    options?: {
      timeline?: Timeline;
      onAssistantStart?: () => void;
      onAssistantChunk?: (chunk: string) => void;
      onAssistantEnd?: () => void;
      withTerminal?: <T>(fn: () => Promise<T>) => Promise<T>;
      promptChoice?: (
        message: string,
        choices: Array<{ label: string; value: string }>,
        defaultValue: string
      ) => Promise<string>;
      disableAutoContext?: boolean;
      autoRunTests?: boolean;
    }
  ): Promise<string> {
    const timeline = options?.timeline;
    const autoRunTests = options?.autoRunTests ?? false; // Default: disabled

    // Clear edited files tracking at the start of each message
    this.editedFiles.clear();
    const onAssistantStart = options?.onAssistantStart;
    const onAssistantChunk = options?.onAssistantChunk;
    const onAssistantEnd = options?.onAssistantEnd;
    const useUI = Boolean(onAssistantChunk);
    this.runWithTerminal = options?.withTerminal;
    this.promptChoice = options?.promptChoice;

    // Auto-gather relevant context BEFORE adding user message (unless disabled)
    if (!options?.disableAutoContext) {
      try {
        const relevantFiles = await this.contextPreprocessor.gatherContext(userMessage);

        if (relevantFiles.length > 0) {
          const contextPrompt = this.contextPreprocessor.buildContextPrompt(relevantFiles);

          // Add context as a system message
          this.messages.push({
            role: 'system',
            content: contextPrompt,
          });

          // Notify user about auto-loaded files
          const fileList = relevantFiles
            .map(f => `  • ${f.path} (${f.reason})`)
            .join('\n');

          if (timeline) {
            timeline.note(`📁 Auto-loaded ${relevantFiles.length} relevant file(s):\n${fileList}`);
          } else {
            console.log(chalk.blue(`\n📁 Auto-loaded ${relevantFiles.length} relevant file(s):`));
            console.log(chalk.gray(fileList));
          }
        }
      } catch (error) {
        // Context gathering is best-effort, don't fail the entire request
        logVerbose(chalk.yellow('⚠️ Auto-context gathering failed:'), error);
      }
    }

    // Add user message
    this.messages.push({ role: "user", content: userMessage });

    // Save to memory
    if (this.enableMemory) {
      memory.addToSession({
        timestamp: Date.now(),
        role: "user",
        content: userMessage,
      });
    }

    let iteration = 0;
    let fullResponse = "";

    while (iteration < this.maxIterations) {
      iteration++;

      if (iteration > 1) {
        const iterationLabel = `Iteration ${iteration}/${this.maxIterations}`;
        if (timeline) {
          timeline.note(iterationLabel);
        } else {
          console.log(chalk.gray(`\n🔄 ${iterationLabel}`));
        }
      }

      // Get LLM response
      const previousPromptTokens = this.lastPromptTokens;
      const promptTokens = countMessageTokens(this.model, this.messages);
      this.sessionTracker?.trackPromptTokens(promptTokens);
      this.sessionTracker?.trackContextUsage(promptTokens);
      this.warnIfContextHigh(promptTokens);
      this.lastPromptTokens = promptTokens;

      let spinner: Ora | null = null;
      let thinkingTaskId: string | undefined;

      if (timeline) {
        thinkingTaskId = timeline.startTask("Thinking", {
          detail: `${this.providerType}:${this.model}`,
        });
      } else {
        spinner = ora({
          text: chalk.blue("Thinking..."),
          spinner: OCEAN_SPINNER,
        }).start();
      }

      let response = "";
      let streamStarted = false;
      let headerPrinted = false;

      const ensureConsoleHeader = () => {
        if (!headerPrinted) {
          console.log(chalk.green("\n🤖 MeerAI:\n"));
          headerPrinted = true;
        }
      };

      try {
        for await (const chunk of this.provider.stream(this.messages)) {
          if (!streamStarted) {
            streamStarted = true;
            if (timeline && thinkingTaskId) {
              timeline.succeed(thinkingTaskId, "Streaming response");
            } else if (spinner) {
              spinner.stop();
            }
            if (useUI) {
              if (!timeline) {
                onAssistantStart?.();
              }
            } else {
              ensureConsoleHeader();
            }
          }

          if (chunk?.trim()) {
            response += chunk;
            if (useUI) {
              onAssistantChunk?.(chunk);
            } else {
              process.stdout.write(chunk);
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
          }
        }

        if (!streamStarted) {
          response = await this.withTimeout(
            this.provider.chat(this.messages),
            this.chatTimeout,
            "LLM response"
          );
          if (timeline && thinkingTaskId) {
            timeline.succeed(thinkingTaskId, "Response ready");
          } else if (spinner) {
            spinner.stop();
          }

          if (useUI) {
            if (!timeline) {
              onAssistantStart?.();
            }
            onAssistantChunk?.(response);
            onAssistantEnd?.();
          } else {
            ensureConsoleHeader();
            console.log(response);
          }
        } else if (useUI) {
          onAssistantEnd?.();
        } else {
          console.log("\n");
        }
        const completionTokens = countTokens(this.model, response);
        this.sessionTracker?.trackCompletionTokens(completionTokens);

        // Display token and cost info for this response
        if (this.sessionTracker) {
          const promptDelta = Math.max(promptTokens - previousPromptTokens, 0);
          const firstTurn = previousPromptTokens === 0;
          const conversationalPromptTokens = firstTurn
            ? Math.max(promptTokens - this.basePromptTokens, 0)
            : promptDelta;
          const tokenUsage = this.sessionTracker.getTokenUsage();
          const costUsage = this.sessionTracker.getCostUsage();
          const headline = `Tokens: ${conversationalPromptTokens.toLocaleString()} in + ${completionTokens.toLocaleString()} out (this turn)`;
          const totals = `Session total: ${tokenUsage.prompt.toLocaleString()} in + ${tokenUsage.completion.toLocaleString()} out`;
          const systemPromptNote =
            firstTurn && this.basePromptTokens > 0
              ? ` • System prompt adds ${this.basePromptTokens.toLocaleString()} tokens upfront`
              : "";

          if (costUsage.total > 0) {
            const summary = `${headline} | Cost: ${costUsage.formatted.total} • ${totals}${systemPromptNote}`;
            if (timeline) {
              timeline.note(`?? ${summary}`);
            } else {
              console.log(chalk.dim(`\n?? ${summary}`));
            }
          } else {
            const summary = `${headline} • ${totals}${systemPromptNote}`;
            if (timeline) {
              timeline.note(`?? ${summary}`);
            } else {
              console.log(chalk.dim(`\n?? ${summary}`));
            }
          }
        }
      } catch (error) {
        if (spinner) {
          spinner.stop();
        }
        if (useUI && streamStarted) {
          onAssistantEnd?.();
        }

        const errorMsg = error instanceof Error ? error.message : String(error);

        if (timeline && thinkingTaskId) {
          timeline.fail(thinkingTaskId, errorMsg);
          timeline.error(`Error: ${errorMsg}`);
        } else {
          console.log(chalk.red(`\n❌ Error: ${errorMsg}`));
        }

        // Fail fast - no excessive retries
        if (errorMsg.includes("timeout") || errorMsg.includes("rate limit")) {
          if (timeline) {
            timeline.warn("Try again in a moment or check your API limits");
          } else {
            console.log(
              chalk.yellow(
                "💡 Try again in a moment or check your API limits"
              )
            );
          }
          break;
        }

        // Give LLM one chance to recover
        if (iteration === 1) {
          this.messages.push({
            role: "system",
            content: `Error occurred: ${errorMsg}. Please try a different approach.`
          });
          continue;
        }

        break; // Don't retry indefinitely
      }

      if (!response.trim()) {
        if (timeline) {
          timeline.warn("Received empty response");
        } else {
          console.log(chalk.yellow("⚠️ Received empty response"));
        }
        break;
      }

      fullResponse += response;

      // Parse tool calls
      const toolCalls = parseToolCalls(response);

      // No tool calls? We're done
      if (toolCalls.length === 0) {
        this.messages.push({ role: "assistant", content: response });

        if (this.enableMemory) {
          memory.addToSession({
            timestamp: Date.now(),
            role: "assistant",
            content: response,
            metadata: { provider: this.providerType, model: this.model },
          });
        }

        break;
      }

      // Execute tools
      if (timeline) {
        timeline.info(`Executing ${toolCalls.length} tool(s)`, {
          icon: "🔧",
        });
      } else {
        console.log(chalk.blue(`\n🔧 Executing ${toolCalls.length} tool(s)...`));
      }

      // Categorize tools into parallelizable and sequential
      const { parallelizable, sequential } = this.categorizeTools(toolCalls);
      const toolResults: string[] = [];

      // Track execution time for performance metrics
      const executionStartTime = Date.now();

      // Execute read operations in parallel
      if (parallelizable.length > 0) {
        if (timeline) {
          timeline.info(`Executing ${parallelizable.length} read operation(s) in parallel`, {
            icon: "⚡",
          });
        } else if (parallelizable.length > 1) {
          console.log(chalk.blue(`\n⚡ Executing ${parallelizable.length} read operations in parallel...`));
        }

        const parallelPromises = parallelizable.map(async (toolCall) => {
          let toolTaskId: string | undefined;
          if (timeline) {
            toolTaskId = timeline.startTask(toolCall.tool, {
              detail: "parallel",
            });
          } else {
            console.log(chalk.cyan(`\n  → ${toolCall.tool}`));
          }

          try {
            const result = await this.executeTool(toolCall);
            if (timeline && toolTaskId) {
              timeline.succeed(toolTaskId, "Done");
            } else {
              console.log(chalk.green(`  ✓ Done`));
            }
            return `Tool: ${toolCall.tool}\nResult: ${result}`;
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            if (timeline && toolTaskId) {
              timeline.fail(toolTaskId, errorMsg);
            } else {
              console.log(chalk.red(`  ✗ Failed: ${errorMsg}`));
            }
            return `Tool: ${toolCall.tool}\nError: ${errorMsg}`;
          }
        });

        const parallelResults = await Promise.all(parallelPromises);
        toolResults.push(...parallelResults);
      }

      // Execute write operations sequentially (for safety)
      if (sequential.length > 0) {
        if (timeline && sequential.length > 0) {
          timeline.info(`Executing ${sequential.length} write operation(s) sequentially`, {
            icon: "🔒",
          });
        }

        // Check if any of these are destructive operations that need a checkpoint
        const destructiveTools = new Set([
          'propose_edit', 'edit_section', 'edit_line', 'write_file',
          'delete_file', 'move_file', 'format_code', 'fix_lint',
          'organize_imports', 'rename_symbol', 'extract_function',
          'extract_variable', 'inline_variable', 'move_symbol',
          'convert_to_async'
        ]);

        const hasDestructiveOps = sequential.some(tc => destructiveTools.has(tc.tool));
        let checkpointCreated = false;

        // Create checkpoint before destructive operations
        if (hasDestructiveOps) {
          await this.transactionManager.createCheckpoint(`batch-edit-${Date.now()}`);
          checkpointCreated = this.transactionManager.hasActiveCheckpoint();
        }

        try {
          for (const toolCall of sequential) {
            let toolTaskId: string | undefined;
            if (timeline) {
              toolTaskId = timeline.startTask(toolCall.tool, {
                detail: "sequential",
              });
            } else {
              console.log(chalk.cyan(`\n  → ${toolCall.tool}`));
            }

            try {
              const result = await this.executeTool(toolCall);
              toolResults.push(`Tool: ${toolCall.tool}\nResult: ${result}`);
              if (timeline && toolTaskId) {
                timeline.succeed(toolTaskId, "Done");
              } else {
                console.log(chalk.green(`  ✓ Done`));
              }
            } catch (error) {
              const errorMsg = error instanceof Error ? error.message : String(error);
              toolResults.push(`Tool: ${toolCall.tool}\nError: ${errorMsg}`);
              if (timeline && toolTaskId) {
                timeline.fail(toolTaskId, errorMsg);
              } else {
                console.log(chalk.red(`  ✗ Failed: ${errorMsg}`));
              }

              // On critical error in destructive operation, rollback
              if (checkpointCreated && destructiveTools.has(toolCall.tool)) {
                const rolled = await this.transactionManager.rollback();
                if (rolled && timeline) {
                  timeline.warn('Rolled back changes due to error');
                }
                checkpointCreated = false; // Checkpoint consumed by rollback
                break; // Stop executing more tools after rollback
              }
            }
          }

          // Commit checkpoint if all operations succeeded
          if (checkpointCreated) {
            await this.transactionManager.commit();
          }
        } catch (error) {
          // Rollback on unexpected error
          if (checkpointCreated) {
            await this.transactionManager.rollback();
          }
          throw error;
        }
      }

      // Show performance metrics
      const executionDuration = Date.now() - executionStartTime;
      if (toolCalls.length > 1) {
        const metricsMsg = `⏱️ Tools executed in ${executionDuration}ms (${parallelizable.length} parallel, ${sequential.length} sequential)`;
        if (timeline) {
          timeline.note(metricsMsg);
        } else {
          console.log(chalk.dim(`\n${metricsMsg}`));
        }
      }

      // Add tool results to conversation
      this.messages.push({ role: "assistant", content: response });
      this.messages.push({
        role: "user",
        content: `Tool Results:\n\n${toolResults.join("\n\n")}`
      });
    }

    if (iteration >= this.maxIterations) {
      if (timeline) {
        timeline.warn("Reached maximum iterations");
      } else {
        console.log(chalk.yellow("\n⚠️ Reached maximum iterations"));
      }
    }

    // Run related tests if autoRunTests is enabled and files were edited
    if (autoRunTests && this.editedFiles.size > 0) {
      await this.runRelatedTests(timeline);
    }

    this.runWithTerminal = undefined;
    this.promptChoice = undefined;
    return fullResponse;
  }

  /**
   * Categorize tools into parallelizable (read operations) and sequential (write operations)
   */
  private categorizeTools(toolCalls: any[]): {
    parallelizable: any[];
    sequential: any[];
  } {
    // Tools that can run in parallel (read-only operations)
    const READ_TOOLS = new Set([
      'read_file',
      'list_files',
      'find_files',
      'grep',
      'search_text',
      'read_many_files',
      'read_folder',
      'git_status',
      'git_diff',
      'git_log',
      'git_blame',
      'analyze_project',
      'get_file_outline',
      'find_symbol_definition',
      'check_syntax',
      'explain_code',
      'check_complexity',
      'detect_smells',
      'find_references',
      'google_search',
      'web_fetch',
      'load_memory',
      'get_env',
      'list_env',
      'package_list',
      'show_plan',
      'validate_project',  // Can run in parallel with other reads
      'http_request',      // GET requests are safe to parallelize
    ]);

    // Tools that must run sequentially (write/destructive operations)
    const WRITE_TOOLS = new Set([
      'propose_edit',
      'edit_section',
      'edit_line',
      'write_file',
      'delete_file',
      'move_file',
      'create_directory',
      'git_commit',
      'git_branch',
      'run_command',
      'package_install',
      'package_run_script',
      'save_memory',
      'set_env',
      'format_code',
      'fix_lint',
      'organize_imports',
      'set_plan',
      'update_plan_task',
      'clear_plan',
      'rename_symbol',
      'extract_function',
      'extract_variable',
      'inline_variable',
      'move_symbol',
      'convert_to_async',
      'generate_tests',
      'generate_test_suite',
      'generate_mocks',
      'generate_api_docs',
      'generate_readme',
      'generate_docstring',
      'security_scan',
      'code_review',
      'dependency_audit',
      'run_tests',
      'analyze_coverage',
    ]);

    const parallelizable: any[] = [];
    const sequential: any[] = [];

    for (const toolCall of toolCalls) {
      // MCP tools are treated as sequential by default (safer)
      if (toolCall.tool.includes('.')) {
        sequential.push(toolCall);
      } else if (READ_TOOLS.has(toolCall.tool)) {
        parallelizable.push(toolCall);
      } else {
        // If not explicitly categorized, treat as sequential (safer)
        sequential.push(toolCall);
      }
    }

    return { parallelizable, sequential };
  }

  /**
   * Review and apply a single edit immediately
   */
  private async reviewSingleEdit(edit: FileEdit): Promise<boolean> {
    console.log(chalk.bold.yellow(`\n📝 ${edit.path}`));
    console.log(chalk.gray(`   ${edit.description}\n`));

    const diff = generateDiff(edit.oldContent, edit.newContent);
    if (diff.length > 0) {
      console.log(chalk.gray("┌─ Changes:"));
      await this.showDiff(diff);
    } else {
      console.log(chalk.green("   No textual diff (new or identical file)\n"));
    }

    console.log(
      chalk.yellow(
        "⚠️ Automatic file application is disabled. Apply these changes manually if you approve them.\n"
      )
    );

    return false;
  }

  private async executeTool(toolCall: any): Promise<string> {
    const { tool, params } = toolCall;

    // Import tools dynamically to avoid circular deps
    const tools = await import("../tools/index.js");

    switch (tool) {
      case "analyze_project":
        const analysis = tools.analyzeProject(this.cwd);
        return analysis.error ? analysis.error : analysis.result;

      case "read_file":
        const readResult = tools.readFile(params.path, this.cwd);
        return readResult.error ? readResult.error : readResult.result;

      case "list_files":
        const listResult = tools.listFiles(params.path || ".", this.cwd);
        return listResult.error ? listResult.error : listResult.result;

      case "propose_edit":
        const edit = tools.proposeEdit(
          params.path,
          toolCall.content || "",
          params.description || "Edit file",
          this.cwd
        );

        // Show diff and prompt for immediate approval
        const approved = await this.reviewSingleEdit(edit);

        if (approved) {
          // Track edited file for test awareness
          this.editedFiles.add(params.path);
          return `✅ Edit applied successfully to ${edit.path}`;
        } else {
          return `⏭️ Edit skipped for ${edit.path}. You can apply it manually later if needed.`;
        }

      case "edit_section": {
        // Preferred tool for editing existing files (avoids placeholders)
        const oldText = params.oldText || params.old_text || "";
        const newText = params.newText || params.new_text || "";
        const path = params.path || "";

        if (!path) {
          return "edit_section requires a path parameter.";
        }

        if (!oldText || !newText) {
          return "edit_section requires both oldText and newText parameters.\n\n" +
                 "Usage: edit_section(path='file.ts', oldText='exact match', newText='replacement')\n" +
                 "Hint: Use read_file first to get the exact text to replace.";
        }

        try {
          const sectionEdit = tools.editSection(
            path,
            oldText,
            newText,
            this.cwd,
            { validateSyntax: true }
          );

          // Show diff and prompt for approval
          const sectionApproved = await this.reviewSingleEdit(sectionEdit);

          if (sectionApproved) {
            // Track edited file for test awareness
            this.editedFiles.add(path);
            return `✅ Section edited successfully in ${sectionEdit.path}`;
          } else {
            return `⏭️ Edit skipped for ${sectionEdit.path}. You can apply it manually later if needed.`;
          }
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      }

      case "run_command": {
        const command =
          params.command !== undefined ? String(params.command) : "";
        if (!command) {
          return "run_command requires a command string.";
        }
        if (!(await this.confirmCommand(command))) {
          return `⚠️ Command cancelled: ${command}`;
        }
        const cmdResult = await tools.runCommand(command, this.cwd, params);
        return cmdResult.error ? cmdResult.error : cmdResult.result;
      }

      case "find_files":
        const findResult = tools.findFiles(
          params.pattern || "*",
          this.cwd,
          params
        );
        return findResult.error ? findResult.error : findResult.result;

      case "read_many_files":
        const files = params.files?.split(",").map((f: string) => f.trim()) || [];
        const readManyResult = tools.readManyFiles(files, this.cwd, params);
        return readManyResult.error ? readManyResult.error : readManyResult.result;

      case "search_text":
        const searchResult = tools.searchText(
          params.term || "",
          this.cwd,
          params
        );
        return searchResult.error ? searchResult.error : searchResult.result;

      case "read_folder":
        const folderResult = tools.readFolder(params.path || ".", this.cwd, params);
        return folderResult.error ? folderResult.error : folderResult.result;

      case "google_search":
        const searchRes = await tools.googleSearch(params.query || "", params);
        return searchRes.error ? searchRes.error : searchRes.result;

      case "web_fetch":
        const fetchRes = tools.webFetch(params.url || "", params);
        return fetchRes.error ? fetchRes.error : fetchRes.result;

      case "save_memory":
        const saveRes = tools.saveMemory(params.key || "", params.content || "", this.cwd);
        return saveRes.error ? saveRes.error : saveRes.result;

      case "load_memory":
        const loadRes = tools.loadMemory(params.key || "", this.cwd);
        return loadRes.error ? loadRes.error : loadRes.result;

      case "grep":
        const grepRes = tools.grep(
          params.path || "",
          params.pattern || "",
          this.cwd,
          params
        );
        return grepRes.error ? grepRes.error : grepRes.result;

      case "edit_line":
        try {
          const editLineResult = tools.editLine(
            params.path || "",
            parseInt(params.lineNumber || "0"),
            params.oldText || "",
            params.newText || "",
            this.cwd
          );

          // Show diff and prompt for immediate approval
          const lineApproved = await this.reviewSingleEdit(editLineResult);

          if (lineApproved) {
            // Track edited file for test awareness
            this.editedFiles.add(params.path || "");
            return `✅ Line edit applied successfully to ${editLineResult.path}`;
          } else {
            return `⏭️ Line edit skipped for ${editLineResult.path}. You can apply it manually later if needed.`;
          }
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }

      // Git tools
      case "git_status":
        const gitStatusRes = tools.gitStatus(this.cwd);
        return gitStatusRes.error ? gitStatusRes.error : gitStatusRes.result;

      case "git_diff":
        const gitDiffRes = tools.gitDiff(this.cwd, params);
        return gitDiffRes.error ? gitDiffRes.error : gitDiffRes.result;

      case "git_log":
        const gitLogRes = tools.gitLog(this.cwd, params);
        return gitLogRes.error ? gitLogRes.error : gitLogRes.result;

      case "git_commit":
        const gitCommitRes = tools.gitCommit(params.message || "", this.cwd, params);
        return gitCommitRes.error ? gitCommitRes.error : gitCommitRes.result;

      case "git_branch":
        const gitBranchRes = tools.gitBranch(this.cwd, params);
        return gitBranchRes.error ? gitBranchRes.error : gitBranchRes.result;

      // File operation tools
      case "write_file": {
        const targetPath =
          typeof params.path === "string" ? params.path.trim() : "";
        if (!targetPath) {
          return "write_file requires a path.";
        }

        const content =
          typeof toolCall.content === "string" ? toolCall.content : "";
        if (!content) {
          return "write_file requires content in the tool call.";
        }

        try {
          const edit = tools.proposeEdit(
            targetPath,
            content,
            params.description || "Write file",
            this.cwd
          );

          const approved = await this.reviewSingleEdit(edit);

          if (approved) {
            // Track edited file for test awareness
            this.editedFiles.add(targetPath);
            return `✅ File write applied to ${edit.path}`;
          }
          return `⏭️ File write skipped for ${edit.path}. You can apply it manually later if needed.`;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      }

      case "delete_file": {
        const targetPath =
          typeof params.path === "string" ? params.path.trim() : "";
        if (!targetPath) {
          return "delete_file requires a path.";
        }

        if (!(await this.confirmToolAction(`Delete file ${targetPath}?`))) {
          return `⚠️ Delete cancelled: ${targetPath}`;
        }

        const deleteRes = tools.deleteFile(targetPath, this.cwd);
        return deleteRes.error ? deleteRes.error : deleteRes.result;
      }

      case "move_file": {
        const source =
          typeof params.source === "string" ? params.source.trim() : "";
        const dest =
          typeof params.dest === "string" ? params.dest.trim() : "";

        if (!source || !dest) {
          return "move_file requires both source and dest paths.";
        }

        if (
          !(await this.confirmToolAction(`Move ${source} → ${dest}?`))
        ) {
          return `⚠️ Move cancelled: ${source} → ${dest}`;
        }

        const moveRes = tools.moveFile(source, dest, this.cwd);
        return moveRes.error ? moveRes.error : moveRes.result;
      }

      case "create_directory": {
        const dirPath =
          typeof params.path === "string" ? params.path.trim() : "";
        if (!dirPath) {
          return "create_directory requires a path.";
        }

        if (
          !(await this.confirmToolAction(`Create directory ${dirPath}?`))
        ) {
          return `⚠️ Directory creation cancelled: ${dirPath}`;
        }

        const mkdirRes = tools.createDirectory(dirPath, this.cwd);
        return mkdirRes.error ? mkdirRes.error : mkdirRes.result;
      }

      // Package manager tools
      case "package_install": {
        const packages =
          params.packages
            ?.split(",")
            .map((p: string) => p.trim())
            .filter(Boolean) || [];

        if (packages.length === 0) {
          return "package_install requires one or more packages.";
        }

        const scopeLabel = params.global ? "globally" : "locally";
        const packageLabel = packages.join(", ");
        if (
          !(await this.confirmToolAction(
            `Install ${packageLabel} ${scopeLabel}?`
          ))
        ) {
          return `⚠️ Package install cancelled: ${packageLabel}`;
        }

        const pkgInstallRes = tools.packageInstall(packages, this.cwd, params);
        return pkgInstallRes.error ? pkgInstallRes.error : pkgInstallRes.result;
      }

      case "package_run_script": {
        const script =
          typeof params.script === "string" ? params.script.trim() : "";
        if (!script) {
          return "package_run_script requires a script name.";
        }

        if (
          !(await this.confirmToolAction(`Run package script "${script}"?`))
        ) {
          return `⚠️ Package script cancelled: ${script}`;
        }

        const pkgRunRes = tools.packageRunScript(script, this.cwd, params);
        return pkgRunRes.error ? pkgRunRes.error : pkgRunRes.result;
      }

      case "package_list":
        const pkgListRes = tools.packageList(this.cwd, params);
        return pkgListRes.error ? pkgListRes.error : pkgListRes.result;

      // Environment variable tools
      case "get_env":
        const getEnvRes = tools.getEnv(params.key || "", this.cwd);
        return getEnvRes.error ? getEnvRes.error : getEnvRes.result;

      case "set_env": {
        const key = params.key || "";
        const value = params.value || "";
        if (!key) {
          return "set_env requires a key.";
        }

        if (!(await this.confirmToolAction(`Set environment variable ${key}=${value}?`))) {
          return `⚠️ Environment variable modification cancelled: ${key}`;
        }

        const setEnvRes = tools.setEnv(key, value, this.cwd);
        return setEnvRes.error ? setEnvRes.error : setEnvRes.result;
      }

      case "list_env":
        const listEnvRes = tools.listEnv(this.cwd);
        return listEnvRes.error ? listEnvRes.error : listEnvRes.result;

      // HTTP request tool
      case "http_request":
        const httpRes = await tools.httpRequest(params.url || "", params);
        return httpRes.error ? httpRes.error : httpRes.result;

      // Code intelligence tools
      case "get_file_outline":
        const outlineRes = tools.getFileOutline(params.path || "", this.cwd);
        return outlineRes.error ? outlineRes.error : outlineRes.result;

      case "find_symbol_definition":
        const symbolRes = tools.findSymbolDefinition(params.symbol || "", this.cwd, params);
        return symbolRes.error ? symbolRes.error : symbolRes.result;

      case "check_syntax":
        const syntaxRes = tools.checkSyntax(params.path || "", this.cwd);
        return syntaxRes.error ? syntaxRes.error : syntaxRes.result;

      // Project validation tool
      case "validate_project":
        const validateRes = tools.validateProject(this.cwd, params);
        return validateRes.error ? validateRes.error : validateRes.result;

      // Planning tools
      case "set_plan":
        const setPlanRes = tools.setPlan(
          params.title || "Task Plan",
          params.tasks || [],
          this.cwd
        );
        return setPlanRes.error ? setPlanRes.error : setPlanRes.result;

      case "update_plan_task":
        const updateTaskRes = tools.updatePlanTask(
          params.taskId || "",
          params.status || "pending",
          params.notes
        );
        return updateTaskRes.error ? updateTaskRes.error : updateTaskRes.result;

      case "show_plan":
        const showPlanRes = tools.showPlan();
        return showPlanRes.error ? showPlanRes.error : showPlanRes.result;

      case "clear_plan":
        const clearPlanRes = tools.clearPlan();
        return clearPlanRes.error ? clearPlanRes.error : clearPlanRes.result;

      // Code explanation and documentation tools
      case "explain_code":
        const explainRes = tools.explainCode(params.path || "", this.cwd, params);
        return explainRes.error ? explainRes.error : explainRes.result;

      case "generate_docstring":
        const docstringRes = tools.generateDocstring(params.path || "", this.cwd, params);
        return docstringRes.error ? docstringRes.error : docstringRes.result;

      // Code quality and testing tools
      case "format_code": {
        const path = params.path || "";
        if (!path) {
          return "format_code requires a path.";
        }

        if (!(await this.confirmToolAction(`Format code in ${path}?`))) {
          return `⚠️ Code formatting cancelled: ${path}`;
        }

        const formatRes = tools.formatCode(path, this.cwd, params);
        return formatRes.error ? formatRes.error : formatRes.result;
      }

      case "dependency_audit":
        const auditRes = tools.dependencyAudit(this.cwd, params);
        return auditRes.error ? auditRes.error : auditRes.result;

      case "run_tests":
        const testRes = tools.runTests(this.cwd, params);
        return testRes.error ? testRes.error : testRes.result;

      case "generate_tests":
        const genTestsRes = tools.generateTests(params.path || "", this.cwd, params);
        return genTestsRes.error ? genTestsRes.error : genTestsRes.result;

      case "security_scan":
        const securityRes = tools.securityScan(params.path || "", this.cwd, params);
        return securityRes.error ? securityRes.error : securityRes.result;

      case "code_review":
        const reviewRes = tools.codeReview(params.path || "", this.cwd, params);
        return reviewRes.error ? reviewRes.error : reviewRes.result;

      case "generate_readme":
        const readmeRes = tools.generateReadme(this.cwd, params);
        return readmeRes.error ? readmeRes.error : readmeRes.result;

      case "fix_lint": {
        const path = params.path || "";
        if (!path) {
          return "fix_lint requires a path.";
        }

        if (!(await this.confirmToolAction(`Auto-fix lint issues in ${path}?`))) {
          return `⚠️ Lint fix cancelled: ${path}`;
        }

        const fixLintRes = tools.fixLint(path, this.cwd, params);
        return fixLintRes.error ? fixLintRes.error : fixLintRes.result;
      }

      case "organize_imports": {
        const path = params.path || "";
        if (!path) {
          return "organize_imports requires a path.";
        }

        if (!(await this.confirmToolAction(`Organize imports in ${path}?`))) {
          return `⚠️ Import organization cancelled: ${path}`;
        }

        const organizeRes = tools.organizeImports(path, this.cwd, params);
        return organizeRes.error ? organizeRes.error : organizeRes.result;
      }

      case "check_complexity":
        const complexityRes = tools.checkComplexity(params.path || "", this.cwd, params);
        return complexityRes.error ? complexityRes.error : complexityRes.result;

      case "detect_smells":
        const smellsRes = tools.detectSmells(params.path || "", this.cwd, params);
        return smellsRes.error ? smellsRes.error : smellsRes.result;

      case "analyze_coverage":
        const coverageRes = tools.analyzeCoverage(this.cwd, params);
        return coverageRes.error ? coverageRes.error : coverageRes.result;

      case "find_references":
        const referencesRes = tools.findReferences(params.symbol || "", this.cwd, params);
        return referencesRes.error ? referencesRes.error : referencesRes.result;

      case "generate_test_suite":
        const testSuiteRes = tools.generateTestSuite(params.path || "", this.cwd, params);
        return testSuiteRes.error ? testSuiteRes.error : testSuiteRes.result;

      case "generate_mocks":
        const mocksRes = tools.generateMocks(params.path || "", this.cwd, params);
        return mocksRes.error ? mocksRes.error : mocksRes.result;

      case "generate_api_docs":
        const apiDocsRes = tools.generateApiDocs(params.path || "", this.cwd, params);
        return apiDocsRes.error ? apiDocsRes.error : apiDocsRes.result;

      case "git_blame":
        const blameRes = tools.gitBlame(params.path || "", this.cwd, params);
        return blameRes.error ? blameRes.error : blameRes.result;

      case "rename_symbol": {
        const oldName = params.oldName || "";
        const newName = params.newName || "";
        if (!oldName || !newName) {
          return "rename_symbol requires both oldName and newName.";
        }

        if (!(await this.confirmToolAction(`Rename symbol ${oldName} → ${newName} across codebase?`))) {
          return `⚠️ Symbol rename cancelled: ${oldName} → ${newName}`;
        }

        const renameRes = tools.renameSymbol(oldName, newName, this.cwd, params);
        return renameRes.error ? renameRes.error : renameRes.result;
      }

      case "extract_function": {
        const filePath = params.filePath || "";
        const functionName = params.functionName || "";
        const startLine = parseInt(params.startLine || "0");
        const endLine = parseInt(params.endLine || "0");

        if (!filePath || !functionName || !startLine || !endLine) {
          return "extract_function requires filePath, startLine, endLine, and functionName.";
        }

        if (!(await this.confirmToolAction(`Extract function "${functionName}" from ${filePath} (lines ${startLine}-${endLine})?`))) {
          return `⚠️ Function extraction cancelled: ${functionName}`;
        }

        const extractFnRes = tools.extractFunction(
          filePath,
          startLine,
          endLine,
          functionName,
          this.cwd,
          params
        );
        return extractFnRes.error ? extractFnRes.error : extractFnRes.result;
      }

      case "extract_variable": {
        const filePath = params.filePath || "";
        const variableName = params.variableName || "";
        const expression = params.expression || "";
        const lineNumber = parseInt(params.lineNumber || "0");

        if (!filePath || !variableName || !expression || !lineNumber) {
          return "extract_variable requires filePath, lineNumber, expression, and variableName.";
        }

        if (!(await this.confirmToolAction(`Extract variable "${variableName}" from ${filePath}:${lineNumber}?`))) {
          return `⚠️ Variable extraction cancelled: ${variableName}`;
        }

        const extractVarRes = tools.extractVariable(
          filePath,
          lineNumber,
          expression,
          variableName,
          this.cwd,
          params
        );
        return extractVarRes.error ? extractVarRes.error : extractVarRes.result;
      }

      case "inline_variable": {
        const filePath = params.filePath || "";
        const variableName = params.variableName || "";

        if (!filePath || !variableName) {
          return "inline_variable requires filePath and variableName.";
        }

        if (!(await this.confirmToolAction(`Inline variable "${variableName}" in ${filePath}?`))) {
          return `⚠️ Variable inlining cancelled: ${variableName}`;
        }

        const inlineVarRes = tools.inlineVariable(
          filePath,
          variableName,
          this.cwd,
          params
        );
        return inlineVarRes.error ? inlineVarRes.error : inlineVarRes.result;
      }

      case "move_symbol": {
        const symbolName = params.symbolName || "";
        const fromFile = params.fromFile || "";
        const toFile = params.toFile || "";

        if (!symbolName || !fromFile || !toFile) {
          return "move_symbol requires symbolName, fromFile, and toFile.";
        }

        if (!(await this.confirmToolAction(`Move symbol "${symbolName}" from ${fromFile} → ${toFile}?`))) {
          return `⚠️ Symbol move cancelled: ${symbolName}`;
        }

        const moveSymbolRes = tools.moveSymbol(
          symbolName,
          fromFile,
          toFile,
          this.cwd,
          params
        );
        return moveSymbolRes.error ? moveSymbolRes.error : moveSymbolRes.result;
      }

      case "convert_to_async": {
        const filePath = params.filePath || "";
        const functionName = params.functionName || "";

        if (!filePath || !functionName) {
          return "convert_to_async requires filePath and functionName.";
        }

        if (!(await this.confirmToolAction(`Convert function "${functionName}" to async in ${filePath}?`))) {
          return `⚠️ Async conversion cancelled: ${functionName}`;
        }

        const convertAsyncRes = tools.convertToAsync(
          filePath,
          functionName,
          this.cwd,
          params
        );
        return convertAsyncRes.error ? convertAsyncRes.error : convertAsyncRes.result;
      }

      default:
        // Try MCP tools
        if (tool.includes(".")) {
          const result = await this.mcpManager.executeTool(tool, params);
          return typeof result.content === "string"
            ? result.content
            : JSON.stringify(result.content, null, 2);
        }
        return `Unknown tool: ${tool}`;
    }
  }

  private getSystemPrompt(): string {
    return buildAgentSystemPrompt({
      cwd: this.cwd,
      mcpTools: this.mcpTools,
    });
  }

  private warnIfContextHigh(tokens: number) {
    if (!this.contextLimit) return;

    const usage = tokens / this.contextLimit;
    if (usage > 0.9) {
      console.log(chalk.red(`\n⚠️ Context usage very high: ${(usage * 100).toFixed(0)}%`));
    } else if (usage > 0.7) {
      console.log(chalk.yellow(`\n⚠️ Context usage: ${(usage * 100).toFixed(0)}%`));
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    operation: string
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout: ${operation} exceeded ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  }

  /**
   * Display a diff with pagination support
   */
  private async showDiff(diffLines: string[]): Promise<void> {
    if (diffLines.length === 0) {
      console.log(chalk.green("   No textual diff (new or identical file)\n"));
      return;
    }

    const maxLines = 50; // Show max 50 lines at once

    if (diffLines.length <= maxLines) {
      // Small diff, show it all
      diffLines.forEach((line) => console.log(line));
      console.log(chalk.gray("└─\n"));
    } else {
      // Large diff, paginate
      diffLines.slice(0, maxLines).forEach((line) => console.log(line));
      console.log(chalk.gray(`└─ ... and ${diffLines.length - maxLines} more lines\n`));

      let showMore: boolean;
      if (this.promptChoice) {
        const choice = await this.promptChoice(
          `Show remaining ${diffLines.length - maxLines} lines?`,
          [
            { label: "Yes, show all", value: "yes" },
            { label: "No, keep hidden", value: "no" },
          ],
          "no"
        );
        showMore = choice === "yes";
      } else {
        const result = await this.runInteractivePrompt(() =>
          inquirer.prompt([
            {
              type: "confirm",
              name: "showMore",
              message: `Show remaining ${diffLines.length - maxLines} lines?`,
              default: false,
            },
          ])
        );
        showMore = result.showMore;
      }

      if (showMore) {
        diffLines.slice(maxLines).forEach((line) => console.log(line));
        console.log(chalk.gray("└─\n"));
      }
    }
  }

  private async runInteractivePrompt<T>(
    task: () => Promise<T>
  ): Promise<T> {
    if (this.runWithTerminal) {
      return this.runWithTerminal(task);
    }
    return task();
  }

  private async confirmToolAction(
    message: string,
    defaultChoice: "confirm" | "cancel" = "cancel"
  ): Promise<boolean> {
    if (this.promptChoice) {
      const choice = await this.promptChoice(
        message,
        [
          { label: "Confirm", value: "confirm" },
          { label: "Cancel", value: "cancel" },
        ],
        defaultChoice
      );
      return choice === "confirm";
    }

    const result = await this.runInteractivePrompt(() =>
      inquirer.prompt([
        {
          type: "list",
          name: "action",
          message,
          choices: [
            { name: "Confirm", value: "confirm" },
            { name: "Cancel", value: "cancel" },
          ],
          default: defaultChoice,
        },
      ])
    );

    return result.action === "confirm";
  }

  private async confirmCommand(command: string): Promise<boolean> {
    if (this.promptChoice) {
      const choice = await this.promptChoice(
        `Run shell command: ${command}`,
        [
          { label: "Run command", value: "run" },
          { label: "Cancel", value: "cancel" },
        ],
        "run"
      );
      return choice === "run";
    }

    console.log(chalk.bold.yellow(`\n[Command] preview`));
    console.log(chalk.gray(`   ${command}\n`));

    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: `Run "${command}"?`,
        choices: [
          { name: "Run command", value: "run" },
          { name: "Cancel", value: "cancel" },
        ],
        default: "run",
      },
    ]);

    if (action === "run") {
      return true;
    }

    console.log(chalk.yellow(`\n[Command] cancelled: ${command}\n`));
    return false;
  }

  /**
   * Run related tests for all edited files
   */
  private async runRelatedTests(timeline?: Timeline): Promise<void> {
    const testFiles = new Set<string>();

    // Collect all test files related to edited source files
    for (const file of this.editedFiles) {
      // Skip if edited file is itself a test file
      if (this.testDetector.isTestFile(file)) {
        continue;
      }

      const related = this.testDetector.findRelatedTests(file);
      related.forEach(t => testFiles.add(t));
    }

    if (testFiles.size === 0) {
      if (timeline) {
        timeline.note('ℹ️ No related tests found for edited files');
      } else {
        console.log(chalk.gray('\nℹ️ No related tests found for edited files'));
      }
      return;
    }

    const testCount = testFiles.size;
    const testLabel = testCount === 1 ? 'test' : 'tests';

    if (timeline) {
      timeline.info(`Running ${testCount} related ${testLabel}`, { icon: '🧪' });
    } else {
      console.log(chalk.blue(`\n🧪 Running ${testCount} related ${testLabel}...`));
    }

    // Detect test framework
    const framework = this.testDetector.detectFramework();
    if (!framework) {
      if (timeline) {
        timeline.warn('No test framework detected');
      } else {
        console.log(chalk.yellow('⚠️ No test framework detected'));
      }
      return;
    }

    // Build test command
    const testCommand = this.testDetector.getTestCommand(
      framework,
      Array.from(testFiles)
    );

    if (!testCommand) {
      if (timeline) {
        timeline.warn(`Unable to build test command for framework: ${framework}`);
      } else {
        console.log(chalk.yellow(`⚠️ Unable to build test command for framework: ${framework}`));
      }
      return;
    }

    // Run tests with timeout
    let testTaskId: string | undefined;
    if (timeline) {
      testTaskId = timeline.startTask('Running tests', {
        detail: framework,
      });
    }

    try {
      const tools = await import('../tools/index.js');
      const result = await tools.runCommand(testCommand, this.cwd, { timeoutMs: 30000 });

      if (result.error) {
        if (timeline && testTaskId) {
          timeline.fail(testTaskId, 'Tests failed');
          timeline.error(`❌ Tests failed:\n${result.error}`);
        } else {
          console.log(chalk.red('\n❌ Tests failed:'));
          console.log(result.error);
        }
      } else {
        if (timeline && testTaskId) {
          timeline.succeed(testTaskId, 'Tests passed');
        } else {
          console.log(chalk.green('\n✅ Tests passed'));
          if (result.result) {
            console.log(chalk.gray(result.result));
          }
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (timeline && testTaskId) {
        timeline.fail(testTaskId, errorMsg);
      } else {
        console.log(chalk.yellow('\n⚠️ Could not run tests:'), errorMsg);
      }
    }
  }

}

