/**
 * WorkflowV3 - Production-ready workflow engine
 * Optimized for performance with proper state management
 */

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
import { OCEAN_SPINNER } from "../ui/workflowTimeline.js";
import { buildAgentSystemPrompt } from "./prompts/systemPrompt.js";
import { ContextPreprocessor } from "./context-preprocessor.js";
import { TransactionManager } from "./transaction-manager.js";
import { TestDetector } from "./test-detector.js";
import type { AgentEventBus } from "./eventBus.js";

// ============================================================================
// Types
// ============================================================================

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
  limits?: {
    maxTokensPerSession?: number;
    maxCostPerSession?: number;
  };
  eventBus?: AgentEventBus;
  onStreamingStart?: () => void;
  onStreamingChunk?: (chunk: string) => void;
  onStreamingEnd?: () => void;
  onToolStart?: (tool: string, args: any) => void;
  onToolUpdate?: (tool: string, status: string, result?: string) => void;
  onToolEnd?: () => void;
  onStatusChange?: (status: string) => void;
  onError?: (error: Error) => void;
  promptChoice?: (
    message: string,
    choices: Array<{ label: string; value: string }>,
    defaultChoice?: string
  ) => Promise<string>;
}

export interface WorkflowEvent {
  type: 'thinking' | 'streaming' | 'tool_start' | 'tool_update' | 'tool_end' | 'error' | 'complete';
  timestamp: number;
  data?: any;
}

export interface WorkflowMetrics {
  iterations: number;
  toolsExecuted: number;
  totalTokens: number;
  totalCost: number;
  startTime: number;
  endTime?: number;
}

// ============================================================================
// Workflow Engine
// ============================================================================

export class AgentWorkflowV3 {
  private provider: Provider;
  private cwd: string;
  private maxIterations: number;
  private enableMemory: boolean;
  private providerType: string;
  private model: string;
  private mcpManager = MCPManager.getInstance();
  private mcpTools: MCPTool[] = [];
  private sessionTracker?: SessionTracker;
  private contextLimit?: number;
  private chatTimeout: number;
  private config: AgentConfig;
  
  private messages: ChatMessage[] = [];
  private contextPreprocessor: ContextPreprocessor;
  private transactionManager: TransactionManager;
  private testDetector: TestDetector;
  private editedFiles: Set<string> = new Set();
  
  private metrics: WorkflowMetrics;
  private currentIteration = 0;
  private isRunning = false;
  private abortController: AbortController | null = null;

  // Callbacks
  private callbacks: {
    onStreamingStart?: () => void;
    onStreamingChunk?: (chunk: string) => void;
    onStreamingEnd?: () => void;
    onToolStart?: (tool: string, args: any) => void;
    onToolUpdate?: (tool: string, status: string, result?: string) => void;
    onToolEnd?: () => void;
    onStatusChange?: (status: string) => void;
    onError?: (error: Error) => void;
  };

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
    this.config = config;
    
    this.contextPreprocessor = new ContextPreprocessor(this.cwd);
    this.transactionManager = new TransactionManager(this.cwd);
    this.testDetector = new TestDetector(this.cwd);
    
    this.metrics = {
      iterations: 0,
      toolsExecuted: 0,
      totalTokens: 0,
      totalCost: 0,
      startTime: Date.now(),
    };

    this.callbacks = {
      onStreamingStart: config.onStreamingStart,
      onStreamingChunk: config.onStreamingChunk,
      onStreamingEnd: config.onStreamingEnd,
      onToolStart: config.onToolStart,
      onToolUpdate: config.onToolUpdate,
      onToolEnd: config.onToolEnd,
      onStatusChange: config.onStatusChange,
      onError: config.onError,
    };

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

  // ============================================================================
  // Public API
  // ============================================================================

  async initialize(contextPrompt?: string): Promise<void> {
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

    // Initialize system prompt
    const systemPrompt = this.getSystemPrompt();
    const fullPrompt = contextPrompt
      ? `${systemPrompt}\n\n${contextPrompt}`
      : systemPrompt;

    this.messages = [{ role: "system", content: fullPrompt }];
  }

