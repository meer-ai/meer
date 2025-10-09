import chalk from "chalk";
import ora from "ora";
import type { Provider, ChatMessage } from "../providers/base.js";
import { parseToolCalls } from "../tools/index.js";
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
        return `File edit proposed: ${edit.path}\n${edit.description}`;

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

    return `You are an intelligent coding assistant. You have access to tools that you can use when needed.

## Your Approach

**You are in control.** Decide for yourself:
- Does this request need tools? Or can you just answer?
- If it needs tools, which ones and when?
- Should you read files? Run commands? Search the web?

**No rigid workflows.** Some requests need no tools at all (like "hello" or "explain what React is"). Others need extensive file operations. You decide based on the request.

**Be conversational.** Explain what you're doing and why. If the request is unclear, ask for clarification instead of guessing.

## Available Tools

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

5. **run_command** - Execute shell commands
   \`<tool name="run_command" command="npm install"></tool>\`

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

${mcpSection}

## Rules

- Use XML-style tool tags as shown above
- For propose_edit, put content BETWEEN tags, not in attributes
- Always use \`<tool>...</tool>\`, never self-closing \`<tool />\`
- Explain your reasoning before using tools
- Ask for clarification if the request is vague
- You DON'T need to analyze the project for every request - only when it's relevant
- For simple greetings or questions, just respond directly

## Working Directory

Current working directory: ${this.cwd}

## Examples

**User: "hello"**
You: "Hi! I'm ready to help with your code. What would you like to work on?"

**User: "what is React?"**
You: "React is a JavaScript library for building user interfaces..." (no tools needed)

**User: "show me the auth code"**
You: "I'll find and read the authentication code for you."
<tool name="search_text" term="auth" filePattern="*.ts"></tool>
(Then read the relevant files)

**User: "add a new user endpoint"**
You: "I'll add a new user endpoint. Let me first check the existing API structure."
<tool name="find_files" pattern="*route*"></tool>
(Then analyze and implement)

You decide the approach based on what makes sense.`;
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
}
