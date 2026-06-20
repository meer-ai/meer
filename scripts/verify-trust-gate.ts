/**
 * Lock down the first-run project-trust gate (resolveTrustMode).
 *
 * Rules:
 *   - A folder with a prior decision is NEVER re-prompted:
 *       trusted  -> "trusted", untrusted -> "restricted".
 *   - A new folder with no interactive chooser defaults to "trusted"
 *     (headless behavior) and is not persisted.
 *   - A new folder prompts once; the choice maps to a mode and persists
 *     for "trust"/"no" but NOT for "once".
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TrustStore } from "@meer/coding-agent/trust/store.js";
import { resolveTrustMode } from "@meer/coding-agent/trust/gate.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "meer-trust-gate-"));
const PROJECT = "/Users/example/Code/widget";

function freshStore(name: string): TrustStore {
  return new TrustStore(join(tmp, `${name}.json`));
}

/** A promptChoice stub that records calls and returns a fixed value. */
function stubChoice(returnValue: string) {
  const calls: string[] = [];
  const fn = async (message: string) => {
    calls.push(message);
    return returnValue;
  };
  return { fn, calls };
}

try {
  // --- prior decision: trusted -> "trusted", no prompt ---------------------
  {
    const store = freshStore("trusted");
    store.setTrusted(PROJECT, true);
    const choice = stubChoice("no");
    const mode = await resolveTrustMode({ cwd: PROJECT, store, promptChoice: choice.fn });
    assert(mode === "trusted", "prior-trusted resolves trusted");
    assert(choice.calls.length === 0, "prior-trusted does not prompt");
  }

  // --- prior decision: untrusted -> "restricted", no prompt ----------------
  {
    const store = freshStore("untrusted");
    store.setTrusted(PROJECT, false);
    const choice = stubChoice("trust");
    const mode = await resolveTrustMode({ cwd: PROJECT, store, promptChoice: choice.fn });
    assert(mode === "restricted", "prior-untrusted resolves restricted");
    assert(choice.calls.length === 0, "prior-untrusted does not prompt");
  }

  // --- new folder, no chooser (headless) -> trusted, not persisted ---------
  {
    const store = freshStore("headless");
    const mode = await resolveTrustMode({ cwd: PROJECT, store });
    assert(mode === "trusted", "headless new folder -> trusted");
    assert(!store.hasDecision(PROJECT), "headless does not persist a decision");
  }

  // --- new folder, choose "trust" -> trusted + persisted -------------------
  {
    const store = freshStore("choose-trust");
    const choice = stubChoice("trust");
    const mode = await resolveTrustMode({ cwd: PROJECT, store, promptChoice: choice.fn });
    assert(mode === "trusted", "choose trust -> trusted");
    assert(choice.calls.length === 1, "prompted exactly once");
    assert(store.isTrusted(PROJECT), "trust decision persisted");
  }

  // --- new folder, choose "no" -> restricted + persisted -------------------
  {
    const store = freshStore("choose-no");
    const choice = stubChoice("no");
    const mode = await resolveTrustMode({ cwd: PROJECT, store, promptChoice: choice.fn });
    assert(mode === "restricted", "choose no -> restricted");
    assert(store.hasDecision(PROJECT), "no decision persisted");
    assert(!store.isTrusted(PROJECT), "persisted as untrusted");
  }

  // --- new folder, choose "once" -> session, NOT persisted -----------------
  {
    const store = freshStore("choose-once");
    const choice = stubChoice("once");
    const mode = await resolveTrustMode({ cwd: PROJECT, store, promptChoice: choice.fn });
    assert(mode === "session", "choose once -> session");
    assert(!store.hasDecision(PROJECT), "trust-once is not persisted");
  }

  console.log("verify-trust-gate: all assertions passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
