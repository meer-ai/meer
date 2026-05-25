import { randomUUID } from "crypto";
import type { Provider, ChatMessage } from "../providers/base.js";
import { ProviderWrapper } from "../providers/provider-wrapper.js";
import { memory } from "../memory/index.js";
import { MCPManager } from "../mcp/manager.js";
import type { MCPTool } from "../mcp/types.js";
import type { SessionTracker } from "../session/tracker.js";
import { buildNativeSystemPrompt } from "./prompts/nativeSystemPrompt.js";
import { createMeerAgentTools } from "./tools/agent.js";
import type { AgentTool } from "./core/types.js";
import { runLoop } from "./core/loop.js";
import type { AgentEvent } from "./core/types.js";
import type { AgentMessage as CoreAgentMessage } from "./core/types.js";
import { generateDiff, type FileEdit } from "../tools/index.js";

// Re-export the config type so cli.ts can use it
export interface MeerAgentConfig {
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
  onCotMessage?: (content: string) => void;
  onTurnStart?: () => void;
  onTurnEnd?: (result?: { success: boolean; error?: string }) => void;
  onIterationChange?: (current: number, max: number) => void;
  onWorkflowStageStart?: (name: string) => void;
  onWorkflowStageComplete?: (name: string) => void;
  onWorkflowStageFail?: (name: string) => void;
  onToolStart?: (tool: string, args: unknown) => void;
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

export interface MeerAgentInitOptions {
  contextPrompt?: string;
  priorMessages?: ChatMessage[];
}

export class MeerAgent {
  private config: MeerAgentConfig;
  private provider: Provider;
  private cwd: string;
  private mcpManager = MCPManager.getInstance();
  private mcpTools: MCPTool[] = [];
  private conversationHistory: CoreAgentMessage[] = [];
  private abortController: AbortController | null = null;
  private isRunning = false;
  private enableMemory: boolean;
  private providerType: string;
  private model: string;
  private editedFiles = new Set<string>();
  private currentTurnId: string | null = null;

  constructor(config: MeerAgentConfig) {
    this.config = config;
    this.provider = new ProviderWrapper(config.provider, {
      name: config.providerType ?? "Provider",
    });
    this.cwd = config.cwd;
    this.enableMemory = config.enableMemory ?? true;
    this.providerType = config.providerType ?? "unknown";
    this.model = config.model ?? "unknown";
  }

  async initialize(
    options?: string | MeerAgentInitOptions
  ): Promise<void> {
    const normalized =
      typeof options === "string" ? { contextPrompt: options } : options ?? {};

    if (!this.mcpManager.isInitialized()) {
      await this.mcpManager.initialize();
    }
    this.mcpTools = this.mcpManager.listAllTools();

    this.conversationHistory = [];

    if (normalized.contextPrompt?.trim()) {
      this.conversationHistory.push({
        role: "user",
        content: `[Context from previous sessions]\n${normalized.contextPrompt}`,
        timestamp: Date.now(),
      });
    }

    if (normalized.priorMessages?.length) {
      for (const msg of normalized.priorMessages) {
        if (msg.role === "user" || msg.role === "assistant" || msg.role === "system") {
          this.conversationHistory.push({
            role: msg.role,
            content: msg.content,
            timestamp: Date.now(),
          });
        }
      }
    }
  }

