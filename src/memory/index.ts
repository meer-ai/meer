import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

export interface ConversationEntry {
  timestamp: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata?: {
    model?: string;
    provider?: string;
    tokens?: number;
  };
}

export interface MemoryStats {
  sessionCount: number;
  totalMessages: number;
  longtermFacts: number;
  diskUsage: string;
}

export class Memory {
  private basePath: string;
  private sessionsPath: string;
  private longtermPath: string;
  private currentSessionId: string;

  constructor() {
    this.basePath = join(homedir(), '.meer');
    this.sessionsPath = join(this.basePath, 'sessions');
    this.longtermPath = join(this.basePath, 'longterm');
    this.currentSessionId = this.generateSessionId();

    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    [this.basePath, this.sessionsPath, this.longtermPath].forEach(dir => {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    });
  }

  private generateSessionId(): string {
    const now = new Date();
    return `session-${now.toISOString().split('T')[0]}-${Date.now()}`;
  }

  private getSessionPath(): string {
    return join(this.sessionsPath, `${this.currentSessionId}.jsonl`);
  }

  /**
   * Append a conversation entry to the current session
   */
  addToSession(entry: ConversationEntry): void {
    const sessionPath = this.getSessionPath();
    const line = JSON.stringify(entry) + '\n';
    appendFileSync(sessionPath, line, 'utf-8');
  }

  /**
   * Load conversation history from current session
   */
  loadCurrentSession(): ConversationEntry[] {
    const sessionPath = this.getSessionPath();

    if (!existsSync(sessionPath)) {
      return [];
    }

    const content = readFileSync(sessionPath, 'utf-8');
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
  }

  /**
   * Load all sessions
   */
  loadAllSessions(): Map<string, ConversationEntry[]> {
    const sessions = new Map<string, ConversationEntry[]>();

    if (!existsSync(this.sessionsPath)) {
      return sessions;
    }

    const files = readdirSync(this.sessionsPath).filter(f => f.endsWith('.jsonl'));

    for (const file of files) {
      const sessionId = file.replace('.jsonl', '');
      const content = readFileSync(join(this.sessionsPath, file), 'utf-8');
      const entries = content
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));

      sessions.set(sessionId, entries);
    }

    return sessions;
  }

  /**
   * Get memory statistics
   */
  getStats(): MemoryStats {
    const sessions = this.loadAllSessions();
    let totalMessages = 0;

    sessions.forEach(entries => {
      totalMessages += entries.length;
    });

    // Calculate disk usage
    let totalBytes = 0;
    if (existsSync(this.sessionsPath)) {
      const files = readdirSync(this.sessionsPath);
      files.forEach(file => {
        const stat = readFileSync(join(this.sessionsPath, file), 'utf-8');
        totalBytes += stat.length;
      });
    }

    const diskUsage = totalBytes > 1024 * 1024
      ? `${(totalBytes / 1024 / 1024).toFixed(2)} MB`
      : `${(totalBytes / 1024).toFixed(2)} KB`;

    return {
      sessionCount: sessions.size,
      totalMessages,
      longtermFacts: 0, // TODO: Implement longterm facts
      diskUsage
    };
  }

  /**
   * Purge all sessions
   */
  purgeSessions(): void {
    if (!existsSync(this.sessionsPath)) {
      return;
    }

    const files = readdirSync(this.sessionsPath);
    files.forEach(file => {
      unlinkSync(join(this.sessionsPath, file));
    });
  }

  /**
   * Purge current session
   */
  purgeCurrentSession(): void {
    const sessionPath = this.getSessionPath();
    if (existsSync(sessionPath)) {
      unlinkSync(sessionPath);
    }
  }

  /**
   * Start a new session
   */
  newSession(): void {
    this.currentSessionId = this.generateSessionId();
  }

  /**
   * Get current session ID
   */
  getCurrentSessionId(): string {
    return this.currentSessionId;
  }
}

// Singleton instance
export const memory = new Memory();
