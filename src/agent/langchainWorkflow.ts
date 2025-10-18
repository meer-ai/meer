import chalk from "chalk";
import ora, { type Ora } from "ora";
import inquirer from "inquirer";
import { CallbackManager } from "@langchain/core/callbacks/manager";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { Provider, ChatMessage } from "../providers/base.js";
import { createMeerLangChainTools } from "./tools/langchain.js";
import { ProviderChatModel } from "./langchain/providerChatModel.js";
import { ManualAgent } from "./langchain/manualAgent.js";
import { buildLangChainSystemPrompt } from "./prompts/langchainSystemPrompt.js";
import { memory } from "../memory/index.js";
import { MCPManager } from "../mcp/manager.js";
import type { MCPTool, MCPToolResult } from "../mcp/types.js";
import type { SessionTracker } from "../session/tracker.js";
import {
  countTokens,
  countMessageTokens,
  getContextLimit,
} from "../token/utils.js";
import { generateDiff, applyEdit, type FileEdit } from "../tools/index.js";
import { OCEAN_SPINNER, type Timeline } from "../ui/workflowTimeline.js";
import {
  log,
  llmRequestsTotal,
  llmLatency,
  llmTokensTotal,
  contextWindowUsage,
  contextPruningEvents,
} from "../telemetry/index.js";

function normalizeAgentOutput(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeAgentOutput(item)).join("");
  }

  if (typeof value === "object") {
    const candidate = value as Record<string, unknown>;

    if (typeof candidate.text === "string") {
      return candidate.text;
    }

    if ("message" in candidate) {
      return normalizeAgentOutput(candidate.message);
    }

    if ("output" in candidate) {
      return normalizeAgentOutput(candidate.output);
    }

    if ("content" in candidate) {
      return normalizeAgentOutput(candidate.content);
    }

    try {
      return JSON.stringify(candidate);
    } catch {
      return String(candidate);
    }
  }

  return String(value);
}

interface ActionDirective {
  action: string;
  input: unknown;
}

