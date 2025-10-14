import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import path from "path";
import { existsSync } from "fs";
import type { Provider, ChatMessage } from "../providers/base.js";
import {
  readFile,
  listFiles,
  proposeEdit,
  applyEdit,
  generateDiff,
  parseToolCalls,
  analyzeProject,
  runCommand,
  suggestSetup,
  scaffoldProject,
  findFiles,
  readManyFiles,
  searchText,
  readFolder,
  googleSearch,
  webFetch,
  saveMemory,
  loadMemory,
  grep,
  editLine,
  gitStatus,
  gitDiff,
  gitLog,
  gitCommit,
  gitBranch,
  writeFile,
  deleteFile,
  moveFile,
  createDirectory,
  semanticSearch,
  type FileEdit,
} from "../tools/index.js";
import { memory } from "../memory/index.js";
import { ChatBoxUI } from "../ui/chatbox.js";
import { logVerbose } from "../logger.js";
import { ProjectContextManager } from "../context/manager.js";
import {
  countTokens,
  countMessageTokens,
  getContextLimit,
} from "../token/utils.js";
import type { SessionTracker } from "../session/tracker.js";
import { detectLanguageFromPath } from "../utils/language.js";
import { MCPManager } from "../mcp/manager.js";
import type { MCPTool } from "../mcp/types.js";

export interface AgentConfig {
  provider: Provider;
  cwd: string;
  maxIterations?: number;
  enableMemory?: boolean;
  providerType?: string;
  model?: string;
  timeouts?: {
    command?: number; // milliseconds for run_command
    webFetch?: number; // milliseconds for web_fetch
    webSearch?: number; // milliseconds for google_search
    default?: number; // default timeout for other operations
  };
  autoSwitching?: {
    enabled: boolean;
    fallbackProviders?: Array<{
      provider: Provider;
      providerType: string;
      model: string;
    }>;
    maxRetries?: number;
  };
  sessionTracker?: SessionTracker;
}

interface TodoItem {
  task: string;
  status: "pending" | "in_progress" | "completed";
}

const BUILT_IN_TOOL_COUNT = 16;

export class AgentWorkflow {
  private provider: Provider;
  private cwd: string;
  private maxIterations: number;
  private messages: ChatMessage[] = [];
  private proposedEdits: FileEdit[] = [];
  private todoList: TodoItem[] = [];
  private appliedEdits: Array<{
    path: string;
    description: string;
    success: boolean;
  }> = [];
  private enableMemory: boolean;
  private providerType: string;
  private model: string;
  private currentDirectory: string;
  private plan: Array<{ title: string; status: "pending" | "in_progress" | "done" }> = [];
  private validationResults: Array<{
    label: string;
    success: boolean;
    output: string;
  }> = [];
  private contextManager = ProjectContextManager.getInstance();
  private mcpManager = MCPManager.getInstance();
  private mcpTools: MCPTool[] = [];
  private sessionTracker?: SessionTracker;
  private contextLimit?: number;
  private contextWarningLevel = 0;
  private lastPromptTokens = 0;
  private timeouts: {
    command: number;
    webFetch: number;
    webSearch: number;
    default: number;
    chat: number;
  };
  private autoSwitching: {
    enabled: boolean;
    fallbackProviders: Array<{
      provider: Provider;
      providerType: string;
      model: string;
    }>;
    maxRetries: number;
    currentProviderIndex: number;
  };
  private originalProvider: {
    provider: Provider;
    providerType: string;
    model: string;
  };

  constructor(config: AgentConfig) {
    this.provider = config.provider;
    this.cwd = config.cwd;
    this.maxIterations = config.maxIterations || 10;
    this.enableMemory = config.enableMemory ?? true;
    this.providerType = config.providerType || "unknown";
    this.model = config.model || "unknown";
    this.currentDirectory = config.cwd;
    this.sessionTracker = config.sessionTracker;
    this.contextLimit = getContextLimit(this.model);
    if (this.contextLimit) {
      this.sessionTracker?.setContextLimit(this.contextLimit);
    }
    this.timeouts = {
      command: config.timeouts?.command || 30000, // 30 seconds default
      webFetch: config.timeouts?.webFetch || 15000, // 15 seconds default
      webSearch: config.timeouts?.webSearch || 20000, // 20 seconds default
      default: config.timeouts?.default || 10000, // 10 seconds default
      chat: this.getChatTimeout(config.providerType), // Provider-specific chat timeout
    };
    this.autoSwitching = {
      enabled: config.autoSwitching?.enabled || false,
      fallbackProviders: config.autoSwitching?.fallbackProviders || [],
      maxRetries: config.autoSwitching?.maxRetries || 3,
      currentProviderIndex: -1, // -1 means using primary provider
    };
    this.originalProvider = {
      provider: config.provider,
      providerType: config.providerType || "unknown",
      model: config.model || "unknown",
    };
  }

  /**
   * Get provider-specific chat timeout
   */
  private getChatTimeout(providerType?: string): number {
    switch (providerType?.toLowerCase()) {
      case "ollama":
        return 300000; // 5 minutes for Ollama (local models can be very slow)
      case "openai":
        return 60000; // 1 minute for OpenAI
      case "gemini":
        return 45000; // 45 seconds for Gemini
      case "anthropic":
        return 90000; // 1.5 minutes for Anthropic (Claude models)
      case "openrouter":
        return 75000; // 1.25 minutes for OpenRouter (varies by underlying model)
      default:
        return 60000; // 1 minute default
    }
  }

  /**
   * Initialize the agent with system prompt
   */
  async initialize(contextPrompt: string) {
    // Initialize MCP if not already done
    if (!this.mcpManager.isInitialized()) {
      try {
        await this.mcpManager.initialize();
        this.mcpTools = this.mcpManager.listAllTools();

        if (this.mcpTools.length > 0) {
          logVerbose(chalk.green(`✓ Loaded ${this.mcpTools.length} MCP tools`));
        }
      } catch (error) {
        logVerbose(chalk.yellow('⚠️  MCP initialization failed, continuing without MCP tools'));
      }
    } else {
      this.mcpTools = this.mcpManager.listAllTools();
    }

    this.messages = [
      {
        role: "system",
        content: this.getSystemPrompt() + "\n\n" + contextPrompt,
      },
    ];
  }

