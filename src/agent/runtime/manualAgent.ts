/**
 * Manual Agentic Loop - Provider-Agnostic Tool Calling
 *
 * This operates on Meer's plain chat messages and provider adapters directly,
 * without any external agent runtime dependency.
 */

import { randomUUID } from "crypto";
import { ProviderChatModel } from "./providerChatModel.js";
import type {
  ChatMessage,
  ProviderEvent,
  ProviderStructuredTurn,
} from "../../providers/base.js";
import { parseStructuredTurn } from "../../providers/structured.js";
import type { AgentTool } from "../runtime/types.js";

export interface ManualAgentConfig {
  llm: ProviderChatModel;
  tools: AgentTool[];
  systemPrompt: string;
  maxIterations?: number;
  verbose?: boolean;
  onAssistantChunk?: (chunk: string) => void;
  onAssistantResponse?: (content: string) => void;
  onAssistantTurn?: (
    content: string,
    metadata: { hasToolCalls: boolean; isFinal: boolean }
  ) => void;
  onIterationStart?: (current: number, max: number) => void;
  onToolStart?: (toolCall: ToolCall) => void;
  onToolResult?: (
    toolCall: ToolCall,
    result: string,
    metadata?: { isError?: boolean }
  ) => void;
}

interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ParsedTurnEnvelope {
  assistantMessage: string;
  toolCalls: ToolCall[];
  finalAnswer?: string;
}

export class ManualAgent {
  private llm: ProviderChatModel;
  private tools: AgentTool[];
  private toolMap: Map<string, AgentTool>;
  private systemPrompt: string;
  private maxIterations: number;
  private verbose: boolean;
  private onAssistantChunk?: (chunk: string) => void;
  private onAssistantResponse?: (content: string) => void;
  private onAssistantTurn?: (
    content: string,
    metadata: { hasToolCalls: boolean; isFinal: boolean }
  ) => void;
  private onIterationStart?: (current: number, max: number) => void;
  private onToolStart?: (toolCall: ToolCall) => void;
  private onToolResult?: (
    toolCall: ToolCall,
    result: string,
    metadata?: { isError?: boolean }
  ) => void;

  constructor(config: ManualAgentConfig) {
    this.llm = config.llm;
    this.tools = config.tools;
    this.toolMap = new Map(config.tools.map((tool) => [tool.name, tool]));
    this.systemPrompt = config.systemPrompt;
    this.maxIterations = config.maxIterations ?? 6;
    this.verbose = config.verbose ?? false;
    this.onAssistantChunk = config.onAssistantChunk;
    this.onAssistantResponse = config.onAssistantResponse;
    this.onAssistantTurn = config.onAssistantTurn;
    this.onIterationStart = config.onIterationStart;
    this.onToolStart = config.onToolStart;
    this.onToolResult = config.onToolResult;
  }

