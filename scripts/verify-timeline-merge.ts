import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  handleSlashCommand,
  mergeTimelineEvents,
} from "@meer-ai/coding-agent/chat/slash.js";
import type { AgentEventRecorder } from "@meer-ai/coding-agent/agent/eventRecorder.js";
import type { ChatAdapter } from "@meer-ai/coding-agent/ui/chat-adapter.js";
import type { UITimelineEvent } from "@meer-ai/coding-agent/ui/shared/timelineTypes.js";

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
      limit: number | null;
      events: UITimelineEvent[];
      plan: { title?: string } | null;
    };
    assert.deepEqual(
      payload.events.map((event) => event.id),
      ["agent-1", "tui-1", "tui-2"],
      "/timeline save includes merged agent and TUI events in order"
    );
    assert.equal(payload.limit, null, "timeline save without limit records null limit");
    assert.equal(payload.plan?.title, "Agent plan", "timeline save keeps recorder plan snapshot");
    assert.ok(
      logs.some((line) => line.includes("Saved 3 timeline events to")),
      "timeline save reports output path"
    );

    const limitedPath = join(tempRoot, "timeline-limited.json");
    await handleSlashCommand(
      `/timeline save ${limitedPath} 2`,
      {},
      undefined,
      tui,
      recorder
    );
    const limitedPayload = JSON.parse(readFileSync(limitedPath, "utf8")) as {
      limit: number | null;
      events: UITimelineEvent[];
    };
    assert.equal(limitedPayload.limit, 2, "timeline save records explicit limit");
    assert.deepEqual(
      limitedPayload.events.map((event) => event.id),
      ["tui-1", "tui-2"],
      "timeline save limit exports bounded tail"
    );

    const copyMessages: string[] = [];
    const copyTui = {
      getTimelineEvents: () => [tuiLog, laterTuiTask],
      getToolSnapshot: () => ({
        id: "tool-copy",
        name: "run_command",
        status: "success",
        summary: "$ npm test",
        output: "copyable output",
      }),
      appendSystemMessage: (message: string) => copyMessages.push(message),
    } as unknown as ChatAdapter;
    const toolExportPath = join(tempRoot, "tool.json");
    await handleSlashCommand(
      `/copy export tool ${toolExportPath}`,
      {},
      undefined,
      copyTui,
      recorder
    );
    const toolPayload = JSON.parse(readFileSync(toolExportPath, "utf8")) as { id?: string; output?: string };
    assert.equal(toolPayload.id, "tool-copy", "/copy export tool writes selected tool snapshot");
    assert.equal(toolPayload.output, "copyable output", "/copy export tool preserves output");
    assert.ok(
      copyMessages.some((message) => message.includes("Exported tool run_command")),
      "/copy export tool reports output path"
    );

    const copyTimelinePath = join(tempRoot, "copy-timeline.json");
    await handleSlashCommand(
      `/copy export timeline ${copyTimelinePath} 1`,
      {},
      undefined,
      copyTui,
      recorder
    );
    const copyTimelinePayload = JSON.parse(readFileSync(copyTimelinePath, "utf8")) as {
      limit: number;
      events: UITimelineEvent[];
    };
    assert.equal(copyTimelinePayload.limit, 1, "/copy export timeline records limit");
    assert.equal(copyTimelinePayload.events.length, 1, "/copy export timeline writes bounded slice");
  } finally {
    console.log = originalLog;
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

console.log("timeline merge verification passed");