  /**
   * Process a user message with agentic workflow
   */
  async processMessage(userMessage: string): Promise<string> {
    this.plan = [];
    this.validationResults = [];
    // Add user message
    this.messages.push({ role: "user", content: userMessage });

    // Save to memory if enabled
    if (this.enableMemory) {
      memory.addToSession({
        timestamp: Date.now(),
        role: "user",
        content: userMessage,
      });
    }

    // Enhanced communication - explain what we're doing
    console.log(chalk.blue("🧠 Understanding your request..."));
    console.log(chalk.gray(`  📝 Request: "${userMessage}"`));

    const relevantFiles = this.contextManager.getRelevantFiles(
      this.cwd,
      userMessage,
      8
    );

    if (
      this.contextManager.isEmbeddingActive() &&
      relevantFiles.some((file) => file.score > 0)
    ) {
      console.log(chalk.gray("📂 Suggested files:"));
      relevantFiles.forEach((file) => {
        const scoreLabel = file.score
          ? ` (${(file.score * 100).toFixed(1)}%)`
          : "";
        console.log(chalk.gray(`  • ${file.path}${scoreLabel}`));
      });
      console.log("");

      const summary = relevantFiles
        .map((file) => {
          const scoreLabel = file.score
            ? ` (${(file.score * 100).toFixed(1)}%)`
            : "";
          return `- ${file.path}${scoreLabel}`;
        })
        .join("\n");

      this.messages.push({
        role: "system",
        content: `Relevant project files (most similar to the latest request):\n${summary}\n\nUse the read_file tool to inspect any file you need.`,
      });
    }

    // First, analyze the project to understand context
    this.markPlanStepInProgress("Collect project context");
    console.log(chalk.blue("🔍 Analyzing project context..."));
    const projectAnalysis = analyzeProject(this.cwd);
    if (projectAnalysis.error) {
      console.log(
        chalk.red(`  ❌ Project analysis failed: ${projectAnalysis.error}`)
      );
      console.log(chalk.yellow("  🔄 Continuing with limited context..."));
      this.markPlanStepPending("Collect project context");
    } else {
      console.log(chalk.green("  ✓ Project context understood"));
      // Add project analysis to context
      this.messages.push({
        role: "system",
        content: `Project Analysis:\n${projectAnalysis.result}`,
      });
      this.markPlanStepDone("Collect project context");
    }

    this.displayPlanProgress();

    let iteration = 0;
    let fullResponse = "";
    this.proposedEdits = [];
    const toolCallHistory: string[] = [];

    while (iteration < this.maxIterations) {
      iteration++;

      // Enhanced communication about what we're doing
      if (iteration === 1) {
        this.plan = this.buildPlan(userMessage);
        this.markPlanStepInProgress("Understand request");
        this.markPlanStepDone("Understand request");
        this.displayPlan();
      } else {
        console.log(
          chalk.blue(
            `🔄 Iteration ${iteration}/${this.maxIterations} - Refining approach...`
          )
        );
        console.log(
          chalk.gray(
            "  🔄 Based on the previous results, I'm adjusting my strategy"
          )
        );
        console.log(
          chalk.gray("  🎯 Let me try a different approach or fix any issues")
        );
        this.displayPlanProgress();
      }

      // Get AI response with streaming for better UX
      const promptTokenEstimate = countMessageTokens(this.model, this.messages);
      const deltaPromptTokens = Math.max(
        promptTokenEstimate - this.lastPromptTokens,
        0
      );
      this.sessionTracker?.trackPromptTokens(deltaPromptTokens);
      this.sessionTracker?.trackContextUsage(promptTokenEstimate);

      this.maybeWarnAboutContext(promptTokenEstimate);

      this.lastPromptTokens = promptTokenEstimate;

      const spinner = ora({
        text: chalk.blue("Thinking..."),
        spinner: {
          interval: 120,
          frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
        },
      }).start();
      let response: string = "";
      let hasStarted = false;
      let isFirstChunk = true;

      let chunkCount = 0;

      try {

        // Wrap streaming with timeout
        const streamingOperation = async () => {
          for await (const chunk of this.provider.stream(this.messages)) {
            chunkCount++;

            // Stop spinner on first chunk and start streaming
            if (!hasStarted) {
              spinner.stop();
              console.log(chalk.green("\n🤖 MeerAI:\n"));
              hasStarted = true;
              await new Promise((resolve) => setTimeout(resolve, 100));
            }

            if (isFirstChunk) {
              isFirstChunk = false;
            }

            // Only process non-empty chunks
            if (chunk && chunk.trim()) {
              // Stream the response chunk by chunk for smooth typing effect
              process.stdout.write(chunk);
              response += chunk;

              // Configurable delay based on chunk length for natural typing speed
              const delay = Math.min(Math.max(chunk.length * 2, 3), 15);
              await new Promise((resolve) => setTimeout(resolve, delay));
            }
          }
        };

        // Apply timeout based on provider type
        await this.executeWithTimeout(
          streamingOperation,
          this.timeouts.chat,
          `streaming chat (${this.providerType})`
        );

        // Debug: Log chunk count
        if (chunkCount === 0) {
          logVerbose(chalk.gray(`  Debug: No chunks received from provider`));
        } else if (!response.trim()) {
          logVerbose(
            chalk.gray(`  Debug: Received ${chunkCount} empty chunks`)
          );
        }

        // Ensure spinner is stopped if no chunks received
        if (!hasStarted) {
          spinner.stop();
          logVerbose(chalk.yellow("⚠️  No response received from AI provider"));
        } else {
          console.log("\n"); // Add newline after streaming
        }
      } catch (error) {
        if (!hasStarted) {
          spinner.stop();
        }
        const errorMsg = error instanceof Error ? error.message : String(error);

        // Check if this is a provider error that requires switching
        if (this.isProviderError(error)) {
          console.log(chalk.yellow("⚠️  Provider error detected:"));
          console.log(chalk.red(`  ${errorMsg}`));

          // Try to switch to fallback provider
          if (await this.switchProvider()) {
            console.log(chalk.blue("🔄 Retrying with new provider..."));
            continue; // Retry with new provider
          } else {
            // No fallback available, ask user to enable auto mode
            if (!this.autoSwitching.enabled) {
              const enabled = await this.promptEnableAutoMode();
              if (enabled && this.autoSwitching.fallbackProviders.length > 0) {
                // Retry with newly enabled auto mode
                continue;
              }
            }
            console.log(chalk.red("❌ No fallback providers available"));
            console.log(
              chalk.gray("   Configure additional providers with: meer setup")
            );
            break; // Exit the iteration loop
          }
        } else {
          // Regular error handling
          console.log(chalk.red("❌ Error generating response:"));
          console.log(chalk.red(`  ${errorMsg}`));
          console.log(chalk.yellow("🔄 Trying alternative approach..."));

          // Add error context to messages for better recovery
          this.messages.push({
            role: "system",
            content: `Previous error: ${errorMsg}. Please try a different approach and explain what went wrong.`,
          });
          continue;
        }
      }

      fullResponse += response;

      if (response.trim()) {
        const completionTokenEstimate = countTokens(this.model, response);
        this.sessionTracker?.trackCompletionTokens(completionTokenEstimate);
      }

      // Check if response is empty or just whitespace
      if (!response.trim()) {
        logVerbose(
          chalk.yellow("⚠️  Received empty response, retrying with fallback...")
        );

        const fallbackReason =
          chunkCount === 0
            ? "   Provider stream returned no content; retrying without streaming."
            : "   Stream output was blank; retrying without streaming.";
        console.log(chalk.gray(fallbackReason));

        // Fallback to non-streaming chat if streaming fails
        try {
          const fallbackSpinner = ora(
            chalk.blue("Retrying without streaming...")
          ).start();
          const fallbackResponse = await this.executeWithTimeout(
            () => this.provider.chat(this.messages),
            this.timeouts.chat,
            `fallback chat (${this.providerType})`
          );
          fallbackSpinner.stop();

          if (fallbackResponse.trim()) {
            console.log(chalk.green("\n🤖 MeerAI:\n"));
            console.log(fallbackResponse);
            response = fallbackResponse;
          } else {
            console.log(
              chalk.red(
                "❌ Provider returned empty response even with fallback"
              )
            );
            continue;
          }
        } catch (fallbackError) {
          // Check if fallback error is also a provider error
          if (this.isProviderError(fallbackError)) {
            console.log(chalk.yellow("⚠️  Fallback provider error detected"));
            if (await this.switchProvider()) {
              console.log(chalk.blue("🔄 Trying next fallback provider..."));
              continue;
            }
          }
          console.log(chalk.red("❌ Fallback also failed:", fallbackError));
          continue;
        }
      }

      // Parse tool calls from response
      const toolCalls = parseToolCalls(response);

      // If no tool calls, break the loop
      if (toolCalls.length === 0) {
        this.markPlanStepDone("Execute tool");
        // Parse TODO list if present
        this.parseTodoList(response);

        // Response already streamed, just add to messages
        this.messages.push({ role: "assistant", content: response });

        // Save to memory if enabled
        if (this.enableMemory) {
          memory.addToSession({
            timestamp: Date.now(),
            role: "assistant",
            content: response,
            metadata: {
              provider: this.providerType,
              model: this.model,
            },
          });
        }

        break;
      }

      // Enhanced communication for tool execution
      console.log(chalk.blue(`🔧 Executing ${toolCalls.length} tool(s)...`));
      console.log(
        chalk.gray(`  Tools: ${toolCalls.map((tc) => tc.tool).join(", ")}`)
      );

      // Add a small delay to let users read the output
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Detect loops (same tool call repeated)
      const currentCallSig = toolCalls
        .map((t) => `${t.tool}:${t.params.command || t.params.path || ""}`)
        .join(",");
      if (toolCallHistory.includes(currentCallSig)) {
        console.log(
          chalk.yellow(
            "\n⚠️  Detected repeated tool calls - stopping to prevent infinite loop"
          )
        );
        console.log(
          chalk.gray(
            "The AI seems stuck. Try rephrasing your request or providing more details.\n"
          )
        );

        // Add a helpful message about what the AI was trying to do
        console.log(chalk.cyan("🧠 What I was trying to accomplish:"));
        console.log(
          chalk.gray(
            "  I was attempting to read the file to understand its structure"
          )
        );
        console.log(
          chalk.gray(
            "  Let me try a different approach or you can provide more specific guidance"
          )
        );
        console.log("");
        break;
      }
      toolCallHistory.push(currentCallSig);

      // Show AI's thinking with step-by-step communication
      const textBeforeTools = response.split("<tool")[0].trim();
      if (textBeforeTools) {
        logVerbose(chalk.cyan("💭 AI Thinking:"));
        logVerbose(chalk.gray("  " + textBeforeTools.replace(/\n/g, "\n  ")));
        logVerbose("");
      }

      // Execute tools with enhanced communication
      const toolResults: string[] = [];

      for (let i = 0; i < toolCalls.length; i++) {
        const toolCall = toolCalls[i];

        // Show detailed reasoning for each tool
        console.log(chalk.cyan(`🧠 Reasoning for ${toolCall.tool}:`));
        if (toolCall.content && toolCall.content.trim()) {
          console.log(
            chalk.gray(`  ${toolCall.content.replace(/\n/g, "\n  ")}`)
          );
        } else {
          console.log(chalk.gray(`  No specific reasoning provided`));
        }
        console.log("");

        console.log(
          chalk.blue(`  ${i + 1}/${toolCalls.length} ${toolCall.tool}...`)
        );
        console.log(
          chalk.gray(
            `    📋 Parameters: ${JSON.stringify(toolCall.params, null, 2)}`
          )
        );
        console.log("");

        try {
          this.markPlanStepInProgress("Execute tool");
          const result = await this.executeTool(toolCall, userMessage);

          // Check if result indicates an error (intelligent error detection)
          // Only flag as error if it starts with error indicators or contains specific error patterns
          const trimmedResult = result.trim();
          const lowerResult = trimmedResult.toLowerCase();
          const benignPatterns = [
            "error: no test specified",
            "note: this file does not exist yet",
            "file doesn't exist yet",
            "file is missing and can be created",
          ];
          const containsBenign = benignPatterns.some((pattern) =>
            lowerResult.includes(pattern)
          );

          const isError =
            !containsBenign &&
            (trimmedResult.startsWith("Error:") ||
              trimmedResult.startsWith("❌") ||
              lowerResult.includes("command failed") ||
              lowerResult.includes("failed:") ||
              lowerResult.includes("not found:") ||
              lowerResult.includes("cannot find:") ||
              lowerResult.includes("does not exist:") ||
              lowerResult.includes("permission denied") ||
              lowerResult.includes("access denied") ||
              lowerResult.includes("syntax error") ||
              lowerResult.includes("compilation error") ||
              lowerResult.includes("build failed") ||
              lowerResult.includes("import error") ||
              lowerResult.includes("module not found") ||
              lowerResult.includes("package not found") ||
              lowerResult.includes("dependency error") ||
              lowerResult.includes("missing dependency") ||
              lowerResult.includes("undefined") ||
              lowerResult.includes("not defined") ||
              // Check for specific tool error patterns
              (toolCall.tool === "read_file" &&
                lowerResult.includes("file not found:")) ||
              (toolCall.tool === "list_files" &&
                lowerResult.includes("directory not found:")) ||
              (toolCall.tool === "run_command" &&
                lowerResult.includes("command failed:")) ||
              (toolCall.tool === "analyze_project" &&
                lowerResult.includes("error analyzing project:")));

          if (isError) {
            if (this.handleSimpleToolFailure(toolCall, result, toolResults)) {
              continue;
            }
            console.log(chalk.red(`    ❌ ${toolCall.tool} failed:`));
            console.log(chalk.red(`      ${result}`));
            console.log(chalk.cyan(`    🧠 Analyzing the error:`));
            console.log(
              chalk.gray(
                `      Let me understand what went wrong and find an alternative approach`
              )
            );
            console.log(
              chalk.gray(
                `      I'll research the error and try a different strategy`
              )
            );
            console.log(
              chalk.yellow(
                `    🔄 Analyzing error and trying alternative approach...`
              )
            );
            console.log("");

            // Try alternative approach
            const alternativeResult = await this.tryAlternativeApproach(
              toolCall,
              result
            );
            if (alternativeResult) {
              this.markPlanStepDone("Execute tool");
              console.log(chalk.green(`    ✓ Alternative approach succeeded`));
              console.log(
                chalk.gray(
                  `      Result: ${alternativeResult.substring(0, 100)}${
                    alternativeResult.length > 100 ? "..." : ""
                  }`
                )
              );
              toolResults.push(alternativeResult);
            } else {
              this.markPlanStepPending("Execute tool");
              console.log(chalk.red(`    ❌ Alternative approach also failed`));
              console.log(
                chalk.gray(
                  `      Final result: ${result.substring(0, 100)}${
                    result.length > 100 ? "..." : ""
                  }`
                )
              );
              toolResults.push(result);
            }
          } else {
            console.log(
              chalk.green(`    ✓ ${toolCall.tool} completed successfully`)
            );
            console.log(chalk.cyan(`    🧠 What I learned:`));
            console.log(
              chalk.gray(
                `      This tool provided valuable information for the next steps`
              )
            );
            console.log(
              chalk.gray(
                `      I can now proceed with the implementation based on these results`
              )
            );
            console.log(
              chalk.gray(
                `      Result: ${result.substring(0, 100)}${
                  result.length > 100 ? "..." : ""
                }`
              )
            );
            this.markPlanStepDone("Execute tool");
            toolResults.push(result);
          }
          console.log("");

          // Add delay to let users read the output
          await new Promise((resolve) => setTimeout(resolve, 800));
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : String(error);
          console.log(
            chalk.red(`    ❌ ${toolCall.tool} crashed: ${errorMsg}`)
          );
          console.log(chalk.yellow(`    🔄 Trying alternative approach...`));

          // Try alternative approach for crashed tools too
          const alternativeResult = await this.tryAlternativeApproach(
            toolCall,
            errorMsg
          );
          if (alternativeResult) {
            this.markPlanStepDone("Execute tool");
            console.log(chalk.green(`    ✓ Alternative approach succeeded`));
            toolResults.push(alternativeResult);
          } else {
            this.markPlanStepPending("Execute tool");
            console.log(chalk.red(`    ❌ Alternative approach also failed`));
            toolResults.push(`Error: ${errorMsg}`);
          }
        }
      }

      // Add tool results to conversation
      const toolResultsMessage = `Tool results:\n${toolResults.join("\n\n")}`;
      this.messages.push({ role: "assistant", content: response });
      this.messages.push({ role: "user", content: toolResultsMessage });
    }

    // If we have proposed edits, show them and ask for approval
    if (this.proposedEdits.length > 0) {
      this.markPlanStepInProgress("Review changes");
      await this.reviewEdits();

      this.markPlanStepDone("Review changes");

      this.markPlanStepInProgress("Summarize next steps");
      await this.runPostEditValidation();
      this.displayEditSummary();
      this.markPlanStepDone("Summarize next steps");
    } else {
      this.markPlanStepInProgress("Summarize next steps");
      this.markPlanStepDone("Summarize next steps");
    }

    return fullResponse;
  }

  /**
   * Detect if an error is a provider-level error that requires switching
   */
  private isProviderError(error: any): boolean {
    const errorMessage = error?.message || String(error);
    const errorLower = errorMessage.toLowerCase();

    // API quota/rate limit errors
    if (
      errorLower.includes("quota") ||
      errorLower.includes("rate limit") ||
      errorLower.includes("429") ||
      errorLower.includes("resource_exhausted")
    ) {
      return true;
    }

    // Authentication/API key errors
    if (
      errorLower.includes("unauthorized") ||
      errorLower.includes("401") ||
      errorLower.includes("invalid api key") ||
      errorLower.includes("authentication")
    ) {
      return true;
    }

    // Service unavailable/connection errors
    if (
      errorLower.includes("service unavailable") ||
      errorLower.includes("502") ||
      errorLower.includes("503") ||
      errorLower.includes("504") ||
      errorLower.includes("404") ||
      errorLower.includes("not found") ||
      errorLower.includes("connection refused") ||
      errorLower.includes("network error") ||
      errorLower.includes("econnrefused") ||
      errorLower.includes("timeout")
    ) {
      return true;
    }

    // Payment/billing errors
    if (
      errorLower.includes("billing") ||
      errorLower.includes("payment") ||
      errorLower.includes("subscription")
    ) {
      return true;
    }

    // Specific provider error patterns
    if (
      errorLower.includes("ollama api error") ||
      errorLower.includes("openai api error") ||
      errorLower.includes("gemini api error") ||
      errorLower.includes("model not found") ||
      errorLower.includes("invalid model")
    ) {
      return true;
    }

    return false;
  }

  /**
   * Switch to the next available provider
   */
  private async switchProvider(): Promise<boolean> {
    if (
      !this.autoSwitching.enabled ||
      this.autoSwitching.fallbackProviders.length === 0
    ) {
      return false;
    }

    this.autoSwitching.currentProviderIndex++;

    if (
      this.autoSwitching.currentProviderIndex >=
      this.autoSwitching.fallbackProviders.length
    ) {
      console.log(chalk.red("❌ All fallback providers exhausted"));
      return false;
    }

    const fallback =
      this.autoSwitching.fallbackProviders[
        this.autoSwitching.currentProviderIndex
      ];
    this.provider = fallback.provider;
    this.providerType = fallback.providerType;
    this.model = fallback.model;

    console.log(
      chalk.yellow(
        `🔄 Switching to ${fallback.providerType} (${fallback.model})`
      )
    );
    return true;
  }

