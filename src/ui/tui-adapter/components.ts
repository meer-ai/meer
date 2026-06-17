/**
 * Meer chat components for the pi-tui renderer.
 *
 * Components are plain objects with `render(width): string[]` — the TUI's
 * differential renderer only repaints lines that changed, so a component that
 * never changes (a settled message) is never rewritten. This is what makes the
 * transcript stable: there is no separate "static" channel to keep in sync.
 */

import type { Component } from "../tui/tui.js";
import { Container, visibleWidth } from "../tui/tui.js";
import { Markdown } from "../tui/components/markdown.js";
import { Spacer } from "../tui/components/spacer.js";
import { Text } from "../tui/components/text.js";
import { matchesKey } from "../tui/keys.js";
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
import type { ToolDisplayMode, ToolOutputSettings } from "../ui-settings.js";
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

// ── Status header ───────────────────────────────────────────────────────────

export interface HeaderState {
  provider: string;
  model: string;
  cwd: string;
  branch?: string;
  tokens?: { used: number; limit?: number };
  tokensEstimated?: boolean;
}

export class HeaderComponent implements Component {
  private state: HeaderState;

  constructor(state: HeaderState) {
    this.state = state;
  }

  update(partial: Partial<HeaderState>): void {
    this.state = { ...this.state, ...partial };
  }

  invalidate(): void {}

