import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  AgentMessage,
  ToolDefinition,
  Provider,
  ProviderEvent,
} from "@meer/ai/base.js";

const tempHome = mkdtempSync(join(tmpdir(), "meer-agent-queue-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const { MeerAgent } = await import("@meer/coding-agent/agent/meer-agent.js");
const { AgentSession } = await import("@meer/coding-agent/agent/agent-session.js");
const { memory } = await import("@meer/coding-agent/memory/index.js");
const { MCPManager } = await import("@meer/coding-agent/mcp/manager.js");

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

class RetryThenAnswerProvider implements Provider {
  attempts = 0;

  async chat(): Promise<string> {
    throw new Error("unused");
  }

  async *stream(): AsyncIterable<string> {
    throw new Error("unused");
  }

  async *streamWithTools(): AsyncIterable<ProviderEvent> {
    this.attempts += 1;
    if (this.attempts === 1) {
      throw new Error("Network timeout while contacting provider");
    }

    const finalText = "recovered after retry";
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

  const runtime = new MeerAgent({
    provider: new SteeringProvider(),
    cwd,
    enableMemory: true,
  }) as any;
  runtime.buildAgentTools = () => [createStubTool()];
  const agent = new AgentSession({ runtime });
  await agent.initialize();

  const run = agent.prompt("start");
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
  const runtime = new MeerAgent({
    provider: new FollowUpProvider(),
    cwd,
    enableMemory: true,
    onAssistantMessage: (content) => assistantMessages.push(content),
  }) as any;
  runtime.buildAgentTools = () => [createStubTool()];
  const agent = new AgentSession({ runtime });
  await agent.initialize();

  const run = agent.prompt("start");
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

async function verifyRetryDoesNotDuplicateUserTurn(): Promise<void> {
  const cwd = join(tempHome, "retry-project");
  mkdirSync(cwd, { recursive: true });
  memory.startSession(cwd);

  const provider = new RetryThenAnswerProvider();
  const runtime = new MeerAgent({
    provider,
    cwd,
    enableMemory: true,
  }) as any;
  const agent = new AgentSession({
    runtime,
    retry: {
      attempts: 1,
      delayMs: 1,
      backoffFactor: 1,
    },
  });
  await agent.initialize();

  const result = await agent.prompt("retry me");
  assert.equal(result, "recovered after retry");
  assert.equal(provider.attempts, 2);

  const sessionEntries = memory.loadCurrentSession(cwd);
  const userEntries = sessionEntries
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.content);
  assert.deepEqual(userEntries, ["retry me"]);
}

try {
  await verifySteeringQueue();
  await verifyFollowUpQueue();
  await verifyRetryDoesNotDuplicateUserTurn();
  console.log("✅ MeerAgent queue behavior verified.");
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