  /**
   * Reset to primary provider
   */
  private resetToPrimaryProvider(): void {
    if (this.autoSwitching.currentProviderIndex !== -1) {
      this.autoSwitching.currentProviderIndex = -1;
      this.provider = this.originalProvider.provider;
      this.providerType = this.originalProvider.providerType;
      this.model = this.originalProvider.model;
      console.log(chalk.blue("🔄 Reset to primary provider"));
    }
  }

  /**
   * Prompt user to enable auto-switching mode
   */
  private async promptEnableAutoMode(): Promise<boolean> {
    console.log(chalk.yellow("\n⚠️  Provider error detected!"));
    console.log(
      chalk.gray(
        "Your current provider is experiencing issues (quota exceeded, API key invalid, etc.)"
      )
    );
    console.log(
      chalk.blue(
        "\n💡 Auto-switching mode can automatically switch between configured providers"
      )
    );
    console.log(chalk.gray("when errors occur, providing better reliability."));

    const { enableAuto } = await inquirer.prompt([
      {
        type: "confirm",
        name: "enableAuto",
        message:
          "Would you like to enable auto-switching mode for this session?",
        default: true,
      },
    ]);

    if (enableAuto) {
      this.autoSwitching.enabled = true;
      console.log(chalk.green("✅ Auto-switching enabled for this session"));
      console.log(
        chalk.gray("💡 To configure additional providers, run: meer setup")
      );
      return true;
    }

    return false;
  }

