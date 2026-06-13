/**
 * Meer chat components for the pi-tui renderer.
 *
 * Components are plain objects with `render(width): string[]` — the TUI's
 * differential renderer only repaints lines that changed, so a component that
 * never changes (a settled message) is never rewritten. This is what makes the
 * transcript stable: there is no separate "static" channel to keep in sync.
 */

import type { Component } from "../tui/tui.js";
import { Container } from "../tui/tui.js";
import { Markdown } from "../tui/components/markdown.js";
import { Spacer } from "../tui/components/spacer.js";
import { Text } from "../tui/components/text.js";
import { truncateToWidth } from "../tui/utils.js";
import {
  classifyTool,
  formatDurationMs,
  getCommand,
  getFilePath,
  truncateLine,
} from "../shared/tool-utils.js";
import { getMarkdownTheme, getTuiStyles, type TuiStyles } from "./theme.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const h = date.getHours().toString().padStart(2, "0");
  const m = date.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

/** "You 14:03" / "Meer 14:03" header line. */
function roleHeader(s: TuiStyles, name: string, color: (t: string) => string, timestamp: number): string {
  return ` ${s.bold(color(name))} ${s.muted(formatTimestamp(timestamp))}`;
}

// ── Brand header ─────────────────────────────────────────────────────────────

export class HeaderComponent extends Container {
  constructor(provider: string, model: string, cwd: string) {
    super();
    const s = getTuiStyles();
    this.addChild(new Spacer(1));
    this.addChild(new Text(` ${s.bold(s.accent("≋ meer"))} ${s.muted("· oceanic coding agent")}`, 0, 0));
    this.addChild(new Text(` ${s.muted(`${provider}/${model}`)}`, 0, 0));
    this.addChild(new Text(` ${s.muted(cwd)}`, 0, 0));
    this.addChild(new Spacer(1));
  }
}

// ── Messages ─────────────────────────────────────────────────────────────────

export class UserMessageComponent extends Container {
  constructor(content: string, timestamp = Date.now()) {
    super();
    const s = getTuiStyles();
    this.addChild(new Spacer(1));
    this.addChild(new Text(roleHeader(s, "You", s.accent, timestamp), 0, 0));
    this.addChild(new Text(s.text(content), 3, 0));
  }
}

export class SystemMessageComponent extends Container {
  constructor(content: string) {
    super();
    const s = getTuiStyles();
    for (const line of content.split("\n").filter((l) => l.trim().length > 0)) {
      this.addChild(new Text(s.muted(`· ${line}`), 1, 0));
    }
  }
}

export class CotMessageComponent extends Container {
  constructor(content: string) {
    super();
    const s = getTuiStyles();
    this.addChild(new Spacer(1));
    this.addChild(new Text(s.italic(s.muted(content.trim())), 1, 0));
  }
}

/**
 * Assistant message. Streaming updates call setContent(); only the lines that
 * actually changed get repainted by the differential renderer.
 */
export class AssistantMessageComponent extends Container {
  private body: Markdown;
  private content: string;
  private headerShown: boolean;

  constructor(initialContent = "", options?: { showHeader?: boolean; timestamp?: number }) {
    super();
    const s = getTuiStyles();
    this.content = initialContent;
    this.headerShown = options?.showHeader !== false;
    this.addChild(new Spacer(1));
    if (this.headerShown) {
      this.addChild(new Text(roleHeader(s, "Meer", s.success, options?.timestamp ?? Date.now()), 0, 0));
    }
    this.body = new Markdown(initialContent, 3, 0, getMarkdownTheme());
    this.addChild(this.body);
  }

  setContent(content: string): void {
    if (content === this.content) return;
    this.content = content;
    this.body.setText(content);
  }

  appendContent(chunk: string): void {
    this.setContent(this.content + chunk);
  }

  getContent(): string {
    return this.content;
  }

  isEmpty(): boolean {
    return this.content.trim().length === 0;
  }
}

// ── Tool rows ────────────────────────────────────────────────────────────────

export type ToolRowStatus = "pending" | "running" | "success" | "error";

export function getToolSummary(toolName: string, args?: Record<string, unknown>): string {
  const lower = toolName.toLowerCase();
  if (/run_command|bash|exec|package_run_script/.test(lower)) {
    const command = getCommand(args);
    return command ? `$ ${command}` : "";
  }
  const path = getFilePath(args);
  if (path) return path;
  const pattern =
    args &&
    ["pattern", "term", "query", "includePattern"]
      .map((key) => args[key])
      .find((value): value is string => typeof value === "string" && value.length > 0);
  if (pattern) return `"${pattern}"`;
  return "";
}

