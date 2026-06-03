/**
 * ChatGPT provider — calls the Codex responses API using OAuth credentials.
 *
 * Users authenticate with their ChatGPT Plus/Pro account (no API key).
 * The provider translates meer's AgentMessage / ProviderEvent types to/from
 * OpenAI's Responses API format used by chatgpt.com/backend-api.
 */

import type {
  Provider,
  ChatMessage,
  ChatOptions,
  ProviderMetadata,
  ProviderEvent,
  ProviderStructuredTurn,
  AgentMessage,
  ToolDefinition,
} from "./base.js";
import { parseStructuredTurn } from "./structured.js";
import type { ChatGPTCredentials } from "../auth/chatgpt/oauth.js";
import { refreshChatGPTToken } from "../auth/chatgpt/oauth.js";
import { fetchWithTimeout, STREAM_TIMEOUT_MS } from "../utils/fetch.js";

const BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM = "https://api.openai.com/auth";
const DEFAULT_MODEL = "gpt-5.3-codex-spark";

// ── Credential resolution ─────────────────────────────────────────────────

export interface ChatGPTProviderConfig {
  model?: string;
  temperature?: number;
  getCredentials: () => ChatGPTCredentials | null;
  saveCredentials: (creds: ChatGPTCredentials) => void;
}

async function resolveAuth(config: ChatGPTProviderConfig): Promise<{ token: string; accountId: string }> {
  let creds = config.getCredentials();
  if (!creds) throw new Error("Not logged in to ChatGPT. Run `meer login chatgpt` first.");

  if (Date.now() >= creds.expires - 60_000) {
    creds = await refreshChatGPTToken(creds.refresh);
    config.saveCredentials(creds);
  }

  return { token: creds.access, accountId: creds.accountId };
}

function buildHeaders(token: string, accountId: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,
    "chatgpt-account-id": accountId,
    "accept": "text/event-stream",
    "OpenAI-Beta": "responses=experimental",
    "originator": "meer",
  };
}

// ── Message conversion ────────────────────────────────────────────────────

type ResponsesInput = unknown[];

function chatMessagesToInput(messages: ChatMessage[]): { instructions?: string; input: ResponsesInput } {
  let instructions: string | undefined;
  const input: ResponsesInput = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      instructions = instructions ? `${instructions}\n\n${msg.content}` : msg.content;
      continue;
    }
    input.push({
      type: "message",
      role: msg.role,
      content: [{ type: msg.role === "user" ? "input_text" : "output_text", text: msg.content }],
    });
  }

  return { instructions, input };
}

function agentMessagesToInput(messages: AgentMessage[]): { instructions?: string; input: ResponsesInput } {
  let instructions: string | undefined;
  const input: ResponsesInput = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      instructions = instructions ? `${instructions}\n\n${msg.content}` : msg.content;
      continue;
    }

    if (msg.role === "user") {
      input.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: msg.content }],
      });
      continue;
    }

    if (msg.role === "assistant") {
      const content: unknown[] = [];
      if (msg.content?.trim()) {
        content.push({ type: "output_text", text: msg.content });
      }
      if (content.length > 0) {
        input.push({ type: "message", role: "assistant", content });
      }
      // Tool calls become separate function_call items
      if (msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.input),
          });
        }
      }
      continue;
    }

    if (msg.role === "tool_result") {
      input.push({
        type: "function_call_output",
        call_id: msg.toolCallId,
        output: msg.isError ? `Error: ${msg.content}` : msg.content,
      });
    }
  }

  return { instructions, input };
}

function toolsToResponsesFormat(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
}

// ── SSE streaming ─────────────────────────────────────────────────────────