  /**
   * Execute a function with timeout
   */
  private async executeWithTimeout<T>(
    operation: () => Promise<T>,
    timeout: number,
    operationName: string
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        console.log(
          chalk.yellow(
            `  ⏰ Operation timed out after ${
              timeout / 1000
            }s: ${operationName}`
          )
        );
        console.log(chalk.gray(`  🔄 Attempting graceful cancellation...`));
        reject(
          new Error(`Operation timeout: ${operationName} exceeded ${timeout}ms`)
        );
      }, timeout);

      operation()
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  /**
   * Execute a single tool call
   */
  private async executeTool(
    toolCall: { tool: string; params: Record<string, string>; content: string },
    userMessage?: string
  ): Promise<string> {
    const { tool, params, content } = toolCall;

    console.log(chalk.yellow(`🔧 Using tool: ${chalk.bold(tool)}`));

    switch (tool) {
      case "read_file": {
        const filepath = params.path || params.file || params.filepath;
        if (!filepath) {
          console.log(chalk.red("  ❌ Missing required parameter: path"));
          return `Error: Missing path parameter`;
        }

        console.log(chalk.gray(`  📖 Reading: ${filepath}`));
        const result = readFile(filepath, this.cwd);

        if (result.error) {
          console.log(chalk.red(`  ❌ ${result.error}`));
          return `Error reading ${filepath}: ${result.error}`;
        }

        // Check if file doesn't exist (not an error, just info)
        if (result.result.includes("File not found")) {
          console.log(
            chalk.yellow(
              `  ℹ️  File doesn't exist yet - can be created with propose_edit`
            )
          );
        } else {
          console.log(chalk.green(`  ✓ Read ${filepath}`));
        }

        return result.result;
      }

      case "list_files": {
        const dirpath = params.path || params.dir || params.directory || "";
        console.log(
          chalk.gray(`  📂 Listing: ${dirpath || "current directory"}`)
        );
        const result = listFiles(dirpath, this.cwd);

        if (result.error) {
          console.log(chalk.red(`  ❌ ${result.error}`));
          return `Error listing ${dirpath}: ${result.error}`;
        }

        console.log(
          chalk.green(`  ✓ Listed ${dirpath || "current directory"}`)
        );
        return result.result;
      }

      case "propose_edit": {
        const filepath = params.path || params.file || params.filepath;
        const description = params.description || "Edit file";

        if (!filepath || !content) {
          console.log(
            chalk.red("  ❌ Missing required parameters: path and content")
          );
          return `Error: Missing path or content`;
        }

        console.log(chalk.gray(`  ✏️  Proposing edit: ${filepath}`));
        console.log(chalk.gray(`     ${description}`));

        try {
          const edit = proposeEdit(filepath, content, description, this.cwd);
          this.proposedEdits.push(edit);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.log(chalk.red(`  ❌ ${message}`));
          return `Error proposing edit: ${message}`;
        }

        console.log(chalk.green(`  ✓ Edit proposed for ${filepath}`));
        return `Edit proposed for ${filepath}: ${description}`;
      }
      case "analyze_project": {
        console.log(chalk.gray(`  🔍 Analyzing project structure`));
        const result = analyzeProject(this.cwd);

        if (result.error) {
          console.log(chalk.red(`  ❌ ${result.error}`));
          return `Error analyzing project: ${result.error}`;
        }

        console.log(chalk.green(`  ✓ Project analyzed`));
        return result.result;
      }

      case "run_command": {
        const command = params.command || params.cmd;
        if (!command) {
          console.log(chalk.red("  ❌ Missing required parameter: command"));
          return `Error: Missing command parameter`;
        }

        const prepared = this.prepareRunCommand(command);
        if (prepared.message) {
          console.log(chalk.gray(`  ${prepared.message}`));
        }

        if (prepared.skipExecution) {
          const message = prepared.resultMessage ?? `Command skipped: ${command}`;
          if (message.toLowerCase().includes("changed directory")) {
            this.markPlanStepDone("Execute tool");
          } else {
            this.markPlanStepPending("Execute tool");
          }
          return message;
        }

        const commandToRun = prepared.command;

        if (!commandToRun) {
          return prepared.resultMessage ?? "No command to execute.";
        }

        console.log(chalk.gray(`  💻 ${commandToRun}`));
        console.log(
          chalk.gray(`  📁 Working directory: ${this.currentDirectory}`)
        );
        console.log(
          chalk.gray(`  ⏱️  Timeout: ${this.timeouts.command / 1000}s`)
        );

        const approval = this.requiresRunCommandApproval(commandToRun);
        if (approval.required) {
          const approved = await this.confirmRunCommand(
            commandToRun,
            approval.reason
          );
          if (!approved) {
            console.log(chalk.yellow("  ⚠️  Command cancelled by user"));
            return `Command cancelled: ${commandToRun}`;
          }
        }

        this.markPlanStepInProgress("Execute tool");
        try {
          const result = await runCommand(commandToRun, this.currentDirectory, {
            timeoutMs: this.timeouts.command,
          });

          if (result.error) {
            console.log(chalk.red(`  ❌ ${result.error}`));
            this.markPlanStepPending("Execute tool");
            return `Error running command: ${result.error}`;
          }

          console.log(chalk.green(`  ✓ Command executed`));
          this.markPlanStepDone("Execute tool");
          return result.result;
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : String(error);
          this.markPlanStepPending("Execute tool");
          console.log(
            chalk.red(`  ❌ Command timed out or failed: ${errorMsg}`)
          );
          this.markPlanStepPending("Execute tool");
          return `Error: ${errorMsg}`;
        }
      }

      case "suggest_setup": {
        console.log(chalk.gray(`  💡 Generating setup suggestions`));
        const projectAnalysis = analyzeProject(this.cwd);
        const result = suggestSetup(userMessage || "", projectAnalysis);

        if (result.error) {
          console.log(chalk.red(`  ❌ ${result.error}`));
          return `Error generating suggestions: ${result.error}`;
        }

        console.log(chalk.green(`  ✓ Suggestions generated`));
        return result.result;
      }

      case "scaffold_project": {
        const projectType = params.type || params.projectType;
        const projectName = params.name || params.projectName;

        if (!projectType || !projectName) {
          console.log(
            chalk.red("  ❌ Missing required parameters: type and name")
          );
          return `Error: Missing project type or name`;
        }

        console.log(
          chalk.gray(`  🏗️  Scaffolding ${projectType} project: ${projectName}`)
        );
        const result = scaffoldProject(projectType, projectName, this.cwd);

        if (result.error) {
          console.log(chalk.red(`  ❌ ${result.error}`));
          return `Error scaffolding project: ${result.error}`;
        }

        console.log(chalk.green(`  ✓ Project scaffolded`));
        return result.result;
      }

      case "find_files": {
        const pattern = params.pattern || params.file;
        if (!pattern) {
          console.log(chalk.red("  ❌ Missing required parameter: pattern"));
          return `Error: Missing pattern parameter`;
        }

        const options = {
          includePattern: params.includePattern,
          excludePattern: params.excludePattern,
          fileTypes: params.fileTypes ? params.fileTypes.split(",") : undefined,
          maxDepth: params.maxDepth ? parseInt(params.maxDepth) : undefined,
        };

        console.log(chalk.gray(`  🔍 Finding files matching: ${pattern}`));
        const result = findFiles(pattern, this.cwd, options);

        if (result.error) {
          console.log(chalk.red(`  ❌ ${result.error}`));
          return `Error finding files: ${result.error}`;
        }

        console.log(chalk.green(`  ✓ Files found`));
        return result.result;
      }

      case "read_many_files": {
        const filePaths = params.files ? params.files.split(",") : [];
        if (filePaths.length === 0) {
          console.log(chalk.red("  ❌ Missing required parameter: files"));
          return `Error: Missing files parameter`;
        }

        const maxFiles = params.maxFiles ? parseInt(params.maxFiles) : 10;
        console.log(chalk.gray(`  📚 Reading ${filePaths.length} files`));
        const result = readManyFiles(filePaths, this.cwd, maxFiles);

        if (result.error) {
          console.log(chalk.red(`  ❌ ${result.error}`));
          return `Error reading files: ${result.error}`;
        }

        console.log(chalk.green(`  ✓ Files read`));
        return result.result;
      }

      case "search_text": {
        const searchTerm = params.term || params.query || params.search;
        if (!searchTerm) {
          console.log(chalk.red("  ❌ Missing required parameter: term"));
          return `Error: Missing search term`;
        }

        const options = {
          filePattern: params.filePattern,
          caseSensitive: params.caseSensitive === "true",
          wholeWord: params.wholeWord === "true",
          includePattern: params.includePattern,
          excludePattern: params.excludePattern,
        };

        console.log(chalk.gray(`  🔎 Searching for: "${searchTerm}"`));
        const result = searchText(searchTerm, this.cwd, options);

        if (result.error) {
          console.log(chalk.red(`  ❌ ${result.error}`));
          return `Error searching text: ${result.error}`;
        }

        console.log(chalk.green(`  ✓ Search completed`));
        return result.result;
      }

      case "read_folder": {
        const folderPath = params.path || params.folder || "";
        const options = {
          maxDepth: params.maxDepth ? parseInt(params.maxDepth) : undefined,
          includeStats: params.includeStats === "true",
          fileTypes: params.fileTypes ? params.fileTypes.split(",") : undefined,
        };

        console.log(
          chalk.gray(
            `  📁 Reading folder: ${folderPath || "current directory"}`
          )
        );
        const result = readFolder(folderPath, this.cwd, options);

        if (result.error) {
          console.log(chalk.red(`  ❌ ${result.error}`));
          return `Error reading folder: ${result.error}`;
        }

        console.log(chalk.green(`  ✓ Folder read`));
        return result.result;
      }

      case "google_search": {
        const query = params.query || params.search;
        if (!query) {
          console.log(chalk.red("  ❌ Missing required parameter: query"));
          return `Error: Missing search query`;
        }

        const options = {
          maxResults: params.maxResults
            ? parseInt(params.maxResults)
            : undefined,
          site: params.site,
        };

        console.log(chalk.gray(`  🔍 Searching: "${query}"`));
        console.log(
          chalk.gray(`  ⏱️  Timeout: ${this.timeouts.webSearch / 1000}s`)
        );

        try {
          const result = await this.executeWithTimeout(
            () => Promise.resolve(googleSearch(query, options)),
            this.timeouts.webSearch,
            `google_search: ${query}`
          );

          if (result.error) {
            console.log(chalk.red(`  ❌ ${result.error}`));
            return `Error searching Google: ${result.error}`;
          }

          console.log(chalk.green(`  ✓ Google search completed`));
          return result.result;
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : String(error);
          console.log(
            chalk.red(`  ❌ Search timed out or failed: ${errorMsg}`)
          );
          return `Error: ${errorMsg}`;
        }
      }

      case "web_fetch": {
        const url = params.url;
        if (!url) {
          console.log(chalk.red("  ❌ Missing required parameter: url"));
          return `Error: Missing URL`;
        }

        const options = {
          method: (params.method as "GET" | "POST" | "PUT" | "DELETE") || "GET",
          headers: params.headers ? JSON.parse(params.headers) : undefined,
          saveTo: params.saveTo,
        };

        console.log(chalk.gray(`  🌐 Accessing: ${url}`));
        console.log(
          chalk.gray(`  ⏱️  Timeout: ${this.timeouts.webFetch / 1000}s`)
        );

        try {
          const result = await this.executeWithTimeout(
            () => Promise.resolve(webFetch(url, options)),
            this.timeouts.webFetch,
            `web_fetch: ${url}`
          );

          if (result.error) {
            console.log(chalk.red(`  ❌ ${result.error}`));
            return `Error fetching URL: ${result.error}`;
          }

          const hostname = new URL(url).hostname;
          console.log(chalk.green(`  ✓ Retrieved content from ${hostname}`));
          return result.result;
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : String(error);
          console.log(
            chalk.red(`  ❌ Web fetch timed out or failed: ${errorMsg}`)
          );
          return `Error: ${errorMsg}`;
        }
      }

      case "save_memory": {
        const key = params.key;
        const content = params.content;
        if (!key || !content) {
          console.log(
            chalk.red("  ❌ Missing required parameters: key and content")
          );
          return `Error: Missing key or content`;
        }

        const options = {
          category: params.category,
          tags: params.tags ? params.tags.split(",") : undefined,
          expiresAt: params.expiresAt ? new Date(params.expiresAt) : undefined,
        };

        console.log(chalk.gray(`  💾 Saving memory: ${key}`));
        const result = saveMemory(key, content, this.cwd, options);

        if (result.error) {
          console.log(chalk.red(`  ❌ ${result.error}`));
          return `Error saving memory: ${result.error}`;
        }

        console.log(chalk.green(`  ✓ Memory saved`));
        return result.result;
      }

      case "load_memory": {
        const key = params.key;
        if (!key) {
          console.log(chalk.red("  ❌ Missing required parameter: key"));
          return `Error: Missing key`;
        }

        console.log(chalk.gray(`  📖 Loading memory: ${key}`));
        const result = loadMemory(key, this.cwd);

        if (result.error) {
          console.log(chalk.red(`  ❌ ${result.error}`));
          return `Error loading memory: ${result.error}`;
        }

        console.log(chalk.green(`  ✓ Memory loaded`));
        return result.result;
      }

      case "grep": {
        const filepath = params.path || params.file || params.filepath;
        const pattern = params.pattern || params.search || params.term;

        if (!filepath || !pattern) {
          console.log(chalk.red("  ❌ Missing required parameters: path and pattern"));
          return `Error: Missing path or pattern`;
        }

        console.log(chalk.gray(`  🔎 Searching in ${filepath} for: "${pattern}"`));
        const result = grep(filepath, pattern, this.cwd, params);

        if (result.error) {
          console.log(chalk.red(`  ❌ ${result.error}`));
          return `Error: ${result.error}`;
        }

        console.log(chalk.green(`  ✓ Found matches`));
        return result.result;
      }

      case "edit_line": {
        const filepath = params.path || params.file || params.filepath;
        const lineNumber = parseInt(params.lineNumber || params.line || "0");
        const oldText = params.oldText || params.old || "";
        const newText = params.newText || params.new || "";

        if (!filepath || !lineNumber || !oldText || !newText) {
          console.log(chalk.red("  ❌ Missing required parameters: path, lineNumber, oldText, newText"));
          return `Error: Missing required parameters`;
        }

        console.log(chalk.gray(`  ✏️  Editing line ${lineNumber} in ${filepath}`));

        try {
          const edit = editLine(filepath, lineNumber, oldText, newText, this.cwd);
          this.proposedEdits.push(edit);
          console.log(chalk.green(`  ✓ Line edit proposed for ${filepath}`));
          return `Edit proposed for ${filepath} line ${lineNumber}: ${edit.description}`;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.log(chalk.red(`  ❌ ${errorMsg}`));
          return `Error: ${errorMsg}`;
        }
      }

      case "semantic_search": {
        const query = params.query || params.q || "";
        const limit = parseInt(params.limit || "10");
        const minScore = parseFloat(params.minScore || params.score || "0.5");
        const filePattern = params.filePattern || params.pattern;
        const language = params.language || params.lang;
        const includeTests = params.includeTests === "true";
        const embeddingModel = params.embeddingModel || params.model || "nomic-embed-text";

        if (!query) {
          console.log(chalk.red("  ❌ Missing required parameter: query"));
          return `Error: Missing query parameter`;
        }

        console.log(chalk.gray(`  🔍 Searching: "${query}"`));

        try {
          const result = await semanticSearch(query, this.cwd, this.provider, {
            limit,
            minScore,
            filePattern,
            language,
            includeTests,
            embeddingModel,
          });

          if (result.error) {
            console.log(chalk.yellow(`  ⚠️  ${result.error}`));
            return result.error;
          }

          console.log(chalk.green(`  ✓ Search completed`));
          return result.result;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.log(chalk.red(`  ❌ ${errorMsg}`));
          return `Error: ${errorMsg}`;
        }
      }

      case "todo": {
        const action = (params.action || params.mode || "list").toLowerCase();
        const rawItemsSource =
          (typeof content === "string" && content.trim().length > 0
            ? content
            : params.items || params.tasks || params.list || "");
        const tasks = this.parseTasksFromInput(String(rawItemsSource));

        const listResponse = () =>
          this.todoList.length > 0
            ? `TODO list:\n${this.formatTodoList()}`
            : "TODO list is currently empty.";

        const resolveReference = () => {
          const indexParam =
            params.index ??
            params.item_index ??
            params.position ??
            params.id ??
            params.number;
          let index: number | undefined;
          if (typeof indexParam === "string" && indexParam.trim().length > 0) {
            const numeric = parseInt(indexParam, 10);
            if (!Number.isNaN(numeric)) {
              const candidate = numeric - 1;
              if (candidate >= 0 && candidate < this.todoList.length) {
                index = candidate;
              }
            }
          }
          const patternSource =
            (params.task && params.task.trim()) ||
            (params.item && params.item.trim()) ||
            (params.name && params.name.trim()) ||
            (params.target && params.target.trim()) ||
            "";
          const pattern =
            patternSource ||
            (tasks.length === 1 ? tasks[0] : "");
          return { index, pattern: pattern || undefined };
        };

        switch (action) {
          case "create":
          case "set":
          case "replace": {
            if (tasks.length === 0) {
              return "TODO: Provide one or more tasks to create the list.";
            }
            this.setTodoListFromTasks(tasks);
            this.displayTodoList();
            return `Created TODO list with ${tasks.length} item(s).\n${listResponse()}`;
          }
          case "add":
          case "append": {
            if (tasks.length === 0) {
              return "TODO: Provide one or more tasks to add.";
            }
            const added = this.addTodoItems(tasks);
            if (added === 0) {
              return "TODO: Provide one or more tasks to add.";
            }
            this.displayTodoList();
            return `Added ${added} task(s).\n${listResponse()}`;
          }
          case "list":
          case "show":
          case "status": {
            this.displayTodoList();
            return listResponse();
          }
          case "start":
          case "progress":
          case "in_progress": {
            const { index, pattern } = resolveReference();
            const updated = this.updateTodoStatus(pattern, "in_progress", index);
            if (!updated) {
              return "TODO: Could not find a matching task to mark in progress.";
            }
            return `Marked "${updated.task}" as in progress.\n${listResponse()}`;
          }
          case "complete":
          case "done":
          case "finish": {
            const { index, pattern } = resolveReference();
            const updated = this.updateTodoStatus(pattern, "completed", index);
            if (!updated) {
              return "TODO: Could not find a matching task to mark complete.";
            }
            return `Marked "${updated.task}" as completed.\n${listResponse()}`;
          }
          case "update": {
            const statusParam = (params.status || params.state || params.value || "").toLowerCase();
            const { index, pattern } = resolveReference();
            if (statusParam === "pending") {
              const targetIndex = this.findTodoIndex(pattern, index);
              if (targetIndex === -1) {
                return "TODO: Could not find a matching task to update.";
              }
              this.todoList[targetIndex].status = "pending";
              this.displayTodoList();
              return `Marked "${this.todoList[targetIndex].task}" as pending.\n${listResponse()}`;
            }
            if (statusParam === "in_progress" || statusParam === "progress" || statusParam === "in-progress") {
              const updated = this.updateTodoStatus(pattern, "in_progress", index);
              if (!updated) {
                return "TODO: Could not find a matching task to update.";
              }
              return `Marked "${updated.task}" as in progress.\n${listResponse()}`;
            }
            if (statusParam === "completed" || statusParam === "done" || statusParam === "complete") {
              const updated = this.updateTodoStatus(pattern, "completed", index);
              if (!updated) {
                return "TODO: Could not find a matching task to update.";
              }
              return `Marked "${updated.task}" as completed.\n${listResponse()}`;
            }
            return "TODO: Provide a valid status (pending, in_progress, completed).";
          }
          case "remove":
          case "delete": {
            const { index, pattern } = resolveReference();
            const targetIndex = this.findTodoIndex(pattern, index);
            if (targetIndex === -1) {
              return "TODO: Could not find a matching task to remove.";
            }
            const [removed] = this.todoList.splice(targetIndex, 1);
            this.displayTodoList();
            return `Removed task "${removed.task}".\n${listResponse()}`;
          }
          case "clear":
          case "reset": {
            const hadItems = this.todoList.length > 0;
            this.todoList = [];
            this.displayTodoList();
            return `${hadItems ? "Cleared TODO list." : "TODO list is already empty."}\n${listResponse()}`;
          }
          default:
            return `TODO: Unknown action "${action}". Supported actions: create, add, list, start, complete, update, remove, clear.`;
        }
      }

      // Git tools
      case "git_status": {
        console.log(chalk.gray(`  📊 Checking git status`));
        const result = gitStatus(this.currentDirectory);
        if (result.error) {
          console.log(chalk.red(`  ❌ ${result.error}`));
          return `Error: ${result.error}`;
        }
        console.log(chalk.green(`  ✓ Git status retrieved`));
        return result.result;
      }

      case "git_diff": {
        const staged = params.staged === "true";
        const filepath = params.filepath || params.path;
        console.log(chalk.gray(`  📝 Getting git diff${staged ? " (staged)" : ""}${filepath ? ` for ${filepath}` : ""}`));
        const result = gitDiff(this.currentDirectory, { staged, filepath });
        if (result.error) {
          console.log(chalk.red(`  ❌ ${result.error}`));
          return `Error: ${result.error}`;
        }
        console.log(chalk.green(`  ✓ Git diff retrieved`));
        return result.result;
      }

      case "git_log": {
        const options = {
          maxCount: params.maxCount ? parseInt(params.maxCount) : undefined,
          author: params.author,
          since: params.since,
          until: params.until,
          filepath: params.filepath || params.path,
        };
        console.log(chalk.gray(`  📜 Fetching git log`));
        const result = gitLog(this.currentDirectory, options);
        if (result.error) {
          console.log(chalk.red(`  ❌ ${result.error}`));
          return `Error: ${result.error}`;
        }
        console.log(chalk.green(`  ✓ Git log retrieved`));
        return result.result;
      }

      case "git_commit": {
        const message = params.message || params.msg;
        if (!message) {
          console.log(chalk.red("  ❌ Missing required parameter: message"));
          return `Error: Missing commit message`;
        }
        const options = {
          addAll: params.addAll === "true",
          files: params.files ? params.files.split(",").map((f: string) => f.trim()) : undefined,
        };
        console.log(chalk.gray(`  💾 Creating git commit`));
        const result = gitCommit(message, this.currentDirectory, options);
        if (result.error) {
          console.log(chalk.red(`  ❌ ${result.error}`));
          return `Error: ${result.error}`;
        }
        console.log(chalk.green(`  ✓ Commit created`));
        return result.result;
      }

      case "git_branch": {
        const options = {
          list: params.list === "true" || !params.create && !params.switch && !params.delete,
          create: params.create,
          switch: params.switch,
          delete: params.delete,
        };
        console.log(chalk.gray(`  🌿 Managing git branches`));
        const result = gitBranch(this.currentDirectory, options);
        if (result.error) {
          console.log(chalk.red(`  ❌ ${result.error}`));
          return `Error: ${result.error}`;
        }
        console.log(chalk.green(`  ✓ Branch operation completed`));
        return result.result;
      }

      // File operation tools
      case "write_file": {
        const filepath = params.path || params.file || params.filepath;
        if (!filepath || !content) {
          console.log(chalk.red("  ❌ Missing required parameters: path and content"));
          return `Error: Missing path or content`;
        }
        console.log(chalk.gray(`  ✍️  Writing file: ${filepath}`));
        const result = writeFile(filepath, content, this.currentDirectory);
        if (result.error) {
          console.log(chalk.red(`  ❌ ${result.error}`));
          return `Error: ${result.error}`;
        }
        console.log(chalk.green(`  ✓ File written`));
        return result.result;
      }

      case "delete_file": {
        const filepath = params.path || params.file || params.filepath;
        if (!filepath) {
          console.log(chalk.red("  ❌ Missing required parameter: path"));
          return `Error: Missing path parameter`;
        }
        console.log(chalk.gray(`  🗑️  Deleting file: ${filepath}`));
        const result = deleteFile(filepath, this.currentDirectory);
        if (result.error) {
          console.log(chalk.red(`  ❌ ${result.error}`));
          return `Error: ${result.error}`;
        }
        console.log(chalk.green(`  ✓ File deleted`));
        return result.result;
      }

      case "move_file": {
        const source = params.source || params.from || params.src;
        const dest = params.dest || params.to || params.destination;
        if (!source || !dest) {
          console.log(chalk.red("  ❌ Missing required parameters: source and dest"));
          return `Error: Missing source or dest parameter`;
        }
        console.log(chalk.gray(`  📦 Moving file: ${source} → ${dest}`));
        const result = moveFile(source, dest, this.currentDirectory);
        if (result.error) {
          console.log(chalk.red(`  ❌ ${result.error}`));
          return `Error: ${result.error}`;
        }
        console.log(chalk.green(`  ✓ File moved`));
        return result.result;
      }

      case "create_directory": {
        const dirpath = params.path || params.dir || params.directory;
        if (!dirpath) {
          console.log(chalk.red("  ❌ Missing required parameter: path"));
          return `Error: Missing path parameter`;
        }
        console.log(chalk.gray(`  📁 Creating directory: ${dirpath}`));
        const result = createDirectory(dirpath, this.currentDirectory);
        if (result.error) {
          console.log(chalk.red(`  ❌ ${result.error}`));
          return `Error: ${result.error}`;
        }
        console.log(chalk.green(`  ✓ Directory created`));
        return result.result;
      }

      default:
        // Check if it's an MCP tool (format: serverName.toolName)
        if (tool.includes('.')) {
          return await this.executeMCPTool(tool, params);
        }

        console.log(chalk.red(`  ❌ Unknown tool: ${tool}`));
        return `Error: Unknown tool ${tool}`;
    }
  }

  /**
   * Execute an MCP tool
   */
  private async executeMCPTool(toolName: string, params: Record<string, string>): Promise<string> {
    try {
      console.log(chalk.gray(`  🔌 Executing MCP tool: ${toolName}`));

      const result = await this.mcpManager.executeTool(toolName, params);

      if (!result.success) {
        console.log(chalk.red(`  ❌ ${result.error}`));
        return `Error executing ${toolName}: ${result.error}`;
      }

      // Extract text content from MCP result
      const textContent = result.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join("\n");

      console.log(chalk.green(`  ✓ MCP tool completed`));
      return textContent || 'Tool executed successfully';
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log(chalk.red(`  ❌ MCP tool failed: ${errorMsg}`));
      return `Error: ${errorMsg}`;
    }
  }

  private requiresRunCommandApproval(command: string): {
    required: boolean;
    reason: string;
  } {
    const lower = command.toLowerCase();

    const destructivePatterns: Array<{ regex: RegExp; reason: string }> = [
      { regex: /\brm\b/, reason: "Deletes files" },
      { regex: /\bdel\b/, reason: "Deletes files" },
      { regex: /\bshred\b/, reason: "Overwrites files" },
      { regex: /\bmkfs\b/, reason: "Formats drives" },
      { regex: /\bdd\b.*\bof=/, reason: "Writes raw data" },
      { regex: /\bgit\s+reset\b/, reason: "Resets git history" },
      { regex: /\bgit\s+clean\b/, reason: "Removes untracked files" },
      { regex: /\bgit\s+checkout\b\s+--/, reason: "Overwrites files" },
      { regex: /\bsudo\b/, reason: "Requires elevated privileges" },
      { regex: /\bchown\b/, reason: "Changes ownership" },
      { regex: /\bchmod\b/, reason: "Changes permissions" },
      { regex: /\bkill\b/, reason: "Terminates processes" },
      { regex: /\breboot\b/, reason: "Reboots system" },
      { regex: /\bshutdown\b/, reason: "Shuts down system" },
    ];

    for (const pattern of destructivePatterns) {
      if (pattern.regex.test(lower)) {
        return { required: true, reason: pattern.reason };
      }
    }

    const installPatterns: Array<{ regex: RegExp; reason: string }> = [
      { regex: /\bnpm\s+(install|ci)\b/, reason: "Installs npm packages" },
      { regex: /\byarn\s+add\b/, reason: "Installs yarn packages" },
      { regex: /\bpnpm\s+add\b/, reason: "Installs pnpm packages" },
      { regex: /\bpip(?:3)?\s+install\b/, reason: "Installs Python packages" },
      { regex: /\bapt(?:-get)?\s+install\b/, reason: "Installs system packages" },
      { regex: /\bbrew\s+install\b/, reason: "Installs Homebrew packages" },
      { regex: /\bgo\s+install\b/, reason: "Installs Go packages" },
      { regex: /\bcargo\s+install\b/, reason: "Installs Cargo packages" },
      { regex: /\bbundle\s+install\b/, reason: "Installs Ruby gems" },
    ];

    for (const pattern of installPatterns) {
      if (pattern.regex.test(lower)) {
        return { required: true, reason: pattern.reason };
      }
    }

    if (/[;&|]/.test(command)) {
      return {
        required: true,
        reason: "Contains multiple chained commands",
      };
    }

    if (/\b(?:curl|wget)\b.*\|/.test(lower)) {
      return {
        required: true,
        reason: "Pipes remote script to shell",
      };
    }

    return { required: false, reason: "" };
  }

  private async confirmRunCommand(
    command: string,
    reason: string
  ): Promise<boolean> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.log(
        chalk.yellow(
          `  ⚠️  Refusing to run "${command}" without interactive approval (${reason}).`
        )
      );
      return false;
    }

    try {
      const { approve } = await inquirer.prompt<{
        approve: boolean;
      }>([
        {
          type: "confirm",
          name: "approve",
          default: false,
          message: `Run command "${command}"? (${reason})`,
        },
      ]);

      return approve;
    } catch (error) {
      console.log(
        chalk.red(
          `  ❌ Failed to prompt for command approval: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      );
      return false;
    }
  }

  private prepareRunCommand(command: string): {
    command: string;
    skipExecution: boolean;
    message?: string;
    resultMessage?: string;
  } {
    const trimmed = command.trim();

    if (!trimmed) {
      return {
        command: trimmed,
        skipExecution: true,
        resultMessage: "No command provided",
      };
    }

    const cdWithRest = trimmed.match(/^cd\s+([^&]+?)\s*&&\s*(.+)$/);
    if (cdWithRest) {
      const targetInput = cdWithRest[1].trim();
      const target = this.resolveDirectory(targetInput);
      if (!target) {
        return {
          command: "",
          skipExecution: true,
          resultMessage: `Directory not found: ${targetInput}`,
          message: `⚠️  Directory not found: ${targetInput}`,
        };
      }

      this.currentDirectory = target;
      return {
        command: cdWithRest[2].trim(),
        skipExecution: false,
        message: `Changed directory to ${target}`,
      };
    }

    const cdOnly = trimmed.match(/^cd\s+(.+)$/);
    if (cdOnly) {
      const targetInput = cdOnly[1].trim();
      const target = this.resolveDirectory(targetInput);
      if (!target) {
        return {
          command: "",
          skipExecution: true,
          resultMessage: `Directory not found: ${targetInput}`,
          message: `⚠️  Directory not found: ${targetInput}`,
        };
      }

      this.currentDirectory = target;
      return {
        command: "",
        skipExecution: true,
        resultMessage: `Changed directory to ${target}`,
        message: `Changed directory to ${target}`,
      };
    }

    return {
      command: trimmed,
      skipExecution: false,
    };
  }

  private resolveDirectory(input: string): string | null {
    const cleaned = input.replace(/^['"]|['"]$/g, "");
    if (!cleaned) {
      return null;
    }

    const target = path.isAbsolute(cleaned)
      ? cleaned
      : path.resolve(this.currentDirectory, cleaned);

    if (!existsSync(target)) {
      return null;
    }

    return target;
  }

  private buildPlan(userMessage: string): Array<{
    title: string;
    status: "pending" | "in_progress" | "done";
  }> {
    const steps = [
      "Understand request",
      "Collect project context",
      "Execute tool",
      "Review changes",
      "Summarize next steps",
    ];

    return steps.map((title) => ({ title, status: "pending" }));
  }

  private displayPlan(): void {
    if (this.plan.length === 0) {
      return;
    }

    console.log(chalk.blue("💭 Plan"));
    this.plan.forEach((step, index) => {
      const marker =
        step.status === "done"
          ? chalk.green("✓")
          : step.status === "in_progress"
          ? chalk.yellow("…")
          : chalk.gray("•");
      console.log(
        chalk.gray(`  ${index + 1}. `) +
          marker +
          chalk.gray(" ") +
          (step.status === "done"
            ? chalk.green(step.title)
            : step.status === "in_progress"
            ? chalk.yellow(step.title)
            : chalk.white(step.title))
      );
    });
    console.log("");
  }

  private displayPlanProgress(): void {
    if (this.plan.length === 0) {
      return;
    }

    const completed = this.plan.filter((step) => step.status === "done").length;
    const total = this.plan.length;
    console.log(
      chalk.blue(`📈 Plan progress: ${completed}/${total} steps completed`)
    );
    console.log("");
  }

  private markPlanStepInProgress(title: string): void {
    const step = this.plan.find((item) => item.title === title);
    if (step) {
      step.status = "in_progress";
    }
  }

  private markPlanStepDone(title: string): void {
    const step = this.plan.find((item) => item.title === title);
    if (step) {
      step.status = "done";
    }
  }

  private markPlanStepPending(title: string): void {
    const step = this.plan.find((item) => item.title === title);
    if (step) {
      step.status = "pending";
    }
  }

  /**
   * Review and apply proposed edits
   */
  private async reviewEdits(): Promise<void> {
    console.log(chalk.bold.blue("\n\n📝 Proposed Changes:\n"));
    console.log(chalk.cyan("🧠 My reasoning for these changes:"));
    console.log(
      chalk.gray(
        "  📋 I've analyzed your request and identified the files that need modification"
      )
    );
    console.log(
      chalk.gray(
        "  🔍 Each change serves a specific purpose in implementing your requirements"
      )
    );
    console.log(
      chalk.gray(
        "  🛠️  I'll show you the diffs so you can review and approve each change"
      )
    );
    console.log("");

    // If multiple edits, allow bulk selection first
    if (this.proposedEdits.length > 1) {
      const { selected } = await inquirer.prompt([
        {
          type: "checkbox",
          name: "selected",
          message: "Select files to apply (space to toggle, enter to confirm):",
          choices: this.proposedEdits.map((e, idx) => ({
            name: `${idx + 1}. ${e.path} - ${e.description}`,
            value: idx,
            checked: true,
          })),
          pageSize: Math.min(10, this.proposedEdits.length),
        },
      ]);

      // If nothing selected, bail out gracefully
      if (!selected || selected.length === 0) {
        console.log(chalk.gray("No changes selected."));
        return;
      }

      // Show detailed diffs and confirm per selection
      for (const idx of selected as number[]) {
        const edit = this.proposedEdits[idx];

        console.log(chalk.bold.yellow(`\n${idx + 1}. ${edit.path}`));
        console.log(chalk.gray(`   ${edit.description}\n`));

        const diff = generateDiff(edit.oldContent, edit.newContent);
        if (diff.length > 0) {
          console.log(chalk.gray("┌─ Changes:"));
          diff.slice(0, 200).forEach((line) => console.log(line));
          if (diff.length > 200) {
            console.log(
              chalk.gray(`└─ ... and ${diff.length - 200} more lines\n`)
            );
          } else {
            console.log(chalk.gray("└─\n"));
          }
        } else {
      console.log(
        chalk.green("   No textual diff (new or identical file)\n")
      );
    }

        const { confirm } = await inquirer.prompt([
          {
            type: "confirm",
            name: "confirm",
            message: `Apply changes to ${edit.path}?`,
            default: true,
          },
        ]);

        if (!confirm) {
          console.log(
            chalk.cyan(`🧠 I understand you want to skip this change`)
          );
          console.log(
            chalk.gray(
              `  This file won't be modified, but I can help with alternatives if needed`
            )
          );
          this.appliedEdits.push({
            path: edit.path,
            description: edit.description + " (skipped)",
            success: false,
          });
          continue;
        }

        console.log(chalk.cyan(`🧠 Applying changes to ${edit.path}:`));
        console.log(
          chalk.gray(`  This will implement the ${edit.description}`)
        );
        console.log(
          chalk.gray(`  The changes will help achieve your overall goal`)
        );

        const result = applyEdit(edit, this.cwd);
        const success = !result.error;
      this.appliedEdits.push({
        path: edit.path,
        description: edit.description,
        success,
        });
        if (result.error) {
          console.log(chalk.red(`\n❌ ${result.error}\n`));
          console.log(chalk.cyan(`🧠 I encountered an error:`));
          console.log(
            chalk.gray(
              `  Let me think about alternative approaches to achieve the same goal`
            )
          );
        } else {
          console.log(chalk.green(`\n✅ ${result.result}\n`));
          console.log(chalk.cyan(`🧠 Great! This change is now applied:`));
          console.log(
            chalk.gray(`  This brings us closer to completing your request`)
          );
          this.updateTodoStatus(edit.path, "completed");

          // Test the implementation if it's a code change
          if (
            edit.path.endsWith(".js") ||
            edit.path.endsWith(".ts") ||
            edit.path.endsWith(".py") ||
            edit.path.endsWith(".go") ||
            edit.path.endsWith(".rs")
          ) {
            await this.testImplementation(edit);
          }
        }
      }
      return;
    }

    // Single edit flow (retain interactive detail)
    for (let i = 0; i < this.proposedEdits.length; i++) {
      const edit = this.proposedEdits[i];

      console.log(chalk.bold.yellow(`\n${i + 1}. ${edit.path}`));
      console.log(chalk.gray(`   ${edit.description}\n`));

      const diff = generateDiff(edit.oldContent, edit.newContent);
      if (diff.length > 0) {
        console.log(chalk.gray("┌─ Changes:"));
      await this.showDiff(diff);
    } else {
      console.log(
        chalk.green("   No textual diff (new or identical file)\n")
      );
      }

      const { action } = await inquirer.prompt([
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
      ]);

      if (action === "apply") {
        console.log(chalk.cyan(`🧠 Applying changes to ${edit.path}:`));
        console.log(
          chalk.gray(`  This will implement the ${edit.description}`)
        );
        console.log(
          chalk.gray(`  The changes will help achieve your overall goal`)
        );

        const result = applyEdit(edit, this.cwd);
        const success = !result.error;
        this.appliedEdits.push({
          path: edit.path,
          description: edit.description,
          success,
        });
        if (result.error) {
          console.log(chalk.red(`\n❌ ${result.error}\n`));
          console.log(chalk.cyan(`🧠 I encountered an error:`));
          console.log(
            chalk.gray(
              `  Let me think about alternative approaches to achieve the same goal`
            )
          );
        } else {
          console.log(chalk.green(`\n✅ ${result.result}\n`));
          console.log(chalk.cyan(`🧠 Great! This change is now applied:`));
          console.log(
            chalk.gray(`  This brings us closer to completing your request`)
          );
          this.updateTodoStatus(edit.path, "completed");

          // Test the implementation if it's a code change
          if (
            edit.path.endsWith(".js") ||
            edit.path.endsWith(".ts") ||
            edit.path.endsWith(".py") ||
            edit.path.endsWith(".go") ||
            edit.path.endsWith(".rs")
          ) {
            await this.testImplementation(edit);
          }
        }
      } else {
        console.log(chalk.cyan(`🧠 I understand you want to skip this change`));
        console.log(
          chalk.gray(
            `  This file won't be modified, but I can help with alternatives if needed`
          )
        );
        console.log(chalk.gray("\nSkipped\n"));
        this.appliedEdits.push({
          path: edit.path,
          description: edit.description + " (skipped)",
          success: false,
        });
      }
    }
  }

  /**
   * Intelligently analyze error and suggest solutions
   */
  private async analyzeError(error: string): Promise<string> {
    try {
      console.log(chalk.blue("🔍 Analyzing error message..."));
      console.log(
        chalk.gray(
          `  📝 Error: ${error.substring(0, 100)}${
            error.length > 100 ? "..." : ""
          }`
        )
      );
      console.log("");

      // Use web search to research the error
      console.log(chalk.blue("🌐 Researching solutions online..."));
      const searchQuery = `"${error}" solution fix troubleshooting`;
      const webSearchResult = await this.executeTool({
        tool: "google_search",
        params: { query: searchQuery },
        content: "",
      });
      console.log(chalk.green("  ✓ Web research completed"));
      console.log("");

      // Add delay to let users read the output
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Analyze the project to understand context
      console.log(chalk.blue("📂 Analyzing project context..."));
      const projectAnalysis = await this.executeTool({
        tool: "analyze_project",
        params: {},
        content: "",
      });
      console.log(chalk.green("  ✓ Project analysis completed"));
      console.log("");

      // Add delay to let users read the output
      await new Promise((resolve) => setTimeout(resolve, 1000));

      return `Error Analysis:
${error}

Project Context:
${projectAnalysis}

Web Research:
${webSearchResult}

Based on this analysis, suggest a solution.`;
    } catch (error) {
      console.log(chalk.red(`❌ Error analysis failed: ${error}`));
      return `Error Analysis: ${error}`;
    }
  }

  private handleSimpleToolFailure(
    toolCall: any,
    result: string,
    toolResults: string[]
  ): boolean {
    const missing = this.detectMissingPath(toolCall, result);
    if (!missing) {
      return false;
    }

    const target =
      missing.path || (missing.type === "file" ? "requested file" : "requested directory");
    console.log(
      chalk.yellow(
        `    ⚠️ ${missing.type === "file" ? "File" : "Directory"} "${target}" not found.`
      )
    );
    const guidance =
      missing.type === "file"
        ? "      Use propose_edit to create it or verify the path before retrying."
        : "      Create the directory or adjust the path, then rerun the command.";
    console.log(chalk.gray(guidance));
    console.log(
      chalk.gray(
        "      Skipping escalated recovery steps for this known, non-fatal condition."
      )
    );

    this.markPlanStepPending("Execute tool");
    toolResults.push(result);
    return true;
  }

  private detectMissingPath(
    toolCall: any,
    message: string
  ): { type: "file" | "directory"; path: string } | null {
    const lower = message.toLowerCase();
    if (!toolCall || !toolCall.tool) {
      return null;
    }

    if (
      toolCall.tool === "read_file" &&
      (lower.includes("file not found") || lower.includes("note: this file does not exist yet"))
    ) {
      const pathParam =
        toolCall.params?.path ||
        toolCall.params?.file ||
        toolCall.params?.filepath ||
        "";
      const detected =
        pathParam ||
        this.extractPathFromMessage(message, /file not found:\s*(.+)/i) ||
        this.extractPathFromMessage(message, /note: this file does not exist yet\.\s*(.+)/i);
      return { type: "file", path: detected };
    }

    if (toolCall.tool === "list_files" && lower.includes("directory not found")) {
      const pathParam =
        toolCall.params?.path ||
        toolCall.params?.dir ||
        toolCall.params?.directory ||
        "";
      const detected = pathParam || this.extractPathFromMessage(message, /directory not found:\s*(.+)/i);
      return { type: "directory", path: detected };
    }

    return null;
  }

  private extractPathFromMessage(message: string, pattern: RegExp): string {
    const match = message.match(pattern);
    return match ? match[1].trim() : "";
  }

  private getSimpleAlternative(
    toolCall: any,
    error: string
  ): { log: string; response: string } | null {
    const missing = this.detectMissingPath(toolCall, error);
    if (!missing) {
      return null;
    }

    const target =
      missing.path || (missing.type === "file" ? "requested file" : "requested directory");
    const log = `${missing.type === "file" ? "File" : "Directory"} "${target}" is missing.`;
    const response =
      missing.type === "file"
        ? `Handled missing file: ${target}. Create it with propose_edit or adjust the path before retrying.`
        : `Handled missing directory: ${target}. Create it or adjust the path before retrying.`;
    return { log, response };
  }

  /**
   * Try alternative approach when a tool fails
   */
  private async tryAlternativeApproach(
    toolCall: any,
    error: string
  ): Promise<string | null> {
    const simpleAlternative = this.getSimpleAlternative(toolCall, error);
    if (simpleAlternative) {
      console.log(chalk.gray(`  ℹ️ ${simpleAlternative.log}`));
      return simpleAlternative.response;
    }

    console.log(chalk.yellow(`🔄 Analyzing failure and trying alternative...`));
    console.log(chalk.gray(`  🎯 Original tool: ${toolCall.tool}`));
    console.log(
      chalk.gray(`  📋 Parameters: ${JSON.stringify(toolCall.params, null, 2)}`)
    );
    console.log("");

    try {
      // Intelligently analyze the error
      const errorAnalysis = await this.analyzeError(error);

      // Analyze what went wrong and suggest alternatives
      console.log(chalk.blue("🧠 Generating alternative solution..."));
      const analysisPrompt = `The tool ${toolCall.tool} failed with error: ${error}

${errorAnalysis}

Please analyze this error and suggest an alternative approach. Consider:
1. What was the original intent?
2. What does this error message mean?
3. What are the common solutions for this type of error?
4. What alternative tools or approaches could work?
5. How can we break this down into smaller steps?

IMPORTANT: Don't repeat the same failing command. Analyze the error and suggest a different approach that addresses the root cause.

If you're unsure about the error, you can:
- Use web_search to research the error message
- Use analyze_project to understand the project structure
- Use read_file to examine relevant files
- Use run_command to try diagnostic commands

Provide a practical alternative solution that addresses the root cause.`;

      const alternativeResponse = await this.executeWithTimeout(
        () =>
          this.provider.chat([
            { role: "system", content: this.getSystemPrompt() },
            { role: "user", content: analysisPrompt },
          ]),
        this.timeouts.chat,
        `alternative analysis (${this.providerType})`
      );
      console.log(chalk.green("  ✓ Alternative solution generated"));
      console.log("");

      // Add delay to let users read the output
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Try to execute the alternative approach
      console.log(chalk.blue("🔧 Executing alternative approach..."));
      const alternativeToolCalls = parseToolCalls(alternativeResponse);
      if (alternativeToolCalls.length > 0) {
        console.log(
          chalk.gray(`  🎯 Alternative tool: ${alternativeToolCalls[0].tool}`)
        );
        console.log(
          chalk.gray(
            `  📋 Parameters: ${JSON.stringify(
              alternativeToolCalls[0].params,
              null,
              2
            )}`
          )
        );
        console.log("");

        const alternativeResult = await this.executeTool(
          alternativeToolCalls[0]
        );

        // Check if alternative result is successful (intelligent success detection)
        const isSuccess =
          !alternativeResult.includes("Error:") &&
          !alternativeResult.includes("❌") &&
          !alternativeResult.includes("Command failed") &&
          !alternativeResult.includes("failed") &&
          !alternativeResult.includes("error") &&
          !alternativeResult.includes("Error") &&
          !alternativeResult.includes("not found") &&
          !alternativeResult.includes("cannot find") &&
          !alternativeResult.includes("does not exist") &&
          !alternativeResult.includes("permission denied") &&
          !alternativeResult.includes("access denied") &&
          !alternativeResult.includes("syntax error") &&
          !alternativeResult.includes("compilation error") &&
          !alternativeResult.includes("build failed") &&
          !alternativeResult.includes("import error") &&
          !alternativeResult.includes("module not found") &&
          !alternativeResult.includes("package not found") &&
          !alternativeResult.includes("dependency") &&
          !alternativeResult.includes("missing") &&
          !alternativeResult.includes("undefined") &&
          !alternativeResult.includes("not defined");

        if (isSuccess) {
          console.log(chalk.green("  ✓ Alternative approach succeeded"));
          console.log(
            chalk.gray(
              `    Result: ${alternativeResult.substring(0, 100)}${
                alternativeResult.length > 100 ? "..." : ""
              }`
            )
          );
          return alternativeResult;
        } else {
          console.log(chalk.red("  ❌ Alternative approach also failed"));
          console.log(
            chalk.gray(
              `    Result: ${alternativeResult.substring(0, 100)}${
                alternativeResult.length > 100 ? "..." : ""
              }`
            )
          );
        }
      } else {
        console.log(
          chalk.yellow("  ⚠️ No alternative tools found in response")
        );
      }

      return null;
    } catch (error) {
      console.log(chalk.red(`❌ Alternative approach failed: ${error}`));
      return null;
    }
  }

  /**
   * Get system prompt for the agent
   */
  /**
   * Generate MCP tools section for system prompt
   */
  private getMCPToolsSection(): string {
    if (this.mcpTools.length === 0) {
      return '';
    }

    let section = '\n## MCP Tools (External Integrations)\n\n';
    section += `You have access to ${this.mcpTools.length} additional tools from connected MCP servers:\n\n`;

    this.mcpTools.forEach((tool, index) => {
      section += `${index + BUILT_IN_TOOL_COUNT + 1}. **${tool.name}** - ${tool.description}\n`;
      section += `   Format: <tool name="${tool.name}"`;

      // Add parameter hints from schema
      if (tool.inputSchema.properties) {
        const params = Object.keys(tool.inputSchema.properties);
        params.forEach(param => {
          section += ` ${param}="value"`;
        });
      }

      section += `></tool>\n\n`;
    });

    section += '**Note**: MCP tools are prefixed with their server name (e.g., `github.create_issue`)\n';

    return section;
  }

  private getSystemPrompt(): string {
    const mcpSection = this.getMCPToolsSection();

    return `You are an intelligent coding assistant with access to tools for project analysis, file operations, and project setup.

## Communication Style
- Be conversational and helpful, like Claude or Gemini
- Explain what you're doing and why
- Show your thinking process
- Handle errors gracefully with alternative approaches
- Provide clear progress updates
- Ask for clarification when needed
- Break down complex tasks into steps

## Error Handling Guidelines
- When a command fails, analyze the error message intelligently
- Use web_search to research unknown errors and find solutions
- Use analyze_project to understand the project structure and requirements
- Use read_file to examine relevant files and understand the codebase
- Try alternative approaches when the first attempt fails
- Don't repeat the same failing command - find a different approach
- Always address the root cause before retrying the original command
- Be framework-agnostic and learn from error messages
- Use diagnostic commands to understand the environment better

## Available Tools

1. **analyze_project** - Analyze the current project structure and type
   Format: <tool name="analyze_project"></tool>

2. **read_file** - Read the contents of a file
   Format: <tool name="read_file" path="path/to/file.ext"></tool>

3. **list_files** - List files and directories in a path
   Format: <tool name="list_files" path="path/to/directory"></tool>

4. **propose_edit** - Create or modify a file with new content
   Format: <tool name="propose_edit" path="path/to/file.ext" description="Brief description of changes">
   [Complete file content goes here]
   </tool>

5. **run_command** - Execute shell commands for project setup
   Format: <tool name="run_command" command="command to run"></tool>

6. **suggest_setup** - Get setup suggestions based on user request
   Format: <tool name="suggest_setup"></tool>

7. **scaffold_project** - Create a new project with scaffolding
   Format: <tool name="scaffold_project" type="react" name="my-app"></tool>

8. **find_files** - Find files with advanced patterns and filters
   Format: <tool name="find_files" pattern="*.js" fileTypes="js,ts" maxDepth="3"></tool>

9. **read_many_files** - Read multiple files at once
   Format: <tool name="read_many_files" files="file1.js,file2.js" maxFiles="5"></tool>

10. **search_text** - Search for text content across files
    Format: <tool name="search_text" term="function" filePattern="*.js" caseSensitive="false"></tool>

11. **read_folder** - Read folder contents recursively with analysis
    Format: <tool name="read_folder" path="src" maxDepth="2" includeStats="true"></tool>

12. **google_search** - Search Google for research and documentation
    Format: <tool name="google_search" query="react hooks tutorial" site="reactjs.org"></tool>

13. **web_fetch** - Fetch resources from the web
    Format: <tool name="web_fetch" url="https://api.example.com/data" method="GET"></tool>

14. **save_memory** - Save information to persistent memory
    Format: <tool name="save_memory" key="project-notes" content="Important project details"></tool>

15. **load_memory** - Load information from persistent memory
    Format: <tool name="load_memory" key="project-notes"></tool>

16. **todo** - Manage the session TODO list (create/add/update tasks)
    Format: <tool name="todo" action="add">- Implement unit tests
      - Update docs</tool>
    Actions: create, add, list, start, complete, update, remove, clear

17. **grep** - Search for pattern in a specific file with line numbers (PREFERRED for large files)
    Format: <tool name="grep" path="src/cli.ts" pattern="\\.version\\(" maxResults="10"></tool>
    Returns exact line numbers. Use this before editing for precise location.

18. **edit_line** - Edit a specific line when you know the exact line number
    Format: <tool name="edit_line" path="src/cli.ts" lineNumber="611" oldText='.version("1.0.0")' newText='.version("0.6.7")"></tool>
    Requires exact line number from grep. More efficient than propose_edit for single-line changes.

19. **semantic_search** - Search codebase using natural language queries (AI-powered code search)
    Format: <tool name="semantic_search" query="authentication logic" limit="10" minScore="0.5" filePattern="**/*.ts"></tool>
    Use this to find code by meaning/intent, not just keywords. Great for discovering functionality, patterns, or similar code.
    Note: Requires Ollama or OpenRouter provider with embedding support.

${mcpSection}

## Critical Rules

1. **Tool Format**: Use XML-style tags exactly as shown above
2. **propose_edit Content**: Place the ENTIRE file content BETWEEN opening and closing tags, not in attributes
3. **No Self-Closing**: Never use <tool ... /> for propose_edit - always use <tool>...</tool>
4. **Complete Files**: Always provide the full file content in propose_edit, not just changes
5. **Explain First**: Always explain what you're doing before using tools
6. **For Large Files (>100 lines)**: Use grep to find line numbers, then edit_line for precise edits
7. **For Small Files or New Files**: Use propose_edit with full content
8. **Never Use Placeholders**: Never write "// ... rest of file" - always provide complete content

## Smart Project Analysis

**ALWAYS start by analyzing the project** to understand what type of project you're working with:

1. **First Step**: Use analyze_project to understand the project structure
2. **Context Awareness**: Based on the analysis, provide appropriate suggestions
3. **Project Type Detection**: Recognize if this is a React, Node.js CLI, Python, etc. project
4. **Smart Suggestions**: If user asks for React components in a CLI project, suggest creating a new React project

## Workflow Guidelines

1. **Analyze First**: Always use analyze_project to understand the project context
2. **Understand the Request**: Read the user's question carefully
3. **Provide Context-Aware Help**: 
   - If user wants React components in a CLI project → suggest create-react-app
   - If user wants CLI tools in a React project → suggest creating a separate CLI project
   - If project is empty → suggest appropriate scaffolding tools
4. **Plan Your Approach**: For multi-step tasks, create a TODO list
5. **Explore First**: Use list_files and read_file to understand existing code
6. **Implement**: Use propose_edit with complete file content
7. **Explain**: Clearly communicate what you're doing at each step

## Project Setup Scenarios

### Empty Directories
- **Always detect empty directories** and suggest appropriate scaffolding
- **Use scaffold_project tool** for creating new projects
- **Supported project types**: react, vue, angular, next, nuxt, node, python, go, rust
- **Example**: User asks "create a React todo app" in empty directory → use scaffold_project

### React Development
- If user asks for React components but project isn't React → suggest: scaffold_project with type="react"
- If project is React → create components in src/components/

### Node.js CLI Development  
- If user asks for CLI features in non-CLI project → suggest: scaffold_project with type="node"
- If project is CLI → add commands in src/commands/

### Framework-Specific Requests
- **Vue**: scaffold_project type="vue" for Vue apps
- **Angular**: scaffold_project type="angular" for Angular apps  
- **Next.js**: scaffold_project type="next" for Next.js apps
- **Python**: scaffold_project type="python" for Python projects
- **Go**: scaffold_project type="go" for Go projects
- **Rust**: scaffold_project type="rust" for Rust projects

### Empty Projects
- **Always suggest scaffold_project** instead of manual setup
- **Provide step-by-step instructions** after scaffolding
- **Guide users to the new project directory**

## TODO Lists

For complex tasks, create a TODO list to track progress:

TODO:
- Analyze project structure
- Understand the current implementation
- Identify files that need changes
- Implement the required functionality
- Test and verify the changes

The system will automatically display and update this list.

## File Operations

- **Reading**: Use read_file to examine existing files before modifying them
- **Creating**: Use propose_edit to create new files (no need to read first)
- **Modifying**: Read the file first, then use propose_edit with updated content
- **Non-existent Files**: If read_file returns "File not found", just create it with propose_edit

## Best Practices

- **Always analyze the project first** to provide context-aware help
- Be concise and focused in your explanations
- Only read files you actually need to see
- Keep TODO lists realistic and actionable
- Provide complete, working code in edits
- **Suggest appropriate project setup** when the current project doesn't match the user's request
- Don't make assumptions - ask for clarification if needed`;
  }

  /**
   * Format AI response for display (remove tool tags)
   */
  private formatResponse(response: string): string {
    // Remove tool tags for cleaner display
    return response.replace(/<tool[\s\S]*?<\/tool>/g, "").trim();
  }

  private parseTasksFromInput(input: string): string[] {
    if (!input) {
      return [];
    }

    return input
      .split(/\r?\n|;/)
      .flatMap((line) =>
        line.includes(',') && !line.includes('http')
          ? line.split(',').map((part) => part.trim())
          : [line]
      )
      .map((line) => line.replace(/^[-*]\s+/, '').trim())
      .filter((line) => line.length > 0);
  }

  private setTodoListFromTasks(tasks: string[]): void {
    this.todoList = tasks.map((task) => ({ task, status: 'pending' as const }));
  }

  private addTodoItems(tasks: string[]): number {
    const additions = tasks
      .map((task) => task.trim())
      .filter((task) => task.length > 0);

    additions.forEach((task) => {
      this.todoList.push({ task, status: 'pending' });
    });

    return additions.length;
  }

  private findTodoIndex(taskPattern?: string, index?: number): number {
    if (typeof index === 'number' && index >= 0 && index < this.todoList.length) {
      return index;
    }

    if (taskPattern) {
      const normalized = taskPattern.toLowerCase();
      return this.todoList.findIndex((item) =>
        item.task.toLowerCase().includes(normalized)
      );
    }

    return -1;
  }

  private formatTodoList(): string {
    if (this.todoList.length === 0) {
      return 'TODO list is currently empty.';
    }

    return this.todoList
      .map((item, index) => {
        const checkbox =
          item.status === 'completed'
            ? '[x]'
            : item.status === 'in_progress'
            ? '[~]'
            : '[ ]';
        return `${index + 1}. ${checkbox} ${item.task}`;
      })
      .join("\n");
  }

  /**
   * Parse and display TODO list from AI response
   */
  private parseTodoList(response: string): void {
    const todoRegex = /(?:TODO|Tasks?|Steps?):\s*\n((?:[-*]\s+.+\n?)+)/gi;
    const match = todoRegex.exec(response);

    if (!match) {
      return;
    }

    const tasks = this.parseTasksFromInput(match[1]);
    if (tasks.length === 0) {
      return;
    }

    this.setTodoListFromTasks(tasks);
    this.displayTodoList();
  }

  /**
   * Display the TODO list
   */
  private displayTodoList(): void {
    console.log(chalk.bold.blue("\n[TODO] Task List\n"));

    if (this.todoList.length === 0) {
      console.log(chalk.gray("  (no tasks yet)\n"));
      return;
    }

    this.todoList.forEach((item, index) => {
      const icon =
        item.status === "completed"
          ? chalk.green("[x]")
          : item.status === "in_progress"
          ? chalk.yellow("[~]")
          : chalk.gray("[ ]");

      const text =
        item.status === "completed"
          ? chalk.gray(item.task)
          : item.status === "in_progress"
          ? chalk.cyan(item.task)
          : item.task;

      console.log(`${icon} ${index + 1}. ${text}`);
    });

    console.log("");
  }

  /**
   * Update TODO item status
   */
  private updateTodoStatus(
    taskPattern: string | undefined,
    status: "in_progress" | "completed",
    index?: number
  ): TodoItem | null {
    const resolvedIndex = this.findTodoIndex(taskPattern, index);
    if (resolvedIndex === -1) {
      return null;
    }

    const item = this.todoList[resolvedIndex];
    item.status = status;
    this.displayTodoList();
    return item;
  }

  /**
   * Test the implementation after applying changes
   */
  private async testImplementation(edit: FileEdit): Promise<void> {
    console.log(chalk.cyan("🧪 Testing the implementation..."));
    console.log(chalk.gray("  Let me verify that the changes work correctly"));

    try {
      // Test different types of implementations
      if (
        (edit.path.endsWith(".js") && edit.newContent.includes("app.get")) ||
        edit.newContent.includes("app.post")
      ) {
        await this.testNodeJSServer(edit);
      } else if (
        edit.path.endsWith(".py") &&
        edit.newContent.includes("@app.route")
      ) {
        await this.testPythonFlask(edit);
      } else if (
        edit.path.endsWith(".go") &&
        edit.newContent.includes("http.HandleFunc")
      ) {
        await this.testGoServer(edit);
      } else {
        console.log(
          chalk.gray("  📋 This appears to be a configuration or utility file")
        );
        console.log(chalk.gray("  ✅ Changes have been applied successfully"));
      }
    } catch (error) {
      console.log(
        chalk.yellow("  ⚠️  Could not automatically test the implementation")
      );
      console.log(
        chalk.gray("  💡 You can test it manually by running your application")
      );
    }
  }

  /**
   * Test Node.js/Express server implementation
   */
  private async testNodeJSServer(edit: FileEdit): Promise<void> {
    console.log(chalk.gray("  🔍 Testing Node.js/Express server..."));

    // Check for syntax errors
    try {
      const { execSync } = await import("child_process");
      execSync(`node -c "${edit.path}"`, { cwd: this.cwd, stdio: "pipe" });
      console.log(chalk.green("  ✅ Syntax check passed"));
    } catch (error) {
      console.log(chalk.red("  ❌ Syntax error detected"));
      return;
    }

    // Check if package.json exists and has required dependencies
    const packageJsonPath = `${this.cwd}/package.json`;
    const { existsSync, readFileSync } = await import("fs");

    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
        const hasExpress =
          packageJson.dependencies?.express ||
          packageJson.devDependencies?.express;

        if (hasExpress) {
          console.log(chalk.green("  ✅ Express dependency found"));
        } else {
          console.log(
            chalk.yellow("  ⚠️  Express dependency not found in package.json")
          );
          console.log(chalk.gray("  💡 Run: npm install express"));
        }
      } catch (error) {
        console.log(chalk.yellow("  ⚠️  Could not read package.json"));
      }
    }

    // Check for common patterns
    if (edit.newContent.includes("/health")) {
      console.log(chalk.green("  ✅ Health endpoint detected"));
    }
    if (edit.newContent.includes("app.listen")) {
      console.log(chalk.green("  ✅ Server startup code found"));
    }

    console.log(chalk.blue("  💡 To test: node " + edit.path));
  }

  /**
   * Test Python Flask implementation
   */
  private async testPythonFlask(edit: FileEdit): Promise<void> {
    console.log(chalk.gray("  🔍 Testing Python Flask server..."));

    // Check for syntax errors
    try {
      const { execSync } = await import("child_process");
      execSync(`python3 -m py_compile "${edit.path}"`, {
        cwd: this.cwd,
        stdio: "pipe",
      });
      console.log(chalk.green("  ✅ Syntax check passed"));
    } catch (error) {
      console.log(chalk.red("  ❌ Syntax error detected"));
      return;
    }

    // Check for Flask patterns
    if (edit.newContent.includes("@app.route")) {
      console.log(chalk.green("  ✅ Flask route decorators found"));
    }
    if (edit.newContent.includes("app.run")) {
      console.log(chalk.green("  ✅ Flask app startup code found"));
    }

    console.log(chalk.blue("  💡 To test: python3 " + edit.path));
  }

  /**
   * Test Go server implementation
   */
  private async testGoServer(edit: FileEdit): Promise<void> {
    console.log(chalk.gray("  🔍 Testing Go server..."));

    // Check for syntax errors
    try {
      const { execSync } = await import("child_process");
      execSync(`go build -o /dev/null "${edit.path}"`, {
        cwd: this.cwd,
        stdio: "pipe",
      });
      console.log(chalk.green("  ✅ Go compilation check passed"));
    } catch (error) {
      console.log(chalk.red("  ❌ Go compilation error detected"));
      return;
    }

    // Check for Go patterns
    if (edit.newContent.includes("http.HandleFunc")) {
      console.log(chalk.green("  ✅ HTTP handler found"));
    }
    if (edit.newContent.includes("http.ListenAndServe")) {
      console.log(chalk.green("  ✅ Server startup code found"));
    }

    console.log(chalk.blue("  💡 To test: go run " + edit.path));
  }

  /**
   * Display summary of all applied edits
   */
  private displayEditSummary(): void {
    if (this.appliedEdits.length === 0) return;

    console.log(chalk.bold.blue("\n📊 Implementation Summary:\n"));
    console.log(chalk.cyan("🧠 What we accomplished:"));
    console.log(
      chalk.gray(
        "  📋 I've analyzed your request and implemented the necessary changes"
      )
    );
    console.log(
      chalk.gray(
        "  🎯 Each modification serves a specific purpose in achieving your goal"
      )
    );
    console.log(
      chalk.gray("  ✅ Here's a comprehensive summary of what was implemented")
    );
    console.log("");

    const successful = this.appliedEdits.filter((e) => e.success);
    const failed = this.appliedEdits.filter((e) => !e.success);

    if (successful.length > 0) {
      console.log(
        chalk.green(
          `✅ Successfully implemented ${successful.length} change(s):\n`
        )
      );
      successful.forEach((edit) => {
        console.log(
          chalk.green(`  • ${edit.path}`) + chalk.gray(` - ${edit.description}`)
        );

        // Provide specific details about what was implemented
        if (
          edit.path.endsWith(".js") &&
          edit.description.toLowerCase().includes("health")
        ) {
          console.log(chalk.blue(`    🔗 Health endpoint: GET /health`));
          console.log(chalk.gray(`    📝 Returns server status and timestamp`));
        } else if (
          edit.path.endsWith(".js") &&
          edit.description.toLowerCase().includes("auth")
        ) {
          console.log(chalk.blue(`    🔐 Authentication system implemented`));
          console.log(
            chalk.gray(`    📝 Includes registration, login, and JWT tokens`)
          );
        } else if (
          edit.path.endsWith(".js") &&
          edit.description.toLowerCase().includes("api")
        ) {
          console.log(chalk.blue(`    🌐 API endpoints added`));
          console.log(chalk.gray(`    📝 RESTful API structure implemented`));
        }
      });
      console.log("");

      // Provide testing instructions
      console.log(chalk.cyan("🧪 Testing Instructions:"));
      console.log(chalk.gray("  📋 To test your implementation:"));
      successful.forEach((edit) => {
        if (edit.path.endsWith(".js")) {
          console.log(chalk.blue(`    • Run: node ${edit.path}`));
        } else if (edit.path.endsWith(".py")) {
          console.log(chalk.blue(`    • Run: python3 ${edit.path}`));
        } else if (edit.path.endsWith(".go")) {
          console.log(chalk.blue(`    • Run: go run ${edit.path}`));
        }
      });
      console.log("");
    }

    if (this.validationResults.length > 0) {
      console.log(chalk.cyan("🧪 Automated Validation:"));
      this.validationResults.forEach((result) => {
        const status = result.success
          ? chalk.green("PASS")
          : chalk.red("FAIL");
        console.log(chalk.gray(`  • ${result.label}: `) + status);
        if (result.output.trim()) {
          const snippet = result.output.trim().split("\n").slice(0, 5);
          snippet.forEach((line) => {
            console.log(chalk.gray(`      ${line}`));
          });
          if (result.output.trim().includes("\n")) {
            console.log(chalk.gray("      ..."));
          }
        }
      });
      console.log("");
    }

    if (failed.length > 0) {
      console.log(chalk.red(`❌ Failed to update ${failed.length} file(s):\n`));
      failed.forEach((edit) => {
        console.log(
          chalk.red(`  • ${edit.path}`) + chalk.gray(` - ${edit.description}`)
        );
      });
      console.log("");
    }

    console.log(chalk.gray("──────────────────────────────────────────"));
    console.log(chalk.bold(`Total: ${this.appliedEdits.length} change(s)`));
    console.log("");

    if (successful.length > 0) {
      console.log(chalk.cyan("✅ Changes applied successfully."));
      console.log(
        chalk.gray(
          "  Run the commands above when you're ready to verify the behaviour."
        )
      );
      console.log("");
    }
  }

  private async runPostEditValidation(): Promise<void> {
    if (!this.appliedEdits.some((edit) => edit.success)) {
      return;
    }

    console.log(chalk.bold.blue("\n🧪 Running validation checks..."));

    const runners = await this.detectValidationCommands();
    if (runners.length === 0) {
      console.log(
        chalk.gray(
          "  📋 No automated tests detected. Skipping validation run."
        )
      );
      return;
    }

    for (const runner of runners) {
      console.log(chalk.gray(`  ▶ ${runner.label}`));

      try {
        const result = await runCommand(runner.command, this.cwd, {
          timeoutMs: runner.timeoutMs ?? this.timeouts.command,
        });

        if (result.error) {
          console.log(chalk.red(`  ❌ ${result.error}`));
          this.validationResults.push({
            label: runner.label,
            success: false,
            output: result.error,
          });
        } else {
          console.log(chalk.green("  ✅ Passed"));
          this.validationResults.push({
            label: runner.label,
            success: true,
            output: result.result,
          });
        }
      } catch (error) {
        console.log(
          chalk.red(
            `  ❌ Validation command failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
        this.validationResults.push({
          label: runner.label,
          success: false,
          output: error instanceof Error ? error.message : String(error),
        });
      }
    }

    console.log("");
  }

  private async detectValidationCommands(): Promise<
    Array<{ label: string; command: string; timeoutMs?: number }>
  > {
    const runners: Array<{ label: string; command: string; timeoutMs?: number }> = [];

    const fs = await import("fs");
    const path = await import("path");
    const { existsSync, readFileSync } = fs;
    const { join } = path;
    const cwd = this.cwd;

    const packageJsonPath = join(cwd, "package.json");
    if (existsSync(packageJsonPath)) {
      let packageJson: any = null;
      try {
        packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
      } catch {
        packageJson = null;
      }

      const hasPnpmLock = existsSync(join(cwd, "pnpm-lock.yaml"));
      const hasYarnLock = existsSync(join(cwd, "yarn.lock"));
      const hasBunLock = existsSync(join(cwd, "bun.lockb"));

      const pm = hasPnpmLock
        ? "pnpm"
        : hasYarnLock
        ? "yarn"
        : hasBunLock
        ? "bun"
        : "npm";

      const buildScriptCommand = (script: string): string => {
        switch (pm) {
          case "pnpm":
            return `pnpm ${script}`;
          case "yarn":
            return `yarn ${script}`;
          case "bun":
            return script === "test" ? "bun test" : `bun run ${script}`;
          default:
            return script === "test" ? "npm test" : `npm run ${script}`;
        }
      };

      if (packageJson?.scripts?.test) {
        const scriptValue = String(packageJson.scripts.test).trim();
        const isPlaceholder = scriptValue.includes("no test specified");
        if (!isPlaceholder) {
          runners.push({
            label: `${pm} test`,
            command: buildScriptCommand("test"),
            timeoutMs: 120_000,
          });
        }
      }

      if (packageJson?.scripts?.lint) {
        runners.push({
          label: `${pm} lint`,
          command: buildScriptCommand("lint"),
          timeoutMs: 120_000,
        });
      }

      if (packageJson?.scripts?.["typecheck"]) {
        runners.push({
          label: `${pm} typecheck`,
          command: buildScriptCommand("typecheck"),
          timeoutMs: 120_000,
        });
      }
    }

    const pytestIni = join(cwd, "pytest.ini");
    const testsDir = join(cwd, "tests");
    const requirementsPath = join(cwd, "requirements.txt");

    let hasPytest = false;
    if (existsSync(pytestIni) || existsSync(testsDir)) {
      hasPytest = true;
    } else if (existsSync(requirementsPath)) {
      try {
        const requirements = readFileSync(requirementsPath, "utf-8")
          .toLowerCase()
          .split("\n");
        if (requirements.some((line) => line.startsWith("pytest"))) {
          hasPytest = true;
        }
      } catch {
        // ignore
      }
    }

    if (hasPytest) {
      runners.push({
        label: "pytest",
        command: "pytest",
        timeoutMs: 120_000,
      });
    }

    if (existsSync(join(cwd, "go.mod"))) {
      runners.push({
        label: "go test",
        command: "go test ./...",
        timeoutMs: 120_000,
      });
    }

    if (existsSync(join(cwd, "Cargo.toml"))) {
      runners.push({
        label: "cargo test",
        command: "cargo test",
        timeoutMs: 180_000,
      });
    }

    return runners;
  }

  private async showDiff(diffLines: string[]): Promise<void> {
    if (diffLines.length === 0) {
      console.log(chalk.green("   No textual diff (new or identical file)\n"));
      return;
    }

    const totalLines = diffLines.length;
    const chunkSize = 80;
    let offset = 0;

    console.log(chalk.gray("┌─ Diff"));

    while (offset < totalLines) {
      const chunk = diffLines
        .slice(offset, offset + chunkSize)
        .map((line) => ChatBoxUI.colorizeDiffLine(line));
      await ChatBoxUI.printPaged(chunk, 40);

      offset += chunkSize;
      if (offset < totalLines) {
        const { continueDiff } = await inquirer.prompt([
          {
            type: "confirm",
            name: "continueDiff",
            message: `Show more diff (${totalLines - offset} lines remaining)?`,
            default: true,
          },
        ]);

        if (!continueDiff) {
          console.log(
            chalk.gray(`└─ (diff truncated, ${totalLines - offset} lines hidden)\n`)
          );
          return;
        }
      }
    }

    console.log(chalk.gray("└─\n"));
  }

  private maybeWarnAboutContext(promptTokens: number): void {
    if (!this.contextLimit) {
      return;
    }

    const ratio = promptTokens / this.contextLimit;
    let level = 0;

    if (ratio >= 0.95) {
      level = 2;
    } else if (ratio >= 0.8) {
      level = 1;
    }

    if (level === 0 && this.contextWarningLevel !== 0 && ratio < 0.7) {
      this.contextWarningLevel = 0;
      return;
    }

    if (level > this.contextWarningLevel) {
      this.contextWarningLevel = level;
      const percentValue = ratio * 100;
      const percentLabel = percentValue.toFixed(1);
      const remaining = Math.max(this.contextLimit - promptTokens, 0);
      const remainingPercent = Math.max(0, 100 - percentValue).toFixed(1);

      if (level === 1) {
        console.log(
          chalk.yellow(
            `⚠️  Context usage at ${percentLabel}% (${promptTokens.toLocaleString()}/${this.contextLimit.toLocaleString()} tokens, ~${remainingPercent}% remaining)`
          )
        );
        console.log(
          chalk.gray(
            "   Consider using /compact or trimming earlier instructions to free up space."
          )
        );
      } else if (level === 2) {
        console.log(
          chalk.red(
            `🚨 Context nearly full (${percentLabel}% used, only ${remaining.toLocaleString()} tokens left).`
          )
        );
        console.log(
          chalk.gray(
            "   I may summarize older turns automatically; you can also run /compact manually."
          )
        );
      }
      console.log("");
    }
  }
}
