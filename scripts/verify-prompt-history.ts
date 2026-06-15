import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptHistoryStore } from "../src/ui/promptHistory.js";

const dir = mkdtempSync(join(tmpdir(), "meer-history-"));
const path = join(dir, "history.log");

try {
  // --- Empty / missing file loads as [] ---
  {
    const store = new PromptHistoryStore({ path });
    assert.deepEqual(store.load(), []);
  }

  // --- Append persists and loads newest-first ---
  {
    const store = new PromptHistoryStore({ path });
    store.append("first");
    store.append("second");
    store.append("third");
    const reloaded = new PromptHistoryStore({ path }).load();
    assert.deepEqual(reloaded, ["third", "second", "first"]);
  }

  // --- Empty and consecutive-duplicate entries are skipped ---
  {
    rmSync(path, { force: true });
    const store = new PromptHistoryStore({ path });
    store.append("a");
    store.append("a"); // consecutive dup → skipped
    store.append("   "); // whitespace-only → skipped
    store.append("b");
    store.append("a"); // non-consecutive dup → kept
    assert.deepEqual(store.load(), ["a", "b", "a"]);
  }

  // --- Multi-line prompts survive a round-trip ---
  {
    rmSync(path, { force: true });
    const multiline = "line one\nline two\n  indented three";
    const store = new PromptHistoryStore({ path });
    store.append(multiline);
    assert.deepEqual(new PromptHistoryStore({ path }).load(), [multiline]);
  }

  // --- Legacy plain-text lines are still readable ---
  {
    rmSync(path, { force: true });
    writeFileSync(path, "legacy one\nlegacy two\n");
    const store = new PromptHistoryStore({ path });
    assert.deepEqual(store.load(), ["legacy two", "legacy one"]);
    // Appending after a legacy load keeps dedup state correct.
    store.append("legacy two"); // equals last persisted → skipped
    store.append("fresh");
    assert.deepEqual(new PromptHistoryStore({ path }).load(), [
      "fresh",
      "legacy two",
      "legacy one",
    ]);
  }

  // --- loadLimit caps how many entries come back (newest kept) ---
  {
    rmSync(path, { force: true });
    const store = new PromptHistoryStore({ path });
    for (let i = 0; i < 10; i++) store.append(`entry-${i}`);
    const limited = new PromptHistoryStore({ path, loadLimit: 3 }).load();
    assert.deepEqual(limited, ["entry-9", "entry-8", "entry-7"]);
  }

  // --- New entries are JSON-encoded on disk (multiline-safe format) ---
  {
    rmSync(path, { force: true });
    new PromptHistoryStore({ path }).append("hello");
    assert.equal(readFileSync(path, "utf-8"), '"hello"\n');
  }

  console.log("verify-prompt-history: all assertions passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
