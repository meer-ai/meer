/**
 * Shared OpenAI-format message transforms.
 *
 * The OpenAI Chat Completions wire format is used by the standard OpenAI API and
 * by every OpenAI-compatible gateway (OpenRouter, Z.ai, Opencode, DeepSeek,
 * Together, …). This module is the single home for converting meer's
 * `AgentMessage[]` into that format so the conversion — including its subtle
 * rules (orphan tool-results, reasoning replay) — lives in exactly one place
 * instead of being copy-pasted per provider.
 */

import type { AgentMessage, MessageAttachment } from "../types.js";
import { readAttachmentBase64 } from "../attachments.js";

/**
 * Build the `content` field for an OpenAI-format user message. Returns a plain
 * string when there are no attachments (the Chat Completions API accepts it),
 * otherwise emits multi-part content with image_url parts:
 *   [{ type: "text", text }, { type: "image_url", image_url: { url: "data:..." } }, ...]
 */
export function buildOpenAIUserContent(
  text: string,
  attachments?: MessageAttachment[]
): unknown {
  if (!attachments?.length) {
    return text;
  }
  const parts: unknown[] = [];
  if (text) {
    parts.push({ type: "text", text });
  }
  for (const attachment of attachments) {
    if (attachment.kind !== "image") continue;
    const { mimeType, data } = readAttachmentBase64(attachment);
    parts.push({
      type: "image_url",
      image_url: { url: `data:${mimeType};base64,${data}` },
    });
  }
  if (parts.length === 0) {
    return text;
  }
  return parts;
}

/** Options controlling provider-specific quirks of the OpenAI conversion. */
export interface OpenAIConversionOptions {
  /**
   * When true, a plain assistant message (no reasoning, no tool calls) is
   * replayed as a `system` "Previous assistant response" message rather than an
   * `assistant` message. Some reasoning models reject assistant turns that lack
   * the original reasoning trace; the standard OpenAI provider opts in for those.
   */
  reasoningReplay?: boolean;
}

/**
 * Convert meer's `AgentMessage[]` into the OpenAI Chat Completions message array.
 *
 * Orphan tool-results (a `tool_result` with no matching `tool_call` in the
 * preceding assistant turn — possible after history compaction or context
 * injection) are emitted as a `user` message, never a mid-conversation `system`
 * message: OpenAI tolerates inline system, but Anthropic / Bedrock / Vertex
 * (reachable through OpenRouter) reject it.
 */
export function convertAgentMessagesToOpenAI(
  messages: AgentMessage[],
  options?: OpenAIConversionOptions
): unknown[] {
  const reasoningReplay = options?.reasoningReplay ?? false;
  const converted: unknown[] = [];
  const pendingToolCallIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "system") {
      pendingToolCallIds.clear();
      converted.push({ role: "system", content: msg.content });
    } else if (msg.role === "user") {
      pendingToolCallIds.clear();
      converted.push({
        role: "user",
        content: buildOpenAIUserContent(msg.content, msg.attachments),
      });
    } else if (msg.role === "assistant") {
      pendingToolCallIds.clear();
      if (reasoningReplay && !msg.reasoningContent && !msg.toolCalls?.length) {
        converted.push({
          role: "system",
          content: `Previous assistant response:\n${msg.content}`,
        });
        continue;
      }
      if (msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          pendingToolCallIds.add(tc.id);
        }
        converted.push({
          role: "assistant",
          content: msg.content || null,
          ...(msg.reasoningContent ? { reasoning_content: msg.reasoningContent } : {}),
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          })),
        });
      } else {
        converted.push({
          role: "assistant",
          content: msg.content,
          ...(msg.reasoningContent ? { reasoning_content: msg.reasoningContent } : {}),
        });
      }
    } else if (msg.role === "tool_result") {
      if (!msg.toolCallId || !pendingToolCallIds.has(msg.toolCallId)) {
        converted.push({
          role: "user",
          content: `Previous tool result (${msg.toolName}${msg.isError ? ", error" : ""}):\n${msg.content}`,
        });
        continue;
      }
      pendingToolCallIds.delete(msg.toolCallId);
      converted.push({
        role: "tool",
        content: msg.content,
        tool_call_id: msg.toolCallId,
      });
    }
  }

  return converted;
}
