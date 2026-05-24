import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

export interface SessionHeader {
  type: "session";
  version: 1;
  id: string;
  createdAt: string;
  cwd: string;
  parentSessionId?: string;
}

export interface SessionMessageEntry {
  type: "message";
  timestamp: number;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  metadata?: {
    model?: string;
    provider?: string;
    tokens?: number;
    toolName?: string;
    isError?: boolean;
    toolCallId?: string;
    turnId?: string;
  };
}

export type SessionEntry = SessionHeader | SessionMessageEntry;

export interface SessionFileInfo {
  id: string;
  path: string;
  cwd: string;
  createdAt: string;
  messageCount: number;
  parentSessionId?: string;
}

function encodeCwd(cwd: string): string {
  return cwd
    .replace(/[:]/g, "")
    .replace(/[\\/]/g, "__")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

function parseSessionFile(content: string): SessionEntry[] {
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SessionEntry);
}

export class SessionStore {
  private readonly basePath: string;
  private readonly sessionsPath: string;
  private currentSessionPath: string | null = null;
  private currentSessionId: string | null = null;
  private currentCwd: string | null = null;

  constructor(basePath = join(homedir(), ".meer")) {
    this.basePath = basePath;
    this.sessionsPath = join(this.basePath, "sessions");
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    mkdirSync(this.sessionsPath, { recursive: true });
  }

  private getProjectSessionsPath(cwd: string): string {
    return join(this.sessionsPath, encodeCwd(cwd));
  }

  private createSessionFile(cwd: string, parentSessionId?: string): SessionFileInfo {
    const sessionId = randomUUID();
    const createdAt = new Date().toISOString();
    const projectDir = this.getProjectSessionsPath(cwd);
    mkdirSync(projectDir, { recursive: true });

    const filename = `${createdAt.replace(/[:.]/g, "-")}_${sessionId}.jsonl`;
    const path = join(projectDir, filename);
    const header: SessionHeader = {
      type: "session",
      version: 1,
      id: sessionId,
      createdAt,
      cwd,
      parentSessionId,
    };

    appendFileSync(path, `${JSON.stringify(header)}\n`, "utf8");

    this.currentSessionPath = path;
    this.currentSessionId = sessionId;
    this.currentCwd = cwd;

    return {
      id: sessionId,
      path,
      cwd,
      createdAt,
      messageCount: 0,
      parentSessionId,
    };
  }

  startSession(cwd: string): SessionFileInfo {
    return this.createSessionFile(cwd);
  }

  openSession(sessionPath: string): SessionFileInfo | null {
    const info = this.getSessionInfoByPath(sessionPath);
    if (!info) {
      return null;
    }

    this.currentSessionPath = sessionPath;
    this.currentSessionId = info.id;
    this.currentCwd = info.cwd;

    return info;
  }

  forkSession(sourcePath: string, targetCwd: string): SessionFileInfo | null {
    const sourceEntries = this.loadSession(sourcePath);
    const sourceHeader = sourceEntries[0];
    if (!sourceHeader || sourceHeader.type !== "session") {
      return null;
    }

    const forked = this.createSessionFile(targetCwd, sourceHeader.id);
    const messageEntries = sourceEntries.filter(
      (entry): entry is SessionMessageEntry => entry.type === "message"
    );

    for (const entry of messageEntries) {
      this.appendMessage(
        {
          timestamp: entry.timestamp,
          role: entry.role,
          content: entry.content,
          metadata: entry.metadata,
        },
        targetCwd
      );
    }

    return forked;
  }

