import chalk from "chalk";
import ora, { type Ora } from "ora";
import inquirer from "inquirer";
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
import type { MCPTool } from "../mcp/types.js";
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

    const tools = createMeerLangChainTools({
      cwd: this.cwd,
      reviewFileEdit: async (edit) => this.reviewFileEdit(edit),
    });

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

    if (timeline) {
      thinkingTaskId = timeline.startTask("Thinking", {
        detail: `${this.providerType}:${this.model}`,
      });
    } else if (!useUI) {
      spinner = ora({
        text: chalk.blue("Thinking..."),
        spinner: "dots",
      }).start();
    } else {
      onAssistantStart?.();
    }

    try {
      const result = await this.withTimeout(
        this.executor.invoke({
          input: userMessage,
          history: historyMessages,
        }),
        this.chatTimeout,
        "LangChain agent"
      );

      const response =
        typeof result === "object" && result !== null && "output" in result
          ? String((result as any).output)
          : "";

      if (timeline && thinkingTaskId) {
        timeline.succeed(thinkingTaskId, "Response ready");
      } else if (spinner) {
        spinner.stop();
      }

      if (!useUI) {
        console.log(chalk.green("\n🤖 MeerAI (LangChain):\n"));
        console.log(response);
      } else {
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
      if (spinner) {
        spinner.stop();
      }
      if (timeline && thinkingTaskId) {
        timeline.fail(
          thinkingTaskId,
          error instanceof Error ? error.message : String(error)
        );
      }
      throw error;
    }
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