  render(width: number): string[] {
    const s = getTuiStyles();
    const st = this.state;
    const leftParts = [
      s.bold(s.accent("≋ meer")),
      st.branch ? s.muted(st.branch) : undefined,
      s.muted(st.cwd),
    ].filter(Boolean) as string[];
    const rightParts = [s.muted(`${st.provider}/${st.model}`)];
    if (st.tokens && st.tokens.used > 0) {
      const limit = st.tokens.limit ? ` / ${formatCompact(st.tokens.limit)}` : "";
      const prefix = st.tokensEstimated ? "~" : "";
      const suffix = st.tokensEstimated ? "ctx" : "tok";
      rightParts.push(s.muted(`${prefix}${formatCompact(st.tokens.used)}${limit} ${suffix}`));
    }

    const left = ` ${leftParts.join(s.muted(" "))}`;
    const right = ` ${rightParts.join(s.muted(" | "))} `;
    const rightWidth = visibleWidth(right);
    const gapWidth = Math.max(1, width - visibleWidth(left) - rightWidth);
    if (width >= rightWidth + 12) {
      return [truncateToWidth(left, Math.max(1, width - rightWidth - gapWidth)) + " ".repeat(gapWidth) + right];
    }
    return [truncateToWidth(left, width)];
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

// ── Transcript viewport ─────────────────────────────────────────────────────

export class ChatViewportComponent implements Component {
  constructor(
    private readonly source: Component,
    private readonly getMaxRows: () => number,
    private readonly getScrollOffset: () => number
  ) {}

  invalidate(): void {
    this.source.invalidate?.();
  }

  render(width: number): string[] {
    const lines = this.source.render(width);
    const maxRows = Math.max(1, Math.floor(this.getMaxRows()));
    if (lines.length <= maxRows) return lines;

    const s = getTuiStyles();
    if (maxRows === 1) {
      return [s.muted(truncateToWidth(`↑ ${lines.length} transcript lines hidden`, width))];
    }

    const offset = Math.max(0, Math.floor(this.getScrollOffset()));
    if (offset <= 0) {
      const visibleRows = maxRows - 1;
      const hidden = lines.length - visibleRows;
      return [this.hiddenAboveMarker(s, hidden, width), ...lines.slice(-visibleRows)];
    }

    const below = Math.min(offset, Math.max(0, lines.length - 1));
    const end = Math.max(1, lines.length - below);
    let contentRows = Math.max(1, maxRows - 2);
    let start = Math.max(0, end - contentRows);
    let above = start;
    let hasAbove = above > 0;
    const hasBelow = below > 0;

    contentRows = Math.max(1, maxRows - (hasAbove ? 1 : 0) - (hasBelow ? 1 : 0));
    start = Math.max(0, end - contentRows);
    above = start;
    hasAbove = above > 0;

    const rendered: string[] = [];
    if (hasAbove) rendered.push(this.hiddenAboveMarker(s, above, width));
    rendered.push(...lines.slice(start, end));
    if (hasBelow) {
      rendered.push(
        s.muted(truncateToWidth(`↓ ${below} newer transcript line${below === 1 ? "" : "s"}`, width))
      );
    }
    return rendered.slice(0, maxRows);
  }

  private hiddenAboveMarker(s: TuiStyles, hidden: number, width: number): string {
    return s.muted(
      truncateToWidth(`↑ ${hidden} earlier transcript line${hidden === 1 ? "" : "s"}`, width)
    );
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

export interface ToolDetailSnapshot {
  id: string;
  name: string;
  status: ToolRowStatus;
  summary: string;
  args?: Record<string, unknown>;
  output?: string;
  details?: Record<string, unknown>;
  diff?: string;
  error?: string;
  outputSettings: ToolOutputSettings;
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
  private diffContainer: Container;
  private outputContainer: Container;
  private errorContainer: Container;
  private diffStat: { added: number; removed: number } | null = null;
  private streamingArgs = "";
  private displayMode: ToolDisplayMode;
  private outputContent = "";
  private outputDetails?: Record<string, unknown>;
  private resultDetails?: Record<string, unknown>;
  private outputSettings: ToolOutputSettings;

  constructor(
    id: string,
    name: string,
    args?: Record<string, unknown>,
    options?: { displayMode?: ToolDisplayMode; outputSettings?: ToolOutputSettings }
  ) {
    super();
    this.id = id;
    this.name = name;
    this.args = args;
    this.displayMode = options?.displayMode ?? "compact";
    this.outputSettings =
      options?.outputSettings ?? {
        maxPreviewLines: 10,
        maxPreviewLineWidth: 120,
        maxDetailLines: 12,
        maxDiffPreviewLines: 7,
      };
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
    this.outputContent = content;
    this.outputDetails = details;
    const preview = buildToolOutputPreview(
      this.name,
      content,
      this.outputSettings.maxPreviewLines,
      this.outputSettings.maxPreviewLineWidth
    );
    this.outputContainer.clear();
    const s = getTuiStyles();
    if (preview && this.shouldShowPreview("output")) {
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
    this.resultDetails = details;
    const diff = typeof details?.diff === "string" ? (details.diff as string) : "";
    if (diff) {
      this.diffStat = parseDiffStat(diff);
      this.diffContainer.clear();
      if (this.shouldShowPreview("diff")) {
        this.buildDiffPreview(diff);
      }
    }
    this.refresh();
  }

  setDisplayMode(mode: ToolDisplayMode): void {
    if (mode === this.displayMode) return;
    this.displayMode = mode;
    this.refresh();
  }

  private shouldShowPreview(kind: "output" | "diff"): boolean {
    if (this.displayMode === "expanded") return true;
    if (this.displayMode === "compact") return false;
    const toolKind = classifyTool(this.name);
    return kind === "diff" || toolKind === "shell";
  }

  getSnapshot(): ToolDetailSnapshot {
    const diff =
      typeof this.resultDetails?.diff === "string"
        ? (this.resultDetails.diff as string)
        : undefined;
    const details =
      this.outputDetails || this.resultDetails
        ? { ...(this.outputDetails ?? {}), ...(this.resultDetails ?? {}) }
        : undefined;
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      summary: getToolSummary(this.name, this.args),
      args: this.args,
      output: this.outputContent || undefined,
      details,
      diff,
      error: this.errorText ?? undefined,
      outputSettings: this.outputSettings,
    };
  }

  private buildDiffPreview(diff: string): void {
    const s = getTuiStyles();
    this.diffContainer.clear();
    const { lines, hiddenLines } = buildDiffPreview(
      diff,
      this.outputSettings.maxDiffPreviewLines,
      this.outputSettings.maxPreviewLineWidth
    );
    const paint: Record<DiffLineKind, (t: string) => string> = {
      add: s.success,
      remove: s.danger,
      meta: s.muted,
      context: s.muted,
    };
    for (const { text, kind } of lines) {
      this.diffContainer.addChild(new Text(paint[kind](text), 5, 0));
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

// ── Tool detail panel ───────────────────────────────────────────────────────

export class ToolDetailPanelComponent extends Container {
  private readonly outputSettings: ToolOutputSettings;

  constructor(snapshot: ToolDetailSnapshot) {
    super();
    this.outputSettings = snapshot.outputSettings;
    const s = getTuiStyles();
    const summary = snapshot.summary ? ` ${snapshot.summary}` : "";
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        `${s.bold(s.text(`Tool detail: ${snapshot.name}`))}${s.muted(summary)} ${this.renderStatus(s, snapshot.status)}`,
        1,
        0
      )
    );
    this.addChild(new Text(s.muted(`id: ${snapshot.id} · Esc or /tool hide to dismiss`), 1, 0));

    const args = snapshot.args && Object.keys(snapshot.args).length > 0
      ? truncateLine(JSON.stringify(snapshot.args), 180)
      : "";
    if (args) {
      this.addChild(new Text(s.muted(`args: ${args}`), 1, 0));
    }

    if (snapshot.error) {
      this.addPreviewLines("error", snapshot.error, s.danger);
    } else if (snapshot.diff) {
      this.addDiffLines(snapshot.diff);
    } else if (snapshot.output) {
      this.addPreviewLines("output", snapshot.output, s.muted);
      this.addFullOutputHint(snapshot.details);
    }

    const renderedDetails = this.addStructuredDetails(snapshot.details);
    if (!snapshot.error && !snapshot.diff && !snapshot.output && !renderedDetails) {
      this.addChild(new Text(s.muted("No output captured for this tool."), 1, 0));
    }
  }

  private renderStatus(s: TuiStyles, status: ToolRowStatus): string {
    switch (status) {
      case "success":
        return s.success("success");
      case "error":
        return s.danger("error");
      case "running":
        return s.accent("running");
      default:
        return s.muted(status);
    }
  }

  private addPreviewLines(
    label: string,
    content: string,
    paint: (text: string) => string
  ): void {
    const s = getTuiStyles();
    const lines = content.replace(/\r/g, "").split("\n");
    const maxLines = this.outputSettings.maxDetailLines;
    this.addChild(new Text(s.muted(`${label}:`), 1, 0));
    for (const line of lines.slice(0, maxLines)) {
      this.addChild(new Text(paint(clipLine(line, this.outputSettings.maxPreviewLineWidth)), 3, 0));
    }
    if (lines.length > maxLines) {
      const hidden = lines.length - maxLines;
      this.addChild(new Text(s.muted(`… ${hidden} more line${hidden === 1 ? "" : "s"}`), 3, 0));
    }
  }

  private addDiffLines(diff: string): void {
    const s = getTuiStyles();
    const { lines, hiddenLines } = buildDiffPreview(
      diff,
      this.outputSettings.maxDetailLines,
      this.outputSettings.maxPreviewLineWidth
    );
    const paint: Record<DiffLineKind, (t: string) => string> = {
      add: s.success,
      remove: s.danger,
      meta: s.muted,
      context: s.muted,
    };
    this.addChild(new Text(s.muted("diff:"), 1, 0));
    for (const { text, kind } of lines) {
      this.addChild(new Text(paint[kind](text), 3, 0));
    }
    if (hiddenLines > 0) {
      this.addChild(new Text(s.muted(`… ${hiddenLines} more line${hiddenLines === 1 ? "" : "s"}`), 3, 0));
    }
  }

  private addFullOutputHint(details?: Record<string, unknown>): void {
    const truncation = details?.truncation as
      | { truncated?: boolean; totalLines?: number; fullOutputPath?: string }
      | undefined;
    const fullPath =
      truncation?.fullOutputPath ?? (details?.fullOutputPath as string | undefined);
    if (!truncation?.truncated || !fullPath) return;
    const s = getTuiStyles();
    const total = truncation.totalLines ? `${truncation.totalLines} lines · ` : "";
    this.addChild(new Text(s.muted(`↳ ${total}full output: ${fullPath}`), 3, 0));
  }

  private addStructuredDetails(details?: Record<string, unknown>): boolean {
    if (!details || Object.keys(details).length === 0) return false;
    const s = getTuiStyles();
    const lines: string[] = [];
    const consumed = new Set(["diff", "truncation", "fullOutputPath"]);

    const add = (line: string): void => {
      if (lines.length >= this.outputSettings.maxDetailLines) return;
      lines.push(clipLine(line, this.outputSettings.maxPreviewLineWidth));
    };

    this.addPathHint("full output", details.fullOutputPath, add);
    for (const key of ["path", "filePath", "outputPath", "artifactPath", "imagePath", "uri", "url"]) {
      if (key in details) {
        consumed.add(key);
        this.addPathHint(key, details[key], add);
      }
    }

    for (const key of ["artifacts", "files", "images", "attachments"]) {
      if (key in details) {
        consumed.add(key);
        this.addArtifactHints(key, details[key], add);
      }
    }

    for (const [key, value] of Object.entries(details)) {
      if (consumed.has(key) || value === undefined) continue;
      add(`${key}: ${this.formatDetailValue(value)}`);
    }

    if (lines.length === 0) return false;
    this.addChild(new Text(s.muted("details:"), 1, 0));
    for (const line of lines) {
      this.addChild(new Text(s.muted(line), 3, 0));
    }
    const remaining = this.countRenderableDetails(details, consumed) - lines.length;
    if (remaining > 0) {
      this.addChild(new Text(s.muted(`… ${remaining} more detail${remaining === 1 ? "" : "s"}`), 3, 0));
    }
    return true;
  }

  private addArtifactHints(
    key: string,
    value: unknown,
    add: (line: string) => void
  ): void {
    const items = Array.isArray(value) ? value : [value];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (isPlainRecord(item)) {
        const kind = this.firstString(item, ["type", "kind", "name"]);
        const mime = this.firstString(item, ["mimeType", "mediaType", "contentType"]);
        const path = this.firstString(item, ["path", "filePath", "outputPath", "artifactPath", "imagePath", "uri", "url"]);
        const bits = [kind, mime, path].filter(Boolean);
        add(`${key}[${i}]: ${bits.length > 0 ? bits.join(" ") : this.formatDetailValue(item)}`);
      } else {
        add(`${key}[${i}]: ${this.formatDetailValue(item)}`);
      }
    }
  }

  private addPathHint(label: string, value: unknown, add: (line: string) => void): void {
    if (typeof value === "string" && value.trim()) {
      add(`${label}: ${value}`);
    }
  }

  private firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return undefined;
  }

  private formatDetailValue(value: unknown): string {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private countRenderableDetails(details: Record<string, unknown>, consumed: Set<string>): number {
    let count = 0;
    for (const [key, value] of Object.entries(details)) {
      if (value === undefined || ["diff", "truncation", "fullOutputPath"].includes(key)) continue;
      if (["artifacts", "files", "images", "attachments"].includes(key)) {
        count += Array.isArray(value) ? value.length : 1;
      } else if (!consumed.has(key)) {
        count++;
      }
    }
    return count;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── Shortcuts overlay ───────────────────────────────────────────────────────

export interface ShortcutEntry {
  keys: string[];
  description: string;
}

export interface ShortcutSection {
  title: string;
  entries: ShortcutEntry[];
}

export class ShortcutsOverlayComponent implements Component {
  constructor(
    private readonly sections: ShortcutSection[],
    private readonly onClose: () => void
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "?")) {
      this.onClose();
    }
  }

  render(width: number): string[] {
    const s = getTuiStyles();
    const lines: string[] = [];
    const contentWidth = Math.max(24, width - 2);
    lines.push(truncateToWidth(` ${s.bold(s.text("Shortcuts"))}`, contentWidth));
    lines.push(truncateToWidth(` ${s.muted("? or Esc close")}`, contentWidth));
    lines.push("");

    for (const section of this.sections) {
      lines.push(truncateToWidth(` ${s.bold(s.accent(section.title))}`, contentWidth));
      for (const entry of section.entries) {
        const keyText = entry.keys.map(formatShortcutKey).join(", ");
        const paddedKeys = padVisible(keyText, 24);
        lines.push(
          truncateToWidth(` ${s.text(paddedKeys)} ${s.muted(entry.description)}`, contentWidth)
        );
      }
      lines.push("");
    }

    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
  }
}

function formatShortcutKey(key: string): string {
  return key
    .split("+")
    .map((part) => {
      switch (part) {
        case "ctrl":
          return "Ctrl";
        case "shift":
          return "Shift";
        case "alt":
          return "Alt";
        case "escape":
        case "esc":
          return "Esc";
        case "enter":
        case "return":
          return "Enter";
        case "pageUp":
          return "PageUp";
        case "pageDown":
          return "PageDown";
        default:
          return part.length === 1 ? part.toUpperCase() : part[0]?.toUpperCase() + part.slice(1);
      }
    })
    .join("+");
}

function padVisible(text: string, width: number): string {
  const pad = Math.max(1, width - visibleWidth(text));
  return `${text}${" ".repeat(pad)}`;
}

// ── Turn summary ────────────────────────────────────────────────────────────

export interface TurnSummaryState {
  durationMs: number;
  toolCount: number;
  tokenDelta?: number;
  tokensEstimated?: boolean;
}

export class TurnSummaryComponent implements Component {
  constructor(private readonly state: TurnSummaryState) {}

  invalidate(): void {}

  render(width: number): string[] {
    const s = getTuiStyles();
    const parts = [formatDurationMs(Math.max(0, this.state.durationMs))];
    parts.push(`${this.state.toolCount} tool${this.state.toolCount === 1 ? "" : "s"}`);
    if (typeof this.state.tokenDelta === "number" && this.state.tokenDelta !== 0) {
      const label = this.state.tokensEstimated ? "ctx" : "tok";
      const sign = this.state.tokenDelta > 0 ? "+" : "";
      parts.push(`${sign}${formatCompact(this.state.tokenDelta)} ${label}`);
    }
    return [truncateToWidth(` ${s.muted(`Turn · ${parts.join(" · ")}`)}`, width)];
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
  toolDisplay?: ToolDisplayMode;
  messageCount: number;
  tokens?: { used: number; limit?: number };
  /** When true, the token figure is a char-based context estimate, not billed usage. */
  tokensEstimated?: boolean;
  cost?: { current: number; limit?: number };
  queued: number;
  status?: string;
  transcriptScrollOffset?: number;
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
    if (st.toolDisplay && st.toolDisplay !== "compact") {
      parts.push(s.muted(`tools:${st.toolDisplay}`));
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
    if (st.transcriptScrollOffset && st.transcriptScrollOffset > 0) {
      parts.push(s.warning(`scroll:${st.transcriptScrollOffset} rows`));
    }
    const hints = s.muted("Enter send · Shift+Pg scroll · ? shortcuts · / commands · Esc stop · ^C exit");
    const line = ` ${parts.join(s.muted(" · "))}`;
    return [truncateToWidth(line, width), truncateToWidth(` ${hints}`, width)];
  }
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