  async processMessage(userMessage: string): Promise<string> {
    if (this.isRunning) {
      throw new Error("Agent is already running");
    }

    this.isRunning = true;
    this.currentTurnId = randomUUID();
    this.abortController = new AbortController();

    this.config.onTurnStart?.();
    this.config.onStatusChange?.("Thinking…");

    if (this.enableMemory) {
      memory.addToSession({
        timestamp: Date.now(),
        role: "user",
        content: userMessage,
      });
    }

    const userMsg: CoreAgentMessage = {
      role: "user",
      content: userMessage,
      timestamp: Date.now(),
    };

    const inputMessages: CoreAgentMessage[] = [
      ...this.conversationHistory,
      userMsg,
    ];

    let finalAssistantText = "";
    let streamStarted = false;
    let turnCount = 0;
    let loopError: Error | null = null;

    const agentTools = this.buildAgentTools();

    const systemPrompt = buildNativeSystemPrompt({
      cwd: this.cwd,
      mcpTools: this.mcpTools,
    });

    const emit = async (event: AgentEvent): Promise<void> => {
      switch (event.type) {
        case "text_delta":
          if (!streamStarted) {
            streamStarted = true;
            this.config.onStreamingStart?.();
          }
          finalAssistantText += event.text;
          this.config.onStreamingChunk?.(event.text);
          break;

        case "turn_start":
          turnCount++;
          this.config.onIterationChange?.(
            turnCount,
            this.config.maxIterations ?? 50
          );
          if (turnCount > 1) {
            // Settle inter-turn text as CoT (reasoning shown before tool calls)
            if (streamStarted) {
              this.config.onStreamingEnd?.();
              if (finalAssistantText) {
                this.config.onCotMessage?.(finalAssistantText);
              }
              streamStarted = false;
              finalAssistantText = "";
            }
          }
          break;

        case "turn_end":
          break;

        case "tool_start":
          this.config.onStatusChange?.(`Running ${event.toolName}…`);
          this.config.onToolStart?.(event.toolName, event.args);
          this.config.onToolUpdate?.(event.toolName, "running");
          break;

        case "tool_update":
          break;

        case "tool_end": {
          const preview = previewContent(event.result.content);
          this.config.onToolUpdate?.(
            event.toolName,
            event.isError ? "failed" : "succeeded",
            preview
          );
          const transcriptResult = formatToolTranscript(
            event.toolName,
            event.result.content
          );
          this.config.onToolMessage?.(event.toolName, transcriptResult, {
            toolCallId: event.toolCallId,
            isError: event.isError,
          });
          if (this.enableMemory) {
            memory.addToSession({
              timestamp: Date.now(),
              role: "tool",
              content: transcriptResult,
              metadata: {
                toolName: event.toolName,
                isError: event.isError,
                toolCallId: event.toolCallId,
                turnId: this.currentTurnId ?? undefined,
              },
            });
          }
          break;
        }

        case "error":
          loopError = event.error;
          this.config.onStatusChange?.("");
          if (streamStarted) {
            this.config.onStreamingEnd?.();
            streamStarted = false;
          }
          break;

        case "aborted":
          this.config.onStatusChange?.("");
          if (streamStarted) {
            this.config.onStreamingEnd?.();
            streamStarted = false;
          }
          break;

        case "agent_end":
          break;
      }
    };

    try {
      const newMessages = await runLoop(
        inputMessages,
        agentTools,
        this.provider,
        {
          systemPrompt,
          maxTurns: this.config.maxIterations ?? 50,
        },
        emit,
        this.abortController.signal
      );

      // Settle any final streaming message
      if (streamStarted) {
        this.config.onStreamingEnd?.();
        streamStarted = false;
      }

      // Surface provider errors that were swallowed inside the loop
      if (loopError && !finalAssistantText) {
        throw loopError;
      }

      // Detect if we hit the iteration limit without a final LLM response
      const hadToolCalls = newMessages.some((m) => m.role === "tool_result");
      const lastMsg = newMessages[newMessages.length - 1];
      if (!finalAssistantText && lastMsg?.role === "tool_result") {
        const limit = this.config.maxIterations ?? 50;
        finalAssistantText = `Reached the maximum of ${limit} iterations. The task may be incomplete — send a follow-up message to continue.`;
        this.config.onStreamingStart?.();
        this.config.onStreamingChunk?.(finalAssistantText);
        this.config.onStreamingEnd?.();
        streamStarted = false;
      }

      // Don't emit a fake "Done." — if tool blocks were shown the work is visible;
      // if nothing happened the model gave a genuinely empty response.
      if (!finalAssistantText && !hadToolCalls) {
        finalAssistantText = "(No response — the model returned empty content. Try rephrasing your request.)";
        this.config.onStreamingStart?.();
        this.config.onStreamingChunk?.(finalAssistantText);
        this.config.onStreamingEnd?.();
      }

      if (finalAssistantText) {
        this.config.onAssistantMessage?.(finalAssistantText);
      }
      this.saveAssistantToMemory(finalAssistantText);

      // Update conversation history with new messages
      this.conversationHistory = [...inputMessages, ...newMessages];
      // Keep only the last 48 messages to avoid context explosion
      if (this.conversationHistory.length > 48) {
        this.conversationHistory = this.conversationHistory.slice(
          this.conversationHistory.length - 48
        );
      }

      this.config.onToolEnd?.();
      this.config.onStatusChange?.("");
      this.config.onTurnEnd?.({ success: true });

      return finalAssistantText;
    } catch (error) {
      if (streamStarted) {
        this.config.onStreamingEnd?.();
      }
      this.config.onStatusChange?.("");
      const message = error instanceof Error ? error.message : String(error);
      this.config.onTurnEnd?.({ success: false, error: message });
      this.config.onError?.(error as Error);
      throw error;
    } finally {
      this.isRunning = false;
      this.abortController = null;
      this.currentTurnId = null;
    }
  }

  abort(): void {
    this.abortController?.abort();
    this.isRunning = false;
  }

  private saveAssistantToMemory(content: string): void {
    if (!this.enableMemory || !content.trim()) return;
    memory.addToSession({
      timestamp: Date.now(),
      role: "assistant",
      content,
      metadata: {
        provider: this.providerType,
        model: this.model,
        turnId: this.currentTurnId ?? undefined,
      },
    });
  }