async function* streamCodexResponses(
  body: Record<string, unknown>,
  token: string,
  accountId: string,
  signal?: AbortSignal
): AsyncIterable<ProviderEvent> {
  const res = await fetchWithTimeout(
    `${BASE_URL}/codex/responses`,
    {
      method: "POST",
      headers: buildHeaders(token, accountId),
      body: JSON.stringify(body),
      signal,
    },
    STREAM_TIMEOUT_MS
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const lower = text.toLowerCase();
    if (res.status === 401 || res.status === 403) {
      throw new Error("ChatGPT authentication failed. Run `meer login chatgpt` to re-authenticate.");
    }
    if (lower.includes("subscription") || lower.includes("quota") || lower.includes("billing")) {
      throw new Error(`ChatGPT usage limit reached: ${text}`);
    }
    throw new Error(`ChatGPT API error (${res.status}): ${text || res.statusText}`);
  }

  if (!res.body) throw new Error("No response body from ChatGPT API");

  const decoder = new TextDecoder();
  let buffer = "";

  // Accumulate tool call arguments per call_id
  const toolArgBuffers = new Map<string, { name: string; args: string }>();
  let rawText = "";

  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          yield { type: "done", rawText };
          return;
        }

        let event: Record<string, unknown>;
        try { event = JSON.parse(data) as Record<string, unknown>; } catch { continue; }

        const type = event.type as string | undefined;

        if (type === "response.output_text.delta") {
          const delta = (event.delta as string | undefined) ?? "";
          if (delta) {
            rawText += delta;
            yield { type: "text-delta", text: delta };
          }
          continue;
        }

        if (type === "response.function_call_arguments.delta") {
          const callId = event.call_id as string;
          const name = event.name as string;
          const delta = (event.delta as string | undefined) ?? "";
          if (!toolArgBuffers.has(callId)) {
            toolArgBuffers.set(callId, { name, args: "" });
          }
          toolArgBuffers.get(callId)!.args += delta;
          yield { type: "tool-call-delta", toolCallId: callId, toolName: name, inputTextDelta: delta };
          continue;
        }

        if (type === "response.output_item.done") {
          const item = event.item as Record<string, unknown> | undefined;
          if (item?.type === "function_call") {
            const callId = item.call_id as string;
            const name = item.name as string;
            const accumulated = toolArgBuffers.get(callId);
            const argsStr = (item.arguments as string | undefined) ?? accumulated?.args ?? "{}";
            let input: Record<string, unknown> = {};
            try { input = JSON.parse(argsStr) as Record<string, unknown>; } catch { /* leave empty */ }
            yield { type: "tool-call", toolCall: { id: callId, name, input } };
            toolArgBuffers.delete(callId);
          }
          continue;
        }

        if (type === "response.completed" || type === "response.failed") {
          const response = event.response as Record<string, unknown> | undefined;
          if (type === "response.failed") {
            const err = response?.error as Record<string, unknown> | undefined;
            throw new Error(`ChatGPT response failed: ${err?.message ?? JSON.stringify(err)}`);
          }
          yield { type: "done", rawText };
          return;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield { type: "done", rawText };
}

// ── Provider class ────────────────────────────────────────────────────────

export class ChatGPTProvider implements Provider {
  private config: ChatGPTProviderConfig;
  readonly model: string;

  constructor(config: ChatGPTProviderConfig) {
    this.config = config;
    this.model = config.model ?? DEFAULT_MODEL;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    const { token, accountId } = await resolveAuth(this.config);
    const { instructions, input } = chatMessagesToInput(messages);

    const body: Record<string, unknown> = {
      model: this.model,
      store: false,
      stream: false,
      input,
    };
    if (instructions) body.instructions = instructions;

    const res = await fetchWithTimeout(
      `${BASE_URL}/codex/responses`,
      {
        method: "POST",
        headers: buildHeaders(token, accountId),
        body: JSON.stringify(body),
      },
      STREAM_TIMEOUT_MS
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ChatGPT API error (${res.status}): ${text}`);
    }

    const json = (await res.json()) as { output?: Array<{ content?: Array<{ text?: string }> }> };
    return json.output?.[0]?.content?.[0]?.text ?? "";
  }

  async *stream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string> {
    const { token, accountId } = await resolveAuth(this.config);
    const { instructions, input } = chatMessagesToInput(messages);

    const body: Record<string, unknown> = {
      model: this.model,
      store: false,
      stream: true,
      input,
    };
    if (instructions) body.instructions = instructions;

    for await (const event of streamCodexResponses(body, token, accountId)) {
      if (event.type === "text-delta") yield event.text;
    }
  }

  async chatStructured(messages: ChatMessage[], options?: ChatOptions): Promise<ProviderStructuredTurn> {
    return parseStructuredTurn(await this.chat(messages, options));
  }

  async *streamWithTools(
    messages: AgentMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal
  ): AsyncIterable<ProviderEvent> {
    const { token, accountId } = await resolveAuth(this.config);
    const { instructions, input } = agentMessagesToInput(messages);

    const body: Record<string, unknown> = {
      model: this.model,
      store: false,
      stream: true,
      input,
      parallel_tool_calls: true,
    };
    if (instructions) body.instructions = instructions;
    if (tools.length > 0) {
      body.tools = toolsToResponsesFormat(tools);
      body.tool_choice = "auto";
    }

    yield* streamCodexResponses(body, token, accountId, signal);
  }

  async metadata(): Promise<ProviderMetadata> {
    return {
      name: "ChatGPT",
      version: "1.0.0",
      capabilities: ["chat", "stream", "tools"],
      models: [this.model],
      currentModel: this.model,
    };
  }
}
