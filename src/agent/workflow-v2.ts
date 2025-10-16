import chalk from "chalk";
import ora, { type Ora } from "ora";
import inquirer from "inquirer";
import type { Provider, ChatMessage } from "../providers/base.js";
import { parseToolCalls, type FileEdit, applyEdit, generateDiff } from "../tools/index.js";
import { memory } from "../memory/index.js";
import { logVerbose } from "../logger.js";
import { MCPManager } from "../mcp/manager.js";
import type { MCPTool } from "../mcp/types.js";
import type { SessionTracker } from "../session/tracker.js";
import { countTokens, countMessageTokens, getContextLimit } from "../token/utils.js";
import type { Timeline } from "../ui/workflowTimeline.js";
import { buildAgentSystemPrompt } from "./prompts/systemPrompt.js";

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

    if (this.contextLimit) {
      this.sessionTracker?.setContextLimit(this.contextLimit);
    }
  }

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
    }
  ): Promise<string> {
    const timeline = options?.timeline;
    const onAssistantStart = options?.onAssistantStart;
    const onAssistantChunk = options?.onAssistantChunk;
    const onAssistantEnd = options?.onAssistantEnd;
    const useUI = Boolean(onAssistantChunk);
    this.runWithTerminal = options?.withTerminal;
    this.promptChoice = options?.promptChoice;

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
      const promptTokens = countMessageTokens(this.model, this.messages);
      this.sessionTracker?.trackPromptTokens(promptTokens);
      this.sessionTracker?.trackContextUsage(promptTokens);
      this.warnIfContextHigh(promptTokens);

      let spinner: Ora | null = null;
      let thinkingTaskId: string | undefined;

      if (timeline) {
        thinkingTaskId = timeline.startTask("Thinking", {
          detail: `${this.providerType}:${this.model}`,
        });
      } else {
        spinner = ora({
          text: chalk.blue("Thinking..."),
          spinner: "dots",
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
          const tokenUsage = this.sessionTracker.getTokenUsage();
          const costUsage = this.sessionTracker.getCostUsage();

          if (costUsage.total > 0) {
            const summary = `Tokens: ${promptTokens.toLocaleString()} in + ${completionTokens.toLocaleString()} out | Cost: ${costUsage.formatted.total} (session total)`;
            if (timeline) {
              timeline.note(`💰 ${summary}`);
            } else {
              console.log(chalk.dim(`\n💰 ${summary}`));
            }
          } else {
            const summary = `Tokens: ${promptTokens.toLocaleString()} in + ${completionTokens.toLocaleString()} out`;
            if (timeline) {
              timeline.note(`💰 ${summary}`);
            } else {
              console.log(chalk.dim(`\n💰 ${summary}`));
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

      const toolResults: string[] = [];
      for (const toolCall of toolCalls) {
        let toolTaskId: string | undefined;
        if (timeline) {
          toolTaskId = timeline.startTask(toolCall.tool, {
            detail: "running",
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

    this.runWithTerminal = undefined;
    this.promptChoice = undefined;
    return fullResponse;
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

    let action: string;
    if (this.promptChoice) {
      action = await this.promptChoice(
        `Apply changes to ${edit.path}?`,
        [
          { label: "Apply", value: "apply" },
          { label: "Skip", value: "skip" },
        ],
        "apply"
      );
    } else {
      const result = await this.runInteractivePrompt(() =>
        inquirer.prompt([
          {
            type: "list",
            name: "action",
            message: `Apply changes to ${edit.path}?`,
            choices: [
              { name: "Apply", value: "apply" },
              { name: "Skip", value: "skip" },
            ],
            default: "apply",
          },
        ])
      );
      action = result.action;
    }

    if (action === "apply") {
      const result = applyEdit(edit, this.cwd);
      if (result.error) {
        console.log(chalk.red(`\n❌ ${result.error}\n`));
        return false;
      } else {
        console.log(chalk.green(`\n✅ ${result.result}\n`));
        return true;
      }
    } else {
      console.log(chalk.yellow(`\n⏭️  Skipped ${edit.path}\n`));
      return false;
    }
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
          return `✅ Edit applied successfully to ${edit.path}`;
        } else {
          return `⏭️ Edit skipped for ${edit.path}. You can apply it manually later if needed.`;
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
        const searchRes = tools.googleSearch(params.query || "", params);
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
      case "write_file":
        const writeRes = tools.writeFile(params.path || "", toolCall.content || "", this.cwd);
        return writeRes.error ? writeRes.error : writeRes.result;

      case "delete_file":
        const deleteRes = tools.deleteFile(params.path || "", this.cwd);
        return deleteRes.error ? deleteRes.error : deleteRes.result;

      case "move_file":
        const moveRes = tools.moveFile(params.source || "", params.dest || "", this.cwd);
        return moveRes.error ? moveRes.error : moveRes.result;

      case "create_directory":
        const mkdirRes = tools.createDirectory(params.path || "", this.cwd);
        return mkdirRes.error ? mkdirRes.error : mkdirRes.result;

      // Package manager tools
      case "package_install":
        const packages = params.packages?.split(",").map((p: string) => p.trim()) || [];
        const pkgInstallRes = tools.packageInstall(packages, this.cwd, params);
        return pkgInstallRes.error ? pkgInstallRes.error : pkgInstallRes.result;

      case "package_run_script":
        const pkgRunRes = tools.packageRunScript(params.script || "", this.cwd, params);
        return pkgRunRes.error ? pkgRunRes.error : pkgRunRes.result;

      case "package_list":
        const pkgListRes = tools.packageList(this.cwd, params);
        return pkgListRes.error ? pkgListRes.error : pkgListRes.result;

      // Environment variable tools
      case "get_env":
        const getEnvRes = tools.getEnv(params.key || "", this.cwd);
        return getEnvRes.error ? getEnvRes.error : getEnvRes.result;

      case "set_env":
        const setEnvRes = tools.setEnv(params.key || "", params.value || "", this.cwd);
        return setEnvRes.error ? setEnvRes.error : setEnvRes.result;

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
      case "format_code":
        const formatRes = tools.formatCode(params.path || "", this.cwd, params);
        return formatRes.error ? formatRes.error : formatRes.result;

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

      case "fix_lint":
        const fixLintRes = tools.fixLint(params.path || "", this.cwd, params);
        return fixLintRes.error ? fixLintRes.error : fixLintRes.result;

      case "organize_imports":
        const organizeRes = tools.organizeImports(params.path || "", this.cwd, params);
        return organizeRes.error ? organizeRes.error : organizeRes.result;

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

      case "rename_symbol":
        const renameRes = tools.renameSymbol(params.oldName || "", params.newName || "", this.cwd, params);
        return renameRes.error ? renameRes.error : renameRes.result;

      case "extract_function":
        const extractFnRes = tools.extractFunction(
          params.filePath || "",
          parseInt(params.startLine || "0"),
          parseInt(params.endLine || "0"),
          params.functionName || "",
          this.cwd,
          params
        );
        return extractFnRes.error ? extractFnRes.error : extractFnRes.result;

      case "extract_variable":
        const extractVarRes = tools.extractVariable(
          params.filePath || "",
          parseInt(params.lineNumber || "0"),
          params.expression || "",
          params.variableName || "",
          this.cwd,
          params
        );
        return extractVarRes.error ? extractVarRes.error : extractVarRes.result;

      case "inline_variable":
        const inlineVarRes = tools.inlineVariable(
          params.filePath || "",
          params.variableName || "",
          this.cwd,
          params
        );
        return inlineVarRes.error ? inlineVarRes.error : inlineVarRes.result;

      case "move_symbol":
        const moveSymbolRes = tools.moveSymbol(
          params.symbolName || "",
          params.fromFile || "",
          params.toFile || "",
          this.cwd,
          params
        );
        return moveSymbolRes.error ? moveSymbolRes.error : moveSymbolRes.result;

      case "convert_to_async":
        const convertAsyncRes = tools.convertToAsync(
          params.filePath || "",
          params.functionName || "",
          this.cwd,
          params
        );
        return convertAsyncRes.error ? convertAsyncRes.error : convertAsyncRes.result;

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

}
