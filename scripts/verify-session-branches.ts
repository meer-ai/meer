import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempHome = mkdtempSync(join(tmpdir(), "meer-session-branch-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const { Memory } = await import("@meer-ai/coding-agent/memory/index.js");

const memory = new Memory();

try {
  const cwd = join(tempHome, "project");
  mkdirSync(cwd, { recursive: true });

  const parent = memory.startSession(cwd);
  memory.addToSession({
    timestamp: 1,
    role: "user",
    content: "start work on auth bug",
  }, cwd);
  memory.addToSession({
    timestamp: 2,
    role: "assistant",
    content: "I'll inspect the auth flow.",
  }, cwd);
  memory.addToSession({
    timestamp: 3,
    role: "tool",
    content: "Tool: read_file\nResult:\nsrc/auth.ts",
    metadata: { toolName: "read_file" },
  }, cwd);
  memory.addToSession({
    timestamp: 4,
    role: "assistant",
    content: "The bug is likely in token refresh.",
  }, cwd);

  const forked = memory.forkSession(parent.sessionPath, cwd);
  assert(forked, "forked session should be created");

  const sessions = memory.listSessions(cwd);
  const child = sessions.find((session) => session.id === forked?.sessionId);
  assert(child, "child session should appear in session list");
  assert.equal(child?.parentSessionId, parent.sessionId);
  assert.equal(child?.branchRootSessionId, parent.sessionId);
  assert.equal(child?.branchDepth, 1);

  const childView = memory.loadSessionView(forked!.sessionPath);
  assert(childView, "child session view should load");
  assert.equal(childView?.parentSessionId, parent.sessionId);
  assert.equal(childView?.branchRootSessionId, parent.sessionId);
  assert.equal(childView?.branchDepth, 1);
  assert.equal(childView?.entries.length, 1, "child should contain compact branch summary only");

  const branchSummary = childView!.entries[0];
  assert.equal(branchSummary.role, "system");
  assert.equal(branchSummary.metadata?.summaryKind, "branch_summary");
  assert.equal(branchSummary.metadata?.sourceSessionId, parent.sessionId);
  assert.equal(branchSummary.metadata?.branchRootSessionId, parent.sessionId);
  assert.match(branchSummary.content, /Summary of parent branch session/);
  assert.match(branchSummary.content, /User: start work on auth bug/);
  assert.match(branchSummary.content, /Assistant: The bug is likely in token refresh/);

  const chatMessages = memory.loadChatMessages(forked!.sessionPath);
  assert.equal(chatMessages.length, 1);
  assert.equal(chatMessages[0]?.role, "system");
  assert.match(chatMessages[0]?.content ?? "", /^Branch summary:/);

  console.log("✅ Session branch summary behavior verified.");
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
