import { randomUUID } from 'crypto';
import { fetch } from 'undici';

export interface SessionStats {
  sessionId: string;
  startTime: number;
  endTime?: number;
  messagesCount: number;
  toolCalls: {
    total: number;
    successful: number;
    failed: number;
    byType: Record<string, { count: number; success: number; fail: number }>;
  };
  apiTime: number;
  toolTime: number;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  currentPromptTokens: number;
  maxPromptTokens: number;
  contextLimit?: number;
}

export class SessionTracker {
  private stats: SessionStats;
  private isActive: boolean = false;
  private apiUrl: string;
  private lastCommandName: string = 'interactive';

  constructor(provider: string, model: string, apiUrl?: string) {
    this.apiUrl = apiUrl || process.env.MEERAI_API_URL || 'https://api.meerai.dev';
    this.stats = {
      sessionId: randomUUID(),
      startTime: Date.now(),
      messagesCount: 0,
      toolCalls: {
        total: 0,
        successful: 0,
        failed: 0,
        byType: {}
      },
      apiTime: 0,
      toolTime: 0,
      provider,
      model,
      promptTokens: 0,
      completionTokens: 0,
      currentPromptTokens: 0,
      maxPromptTokens: 0,
      contextLimit: undefined
    };
    this.isActive = true;
  }

  // Set command name (for logging)
  setCommandName(command: string): void {
    this.lastCommandName = command;
  }

  // Track a user message
  trackMessage(): void {
    if (!this.isActive) return;
    this.stats.messagesCount++;
  }

  // Track API call timing
  trackApiCall(duration: number): void {
    if (!this.isActive) return;
    this.stats.apiTime += duration;
  }

  trackPromptTokens(count: number): void {
    if (!this.isActive) return;
    this.stats.promptTokens += count;
  }

  trackCompletionTokens(count: number): void {
    if (!this.isActive) return;
    this.stats.completionTokens += count;
  }

  trackContextUsage(tokens: number): void {
    if (!this.isActive) return;
    this.stats.currentPromptTokens = tokens;
    if (tokens > this.stats.maxPromptTokens) {
      this.stats.maxPromptTokens = tokens;
    }
  }

  setContextLimit(limit: number): void {
    this.stats.contextLimit = limit;
  }

  // Track tool call
  trackToolCall(toolName: string, success: boolean, duration: number): void {
    if (!this.isActive) return;
    
    this.stats.toolCalls.total++;
    this.stats.toolTime += duration;
    
    if (success) {
      this.stats.toolCalls.successful++;
    } else {
      this.stats.toolCalls.failed++;
    }

    // Track by tool type
    if (!this.stats.toolCalls.byType[toolName]) {
      this.stats.toolCalls.byType[toolName] = { count: 0, success: 0, fail: 0 };
    }
    
    this.stats.toolCalls.byType[toolName].count++;
    if (success) {
      this.stats.toolCalls.byType[toolName].success++;
    } else {
      this.stats.toolCalls.byType[toolName].fail++;
    }
  }

  // End the session
  async endSession(): Promise<SessionStats> {
    this.stats.endTime = Date.now();
    this.isActive = false;

    // Log usage to backend if authenticated
    await this.logUsageToBackend();

    return { ...this.stats };
  }

  /**
   * Log usage to backend API
   * Only sends if user is authenticated
   */
  private async logUsageToBackend(): Promise<void> {
    try {
      // Check if user is authenticated
      const { AuthStorage } = await import('../auth/storage.js');
      const authStorage = new AuthStorage();

      if (!authStorage.isAuthenticated()) {
        return; // Skip logging if not authenticated
      }

      // Use refresh token for authentication (access token might not be in database)
      const refreshToken = authStorage.getRefreshToken();
      const accessToken = authStorage.getAccessToken();
      const token = refreshToken || accessToken;

      if (!token) {
        return;
      }

      const tokenUsage = this.getTokenUsage();

      // Send usage log to backend
      const response = await fetch(`${this.apiUrl}/api/usage/log`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          command: this.lastCommandName,
          model: this.stats.model,
          tokens_used: tokenUsage.total,
          cost: 0, // Can be calculated based on model pricing
          success: this.stats.toolCalls.failed === 0,
          error_message: this.stats.toolCalls.failed > 0 ? `${this.stats.toolCalls.failed} tool calls failed` : null,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('Failed to log usage:', response.status, errorData);
      }
    } catch (error) {
      // Log errors in development
      if (process.env.DEBUG || process.env.NODE_ENV === 'development') {
        console.error('Usage logging error:', error);
      }
    }
  }

  // Get current stats without ending session
  getCurrentStats(): SessionStats {
    return { ...this.stats, endTime: Date.now() };
  }

  // Calculate success rate
  getSuccessRate(): number {
    if (this.stats.toolCalls.total === 0) return 0;
    return (this.stats.toolCalls.successful / this.stats.toolCalls.total) * 100;
  }

  // Get wall time (total session duration)
  getWallTime(): number {
    const endTime = this.stats.endTime || Date.now();
    return endTime - this.stats.startTime;
  }

  // Get agent active time (API + tool time)
  getAgentActiveTime(): number {
    return this.stats.apiTime + this.stats.toolTime;
  }

  getTokenUsage(): { prompt: number; completion: number; total: number } {
    return {
      prompt: this.stats.promptTokens,
      completion: this.stats.completionTokens,
      total: this.stats.promptTokens + this.stats.completionTokens
    };
  }

  getContextUsage(): {
    current: number;
    max: number;
    limit?: number;
    percent?: number;
  } {
    const { currentPromptTokens, maxPromptTokens, contextLimit } = this.stats;
    const percent = contextLimit
      ? (currentPromptTokens / contextLimit) * 100
      : undefined;

    return {
      current: currentPromptTokens,
      max: maxPromptTokens,
      limit: contextLimit,
      percent,
    };
  }

  // Format duration to human readable
  static formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  // Format percentage
  static formatPercentage(value: number): string {
    return `${value.toFixed(1)}%`;
  }
}
