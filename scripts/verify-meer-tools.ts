import assert from "node:assert/strict";
import http from "node:http";
import { MeerProvider } from "@meer-ai/ai/providers/meer.js";
import { parseStructuredTurn } from "@meer-ai/ai/providers/structured.js";
import type {
  AgentMessage,
  ProviderEvent,
  ToolDefinition,
} from "@meer-ai/ai/base.js";

// ─── 1. Managed provider does NATIVE tool calling (not the XML fallback) ──────
// Regression: routing custom-deepseek/* through the Meer managed provider used
// to fall back to a `<tool_call>` XML text-protocol the models don't reliably
// emit, so tools never fired. The provider now sends OpenAI-format tools and
// translates the gateway's `data.tool_calls` into real tool-call events.

const READ_FILE_TOOL: ToolDefinition = {
  name: "read_file",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
};

let capturedBody: any = null;

// A real local gateway stand-in. We point the provider at it so the genuine
// undici `fetch` path runs end-to-end (the core fetch wrapper imports fetch
// from undici, so a globalThis.fetch stub wouldn't apply).
const server = http.createServer((req, res) => {
  let data = "";
  req.on("data", (chunk) => (data += chunk));
  req.on("end", () => {
    capturedBody = JSON.parse(data || "{}");
    // The gateway echoes back the (sanitized) tool name it was given, exactly
    // as a real OpenAI-compatible upstream would — so the registry maps it back.
    const providerToolName = capturedBody.tools?.[0]?.function?.name as string;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        success: true,
        data: {
          content: "Reading it now.",
          model: "custom-deepseek/deepseek-v4-pro",
          tool_calls: [
            {
              id: "call_abc",
              type: "function",
              function: {
                name: providerToolName,
                arguments: JSON.stringify({ path: "src/x.ts" }),
              },
            },
          ],
        },
        usage: { prompt_tokens: 42, completion_tokens: 7 },
      })
    );
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

try {
  const provider = new MeerProvider({
    apiKey: "test-key",
    apiUrl: `http://127.0.0.1:${port}`,
    model: "custom-deepseek/deepseek-v4-pro",
  });

  const messages: AgentMessage[] = [{ role: "user", content: "Read src/x.ts" }];

  const events: ProviderEvent[] = [];
  for await (const event of provider.streamWithTools(messages, [READ_FILE_TOOL])) {
    events.push(event);
  }

  // Tools were sent upstream in OpenAI function format.
  assert.ok(capturedBody.tools?.length === 1, "tools forwarded to gateway");
  assert.equal(capturedBody.tools[0].type, "function", "OpenAI function shape");
  assert.equal(capturedBody.tool_choice, "auto", "tool_choice auto set");

  // The text came through as a delta.
  const textEvent = events.find((e) => e.type === "text-delta");
  assert.ok(textEvent && textEvent.type === "text-delta", "text-delta emitted");
  assert.equal(textEvent.text, "Reading it now.");

  // A real tool-call event fired, with the ORIGINAL name + parsed input.
  const toolEvent = events.find((e) => e.type === "tool-call");
  assert.ok(toolEvent && toolEvent.type === "tool-call", "tool-call emitted");
  assert.equal(toolEvent.toolCall.name, "read_file", "name mapped back to original");
  assert.deepEqual(toolEvent.toolCall.input, { path: "src/x.ts" }, "args parsed");

  // The done event carries the structured turn + usage.
  const doneEvent = events.find((e) => e.type === "done");
  assert.ok(doneEvent && doneEvent.type === "done", "done emitted");
  assert.equal(doneEvent.turn?.toolCalls.length, 1, "turn has the tool call");
  assert.equal(doneEvent.usage?.promptTokens, 42, "usage reported");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// ─── 2. Tool markup never leaks into the visible message ──────────────────────
// A truncated stream or malformed XML used to leave a dangling `</tool_call>`
// (or a half-open `<tool_call>…`) in the assistant text. stripToolMarkup now
// removes unmatched/partial tags too.

const dangledClose = parseStructuredTurn("Let me read the files.</tool_call>");
assert.equal(dangledClose.toolCalls.length, 0, "no tool calls from a stray close tag");
assert.ok(
  !dangledClose.assistantMessage.includes("tool_call"),
  "stray </tool_call> stripped from message"
);
assert.equal(dangledClose.assistantMessage, "Let me read the files.");

const dangledOpen = parseStructuredTurn("Working on it <tool_call><tool_name>read_file");
assert.ok(
  !dangledOpen.assistantMessage.includes("tool_call"),
  "half-open <tool_call> stripped from message"
);
assert.equal(dangledOpen.assistantMessage, "Working on it");

// A well-formed block is still parsed into a real tool call (unchanged path).
const wellFormed = parseStructuredTurn(
  "Done.<tool_call><tool_name>read_file</tool_name><tool_input>{\"path\":\"a.ts\"}</tool_input></tool_call>"
);
assert.equal(wellFormed.toolCalls.length, 1, "complete block still parses");
assert.equal(wellFormed.toolCalls[0].name, "read_file");
assert.equal(wellFormed.assistantMessage, "Done.", "block stripped from message");

console.log("verify-meer-tools: all assertions passed");
