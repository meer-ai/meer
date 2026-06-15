import type { Provider, ToolDefinition } from "../../providers/base.js";
import type {
  AgentMessage,
  AgentTool,
  AgentEventSink,
  ToolResult,
} from "./types.js";

export interface LoopConfig {
  systemPrompt: string;
  maxTurns?: number;
  maxRepeatedToolBatches?: number;
  maxRepeatedToolResults?: number;
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  getFollowUpMessages?: () => Promise<AgentMessage[]>;
  beforeToolCall?: (
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<{ block: boolean; reason?: string } | undefined>;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b)
    );
    return `{${entries
      .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function toolBatchSignature(
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>
): string {
  return stableStringify(
    toolCalls.map((toolCall) => ({
      name: toolCall.name,
      input: toolCall.input,
    }))
  );
}

function buildToolDefinitions(tools: AgentTool[]): ToolDefinition[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

async function executeToolCall(
  tool: AgentTool,
  toolCallId: string,
  input: Record<string, unknown>,
  emit: AgentEventSink,
  signal?: AbortSignal
): Promise<ToolResult> {
  return tool.execute(
    toolCallId,
    input,
    signal,
    async (partial) => {
      await emit({ type: "tool_update", toolCallId, toolName: tool.name, partial });
    }
  );
}

export async function runLoop(
  initialMessages: AgentMessage[],
  tools: AgentTool[],
  provider: Provider,
  config: LoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal
): Promise<AgentMessage[]> {
  await emit({ type: "agent_start" });

  const messages: AgentMessage[] = [
    {
      role: "system",
      content: config.systemPrompt,
      timestamp: Date.now(),
    },
    ...initialMessages,
  ];

  const toolDefs = buildToolDefinitions(tools);
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const maxTurns =
    typeof config.maxTurns === "number" && config.maxTurns > 0
      ? config.maxTurns
      : undefined;
  const maxRepeatedToolBatches = config.maxRepeatedToolBatches ?? 3;
  const maxRepeatedToolResults = config.maxRepeatedToolResults ?? 2;

  let turns = 0;
  let newMessages: AgentMessage[] = [];
  let lastToolBatchSignature: string | null = null;
  let repeatedToolBatchCount = 0;
  let lastToolResultSignature: string | null = null;
  let repeatedToolResultCount = 0;
  let pendingMessages: AgentMessage[] =
    (await config.getSteeringMessages?.()) ?? [];

  const resetRepeatGuards = () => {
    lastToolBatchSignature = null;
    repeatedToolBatchCount = 0;
    lastToolResultSignature = null;
    repeatedToolResultCount = 0;
  };

  try {
    const canStartAnotherTurn = () => maxTurns === undefined || turns < maxTurns;

    while (canStartAnotherTurn()) {
      let hasMoreToolCalls = true;

      while ((hasMoreToolCalls || pendingMessages.length > 0) && canStartAnotherTurn()) {
        if (signal?.aborted) {
          await emit({ type: "aborted" });
          return newMessages;
        }

        if (pendingMessages.length > 0) {
          messages.push(...pendingMessages);
          newMessages.push(...pendingMessages);
          pendingMessages = [];
          resetRepeatGuards();
        }

        turns++;
        await emit({ type: "turn_start" });

        let assistantText = "";
        let assistantReasoningContent: string | undefined;
        const pendingToolCalls: Array<{
          id: string;
          name: string;
          input: Record<string, unknown>;
        }> = [];

        try {
          const streamWithTools =
            provider.streamWithTools?.bind(provider) ??
            (provider as any).streamWithTools;

          if (!streamWithTools) {
            throw new Error(
              "Provider does not support streamWithTools. Use a provider with native tool calling (Anthropic, OpenAI) or the ProviderWrapper."
            );
          }

          for await (const event of streamWithTools(messages, toolDefs, signal)) {
            if (signal?.aborted) break;

            if (event.type === "text-delta") {
              assistantText += event.text;
              await emit({ type: "text_delta", text: event.text });
            } else if (event.type === "assistant-message") {
              assistantText = event.text;
            } else if (event.type === "tool-call-delta") {
              await emit({
                type: "tool_call_delta",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                inputTextDelta: event.inputTextDelta,
              });
            } else if (event.type === "tool-call") {
              pendingToolCalls.push(event.toolCall);
            } else if (event.type === "done") {
              if (event.usage) {
                await emit({
                  type: "usage",
                  promptTokens: event.usage.promptTokens,
                  completionTokens: event.usage.completionTokens,
                });
              }
              if (event.turn?.toolCalls?.length && pendingToolCalls.length === 0) {
                pendingToolCalls.push(...event.turn.toolCalls);
              }
              if (event.turn?.assistantMessage && !assistantText) {
                assistantText = event.turn.assistantMessage;
              }
              if (event.turn?.reasoningContent) {
                assistantReasoningContent = event.turn.reasoningContent;
              } else if (event.reasoningContent) {
                assistantReasoningContent = event.reasoningContent;
              }
              if (
                event.rawText &&
                event.rawText !== assistantText &&
                !event.turn?.assistantMessage
              ) {
                const missed = event.rawText.slice(assistantText.length);
                if (missed) {
                  assistantText = event.rawText;
                  await emit({ type: "text_delta", text: missed });
                }
              }
            }
          }
        } catch (err) {
          if (signal?.aborted) {
            await emit({ type: "aborted" });
            return newMessages;
          }
          const error = err instanceof Error ? err : new Error(String(err));
          await emit({ type: "error", error });
          await emit({ type: "turn_end" });
          return newMessages;
        }

        // Surface reasoning-model thinking to the UI (capped at render time).
        if (assistantReasoningContent && assistantReasoningContent.trim()) {
          await emit({ type: "reasoning", content: assistantReasoningContent });
        }

        const assistantMsg: AgentMessage = {
          role: "assistant",
          content: assistantText,
          reasoningContent: assistantReasoningContent,
          toolCalls: pendingToolCalls.length
            ? pendingToolCalls.map((tc) => ({
                id: tc.id,
                name: tc.name,
                input: tc.input,
              }))
            : undefined,
          timestamp: Date.now(),
        };
        messages.push(assistantMsg);
        newMessages.push(assistantMsg);

        if (pendingToolCalls.length === 0) {
          hasMoreToolCalls = false;
          resetRepeatGuards();
          await emit({ type: "turn_end" });
          pendingMessages = (await config.getSteeringMessages?.()) ?? [];
          continue;
        }

        const currentToolBatchSignature = toolBatchSignature(pendingToolCalls);
        if (currentToolBatchSignature === lastToolBatchSignature) {
          repeatedToolBatchCount += 1;
        } else {
          lastToolBatchSignature = currentToolBatchSignature;
          repeatedToolBatchCount = 1;
        }

        if (repeatedToolBatchCount >= maxRepeatedToolBatches) {
          const guardAssistantMessage: AgentMessage = {
            role: "assistant",
            content:
              "I’m repeating the same tool calls without making progress, so I’m stopping here. Review the latest tool results and send a narrower follow-up if you want me to continue.",
            timestamp: Date.now(),
          };
          messages.push(guardAssistantMessage);
          newMessages.push(guardAssistantMessage);
          await emit({ type: "turn_end" });
          hasMoreToolCalls = false;
          break;
        }

        const toolResults: AgentMessage[] = [];
        let shouldTerminate = false;

        for (const tc of pendingToolCalls) {
          if (signal?.aborted) {
            break;
          }

          const tool = toolMap.get(tc.name);

          if (tool?.requiresApproval) {
            const needsApproval =
              typeof tool.requiresApproval === "function"
                ? await tool.requiresApproval(tc.input)
                : tool.requiresApproval;

            if (needsApproval && config.beforeToolCall) {
              const decision = await config.beforeToolCall(tc.name, tc.input, signal);
              if (decision?.block) {
                const blockedResult: AgentMessage = {
                  role: "tool_result",
                  toolCallId: tc.id,
                  toolName: tc.name,
                  content: decision.reason ?? "Tool execution was blocked by user.",
                  isError: true,
                  details: undefined,
                  timestamp: Date.now(),
                };
                toolResults.push(blockedResult);
                await emit({
                  type: "tool_end",
                  toolCallId: tc.id,
                  toolName: tc.name,
                  result: { content: blockedResult.content, isError: true },
                  isError: true,
                });
                continue;
              }
            }
          }

          await emit({
            type: "tool_start",
            toolCallId: tc.id,
            toolName: tc.name,
            args: tc.input,
          });

          const toolStartedAt = Date.now();
          let result: ToolResult;
          if (!tool) {
            result = {
              content: `Tool "${tc.name}" not found.`,
              isError: true,
            };
          } else {
            try {
              result = await executeToolCall(tool, tc.id, tc.input, emit, signal);
            } catch (err) {
              result = {
                content: err instanceof Error ? err.message : String(err),
                isError: true,
              };
            }
          }
          const durationMs = Date.now() - toolStartedAt;

          // Surface the duration in result.details so renderers can pick
          // between compact (sub-second) and full widget layouts without
          // needing a separate event-bus channel. Most tools don't set
          // their own durationMs; the ones that do (run_command) override
          // this with a more precise measurement of just the child
          // process, which is what we want anyway.
          if (!result.details || typeof (result.details as Record<string, unknown>).durationMs !== "number") {
            result.details = {
              ...(result.details ?? {}),
              durationMs,
            };
          }

          await emit({
            type: "tool_end",
            toolCallId: tc.id,
            toolName: tc.name,
            result,
            isError: result.isError ?? false,
          });

          const resultMsg: AgentMessage = {
            role: "tool_result",
            toolCallId: tc.id,
            toolName: tc.name,
            content: result.content,
            isError: result.isError,
            details: result.details,
            timestamp: Date.now(),
          };
          toolResults.push(resultMsg);
          messages.push(resultMsg);
          newMessages.push(resultMsg);

          if (result.terminate) {
            shouldTerminate = true;
            break;
          }
        }

        const currentToolResultSignature = stableStringify(
          toolResults.map((result) => {
            const toolResult = result as Extract<AgentMessage, { role: "tool_result" }>;
            return {
              toolName: toolResult.toolName,
              content: toolResult.content,
              isError: toolResult.isError ?? false,
            };
          })
        );

        if (currentToolResultSignature === lastToolResultSignature) {
          repeatedToolResultCount += 1;
        } else {
          lastToolResultSignature = currentToolResultSignature;
          repeatedToolResultCount = 1;
        }

        if (repeatedToolResultCount >= maxRepeatedToolResults) {
          const guardAssistantMessage: AgentMessage = {
            role: "assistant",
            content:
              "I’m getting the same tool results repeatedly without making progress, so I’m stopping here. Review the latest results and send a narrower follow-up if you want me to continue.",
            timestamp: Date.now(),
          };
          messages.push(guardAssistantMessage);
          newMessages.push(guardAssistantMessage);
          await emit({ type: "turn_end" });
          hasMoreToolCalls = false;
          break;
        }

        await emit({ type: "turn_end" });

        if (shouldTerminate || signal?.aborted) {
          if (signal?.aborted) {
            await emit({ type: "aborted" });
          }
          hasMoreToolCalls = false;
          break;
        }

        hasMoreToolCalls = true;
        pendingMessages = (await config.getSteeringMessages?.()) ?? [];
      }

      const followUpMessages = (await config.getFollowUpMessages?.()) ?? [];
      if (followUpMessages.length > 0) {
        pendingMessages = followUpMessages;
        resetRepeatGuards();
        continue;
      }

      break;
    }
  } finally {
    await emit({ type: "agent_end", messages: newMessages });
  }

  return newMessages;
}