  private async reviewFileEdit(edit: FileEdit): Promise<boolean> {
    if (!this.config.promptChoice) return false;

    const diff = generateDiff(edit.oldContent, edit.newContent);
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

  private async confirmCommand(command: string): Promise<boolean> {
    const cmd = command.trim();

    // Block unambiguously destructive patterns regardless of anything else
    const blockedPatterns = [
      /rm\s+-[a-z]*r[a-z]*f|rm\s+-[a-z]*f[a-z]*r/i,    // rm -rf / rm -fr
      /\bformat\s+(c:|\/dev\/)/i,
      /\bmkfs\b/i,
      /\bdd\s+if=.*of=\/dev\//i,
      /\bshutdown\b|\breboot\b|\binit\s+0\b/i,
      /\bsudo\s+rm\b/i,
      /\bdel\s+\/[sf]/i,
      /\brd\s+\/s/i,
    ];
    if (blockedPatterns.some((p) => p.test(cmd))) {
      return false;
    }

    // Auto-approve read-only and common dev-workflow commands
    const safePatterns = [
      // git — all read operations
      /^git\s+(status|diff|log|branch|show|describe|rev-parse|shortlog|tag|ls-files|ls-remote|blame|stash list|remote|fetch\s+--dry-run|config\s+--list|reflog|cherry|check-ignore)/i,
      // npm — build, test, info, audit, listing
      /^npm\s+(run|test|build|install|i|ci|audit|ls|list|outdated|info|view|pack|version|help|fund|ping|prefix|bin)(\s|$)/i,
      // yarn — build, test, info, audit
      /^yarn(\s+(run|test|build|install|audit|list|outdated|info|versions|check|help|why|licenses|bin|config))?(\s|$)/i,
      // pnpm — build, test, info, audit
      /^pnpm\s+(run|test|build|install|audit|list|ls|outdated|info|why|licenses)(\s|$)/i,
      // npx for common read/check tools
      /^npx\s+(tsc|eslint|prettier|jest|vitest|mocha|ts-node|tsx|vite build|next build|nuxt build|rollup|esbuild|swc|turbo)(\s|$)/i,
      // runtime version / help queries
      /^(node|npm|npx|yarn|pnpm|bun|deno|go|python3?|ruby|java|rustc|cargo)\s+(--version|-v|--help|-h|version)(\s|$)/i,
      // OS read-only
      /^(ls|dir|cat|head|tail|grep|rg|find|fd|bat|less|more|type)\s/i,
      /^(ls|dir|pwd|echo|printf|env|whoami|hostname|uname|date|which|where|type)(\s|$)/i,
      // package.json scripts via node/bun
      /^(node|bun)\s+--?\w/i,
    ];

    if (safePatterns.some((p) => p.test(cmd))) return true;

    if (!this.config.promptChoice) {
      // No TUI prompt available — auto-approve non-destructive commands
      return true;
    }

    const choice = await this.config.promptChoice(
      `**Run shell command:**\n\`\`\`\n${command}\n\`\`\``,
      [
        { label: "Run", value: "run" },
        { label: "Cancel", value: "cancel" },
      ],
      "run"
    );

    return choice === "run";
  }

  private buildAgentTools(): AgentTool[] {
    const legacyTools = createMeerAgentTools(
      {
        cwd: this.cwd,
        provider: this.config.provider,
        reviewFileEdit: (edit) => this.reviewFileEdit(edit),
        executeMcpTool: async (toolName, input) => {
          const result = await this.mcpManager.executeTool(toolName, input);
          if (!result.success) {
            throw new Error(result.error ?? `Failed to execute MCP tool ${toolName}`);
          }
          return result.content
            .map((entry) => ("text" in entry ? entry.text : JSON.stringify(entry)))
            .join("\n") || "Tool completed.";
        },
        confirmCommand: (command) => this.confirmCommand(command),
      },
      { mcpTools: this.mcpTools }
    );

    return legacyTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as AgentTool["inputSchema"],
      async execute(_toolCallId, input, _signal, _onUpdate) {
        try {
          const content = await tool.call(input);
          return { content: String(content), isError: false };
        } catch (err) {
          return {
            content: err instanceof Error ? err.message : String(err),
            isError: true,
          };
        }
      },
    }));
  }
}

function previewContent(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function formatToolTranscript(toolName: string, result: string): string {
  const normalized = result.trim();
  if (!normalized) return `Tool: ${toolName}\nResult: (empty)`;

  if (["read_file", "list_files", "read_folder", "read_many_files"].includes(toolName)) {
    const lines = normalized.split("\n");
    if (normalized.length > 4000 || lines.length > 120) {
      const previewLines = lines.slice(0, 80).join("\n");
      const omittedLines = Math.max(0, lines.length - 80);
      return [
        `Tool: ${toolName}`,
        `Result (truncated - ${normalized.length} chars, ${lines.length} lines):`,
        previewLines,
        "",
        `[... ${omittedLines} more lines omitted. Read narrower sections if needed]`,
      ].join("\n");
    }
  }

  return `Tool: ${toolName}\nResult:\n${normalized}`;
}
