import { basename } from "path";
import {
  SessionStore,
  type CompactSessionOptions,
  type SessionMessageEntry,
  type SessionCompactionEntry,
} from "../session/store.js";
import type { ChatMessage } from "../providers/base.js";

export interface ConversationEntry {
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

export interface MemoryStats {
  sessionCount: number;
  totalMessages: number;
  longtermFacts: number;
  diskUsage: string;
}

export interface SessionView {
  sessionId: string;
  sessionPath: string;
  sessionLabel: string;
  entries: ConversationEntry[];
  parentSessionId?: string;
  branchRootSessionId?: string;
  branchDepth?: number;
}

export class Memory {
  private readonly store: SessionStore;

  constructor(store = new SessionStore()) {
    this.store = store;
  }

  startSession(cwd = process.cwd()): { sessionId: string; sessionPath: string } {
    const session = this.store.startSession(cwd);
    return {
      sessionId: session.id,
      sessionPath: session.path,
    };
  }

  resumeSession(sessionPath: string): { sessionId: string; sessionPath: string } | null {
    const session = this.store.openSession(sessionPath);
    if (!session) {
      return null;
    }
    return {
      sessionId: session.id,
      sessionPath: session.path,
    };
  }

  forkSession(sourcePath: string, cwd = process.cwd()): { sessionId: string; sessionPath: string } | null {
    const session = this.store.forkSession(sourcePath, cwd);
    if (!session) {
      return null;
    }
    return {
      sessionId: session.id,
      sessionPath: session.path,
    };
  }

  addToSession(entry: ConversationEntry, cwd = process.cwd()): void {
    this.store.appendMessage(entry, cwd);
  }

  loadCurrentSession(cwd = process.cwd()): ConversationEntry[] {
    const active = this.store.resolveViewSession(cwd);
    if (!active) {
      return [];
    }

    return this.mapEntriesForView(this.store.loadSession(active.path));
  }

  loadCurrentSessionView(cwd = process.cwd()): SessionView | null {
    const active = this.store.resolveViewSession(cwd);
    if (!active) {
      return null;
    }

    return {
      sessionId: active.id,
      sessionPath: active.path,
      sessionLabel: basename(active.path),
      entries: this.loadCurrentSession(cwd),
      parentSessionId: active.parentSessionId,
      branchRootSessionId: active.branchRootSessionId,
      branchDepth: active.branchDepth,
    };
  }

  loadSessionView(sessionPath: string): SessionView | null {
    const session = this.store.getSessionInfoByPath(sessionPath);
    if (!session) {
      return null;
    }

    return {
      sessionId: session.id,
      sessionPath: session.path,
      sessionLabel: basename(session.path),
      entries: this.mapEntriesForView(this.store.loadSession(session.path)),
      parentSessionId: session.parentSessionId,
      branchRootSessionId: session.branchRootSessionId,
      branchDepth: session.branchDepth,
    };
  }

  loadChatMessages(sessionPath: string, options?: { maxMessages?: number }): ChatMessage[] {
    const session = this.loadSessionView(sessionPath);
    if (!session) {
      return [];
    }

    const entries =
      options?.maxMessages && session.entries.length > options.maxMessages
        ? session.entries.slice(-options.maxMessages)
        : session.entries;

    return entries.flatMap((entry) => {
      if (entry.role === "tool") {
        const label = entry.metadata?.toolName
          ? `Tool result (${entry.metadata.toolName})`
          : "Tool result";
        return [
          {
            role: "system" as const,
            content: `${label}:\n${entry.content}`,
          },
        ];
      }

      if (entry.metadata?.summaryKind === "branch_summary") {
        return [
          {
            role: "system" as const,
            content: `Branch summary:\n${entry.content}`,
          },
        ];
      }

      if (entry.metadata?.summaryKind === "compaction") {
        return [
          {
            role: "system" as const,
            content: `Compaction summary:\n${entry.content}`,
          },
        ];
      }

      return [
        {
          role: entry.role,
          content: entry.content,
        },
      ];
    });
  }

  getStats(cwd?: string): MemoryStats {
    const sessions = this.store.listSessions(cwd);
    const totalMessages = cwd
      ? sessions.reduce((sum, session) => sum + session.messageCount, 0)
      : this.store.getTotalMessageCount();
    const bytes = this.store.getDiskUsageBytes(cwd);

    const diskUsage =
      bytes > 1024 * 1024
        ? `${(bytes / 1024 / 1024).toFixed(2)} MB`
        : `${(bytes / 1024).toFixed(2)} KB`;

    return {
      sessionCount: sessions.length,
      totalMessages,
      longtermFacts: 0,
      diskUsage,
    };
  }

  purgeSessions(cwd?: string): void {
    this.store.purgeSessions(cwd);
  }

  purgeCurrentSession(cwd = process.cwd()): void {
    const current = this.store.resolveViewSession(cwd);
    if (!current) {
      return;
    }
    this.store.purgeSessionFile(current.path);
  }

  buildRecentContext(
    cwd = process.cwd(),
    options?: { excludeCurrent?: boolean; maxMessages?: number }
  ): string | null {
    return this.store.buildRecentContext(cwd, options);
  }

  buildSessionContext(sessionPath: string, maxMessages = 8): string | null {
    return this.store.buildContextFromSessionPath(sessionPath, maxMessages);
  }

  listSessions(cwd?: string) {
    return this.store.listSessions(cwd);
  }

  async compactCurrentSession(
    cwd = process.cwd(),
    options?: CompactSessionOptions
  ) {
    const current = this.store.resolveViewSession(cwd);
    if (!current) {
      return null;
    }
    return this.store.compactSession(current.path, options);
  }

  async compactSession(
    sessionPath: string,
    options?: CompactSessionOptions
  ) {
    return this.store.compactSession(sessionPath, options);
  }

  getCurrentSessionContextStats(cwd = process.cwd()) {
    const current = this.store.resolveViewSession(cwd);
    if (!current) {
      return null;
    }
    return this.store.getSessionContextStats(current.path);
  }

  resolveSession(query: string, cwd = process.cwd()) {
    return this.store.resolveSession(query, cwd);
  }

  getCurrentSessionId(): string {
    return this.store.getCurrentSessionId() ?? "no-active-session";
  }

  getCurrentSessionPath(): string | null {
    return this.store.getCurrentSessionPath();
  }

  private mapEntriesForView(
    entries: Array<
      | ({ type: "message" } & SessionMessageEntry)
      | ({ type: "compaction" } & SessionCompactionEntry)
      | any
    >
  ): ConversationEntry[] {
    return entries.flatMap((entry) => {
      if (entry.type === "message") {
        const { type: _type, ...message } = entry;
        return [message];
      }

      if (entry.type === "compaction") {
        return [
          {
            timestamp: entry.timestamp,
            role: "system" as const,
            content: entry.summary,
            metadata: {
              summaryKind: "compaction" as const,
            },
          },
        ];
      }

      return [];
    });
  }
}

export const memory = new Memory();
