import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  AgentMessage,
  ToolDefinition,
  Provider,
  ProviderEvent,
} from "../src/providers/base.js";

const tempHome = mkdtempSync(join(tmpdir(), "meer-agent-queue-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const { MeerAgent } = await import("../src/agent/meer-agent.js");
const { memory } = await import("../src/memory/index.js");
const { MCPManager } = await import("../src/mcp/manager.js");

const manager = MCPManager.getInstance() as any;
manager.initialized = true;
manager.listAllTools = () => [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createStubTool() {
  return {
    name: "analyze_project",
    description: "Stub analysis tool",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    async execute() {
      await sleep(20);
      return { content: "analysis complete", isError: false };
    },
  };
}

class SteeringProvider implements Provider {
  async chat(): Promise<string> {
    throw new Error("unused");
  }

  async *stream(): AsyncIterable<string> {
    throw new Error("unused");
  }

  async *streamWithTools(
    messages: AgentMessage[],
    _tools: ToolDefinition[]
  ): AsyncIterable<ProviderEvent> {
    const userTexts = messages
      .filter((message): message is Extract<AgentMessage, { role: "user" }> => message.role === "user")
      .map((message) => message.content);
    const sawToolResult = messages.some((message) => message.role === "tool_result");

    if (!sawToolResult) {
      yield {
        type: "tool-call",
        toolCall: { id: "tool-1", name: "analyze_project", input: {} },
      };
      yield { type: "done", rawText: "" };
      return;
    }

    const sawSteer = userTexts.includes("steer now");
    const finalText = sawSteer ? "saw steer" : "missing steer";
    yield {
      type: "done",
      rawText: finalText,
      turn: {
        assistantMessage: finalText,
        finalAnswer: finalText,
        rawText: finalText,
        toolCalls: [],
      },
    };
  }
}

class FollowUpProvider implements Provider {
  async chat(): Promise<string> {
    throw new Error("unused");
  }

  async *stream(): AsyncIterable<string> {
    throw new Error("unused");
  }

  async *streamWithTools(
    messages: AgentMessage[],
    _tools: ToolDefinition[]
  ): AsyncIterable<ProviderEvent> {
    const userTexts = messages
      .filter((message): message is Extract<AgentMessage, { role: "user" }> => message.role === "user")
      .map((message) => message.content);
    const latestUser = userTexts[userTexts.length - 1];
    const sawToolResult = messages.some((message) => message.role === "tool_result");

    if (latestUser === "start" && !sawToolResult) {
      yield {
        type: "tool-call",
        toolCall: { id: "tool-1", name: "analyze_project", input: {} },
      };
      yield { type: "done", rawText: "" };
      return;
    }

    const finalText =
      latestUser === "after current run" ? "handled follow up" : "first answer";
    yield {
      type: "done",
      rawText: finalText,
      turn: {
        assistantMessage: finalText,
        finalAnswer: finalText,
        rawText: finalText,
        toolCalls: [],
      },
    };
  }
}

async function verifySteeringQueue(): Promise<void> {
  const cwd = join(tempHome, "steering-project");
  mkdirSync(cwd, { recursive: true });
  memory.startSession(cwd);

  const agent = new MeerAgent({
    provider: new SteeringProvider(),
    cwd,
    enableMemory: true,
  }) as any;
  agent.buildAgentTools = () => [createStubTool()];
  await agent.initialize();

  const run = agent.processMessage("start");
  await sleep(5);
  assert.equal(agent.isProcessing(), true, "agent should still be running");
  assert.equal(agent.queueMessage("steer now", "steer"), true);
  const result = await run;

  assert.equal(result, "saw steer");
  const sessionEntries = memory.loadCurrentSession(cwd);
  const userEntries = sessionEntries
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.content);
  assert.deepEqual(userEntries, ["start", "steer now"]);
  const queueEntries = sessionEntries.filter(
    (entry) => entry.metadata?.queueAction
  );
  assert.deepEqual(
    queueEntries.map((entry) => ({
      action: entry.metadata?.queueAction,
      mode: entry.metadata?.queueMode,
      content: entry.content,
    })),
    [
      {
        action: "queued",
        mode: "steer",
        content: "Queued steer: steer now",
      },
      {
        action: "delivered",
        mode: "steer",
        content: "Delivered steer: steer now",
      },
    ]
  );
}

async function verifyFollowUpQueue(): Promise<void> {
  const cwd = join(tempHome, "follow-up-project");
  mkdirSync(cwd, { recursive: true });
  memory.startSession(cwd);

  const assistantMessages: string[] = [];
  const agent = new MeerAgent({
    provider: new FollowUpProvider(),
    cwd,
    enableMemory: true,
    onAssistantMessage: (content) => assistantMessages.push(content),
  }) as any;
  agent.buildAgentTools = () => [createStubTool()];
  await agent.initialize();

  const run = agent.processMessage("start");
  await sleep(5);
  assert.equal(agent.queueMessage("after current run", "followUp"), true);
  const result = await run;

  assert.equal(result, "handled follow up");
  assert.deepEqual(assistantMessages, ["first answer", "handled follow up"]);
  const sessionEntries = memory.loadCurrentSession(cwd);
  const userEntries = sessionEntries
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.content);
  assert.deepEqual(userEntries, ["start", "after current run"]);
  const queueEntries = sessionEntries.filter(
    (entry) => entry.metadata?.queueAction
  );
  assert.deepEqual(
    queueEntries.map((entry) => ({
      action: entry.metadata?.queueAction,
      mode: entry.metadata?.queueMode,
      content: entry.content,
    })),
    [
      {
        action: "queued",
        mode: "followUp",
        content: "Queued follow-up: after current run",
      },
      {
        action: "delivered",
        mode: "followUp",
        content: "Delivered follow-up: after current run",
      },
    ]
  );
}

try {
  await verifySteeringQueue();
  await verifyFollowUpQueue();
  console.log("✅ MeerAgent queue behavior verified.");
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