  /**
   * Process a user message with the agentic workflow
   * Returns the full assistant response
   */
  async processMessage(userMessage: string): Promise<string> {
    if (this.isRunning) {
      throw new Error("Workflow is already running");
    }

    this.isRunning = true;
    this.abortController = new AbortController();
    
    try {
      this.updateStatus("Processing request...");
      
      // Auto-gather relevant context (optional feature)
      const relevantFiles = await this.contextPreprocessor.gatherContext(userMessage);
      if (relevantFiles.length > 0) {
        const contextPrompt = this.contextPreprocessor.buildContextPrompt(relevantFiles);
        this.messages.push({ role: 'system', content: contextPrompt });
        this.updateStatus(`Auto-loaded ${relevantFiles.length} relevant files`);
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

      let fullResponse = "";
      let iteration = 0;

      while (iteration < this.maxIterations && !this.abortController.signal.aborted) {
        iteration++;
        this.currentIteration = iteration;
        this.metrics.iterations = iteration;

        if (iteration > 1) {
          this.updateStatus(`Iteration ${iteration}/${this.maxIterations}`);
        }

        // Check session limits
        this.checkSessionLimits();

        // Prune messages to keep context bounded
        this.pruneMessages();

        // Get LLM response with streaming
        const response = await this.streamResponse();
        
        if (!response) {
          this.updateStatus("Received empty response, stopping");
          break;
        }

        fullResponse += response;

        // Check if we should stop (AI asking questions or completed)
        if (this.shouldStopAfterResponse(response)) {
          this.messages.push({ role: "assistant", content: response });
          
          if (this.enableMemory) {
            memory.addToSession({
              timestamp: Date.now(),
              role: "assistant",
              content: response,
              metadata: { provider: this.providerType, model: this.model },
            });
          }

          this.updateStatus("Waiting for user input");
          break;
        }

        // Parse and execute tools
        const toolCalls = parseToolCalls(response);

        if (toolCalls.length === 0) {
          // No tools, we're done
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
        this.updateStatus(`Executing ${toolCalls.length} tool(s)`);
        const toolResults = await this.executeTools(toolCalls);

        // Add tool results to conversation
        this.messages.push({ role: "assistant", content: response });
        this.messages.push({
          role: "user",
          content: `Tool Results:\n\n${toolResults.join("\n\n")}`
        });
      }

      // Run related tests if files were edited
      if (this.editedFiles.size > 0) {
        await this.runRelatedTests();
      }

      this.metrics.endTime = Date.now();
      return fullResponse;

    } catch (error) {
      this.callbacks.onError?.(error as Error);
      throw error;
    } finally {
      this.isRunning = false;
      this.abortController = null;
    }
  }

  /**
   * Abort the current workflow execution
   */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.isRunning = false;
  }

  /**
   * Get workflow metrics
   */
  getMetrics(): WorkflowMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset workflow state for new session
   */
  reset(): void {
    this.messages = [];
    this.currentIteration = 0;
    this.editedFiles.clear();
    this.metrics = {
      iterations: 0,
      toolsExecuted: 0,
      totalTokens: 0,
      totalCost: 0,
      startTime: Date.now(),
    };
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async streamResponse(): Promise<string> {
    const promptTokens = countMessageTokens(this.model, this.messages);
    this.sessionTracker?.trackPromptTokens(promptTokens);
    this.sessionTracker?.trackContextUsage(promptTokens);
    this.warnIfContextHigh(promptTokens);

    this.updateStatus("Thinking...");

    this.callbacks.onStreamingStart?.();

    let response = "";
    let streamStarted = false;
    let bufferedContent = "";
    let xmlStarted = false;

    try {
      const chunks: string[] = [];
      
      for await (const chunk of this.provider.stream(this.messages, {
        signal: this.abortController?.signal,
      })) {
        if (!streamStarted) {
          streamStarted = true;
          this.updateStatus("Streaming response");
        }

        if (chunk?.trim()) {
          response += chunk;
          
          // Filter out XML tags for better UX
          const filteredChunk = this.filterXML(chunk);
          bufferedContent += filteredChunk;
          
          // Emit filtered chunk
          if (filteredChunk) {
            this.callbacks.onStreamingChunk?.(filteredChunk);
          }
        }
      }

      // Track tokens
      const completionTokens = countTokens(this.model, response);
      this.sessionTracker?.trackCompletionTokens(completionTokens);
      this.metrics.totalTokens += promptTokens + completionTokens;

      this.callbacks.onStreamingEnd?.();
      
      return response;

    } catch (error) {
      this.callbacks.onError?.(error as Error);
      throw error;
    }
  }

  private filterXML(chunk: string): string {
    let output = "";
    let i = 0;
    let xmlStarted = false;

    while (i < chunk.length) {
      if (!xmlStarted && chunk[i] === '<' && chunk.substring(i).startsWith('<tool')) {
        xmlStarted = true;
      }

      if (!xmlStarted) {
        output += chunk[i];
        i++;
      } else {
        // Inside XML, skip until closing tag
        if (chunk.substring(i).startsWith('</tool>')) {
          xmlStarted = false;
          i += 7; // Skip past </tool>
        } else if (chunk.substring(i).startsWith('/>')) {
          xmlStarted = false;
          i += 2; // Skip past />
        } else {
          i++;
        }
      }
    }

    return output;
  }

  private async executeTools(toolCalls: any[]): Promise<string[]> {
    const results: string[] = [];
    this.metrics.toolsExecuted += toolCalls.length;

    // Categorize tools
    const { parallelizable, sequential } = this.categorizeTools(toolCalls);

    // Execute read operations in parallel
    if (parallelizable.length > 0) {
      this.updateStatus(`Executing ${parallelizable.length} read operation(s) in parallel`);
      
      const parallelPromises = parallelizable.map(async (toolCall) => {
        const toolName = toolCall.tool;
        this.callbacks.onToolStart?.(toolName, toolCall.params);
        
        try {
          const result = await this.executeTool(toolCall);
          this.callbacks.onToolUpdate?.(toolName, "succeeded", this.previewResult(result));
          return this.formatToolResult(toolName, result);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.callbacks.onToolUpdate?.(toolName, "failed", errorMsg);
          return `Tool: ${toolName}\nError: ${errorMsg}`;
        }
      });

      const parallelResults = await Promise.all(parallelPromises);
      results.push(...parallelResults);
    }

    // Execute write operations sequentially
    if (sequential.length > 0) {
      this.updateStatus(`Executing ${sequential.length} write operation(s) sequentially`);
      
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
          const toolName = toolCall.tool;
          this.callbacks.onToolStart?.(toolName, toolCall.params);
          
          try {
            const result = await this.executeTool(toolCall);
            this.callbacks.onToolUpdate?.(toolName, "succeeded", this.previewResult(result));
            results.push(this.formatToolResult(toolName, result));
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.callbacks.onToolUpdate?.(toolName, "failed", errorMsg);
            results.push(`Tool: ${toolName}\nError: ${errorMsg}`);

            // On critical error in destructive operation, rollback
            if (checkpointCreated && destructiveTools.has(toolName)) {
              const rolled = await this.transactionManager.rollback();
              if (rolled) {
                this.updateStatus('Rolled back changes due to error');
              }
              checkpointCreated = false;
              break;
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

    this.callbacks.onToolEnd?.();
    return results;
  }

  private categorizeTools(toolCalls: any[]): {
    parallelizable: any[];
    sequential: any[];
  } {
    const READ_TOOLS = new Set([
      'read_file', 'list_files', 'find_files', 'grep', 'search_text',
      'read_many_files', 'read_folder', 'git_status', 'git_diff',
      'git_log', 'git_blame', 'analyze_project', 'get_file_outline',
      'find_symbol_definition', 'check_syntax', 'explain_code',
      'check_complexity', 'detect_smells', 'find_references',
      'google_search', 'web_fetch', 'load_memory', 'get_env',
      'list_env', 'package_list', 'show_plan', 'validate_project',
      'http_request',
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

  private async executeTool(toolCall: any): Promise<string> {
    const { tool, params } = toolCall;

    // Import tools dynamically
    const tools = await import("../tools/index.js");

    switch (tool) {
      case "analyze_project": {
        const analysis = tools.analyzeProject(this.cwd);
        return analysis.error ? analysis.error : analysis.result;
      }

      case "read_file": {
        const readResult = tools.readFile(params.path, this.cwd);
        if (readResult.error) return readResult.error;
        
        // Check if file already in context
        if (this.isFileInContext(params.path)) {
          return `File ${params.path} already in context (unchanged)`;
        }
        
        this.registerFile(params.path, readResult.result);
        return readResult.result;
      }

      case "list_files": {
        const listResult = tools.listFiles(params.path || ".", this.cwd);
        return listResult.error ? listResult.error : listResult.result;
      }

      case "propose_edit": {
        const edit = tools.proposeEdit(
          params.path,
          toolCall.content || "",
          params.description || "Edit file",
          this.cwd
        );

        // Show diff and prompt for approval
        const approved = await this.reviewSingleEdit(edit);
        
        if (approved) {
          const applyResult = tools.applyEdit(edit, this.cwd);
          if (applyResult.error) {
            await this.transactionManager.rollback();
            return `❌ Failed to apply edit: ${applyResult.error}`;
          }

          await this.transactionManager.commit();
          this.editedFiles.add(params.path);
          return `✅ Edit applied successfully to ${edit.path}`;
        } else {
          await this.transactionManager.rollback();
          return `⏭️ Edit skipped for ${edit.path}`;
        }
      }

      case "edit_section": {
        const oldText = params.oldText || params.old_text || "";
        const newText = params.newText || params.new_text || "";
        const path = params.path || "";

        if (!path || !oldText || !newText) {
          return "edit_section requires path, oldText, and newText";
        }

        const sectionEdit = tools.editSection(
          path,
          oldText,
          newText,
          this.cwd,
          { validateSyntax: true }
        );

        const approved = await this.reviewSingleEdit(sectionEdit);

        if (approved) {
          const applyResult = tools.applyEdit(sectionEdit, this.cwd);
          if (applyResult.error) {
            await this.transactionManager.rollback();
            return `❌ Failed to apply edit: ${applyResult.error}`;
          }

          await this.transactionManager.commit();
          this.editedFiles.add(path);
          return `✅ Section edited successfully in ${sectionEdit.path}`;
        } else {
          await this.transactionManager.rollback();
          return `⏭️ Edit skipped for ${sectionEdit.path}`;
        }
      }

      case "run_command": {
        const command = params.command !== undefined ? String(params.command) : "";
        if (!command) {
          return "run_command requires a command string.";
        }

        if (!(await this.confirmCommand(command))) {
          return `⚠️ Command cancelled: ${command}`;
        }

        const cmdResult = await tools.runCommand(command, this.cwd, params);
        return cmdResult.error ? cmdResult.error : cmdResult.result;
      }

      case "find_files": {
        const findResult = tools.findFiles(
          params.pattern || "*",
          this.cwd,
          params
        );
        return findResult.error ? findResult.error : findResult.result;
      }

      case "read_many_files": {
        const files = params.files?.split(",").map((f: string) => f.trim()) || [];
        const readManyResult = tools.readManyFiles(files, this.cwd, params);
        return readManyResult.error ? readManyResult.error : readManyResult.result;
      }

      case "search_text": {
        const searchResult = tools.searchText(
          params.term || "",
          this.cwd,
          params
        );
        return searchResult.error ? searchResult.error : searchResult.result;
      }

      case "read_folder": {
        const folderResult = tools.readFolder(params.path || ".", this.cwd, params);
        return folderResult.error ? folderResult.error : folderResult.result;
      }

      case "google_search": {
        const searchRes = await tools.googleSearch(params.query || "", params);
        return searchRes.error ? searchRes.error : searchRes.result;
      }

      case "web_fetch": {
        const fetchRes = tools.webFetch(params.url || "", params);
        return fetchRes.error ? fetchRes.error : fetchRes.result;
      }

      case "save_memory": {
        const saveRes = tools.saveMemory(params.key || "", params.content || "", this.cwd);
        return saveRes.error ? saveRes.error : saveRes.result;
      }

      case "load_memory": {
        const loadRes = tools.loadMemory(params.key || "", this.cwd);
        return loadRes.error ? loadRes.error : loadRes.result;
      }

      case "grep": {
        const grepRes = tools.grep(
          params.path || "",
          params.pattern || "",
          this.cwd,
          params
        );
        return grepRes.error ? grepRes.error : grepRes.result;
      }

      case "edit_line": {
        const editLineResult = tools.editLine(
          params.path || "",
          parseInt(params.lineNumber || "0"),
          params.oldText || "",
          params.newText || "",
          this.cwd
        );

        const approved = await this.reviewSingleEdit(editLineResult);

        if (approved) {
          const applyResult = tools.applyEdit(editLineResult, this.cwd);
          if (applyResult.error) {
            await this.transactionManager.rollback();
            return `❌ Failed to apply edit: ${applyResult.error}`;
          }

          await this.transactionManager.commit();
          this.editedFiles.add(params.path || "");
          return `✅ Line edit applied successfully to ${editLineResult.path}`;
        } else {
          await this.transactionManager.rollback();
          return `⏭️ Line edit skipped for ${editLineResult.path}`;
        }
      }

      case "git_status": {
        const gitStatusRes = tools.gitStatus(this.cwd);
        return gitStatusRes.error ? gitStatusRes.error : gitStatusRes.result;
      }

      case "git_diff": {
        const gitDiffRes = tools.gitDiff(this.cwd, params);
        return gitDiffRes.error ? gitDiffRes.error : gitDiffRes.result;
      }

      case "git_log": {
        const gitLogRes = tools.gitLog(this.cwd, params);
        return gitLogRes.error ? gitLogRes.error : gitLogRes.result;
      }

      case "git_commit": {
        const gitCommitRes = tools.gitCommit(params.message || "", this.cwd, params);
        return gitCommitRes.error ? gitCommitRes.error : gitCommitRes.result;
      }

      case "git_branch": {
        const gitBranchRes = tools.gitBranch(this.cwd, params);
        return gitBranchRes.error ? gitBranchRes.error : gitBranchRes.result;
      }

      case "write_file": {
        const targetPath = typeof params.path === "string" ? params.path.trim() : "";
        if (!targetPath) {
          return "write_file requires a path.";
        }

        const content = typeof toolCall.content === "string" ? toolCall.content : "";
        if (!content) {
          return "write_file requires content in the tool call.";
        }

        const edit = tools.proposeEdit(
          targetPath,
          content,
          params.description || "Write file",
          this.cwd
        );

        const approved = await this.reviewSingleEdit(edit);

        if (approved) {
          const applyResult = tools.applyEdit(edit, this.cwd);
          if (applyResult.error) {
            await this.transactionManager.rollback();
            return `❌ Failed to apply edit: ${applyResult.error}`;
          }

          await this.transactionManager.commit();
          this.editedFiles.add(targetPath);
          return `✅ File write applied to ${edit.path}`;
        }

        await this.transactionManager.rollback();
        return `⏭️ File write skipped for ${edit.path}`;
      }

      case "delete_file": {
        const targetPath = typeof params.path === "string" ? params.path.trim() : "";
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
        const source = typeof params.source === "string" ? params.source.trim() : "";
        const dest = typeof params.dest === "string" ? params.dest.trim() : "";

        if (!source || !dest) {
          return "move_file requires both source and dest paths.";
        }

        if (!(await this.confirmToolAction(`Move ${source} → ${dest}?`))) {
          return `⚠️ Move cancelled: ${source} → ${dest}`;
        }

        const moveRes = tools.moveFile(source, dest, this.cwd);
        return moveRes.error ? moveRes.error : moveRes.result;
      }

      case "create_directory": {
        const dirPath = typeof params.path === "string" ? params.path.trim() : "";
        if (!dirPath) {
          return "create_directory requires a path.";
        }

        if (!(await this.confirmToolAction(`Create directory ${dirPath}?`))) {
          return `⚠️ Directory creation cancelled: ${dirPath}`;
        }

        const mkdirRes = tools.createDirectory(dirPath, this.cwd);
        return mkdirRes.error ? mkdirRes.error : mkdirRes.result;
      }

      case "package_install": {
        const packages = params.packages
          ?.split(",")
          .map((p: string) => p.trim())
          .filter(Boolean) || [];

        if (packages.length === 0) {
          return "package_install requires one or more packages.";
        }

        const scopeLabel = params.global ? "globally" : "locally";
        const packageLabel = packages.join(", ");
        if (!(await this.confirmToolAction(`Install ${packageLabel} ${scopeLabel}?`))) {
          return `⚠️ Package install cancelled: ${packageLabel}`;
        }

        const pkgInstallRes = tools.packageInstall(packages, this.cwd, params);
        return pkgInstallRes.error ? pkgInstallRes.error : pkgInstallRes.result;
      }

      case "package_run_script": {
        const script = typeof params.script === "string" ? params.script.trim() : "";
        if (!script) {
          return "package_run_script requires a script name.";
        }

        if (!(await this.confirmToolAction(`Run package script "${script}"?`))) {
          return `⚠️ Package script cancelled: ${script}`;
        }

        const pkgRunRes = tools.packageRunScript(script, this.cwd, params);
        return pkgRunRes.error ? pkgRunRes.error : pkgRunRes.result;
      }

      case "package_list": {
        const pkgListRes = tools.packageList(this.cwd, params);
        return pkgListRes.error ? pkgListRes.error : pkgListRes.result;
      }

      case "get_env": {
        const getEnvRes = tools.getEnv(params.key || "", this.cwd);
        return getEnvRes.error ? getEnvRes.error : getEnvRes.result;
      }

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

      case "list_env": {
        const listEnvRes = tools.listEnv(this.cwd);
        return listEnvRes.error ? listEnvRes.error : listEnvRes.result;
      }

      case "http_request": {
        const httpRes = await tools.httpRequest(params.url || "", params);
        return httpRes.error ? httpRes.error : httpRes.result;
      }

      case "get_file_outline": {
        const outlineRes = tools.getFileOutline(params.path || "", this.cwd);
        return outlineRes.error ? outlineRes.error : outlineRes.result;
      }

      case "find_symbol_definition": {
        const symbolRes = tools.findSymbolDefinition(params.symbol || "", this.cwd, params);
        return symbolRes.error ? symbolRes.error : symbolRes.result;
      }

      case "check_syntax": {
        const syntaxRes = tools.checkSyntax(params.path || "", this.cwd);
        return syntaxRes.error ? syntaxRes.error : syntaxRes.result;
      }

      case "validate_project": {
        const validateRes = tools.validateProject(this.cwd, params);
        return validateRes.error ? validateRes.error : validateRes.result;
      }

      case "set_plan": {
        const setPlanRes = tools.setPlan(
          params.title || "Task Plan",
          params.tasks || [],
          this.cwd
        );
        return setPlanRes.error ? setPlanRes.error : setPlanRes.result;
      }

      case "update_plan_task": {
        const updateTaskRes = tools.updatePlanTask(
          params.taskId || "",
          params.status || "pending",
          params.notes
        );
        return updateTaskRes.error ? updateTaskRes.error : updateTaskRes.result;
      }

      case "show_plan": {
        const showPlanRes = tools.showPlan();
        return showPlanRes.error ? showPlanRes.error : showPlanRes.result;
      }

      case "clear_plan": {
        const clearPlanRes = tools.clearPlan();
        return clearPlanRes.error ? clearPlanRes.error : clearPlanRes.result;
      }

      case "explain_code": {
        const explainRes = tools.explainCode(params.path || "", this.cwd, params);
        return explainRes.error ? explainRes.error : explainRes.result;
      }

      case "generate_docstring": {
        const docstringRes = tools.generateDocstring(params.path || "", this.cwd, params);
        return docstringRes.error ? docstringRes.error : docstringRes.result;
      }

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

      case "dependency_audit": {
        const auditRes = tools.dependencyAudit(this.cwd, params);
        return auditRes.error ? auditRes.error : auditRes.result;
      }

      case "run_tests": {
        const testRes = tools.runTests(this.cwd, params);
        return testRes.error ? testRes.error : testRes.result;
      }

      case "generate_tests": {
        const genTestsRes = tools.generateTests(params.path || "", this.cwd, params);
        return genTestsRes.error ? genTestsRes.error : genTestsRes.result;
      }

      case "security_scan": {
        const securityRes = tools.securityScan(params.path || "", this.cwd, params);
        return securityRes.error ? securityRes.error : securityRes.result;
      }

      case "code_review": {
        const reviewRes = tools.codeReview(params.path || "", this.cwd, params);
        return reviewRes.error ? reviewRes.error : reviewRes.result;
      }

      case "generate_readme": {
        const readmeRes = tools.generateReadme(this.cwd, params);
        return readmeRes.error ? readmeRes.error : readmeRes.result;
      }

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

      case "check_complexity": {
        const complexityRes = tools.checkComplexity(params.path || "", this.cwd);
        return complexityRes.error ? complexityRes.error : complexityRes.result;
      }

      case "detect_smells": {
        const smellsRes = tools.detectSmells(params.path || "", this.cwd, params);
        return smellsRes.error ? smellsRes.error : smellsRes.result;
      }

      case "analyze_coverage": {
        const coverageRes = tools.analyzeCoverage(this.cwd, params);
        return coverageRes.error ? coverageRes.error : coverageRes.result;
      }

      case "find_references": {
        const referencesRes = tools.findReferences(params.symbol || "", this.cwd, params);
        return referencesRes.error ? referencesRes.error : referencesRes.result;
      }

      case "generate_test_suite": {
        const testSuiteRes = tools.generateTestSuite(params.path || "", this.cwd, params);
        return testSuiteRes.error ? testSuiteRes.error : testSuiteRes.result;
      }

      case "generate_mocks": {
        const mocksRes = tools.generateMocks(params.path || "", this.cwd, params);
        return mocksRes.error ? mocksRes.error : mocksRes.result;
      }

      case "generate_api_docs": {
        const apiDocsRes = tools.generateApiDocs(params.path || "", this.cwd, params);
        return apiDocsRes.error ? apiDocsRes.error : apiDocsRes.result;
      }

      case "git_blame": {
        const blameRes = tools.gitBlame(params.path || "", this.cwd);
        return blameRes.error ? blameRes.error : blameRes.result;
      }

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

        const convertRes = tools.convertToAsync(
          filePath,
          functionName,
          this.cwd,
          params
        );
        return convertRes.error ? convertRes.error : convertRes.result;
      }

      case "wait_for_user": {
        const waitRes = tools.waitForUser(params.reason || "waiting for user response");
        return waitRes.error ? waitRes.error : waitRes.result;
      }

      default:
        // Try MCP tools
        if (tool.includes('.')) {
          const result = await this.mcpManager.executeTool(tool, params);
          return typeof result.content === "string"
            ? result.content
            : JSON.stringify(result.content, null, 2);
        }

        return `Unknown tool: ${tool}`;
    }
  }

  private formatToolResult(toolName: string, result: string): string {
    const MAX_LENGTH = 3000;
    const MAX_LINES = 100;

    const lines = result.split('\n');

    if (toolName === 'read_file' || toolName === 'list_files' || toolName === 'read_folder' || toolName === 'read_many_files') {
      if (result.length > MAX_LENGTH || lines.length > MAX_LINES) {
        const truncated = lines.slice(0, MAX_LINES).join('\n').slice(0, MAX_LENGTH);
        const omittedLines = Math.max(lines.length - MAX_LINES, 0);
        const omittedChars = Math.max(result.length - MAX_LENGTH, 0);
        return `Tool: ${toolName}\nResult (truncated - ${result.length} chars, ${lines.length} lines):\n${truncated}\n\n[... ${omittedLines} more lines omitted (${omittedChars} chars). Use grep or read specific sections if needed]`;
      }
    }

    return `Tool: ${toolName}\nResult:\n${result}`;
  }

  private shouldStopAfterResponse(response: string): boolean {
    const questionPatterns = [
      /would you like/i,
      /do you want/i,
      /should i/i,
      /can i help/i,
      /what would you prefer/i,
      /which (?:one|option)/i,
      /are you sure/i,
      /confirm/i,
      /please (?:confirm|let me know|tell me)/i,
      /could you clarify/i,
      /could you (?:explain|provide|specify)/i,
    ];

    const completionPatterns = [
      /the (?:app|project|feature|task) is (?:ready|complete|done)/i,
      /all (?:files|changes|tasks) (?:are|have been) (?:created|completed)/i,
      /you can now/i,
      /to get started/i,
      /ready to (?:use|test|run)/i,
    ];

    for (const pattern of questionPatterns) {
      if (pattern.test(response)) {
        return true;
      }
    }

    for (const pattern of completionPatterns) {
      if (pattern.test(response)) {
        return true;
      }
    }

    const lines = response.split('\n').map(line => line.trim());
    for (const line of lines) {
      if (line.endsWith('?')) {
        return true;
      }
    }

    return false;
  }

  private getSystemPrompt(): string {
    return buildAgentSystemPrompt({
      cwd: this.cwd,
      mcpTools: this.mcpTools,
    });
  }

  private checkSessionLimits(): void {
    if (!this.sessionTracker) {
      return;
    }

    const tokenUsage = this.sessionTracker.getTokenUsage();
    const costUsage = this.sessionTracker.getCostUsage();

    if (this.config.limits?.maxTokensPerSession && tokenUsage.total >= this.config.limits.maxTokensPerSession) {
      throw new Error(
        `Session token limit exceeded: ${tokenUsage.total.toLocaleString()} / ${this.config.limits.maxTokensPerSession.toLocaleString()} tokens used.\n` +
        `Consider increasing the limit in your config or starting a new session.`
      );
    }

    if (this.config.limits?.maxCostPerSession && costUsage.total >= this.config.limits.maxCostPerSession) {
      throw new Error(
        `Session cost limit exceeded: ${costUsage.formatted.total} / $${this.config.limits.maxCostPerSession.toFixed(2)} spent.\n` +
        `Consider increasing the limit in your config or starting a new session.`
      );
    }

    const tokenPercent = this.config.limits?.maxTokensPerSession 
      ? (tokenUsage.total / this.config.limits.maxTokensPerSession) * 100
      : 0;

    if (tokenPercent >= 85 && tokenPercent < 100) {
      this.updateStatus(`⚠️ ${tokenPercent.toFixed(1)}% of session token limit used`);
    }

    const costPercent = this.config.limits?.maxCostPerSession
      ? (costUsage.total / this.config.limits.maxCostPerSession) * 100
      : 0;

    if (costPercent >= 85 && costPercent < 100) {
      this.updateStatus(`⚠️ ${costPercent.toFixed(1)}% of session cost limit used`);
    }
  }

  private pruneMessages(): void {
    const MAX_MESSAGES = 12;
    const KEEP_RECENT = 6;

    if (this.messages.length <= MAX_MESSAGES) return;

    const pruned = this.messages.length - MAX_MESSAGES;
    const systemMessages = this.messages.filter(m => m.role === 'system');
    const recentMessages = this.messages.slice(-KEEP_RECENT);

    this.messages = [...systemMessages, ...recentMessages];
  }

  private warnIfContextHigh(tokens: number): void {
    if (!this.contextLimit) return;

    const usage = tokens / this.contextLimit;
    if (usage > 0.9) {
      this.updateStatus(`⚠️ Context usage very high: ${(usage * 100).toFixed(0)}%`);
    } else if (usage > 0.7) {
      this.updateStatus(`⚠️ Context usage: ${(usage * 100).toFixed(0)}%`);
    }
  }

  private updateStatus(status: string): void {
    this.callbacks.onStatusChange?.(status);
  }

  private async reviewSingleEdit(edit: FileEdit): Promise<boolean> {
    // Use updateStatus instead of console.log to avoid interfering with Ink TUI
    this.updateStatus(`📝 Reviewing edit: ${edit.path}`);
    
    const diff = generateDiff(edit.oldContent, edit.newContent);
    if (diff.length > 0) {
      // Show a brief preview of the diff
      const previewLines = diff.slice(0, 10);
      const preview = previewLines.join('\n');
      this.updateStatus(`Changes preview:\n${preview}${diff.length > 10 ? `\n... and ${diff.length - 10} more lines` : ''}`);
    } else {
      this.updateStatus(`No textual diff (new or identical file): ${edit.path}`);
    }

    // Create checkpoint before applying changes
    await this.transactionManager.createCheckpoint(`edit-${edit.path.replace(/[^a-zA-Z0-9]/g, '-')}`);

    // Prompt for approval with retry option
    if (this.config.promptChoice) {
      const choice = await this.config.promptChoice(
        `Apply changes to ${edit.path}?`,
        [
          { label: "Apply", value: "apply" },
          { label: "Skip", value: "skip" },
          { label: "Cancel all", value: "cancel" },
        ],
        "apply"
      );

      if (choice === "cancel") {
        throw new Error("Edit cancelled by user");
      }

      return choice === "apply";
    }

    // Default to applying changes if no prompt choice callback
    return true;
  }

  private async confirmCommand(command: string): Promise<boolean> {
    const safeCommands = [
      /^npm\s+run\s+(build|test|lint|check|compile|typecheck)$/i,
      /^npm\s+test$/i,
      /^npm\s+run\s+lint$/i,
      /^yarn\s+build$/i,
      /^yarn\s+test$/i,
      /^pnpm\s+build$/i,
      /^pnpm\s+test$/i,
      /^git\s+status$/i,
      /^git\s+diff/i,
      /^git\s+log/i,
      /^git\s+branch$/i,
      /^npm\s+install$/i,
      /^npm\s+i$/i,
      /^yarn\s+install$/i,
      /^yarn$/i,
      /^pnpm\s+install$/i,
    ];

    for (const pattern of safeCommands) {
      if (pattern.test(command.trim())) {
        return true;
      }
    }

    if (this.config.promptChoice) {
      const choice = await this.config.promptChoice(
        `Run shell command: ${command}`,
        [
          { label: "Run command", value: "run" },
          { label: "Cancel", value: "cancel" },
        ],
        "run"
      );
      return choice === "run";
    }

    // Default to cancel if no prompt choice callback (safer default)
    return false;
  }

  private async confirmToolAction(message: string): Promise<boolean> {
    if (this.config.promptChoice) {
      const choice = await this.config.promptChoice(
        message,
        [
          { label: "Confirm", value: "confirm" },
          { label: "Cancel", value: "cancel" },
        ],
        "cancel"
      );
      return choice === "confirm";
    }

    // Default to cancel if no prompt choice callback (safer default)
    return false;
  }

  private async runRelatedTests(): Promise<void> {
    const testFiles = new Set<string>();

    for (const file of this.editedFiles) {
      if (this.testDetector.isTestFile(file)) {
        continue;
      }

      const related = this.testDetector.findRelatedTests(file);
      related.forEach(t => testFiles.add(t));
    }

    if (testFiles.size === 0) {
      this.updateStatus('ℹ️ No related tests found for edited files');
      return;
    }

    const testCount = testFiles.size;
    const testLabel = testCount === 1 ? 'test' : 'tests';

    this.updateStatus(`🧪 Running ${testCount} related ${testLabel}...`);

    const framework = this.testDetector.detectFramework();
    if (!framework) {
      this.updateStatus('⚠️ No test framework detected');
      return;
    }

    const testCommand = this.testDetector.getTestCommand(
      framework,
      Array.from(testFiles)
    );

    if (!testCommand) {
      this.updateStatus(`⚠️ Unable to build test command for framework: ${framework}`);
      return;
    }

    try {
      const tools = await import("../tools/index.js");
      const result = await tools.runCommand(testCommand, this.cwd, { timeoutMs: 30000 });

      if (result.error) {
        this.updateStatus(`❌ Tests failed:\n${result.error}`);
      } else {
        this.updateStatus(`✅ Tests passed`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.updateStatus(`⚠️ Could not run tests: ${errorMsg}`);
    }
  }

  // File registry helpers
  private fileRegistry = new Map<string, {
    hash: string;
    content: string;
    lastAccess: number;
  }>();

  private hashContent(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) - hash) + content.charCodeAt(i);
      hash = hash & hash;
    }
    return hash.toString(16);
  }

  private registerFile(path: string, content: string): void {
    const hash = this.hashContent(content);
    this.fileRegistry.set(path, {
      hash,
      content,
      lastAccess: Date.now()
    });
  }

  private isFileInContext(path: string): boolean {
    return this.fileRegistry.has(path);
  }

  private previewResult(result: string): string {
    const max = 200;
    return result.length > max ? `${result.slice(0, max)}…` : result;
  }
}
