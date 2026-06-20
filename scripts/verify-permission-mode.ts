/**
 * Verifies the Shift+Tab permission modes drive the agent's approval logic:
 *   - normal:      prompt before edits and non-safe commands
 *   - auto-accept: auto-apply edits; commands follow launch approvals/trust
 *   - plan:        read-only — edits and mutating commands blocked
 *
 * The approval methods are private; we reach them via a cast, the same
 * pragmatic approach used by the other verify-* scripts.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeerAgent, type PermissionMode } from "@meer/coding-agent/agent/meer-agent.js";
import { TrustStore } from "@meer/coding-agent/trust/store.js";

const dir = mkdtempSync(join(tmpdir(), "meer-perm-"));

function stubChoice(returnValue: string) {
  const calls: string[] = [];
  const fn = async (message: string) => {
    calls.push(message);
    return returnValue;
  };
  return { fn, calls };
}

function makeAgent(opts: {
  approvalsEnabled?: boolean;
  choiceReturns?: string;
}) {
  const choice = stubChoice(opts.choiceReturns ?? "apply");
  const agent = new MeerAgent({
    provider: {} as never,
    cwd: dir,
    trustStore: new TrustStore(join(dir, `trust-${Math.random()}.json`)),
    trustMode: "trusted",
    approvalsEnabled: opts.approvalsEnabled ?? false,
    promptChoice: choice.fn,
  });
  return { agent: agent as any, choice };
}

const edit = {
  path: join(dir, "file.ts"),
  oldContent: "a\n",
  newContent: "b\n",
  description: "change",
};

try {
  // --- Default mode derives from launch approvals flag ---
  {
    const { agent } = makeAgent({ approvalsEnabled: true });
    assert.equal(
      (agent as { getPermissionMode(): PermissionMode }).getPermissionMode(),
      "normal"
    );
    const { agent: agent2 } = makeAgent({ approvalsEnabled: false });
    assert.equal(
      (agent2 as { getPermissionMode(): PermissionMode }).getPermissionMode(),
      "auto-accept"
    );
  }

  // --- normal: edits prompt; Apply → applied, Skip → not applied ---
  {
    const { agent, choice } = makeAgent({ choiceReturns: "apply" });
    agent.setPermissionMode("normal");
    assert.equal(await agent.reviewFileEdit(edit), true);
    assert.equal(choice.calls.length, 1);

    const skip = makeAgent({ choiceReturns: "skip" });
    skip.agent.setPermissionMode("normal");
    assert.equal(await skip.agent.reviewFileEdit(edit), false);
    assert.equal(skip.choice.calls.length, 1);
  }

  // --- auto-accept: edits apply WITHOUT prompting ---
  {
    const { agent, choice } = makeAgent({ choiceReturns: "skip" });
    agent.setPermissionMode("auto-accept");
    assert.equal(await agent.reviewFileEdit(edit), true);
    assert.equal(choice.calls.length, 0);
  }

  // --- plan: edits are blocked (throws), no prompt ---
  {
    const { agent, choice } = makeAgent({});
    agent.setPermissionMode("plan");
    await assert.rejects(() => agent.reviewFileEdit(edit), /read-only/);
    assert.equal(choice.calls.length, 0);
  }

  // --- plan: non-safe commands blocked, safe commands allowed ---
  {
    const { agent, choice } = makeAgent({ choiceReturns: "run" });
    agent.setPermissionMode("plan");
    assert.equal(await agent.confirmCommand("mkdir foo"), false); // risk: normal
    assert.equal(await agent.confirmCommand("ls -la"), true); // risk: safe
    assert.equal(choice.calls.length, 0, "plan never prompts for commands");
  }

  // --- normal: non-safe command prompts even when launched without approvals ---
  {
    const { agent, choice } = makeAgent({
      approvalsEnabled: false,
      choiceReturns: "run",
    });
    agent.setPermissionMode("normal");
    assert.equal(await agent.confirmCommand("mkdir foo"), true);
    assert.equal(choice.calls.length, 1, "normal forces command prompting");
  }

  // --- auto-accept (launched without approvals): non-safe command runs freely ---
  {
    const { agent, choice } = makeAgent({
      approvalsEnabled: false,
      choiceReturns: "cancel",
    });
    agent.setPermissionMode("auto-accept");
    assert.equal(await agent.confirmCommand("mkdir foo"), true);
    assert.equal(
      choice.calls.length,
      0,
      "auto-accept preserves frictionless commands when launched without approvals"
    );
  }

  // --- plan: mutating tool actions blocked ---
  {
    const { agent } = makeAgent({});
    agent.setPermissionMode("plan");
    assert.equal(await agent.confirmToolAction("delete_file", "Delete x"), false);
  }

  console.log("verify-permission-mode: all assertions passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