function tryParseJson(value: string): unknown {
  const trimmed = value.trim();

  if (trimmed.startsWith("```")) {
    const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
    if (fenceMatch) {
      try {
        return JSON.parse(fenceMatch[1]);
      } catch {
        // fall through to default behavior
      }
    }
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function parseActionDirective(raw: unknown): ActionDirective | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  let candidate: unknown = raw;

  if (typeof raw === "string") {
    candidate = tryParseJson(raw.trim());
  }

  if (Array.isArray(candidate)) {
    for (const item of candidate) {
      const parsed = parseActionDirective(item);
      if (parsed) {
        return parsed;
      }
    }
    return null;
  }

  if (typeof candidate !== "object") {
    return null;
  }

  const record = candidate as Record<string, unknown>;
  const action =
    typeof record.action === "string"
      ? record.action
      : typeof record.tool === "string"
      ? record.tool
      : typeof record.name === "string"
      ? record.name
      : null;

  if (!action) {
    return null;
  }

  const input =
    record.args ??
    record.arguments ??
    record.action_input ??
    record.input ??
    record.parameters ??
    {};

  return { action, input };
}

export interface LangChainAgentConfig {
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

export class LangChainAgentWorkflow {
  private provider: Provider;
  private cwd: string;
  private maxIterations: number;
  private enableMemory: boolean;
  private providerType: string;
  private model: string;
  private sessionTracker?: SessionTracker;
  private contextLimit?: number;
  private chatTimeout: number;
  private messages: ChatMessage[] = [];
  private agent?: ManualAgent;
  private tools: StructuredToolInterface[] = [];
  private toolMap = new Map<string, StructuredToolInterface>();
  private mcpManager = MCPManager.getInstance();
  private mcpTools: MCPTool[] = [];
  private runWithTerminal?: <T>(fn: () => Promise<T>) => Promise<T>;
  private promptChoice?: (
    message: string,
    choices: Array<{ label: string; value: string }>,
    defaultValue: string
  ) => Promise<string>;
  private lastPromptTokens = 0;
  private basePromptTokens = 0;

  constructor(config: LangChainAgentConfig) {
    this.provider = config.provider;
    this.cwd = config.cwd;
    this.maxIterations = config.maxIterations || 6;
    this.enableMemory = config.enableMemory ?? true;
    this.providerType = config.providerType || "unknown";
    this.model = config.model || "unknown";
    this.sessionTracker = config.sessionTracker;
    this.contextLimit = getContextLimit(this.model);
    this.chatTimeout =
      config.timeouts?.chat ||
      (this.providerType.toLowerCase() === "ollama" ? 300000 : 90000);

    if (this.contextLimit) {
      this.sessionTracker?.setContextLimit(this.contextLimit);
    }
  }

  async initialize(contextPrompt?: string) {
    if (!this.mcpManager.isInitialized()) {
      try {
        await this.mcpManager.initialize();
        this.mcpTools = this.mcpManager.listAllTools();
      } catch (error) {
        console.log(
          chalk.yellow("⚠️  MCP initialization failed. Continuing without MCP tools.")
        );
        this.mcpTools = [];
      }
    } else {
      this.mcpTools = this.mcpManager.listAllTools();
    }

    const systemPrompt = buildLangChainSystemPrompt({
      cwd: this.cwd,
      mcpTools: this.mcpTools,
    });
    const fullPrompt = contextPrompt
      ? `${systemPrompt}\n\n${contextPrompt}`
      : systemPrompt;

    this.messages = [{ role: "system", content: fullPrompt }];
    this.basePromptTokens = countMessageTokens(this.model, this.messages);
    this.lastPromptTokens = 0;

    const chatModel = new ProviderChatModel(this.provider, {
      model: this.model,
      providerType: this.providerType,
    });

    this.tools = createMeerLangChainTools(
      {
        cwd: this.cwd,
        provider: this.provider,
        reviewFileEdit: async (edit) => this.reviewFileEdit(edit),
        confirmCommand: async (command) => this.confirmCommand(command),
        executeMcpTool: (toolName, params) =>
          this.executeMcpTool(toolName, params),
      },
      {
        mcpTools: this.mcpTools,
      }
    );
    this.toolMap = new Map(
      this.tools.map((tool) => [tool.name, tool] as const)
    );

    // Create manual agent with provider-agnostic tool calling
    this.agent = new ManualAgent({
      llm: chatModel,
      tools: this.tools,
      systemPrompt: fullPrompt,
      maxIterations: this.maxIterations,
      verbose: false,
    });
  }

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
    if (!this.agent) {
      throw new Error("Agent not initialized");
    }

    const timeline = options?.timeline;
    const onAssistantStart = options?.onAssistantStart;
    const onAssistantChunk = options?.onAssistantChunk;
    const onAssistantEnd = options?.onAssistantEnd;
    const useUI = Boolean(onAssistantChunk);
    this.runWithTerminal = options?.withTerminal;
    this.promptChoice = options?.promptChoice;

    this.messages.push({ role: "user", content: userMessage });

    // Prune messages if approaching context limit
    this.pruneMessagesIfNeeded();

    if (this.enableMemory) {
      memory.addToSession({
        timestamp: Date.now(),
        role: "user",
        content: userMessage,
      });
    }

    const historyMessages = this.messages
      .slice(1, -1)
      .map(toLangChainMessage);

    const previousPromptTokens = this.lastPromptTokens;
    const promptTokens = countMessageTokens(this.model, this.messages);
    this.sessionTracker?.trackPromptTokens(promptTokens);
    this.sessionTracker?.trackContextUsage(promptTokens);
    this.warnIfContextHigh(promptTokens);
    this.lastPromptTokens = promptTokens;

    let spinner: Ora | null = null;
    let thinkingTaskId: string | undefined;
    const stopSpinner = () => {
      if (spinner) {
        spinner.stop();
        spinner = null;
      }
    };
    let streamStarted = false;
    let uiStreamStarted = false;
    let headerPrinted = false;

    const printConsoleHeader = () => {
      if (!headerPrinted) {
        console.log(chalk.green("\n🤖 MeerAI (LangChain):\n"));
        headerPrinted = true;
      }
    };

    if (timeline) {
      thinkingTaskId = timeline.startTask("Thinking", {
        detail: `${this.providerType}:${this.model}`,
      });
    } else if (!useUI) {
      spinner = ora({
        text: chalk.blue("Thinking..."),
        spinner: OCEAN_SPINNER,
      }).start();
    }

    const callbackManager = CallbackManager.fromHandlers({
      handleLLMNewToken: async (token) => {
        if (token === undefined || token === null) {
          return;
        }
        const text = String(token);
        if (!text) {
          return;
        }
        streamStarted = true;
        if (timeline && thinkingTaskId) {
          timeline.succeed(thinkingTaskId, "Streaming response");
          thinkingTaskId = undefined;
        }
        stopSpinner();
        if (useUI) {
          if (!uiStreamStarted) {
            uiStreamStarted = true;
            if (!timeline) {
              onAssistantStart?.();
            }
          }
          onAssistantChunk?.(text);
        } else {
          printConsoleHeader();
          process.stdout.write(text);
        }
      },
      handleLLMEnd: async () => {
        stopSpinner();
        if (useUI && uiStreamStarted) {
          onAssistantEnd?.();
        } else if (!useUI && streamStarted) {
          console.log("");
        }
      },
      handleLLMError: async (err) => {
        stopSpinner();
        if (timeline && thinkingTaskId) {
          timeline.fail(
            thinkingTaskId,
            err instanceof Error ? err.message : String(err)
          );
          thinkingTaskId = undefined;
        }
        if (useUI && uiStreamStarted) {
          onAssistantEnd?.();
        }
      },
    });

    const llmStartTime = Date.now();

    try {
      const result = await this.withTimeout(
        this.agent.invoke({
          input: userMessage,
          chat_history: historyMessages,
        }),
        this.chatTimeout,
        "LangChain agent"
      );

      // Track successful LLM request
      const llmDuration = (Date.now() - llmStartTime) / 1000;
      llmRequestsTotal.inc({
        provider: this.providerType,
        model: this.model,
        status: 'success'
      });
      llmLatency.observe({
        provider: this.providerType,
        model: this.model
      }, llmDuration);

      const responseOutput =
        typeof result === "object" && result !== null && "output" in result
          ? (result as any).output
          : result;

      const directive = parseActionDirective(responseOutput);
      let response = normalizeAgentOutput(responseOutput);

      if (directive) {
        const fallback = await this.executeFallbackToolAction(
          directive,
          timeline
        );
        if (fallback !== null) {
          response = fallback;
        }
      }

      if (timeline && thinkingTaskId) {
        timeline.succeed(thinkingTaskId, "Response ready");
        thinkingTaskId = undefined;
      } else {
        stopSpinner();
      }

      if (!useUI) {
        if (!streamStarted) {
          printConsoleHeader();
          console.log(response);
        }
      } else if (!uiStreamStarted) {
        uiStreamStarted = true;
        if (!timeline) {
          onAssistantStart?.();
        }
        onAssistantChunk?.(response);
        onAssistantEnd?.();
      }

      const completionTokens = countTokens(this.model, response);
      this.sessionTracker?.trackCompletionTokens(completionTokens);

      // Track token metrics
      llmTokensTotal.inc({
        provider: this.providerType,
        model: this.model,
        type: 'prompt'
      }, promptTokens);
      llmTokensTotal.inc({
        provider: this.providerType,
        model: this.model,
        type: 'completion'
      }, completionTokens);

      // Track context window usage
      if (this.contextLimit) {
        const totalTokens = promptTokens + completionTokens;
        const usageRatio = totalTokens / this.contextLimit;
        contextWindowUsage.observe({ model: this.model }, usageRatio);
      }

      this.messages.push({ role: "assistant", content: response });

      if (this.enableMemory) {
        memory.addToSession({
          timestamp: Date.now(),
          role: "assistant",
          content: response,
          metadata: { provider: this.providerType, model: this.model },
        });
      }
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
        const summary =
          costUsage.total > 0
            ? `${headline} | Cost: ${costUsage.formatted.total} • ${totals}${systemPromptNote}`
            : `${headline} • ${totals}${systemPromptNote}`;
        if (timeline) {
          timeline.note(`?? ${summary}`);
        } else {
          console.log(chalk.dim(`\n?? ${summary}`));
        }
      }

      return response;
    } catch (error) {
      // Track failed LLM request
      llmRequestsTotal.inc({
        provider: this.providerType,
        model: this.model,
        status: 'failure'
      });

      log.error(`LLM request failed: ${this.providerType}/${this.model}`, error as Error, {
        provider: this.providerType,
        model: this.model
      });

      stopSpinner();
      if (timeline && thinkingTaskId) {
        timeline.fail(
          thinkingTaskId,
          error instanceof Error ? error.message : String(error)
        );
        thinkingTaskId = undefined;
      }
      if (useUI && uiStreamStarted) {
        onAssistantEnd?.();
      }
      throw error;
    } finally {
      this.runWithTerminal = undefined;
      this.promptChoice = undefined;
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

  private async executeMcpTool(
    toolName: string,
    params: Record<string, unknown>
  ): Promise<string> {
    const result = await this.mcpManager.executeTool(toolName, params);
    return this.formatMcpToolResult(toolName, result);
  }

  private formatMcpToolResult(
    toolName: string,
    result: MCPToolResult
  ): string {
    if (!result.success) {
      const reason = result.error ?? "Unknown error";
      throw new Error(`MCP tool "${toolName}" failed: ${reason}`);
    }

    if (!Array.isArray(result.content) || result.content.length === 0) {
      return `MCP tool "${toolName}" executed successfully (no content).`;
    }

    const parts = result.content.map((item) => {
      if (item.type === "text" && item.text) {
        return item.text;
      }
      if (item.type === "image" && item.data) {
        return `[image:${item.mimeType ?? "unknown"} size=${item.data.length}B]`;
      }
      if (item.type === "resource" && item.text) {
        return item.text;
      }
      return JSON.stringify(item);
    });

    const duration =
      typeof result.metadata?.executionTime === "number"
        ? `\n\nDuration: ${result.metadata.executionTime}ms`
        : "";

    return parts.join("\n\n") + duration;
  }

  private warnIfContextHigh(tokens: number) {
    if (!this.contextLimit) return;
    const usage = tokens / this.contextLimit;
    if (usage > 0.9) {
      console.log(
        chalk.red(`\n⚠️ Context usage very high: ${(usage * 100).toFixed(0)}%`)
      );
    } else if (usage > 0.7) {
      console.log(
        chalk.yellow(`\n⚠️ Context usage: ${(usage * 100).toFixed(0)}%`)
      );
    }
  }

  /**
   * Prune old messages if approaching context limit
   */
  private pruneMessagesIfNeeded(): void {
    if (!this.contextLimit) return;

    // Calculate target token count (70% of limit to leave room for response)
    const targetTokens = Math.floor(this.contextLimit * 0.7);
    let currentTokens = countMessageTokens(this.model, this.messages);

    // If we're under the target, no need to prune
    if (currentTokens <= targetTokens) {
      return;
    }

    console.log(
      chalk.yellow(
        `\n⚠️  Context window is full (${currentTokens.toLocaleString()} / ${this.contextLimit.toLocaleString()} tokens). Pruning old messages...`
      )
    );

    // Keep system message (index 0) and most recent messages
    // Remove oldest user/assistant message pairs
    const systemMessage = this.messages[0];
    let messagesToKeep = [systemMessage];
    let recentMessages = this.messages.slice(1);

    // Start from the end and keep as many recent messages as fit
    while (recentMessages.length > 0) {
      const candidateMessages = [systemMessage, ...recentMessages];
      const candidateTokens = countMessageTokens(this.model, candidateMessages);

      if (candidateTokens <= targetTokens) {
        messagesToKeep = candidateMessages;
        break;
      }

      // Remove oldest non-system message
      recentMessages = recentMessages.slice(1);
    }

    const prunedCount = this.messages.length - messagesToKeep.length;
    if (prunedCount > 0) {
      this.messages = messagesToKeep;
      const newTokenCount = countMessageTokens(this.model, this.messages);

      // Track context pruning event
      contextPruningEvents.inc({ model: this.model });
      log.info('Context window pruned', {
        model: this.model,
        messagesPruned: prunedCount,
        tokensBefore: currentTokens,
        tokensAfter: newTokenCount,
        contextLimit: this.contextLimit,
        usageAfter: ((newTokenCount / this.contextLimit) * 100).toFixed(2) + '%'
      });

      console.log(
        chalk.green(
          `  ✅ Pruned ${prunedCount} ${prunedCount === 1 ? 'message' : 'messages'}. ` +
          `Context: ${newTokenCount.toLocaleString()} / ${this.contextLimit.toLocaleString()} tokens ` +
          `(${((newTokenCount / this.contextLimit) * 100).toFixed(0)}%)`
        )
      );
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
        setTimeout(
          () =>
            reject(new Error(`Timeout: ${operation} exceeded ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ]);
  }

  private async reviewFileEdit(edit: FileEdit): Promise<boolean> {
    console.log(chalk.bold.yellow(`\n📝 ${edit.path}`));
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

  private async showDiff(diffLines: string[]): Promise<void> {
    if (diffLines.length === 0) {
      console.log(chalk.green("   No textual diff (new or identical file)\n"));
      return;
    }

    const maxLines = 50;
    if (diffLines.length <= maxLines) {
      diffLines.forEach((line) => console.log(line));
      console.log(chalk.gray("└─\n"));
      return;
    }

    diffLines.slice(0, maxLines).forEach((line) => console.log(line));
    console.log(
      chalk.gray(`└─ ... and ${diffLines.length - maxLines} more lines\n`)
    );

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

  private async executeFallbackToolAction(
    directive: ActionDirective,
    timeline?: Timeline
  ): Promise<string | null> {
    const tool = this.toolMap.get(directive.action);
    if (!tool) {
      return null;
    }

    let toolInput: unknown = directive.input ?? {};

    if (directive.action === "suggest_setup") {
      if (typeof toolInput === "string" && toolInput.trim().length > 0) {
        toolInput = { request: toolInput.trim() };
      } else if (typeof toolInput !== "object" || toolInput === null) {
        toolInput = {};
      }

      const inputRecord = toolInput as Record<string, unknown>;
      const hasRequest =
        typeof inputRecord.request === "string" &&
        inputRecord.request.trim().length > 0;
      if (!hasRequest) {
        const latestUserMessage = [...this.messages]
          .reverse()
          .find((message) => message.role === "user");
        if (latestUserMessage && latestUserMessage.content) {
          inputRecord.request = latestUserMessage.content;
        }
      }
    }

    let taskId: string | undefined;
    if (timeline) {
      taskId = timeline.startTask(`Tool: ${directive.action}`);
    }

    try {
      const result = await tool.call(toolInput ?? {});
      if (taskId && timeline) {
        timeline.succeed(taskId);
      }
      return normalizeAgentOutput(result);
    } catch (error) {
      if (taskId && timeline) {
        timeline.fail(
          taskId,
          error instanceof Error ? error.message : String(error)
        );
      }
      log.warn(
        `LangChain fallback tool execution failed for ${directive.action}`,
        {
          error: error instanceof Error ? error.message : String(error),
        }
      );
      return `⚠️ Tool "${directive.action}" failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }
}

function toLangChainMessage(message: ChatMessage): BaseMessage {
  switch (message.role) {
    case "system":
      return new SystemMessage(message.content);
    case "assistant":
      return new AIMessage(message.content);
    default:
      return new HumanMessage(message.content);
  }
}
