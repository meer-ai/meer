import { randomUUID } from "crypto";
import type { Provider, ChatMessage } from "../providers/base.js";
import { memory } from "../memory/index.js";
import { MCPManager } from "../mcp/manager.js";
import type { MCPTool } from "../mcp/types.js";
import type { SessionTracker } from "../session/tracker.js";
import { buildAgentSystemPrompt } from "./prompts/agentSystemPrompt.js";
import { ProviderChatModel } from "./runtime/providerChatModel.js";
import { ManualAgent } from "./runtime/manualAgent.js";
import { createMeerAgentTools } from "./tools/agent.js";
import { ContextPreprocessor } from "./context-preprocessor.js";
import { TransactionManager } from "./transaction-manager.js";
import { TestDetector } from "./test-detector.js";
import { generateDiff, type FileEdit } from "../tools/index.js";
import type { AgentTool } from "./runtime/types.js";

export interface StructuredAgentConfig {
  provider: Provider;
  cwd: string;
  maxIterations?: number;
  enableMemory?: boolean;
  autoCollectContext?: boolean;
  providerType?: string;
  model?: string;
  sessionTracker?: SessionTracker;
  onStreamingStart?: () => void;
  onStreamingChunk?: (chunk: string) => void;
  onStreamingEnd?: () => void;
  onAssistantMessage?: (content: string) => void;
  onTurnStart?: () => void;
  onTurnEnd?: (result: { success: boolean; error?: string }) => void;
  onIterationChange?: (current: number, max: number) => void;
  onWorkflowStageStart?: (name: string) => void;
  onWorkflowStageComplete?: (name: string) => void;
  onWorkflowStageFail?: (name: string) => void;
  onToolStart?: (tool: string, args: any) => void;
  onToolUpdate?: (tool: string, status: string, result?: string) => void;
  onToolMessage?: (
    tool: string,
    result: string,
    metadata?: { toolCallId?: string; isError?: boolean }
  ) => void;
  onToolEnd?: () => void;
  onStatusChange?: (status: string) => void;
  onError?: (error: Error) => void;
  promptChoice?: (
    message: string,
    choices: Array<{ label: string; value: string }>,
    defaultChoice?: string
  ) => Promise<string>;
}

export interface StructuredWorkflowInitializationOptions {
  contextPrompt?: string;
  priorMessages?: ChatMessage[];
}

export class StructuredAgentWorkflow {
  private provider: Provider;
  private cwd: string;
  private maxIterations: number;
  private enableMemory: boolean;
  private autoCollectContext: boolean;
  private providerType: string;
  private model: string;
  private sessionTracker?: SessionTracker;
  private mcpManager = MCPManager.getInstance();
  private mcpTools: MCPTool[] = [];
  private history: ChatMessage[] = [];
  private isRunning = false;
  private currentOutput = "";
  private streamStarted = false;
  private currentTurnId: string | null = null;
  private currentStageName: string | null = null;
  private lastAssistantMessageThisTurn: string | null = null;
  private config: StructuredAgentConfig;
  private contextPreprocessor: ContextPreprocessor;
  private transactionManager: TransactionManager;
  private testDetector: TestDetector;
  private editedFiles = new Set<string>();

  constructor(config: StructuredAgentConfig) {
    this.provider = config.provider;
    this.cwd = config.cwd;
    this.maxIterations = config.maxIterations ?? 10;
    this.enableMemory = config.enableMemory ?? true;
    this.autoCollectContext = config.autoCollectContext ?? false;
    this.providerType = config.providerType ?? "unknown";
    this.model = config.model ?? "unknown";
    this.sessionTracker = config.sessionTracker;
    this.config = config;
    this.contextPreprocessor = new ContextPreprocessor(this.cwd);
    this.transactionManager = new TransactionManager(this.cwd);
    this.testDetector = new TestDetector(this.cwd);
  }

  async initialize(
    options?: string | StructuredWorkflowInitializationOptions
  ): Promise<void> {
    const normalized =
      typeof options === "string" ? { contextPrompt: options } : options ?? {};

    if (!this.mcpManager.isInitialized()) {
      await this.mcpManager.initialize();
    }
    this.mcpTools = this.mcpManager.listAllTools();

    this.history = [];

    if (normalized.contextPrompt?.trim()) {
      this.history.push({ role: "system", content: normalized.contextPrompt });
    }

    if (normalized.priorMessages?.length) {
      this.history.push(...normalized.priorMessages);
    }
  }

