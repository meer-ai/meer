import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

export interface SessionHeader {
  type: "session";
  version: 3;
  id: string;
  createdAt: string;
  cwd: string;
  parentSessionId?: string;
  branchRootSessionId?: string;
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
    queueAction?: "queued" | "delivered";
    queueMode?: "steer" | "followUp";
    summaryKind?: "branch_summary" | "compaction";
    sourceSessionId?: string;
    branchRootSessionId?: string;
  };
}

export interface SessionCompactionEntry {
  type: "compaction";
  timestamp: number;
  summary: string;
  firstKeptTimestamp: number | null;
  summarizedMessageCount: number;
  tokensBefore: number;
}

export type SessionEntry =
  | SessionHeader
  | SessionMessageEntry
  | SessionCompactionEntry;

export interface SessionFileInfo {
  id: string;
  path: string;
  cwd: string;
  createdAt: string;
  messageCount: number;
  parentSessionId?: string;
  branchRootSessionId?: string;
  branchDepth?: number;
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

  private createSessionFile(
    cwd: string,
    parentSessionId?: string,
    branchRootSessionId?: string
  ): SessionFileInfo {
    const sessionId = randomUUID();
    const createdAt = new Date().toISOString();
    const projectDir = this.getProjectSessionsPath(cwd);
    mkdirSync(projectDir, { recursive: true });

    const filename = `${createdAt.replace(/[:.]/g, "-")}_${sessionId}.jsonl`;
    const path = join(projectDir, filename);
    const header: SessionHeader = {
      type: "session",
      version: 3,
      id: sessionId,
      createdAt,
      cwd,
      parentSessionId,
      branchRootSessionId,
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
      branchRootSessionId,
      branchDepth: parentSessionId ? 1 : 0,
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

    const branchRootSessionId =
      sourceHeader.branchRootSessionId ?? sourceHeader.id;
    const forked = this.createSessionFile(
      targetCwd,
      sourceHeader.id,
      branchRootSessionId
    );
    const messageEntries = sourceEntries.filter(
      (entry): entry is SessionMessageEntry => entry.type === "message"
    );
    const summary = this.buildBranchSummary(sourceHeader.id, messageEntries);
    if (summary) {
      this.appendMessage(
        {
          timestamp: Date.now(),
          role: "system",
          content: summary,
          metadata: {
            summaryKind: "branch_summary",
            sourceSessionId: sourceHeader.id,
            branchRootSessionId,
          },
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

    this.appendEntry(payload, cwd);
  }

  compactSession(
    sessionPath: string,
    options?: { keepRecentMessages?: number }
  ): SessionCompactionEntry | null {
    const info = this.getSessionInfoByPath(sessionPath);
    if (!info) {
      return null;
    }

    const keepRecentMessages = Math.max(1, options?.keepRecentMessages ?? 12);
    const entries = this.loadSession(sessionPath);
    const { visibleMessages, latestCompaction } =
      this.getVisibleMessagesFromEntries(entries);

    if (visibleMessages.length <= keepRecentMessages) {
      return null;
    }

    const messagesToSummarize = visibleMessages.slice(0, -keepRecentMessages);
    const keptMessages = visibleMessages.slice(-keepRecentMessages);
    const firstKeptTimestamp = keptMessages[0]?.timestamp ?? null;
    const previousSummary = latestCompaction?.summary?.trim();
    const summary = this.buildCompactionSummary(
      messagesToSummarize,
      previousSummary || null
    );
    const tokensBefore = visibleMessages.reduce(
      (sum, message) => sum + message.content.length,
      0
    );

    const entry: SessionCompactionEntry = {
      type: "compaction",
      timestamp: Date.now(),
      summary,
      firstKeptTimestamp,
      summarizedMessageCount:
        (latestCompaction?.summarizedMessageCount ?? 0) +
        messagesToSummarize.length,
      tokensBefore,
    };

    this.appendRawEntry(sessionPath, entry);
    return entry;
  }

  getSessionContextStats(sessionPath: string): {
    visibleMessages: number;
    totalChars: number;
    summarizedMessages: number;
  } | null {
    const info = this.getSessionInfoByPath(sessionPath);
    if (!info) {
      return null;
    }
    const { visibleMessages, latestCompaction } = this.getVisibleMessagesFromEntries(
      this.loadSession(sessionPath)
    );
    return {
      visibleMessages: visibleMessages.length,
      totalChars: visibleMessages.reduce((sum, message) => sum + message.content.length, 0),
      summarizedMessages: latestCompaction?.summarizedMessageCount ?? 0,
    };
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
          branchRootSessionId: header.branchRootSessionId,
        });
      }
    }

    const byId = new Map(sessions.map((session) => [session.id, session]));
    for (const session of sessions) {
      let depth = 0;
      let cursor = session.parentSessionId ? byId.get(session.parentSessionId) : null;
      while (cursor) {
        depth += 1;
        cursor = cursor.parentSessionId ? byId.get(cursor.parentSessionId) : null;
      }
      session.branchDepth = depth;
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

    const entries = this.getVisibleMessagesFromEntries(
      this.loadSession(latest.path)
    ).visibleMessages;

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
    const latest = this.getLatestSession(cwd, {
      excludePath: options?.excludeCurrent ? this.currentSessionPath ?? undefined : undefined,
    });
    if (!latest) {
      return null;
    }
    const entries = this.loadSession(latest.path);
    const { visibleMessages, latestCompaction } =
      this.getVisibleMessagesFromEntries(entries);
    const messages =
      options?.maxMessages && visibleMessages.length > options.maxMessages
        ? visibleMessages.slice(-options.maxMessages)
        : visibleMessages;
    if (messages.length === 0 && !latestCompaction) {
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
      const prefix =
        message.metadata?.summaryKind === "branch_summary"
          ? "Branch summary"
          : role;
      return `${prefix}: ${message.content}`;
    });

    return [
      "Recent project conversation context from the last Meer session.",
      "Use it only when relevant and prioritize the current user request.",
      ...(latestCompaction
        ? [`Compaction summary: ${latestCompaction.summary}`]
        : []),
      ...lines,
    ].join("\n");
  }