  private shouldContinueWorking(response: string, userMessage: string): boolean {
    const normalizedResponse = response.trim();
    const normalizedUser = userMessage.trim().toLowerCase();

    if (!normalizedResponse) {
      return false;
    }

    const actionRequestPatterns = [
      /\breview\b/,
      /\bcheck\b/,
      /\binspect\b/,
      /\baudit\b/,
      /\banaly[sz]e\b/,
      /\bfind\b/,
      /\bsearch\b/,
      /\bfix\b/,
      /\blook at\b/,
      /\bscan\b/,
      /\breport\b/,
      /\bdebug\b/,
      /\binvestigate\b/,
      /\bport\b/,
      /\bimplement\b/,
      /\bbuild\b/,
    ];

    const planningResponsePatterns = [
      /^i(?:'| wi)ll\b/i,
      /^let me\b/i,
      /^first,?\s+i(?:'| wi)ll\b/i,
      /^to start,?\s+i(?:'| wi)ll\b/i,
      /^i need to\b/i,
      /^to perform\b/i,
      /^i'?m going to\b/i,
    ];

    const concreteFindingPatterns = [
      /\b(found|identified|discovered|detected)\b/i,
      /\bsecurity issue\b/i,
      /\brecommend(?:ation|ed)\b/i,
      /\bhere (?:are|is)\b/i,
      /\bsummary\b/i,
      /\bresult\b/i,
    ];

    return (
      actionRequestPatterns.some((pattern) => pattern.test(normalizedUser)) &&
      planningResponsePatterns.some((pattern) => pattern.test(normalizedResponse)) &&
      !concreteFindingPatterns.some((pattern) => pattern.test(normalizedResponse))
    );
  }

  private stripToolMarkup(text: string): string {
    return text
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
      .replace(/<tool_result>[\s\S]*?<\/tool_result>/g, "")
      .replace(/<\/?tool_name>/g, "")
      .replace(/<\/?tool_input>/g, "")
      .replace(/<\/?tool_result>/g, "")
      .trim();
  }

  private normalizeAssistantText(text: string): string {
    return this.stripToolMarkup(text).replace(/\n{3,}/g, "\n\n").trim();
  }

  private formatToolsForPrompt(): string {
    const toolDescriptions = this.tools
      .map((tool) => {
        const schemaStr = JSON.stringify(tool.inputSchema ?? {}, null, 2);
        return `## ${tool.name}\n${tool.description}\n\nInput schema:\n\`\`\`json\n${schemaStr}\n\`\`\``;
      })
      .join("\n\n");

    return (
      `# Available Tools\n\n${toolDescriptions}\n\n` +
      `# Preferred Turn Format\n\n` +
      `Respond with a JSON object using exactly one of these shapes:\n\n` +
      `1. Tool-use turn:\n` +
      `\`\`\`json\n{\n  "assistant_message": "Briefly explain what you are doing next.",\n  "tool_calls": [\n    {\n      "name": "tool_name_here",\n      "input": {\n        "param1": "value1"\n      }\n    }\n  ]\n}\n\`\`\`\n\n` +
      `2. Final-answer turn:\n` +
      `\`\`\`json\n{\n  "assistant_message": "Optional short status update.",\n  "final_answer": "Your full final answer to the user."\n}\n\`\`\`\n\n` +
      `Do not emit fake <tool_result> blocks. Tool results are supplied by the system after execution.\n\n` +
      `# Legacy Tool Calling Fallback\n\n` +
      `If JSON fails, you may use XML-style tags:\n\n` +
      `<tool_call>\n<tool_name>tool_name_here</tool_name>\n<tool_input>\n{\n  "param1": "value1",\n  "param2": "value2"\n}\n</tool_input>\n</tool_call>\n\n` +
      `You can call multiple tools by using multiple <tool_call> blocks.\n\n` +
      `When you have enough information to provide a final answer, prefer the JSON final-answer turn.`
    );
  }

  private toParsedTurnEnvelope(
    turn: ProviderStructuredTurn | null | undefined
  ): ParsedTurnEnvelope | null {
    if (!turn) {
      return null;
    }

    const toolCalls = turn.toolCalls.map((call) => ({
      id: call.id || randomUUID(),
      name: call.name,
      input: call.input,
    }));

    if (!turn.assistantMessage && !turn.finalAnswer && toolCalls.length === 0) {
      return null;
    }

    return {
      assistantMessage: turn.assistantMessage,
      toolCalls,
      finalAnswer: turn.finalAnswer,
    };
  }

  private parseStructuredEnvelope(text: string): ParsedTurnEnvelope | null {
    return this.toParsedTurnEnvelope(parseStructuredTurn(text));
  }

  private parseToolCalls(text: string): ToolCall[] {
    const toolCalls: ToolCall[] = [];
    const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
    let match: RegExpExecArray | null;

    while ((match = toolCallRegex.exec(text)) !== null) {
      const callContent = match[1];
      const nameMatch = callContent.match(/<tool_name>(.*?)<\/tool_name>/);
      const inputMatch = callContent.match(/<tool_input>([\s\S]*?)<\/tool_input>/);

      if (!nameMatch || !inputMatch) {
        continue;
      }

      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(inputMatch[1].trim()) as Record<string, unknown>;
      } catch {
        input = { raw: inputMatch[1].trim() };
      }

      toolCalls.push({ id: randomUUID(), name: nameMatch[1].trim(), input });
    }

    if (toolCalls.length === 0) {
      try {
        const jsonMatch = text.match(/\{[\s\S]*?"action"[\s\S]*?:[\s\S]*?"([^"]+)"[\s\S]*?"action_input"[\s\S]*?:[\s\S]*?(\{[\s\S]*?\}|\[[\s\S]*?\])[\s\S]*?\}/);
        if (jsonMatch) {
          toolCalls.push({
            id: randomUUID(),
            name: jsonMatch[1],
            input: JSON.parse(jsonMatch[2]) as Record<string, unknown>,
          });
        }
      } catch {
        // Ignore malformed JSON fallback.
      }
    }

    return toolCalls;
  }

  private async executeTool(toolCall: ToolCall): Promise<string> {
    const tool = this.toolMap.get(toolCall.name);

    if (!tool) {
      const result = `Error: Tool "${toolCall.name}" not found. Available tools: ${Array.from(this.toolMap.keys()).join(", ")}`;
      this.onToolResult?.(toolCall, result, { isError: true });
      return result;
    }

    try {
      this.onToolStart?.(toolCall);
      if (this.verbose) {
        console.log(`\n🛠️  Executing tool: ${toolCall.name}`);
        console.log(`   Input: ${JSON.stringify(toolCall.input, null, 2)}`);
      }

      const result = await tool.call(toolCall.input);
      const normalized =
        typeof result === "string" ? result : JSON.stringify(result);

      if (this.verbose) {
        const preview =
          normalized.length > 200 ? `${normalized.slice(0, 200)}...` : normalized;
        console.log(`   Result: ${preview}\n`);
      }

      this.onToolResult?.(toolCall, normalized, { isError: false });
      return normalized;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (this.verbose) {
        console.log(`   Error: ${errorMsg}\n`);
      }
      const result = `Error executing tool "${toolCall.name}": ${errorMsg}`;
      this.onToolResult?.(toolCall, result, { isError: true });
      return result;
    }
  }

  private mergeProviderEventEnvelope(
    envelope: ParsedTurnEnvelope | null,
    event: ProviderEvent
  ): ParsedTurnEnvelope | null {
    const next = envelope ?? {
      assistantMessage: "",
      toolCalls: [],
      finalAnswer: undefined,
    };

    switch (event.type) {
      case "assistant-message":
        next.assistantMessage = event.text;
        return next;
      case "tool-call":
        next.toolCalls.push({
          id: event.toolCall.id,
          name: event.toolCall.name,
          input: event.toolCall.input,
        });
        return next;
      case "final-answer":
        next.finalAnswer = event.text;
        return next;
      case "done":
        return this.toParsedTurnEnvelope(event.turn ?? parseStructuredTurn(event.rawText));
      default:
        return next;
    }
  }

  private async streamModelTurn(
    messages: ChatMessage[]
  ): Promise<{ responseText: string; envelope: ParsedTurnEnvelope | null }> {
    let responseText = "";
    let envelope: ParsedTurnEnvelope | null = null;

    try {
      for await (const event of this.llm.streamProviderEvents(messages)) {
        if (event.type === "text-delta") {
          responseText += event.text;
          continue;
        }

        envelope = this.mergeProviderEventEnvelope(envelope, event);
      }

      if (responseText.trim().length > 0) {
        this.onAssistantResponse?.(responseText);
      }

      if (responseText.trim().length > 0 || envelope) {
        return { responseText, envelope };
      }
    } catch {
      // Fall back to non-streaming structured turn below.
    }

    const turn = await this.llm.chatStructuredTurn(messages);
    responseText = turn.rawText;
    this.onAssistantResponse?.(responseText);
    return {
      responseText,
      envelope: this.toParsedTurnEnvelope(turn),
    };
  }

  async invoke(input: {
    input: string;
    chat_history?: ChatMessage[];
  }): Promise<{ output: string; transcript: ChatMessage[] }> {
    const messages: ChatMessage[] = [
      { role: "system", content: `${this.systemPrompt}\n\n${this.formatToolsForPrompt()}` },
      ...(input.chat_history || []),
      { role: "user", content: input.input },
    ];

    let iterationCount = 0;
    let interimContinuationCount = 0;

    while (iterationCount < this.maxIterations) {
      iterationCount += 1;
      this.onIterationStart?.(iterationCount, this.maxIterations);

      if (this.verbose) {
        console.log(`\n--- Iteration ${iterationCount}/${this.maxIterations} ---`);
      }

      const { responseText, envelope } = await this.streamModelTurn(messages);
      const toolCalls = envelope?.toolCalls ?? this.parseToolCalls(responseText);
      const visibleResponse = this.normalizeAssistantText(
        envelope?.assistantMessage || envelope?.finalAnswer || responseText
      );
      const finalAnswer = this.normalizeAssistantText(envelope?.finalAnswer || "");

      if (toolCalls.length === 0) {
        if (
          !finalAnswer &&
          this.shouldContinueWorking(visibleResponse || responseText, input.input) &&
          interimContinuationCount < 2
        ) {
          interimContinuationCount += 1;
          messages.push({ role: "assistant", content: visibleResponse || responseText });
          messages.push({
            role: "user",
            content:
              "Continue the task. Do not stop after stating intent. Execute the next concrete step now. If repository inspection is needed, call the next relevant tool instead of only describing what you will do.",
          });
          continue;
        }

        if (this.verbose) {
          console.log(`\n✅ Final answer received\n`);
        }

        const output = finalAnswer || visibleResponse || responseText;
        if (output) {
          this.onAssistantTurn?.(visibleResponse, {
            hasToolCalls: false,
            isFinal: true,
          });
        }
        messages.push({ role: "assistant", content: output });
        return { output, transcript: messages.slice(1) };
      }

      if (visibleResponse) {
        this.onAssistantTurn?.(visibleResponse, {
          hasToolCalls: true,
          isFinal: false,
        });
      }

      const observations: string[] = [];
      for (const toolCall of toolCalls) {
        const observation = await this.executeTool(toolCall);
        observations.push(`Tool: ${toolCall.name}\nResult: ${observation}`);
      }
      interimContinuationCount = 0;

      messages.push({ role: "assistant", content: visibleResponse || responseText });
      messages.push({
        role: "user",
        content: [
          "Tool Results:",
          "",
          ...observations,
          "",
          'Respond with a JSON object.',
          'If more work is needed, emit {"assistant_message": "...", "tool_calls": [...]}',
          'If the task is complete, emit {"assistant_message": "...", "final_answer": "..."}',
        ].join("\n"),
      });
    }

    const lastResponse = messages[messages.length - 2];
    const lastContent = lastResponse?.content || "Maximum iterations reached without final answer";
    const output = `${this.normalizeAssistantText(lastContent)}\n\n(Note: Reached maximum iteration limit of ${this.maxIterations})`;
    messages.push({ role: "assistant", content: output });
    return { output, transcript: messages.slice(1) };
  }
}
