/**
 * Resilient, versioned parsing for session JSONL files.
 *
 * Session files are append-only JSONL. Two failure modes must never take down a
 * session load (or, via listSessions, ALL sessions):
 *   1. A corrupt / partially-written line (e.g. the process was killed mid-append).
 *   2. An entry written by a newer/older meer with an unknown shape or version.
 *
 * parseSessionEntries skips unparseable or unknown lines instead of throwing,
 * and routes every recognized entry through migrateSessionEntry so older files
 * are upgraded to the current shape on read.
 */

import type { SessionEntry } from "./store.js";

export const CURRENT_SESSION_VERSION = 3;

const KNOWN_ENTRY_TYPES = new Set(["session", "message", "compaction", "plan"]);

/**
 * Forward-migrate a single entry from the file's declared version to the
 * current version. meer's shipped entry types (v1–v3) are structurally
 * compatible, so this is currently an identity transform — but it is the seam
 * where future field backfills live, e.g.:
 *
 *   if (fromVersion < 4 && entry.type === "message") {
 *     return { ...entry, metadata: { ...entry.metadata, turnId: entry.metadata?.turnId ?? "" } };
 *   }
 *
 * Returns null to drop an entry that cannot be migrated.
 */
export function migrateSessionEntry(
  entry: SessionEntry,
  _fromVersion: number
): SessionEntry | null {
  return entry;
}

/** True when a parsed object looks like a session entry we understand. */
function isKnownEntry(value: unknown): value is SessionEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string" &&
    KNOWN_ENTRY_TYPES.has((value as { type: string }).type)
  );
}

/**
 * Parse a session JSONL file body into entries, skipping any corrupt or
 * unrecognized lines and migrating recognized ones to the current version.
 */
export function parseSessionEntries(content: string): SessionEntry[] {
  const entries: SessionEntry[] = [];
  // Default to current; the header (first line) refines this for the rest.
  let fileVersion = CURRENT_SESSION_VERSION;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Partial/corrupt line — skip it rather than failing the whole load.
      continue;
    }

    if (!isKnownEntry(parsed)) continue;

    if (parsed.type === "session") {
      const v = (parsed as { version?: unknown }).version;
      if (typeof v === "number") fileVersion = v;
    }

    const migrated = migrateSessionEntry(parsed, fileVersion);
    if (migrated) entries.push(migrated);
  }

  return entries;
}
