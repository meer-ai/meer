import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
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
  type FileEdit,
} from "../tools/index.js";
import { memory } from "../memory/index.js";

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
}

interface TodoItem {
  task: string;
  status: "pending" | "in_progress" | "completed";
}

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
      case 'ollama':
        return 300000; // 5 minutes for Ollama (local models can be very slow)
      case 'openai':
        return 60000;  // 1 minute for OpenAI
      case 'gemini':
        return 45000;  // 45 seconds for Gemini
      case 'anthropic':
        return 90000;  // 1.5 minutes for Anthropic (Claude models)
      case 'openrouter':
        return 75000;  // 1.25 minutes for OpenRouter (varies by underlying model)
      default:
        return 60000;  // 1 minute default
    }
  }

  /**
   * Initialize the agent with system prompt
   */
  initialize(contextPrompt: string) {
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

    // First, analyze the project to understand context
    console.log(chalk.blue("🔍 Analyzing project context..."));
    const projectAnalysis = analyzeProject(this.cwd);
    if (projectAnalysis.error) {
      console.log(
        chalk.red(`  ❌ Project analysis failed: ${projectAnalysis.error}`)
      );
      console.log(chalk.yellow("  🔄 Continuing with limited context..."));
    } else {
      console.log(chalk.green("  ✓ Project context understood"));
      // Add project analysis to context
      this.messages.push({
        role: "system",
        content: `Project Analysis:\n${projectAnalysis.result}`,
      });
    }

    let iteration = 0;
    let fullResponse = "";
    this.proposedEdits = [];
    const toolCallHistory: string[] = [];

    while (iteration < this.maxIterations) {
      iteration++;

      // Enhanced communication about what we're doing
      if (iteration === 1) {
        console.log(chalk.blue("💭 Planning my approach..."));
      } else {
        console.log(
          chalk.blue(
            `🔄 Iteration ${iteration}/${this.maxIterations} - Refining approach...`
          )
        );
      }

      // Get AI response with streaming for better UX
      const spinner = ora({
        text: chalk.blue("Thinking..."),
        spinner: {
          interval: 120,
          frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
        }
      }).start();
      let response: string = "";
      let hasStarted = false;
      let isFirstChunk = true;
      
      try {
        let chunkCount = 0;
        
        // Wrap streaming with timeout
        const streamingOperation = async () => {
          for await (const chunk of this.provider.stream(this.messages)) {
            chunkCount++;
            
            // Stop spinner on first chunk and start streaming
            if (!hasStarted) {
              spinner.stop();
              console.log(chalk.green("\n🤖 MeerAI:\n"));
              hasStarted = true;
              await new Promise(resolve => setTimeout(resolve, 100));
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
              await new Promise(resolve => setTimeout(resolve, delay));
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
          console.log(chalk.gray(`  Debug: No chunks received from provider`));
        } else if (!response.trim()) {
          console.log(chalk.gray(`  Debug: Received ${chunkCount} empty chunks`));
        }
        
        // Ensure spinner is stopped if no chunks received
        if (!hasStarted) {
          spinner.stop();
          console.log(chalk.yellow("⚠️  No response received from AI provider"));
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
            console.log(chalk.gray("   Configure additional providers with: meer setup"));
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

      // Check if response is empty or just whitespace
      if (!response.trim()) {
        console.log(chalk.yellow("⚠️  Received empty response, retrying with fallback..."));
        
        // Fallback to non-streaming chat if streaming fails
        try {
          const fallbackSpinner = ora(chalk.blue("Trying fallback approach...")).start();
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
            console.log(chalk.red("❌ Provider returned empty response even with fallback"));
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
        break;
      }
      toolCallHistory.push(currentCallSig);

      // Show AI's thinking with step-by-step communication
      const textBeforeTools = response.split("<tool")[0].trim();
      if (textBeforeTools) {
        console.log(chalk.cyan("💭 AI Thinking:"));
        console.log(chalk.gray("  " + textBeforeTools.replace(/\n/g, "\n  ")));
        console.log("");
      }

      // Execute tools with enhanced communication
      const toolResults: string[] = [];

      for (let i = 0; i < toolCalls.length; i++) {
        const toolCall = toolCalls[i];
        console.log(
          chalk.blue(`  ${i + 1}/${toolCalls.length} ${toolCall.tool}...`)
        );
        console.log(
          chalk.gray(
            `    📋 Parameters: ${JSON.stringify(toolCall.params, null, 2)}`
          )
        );
        console.log(
          chalk.gray(
            `    🎯 Purpose: ${toolCall.content || "No description provided"}`
          )
        );
        console.log("");

        try {
          const result = await this.executeTool(toolCall, userMessage);

          // Check if result indicates an error (intelligent error detection)
          const isError =
            result.includes("Error:") ||
            result.includes("❌") ||
            result.includes("Command failed") ||
            result.includes("failed") ||
            result.includes("error") ||
            result.includes("Error") ||
            result.includes("not found") ||
            result.includes("cannot find") ||
            result.includes("does not exist") ||
            result.includes("permission denied") ||
            result.includes("access denied") ||
            result.includes("syntax error") ||
            result.includes("compilation error") ||
            result.includes("build failed") ||
            result.includes("import error") ||
            result.includes("module not found") ||
            result.includes("package not found") ||
            result.includes("dependency") ||
            result.includes("missing") ||
            result.includes("undefined") ||
            result.includes("not defined");

          if (isError) {
            console.log(chalk.red(`    ❌ ${toolCall.tool} failed:`));
            console.log(chalk.red(`      ${result}`));
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
            console.log(
              chalk.gray(
                `      Result: ${result.substring(0, 100)}${
                  result.length > 100 ? "..." : ""
                }`
              )
            );
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
            console.log(chalk.green(`    ✓ Alternative approach succeeded`));
            toolResults.push(alternativeResult);
          } else {
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
      await this.reviewEdits();

      // Show summary of all edits
      this.displayEditSummary();
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
    if (errorLower.includes('quota') || 
        errorLower.includes('rate limit') || 
        errorLower.includes('429') ||
        errorLower.includes('resource_exhausted')) {
      return true;
    }
    
    // Authentication/API key errors
    if (errorLower.includes('unauthorized') || 
        errorLower.includes('401') ||
        errorLower.includes('invalid api key') ||
        errorLower.includes('authentication')) {
      return true;
    }
    
    // Service unavailable/connection errors
    if (errorLower.includes('service unavailable') || 
        errorLower.includes('502') ||
        errorLower.includes('503') ||
        errorLower.includes('504') ||
        errorLower.includes('404') ||
        errorLower.includes('not found') ||
        errorLower.includes('connection refused') ||
        errorLower.includes('network error') ||
        errorLower.includes('econnrefused') ||
        errorLower.includes('timeout')) {
      return true;
    }
    
    // Payment/billing errors
    if (errorLower.includes('billing') || 
        errorLower.includes('payment') ||
        errorLower.includes('subscription')) {
      return true;
    }
    
    // Specific provider error patterns
    if (errorLower.includes('ollama api error') ||
        errorLower.includes('openai api error') ||
        errorLower.includes('gemini api error') ||
        errorLower.includes('model not found') ||
        errorLower.includes('invalid model')) {
      return true;
    }
    
    return false;
  }

  /**
   * Switch to the next available provider
   */
  private async switchProvider(): Promise<boolean> {
    if (!this.autoSwitching.enabled || this.autoSwitching.fallbackProviders.length === 0) {
      return false;
    }
    
    this.autoSwitching.currentProviderIndex++;
    
    if (this.autoSwitching.currentProviderIndex >= this.autoSwitching.fallbackProviders.length) {
      console.log(chalk.red("❌ All fallback providers exhausted"));
      return false;
    }
    
    const fallback = this.autoSwitching.fallbackProviders[this.autoSwitching.currentProviderIndex];
    this.provider = fallback.provider;
    this.providerType = fallback.providerType;
    this.model = fallback.model;
    
    console.log(chalk.yellow(`🔄 Switching to ${fallback.providerType} (${fallback.model})`));
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
    console.log(chalk.gray("Your current provider is experiencing issues (quota exceeded, API key invalid, etc.)"));
    console.log(chalk.blue("\n💡 Auto-switching mode can automatically switch between configured providers"));
    console.log(chalk.gray("when errors occur, providing better reliability."));
    
    const { enableAuto } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'enableAuto',
        message: 'Would you like to enable auto-switching mode for this session?',
        default: true
      }
    ]);

    if (enableAuto) {
      this.autoSwitching.enabled = true;
      console.log(chalk.green("✅ Auto-switching enabled for this session"));
      console.log(chalk.gray("💡 To configure additional providers, run: meer setup"));
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
        console.log(chalk.yellow(`  ⏰ Operation timed out after ${timeout/1000}s: ${operationName}`));
        console.log(chalk.gray(`  🔄 Attempting graceful cancellation...`));
        reject(new Error(`Operation timeout: ${operationName} exceeded ${timeout}ms`));
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

        const edit = proposeEdit(filepath, content, description, this.cwd);
        this.proposedEdits.push(edit);

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

        console.log(chalk.gray(`  💻 ${command}`));
        console.log(chalk.gray(`  ⏱️  Timeout: ${this.timeouts.command/1000}s`));
        
        try {
          const result = await this.executeWithTimeout(
            () => Promise.resolve(runCommand(command, this.cwd)),
            this.timeouts.command,
            `run_command: ${command}`
          );

          if (result.error) {
            console.log(chalk.red(`  ❌ ${result.error}`));
            return `Error running command: ${result.error}`;
          }

          console.log(chalk.green(`  ✓ Command executed`));
          return result.result;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.log(chalk.red(`  ❌ Command timed out or failed: ${errorMsg}`));
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
        console.log(chalk.gray(`  ⏱️  Timeout: ${this.timeouts.webSearch/1000}s`));
        
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
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.log(chalk.red(`  ❌ Search timed out or failed: ${errorMsg}`));
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
        console.log(chalk.gray(`  ⏱️  Timeout: ${this.timeouts.webFetch/1000}s`));
        
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
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.log(chalk.red(`  ❌ Web fetch timed out or failed: ${errorMsg}`));
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

      default:
        console.log(chalk.red(`  ❌ Unknown tool: ${tool}`));
        return `Error: Unknown tool ${tool}`;
    }
  }

  /**
   * Review and apply proposed edits
   */
  private async reviewEdits(): Promise<void> {
    console.log(chalk.bold.blue("\n\n📝 Proposed Changes:\n"));

    for (let i = 0; i < this.proposedEdits.length; i++) {
      const edit = this.proposedEdits[i];

      console.log(chalk.bold.yellow(`\n${i + 1}. ${edit.path}`));
      console.log(chalk.gray(`   ${edit.description}\n`));

      // Show diff
      const diff = generateDiff(edit.oldContent, edit.newContent);

      if (diff.length > 40) {
        console.log(chalk.gray("┌─ Changes (first 40 lines):"));
        diff.slice(0, 40).forEach((line) => console.log(line));
        console.log(chalk.gray(`└─ ... and ${diff.length - 40} more lines\n`));
      } else if (diff.length > 0) {
        console.log(chalk.gray("┌─ Changes:"));
        diff.forEach((line) => console.log(line));
        console.log(chalk.gray("└─\n"));
      } else {
        console.log(chalk.green("   No changes (new file)\n"));
        const lines = edit.newContent.split("\n");
        const preview = lines.slice(0, 10);
        console.log(chalk.gray("┌─ Preview:"));
        preview.forEach((line) => console.log(chalk.gray(`│ ${line}`)));
        if (lines.length > 10) {
          console.log(chalk.gray(`│ ... (${lines.length - 10} more lines)`));
        }
        console.log(chalk.gray("└─\n"));
      }

      // Ask for approval
      const { action } = await inquirer.prompt([
        {
          type: "list",
          name: "action",
          message: `Apply changes to ${edit.path}?`,
          choices: [
            { name: "Apply", value: "apply" },
            { name: "Skip", value: "skip" },
            { name: "Apply All Remaining", value: "apply_all" },
            { name: "Skip All Remaining", value: "skip_all" },
          ],
          default: "apply",
        },
      ]);

      if (action === "apply") {
        const result = applyEdit(edit, this.cwd);
        const success = !result.error;

        this.appliedEdits.push({
          path: edit.path,
          description: edit.description,
          success,
        });

        if (result.error) {
          console.log(chalk.red(`\n❌ ${result.error}\n`));
        } else {
          console.log(chalk.green(`\n✅ ${result.result}\n`));

          // Update TODO list if applicable
          this.updateTodoStatus(edit.path, "completed");
        }
      } else if (action === "skip") {
        console.log(chalk.gray("\nSkipped\n"));
        this.appliedEdits.push({
          path: edit.path,
          description: edit.description + " (skipped)",
          success: false,
        });
      } else if (action === "apply_all") {
        // Apply this and all remaining
        for (let j = i; j < this.proposedEdits.length; j++) {
          const e = this.proposedEdits[j];
          const result = applyEdit(e, this.cwd);
          const success = !result.error;

          this.appliedEdits.push({
            path: e.path,
            description: e.description,
            success,
          });

          if (result.error) {
            console.log(chalk.red(`❌ ${e.path}: ${result.error}`));
          } else {
            console.log(chalk.green(`✅ ${e.path}`));
            this.updateTodoStatus(e.path, "completed");
          }
        }
        break;
      } else if (action === "skip_all") {
        console.log(chalk.gray("\nSkipped all remaining changes\n"));

        // Mark all remaining as skipped
        for (let j = i; j < this.proposedEdits.length; j++) {
          this.appliedEdits.push({
            path: this.proposedEdits[j].path,
            description: this.proposedEdits[j].description + " (skipped)",
            success: false,
          });
        }
        break;
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

  /**
   * Try alternative approach when a tool fails
   */
  private async tryAlternativeApproach(
    toolCall: any,
    error: string
  ): Promise<string | null> {
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
        () => this.provider.chat([
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
  private getSystemPrompt(): string {
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

## Critical Rules

1. **Tool Format**: Use XML-style tags exactly as shown above
2. **propose_edit Content**: Place the ENTIRE file content BETWEEN opening and closing tags, not in attributes
3. **No Self-Closing**: Never use <tool ... /> for propose_edit - always use <tool>...</tool>
4. **Complete Files**: Always provide the full file content in propose_edit, not just changes
5. **Explain First**: Always explain what you're doing before using tools

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

  /**
   * Parse and display TODO list from AI response
   */
  private parseTodoList(response: string): void {
    // Look for TODO list in response (markdown format)
    const todoRegex = /(?:TODO|Tasks?|Steps?):\s*\n((?:[-*]\s+.+\n?)+)/gi;
    const match = todoRegex.exec(response);

    if (match) {
      const todoText = match[1];
      const lines = todoText.split("\n").filter((l) => l.trim());

      this.todoList = lines.map((line) => {
        const task = line.replace(/^[-*]\s+/, "").trim();
        return { task, status: "pending" as const };
      });

      if (this.todoList.length > 0) {
        this.displayTodoList();
      }
    }
  }

  /**
   * Display the TODO list
   */
  private displayTodoList(): void {
    console.log(chalk.bold.blue("\n📋 Task List:\n"));

    this.todoList.forEach((item, index) => {
      const icon =
        item.status === "completed"
          ? chalk.green("✅")
          : item.status === "in_progress"
          ? chalk.yellow("⏳")
          : chalk.gray("⬜");

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
    taskPattern: string,
    status: "in_progress" | "completed"
  ): void {
    const item = this.todoList.find((t) =>
      t.task.toLowerCase().includes(taskPattern.toLowerCase())
    );

    if (item) {
      item.status = status;
      this.displayTodoList();
    }
  }

  /**
   * Display summary of all applied edits
   */
  private displayEditSummary(): void {
    if (this.appliedEdits.length === 0) return;

    console.log(chalk.bold.blue("\n📊 Summary of Changes:\n"));

    const successful = this.appliedEdits.filter((e) => e.success);
    const failed = this.appliedEdits.filter((e) => !e.success);

    if (successful.length > 0) {
      console.log(
        chalk.green(`✅ Successfully updated ${successful.length} file(s):\n`)
      );
      successful.forEach((edit) => {
        console.log(
          chalk.green(`  • ${edit.path}`) + chalk.gray(` - ${edit.description}`)
        );
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
  }
}
