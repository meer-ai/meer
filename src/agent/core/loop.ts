import { randomUUID } from "crypto";
import type { Provider, ToolDefinition } from "../../providers/base.js";
import type {
  AgentMessage,
  AgentTool,
  AgentEvent,
  AgentEventSink,
  ToolResult,
} from "./types.js";

export interface LoopConfig {
  systemPrompt: string;
  maxTurns?: number;
  maxRepeatedToolBatches?: number;
  maxRepeatedToolResults?: number;
  getSteeringMessages?: () => Promise<AgentMessage[]>;
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

  const systemMsg: AgentMessage = {
    role: "system",
    content: config.systemPrompt,
    timestamp: Date.now(),
  };

  const messages: AgentMessage[] = [systemMsg, ...initialMessages];
  const toolDefs = buildToolDefinitions(tools);
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const maxTurns = config.maxTurns ?? 50;
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

  try {
    while (turns < maxTurns) {
      if (signal?.aborted) {
        await emit({ type: "aborted" });
        break;
      }

      if (pendingMessages.length > 0) {
        messages.push(...pendingMessages);
        newMessages.push(...pendingMessages);
        pendingMessages = [];
        lastToolBatchSignature = null;
        repeatedToolBatchCount = 0;
        lastToolResultSignature = null;
        repeatedToolResultCount = 0;
      }

      turns++;
      await emit({ type: "turn_start" });

      let assistantText = "";
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
          } else if (event.type === "tool-call") {
            pendingToolCalls.push(event.toolCall);
          } else if (event.type === "done") {
            if (event.turn?.toolCalls?.length && pendingToolCalls.length === 0) {
              pendingToolCalls.push(...event.turn.toolCalls);
            }
            // Prefer the turn's assistantMessage if available
            if (event.turn?.assistantMessage && !assistantText) {
              assistantText = event.turn.assistantMessage;
            }
            // rawText is the authoritative accumulated text from the provider;
            // use it if the delta loop somehow missed content
            if (event.rawText && event.rawText !== assistantText && !event.turn?.assistantMessage) {
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
          break;
        }
        const error = err instanceof Error ? err : new Error(String(err));
        await emit({ type: "error", error });
        await emit({ type: "turn_end" });
        break;
      }

      // Record the assistant message
      const assistantMsg: AgentMessage = {
        role: "assistant",
        content: assistantText,
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

      await emit({ type: "turn_end" });

      if (pendingToolCalls.length === 0) {
        lastToolBatchSignature = null;
        repeatedToolBatchCount = 0;
        lastToolResultSignature = null;
        repeatedToolResultCount = 0;
        break;
      }

      const currentToolBatchSignature = toolBatchSignature(pendingToolCalls);
      if (currentToolBatchSignature === lastToolBatchSignature) {
        repeatedToolBatchCount += 1;
      } else {
        lastToolBatchSignature = currentToolBatchSignature;
        repeatedToolBatchCount = 1;
      }

      if (repeatedToolBatchCount >= maxRepeatedToolBatches) {
        const guardMessage =
          "I’m repeating the same tool calls without making progress, so I’m stopping here. Review the latest tool results and send a narrower follow-up if you want me to continue.";
        const guardAssistantMessage: AgentMessage = {
          role: "assistant",
          content: guardMessage,
          timestamp: Date.now(),
        };
        messages.push(guardAssistantMessage);
        newMessages.push(guardAssistantMessage);
        break;
      }

      // Execute tool calls
      const toolResults: AgentMessage[] = [];
      let shouldTerminate = false;

      for (const tc of pendingToolCalls) {
        if (signal?.aborted) break;

        const tool = toolMap.get(tc.name);

        // Approval check
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
          timestamp: Date.now(),
        };
        toolResults.push(resultMsg);
        newMessages.push(resultMsg);

        if (result.terminate) {
          shouldTerminate = true;
          break;
        }
      }

      messages.push(...toolResults);

      const currentToolResultSignature = toolBatchSignature(
        toolResults.map((result) => {
          const toolResult = result as Extract<AgentMessage, { role: "tool_result" }>;
          return {
            name: toolResult.toolName,
            input: {
              content: toolResult.content,
              isError: toolResult.isError ?? false,
            },
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
        const guardMessage =
          "I’m getting the same tool results repeatedly without making progress, so I’m stopping here. Review the latest results and send a narrower follow-up if you want me to continue.";
        const guardAssistantMessage: AgentMessage = {
          role: "assistant",
          content: guardMessage,
          timestamp: Date.now(),
        };
        messages.push(guardAssistantMessage);
        newMessages.push(guardAssistantMessage);
        break;
      }

      if (shouldTerminate || signal?.aborted) {
        if (signal?.aborted) {
          await emit({ type: "aborted" });
        }
        break;
      }

      pendingMessages = (await config.getSteeringMessages?.()) ?? [];
    }
  } finally {
    await emit({ type: "agent_end", messages: newMessages });
  }

  return newMessages;
}
