/**
 * Persistent project-trust store.
 *
 * Records, per project folder:
 *   - whether the user trusts the folder (gates command/extension execution)
 *   - an allowlist of commands the user chose to "always allow"
 *   - an allowlist of tool actions (delete_file, move_file, …) likewise
 *
 * Persisted to `~/.meer/trust.json`. All updates are immutable: methods read
 * the current snapshot, build a new object, and write it back — the in-memory
 * data is never mutated in place.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { homedir } from "os";
import { normalizeCommand, isCommandInAllowlist } from "./match.js";

export const TRUST_STORE_VERSION = 1;

/**
 * How the current session treats command/tool approval:
 *   - "trusted":    the folder is trusted; persisted allowlist is active and
 *                   "Always allow" decisions are written to disk.
 *   - "session":    trusted for this run only; "Always allow" lasts the session.
 *   - "restricted": the user declined trust; every command is prompted.
 */
export type TrustMode = "trusted" | "session" | "restricted";

export interface ProjectTrust {
  trusted: boolean;
  /** ISO timestamp of the most recent trust decision. */
  decidedAt: string;
  allowedCommands: string[];
  allowedTools: string[];
}

export interface TrustData {
  version: number;
  projects: Record<string, ProjectTrust>;
}

function emptyData(): TrustData {
  return { version: TRUST_STORE_VERSION, projects: {} };
}

function emptyProject(): ProjectTrust {
  return {
    trusted: false,
    decidedAt: new Date().toISOString(),
    allowedCommands: [],
    allowedTools: [],
  };
}

/** Canonical key for a project folder. */
export function projectKey(cwd: string): string {
  return resolve(cwd);
}

export class TrustStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? join(homedir(), ".meer", "trust.json");
  }

  private read(): TrustData {
    if (!existsSync(this.filePath)) {
      return emptyData();
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as Partial<TrustData>;
      if (!parsed || typeof parsed !== "object" || typeof parsed.projects !== "object") {
        return emptyData();
      }
      return {
        version: typeof parsed.version === "number" ? parsed.version : TRUST_STORE_VERSION,
        projects: parsed.projects as Record<string, ProjectTrust>,
      };
    } catch {
      // Corrupt or unreadable file: fail safe to an empty, untrusted state
      // rather than throwing and blocking the whole session.
      return emptyData();
    }
  }

  private write(data: TrustData): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  /** Immutably replace one project's record and persist. */
  private update(cwd: string, mutate: (current: ProjectTrust) => ProjectTrust): ProjectTrust {
    const key = projectKey(cwd);
    const data = this.read();
    const current = data.projects[key] ?? emptyProject();
    const next = mutate(current);
    this.write({
      ...data,
      projects: { ...data.projects, [key]: next },
    });
    return next;
  }

  getProject(cwd: string): ProjectTrust | undefined {
    return this.read().projects[projectKey(cwd)];
  }

  /** Whether the user has ever recorded a trust decision for this folder. */
  hasDecision(cwd: string): boolean {
    return this.getProject(cwd) !== undefined;
  }

  isTrusted(cwd: string): boolean {
    return this.getProject(cwd)?.trusted === true;
  }

  setTrusted(cwd: string, trusted: boolean): void {
    this.update(cwd, (current) => ({
      ...current,
      trusted,
      decidedAt: new Date().toISOString(),
    }));
  }

  isCommandAllowed(cwd: string, command: string): boolean {
    const project = this.getProject(cwd);
    if (!project) return false;
    return isCommandInAllowlist(command, project.allowedCommands);
  }

  allowCommand(cwd: string, command: string): void {
    const rule = normalizeCommand(command);
    if (!rule) return;
    this.update(cwd, (current) =>
      current.allowedCommands.includes(rule)
        ? current
        : { ...current, allowedCommands: [...current.allowedCommands, rule] }
    );
  }

  isToolAllowed(cwd: string, tool: string): boolean {
    const project = this.getProject(cwd);
    if (!project) return false;
    return project.allowedTools.includes(tool);
  }

  allowTool(cwd: string, tool: string): void {
    const name = tool.trim();
    if (!name) return;
    this.update(cwd, (current) =>
      current.allowedTools.includes(name)
        ? current
        : { ...current, allowedTools: [...current.allowedTools, name] }
    );
  }

  /** Forget all trust + allowlist state for a folder. */
  reset(cwd: string): void {
    const key = projectKey(cwd);
    const data = this.read();
    if (!(key in data.projects)) return;
    const nextProjects = { ...data.projects };
    delete nextProjects[key];
    this.write({ ...data, projects: nextProjects });
  }
}
