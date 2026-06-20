import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempHome = mkdtempSync(join(tmpdir(), "meer-session-compaction-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const { Memory } = await import("@meer/coding-agent/memory/index.js");

const memory = new Memory();

try {
  const cwd = join(tempHome, "project");
  mkdirSync(cwd, { recursive: true });
  const session = memory.startSession(cwd);

  const entries = [
    { role: "user" as const, content: "message 1" },
    { role: "assistant" as const, content: "message 2" },
    { role: "user" as const, content: "message 3" },
    { role: "assistant" as const, content: "message 4" },
    { role: "user" as const, content: "message 5" },
    { role: "assistant" as const, content: "message 6" },
  ];

  entries.forEach((entry, index) => {
    memory.addToSession(
      {
        timestamp: index + 1,
        role: entry.role,
        content: entry.content,
      },
      cwd
    );
  });

  const compaction = await memory.compactCurrentSession(cwd, {
    keepRecentMessages: 2,
    summaryGenerator: () =>
      [
        "## Task State",
        "- Session compacted by custom summarizer.",
        "",
        "## Findings",
        "- message 1 and message 2 were summarized.",
        "",
        "## Files Touched",
        "- None yet.",
        "",
        "## Next Steps",
        "- Continue with recent messages.",
      ].join("\n"),
  });
  assert(compaction, "compaction should be created");
  assert.equal(compaction?.summarizedMessageCount, 4);
  assert.equal(compaction?.firstKeptTimestamp, 5);

  const sessionView = memory.loadSessionView(session.sessionPath);
  assert(sessionView, "session view should load");
  const compactionEntries = sessionView!.entries.filter(
    (entry) => entry.metadata?.summaryKind === "compaction"
  );
  assert.equal(compactionEntries.length, 1);
  assert.match(compactionEntries[0]?.content ?? "", /## Task State/);
  assert.match(compactionEntries[0]?.content ?? "", /custom summarizer/);

  const context = memory.buildSessionContext(session.sessionPath, 4);
  assert(context, "context should build");
  assert.match(context ?? "", /Compaction summary:/);
  assert.match(context ?? "", /message 5/);
  assert.match(context ?? "", /message 6/);

  const visibleEntries = memory
    .loadCurrentSession(cwd)
    .filter((entry) => entry.role !== "system" || entry.metadata?.summaryKind !== "compaction")
    .map((entry) => entry.content);
  assert.deepEqual(visibleEntries.slice(-2), ["message 5", "message 6"]);

  const chatMessages = memory.loadChatMessages(session.sessionPath);
  const systemMessages = chatMessages.filter((entry) => entry.role === "system");
  assert(systemMessages.some((entry) => entry.content.startsWith("Compaction summary:\n")));

  memory.addToSession(
    {
      timestamp: 7,
      role: "user",
      content: "message 7",
    },
    cwd
  );
  memory.addToSession(
    {
      timestamp: 8,
      role: "assistant",
      content: "message 8",
    },
    cwd
  );
  memory.addToSession(
    {
      timestamp: 9,
      role: "user",
      content: "message 9",
    },
    cwd
  );

  const secondCompaction = await memory.compactCurrentSession(cwd, {
    keepRecentMessages: 2,
    summaryGenerator: () => {
      throw new Error("forced fallback");
    },
  });
  assert(secondCompaction, "second compaction should be created");
  assert.equal(secondCompaction?.summarizedMessageCount, 7);
  assert.match(secondCompaction?.summary ?? "", /## Task State/);
  assert.match(secondCompaction?.summary ?? "", /message 7/);

  const updatedStats = memory.getCurrentSessionContextStats(cwd);
  assert(updatedStats, "context stats should be available");
  assert.equal(updatedStats?.visibleMessages, 2);
  assert.equal(updatedStats?.summarizedMessages, 7);

  console.log("✅ Session compaction behavior verified.");
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