  async processMessage(userMessage: string): Promise<string> {
    if (this.isRunning) {
      throw new Error("Workflow is already running");
    }

    this.isRunning = true;
    this.currentOutput = "";
    this.streamStarted = false;
    this.currentTurnId = randomUUID();
    this.currentStageName = null;
    this.lastAssistantMessageThisTurn = null;
    this.config.onTurnStart?.();

    try {
      this.config.onStatusChange?.("Thinking…");

      const chatHistory = this.history.slice();
      let toolCallsExecuted = 0;

      if (this.autoCollectContext) {
        const relevantFiles = await this.contextPreprocessor.gatherContext(userMessage);
        if (relevantFiles.length > 0) {
          const contextPrompt = this.contextPreprocessor.buildContextPrompt(relevantFiles);
          chatHistory.push({ role: "system", content: contextPrompt });
        }
      }

      if (this.enableMemory) {
        memory.addToSession({
          timestamp: Date.now(),
          role: "user",
          content: userMessage,
        });
      }

      const llm = new ProviderChatModel(this.provider, {
        model: this.model,
        providerType: this.providerType,
      });

      const tools = createMeerAgentTools(
        {
          cwd: this.cwd,
          provider: this.provider,
          reviewFileEdit: async (edit) => this.reviewSingleEdit(edit),
          executeMcpTool: async (toolName, input) => {
            const result = await this.mcpManager.executeTool(toolName, input);
            if (!result.success) {
              throw new Error(result.error || `Failed to execute MCP tool ${toolName}`);
            }
            const text = result.content
              .map((entry) => ("text" in entry ? entry.text : JSON.stringify(entry)))
              .join("\n");
            return text || "Tool completed.";
          },
          confirmCommand: async (command) => this.confirmCommand(command),
        },
        { mcpTools: this.mcpTools }
      );

      const agent = new ManualAgent({
        llm,
        tools,
        systemPrompt: buildAgentSystemPrompt({
          cwd: this.cwd,
          mcpTools: this.mcpTools,
        }),
        maxIterations: this.maxIterations,
        onIterationStart: (current, max) => {
          this.config.onIterationChange?.(current, max);
          const nextStageName =
            current === 1 ? "Iteration 1 · Initial analysis" : `Iteration ${current}`;
          if (this.currentStageName && this.currentStageName !== nextStageName) {
            this.config.onWorkflowStageComplete?.(this.currentStageName);
          }
          if (this.currentStageName !== nextStageName) {
            this.config.onWorkflowStageStart?.(nextStageName);
            this.currentStageName = nextStageName;
          }
        },
        onAssistantChunk: (chunk) => {
          if (!this.streamStarted) {
            this.streamStarted = true;
            this.config.onStreamingStart?.();
          }
          this.currentOutput += chunk;
          this.config.onStreamingChunk?.(chunk);
        },
        onAssistantResponse: () => {},
        onAssistantTurn: (content, metadata) => {
          if (metadata.isFinal || !content.trim()) {
            return;
          }

          const normalized = normalizeAssistantContent(content);
          if (!normalized || normalized === this.lastAssistantMessageThisTurn) {
            return;
          }

          if (this.enableMemory) {
            memory.addToSession({
              timestamp: Date.now(),
              role: "assistant",
              content: normalized,
              metadata: {
                provider: this.providerType,
                model: this.model,
                turnId: this.currentTurnId ?? undefined,
              },
            });
          }

          this.lastAssistantMessageThisTurn = normalized;
          this.config.onAssistantMessage?.(normalized);
        },
        onToolStart: (toolCall) => {
          toolCallsExecuted += 1;
          this.config.onToolStart?.(toolCall.name, toolCall.input);
          this.config.onToolUpdate?.(toolCall.name, "running");
          this.config.onStatusChange?.(`Running ${toolCall.name}…`);
        },
        onToolResult: (toolCall, result, metadata) => {
          const transcriptResult = formatToolTranscript(toolCall.name, result);
          if (this.enableMemory) {
            memory.addToSession({
              timestamp: Date.now(),
              role: "tool",
              content: transcriptResult,
              metadata: {
                toolName: toolCall.name,
                isError: Boolean(metadata?.isError),
                toolCallId: toolCall.id,
                turnId: this.currentTurnId ?? undefined,
              },
            });
          }
          this.config.onToolMessage?.(toolCall.name, transcriptResult, {
            toolCallId: toolCall.id,
            isError: Boolean(metadata?.isError),
          });
          this.config.onToolUpdate?.(
            toolCall.name,
            metadata?.isError ? "failed" : "succeeded",
            previewResult(result)
          );
        },
      });

      const invocation = await agent.invoke({
        input: userMessage,
        chat_history: chatHistory,
      });

      let transcript = invocation.transcript;
      let finalOutput =
        normalizeAssistantContent(invocation.output) ||
        normalizeAssistantContent(this.currentOutput) ||
        "Done.";

      if (
        toolCallsExecuted === 0 &&
        this.shouldBootstrapAction(userMessage, finalOutput)
      ) {
        const bootstrapped = await this.bootstrapToolDrivenTurn(
          agent,
          tools,
          transcript,
          userMessage
        );
        if (bootstrapped) {
          transcript = bootstrapped.transcript;
          finalOutput =
            normalizeAssistantContent(bootstrapped.output) ||
            normalizeAssistantContent(this.currentOutput) ||
            finalOutput;
          toolCallsExecuted += bootstrapped.toolCallsExecuted;
        }
      }

      this.history = transcript;
      if (this.currentStageName) {
        this.config.onWorkflowStageComplete?.(this.currentStageName);
        this.currentStageName = null;
      }

      if (!this.streamStarted) {
        this.config.onStreamingStart?.();
        this.config.onStreamingChunk?.(finalOutput);
      }
      this.config.onStreamingEnd?.();

      if (this.enableMemory) {
        if (finalOutput !== this.lastAssistantMessageThisTurn) {
          memory.addToSession({
            timestamp: Date.now(),
            role: "assistant",
            content: finalOutput,
            metadata: { provider: this.providerType, model: this.model },
          });
        }
      }

      if (finalOutput !== this.lastAssistantMessageThisTurn) {
        this.config.onAssistantMessage?.(finalOutput);
      }
      this.config.onToolEnd?.();
      this.config.onStatusChange?.("");
      this.config.onTurnEnd?.({ success: true });
      return finalOutput;
    } catch (error) {
      if (this.streamStarted) {
        this.config.onStreamingEnd?.();
      }
      if (this.currentStageName) {
        this.config.onWorkflowStageFail?.(this.currentStageName);
        this.currentStageName = null;
      }
      this.config.onStatusChange?.("");
      const message = error instanceof Error ? error.message : String(error);
      this.config.onTurnEnd?.({ success: false, error: message });
      this.config.onError?.(error as Error);
      throw error;
    } finally {
      this.isRunning = false;
      this.streamStarted = false;
      this.currentTurnId = null;
      this.currentStageName = null;
      this.lastAssistantMessageThisTurn = null;
    }
  }