  buildContextFromSessionPath(sessionPath: string, maxMessages = 8): string | null {
    const { visibleMessages, latestCompaction } = this.getVisibleMessagesFromEntries(
      this.loadSession(sessionPath)
    );

    if (visibleMessages.length === 0 && !latestCompaction) {
      return null;
    }

    const lines = visibleMessages.slice(-maxMessages).map((message) => {
      const role =
        message.role === "assistant"
          ? "Assistant"
          : message.role === "system"
          ? "System"
          : message.role === "tool"
          ? `Tool${message.metadata?.toolName ? ` (${message.metadata.toolName})` : ""}`
          : "User";
      const prefix =
        message.metadata?.summaryKind === "branch_summary"
          ? "Branch summary"
          : role;
      return `${prefix}: ${message.content}`;
    });

    return [
      "Session transcript context loaded from a selected Meer session.",
      "Use it only when relevant and prioritize the current user request.",
      ...(latestCompaction
        ? [`Compaction summary: ${latestCompaction.summary}`]
        : []),
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

    return this.getVisibleMessagesFromEntries(
      this.loadSession(this.currentSessionPath)
    ).visibleMessages;
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

    let branchDepth = 0;
    let cursorId = header.parentSessionId;
    while (cursorId) {
      const parent = this.listSessions(header.cwd).find(
        (session) => session.id === cursorId
      );
      if (!parent) {
        break;
      }
      branchDepth += 1;
      cursorId = parent.parentSessionId;
    }

    return {
      id: header.id,
      path: sessionPath,
      cwd: header.cwd,
      createdAt: header.createdAt,
      messageCount: entries.filter((entry) => entry.type === "message").length,
      parentSessionId: header.parentSessionId,
      branchRootSessionId: header.branchRootSessionId,
      branchDepth,
    };
  }

  private buildBranchSummary(
    sourceSessionId: string,
    entries: SessionMessageEntry[]
  ): string | null {
    const visibleEntries = entries.filter(
      (entry) =>
        !(entry.role === "system" && entry.metadata?.summaryKind === "branch_summary")
    );
    if (visibleEntries.length === 0) {
      return null;
    }

    const keptEntries = visibleEntries.slice(-10);
    const omitted = Math.max(0, visibleEntries.length - keptEntries.length);
    const lines = keptEntries.map((entry) => {
      const role =
        entry.role === "assistant"
          ? "Assistant"
          : entry.role === "tool"
          ? `Tool${entry.metadata?.toolName ? ` (${entry.metadata.toolName})` : ""}`
          : entry.role === "system"
          ? "System"
          : "User";
      const normalized = entry.content.replace(/\s+/g, " ").trim();
      const preview =
        normalized.length > 220 ? `${normalized.slice(0, 219).trim()}…` : normalized;
      return `- ${role}: ${preview}`;
    });

    const intro = [
      `Summary of parent branch session ${sourceSessionId.slice(0, 8)}.`,
      "This fork started from that session. Use this summary as durable branch context if prior details matter.",
    ];

    if (omitted > 0) {
      intro.push(`${omitted} earlier entries omitted from this compact branch summary.`);
    }

    return [...intro, ...lines].join("\n");
  }

  private deleteSessionFile(sessionPath: string): void {
    unlinkSync(sessionPath);
    if (sessionPath === this.currentSessionPath) {
      this.currentSessionPath = null;
      this.currentSessionId = null;
    }
  }

  private appendEntry(
    entry: SessionMessageEntry | SessionCompactionEntry,
    cwd = this.currentCwd ?? process.cwd()
  ): void {
    if (!this.currentSessionPath || this.currentCwd !== cwd) {
      this.startSession(cwd);
    }
    this.appendRawEntry(this.currentSessionPath as string, entry);
  }

  private appendRawEntry(
    sessionPath: string,
    entry: SessionMessageEntry | SessionCompactionEntry
  ): void {
    appendFileSync(sessionPath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  private getVisibleMessagesFromEntries(entries: SessionEntry[]): {
    visibleMessages: SessionMessageEntry[];
    latestCompaction: SessionCompactionEntry | null;
  } {
    const latestCompaction = [...entries]
      .reverse()
      .find(
        (entry): entry is SessionCompactionEntry => entry.type === "compaction"
      ) ?? null;

    const messages = entries.filter(
      (entry): entry is SessionMessageEntry => entry.type === "message"
    );

    if (!latestCompaction) {
      return { visibleMessages: messages, latestCompaction: null };
    }

    const visibleMessages =
      latestCompaction.firstKeptTimestamp == null
        ? []
        : messages.filter(
            (entry) => entry.timestamp >= latestCompaction.firstKeptTimestamp!
          );

    return { visibleMessages, latestCompaction };
  }

  private buildCompactionSummary(
    messages: SessionMessageEntry[],
    previousSummary: string | null
  ): string {
    const lines = messages.slice(-20).map((message) => {
      const role =
        message.role === "assistant"
          ? "Assistant"
          : message.role === "tool"
          ? `Tool${message.metadata?.toolName ? ` (${message.metadata.toolName})` : ""}`
          : message.role === "system"
          ? "System"
          : "User";
      const normalized = message.content.replace(/\s+/g, " ").trim();
      const preview =
        normalized.length > 200 ? `${normalized.slice(0, 199).trim()}…` : normalized;
      return `- ${role}: ${preview}`;
    });

    return [
      "Compacted conversation summary.",
      ...(previousSummary
        ? ["Previous summary context:", previousSummary]
        : []),
      `${messages.length} older messages were summarized and removed from active context.`,
      "Recent summarized highlights:",
      ...lines,
    ].join("\n");
  }
}
