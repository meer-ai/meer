import blessed from "blessed";
import type { Widgets } from "blessed";
import type {
  Timeline,
  InfoOptions as TimelineInfoOptions,
  TaskOptions as TimelineTaskOptions,
} from "./workflowTimeline.js";

const PALETTE = {
  background: "#011627",
  border: "#0ea5e9",
  primary: "#0ea5e9",
  accent: "#06b6d4",
  success: "#14b8a6",
  danger: "#f87171",
  warning: "#fbbf24",
  text: "#e0f2fe",
  muted: "#64748b",
};

type MessageRole = "user" | "assistant" | "system";

interface ChatMessage {
  role: MessageRole;
  content: string;
}

type TimelineEntryType = "task" | "info" | "warn" | "note" | "error";

interface TimelineEntry {
  id: string;
  type: TimelineEntryType;
  label: string;
  detail?: string;
  status?: "pending" | "success" | "error";
}

interface OceanChatConfig {
  provider: string;
  model: string;
  cwd: string;
  showWorkflowPanel?: boolean;
}

export class OceanChatUI {
  private screen: blessed.Widgets.Screen;
  private timelineBox?: blessed.Widgets.BoxElement;
  private chatBox: blessed.Widgets.BoxElement;
  private inputBox: blessed.Widgets.TextareaElement;
  private statusBar: blessed.Widgets.BoxElement;
  private timelineEntries: TimelineEntry[] = [];
  private timelineSequence = 0;
  private messages: ChatMessage[] = [];
  private currentAssistantIndex: number | null = null;
  private promptResolver: ((value: string) => void) | null = null;
  private promptRejecter: ((reason?: unknown) => void) | null = null;
  private promptActive = false;
  private config: OceanChatConfig;
  private originalConsole?: {
    log: typeof console.log;
    error: typeof console.error;
    warn: typeof console.warn;
  };
  private footerStatic: string = "";
  private statusSpinnerInterval?: NodeJS.Timeout;
  private statusSpinnerLabel?: string;
  private statusSpinnerFrame = 0;
  private activeSpinnerTaskId?: string;