  reset(): void {
    this.history = [];
    this.currentOutput = "";
    this.editedFiles.clear();
  }

  abort(): void {
    this.isRunning = false;
  }

  private async reviewSingleEdit(edit: FileEdit): Promise<boolean> {
    const diff = generateDiff(edit.oldContent, edit.newContent);

    if (this.config.promptChoice) {
      const previewLines = diff.slice(0, 20);
      const more = diff.length > 20 ? `\n… ${diff.length - 20} more lines` : "";
      const diffBlock = previewLines.join("\n") + more;

      const choice = await this.config.promptChoice(
        `**Proposed edit:** \`${edit.path}\`\n${edit.description ?? ""}\n\`\`\`diff\n${diffBlock}\n\`\`\``,
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

      if (choice === "apply") {
        this.editedFiles.add(edit.path);
        return true;
      }

      return false;
    }

    return false;
  }

  private async confirmCommand(command: string): Promise<boolean> {
    const safeCommands = [
      /^npm\s+run\s+(build|test|lint|check|compile|typecheck)$/i,
      /^npm\s+test$/i,
      /^npm\s+run\s+lint$/i,
      /^yarn\s+(build|test|install)?$/i,
      /^pnpm\s+(build|test|install)$/i,
      /^git\s+(status|diff|log|branch)$/i,
      /^npm\s+(install|i)$/i,
    ];

    if (safeCommands.some((pattern) => pattern.test(command.trim()))) {
      return true;
    }

    if (!this.config.promptChoice) {
      return false;
    }

    const choice = await this.config.promptChoice(
      `**Run shell command:**\n\`\`\`\n${command}\n\`\`\``,
      [
        { label: "Run", value: "run" },
        { label: "Cancel", value: "cancel" },
      ],
      "cancel"
    );

    return choice === "run";
  }

  private shouldBootstrapAction(userMessage: string, response: string): boolean {
    const normalizedUser = userMessage.trim().toLowerCase();
    const normalizedResponse = response.trim().toLowerCase();

    if (!normalizedUser || !normalizedResponse) {
      return false;
    }

    const actionablePatterns = [
      /\baudit\b/,
      /\breview\b/,
      /\binspect\b/,
      /\banaly[sz]e\b/,
      /\bscan\b/,
      /\bcheck\b/,
      /\bdebug\b/,
      /\bfix\b/,
      /\binvestigate\b/,
      /\bsecurity\b/,
    ];
    const planningPatterns = [
      /^i(?:'| wi)ll\b/,
      /^let me\b/,
      /^to\b.*\bi(?:'| wi)ll\b/,
      /^i need to\b/,
      /^i'?ll proceed\b/,
      /\bstart by\b/,
      /\bfirst need to gather\b/,
    ];

    return (
      actionablePatterns.some((pattern) => pattern.test(normalizedUser)) &&
      planningPatterns.some((pattern) => pattern.test(normalizedResponse))
    );
  }

  private async bootstrapToolDrivenTurn(
    agent: ManualAgent,
    tools: AgentTool[],
    transcript: ChatMessage[],
    userMessage: string
  ): Promise<{ transcript: ChatMessage[]; output: string; toolCallsExecuted: number } | null> {
    const bootstrapPlan = this.pickBootstrapTools(userMessage);
    if (bootstrapPlan.length === 0) {
      return null;
    }

    const toolOutputs: string[] = [];
    let executed = 0;

    for (const step of bootstrapPlan) {
      const tool = tools.find((candidate) => candidate.name === step.name);
      if (!tool) {
        continue;
      }

      executed += 1;
      this.config.onToolStart?.(step.name, step.input);
      this.config.onToolUpdate?.(step.name, "running");
      this.config.onStatusChange?.(`Running ${step.name}…`);

      let rawResult = "";
      let isError = false;
      try {
        const result = await tool.call(step.input);
        rawResult =
          typeof result === "string" ? result : JSON.stringify(result, null, 2);
      } catch (error) {
        isError = true;
        rawResult = error instanceof Error ? error.message : String(error);
      }

      const transcriptResult = formatToolTranscript(step.name, rawResult);
      if (this.enableMemory) {
        memory.addToSession({
          timestamp: Date.now(),
          role: "tool",
          content: transcriptResult,
          metadata: {
            toolName: step.name,
            isError,
            toolCallId: `bootstrap-${randomUUID()}`,
            turnId: this.currentTurnId ?? undefined,
          },
        });
      }

      this.config.onToolMessage?.(step.name, transcriptResult, { isError });
      this.config.onToolUpdate?.(
        step.name,
        isError ? "failed" : "succeeded",
        previewResult(rawResult)
      );

      toolOutputs.push(transcriptResult);
    }

    if (executed === 0) {
      return null;
    }

    const continuedHistory = transcript.slice();
    continuedHistory.push({
      role: "user",
      content: `Tool Results:\n\n${toolOutputs.join("\n\n")}\n\nContinue the original request using these results. Do not restate that you will begin. Execute the next concrete step or provide actual findings.`,
    });

    const continued = await agent.invoke({
      input:
        "Continue the user's request using the tool results above. Do not stop at planning language.",
      chat_history: continuedHistory,
    });

    return {
      transcript: continued.transcript,
      output: continued.output,
      toolCallsExecuted: executed,
    };
  }

  private pickBootstrapTools(
    userMessage: string
  ): Array<{ name: string; input: Record<string, unknown> }> {
    const normalized = userMessage.toLowerCase();

    if (/\bsecurity\b/.test(normalized) || /\baudit\b/.test(normalized)) {
      return [
        { name: "analyze_project", input: {} },
      ];
    }

    if (
      /\breview\b/.test(normalized) ||
      /\binspect\b/.test(normalized) ||
      /\banaly[sz]e\b/.test(normalized) ||
      /\bdebug\b/.test(normalized) ||
      /\bfix\b/.test(normalized)
    ) {
      return [
        { name: "analyze_project", input: {} },
      ];
    }

    return [];
  }
}

function previewResult(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function normalizeAssistantContent(value: string): string {
  return value
    .replace(/<tool_result>[\s\S]*?<\/tool_result>/g, "")
    .replace(/<\/?tool_result>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatToolTranscript(toolName: string, result: string): string {
  const normalized = result.trim();
  if (!normalized) {
    return `Tool: ${toolName}\nResult: (empty)`;
  }

  if (
    toolName === "read_file" ||
    toolName === "list_files" ||
    toolName === "read_folder" ||
    toolName === "read_many_files"
  ) {
    const lines = normalized.split("\n");
    if (normalized.length > 4000 || lines.length > 120) {
      const previewLines = lines.slice(0, 80).join("\n");
      const omittedLines = Math.max(0, lines.length - 80);
      const omittedChars = Math.max(0, normalized.length - previewLines.length);
      return [
        `Tool: ${toolName}`,
        `Result (truncated - ${normalized.length} chars, ${lines.length} lines):`,
        previewLines,
        "",
        `[... ${omittedLines} more lines omitted (${omittedChars} chars). Read narrower sections if needed]`,
      ].join("\n");
    }
  }

  return `Tool: ${toolName}\nResult:\n${normalized}`;
}
