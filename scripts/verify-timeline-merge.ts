import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  handleSlashCommand,
  mergeTimelineEvents,
} from "../src/chat/slash.js";
import type { AgentEventRecorder } from "../src/agent/eventRecorder.js";
import type { ChatAdapter } from "../src/ui/chat-adapter.js";
import type { UITimelineEvent } from "../src/ui/shared/timelineTypes.js";

const agentStarted: UITimelineEvent = {
  id: "agent-1",
  type: "task",
  status: "started",
  label: "Agent task",
  detail: "collect context",
  timestamp: 1000,
};

const duplicateAgentStarted: UITimelineEvent = {
  ...agentStarted,
  id: "tui-duplicate",
  timestamp: 1500,
};

const tuiLog: UITimelineEvent = {
  id: "tui-1",
  type: "log",
  level: "info",
  message: "TUI resumed",
  timestamp: 1200,
};

const laterTuiTask: UITimelineEvent = {
  id: "tui-2",
  type: "task",
  status: "succeeded",
  label: "Tool run_command",
  timestamp: 3000,
};

{
  const merged = mergeTimelineEvents(
    [laterTuiTask, duplicateAgentStarted],
    [tuiLog, agentStarted]
  );
  assert.deepEqual(
    merged.map((event) => event.id),
    ["agent-1", "tui-1", "tui-2"],
    "timeline events merge by timestamp and suppress close duplicates"
  );
}

{
  const tempRoot = mkdtempSync(join(tmpdir(), "meer-timeline-test-"));
  const outputPath = join(tempRoot, "timeline.json");
  const recorder = {
    getTimelineEvents: () => [agentStarted],
    getPlanSnapshot: () => ({
      title: "Agent plan",
      createdAt: 1,
      updatedAt: 1,
      tasks: [{ id: "task-1", description: "merge timelines", status: "completed" }],
    }),
  } as unknown as AgentEventRecorder;
  const tui = {
    getTimelineEvents: () => [tuiLog, laterTuiTask],
  } as unknown as ChatAdapter;

  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };

  try {
    await handleSlashCommand(
      `/timeline save ${outputPath}`,
      {},
      undefined,
      tui,
      recorder
    );
    const payload = JSON.parse(readFileSync(outputPath, "utf8")) as {
      events: UITimelineEvent[];
      plan: { title?: string } | null;
    };
    assert.deepEqual(
      payload.events.map((event) => event.id),
      ["agent-1", "tui-1", "tui-2"],
      "/timeline save includes merged agent and TUI events in order"
    );
    assert.equal(payload.plan?.title, "Agent plan", "timeline save keeps recorder plan snapshot");
    assert.ok(
      logs.some((line) => line.includes("Saved timeline to")),
      "timeline save reports output path"
    );
  } finally {
    console.log = originalLog;
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

console.log("timeline merge verification passed");
