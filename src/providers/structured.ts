import { randomUUID } from "crypto";
import type {
  ProviderEvent,
  ProviderStructuredTurn,
  ProviderToolCall,
} from "./base.js";

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:\w+)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

function extractBalancedJson(text: string): string | null {
  const stripped = stripCodeFences(text);
  const firstBrace = stripped.indexOf("{");
  if (firstBrace === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = firstBrace; i < stripped.length; i++) {
    const char = stripped[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return stripped.slice(firstBrace, i + 1);
      }
    }
  }

  return null;
}

function stripToolMarkup(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<tool_result>[\s\S]*?<\/tool_result>/g, "")
    .replace(/<\/?tool_name>/g, "")
    .replace(/<\/?tool_input>/g, "")
    .replace(/<\/?tool_result>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseXmlToolCalls(text: string): ProviderToolCall[] {
  const toolCalls: ProviderToolCall[] = [];
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

    toolCalls.push({
      id: randomUUID(),
      name: nameMatch[1].trim(),
      input,
    });
  }

  return toolCalls;
}

export function parseStructuredTurn(text: string): ProviderStructuredTurn {
  const rawText = text;
  const rawJson = extractBalancedJson(text);

  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as {
        assistant_message?: unknown;
        tool_calls?: Array<{ id?: unknown; name?: unknown; input?: unknown }>;
        final_answer?: unknown;
      };

      const assistantMessage =
        typeof parsed.assistant_message === "string"
          ? stripToolMarkup(parsed.assistant_message)
          : "";
      const finalAnswer =
        typeof parsed.final_answer === "string"
          ? stripToolMarkup(parsed.final_answer)
          : undefined;
      const toolCalls = Array.isArray(parsed.tool_calls)
        ? parsed.tool_calls
            .filter(
              (call): call is { id?: unknown; name: unknown; input?: unknown } =>
                Boolean(call && typeof call === "object" && "name" in call)
            )
            .map((call) => ({
              id: typeof call.id === "string" ? call.id : randomUUID(),
              name: String(call.name).trim(),
              input:
                call.input && typeof call.input === "object" && !Array.isArray(call.input)
                  ? (call.input as Record<string, unknown>)
                  : {},
            }))
            .filter((call) => call.name.length > 0)
        : [];

      if (assistantMessage || finalAnswer || toolCalls.length > 0) {
        return {
          assistantMessage,
          toolCalls,
          finalAnswer,
          rawText,
        };
      }
    } catch {
      // Fall through to XML/plain-text parsing.
    }
  }

  const toolCalls = parseXmlToolCalls(text);
  const assistantMessage = stripToolMarkup(text);

  return {
    assistantMessage,
    toolCalls,
    rawText,
  };
}

export function eventsFromStructuredTurn(
  turn: ProviderStructuredTurn
): ProviderEvent[] {
  const events: ProviderEvent[] = [];

  if (turn.assistantMessage) {
    events.push({ type: "assistant-message", text: turn.assistantMessage });
  }

  for (const toolCall of turn.toolCalls) {
    events.push({
      type: "tool-call-delta",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      inputTextDelta: JSON.stringify(toolCall.input),
    });
    events.push({ type: "tool-call", toolCall });
  }

  if (turn.finalAnswer) {
    events.push({ type: "final-answer", text: turn.finalAnswer });
  }

  events.push({ type: "done", rawText: turn.rawText, turn });
  return events;
}

export async function* textStreamToStructuredEvents(
  source: AsyncIterable<string>
): AsyncIterable<ProviderEvent> {
  let rawText = "";

  for await (const chunk of source) {
    const text = typeof chunk === "string" ? chunk : String(chunk ?? "");
    if (!text) {
      continue;
    }
    rawText += text;
    yield { type: "text-delta", text };
  }

  const turn = parseStructuredTurn(rawText);
  yield* eventsFromStructuredTurn(turn);
}
