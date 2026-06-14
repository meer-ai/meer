/**
 * Lock down the project-trust store and command-allowlist matching contract.
 *
 * Guarantees:
 *   - Allowlist matching is EXACT (normalized) — never prefix/fuzzy, so an
 *     allowed `npm test` does not also permit `npm test && rm -rf /`.
 *   - Whitespace-only differences do not force a re-prompt.
 *   - Trust + allowlist state persists across store instances (same file).
 *   - Updates are immutable and a corrupt file fails safe to "untrusted".
 *   - reset() forgets a folder entirely.
 */

import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { normalizeCommand, isCommandInAllowlist } from "../src/trust/match.js";
import { TrustStore } from "../src/trust/store.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "meer-trust-"));
const storeFile = join(tmp, "trust.json");
const PROJECT = "/Users/example/Code/widget";

try {
  // --- normalizeCommand ----------------------------------------------------
  {
    assert(normalizeCommand("  npm   test  ") === "npm test", "collapses whitespace");
    assert(normalizeCommand("npm\ttest") === "npm test", "tabs become single space");
    assert(normalizeCommand("") === "", "empty stays empty");
  }

  // --- isCommandInAllowlist: exact only ------------------------------------
  {
    const rules = ["npm test", "git status"];
    assert(isCommandInAllowlist("npm test", rules), "exact match allowed");
    assert(isCommandInAllowlist(" npm  test ", rules), "whitespace-insensitive match");
    assert(!isCommandInAllowlist("npm test && rm -rf /", rules), "prefix NOT allowed");
    assert(!isCommandInAllowlist("npm testx", rules), "superstring NOT allowed");
    assert(!isCommandInAllowlist("", rules), "empty command never allowed");
  }

  // --- default state: nothing trusted, no decision -------------------------
  {
    const store = new TrustStore(storeFile);
    assert(!store.hasDecision(PROJECT), "no decision initially");
    assert(!store.isTrusted(PROJECT), "untrusted initially");
    assert(!store.isCommandAllowed(PROJECT, "npm test"), "no commands allowed initially");
  }

  // --- setTrusted + persistence across instances ---------------------------
  {
    const store = new TrustStore(storeFile);
    store.setTrusted(PROJECT, true);
    assert(store.hasDecision(PROJECT), "decision recorded");

    const reopened = new TrustStore(storeFile);
    assert(reopened.isTrusted(PROJECT), "trust persists across instances");
  }

  // --- command allowlist persists + immutable accumulation -----------------
  {
    const store = new TrustStore(storeFile);
    store.allowCommand(PROJECT, "  npm   run build ");
    assert(store.isCommandAllowed(PROJECT, "npm run build"), "allowed command matches normalized");
    store.allowCommand(PROJECT, "npm run build"); // duplicate, should not double-add
    const project = store.getProject(PROJECT);
    assert(
      project?.allowedCommands.filter((c) => c === "npm run build").length === 1,
      "no duplicate allowlist entries"
    );

    const reopened = new TrustStore(storeFile);
    assert(reopened.isCommandAllowed(PROJECT, "npm run build"), "command allowlist persists");
    assert(!reopened.isCommandAllowed(PROJECT, "npm run build --prod"), "extra args re-prompt");
  }

  // --- tool allowlist ------------------------------------------------------
  {
    const store = new TrustStore(storeFile);
    assert(!store.isToolAllowed(PROJECT, "delete_file"), "tool not allowed initially");
    store.allowTool(PROJECT, "delete_file");
    assert(store.isToolAllowed(PROJECT, "delete_file"), "tool allowed after grant");
    assert(!store.isToolAllowed(PROJECT, "move_file"), "other tools unaffected");
  }

  // --- reset forgets everything --------------------------------------------
  {
    const store = new TrustStore(storeFile);
    store.reset(PROJECT);
    assert(!store.hasDecision(PROJECT), "decision cleared after reset");
    assert(!store.isCommandAllowed(PROJECT, "npm run build"), "commands cleared after reset");
    assert(!store.isToolAllowed(PROJECT, "delete_file"), "tools cleared after reset");
  }

  // --- corrupt file fails safe to untrusted --------------------------------
  {
    const corruptFile = join(tmp, "corrupt.json");
    writeFileSync(corruptFile, "{ this is not valid json", "utf-8");
    const store = new TrustStore(corruptFile);
    assert(!store.isTrusted(PROJECT), "corrupt file -> untrusted");
    assert(!store.hasDecision(PROJECT), "corrupt file -> no decision");
    // and it can recover by writing fresh state
    store.setTrusted(PROJECT, true);
    assert(new TrustStore(corruptFile).isTrusted(PROJECT), "recovers after corrupt read");
  }

  console.log("verify-trust-store: all assertions passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
