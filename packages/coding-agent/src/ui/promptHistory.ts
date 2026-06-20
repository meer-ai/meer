import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

/** Shared on-disk location for prompt history (TUI + legacy readline input). */
export const DEFAULT_HISTORY_PATH = join(homedir(), ".meer", "history.log");

/** Max entries handed to the editor / readline on load. */
const DEFAULT_LOAD_LIMIT = 1000;

export interface PromptHistoryOptions {
  path?: string;
  loadLimit?: number;
}

/**
 * Persistent prompt history shared by the TUI editor and the legacy readline
 * input. Entries are stored as JSON-encoded lines so multi-line prompts survive
 * round-trips; legacy plain-text lines are still read for backward
 * compatibility. All disk access is best-effort and never throws — history is a
 * convenience, not a correctness requirement.
 */
export class PromptHistoryStore {
  private readonly path: string;
  private readonly loadLimit: number;
  private lastPersisted: string | null = null;

  constructor(options: PromptHistoryOptions = {}) {
    this.path = options.path ?? DEFAULT_HISTORY_PATH;
    this.loadLimit = options.loadLimit ?? DEFAULT_LOAD_LIMIT;
  }

  /**
   * Load persisted prompts newest-first (index 0 = most recent), collapsing
   * consecutive duplicates and capping to the configured load limit.
   */
  load(): string[] {
    let entries: string[];
    try {
      if (!existsSync(this.path)) return [];
      entries = readFileSync(this.path, "utf-8")
        .split("\n")
        .map((line) => this.decode(line))
        .filter((entry): entry is string => entry !== null);
    } catch {
      return [];
    }

    const deduped: string[] = [];
    for (const entry of entries) {
      if (deduped.length === 0 || deduped[deduped.length - 1] !== entry) {
        deduped.push(entry);
      }
    }

    this.lastPersisted = deduped[deduped.length - 1] ?? null;
    return deduped.slice(-this.loadLimit).reverse();
  }

  /** Append a prompt, skipping empties and consecutive duplicates. */
  append(entry: string): void {
    const trimmed = entry.trim();
    if (!trimmed || trimmed === this.lastPersisted) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(trimmed)}\n`);
      this.lastPersisted = trimmed;
    } catch {
      // Best-effort: never block input on a disk error.
    }
  }

  private decode(line: string): string | null {
    if (!line) return null;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === "string") {
        return parsed.trim().length > 0 ? parsed : null;
      }
    } catch {
      // Not JSON — fall through and treat as a legacy plain-text entry.
    }
    return line.trim().length > 0 ? line : null;
  }
}