  constructor(config: OceanChatConfig) {
    this.config = config;
    this.screen = blessed.screen({
      smartCSR: true,
      dockBorders: true,
      autoPadding: true,
      warnings: false,
    });

    this.screen.title = "MeerAI • Ocean Chat";
    this.screen.program.alternateBuffer();
    this.screen.program.hideCursor();

    const showWorkflow = config.showWorkflowPanel !== false;
    if (showWorkflow) {
      this.timelineBox = blessed.box({
        parent: this.screen,
        top: 0,
        left: 0,
        width: "100%",
        height: 7,
        label: " Workflow ",
        border: { type: "line", fg: PALETTE.border as any },
        style: {
          fg: PALETTE.text,
          border: { fg: PALETTE.border },
        },
        tags: true,
        scrollable: true,
        alwaysScroll: true,
      });
    }

    this.chatBox = blessed.box({
      parent: this.screen,
      top: showWorkflow ? 7 : 0,
      left: 0,
      right: 0,
      bottom: 4,
      label: " Conversation ",
      border: { type: "line", fg: PALETTE.border as any },
      style: {
        fg: PALETTE.text,
        bg: "#02121f",
        border: { fg: PALETTE.border },
        focus: {
          fg: "#ecfeff",
          bg: "#03263c",
          border: { fg: "#38bdf8" },
        },
        scrollbar: {
          bg: PALETTE.primary,
        },
      },
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      mouse: true,
    });

    this.inputBox = blessed.textarea({
      parent: this.screen,
      bottom: 1,
      left: 0,
      right: 0,
      height: 3,
      label: " Prompt ",
      border: { type: "line", fg: PALETTE.border as any },
      style: {
        fg: PALETTE.text,
        border: { fg: PALETTE.border },
      },
      keys: true,
      mouse: true,
      inputOnFocus: true,
      scrollbar: {
        ch: " ",
        track: { bg: PALETTE.background },
        style: { bg: PALETTE.primary },
      },
    });

    this.statusBar = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      right: 0,
      height: 1,
      tags: true,
      style: {
        fg: PALETTE.primary,
        bg: "#02223a",
      },
    });

    this.bindKeys();
    this.renderStatus();
    this.renderTimeline();
    this.renderMessages();

    this.inputBox.on("focus", () => {
      this.screen.program.showCursor();
      this.updateStatusBar();
    });

    this.inputBox.on("blur", () => {
      this.screen.program.hideCursor();
      this.updateStatusBar();
    });

    this.screen.render();
  }

  destroy(): void {
    if (this.promptActive) {
      this.promptRejecter?.(new Error("UI destroyed"));
    }
    this.restoreConsole();
    this.stopStatusSpinner();
    this.screen.program.showCursor();
    this.screen.program.normalBuffer();
    this.screen.destroy();
  }

  async prompt(): Promise<string> {
    if (this.promptActive) {
      throw new Error("Prompt already active");
    }

    this.promptActive = true;

    return new Promise((resolve, reject) => {
      this.promptResolver = resolve;
      this.promptRejecter = reject;
      this.inputBox.clearValue();
      this.inputBox.focus();
      this.screen.render();
    });
  }

  appendUserMessage(content: string): void {
    if (!content.trim()) return;
    this.messages.push({ role: "user", content });
    this.renderMessages();
    this.scrollToBottom();
  }

  startAssistantMessage(): void {
    this.currentAssistantIndex = this.messages.push({
      role: "assistant",
      content: "",
    }) - 1;
    this.renderMessages();
    this.scrollToBottom();
  }

  appendAssistantChunk(chunk: string): void {
    if (this.currentAssistantIndex === null) {
      this.startAssistantMessage();
    }

    if (this.currentAssistantIndex === null) {
      return;
    }

    const message = this.messages[this.currentAssistantIndex];
    message.content += chunk;
    this.renderMessages();
    this.scrollToBottom();
  }

  finishAssistantMessage(): void {
    this.currentAssistantIndex = null;
    this.renderMessages();
    this.scrollToBottom();
  }

  appendSystemMessage(content: string): void {
    this.messages.push({ role: "system", content });
    this.renderMessages();
    this.scrollToBottom();
  }

  setStatus(text: string): void {
    if (this.statusSpinnerInterval) {
      clearInterval(this.statusSpinnerInterval);
      this.statusSpinnerInterval = undefined;
    }
    this.updateStatusBar(text);
  }

  captureConsole(): void {
    if (this.originalConsole) return;

    this.originalConsole = {
      log: console.log,
      error: console.error,
      warn: console.warn,
    };

    console.log = (...args: unknown[]) => {
      this.appendSystemMessage(this.formatArgs(args));
      this.screen.render();
    };

    console.warn = (...args: unknown[]) => {
      this.appendSystemMessage(`⚠ ${this.formatArgs(args)}`);
      this.screen.render();
    };

    console.error = (...args: unknown[]) => {
      this.appendSystemMessage(`❌ ${this.formatArgs(args)}`);
      this.screen.render();
    };
  }

  restoreConsole(): void {
    if (!this.originalConsole) return;
    console.log = this.originalConsole.log;
    console.error = this.originalConsole.error;
    console.warn = this.originalConsole.warn;
    this.originalConsole = undefined;
  }

  getTimelineAdapter(): Timeline {
    return {
      startTask: (label: string, options: TimelineTaskOptions = {}) =>
        this.startTask(label, options.detail),
      updateTask: (id: string, detail: string) => this.updateTask(id, detail),
      succeed: (id: string, detail?: string) => this.completeTask(id, "success", detail),
      fail: (id: string, detail?: string) => this.completeTask(id, "error", detail),
      info: (message: string, options?: TimelineInfoOptions) =>
        this.addTimelineEntry("info", message, options?.icon, options?.color, options?.dim),
      note: (message: string) => this.addTimelineEntry("note", message),
      warn: (message: string) => this.addTimelineEntry("warn", message),
      error: (message: string) => this.addTimelineEntry("error", message),
      close: () => this.stopStatusSpinner(),
    };
  }

  private bindKeys(): void {
    this.screen.key(["C-c"], () => {
      this.destroy();
      process.exit(0);
    });

    this.screen.key(["C-l"], () => {
      this.chatBox.setContent("");
      this.messages = [];
      this.screen.render();
    });

    this.inputBox.on("keypress", (_ch: string, key: Widgets.Events.IKeyEventArg) => {
      if (!this.promptActive) return;

      if (key.name === "enter" && key.shift) {
        const current = this.inputBox.getValue() ?? "";
        this.inputBox.setValue(`${current}\n`);
        this.inputBox.setScrollPerc(100);
        this.screen.render();
        return;
      }

      if (key.name === "enter") {
        const value = this.inputBox.getValue();
        this.finishPrompt(value);
        return;
      }

      if (key.name === "escape") {
        this.finishPrompt("");
        return;
      }
    });
  }

  private finishPrompt(value: string): void {
    const resolver = this.promptResolver;
    this.promptResolver = null;
    this.promptRejecter = null;
    this.promptActive = false;

    this.inputBox.clearValue();
    this.screen.render();

    resolver?.(value.trim());
  }

  private renderStatus(): void {
    const cwd =
      this.config.cwd.length > 48
        ? `...${this.config.cwd.slice(-45)}`
        : this.config.cwd;
    this.footerStatic = `{gray-fg}Ctrl+C exit  ·  Shift+Enter newline  ·  ${cwd}  ·  ${this.config.provider}:${this.config.model}{/}`;
    this.updateStatusBar();
  }

  private renderTimeline(): void {
    if (!this.timelineBox) {
      return;
    }

    const maxEntries = 12;
    const entries = this.timelineEntries.slice(-maxEntries);
    if (entries.length === 0) {
      this.timelineBox.setContent(
        "{gray-fg}Tasks will appear here as Meer works...{/}"
      );
    } else {
      const lines = entries.map((entry) => this.renderTimelineEntry(entry));
      this.timelineBox.setContent(lines.join("\n"));
    }
    this.screen.render();
  }

  private renderTimelineEntry(entry: TimelineEntry): string {
    const detail =
      entry.detail && entry.detail.trim().length > 0
        ? ` {gray-fg}${this.escape(entry.detail)}{/}`
        : "";

    switch (entry.type) {
      case "task": {
        let icon = "{cyan-fg}●{/}";
        if (entry.status === "success") {
          icon = "{green-fg}✔{/}";
        } else if (entry.status === "error") {
          icon = "{red-fg}✖{/}";
        }
        return `${icon} ${this.escape(entry.label)}${detail}`;
      }
      case "info":
        return `{cyan-fg}•{/} ${this.escape(entry.label)}${detail}`;
      case "note":
        return `{blue-fg}•{/} ${this.escape(entry.label)}${detail}`;
      case "warn":
        return `{yellow-fg}⚠{/} ${this.escape(entry.label)}${detail}`;
      case "error":
        return `{red-fg}✖{/} ${this.escape(entry.label)}${detail}`;
      default:
        return `${this.escape(entry.label)}${detail}`;
    }
  }

  private renderMessages(): void {
    if (this.messages.length === 0) {
      this.chatBox.setContent(
        "{gray-fg}Type a prompt below to start a conversation with Meer...{/}"
      );
      this.screen.render();
      return;
    }

    const lines = this.messages.map((message) => {
      const label =
        message.role === "user"
          ? "{cyan-fg}You{/}"
          : message.role === "assistant"
          ? "{green-fg}MeerAI{/}"
          : "{blue-fg}System{/}";
      const indented = this.escape(message.content).replace(/\n/g, "\n   ");
      return `${label}\n  ${indented}`;
    });

    this.chatBox.setContent(lines.join("\n\n"));
    this.screen.render();
  }

  private scrollToBottom(): void {
    if (this.chatBox.getScrollPerc() !== 100) {
      this.chatBox.setScrollPerc(100);
      this.screen.render();
    }
  }

  private startTask(label: string, detail?: string): string {
    const id = `task-${++this.timelineSequence}`;
    this.timelineEntries.push({
      id,
      type: "task",
      label,
      detail,
      status: "pending",
    });
    if (this.timelineBox) {
      this.renderTimeline();
    } else {
      const suffix = detail ? ` (${detail})` : "";
      this.appendSystemMessage(`• ${label}${suffix}`);
    }
    if (label.toLowerCase().includes("thinking")) {
      this.activeSpinnerTaskId = id;
      const suffix = detail ? ` (${detail})` : "";
      this.startStatusSpinner(`Thinking${suffix}`);
    }
    return id;
  }

  private updateTask(id: string, detail: string): void {
    const entry = this.timelineEntries.find((item) => item.id === id);
    if (!entry) return;
    entry.detail = detail;
    if (this.timelineBox) {
      this.renderTimeline();
    } else {
      this.appendSystemMessage(`• ${entry.label} (${detail})`);
    }
    if (this.activeSpinnerTaskId === id) {
      const suffix = detail ? ` (${detail})` : "";
      this.startStatusSpinner(`${entry.label}${suffix}`);
    }
  }

  private completeTask(
    id: string,
    status: "success" | "error",
    detail?: string
  ): void {
    const entry = this.timelineEntries.find((item) => item.id === id);
    if (!entry) return;
    entry.status = status;
    if (detail) {
      entry.detail = detail;
    }
    if (this.timelineBox) {
      this.renderTimeline();
    } else {
      const icon = status === "success" ? "✔" : "✖";
      const suffix = entry.detail ? ` (${entry.detail})` : "";
      this.appendSystemMessage(`${icon} ${entry.label}${suffix}`);
    }
    if (this.activeSpinnerTaskId === id) {
      this.stopStatusSpinner();
      this.activeSpinnerTaskId = undefined;
    }
  }

  private addTimelineEntry(
    type: TimelineEntryType,
    label: string,
    icon?: string,
    color?: string,
    dim?: boolean
  ): void {
    let formatted = label;
    if (icon) {
      formatted = `${icon} ${formatted}`;
    }
    if (color) {
      const colorTag = color.startsWith("#") ? color.slice(1) : color;
      formatted = `{${colorTag}-fg}${formatted}{/}`;
    }
    if (dim) {
      formatted = `{gray-fg}${formatted}{/}`;
    }
    this.timelineEntries.push({
      id: `note-${++this.timelineSequence}`,
      type,
      label: formatted,
    });
    if (this.timelineBox) {
      this.renderTimeline();
    } else {
      this.appendSystemMessage(label);
    }
  }

  private escape(value: string): string {
    return value.replace(/\{/g, "\\{").replace(/\}/g, "\\}");
  }

  private formatArgs(args: unknown[]): string {
    return args
      .map((arg) => {
        if (typeof arg === "string") return arg;
        try {
          return JSON.stringify(arg, null, 2);
        } catch {
          return String(arg);
        }
      })
      .join(" ");
  }

  private updateStatusBar(activeText?: string): void {
    const content = activeText
      ? `${activeText}  ${this.footerStatic}`
      : this.footerStatic;
    this.statusBar.setContent(content);
    this.screen.render();
  }

  private startStatusSpinner(label: string): void {
    this.stopStatusSpinner();
    this.statusSpinnerLabel = label;
    this.statusSpinnerFrame = 0;
    const frames = ["~≈", "≈~", "≈≋", "≈~"];
    this.statusSpinnerInterval = setInterval(() => {
      const frame = frames[this.statusSpinnerFrame % frames.length];
      this.statusSpinnerFrame += 1;
      this.updateStatusBar(`{cyan-fg}${label} ${frame}{/}`);
    }, 140);
  }

  private stopStatusSpinner(): void {
    if (this.statusSpinnerInterval) {
      clearInterval(this.statusSpinnerInterval);
      this.statusSpinnerInterval = undefined;
    }
    this.statusSpinnerLabel = undefined;
    this.updateStatusBar();
  }
}

export type OceanChatTimeline = ReturnType<OceanChatUI["getTimelineAdapter"]>;
