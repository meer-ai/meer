/**
 * Lock down resilient + versioned session JSONL parsing.
 *
 * Guarantees:
 *   - A corrupt / partially-written line is skipped, NOT thrown — one bad line
 *     must never nuke a session load (or, via listSessions, every session).
 *   - Unknown entry types (written by a newer meer) are skipped, not mis-cast.
 *   - Blank lines are ignored.
 *   - Well-formed entries round-trip unchanged (migration is identity for v3).
 *   - Older-version headers are accepted (version is read, entries migrated).
 */

import { parseSessionEntries, migrateSessionEntry, CURRENT_SESSION_VERSION } from "../src/session/migrate.js";
import type { SessionEntry } from "../src/session/store.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

const header = JSON.stringify({
  type: "session",
  version: CURRENT_SESSION_VERSION,
  id: "abc",
  createdAt: "2026-01-01T00:00:00.000Z",
  cwd: "/tmp/x",
});
const msg = (content: string) =>
  JSON.stringify({ type: "message", timestamp: 1, role: "user", content });

// --- happy path ------------------------------------------------------------
{
  const content = [header, msg("hello"), msg("world")].join("\n");
  const entries = parseSessionEntries(content);
  assert(entries.length === 3, `expected 3 entries, got ${entries.length}`);
  assert(entries[0].type === "session", "first entry is the header");
  assert(
    entries[1].type === "message" && (entries[1] as { content: string }).content === "hello",
    "message content preserved"
  );
}

// --- corrupt line is skipped, not thrown -----------------------------------
{
  const content = [
    header,
    msg("before"),
    "{ this is not valid json", // simulated interrupted append
    msg("after"),
  ].join("\n");
  let entries: SessionEntry[] = [];
  // Must not throw.
  entries = parseSessionEntries(content);
  assert(entries.length === 3, `corrupt line skipped → 3 entries, got ${entries.length}`);
  const contents = entries
    .filter((e) => e.type === "message")
    .map((e) => (e as { content: string }).content);
  assert(
    contents.includes("before") && contents.includes("after"),
    "messages around the corrupt line survive"
  );
}

// --- unknown entry type skipped --------------------------------------------
{
  const futureEntry = JSON.stringify({ type: "branch_summary_v9", timestamp: 2, blob: {} });
  const content = [header, futureEntry, msg("ok")].join("\n");
  const entries = parseSessionEntries(content);
  assert(entries.length === 2, `unknown type dropped → 2 entries, got ${entries.length}`);
  assert(
    !entries.some((e) => (e as { type: string }).type === "branch_summary_v9"),
    "unknown entry not included"
  );
}

// --- blank lines + trailing newline ----------------------------------------
{
  const content = `${header}\n\n${msg("x")}\n\n`;
  const entries = parseSessionEntries(content);
  assert(entries.length === 2, `blank lines ignored → 2 entries, got ${entries.length}`);
}

// --- empty input -----------------------------------------------------------
{
  assert(parseSessionEntries("").length === 0, "empty content → no entries");
  assert(parseSessionEntries("\n\n").length === 0, "whitespace-only → no entries");
}

// --- older-version header still loads --------------------------------------
{
  const oldHeader = JSON.stringify({
    type: "session",
    version: 1,
    id: "old",
    createdAt: "2025-01-01T00:00:00.000Z",
    cwd: "/tmp/x",
  });
  const entries = parseSessionEntries([oldHeader, msg("legacy")].join("\n"));
  assert(entries.length === 2, "v1 file loads");
  assert(entries[0].type === "session", "v1 header preserved");
}

// --- migrateSessionEntry is identity for current entries -------------------
{
  const entry = JSON.parse(msg("same")) as SessionEntry;
  const migrated = migrateSessionEntry(entry, CURRENT_SESSION_VERSION);
  assert(JSON.stringify(migrated) === JSON.stringify(entry), "v3 entry unchanged by migration");
}

console.log("verify-session-migrate: all assertions passed");
