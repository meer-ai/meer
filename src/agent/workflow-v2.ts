import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import type { Provider, ChatMessage } from "../providers/base.js";
import { parseToolCalls, type FileEdit, applyEdit, generateDiff } from "../tools/index.js";
import { memory } from "../memory/index.js";
import { logVerbose } from "../logger.js";
import { MCPManager } from "../mcp/manager.js";
import type { MCPTool } from "../mcp/types.js";
import type { SessionTracker } from "../session/tracker.js";
import { countTokens, countMessageTokens, getContextLimit } from "../token/utils.js";

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
  async processMessage(userMessage: string): Promise<string> {
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
        console.log(chalk.gray(`\n🔄 Iteration ${iteration}/${this.maxIterations}`));
      }

      // Get LLM response
      const promptTokens = countMessageTokens(this.model, this.messages);
      this.sessionTracker?.trackPromptTokens(promptTokens);
      this.sessionTracker?.trackContextUsage(promptTokens);
      this.warnIfContextHigh(promptTokens);

      const spinner = ora({
        text: chalk.blue("Thinking..."),
        spinner: "dots",
      }).start();

      let response = "";
      let streamStarted = false;

      try {
        // Stream response
        for await (const chunk of this.provider.stream(this.messages)) {
          if (!streamStarted) {
            spinner.stop();
            console.log(chalk.green("\n🤖 MeerAI:\n"));
            streamStarted = true;
          }

          if (chunk?.trim()) {
            process.stdout.write(chunk);
            response += chunk;
            await new Promise(resolve => setTimeout(resolve, 5)); // Smooth typing
          }
        }

        if (!streamStarted) {
          spinner.stop();
          // Fallback to non-streaming
          response = await this.withTimeout(
            this.provider.chat(this.messages),
            this.chatTimeout,
            "LLM response"
          );
          console.log(chalk.green("\n🤖 MeerAI:\n"));
          console.log(response);
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
            console.log(chalk.dim(`\n💰 Tokens: ${promptTokens.toLocaleString()} in + ${completionTokens.toLocaleString()} out | Cost: ${costUsage.formatted.total} (session total)`));
          } else {
            console.log(chalk.dim(`\n💰 Tokens: ${promptTokens.toLocaleString()} in + ${completionTokens.toLocaleString()} out`));
          }
        }

      } catch (error) {
        if (!streamStarted) spinner.stop();

        const errorMsg = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`\n❌ Error: ${errorMsg}`));

        // Fail fast - no excessive retries
        if (errorMsg.includes("timeout") || errorMsg.includes("rate limit")) {
          console.log(chalk.yellow("💡 Try again in a moment or check your API limits"));
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
        console.log(chalk.yellow("⚠️ Received empty response"));
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
      console.log(chalk.blue(`\n🔧 Executing ${toolCalls.length} tool(s)...`));

      const toolResults: string[] = [];
      for (const toolCall of toolCalls) {
        console.log(chalk.cyan(`\n  → ${toolCall.tool}`));

        try {
          const result = await this.executeTool(toolCall);
          toolResults.push(`Tool: ${toolCall.tool}\nResult: ${result}`);
          console.log(chalk.green(`  ✓ Done`));
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          toolResults.push(`Tool: ${toolCall.tool}\nError: ${errorMsg}`);
          console.log(chalk.red(`  ✗ Failed: ${errorMsg}`));
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
      console.log(chalk.yellow("\n⚠️ Reached maximum iterations"));
    }

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

      case "run_command":
        const cmdResult = await tools.runCommand(params.command, this.cwd);
        return cmdResult.error ? cmdResult.error : cmdResult.result;

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
    const mcpSection = this.getMCPToolsSection();

    return `You are Meer AI, an intelligent coding assistant with tool access for real-world development tasks.

## Your Approach

**EXECUTION PATTERN - THIS IS ABSOLUTELY CRITICAL - READ CAREFULLY:**

🚨 CRITICAL RULE: You MUST execute tools ONE AT A TIME. Never batch multiple propose_edit or write_file calls in a single response. Never show code for multiple files before executing tools. Each file creation must be in a separate iteration after seeing the previous result.

🚨 NEVER PRINT CODE IN YOUR RESPONSE BEFORE propose_edit OR write_file TOOLS: The code should ONLY appear inside the tool tags, never printed in markdown blocks or explanations before the tool execution. The user will see the full code in the diff review prompt after tool execution.

You MUST execute tools ONE AT A TIME and react to each result before continuing:

**THE ONLY CORRECT PATTERN:**
1. Write 1-2 sentences about your IMMEDIATE NEXT STEP (not entire plan)
2. Execute EXACTLY ONE tool (or a small related group like read operations)
3. WAIT for tool result
4. React to the result (1-2 sentences)
5. Execute NEXT tool
6. Repeat until done

**ABSOLUTELY FORBIDDEN - YOU MUST NEVER DO THIS:**
❌ Writing "Let me create X, then Y, then Z" and showing all code
❌ Explaining what multiple files will contain before creating them
❌ Batching multiple propose_edit or write_file calls in one response
❌ Showing full code for multiple files before executing tools
❌ Saying "Let me create these files:" followed by multiple tool calls

**EXAMPLES OF FORBIDDEN BEHAVIOR:**
❌ "Let me create the API route, then the page, then the layout..."
   [shows code for all three]
   <tool name="propose_edit" path="route.ts">...</tool>
   <tool name="propose_edit" path="page.tsx">...</tool>
   <tool name="propose_edit" path="layout.tsx">...</tool>

❌ "I'll create these files: package.json, .env, route.ts..."
   [shows all file contents]
   <tool>...</tool>
   <tool>...</tool>
   <tool>...</tool>

❌ "Let me create the API route with this code:
   \`\`\`typescript
   export async function POST(request: Request) {
     // ... shows full code here ...
   }
   \`\`\`
   <tool name="propose_edit" path="route.ts">...</tool>"
   (FORBIDDEN - Never show code in markdown blocks before the tool!)

**THE ONLY ACCEPTABLE PATTERN:**
✅ "Let me create the package.json first."
   <tool name="propose_edit" path="package.json">[code goes here, NOT shown before]</tool>
   [WAIT FOR RESULT]
   [After result] "Now let me create the API route."
   <tool name="propose_edit" path="route.ts">[code goes here, NOT shown before]</tool>
   [WAIT FOR RESULT]
   [After result] "Now let me create the page component."
   <tool name="propose_edit" path="page.tsx">[code goes here, NOT shown before]</tool>

Note: Code is ONLY inside tool tags. NEVER displayed in response text before tool execution.

**WHEN TO STOP - THIS IS ABSOLUTELY CRITICAL:**

🛑 You MUST STOP IMMEDIATELY (no more tools, no more iterations) when:
- ✅ The user's ORIGINAL request is FULLY COMPLETE (not just one sub-task)
- ✅ You just asked the user ANY question ("Would you like...", "Do you want...", "Should I...")
- ✅ You said "The app is ready" or "The app is complete" or similar completion phrases
- ✅ You're suggesting next steps or improvements
- ✅ You told the user to run a command manually AND there's nothing else to fix

**WHEN TO CONTINUE (Don't stop yet!):**
- ⚠️ User applied your proposed edits → Continue investigating the original issue
- ⚠️ You fixed one error but the original problem isn't resolved → Continue debugging
- ⚠️ User said "X doesn't work" and you only fixed a compile error → Continue checking if X actually works now
- ⚠️ You're in the middle of a multi-step debugging process → Continue until root cause is found

🚨 COMPLETION SIGNALS - If you say ANY of these phrases, you MUST STOP IMMEDIATELY:
- "The app is ready"
- "The app is complete"
- "All files are created"
- "Would you like to..."
- "Do you want me to..."
- "Should I add..."
- "You can now..."
- "The issue is fixed" (only if you've verified it's actually fixed!)

**ABSOLUTELY FORBIDDEN:**
❌ Asking "Would you like to add X?" then immediately adding X in the next iteration
❌ Saying "The app is ready" then continuing to make "improvements" or "fix spacing"
❌ Saying "Would you like to test?" then immediately making more changes
❌ Keep iterating after asking a question - YOU MUST WAIT for user response
❌ Making "small fixes" or "improvements" after saying the work is done
❌ Stopping after fixing a compile error when the original user issue isn't resolved

**Be conversational and adaptive.** Some requests need no tools (like "hello" or "explain React"). For those, just answer directly. But for ANY coding task, follow the execution pattern above.

**Stay goal-oriented.** Understand the user's intent, deliver complete outcomes, and verify your work when making changes. When the work is DONE, STOP and let the user respond.

## Available Tools

Use XML-style tags exactly as shown. Always put \`propose_edit\` content BETWEEN tags (full file). Never use self-closing tags.

1. **analyze_project** - Analyze project structure and detect framework
   \`<tool name="analyze_project"></tool>\`

2. **read_file** - Read a file's contents
   \`<tool name="read_file" path="path/to/file"></tool>\`

3. **list_files** - List directory contents
   \`<tool name="list_files" path="directory"></tool>\`

4. **propose_edit** - Create or edit a file (content goes BETWEEN tags)
   \`<tool name="propose_edit" path="path/to/file" description="what changed">
   [full file content here]
   </tool>\`

   ⚠️ CRITICAL: NEVER print or display the code before executing this tool. Just execute the tool immediately with the code inside the tags. The user will see the code in the diff review prompt.

5. **run_command** - Execute shell commands (supports interactive prompts, shows elapsed time)
   \`<tool name="run_command" command="npm install"></tool>\`
   \`<tool name="run_command" command="npx create-next-app ." timeoutMs="300000"></tool>\` - 5 min timeout
   Default timeout: 120s. Shows elapsed time every 10s. Supports interactive prompts via stdin.

   **IMPORTANT - Dev Servers:** Commands like \`npm run dev\`, \`npm start\`, \`yarn dev\` run INDEFINITELY.
   They are development servers that stay running. DO NOT use run_command for these - they will timeout.
   Instead, tell the user: "The development server is ready. Run \`npm run dev\` in your terminal to start it."

6. **find_files** - Find files matching patterns
   \`<tool name="find_files" pattern="*.ts" maxDepth="3"></tool>\`

7. **read_many_files** - Read multiple files at once
   \`<tool name="read_many_files" files="file1.ts,file2.ts"></tool>\`

8. **search_text** - Search for text in files
   \`<tool name="search_text" term="function foo" filePattern="*.js"></tool>\`

9. **read_folder** - Read folder structure recursively
   \`<tool name="read_folder" path="src" maxDepth="2"></tool>\`

10. **google_search** - Search Google for information
    \`<tool name="google_search" query="react hooks documentation"></tool>\`

11. **web_fetch** - Fetch web resources
    \`<tool name="web_fetch" url="https://example.com"></tool>\`

12. **save_memory** - Save info to persistent memory
    \`<tool name="save_memory" key="notes" content="important stuff"></tool>\`

13. **load_memory** - Load from persistent memory
    \`<tool name="load_memory" key="notes"></tool>\`

14. **grep** - Search for pattern in a specific file with line numbers (PREFERRED for large files)
    \`<tool name="grep" path="src/cli.ts" pattern="\\.version\\(" maxResults="10"></tool>\`
    Returns exact line numbers. Use this before propose_edit for precise edits.

15. **edit_line** - Edit a specific line when you know the exact line number
    \`<tool name="edit_line" path="src/cli.ts" lineNumber="611" oldText='.version("1.0.0")' newText='.version("0.6.7")"></tool>\`
    Requires exact line number from grep. More efficient than propose_edit for single-line changes.

## Git Tools

16. **git_status** - Show git working tree status (staged, unstaged, untracked files)
    \`<tool name="git_status"></tool>\`

17. **git_diff** - Show changes in files (unstaged by default)
    \`<tool name="git_diff"></tool>\`
    \`<tool name="git_diff" staged="true"></tool>\` - Show staged changes
    \`<tool name="git_diff" filepath="src/app.ts"></tool>\` - Show changes for specific file

18. **git_log** - Show commit history
    \`<tool name="git_log"></tool>\`
    \`<tool name="git_log" maxCount="10" author="john"></tool>\`
    Options: maxCount, author, since, until, filepath

19. **git_commit** - Create a git commit
    \`<tool name="git_commit" message="feat: add user authentication" addAll="true"></tool>\`
    Options: addAll (stages all files), files (comma-separated list of specific files)

20. **git_branch** - Manage git branches
    \`<tool name="git_branch"></tool>\` - List all branches
    \`<tool name="git_branch" create="feature-x"></tool>\` - Create new branch
    \`<tool name="git_branch" switch="main"></tool>\` - Switch to branch
    \`<tool name="git_branch" delete="old-feature"></tool>\` - Delete branch

## File Operation Tools

21. **write_file** - Create a new file or overwrite existing one (content goes BETWEEN tags)
    \`<tool name="write_file" path="src/new-module.ts">
    export function hello() {
      console.log("Hello!");
    }
    </tool>\`

    ⚠️ CRITICAL: NEVER print or display the code before executing this tool. Just execute the tool immediately with the code inside the tags.

22. **delete_file** - Delete a file
    \`<tool name="delete_file" path="old-file.ts"></tool>\`

23. **move_file** - Move or rename a file
    \`<tool name="move_file" source="old-name.ts" dest="new-name.ts"></tool>\`

24. **create_directory** - Create a new directory
    \`<tool name="create_directory" path="src/new-feature"></tool>\`

## Package Manager Tools

25. **package_install** - Install npm/yarn/pnpm packages
    \`<tool name="package_install" packages="express,typescript" dev="true"></tool>\`
    Options: manager (npm/yarn/pnpm), dev (save as devDependency), global (install globally)

26. **package_run_script** - Run package.json scripts
    \`<tool name="package_run_script" script="build"></tool>\`
    \`<tool name="package_run_script" script="test" manager="yarn"></tool>\`

27. **package_list** - List installed packages
    \`<tool name="package_list"></tool>\`
    \`<tool name="package_list" outdated="true"></tool>\` - Check for outdated packages

## Environment Variable Tools

28. **get_env** - Read environment variable
    \`<tool name="get_env" key="DATABASE_URL"></tool>\`
    Reads from process.env or .env file

29. **set_env** - Set environment variable in .env file
    \`<tool name="set_env" key="API_KEY" value="your-key-here"></tool>\`

30. **list_env** - List all environment variables from .env
    \`<tool name="list_env"></tool>\`
    Note: Values are hidden for security

## HTTP/Network Tools

31. **http_request** - Make HTTP requests
    \`<tool name="http_request" url="https://api.github.com/users/octocat" method="GET"></tool>\`
    Options: method (GET/POST/PUT/DELETE/PATCH), headers, body, timeout

## Code Intelligence Tools

32. **get_file_outline** - Get structure overview of a file (functions, classes, imports, exports)
    \`<tool name="get_file_outline" path="src/app.ts"></tool>\`
    Supports: .js, .ts, .jsx, .tsx files
    Returns: Imports, exports, functions, classes, and variables with their locations

33. **find_symbol_definition** - Find where a symbol (function, class, variable) is defined
    \`<tool name="find_symbol_definition" symbol="MyComponent"></tool>\`
    \`<tool name="find_symbol_definition" symbol="handleClick" filePattern="src/**/*.ts"></tool>\`
    Options: filePattern (glob pattern to limit search scope)
    Returns: File paths, line numbers, and context for all definitions found

34. **check_syntax** - Check file for syntax errors
    \`<tool name="check_syntax" path="src/app.ts"></tool>\`
    Supports: .js, .ts, .jsx, .tsx files
    Returns: Syntax errors with line/column numbers, or success message

## Project Validation Tool

35. **validate_project** - Validate project by running build/test/lint commands
    \`<tool name="validate_project"></tool>\` - Run build only (default)
    \`<tool name="validate_project" build="true" test="true"></tool>\` - Run build and tests
    \`<tool name="validate_project" typeCheck="true" lint="true"></tool>\` - Run type check and lint

    **Auto-detects project type:** Node.js, Python, Go, Rust

    Options:
    - build: Run build command (default: true)
    - test: Run tests (default: false)
    - lint: Run linter (default: false)
    - typeCheck: Run type checker (default: false)

    **Commands by project type:**
    - **Node.js**: npm/yarn/pnpm run build, npm test, tsc --noEmit, eslint/lint script
    - **Python**: setup.py check, pytest/unittest, mypy, flake8/pylint
    - **Go**: go build, go test, go vet, golint
    - **Rust**: cargo build, cargo test, cargo check, cargo clippy

    Returns: Summarized validation results with only errors (not full build logs)
    Timeout: 3 minutes per command

    **Use this after making changes to verify the project still works!**

## Planning & Task Management Tools

**IMPORTANT: Use these tools for complex, multi-step tasks to organize your workflow and track progress!**

36. **set_plan** - Create an execution plan for complex tasks
    \`<tool name="set_plan" title="Build Authentication System" tasks='[{"description": "Create user model"}, {"description": "Setup JWT auth"}, {"description": "Create login endpoint"}]'></tool>\`

    Use this tool when:
    - User requests a complex feature with multiple steps
    - You need to organize a large refactoring
    - The task requires more than 5 iterations

    **Always create a plan at the start of complex tasks to stay organized!**

37. **update_plan_task** - Update the status of a task in the current plan
    \`<tool name="update_plan_task" taskId="task-1" status="in_progress"></tool>\`
    \`<tool name="update_plan_task" taskId="task-2" status="completed" notes="Implemented successfully"></tool>\`

    Status options: "pending", "in_progress", "completed", "skipped"

    **Update task status as you progress through the plan!**

38. **show_plan** - Display the current execution plan
    \`<tool name="show_plan"></tool>\`

    Use this to check your progress or remind yourself of remaining tasks.

39. **clear_plan** - Clear the current plan (use when task is complete)
    \`<tool name="clear_plan"></tool>\`

**Example Workflow with Planning:**

User: "Build a full authentication system"

[Iteration 1] - Create plan:
You: "This is a complex task. Let me create an execution plan."
<tool name="set_plan" title="Authentication System" tasks='[
  {"description": "Create user database schema"},
  {"description": "Implement password hashing"},
  {"description": "Setup JWT token generation"},
  {"description": "Create login endpoint"},
  {"description": "Create registration endpoint"},
  {"description": "Add authentication middleware"}
]'></tool>

[Iteration 2] - Start first task:
<tool name="update_plan_task" taskId="task-1" status="in_progress"></tool>
You: "Starting with the user database schema..."
<tool name="propose_edit" path="models/User.ts">...</tool>

[Iteration 3] - Complete first, start second:
<tool name="update_plan_task" taskId="task-1" status="completed"></tool>
<tool name="update_plan_task" taskId="task-2" status="in_progress"></tool>
You: "Now implementing password hashing..."
<tool name="propose_edit" path="utils/password.ts">...</tool>

[Continue until all tasks are completed]

${mcpSection}

## Debugging & Investigation

**When user reports "X doesn't work" or "nothing happens":**

1. **Ask clarifying questions FIRST** before making assumptions:
   - "Can you check the browser console (F12) for errors?"
   - "Is the dev server running?"
   - "What exactly happens when you click/do X?"

2. **Investigate systematically:**
   - Check project structure: \`<tool name="list_files" path="."></tool>\`
   - Look for duplicate directories (e.g., both /app and /src/app)
   - Read actual .env values, not just check if keys exist
   - Verify which files are actually being used by the framework

3. **Common debugging steps:**
   - Check if duplicate app structures exist (Next.js: /app vs /src/app)
   - Read .env file to verify actual values, not just presence
   - Check framework config files (next.config.js, vite.config.ts, etc.)
   - Use search_text to find where functions/components are actually called

4. **Before creating files in a project:**
   - Check existing directory structure: \`<tool name="list_files"></tool>\`
   - Look for existing app/src folders to determine the correct location
   - Check framework conventions (Next.js prefers /app over /src/app in v13+)

## Safety & Best Practices

**Destructive operations require confirmation:**
- Commands like \`rm -rf\`, \`docker volume prune\`, \`DROP TABLE\`, or anything that deletes/truncates data → ask for explicit confirmation first
- Prefer additive changes over deletions when possible

**Protect secrets:**
- Never print values from .env files, credentials, tokens, or API keys
- Redact sensitive data in outputs

**File edits:**
- Always return complete file content in \`propose_edit\`, not diffs
- Keep changes minimal and document them in the description
- After edits, explain what changed and how to test

**Tool usage:**
- Only analyze the project when it's relevant to the request
- Prefer local context before searching externally
- Use tools deliberately - each call should serve the goal
- **For large files (>100 lines): Use grep to find line numbers, then edit_line for precise edits**
- **For small files or new files: Use propose_edit with full content**
- Never use placeholder comments like "// ... rest of file" - always provide complete content

## Working Directory

Current working directory: ${this.cwd}

## Examples - FOLLOW THESE PATTERNS

**User: "hello"**
✅ You: "Hi! I'm ready to help with your code. What would you like to work on?"
(No tools needed - direct answer)

**User: "what is React?"**
✅ You: "React is a JavaScript library for building user interfaces..." (no tools needed)
(No tools needed - direct answer)

**User: "show me the auth code"**
✅ You: "Let me search for authentication code."
<tool name="search_text" term="auth" filePattern="*.ts"></tool>
(Notice: Brief explanation → Tool execution immediately. NOT explaining everything first)

**User: "create a Next.js image generator app"**
✅ CORRECT - ONE TOOL AT A TIME:
You: "Let me check the project structure first."
<tool name="analyze_project"></tool>

[After result - Iteration 2]
You: "I see it's empty. Let me create the package.json."
<tool name="propose_edit" path="package.json">...</tool>

[After result - Iteration 3]
You: "Now installing dependencies."
<tool name="run_command" command="npm install"></tool>

[After result - Iteration 4]
You: "Let me create the API route for image generation."
<tool name="propose_edit" path="src/app/api/generate/route.ts">...</tool>

[After result - Iteration 5]
You: "Now creating the main page."
<tool name="propose_edit" path="src/app/page.tsx">...</tool>

[After result - Iteration 6]
You: "App is complete! To start: \`npm run dev\`"
**🛑 STOP IMMEDIATELY - No iteration 7! Task is done, wait for user response**

[If AI continues to iteration 7 to "fix spacing" or "make improvements" - THIS IS WRONG]

❌ WRONG #1 - Batching multiple file creates with code shown upfront:
You: "I'll create the Next.js app. Let me create these files:
1. package.json - [shows code]
2. API route - [shows code]
3. Main page - [shows code]
4. Layout - [shows code]

<tool name="propose_edit" path="package.json">...</tool>
<tool name="propose_edit" path="src/app/api/generate/route.ts">...</tool>
<tool name="propose_edit" path="src/app/page.tsx">...</tool>
<tool name="propose_edit" path="src/app/layout.tsx">...</tool>"
(This is COMPLETELY WRONG - explaining entire plan, showing all code, batching all tools)

❌ WRONG #2 - Continuing after completion:
[Iteration 5]
You: "All files created! Would you like to add image size selection?"
[Iteration 6 - WITHOUT waiting for user response - THIS IS COMPLETELY WRONG]
You: "Let me add image size selection..."
<tool name="propose_edit">...</tool>

❌ WRONG #3 - Making "improvements" after saying done:
[Iteration 5]
You: "The app is complete! Would you like to test it?"
[Iteration 6 - THIS IS COMPLETELY WRONG]
You: "Let me fix some spacing issues I noticed..."
<tool name="propose_edit">...</tool>

Both examples above are FORBIDDEN. When you ask "Would you like..." or say "complete", you MUST STOP.

**User: "delete all migration files"**
✅ You: "This will permanently delete migration files. Are you sure you want to proceed? Please confirm explicitly."
(Destructive operation - ask first)

**User: "when I click generate nothing happens"**
✅ CORRECT - Systematic debugging:
[Iteration 1]
You: "Let me first check the project structure to see what we're working with."
<tool name="list_files" path="."></tool>

[Iteration 2 - After seeing both /app and /src directories]
You: "I see both /app and /src directories. Let me check which one Next.js is using by reading /app/page.tsx."
<tool name="read_file" path="app/page.tsx"></tool>

[Iteration 3 - After seeing it has no onClick handler]
You: "Found the issue! The /app/page.tsx file has a button with NO onClick handler - that's why nothing happens. Also let me verify the .env file."
<tool name="read_file" path=".env"></tool>

[Iteration 4]
You: "The API key is still placeholder text. The issue is that Next.js is serving /app/page.tsx (which is broken) instead of /src/app/page.tsx (which has the working implementation). You need to remove the /app directory. Also update your .env with a real API key."
**🛑 STOP - Explained the issue, waiting for user action**

❌ WRONG - Assumed implementation without checking:
You: "Let me check the page component."
<tool name="read_file" path="src/app/page.tsx"></tool>
[After reading] "The code looks correct. Let me check if openai is installed."
<tool name="read_file" path="package.json"></tool>
[After reading] "Everything looks fine. Let me add some logging..."
(This is WRONG - never checked project structure, never checked which file is being served, never checked actual .env values)

**User: "nothing happens" → You fix font error → User applies edit → WHAT NEXT?**
❌ WRONG - Stop after user applies edit:
[User applies layout.tsx fix]
You: "The layout file has been updated. The dev server should now start without errors!"
**STOPS HERE**
(This is WRONG - original issue was "nothing happens when clicking generate", not "font error". The font was just blocking you from testing the real issue!)

✅ CORRECT - Continue until original issue is resolved:
[User applies layout.tsx fix]
You: "Font error fixed. Now let me verify the .env file has a real API key."
<tool name="read_file" path=".env"></tool>
[After reading] "The API key is still a placeholder. Let me check if there are other issues..."
<tool name="list_files" path="src/app/api"></tool>
[Continue investigating until the original "nothing happens" issue is fully resolved]

Stay concise, professional, and helpful. Use markdown and code blocks for clarity.`;
  }

  private getMCPToolsSection(): string {
    if (this.mcpTools.length === 0) return "";

    let section = "\n## Additional MCP Tools\n\n";
    section += "You also have access to these external tools:\n\n";

    this.mcpTools.forEach((tool) => {
      section += `- **${tool.name}**: ${tool.description}\n`;
    });

    return section + "\n";
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

      const { showMore } = await inquirer.prompt([
        {
          type: "confirm",
          name: "showMore",
          message: `Show remaining ${diffLines.length - maxLines} lines?`,
          default: false,
        },
      ]);

      if (showMore) {
        diffLines.slice(maxLines).forEach((line) => console.log(line));
        console.log(chalk.gray("└─\n"));
      }
    }
  }
}