  getCurrentSessionPath(): string | null {
    return this.currentSessionPath;
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  appendMessage(
    entry: Omit<SessionMessageEntry, "type">,
    cwd = this.currentCwd ?? process.cwd()
  ): void {
    if (!this.currentSessionPath || this.currentCwd !== cwd) {
      this.startSession(cwd);
    }

    const payload: SessionMessageEntry = {
      type: "message",
      ...entry,
    };

    appendFileSync(this.currentSessionPath as string, `${JSON.stringify(payload)}\n`, "utf8");
  }

  loadSession(sessionPath: string): SessionEntry[] {
    if (!existsSync(sessionPath)) {
      return [];
    }

    return parseSessionFile(readFileSync(sessionPath, "utf8"));
  }

  listSessions(cwd?: string): SessionFileInfo[] {
    const roots = cwd
      ? [this.getProjectSessionsPath(cwd)]
      : readdirSync(this.sessionsPath, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(this.sessionsPath, entry.name));

    const sessions: SessionFileInfo[] = [];

    for (const root of roots) {
      if (!existsSync(root)) continue;

      const files = readdirSync(root)
        .filter((name) => name.endsWith(".jsonl"))
        .sort()
        .reverse();

      for (const file of files) {
        const path = join(root, file);
        const entries = this.loadSession(path);
        if (entries.length === 0) continue;

        const [header, ...rest] = entries;
        if (header.type !== "session") continue;

        sessions.push({
          id: header.id,
          path,
          cwd: header.cwd,
          createdAt: header.createdAt,
          messageCount: rest.filter((entry) => entry.type === "message").length,
          parentSessionId: header.parentSessionId,
        });
      }
    }

    sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return sessions;
  }

  getLatestSession(cwd: string, options?: { excludePath?: string }): SessionFileInfo | null {
    const sessions = this.listSessions(cwd);
    return (
      sessions.find((session) => session.path !== options?.excludePath) ?? null
    );
  }

  loadLatestSessionMessages(
    cwd: string,
    options?: { excludeCurrent?: boolean; maxMessages?: number }
  ): SessionMessageEntry[] {
    const latest = this.getLatestSession(cwd, {
      excludePath: options?.excludeCurrent ? this.currentSessionPath ?? undefined : undefined,
    });

    if (!latest) {
      return [];
    }

    const entries = this.loadSession(latest.path)
      .filter((entry): entry is SessionMessageEntry => entry.type === "message");

    if (!options?.maxMessages || entries.length <= options.maxMessages) {
      return entries;
    }

    return entries.slice(-options.maxMessages);
  }

  resolveSession(query: string, cwd = process.cwd()): SessionFileInfo | null {
    if (query.includes("/") || query.includes("\\") || query.endsWith(".jsonl")) {
      return this.getSessionInfoByPath(query);
    }

    const local = this.listSessions(cwd).find((session) => session.id.startsWith(query));
    if (local) {
      return local;
    }

    return this.listSessions().find((session) => session.id.startsWith(query)) ?? null;
  }

  purgeSessions(cwd?: string): void {
    const sessions = this.listSessions(cwd);
    for (const session of sessions) {
      this.deleteSessionFile(session.path);
    }
  }

  purgeSessionFile(sessionPath: string): void {
    if (!existsSync(sessionPath)) {
      return;
    }
    this.deleteSessionFile(sessionPath);
  }

  buildRecentContext(
    cwd: string,
    options?: { excludeCurrent?: boolean; maxMessages?: number }
  ): string | null {
    const messages = this.loadLatestSessionMessages(cwd, options);
    if (messages.length === 0) {
      return null;
    }

    const lines = messages.map((message) => {
      const role =
        message.role === "assistant"
          ? "Assistant"
          : message.role === "system"
          ? "System"
          : message.role === "tool"
          ? `Tool${message.metadata?.toolName ? ` (${message.metadata.toolName})` : ""}`
          : "User";
      return `${role}: ${message.content}`;
    });

    return [
      "Recent project conversation context from the last Meer session.",
      "Use it only when relevant and prioritize the current user request.",
      ...lines,
    ].join("\n");
  }

  buildContextFromSessionPath(sessionPath: string, maxMessages = 8): string | null {
    const entries = this.loadSession(sessionPath)
      .filter((entry): entry is SessionMessageEntry => entry.type === "message");

    if (entries.length === 0) {
      return null;
    }

    const lines = entries.slice(-maxMessages).map((message) => {
      const role =
        message.role === "assistant"
          ? "Assistant"
          : message.role === "system"
          ? "System"
          : message.role === "tool"
          ? `Tool${message.metadata?.toolName ? ` (${message.metadata.toolName})` : ""}`
          : "User";
      return `${role}: ${message.content}`;
    });

    return [
      "Session transcript context loaded from a selected Meer session.",
      "Use it only when relevant and prioritize the current user request.",
      ...lines,
    ].join("\n");
  }

  getTotalMessageCount(): number {
    return this.listSessions().reduce((sum, session) => sum + session.messageCount, 0);
  }

  getDiskUsageBytes(cwd?: string): number {
    return this.listSessions(cwd).reduce((sum, session) => {
      if (!existsSync(session.path)) return sum;
      return sum + readFileSync(session.path, "utf8").length;
    }, 0);
  }

  getCurrentSessionEntries(): SessionMessageEntry[] {
    if (!this.currentSessionPath) {
      return [];
    }

    return this.loadSession(this.currentSessionPath).filter(
      (entry): entry is SessionMessageEntry => entry.type === "message"
    );
  }

  resolveViewSession(cwd = process.cwd()): SessionFileInfo | null {
    if (this.currentSessionPath && existsSync(this.currentSessionPath)) {
      const info = this.getSessionInfoByPath(this.currentSessionPath);
      if (info) {
        return info;
      }
    }

    return this.getLatestSession(cwd);
  }

  getSessionInfoByPath(sessionPath: string): SessionFileInfo | null {
    const entries = this.loadSession(sessionPath);
    const header = entries[0];
    if (!header || header.type !== "session") {
      return null;
    }

    return {
      id: header.id,
      path: sessionPath,
      cwd: header.cwd,
      createdAt: header.createdAt,
      messageCount: entries.filter((entry) => entry.type === "message").length,
      parentSessionId: header.parentSessionId,
    };
  }

  private deleteSessionFile(sessionPath: string): void {
    unlinkSync(sessionPath);
    if (sessionPath === this.currentSessionPath) {
      this.currentSessionPath = null;
      this.currentSessionId = null;
    }
  }
}
