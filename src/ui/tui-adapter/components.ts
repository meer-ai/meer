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
  buildDiffPreview,
  buildToolOutputPreview,
  classifyTool,
  clipLine,
  extractStreamingArgPreview,
  formatDurationMs,
  getToolSummary,
  parseDiffStat,
  truncateLine,
  type DiffLineKind,
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

/** Max reasoning lines shown before collapsing the rest. */
const COT_PREVIEW_LINES = 6;
const COT_PREVIEW_CHARS = 600;

export class CotMessageComponent extends Container {
  constructor(content: string) {
    super();
    const s = getTuiStyles();
    const lines = content
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const shown = lines.slice(0, COT_PREVIEW_LINES);
    const hidden = lines.length - shown.length;
    let body = shown.join("\n");
    // Clip a single long block too, so a wall-of-text paragraph can't flood.
    if (hidden === 0 && body.length > COT_PREVIEW_CHARS) {
      body = `${body.slice(0, COT_PREVIEW_CHARS - 1)}…`;
    }

    this.addChild(new Spacer(1));
    this.addChild(new Text(s.italic(s.muted(`∵ ${body}`)), 1, 0));
    if (hidden > 0) {
      this.addChild(
        new Text(s.muted(`  … +${hidden} more line${hidden === 1 ? "" : "s"} of reasoning`), 1, 0)
      );
    }
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
  private diffContainer: Container;
  private outputContainer: Container;
  private errorContainer: Container;
  private diffStat: { added: number; removed: number } | null = null;
  private streamingArgs = "";

  constructor(id: string, name: string, args?: Record<string, unknown>) {
    super();
    this.id = id;
    this.name = name;
    this.args = args;
    this.line = new Text("", 1, 0);
    this.diffContainer = new Container();
    this.outputContainer = new Container();
    this.errorContainer = new Container();
    this.addChild(this.line);
    this.addChild(this.diffContainer);
    this.addChild(this.outputContainer);
    this.addChild(this.errorContainer);
    this.refresh();
  }

  /**
   * Show a compact preview of the tool's textual output (run_command stdout,
   * grep matches, read previews). Called live while the tool streams and again
   * with the final result. No-op for edits (they render a diff instead).
   */
  setOutput(content: string, details?: Record<string, unknown>): void {
    const preview = buildToolOutputPreview(this.name, content);
    this.outputContainer.clear();
    const s = getTuiStyles();
    if (preview) {
      for (const line of preview.lines) {
        this.outputContainer.addChild(new Text(s.muted(line), 5, 0));
      }
      if (preview.hiddenLines > 0) {
        this.outputContainer.addChild(
          new Text(
            s.muted(`… ${preview.hiddenLines} more line${preview.hiddenLines === 1 ? "" : "s"}`),
            5,
            0
          )
        );
      }
    }
    this.renderTruncationHint(s, details);
  }

  /** When output was capped and spilled to a file, say so + where to find it. */
  private renderTruncationHint(s: TuiStyles, details?: Record<string, unknown>): void {
    const truncation = details?.truncation as
      | { truncated?: boolean; totalLines?: number; fullOutputPath?: string }
      | undefined;
    const fullPath =
      truncation?.fullOutputPath ?? (details?.fullOutputPath as string | undefined);
    if (!truncation?.truncated || !fullPath) return;
    const total = truncation.totalLines ? `${truncation.totalLines} lines · ` : "";
    this.outputContainer.addChild(
      new Text(s.muted(`↳ ${total}full output: ${fullPath}`), 5, 0)
    );
  }

  /**
   * Attach a completed tool's result details. For file edits/writes this
   * renders a compact diff preview and a +N/-M stat on the status line.
   */
  setResult(details?: Record<string, unknown>): void {
    const diff = typeof details?.diff === "string" ? (details.diff as string) : "";
    if (diff) {
      this.diffStat = parseDiffStat(diff);
      this.buildDiffPreview(diff);
    }
    this.refresh();
  }

  private buildDiffPreview(diff: string): void {
    const s = getTuiStyles();
    this.diffContainer.clear();
    const { lines, hiddenLines } = buildDiffPreview(diff);
    const paint: Record<DiffLineKind, (t: string) => string> = {
      add: s.success,
      remove: s.danger,
      meta: s.muted,
      context: s.muted,
    };
    for (const { text, kind } of lines) {
      this.diffContainer.addChild(new Text(paint[kind](clipLine(text, 120)), 5, 0));
    }
    if (hiddenLines > 0) {
      this.diffContainer.addChild(
        new Text(s.muted(`… ${hiddenLines} more line${hiddenLines === 1 ? "" : "s"}`), 5, 0)
      );
    }
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

  /** Accumulate streamed tool-call arg JSON so the row shows it building live. */
  appendStreamingArgs(delta: string): void {
    if (!delta) return;
    this.streamingArgs += delta;
    this.refresh();
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
    // Prefer the finalized args summary; while the call is still streaming in
    // (no args yet), show the partial value being typed with a trailing ellipsis.
    let summary = getToolSummary(this.name, this.args);
    if (!summary && this.isActive() && this.streamingArgs) {
      const partial = extractStreamingArgPreview(this.streamingArgs);
      if (partial) summary = `${partial}…`;
    }
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
    const statPart =
      this.diffStat && (this.diffStat.added > 0 || this.diffStat.removed > 0)
        ? ` ${s.success(`+${this.diffStat.added}`)} ${s.danger(`-${this.diffStat.removed}`)}`
        : "";
    this.line.setText(`${icon} ${label}${summaryPart}${statPart}${duration}`);
  }
}

// ── Footer ───────────────────────────────────────────────────────────────────

export interface FooterState {
  provider: string;
  model: string;
  cwd: string;
  mode: "normal" | "auto-accept" | "plan";
  screenReaderMode?: "auto" | "on" | "off";
  alternateBufferMode?: "on" | "off";
  messageCount: number;
  tokens?: { used: number; limit?: number };
  /** When true, the token figure is a char-based context estimate, not billed usage. */
  tokensEstimated?: boolean;
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
    const modeLabel =
      st.mode === "auto-accept"
        ? "⚡ auto-accept"
        : st.mode === "plan"
        ? "📋 plan"
        : "🔒 normal";
    const parts: string[] = [
      s.accent("meer"),
      s.muted(`${st.provider}/${st.model}`),
      st.mode === "plan" ? s.accent(modeLabel) : s.muted(modeLabel),
    ];
    if (st.screenReaderMode === "on") {
      parts.push(s.accent("sr:on"));
    }
    if (st.alternateBufferMode === "on") {
      parts.push(s.muted("alt:on"));
    }
    if (st.tokens && st.tokens.used > 0) {
      const limit = st.tokens.limit ? `/${formatCompact(st.tokens.limit)}` : "";
      // Real billed usage renders as "12k tok"; a char-based context estimate
      // (no provider usage) renders as "~12k ctx" so it's never mistaken for billing.
      parts.push(
        st.tokensEstimated
          ? s.muted(`~${formatCompact(st.tokens.used)}${limit} ctx`)
          : s.muted(`${formatCompact(st.tokens.used)}${limit} tok`)
      );
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
