/**
 * Adapter to integrate Ink-based UI with existing agent system
 * Provides the same interface as OceanChatUI but with beautiful modern TUI
 */

import { render } from 'ink';
import React from 'react';
import { MeerChat } from './MeerChat.js';
import type { Timeline } from '../workflowTimeline.js';

interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolName?: string;
  timestamp?: number;
}

export interface InkChatConfig {
  provider: string;
  model: string;
  cwd: string;
}

type Mode = 'edit' | 'plan';

export class InkChatAdapter {
  private config: InkChatConfig;
  private messages: Message[] = [];
  private promptResolver: ((value: string) => void) | null = null;
  private promptRejecter: ((reason?: unknown) => void) | null = null;
  private promptActive = false;
  private instance: any = null;
  private isThinking = false;
  private statusMessage: string | null = null;
  private currentAssistantIndex: number | null = null;
  private onSubmitCallback?: (text: string) => void;
  private onInterruptCallback?: () => void;
  private mode: Mode = 'edit';
  private onModeChangeCallback?: (mode: Mode) => void;

  constructor(config: InkChatConfig) {
    this.config = config;
    this.renderUI();
  }

  setInterruptHandler(handler: () => void): void {
    this.onInterruptCallback = handler;
    this.updateUI();
  }

  setModeChangeHandler(handler: (mode: Mode) => void): void {
    this.onModeChangeCallback = handler;
    this.updateUI();
  }

  getMode(): Mode {
    return this.mode;
  }

  setMode(mode: Mode): void {
    if (this.mode !== mode) {
      this.mode = mode;
      const modeLabel = mode === 'plan' ? '📋 PLAN' : '✏️ EDIT';
      this.appendSystemMessage(`Switched to ${modeLabel} mode`);
      this.updateUI();
    }
  }

  private renderUI() {
    const handleMessage = (message: string) => {
      if (this.onSubmitCallback) {
        this.onSubmitCallback(message);
      } else if (this.promptActive && this.promptResolver) {
        this.promptResolver(message);
        this.promptResolver = null;
        this.promptRejecter = null;
        this.promptActive = false;
      }
    };

    const handleInterrupt = () => {
      if (this.onInterruptCallback) {
        this.onInterruptCallback();
      }
    };

    const handleModeChange = (mode: Mode) => {
      this.setMode(mode);
      if (this.onModeChangeCallback) {
        this.onModeChangeCallback(mode);
      }
    };

    this.instance = render(
      React.createElement(MeerChat, {
        messages: this.messages,
        isThinking: this.isThinking,
        status: this.statusMessage || undefined,
        provider: this.config.provider,
        model: this.config.model,
        cwd: this.config.cwd,
        onMessage: handleMessage,
        onExit: () => this.destroy(),
        onInterrupt: handleInterrupt,
        mode: this.mode,
        onModeChange: handleModeChange,
      })
    );
  }

  private updateUI() {
    if (!this.instance) return;

    const handleMessage = (message: string) => {
      if (this.onSubmitCallback) {
        this.onSubmitCallback(message);
      } else if (this.promptActive && this.promptResolver) {
        this.promptResolver(message);
        this.promptResolver = null;
        this.promptRejecter = null;
        this.promptActive = false;
      }
    };

    const handleInterrupt = () => {
      if (this.onInterruptCallback) {
        this.onInterruptCallback();
      }
    };

    const handleModeChange = (mode: Mode) => {
      this.setMode(mode);
      if (this.onModeChangeCallback) {
        this.onModeChangeCallback(mode);
      }
    };

    // Force re-render by unmounting and remounting
    this.instance.rerender(
      React.createElement(MeerChat, {
        messages: this.messages,
        isThinking: this.isThinking,
        status: this.statusMessage || undefined,
        provider: this.config.provider,
        model: this.config.model,
        cwd: this.config.cwd,
        onMessage: handleMessage,
        onExit: () => this.destroy(),
        onInterrupt: handleInterrupt,
        mode: this.mode,
        onModeChange: handleModeChange,
      })
    );
  }

  // Compatibility methods for existing agent system

  appendUserMessage(content: string): void {
    if (!content.trim()) return;
    this.messages.push({ role: 'user', content, timestamp: Date.now() });
    this.updateUI();
  }

  startAssistantMessage(): void {
    this.isThinking = true;
    this.currentAssistantIndex = this.messages.push({
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    }) - 1;
    this.updateUI();
  }

  appendAssistantChunk(chunk: string): void {
    if (this.currentAssistantIndex === null) {
      this.startAssistantMessage();
    }

    if (this.currentAssistantIndex === null) return;

    const message = this.messages[this.currentAssistantIndex];
    if (message) {
      message.content += chunk;
      this.updateUI();
    }
  }

  finishAssistantMessage(): void {
    this.isThinking = false;
    this.currentAssistantIndex = null;
    this.updateUI();
  }