/**
 * One tool call: a single status line, plus error details when it fails.
 * The adapter ticks a shared timer while any row is running so the spinner
 * and elapsed time animate.
 */
export class ToolRowComponent extends Container {
  readonly id: string;
  name: string;
  args?: Record<string, unknown>;
  status: ToolRowStatus = "pending";
  private startTime = Date.now();
  private endTime: number | null = null;
  private errorText: string | null = null;
  private line: Text;
  private errorContainer: Container;

  constructor(id: string, name: string, args?: Record<string, unknown>) {
    super();
    this.id = id;
    this.name = name;
    this.args = args;
    this.line = new Text("", 1, 0);
    this.errorContainer = new Container();
    this.addChild(this.line);
    this.addChild(this.errorContainer);
    this.refresh();
  }

  setName(name: string): void {
    if (name && name !== this.name) {
      this.name = name;
      this.refresh();
    }
  }

  setArgs(args?: Record<string, unknown>): void {
    if (args && Object.keys(args).length > 0) {
      this.args = args;
      this.refresh();
    }
  }

  setStatus(status: ToolRowStatus, errorText?: string): void {
    this.status = status;
    if (status === "success" || status === "error") {
      this.endTime = Date.now();
    }
    if (status === "error" && errorText) {
      this.errorText = errorText;
      this.errorContainer.clear();
      const s = getTuiStyles();
      const preview = errorText.split("\n").slice(0, 4);
      for (const line of preview) {
        this.errorContainer.addChild(new Text(s.danger(truncateLine(line, 200)), 5, 0));
      }
    }
    this.refresh();
  }

  isActive(): boolean {
    return this.status === "pending" || this.status === "running";
  }

  /** Re-renders the status line; called by the adapter's ticker while active. */
  refresh(): void {
    const s = getTuiStyles();
    const summary = getToolSummary(this.name, this.args);
    const elapsedMs = (this.endTime ?? Date.now()) - this.startTime;
    const duration = elapsedMs >= 100 ? s.muted(` (${formatDurationMs(elapsedMs)})`) : "";
    const kind = classifyTool(this.name);

    let icon: string;
    let label: string;
    switch (this.status) {
      case "pending":
      case "running": {
        const frame = SPINNER_FRAMES[Math.floor(Date.now() / 120) % SPINNER_FRAMES.length];
        icon = s.accent(frame);
        label = s.text(this.name);
        break;
      }
      case "success":
        icon = kind === "mutation" ? s.warning("●") : s.success("✓");
        label = s.muted(this.name);
        break;
      case "error":
        icon = s.danger("✗");
        label = s.danger(this.name);
        break;
    }

    const summaryPart = summary ? ` ${s.muted(truncateLine(summary, 96))}` : "";
    this.line.setText(`${icon} ${label}${summaryPart}${duration}`);
  }
}

// ── Footer ───────────────────────────────────────────────────────────────────

export interface FooterState {
  provider: string;
  model: string;
  cwd: string;
  mode: "edit" | "plan";
  messageCount: number;
  tokens?: { used: number; limit?: number };
  cost?: { current: number; limit?: number };
  queued: number;
  status?: string;
  /** Number of images queued to send with the next message. */
  attachments?: number;
}

export class FooterComponent implements Component {
  private state: FooterState;

  constructor(state: FooterState) {
    this.state = state;
  }

  update(partial: Partial<FooterState>): void {
    this.state = { ...this.state, ...partial };
  }

  invalidate(): void {}

  render(width: number): string[] {
    const s = getTuiStyles();
    const st = this.state;
    const parts: string[] = [
      s.accent("meer"),
      s.muted(`${st.provider}/${st.model}`),
      s.muted(st.mode),
    ];
    if (st.tokens && st.tokens.used > 0) {
      const limit = st.tokens.limit ? `/${formatCompact(st.tokens.limit)}` : "";
      parts.push(s.muted(`${formatCompact(st.tokens.used)}${limit} tok`));
    }
    if (st.cost && st.cost.current > 0) {
      parts.push(s.muted(`$${st.cost.current.toFixed(4)}`));
    }
    parts.push(s.muted(`${st.messageCount} msgs`));
    if (st.queued > 0) {
      parts.push(s.warning(`${st.queued} queued`));
    }
    if (st.attachments && st.attachments > 0) {
      parts.push(s.warning(`📎 ${st.attachments}`));
    }
    const hints = s.muted("Enter send · Esc stop · / commands · ^C exit");
    const line = ` ${parts.join(s.muted(" · "))}`;
    return [truncateToWidth(line, width), truncateToWidth(` ${hints}`, width)];
  }
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
