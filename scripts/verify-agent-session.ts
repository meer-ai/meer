import assert from "node:assert/strict";
import { AgentSession } from "@meer-ai/coding-agent/agent/agent-session.js";

class RetryRuntime {
  attempts = 0;

  async initialize(): Promise<void> {}

  async processMessage() {
    this.attempts += 1;
    if (this.attempts === 1) {
      throw new Error("Network timeout while contacting provider");
    }
    return {
      response: "recovered",
      conversationHistory: [],
    };
  }

  abort(): void {}

  isProcessing(): boolean {
    return false;
  }
}

class QueueRuntime {
  async initialize(): Promise<void> {}

  async processMessage(userMessage: string) {
    return {
      response: `handled:${userMessage}`,
      conversationHistory: [],
    };
  }

  abort(): void {}

  isProcessing(): boolean {
    return true;
  }
}

class LifecycleRuntime {
  private sink?: (event: import("@meer-ai/coding-agent/agent/agent-session.js").AgentSessionEvent) => void;

  setSessionEventSink(
    sink: (event: import("@meer-ai/coding-agent/agent/agent-session.js").AgentSessionEvent) => void
  ): void {
    this.sink = sink;
  }

  async initialize(): Promise<void> {}

  async processMessage() {
    this.sink?.({ type: "turn_start" });
    this.sink?.({ type: "iteration_change", current: 1, max: 5 });
    this.sink?.({ type: "workflow_stage", name: "Inspect repository", status: "started" });
    this.sink?.({ type: "workflow_stage", name: "Inspect repository", status: "completed" });
    this.sink?.({ type: "status_change", status: "Thinking…" });
    this.sink?.({ type: "status_change", status: "" });
    this.sink?.({ type: "turn_end", success: true });
    return {
      response: "done",
      conversationHistory: [],
    };
  }
}

class AbortRuntime {
  abortCalls = 0;

  async initialize(): Promise<void> {}

  async processMessage() {
    return {
      response: "unused",
      conversationHistory: [],
    };
  }

  abort(): void {
    this.abortCalls += 1;
  }
}

async function verifyRetryFlow(): Promise<void> {
  const runtime = new RetryRuntime();
  const events: string[] = [];
  const session = new AgentSession({
    runtime,
    retry: {
      attempts: 1,
      delayMs: 1,
      backoffFactor: 1,
    },
    onEvent: (event) => {
      if (event.type === "auto_retry_start") {
        events.push(`start:${event.attempt}:${event.maxAttempts}`);
      } else if (event.type === "auto_retry_end") {
        events.push(`end:${event.success}:${event.attempt}`);
      }
    },
  });

  const result = await session.prompt("hello");
  assert.equal(result, "recovered");
  assert.equal(runtime.attempts, 2);
  assert.deepEqual(events, ["start:1:1", "end:true:1"]);
}

async function verifyQueueFlow(): Promise<void> {
  const runtime = new QueueRuntime();
  const events: string[] = [];
  const session = new AgentSession({
    runtime,
    onEvent: (event) => {
      if (event.type === "queue_update") {
        for (const change of event.changes ?? []) {
          events.push(`${change.action}:${change.mode}:${change.message}`);
        }
      }
    },
  });
  assert.equal(session.isProcessing(), true);
  assert.equal(session.queueMessage("narrow this", "steer"), true);
  assert.equal(session.queueMessage("continue later", "followUp"), true);
  assert.deepEqual(events, [
    "queued:steer:narrow this",
    "queued:followUp:continue later",
  ]);
}

async function verifyLifecycleEvents(): Promise<void> {
  const runtime = new LifecycleRuntime();
  const events: string[] = [];
  const session = new AgentSession({
    runtime,
    onEvent: (event) => {
      if (event.type === "turn_start") {
        events.push("turn_start");
      } else if (event.type === "iteration_change") {
        events.push(`iteration:${event.current}/${event.max}`);
      } else if (event.type === "workflow_stage") {
        events.push(`stage:${event.status}:${event.name}`);
      } else if (event.type === "turn_end") {
        events.push(`turn_end:${event.success}`);
      } else if (event.type === "status_change") {
        events.push(`status:${event.status}`);
      }
    },
  });

  const result = await session.prompt("hello");
  assert.equal(result, "done");
  assert.deepEqual(events, [
    "turn_start",
    "iteration:1/5",
    "stage:started:Inspect repository",
    "stage:completed:Inspect repository",
    "status:Thinking…",
    "status:",
    "turn_end:true",
  ]);
}

async function verifyAbortStatus(): Promise<void> {
  const runtime = new AbortRuntime();
  const statuses: string[] = [];
  const session = new AgentSession({
    runtime,
    onEvent: (event) => {
      if (event.type === "status_change") {
        statuses.push(event.status);
      }
    },
  });

  session.abort();
  assert.equal(runtime.abortCalls, 1);
  assert.deepEqual(statuses, ["Interrupting…"]);
}

await verifyRetryFlow();
await verifyQueueFlow();
await verifyLifecycleEvents();
await verifyAbortStatus();
console.log("✅ AgentSession behavior verified.");
