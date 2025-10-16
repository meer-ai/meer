import chalk from "chalk";
import ora, { type Ora } from "ora";
import inquirer from "inquirer";
import { CallbackManager } from "@langchain/core/callbacks/manager";
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from "@langchain/core/prompts";
import {
  AgentExecutor,
  StructuredChatAgent,
  createStructuredChatAgent,
} from "langchain/agents";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { Provider, ChatMessage } from "../providers/base.js";
import { createMeerLangChainTools } from "./tools/langchain.js";
import { ProviderChatModel } from "./langchain/providerChatModel.js";
import { buildAgentSystemPrompt } from "./prompts/systemPrompt.js";
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
import type { Timeline } from "../ui/workflowTimeline.js";

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
  private executor?: AgentExecutor;
  private mcpManager = MCPManager.getInstance();
  private mcpTools: MCPTool[] = [];
  private runWithTerminal?: <T>(fn: () => Promise<T>) => Promise<T>;
  private promptChoice?: (
    message: string,
    choices: Array<{ label: string; value: string }>,
    defaultValue: string
  ) => Promise<string>;

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

    const systemPrompt = buildAgentSystemPrompt({
      cwd: this.cwd,
      mcpTools: this.mcpTools,
    });
    const fullPrompt = contextPrompt
      ? `${systemPrompt}\n\n${contextPrompt}`
      : systemPrompt;

    this.messages = [{ role: "system", content: fullPrompt }];

    const chatModel = new ProviderChatModel(this.provider, {
      model: this.model,
      providerType: this.providerType,
    });

    const tools = createMeerLangChainTools(
      {
        cwd: this.cwd,
        provider: this.provider,
        reviewFileEdit: async (edit) => this.reviewFileEdit(edit),
        executeMcpTool: (toolName, params) =>
          this.executeMcpTool(toolName, params),
      },
      {
        mcpTools: this.mcpTools,
      }
    );

    const escapedPrompt = fullPrompt
      .replaceAll("{", "{{")
      .replaceAll("}", "}}");

    const systemContent =
      `${escapedPrompt}\n\nAvailable tools:\n{tools}\n\nTool usage instructions: only call tools listed above using their exact ` +
      `names ({tool_names}).`;

    const prompt = ChatPromptTemplate.fromMessages([
      ["system", systemContent],
      new MessagesPlaceholder("history"),
      ["human", "{input}"],
      new MessagesPlaceholder("agent_scratchpad"),
    ]);

    const agent = await createStructuredChatAgent({
      llm: chatModel,
      tools,
      prompt,
    });

    this.executor = new AgentExecutor({
      agent,
      tools,
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
    if (!this.executor) {
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

    const promptTokens = countMessageTokens(this.model, this.messages);
    this.sessionTracker?.trackPromptTokens(promptTokens);
    this.sessionTracker?.trackContextUsage(promptTokens);
    this.warnIfContextHigh(promptTokens);

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
        spinner: "dots",
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

    try {
      const result = await this.withTimeout(
        this.executor.invoke(
          {
            input: userMessage,
            history: historyMessages,
          },
          {
            callbacks: [callbackManager],
          }
        ),
        this.chatTimeout,
        "LangChain agent"
      );

      const response =
        typeof result === "object" && result !== null && "output" in result
          ? String((result as any).output)
          : "";

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
        const tokenUsage = this.sessionTracker.getTokenUsage();
        const costUsage = this.sessionTracker.getCostUsage();
        const summary =
          costUsage.total > 0
            ? `Tokens: ${promptTokens.toLocaleString()} in + ${completionTokens.toLocaleString()} out | Cost: ${costUsage.formatted.total} (session total)`
            : `Tokens: ${promptTokens.toLocaleString()} in + ${completionTokens.toLocaleString()} out`;
        if (timeline) {
          timeline.note(`💰 ${summary}`);
        } else {
          console.log(chalk.dim(`\n💰 ${summary}`));
        }
      }

      return response;
    } catch (error) {
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