  appendSystemMessage(content: string): void {
    this.messages.push({ role: 'system', content, timestamp: Date.now() });
    this.updateUI();
  }

  appendToolMessage(toolName: string, content: string): void {
    this.messages.push({
      role: 'tool',
      content,
      toolName,
      timestamp: Date.now(),
    });
    this.updateUI();
  }

  setStatus(text: string): void {
    this.statusMessage = text?.trim() || null;
    this.updateUI();
  }

  enableContinuousChat(onSubmit: (text: string) => void): void {
    this.onSubmitCallback = onSubmit;
    this.promptActive = true;
    this.updateUI();
  }

  async prompt(): Promise<string> {
    if (this.promptActive) {
      throw new Error('Prompt already active');
    }

    this.promptActive = true;
    this.updateUI();

    return new Promise((resolve, reject) => {
      this.promptResolver = resolve;
      this.promptRejecter = reject;
    });
  }

  async promptChoice<T extends string>(
    message: string,
    options: Array<{ label: string; value: T }>,
    defaultValue: T
  ): Promise<T> {
    // For now, just append as system message and return default
    // TODO: Implement proper choice UI with ink-select-input
    this.appendSystemMessage(`${message}\nOptions: ${options.map(o => o.label).join(', ')}`);
    return defaultValue;
  }

  captureConsole(): void {
    // Ink handles console output automatically
  }

  restoreConsole(): void {
    // Ink handles console output automatically
  }

  private async executeWithTerminal<T>(
    task: () => Promise<T>,
    options: { capture?: boolean } = {}
  ): Promise<{ result: T; stdout: string; stderr: string }> {
    const capture = Boolean(options.capture);
    let stdoutBuffer = '';
    let stderrBuffer = '';

    // Temporarily unmount UI for terminal access
    if (this.instance) {
      this.instance.unmount();
    }

    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);

    const wrapWriter =
      <TWriter extends typeof process.stdout.write>(
        writer: TWriter,
        collector: (chunk: string) => void
      ): TWriter =>
      ((chunk: any, encoding?: any, callback?: any) => {
        const normalizedEncoding =
          typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined;
        const normalized =
          typeof chunk === 'string'
            ? chunk
            : Buffer.isBuffer(chunk)
            ? chunk.toString(
                normalizedEncoding ?? 'utf8'
              )
            : String(chunk);

        collector(normalized);
        return (writer as unknown as (...args: any[]) => boolean)(
          chunk,
          normalizedEncoding,
          callback
        );
      }) as TWriter;

    if (capture) {
      process.stdout.write = wrapWriter(
        originalStdoutWrite,
        (chunk) => (stdoutBuffer += chunk)
      );
      process.stderr.write = wrapWriter(
        originalStderrWrite,
        (chunk) => (stderrBuffer += chunk)
      );
    }

    try {
      const result = await task();
      return { result, stdout: stdoutBuffer, stderr: stderrBuffer };
    } finally {
      if (capture) {
        process.stdout.write = originalStdoutWrite;
        process.stderr.write = originalStderrWrite;
        if (typeof console.clear === 'function') {
          console.clear();
        }
      }
      // Remount UI
      this.renderUI();
    }
  }

  async runWithTerminal<T>(task: () => Promise<T>): Promise<T> {
    const { result } = await this.executeWithTerminal(task);
    return result;
  }

  async runWithTerminalCapture<T>(
    task: () => Promise<T>
  ): Promise<{ result: T; stdout: string; stderr: string }> {
    return this.executeWithTerminal(task, { capture: true });
  }

  getTimelineAdapter(): Timeline {
    return {
      startTask: (label: string) => {
        const id = `task-${Date.now()}`;
        this.setStatus(`🔄 ${label}`);
        return id;
      },
      updateTask: (id: string, detail: string) => {
        this.setStatus(`🔄 ${detail}`);
      },
      succeed: (id: string, detail?: string) => {
        this.setStatus(detail ? `✅ ${detail}` : '');
      },
      fail: (id: string, detail?: string) => {
        this.setStatus(detail ? `❌ ${detail}` : '');
      },
      info: (message: string) => {
        this.appendSystemMessage(`ℹ️  ${message}`);
      },
      note: (message: string) => {
        this.appendSystemMessage(`📝 ${message}`);
      },
      warn: (message: string) => {
        this.appendSystemMessage(`⚠️  ${message}`);
      },
      error: (message: string) => {
        this.appendSystemMessage(`❌ ${message}`);
      },
      close: () => {
        this.setStatus('');
      },
    };
  }

  destroy(): void {
    if (this.promptActive && this.promptRejecter) {
      this.promptRejecter(new Error('UI destroyed'));
    }

    this.onSubmitCallback = undefined;
    this.promptResolver = null;
    this.promptRejecter = null;
    this.promptActive = false;

    if (this.instance) {
      this.instance.unmount();
      this.instance = null;
    }
  }
}

export default InkChatAdapter;
