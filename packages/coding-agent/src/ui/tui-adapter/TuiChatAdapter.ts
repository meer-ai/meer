/**
 * Chat adapter on the vendored pi-tui renderer (src/ui/tui).
 *
 * Implements the same ChatAdapter seam as InkChatAdapter, but renders through
 * pi-tui's differential renderer: components are plain `render(width)` string
 * producers, settled transcript lines are never rewritten, and there is no
 * virtual-DOM/static-region machinery to desync (the bug class that plagued
 * the Ink renderer).
 *
 * Enable with ui.renderer = "tui" in config, or MEER_UI_RENDERER=tui.
 */

import { format as formatArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ChatAdapter,
  ChatMode,
  ChoiceOption,
  FormQuestion,
  ToolSnapshot,
  TranscriptEntry,
  TuiDebugState,
} from "../chat-adapter.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { MessageAttachment } from "@meer-ai/agent/types.js";
import { readClipboardImage } from "../../utils/clipboard-image.js";
import { saveAttachmentBytes } from "@meer-ai/ai/attachments.js";
import type { Plan } from "../../plan/types.js";
import type { BackgroundTerminalSession } from "../../runtime/backgroundTerminals.js";
import type { UITimelineEvent } from "../shared/timelineTypes.js";
import { collapseWhitespace } from "../shared/streamCommit.js";
import type { UISettings } from "../ui-settings.js";
import type { ToolDisplayMode } from "../ui-settings.js";
import { getAllCommands } from "../../slash/registry.js";
import { isSlashCommandInput } from "../../slash/utils.js";
import { setToolConsoleQuiet } from "../../tools/index.js";
import { CombinedAutocompleteProvider, type SlashCommand } from "@meer-ai/tui/autocomplete.js";
import { setTuiDiagnosticReporter } from "@meer-ai/tui/diagnostics.js";
import { recordDiagnostic } from "../../utils/diagnostics.js";
import { findFilesFuzzy } from "../../utils/file-finder.js";
import { Editor } from "@meer-ai/tui/components/editor.js";
import { PromptHistoryStore } from "../promptHistory.js";
import { Loader } from "@meer-ai/tui/components/loader.js";
import { SelectList, type SelectItem } from "@meer-ai/tui/components/select-list.js";
import { Spacer } from "@meer-ai/tui/components/spacer.js";
import { Text } from "@meer-ai/tui/components/text.js";
import { getKeybindings, type Keybinding } from "@meer-ai/tui/keybindings.js";
import { matchesKey } from "@meer-ai/tui/keys.js";
import { ProcessTerminal, type Terminal } from "@meer-ai/tui/terminal.js";
import { type Component, Container, type OverlayHandle, TUI } from "@meer-ai/tui/tui.js";
import {
  AssistantMessageComponent,
  CotMessageComponent,
  FooterComponent,
  HeaderComponent,
  ShortcutsOverlayComponent,
  type ShortcutSection,
  SystemMessageComponent,
  ToolDetailPanelComponent,
  ToolRowComponent,
  TurnSummaryComponent,
  UserMessageComponent,
} from "./components.js";
import { getEditorTheme, getSelectListTheme, getTuiStyles } from "./theme.js";
import { WAVE_LOADER_INTERVAL_MS, getWaveLoaderFrames } from "../logo.js";

export interface TuiChatConfig {
  provider: string;
  model: string;
  cwd: string;
  ui?: UISettings;
  /** Injected for tests; defaults to a real ProcessTerminal. */
  terminal?: Terminal;
}

const EXIT_CONFIRM_WINDOW_MS = 1500;
const MAX_TIMELINE_EVENTS = 400;
/**
 * Upper bound on transcript components kept in memory. The viewport only ever
 * shows a screen's worth, and old settled messages are never re-read, so a long
 * session would otherwise grow `this.chat` (and the per-frame render cost)
 * without limit. Generous enough that an active turn's rows are never trimmed.
 */
export const MAX_TRANSCRIPT_COMPONENTS = 5000;

/**
 * Reduce the small amount of Markdown that callers put in prompt messages
 * (bold, inline code, code fences, headers) to plain text. The InlinePrompt
 * renders a single styled string, so raw `**` / backticks would otherwise show
 * literally.
 */
function stripPromptMarkdown(input: string): string {
  return input
    .replace(/```[a-zA-Z0-9_-]*\n?/g, "") // code-fence markers
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold**
    .replace(/__([^_]+)__/g, "$1") // __bold__
    .replace(/^#{1,6}\s+/gm, "") // # headers
    .replace(/\n{3,}/g, "\n\n") // collapse excess blank lines
    .trim();
}

/**
 * Transcript container that caps how many child components it retains. When the
 * cap is exceeded the oldest (always settled) components are dropped from the
 * front; a callback lets the owner prune any side tables that referenced them.
 */
class BoundedTranscriptContainer extends Container {
  constructor(
    private readonly max: number,
    private readonly onTrim: (removed: Component[]) => void
  ) {
    super();
  }

  addChild(component: Component): void {
    super.addChild(component);
    if (this.children.length > this.max) {
      const removed = this.children.splice(0, this.children.length - this.max);
      this.onTrim(removed);
    }
  }
}

/**
 * Container that remembers how many lines it produced on its last render.
 * Used to reserve the composer's real height when sizing the transcript
 * viewport, so a tall input area never overflows the screen.
 */
class HeightTrackingContainer extends Container {
  lastHeight = 0;

  render(width: number): string[] {
    const lines = super.render(width);
    this.lastHeight = lines.length;
    return lines;
  }
}

/** Inline prompt (choice/form question) shown above the editor. */
class InlinePrompt extends Container {
  list: SelectList;
  onCancel?: () => void;

  constructor(message: string, items: SelectItem[], hint: string) {
    super();
    const s = getTuiStyles();
    this.addChild(new Spacer(1));
    this.addChild(new Text(s.bold(s.text(stripPromptMarkdown(message))), 1, 0));
    this.list = new SelectList(items, Math.min(10, Math.max(items.length, 1)), getSelectListTheme());
    this.addChild(this.list);
    this.addChild(new Text(s.muted(hint), 1, 0));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.onCancel?.();
      return;
    }
    this.list.handleInput(data);
  }
}

/** Human-readable one-line description of a permission mode for system messages. */
function describeMode(mode: ChatMode): string {
  switch (mode) {
    case "normal":
      return "🔒 Normal — ask before edits and commands";
    case "auto-accept":
      return "⚡ Auto-accept edits — applies edits, still asks for commands";
    case "plan":
      return "📋 Plan mode — read-only, proposes a plan";
  }
}

function gitOutput(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 1000,
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function detectGitBranch(cwd: string): string | undefined {
  const branch = gitOutput(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch && branch !== "HEAD") return branch;
  const commit = gitOutput(cwd, ["rev-parse", "--short", "HEAD"]);
  return commit ? `detached:${commit}` : undefined;
}

export class TuiChatAdapter implements ChatAdapter {
  private config: TuiChatConfig;
  private ui: TUI;
  private chat: BoundedTranscriptContainer;
  private header: HeaderComponent;
  private statusContainer = new Container();
  private toolDetailContainer = new Container();
  private planContainer = new Container();
  private promptContainer = new Container();
  private editorChrome = new HeightTrackingContainer();
  private editor: Editor;
  private readonly history = new PromptHistoryStore();
  private footer: FooterComponent;
  private loader: Loader | null = null;
  private shortcutsOverlay: OverlayHandle | null = null;
  private lastRendererSnapshotPath: string | undefined;
  private resizeEvents: number[] = [];

  private mode: ChatMode = "normal";
  private screenReaderMode: "auto" | "on" | "off";
  private alternateBufferMode: "on" | "off";
  private toolDisplayMode: ToolDisplayMode;
  private turnActive = false;
  private destroyed = false;
  private messageCount = 0;
  private queueState = { steering: 0, followUp: 0 };
  private queueMode: "steer" | "followUp" = "steer";
  private statusText: string | null = null;
  private iteration: { current: number; max?: number } | null = null;
  private lastTokenUsage: { used: number; estimated: boolean } | null = null;
  private turnSummary:
    | {
        startedAt: number;
        toolCount: number;
        startTokens?: number;
        tokensEstimated?: boolean;
      }
    | null = null;

  // Streaming state — one component per uninterrupted assistant block.
  private currentAssistant: AssistantMessageComponent | null = null;
  private turnAssistantParts: AssistantMessageComponent[] = [];
  private lastSettledContent: string | null = null;

  // Tool rows by call id; rows stay in the transcript as the durable work log.
  private toolRows = new Map<string, ToolRowComponent>();
  private ticker: NodeJS.Timeout | null = null;

  private onSubmitCallback:
    | ((text: string, attachments?: MessageAttachment[]) => void)
    | null = null;
  private promptResolver: ((value: string) => void) | null = null;
  private interruptHandler: (() => void) | null = null;
  private modeChangeHandler: ((mode: ChatMode) => void) | null = null;
  private backgroundStopHandler: ((id: string) => void) | null = null;
  private backgroundSessions: BackgroundTerminalSession[] = [];
  private pendingUserMessages = new Set<string>();
  private lastUserMessage: { content: string; at: number } | null = null;
  private activePrompt: InlinePrompt | null = null;
  private lastCtrlCAt = 0;
  private plan: Plan | null = null;
  private onTerminalResize?: () => void;
  private timelineEvents: UITimelineEvent[] = [];
  private timelineSeq = 0;
  /** Images pasted (Ctrl+V) that will ride along with the next submitted message. */
  private pendingAttachments: MessageAttachment[] = [];

  private consolePatched = false;
  private savedConsole: Partial<
    Record<"log" | "info" | "warn" | "error" | "debug", (...args: unknown[]) => void>
  > = {};

  constructor(config: TuiChatConfig) {
    this.config = config;
    this.screenReaderMode = config.ui?.screenReaderMode ?? "auto";
    this.alternateBufferMode = config.ui?.useAlternateBuffer ? "on" : "off";
    this.toolDisplayMode = config.ui?.toolDisplay ?? "compact";
    // Tool functions must not write raw progress lines while the TUI owns
    // the terminal — the differential renderer can't account for them.
    setToolConsoleQuiet(true);

    // Route the renderer's diagnostic seam into meer's diagnostics buffer.
    setTuiDiagnosticReporter(recordDiagnostic);

    this.ui = new TUI(config.terminal ?? new ProcessTerminal());

    // Drop tool-row bookkeeping for any components trimmed out of the
    // transcript so the toolRows map can't outlive its rows.
    this.chat = new BoundedTranscriptContainer(
      MAX_TRANSCRIPT_COMPONENTS,
      (removed) => {
        for (const component of removed) {
          if (component instanceof ToolRowComponent) {
            this.toolRows.delete(component.id);
          }
        }
      }
    );

    this.header = new HeaderComponent({
      provider: config.provider,
      model: config.model,
      cwd: config.cwd,
      branch: detectGitBranch(config.cwd),
    });
    // Render the transcript inline (like pi): no viewport-windowing. As the
    // conversation grows past the screen, the differential renderer scrolls
    // settled lines into the terminal's NATIVE scrollback, so the terminal's
    // own scroll + text selection/copy work normally. No in-app scroll layer.
    this.ui.addChild(this.header);
    this.ui.addChild(this.chat);
    this.ui.addChild(this.statusContainer);
    this.ui.addChild(this.toolDetailContainer);
    this.ui.addChild(this.planContainer);
    this.ui.addChild(this.promptContainer);

    this.editor = new Editor(this.ui, getEditorTheme(), { paddingX: 1 });
    this.editor.setHistory(this.history.load());
    this.editor.onSubmit = (text) => this.handleSubmit(text);
    this.installAutocomplete();
    // Size the autocomplete dropdown to the terminal instead of the vendored
    // default of 5 rows — meer's slash registry has far more than 5 commands,
    // so a tiny window made the list feel un-scrollable. Track resizes too.
    this.applyAutocompleteHeight();
    this.onTerminalResize = () => {
      this.applyAutocompleteHeight();
      this.recordResizeDiagnostic();
    };
    process.stdout.on("resize", this.onTerminalResize);
    this.editorChrome.addChild(new Spacer(1));
    this.editorChrome.addChild(this.editor as unknown as Component);
    this.ui.addChild(this.editorChrome);

    this.footer = new FooterComponent({
      provider: config.provider,
      model: config.model,
      cwd: config.cwd,
      mode: this.mode,
      screenReaderMode: this.screenReaderMode,
      alternateBufferMode: this.alternateBufferMode,
      toolDisplay: this.toolDisplayMode,
      messageCount: 0,
      queued: 0,
    });
    this.ui.addChild(this.footer);

    this.ui.addInputListener((data) => this.handleGlobalInput(data));
    this.ui.setFocus(this.editor as unknown as Component);
    this.captureConsole();
    this.ui.start();
  }

  // ── Input handling ─────────────────────────────────────────────────────────

  /**
   * Choose how many autocomplete rows to show: roughly 40% of the terminal
   * height, clamped to a comfortable range (the editor itself clamps to 3–20).
   */
  private applyAutocompleteHeight(): void {
    const rows = this.ui.terminal.rows || 24;
    const visible = Math.max(6, Math.min(15, Math.floor(rows * 0.4)));
    this.editor.setAutocompleteMaxVisible(visible);
  }


  private installAutocomplete(): void {
    let commands: SlashCommand[] = [];
    try {
      commands = getAllCommands(this.config.cwd).map((entry) => ({
        name: entry.command.replace(/^\//, ""),
        description: entry.description,
      }));
    } catch {
      // Slash registry unavailable (tests) — autocomplete simply stays off.
    }
    this.editor.setAutocompleteProvider(
      // Inject meer's file-finder cascade so the @ picker works; the tui
      // package itself stays free of any concrete file-finding backend.
      new CombinedAutocompleteProvider(commands, this.config.cwd, null, findFilesFuzzy)
    );
  }

  private handleGlobalInput(data: string): { consume?: boolean } | undefined {
    if (isShortcutHelpKey(data)) {
      this.toggleShortcutsOverlay();
      return { consume: true };
    }
    if (matchesKey(data, "escape") && this.shortcutsOverlay) {
      this.hideShortcutsOverlay();
      return { consume: true };
    }
    // Match via matchesKey, not a raw "\x03" byte: with the Kitty keyboard
    // protocol active (disambiguate flag) Ctrl+C arrives as "\x1b[99;5u", so a
    // raw-byte check would never fire and Ctrl+C wouldn't interrupt or exit.
    if (matchesKey(data, "ctrl+c")) {
      if (this.turnActive && this.interruptHandler) {
        this.interruptHandler();
        return { consume: true };
      }
      const now = Date.now();
      if (now - this.lastCtrlCAt < EXIT_CONFIRM_WINDOW_MS) {
        this.destroy();
        process.exit(0);
      }
      this.lastCtrlCAt = now;
      this.setStatus("Press Ctrl+C again to exit");
      return { consume: true };
    }
    if (this.turnActive && this.interruptHandler && matchesKey(data, "escape") && !this.activePrompt) {
      this.interruptHandler();
      return { consume: true };
    }
    if (matchesKey(data, "escape") && !this.activePrompt && this.toolDetailContainer.children.length > 0) {
      this.hideToolDetail();
      return { consume: true };
    }
    // Shift+Tab: cycle the permission mode (normal → auto-accept → plan).
    // Ignored mid-turn and while a modal prompt is open.
    if (matchesKey(data, "shift+tab") && !this.activePrompt && !this.turnActive) {
      this.cycleMode();
      return { consume: true };
    }
    // Ctrl+O: cycle how much tool detail the work log shows inline
    // (compact → auto → expanded), so output and diffs can be revealed or
    // hidden without leaving the transcript or opening /settings.
    if (matchesKey(data, "ctrl+o") && !this.activePrompt) {
      this.cycleToolDisplayMode();
      return { consume: true };
    }
    // Ctrl+V: attach an image from the clipboard if there is one. When the
    // clipboard holds no image we DON'T consume the event, so normal
    // text-paste behaviour is unaffected.
    if (matchesKey(data, "ctrl+v") && !this.activePrompt) {
      if (this.tryPasteImage()) {
        return { consume: true };
      }
    }
    return undefined;
  }

  /** Cycle the inline tool-output verbosity (Ctrl+O) and announce the change. */
  private cycleToolDisplayMode(): void {
    const order: ToolDisplayMode[] = ["compact", "auto", "expanded"];
    const next = order[(order.indexOf(this.toolDisplayMode) + 1) % order.length];
    this.setToolDisplayMode(next);
    this.appendSystemMessage(`Tool output: ${next} (Ctrl+O to cycle)`);
  }

  /**
   * Read an image off the system clipboard, persist it as an attachment, and
   * queue it for the next submitted message. Returns true if an image was
   * found (so the keypress is consumed); false means "no image — fall through".
   */
  private tryPasteImage(): boolean {
    let clip: { path: string; mimeType: string } | null = null;
    try {
      clip = readClipboardImage();
    } catch {
      clip = null;
    }
    if (!clip) return false;
    try {
      const attachment = saveAttachmentBytes(readFileSync(clip.path), clip.mimeType);
      this.pendingAttachments.push(attachment);
      this.appendSystemMessage(
        `📎 Image attached (${this.pendingAttachments.length} pending) — it will be sent with your next message.`
      );
      this.refreshFooter();
    } catch (error) {
      this.appendSystemMessage(
        `❌ Couldn't attach image: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return true;
  }

  /** Number of rendered transcript lines (debug diagnostics only). */
  private getTranscriptLineCount(): number {
    const width = this.ui.terminal.columns || 80;
    return this.chat.render(width).length;
  }

  private getLayoutMode(): string {
    const width = this.ui.terminal.columns || 80;
    if (width < 60) return "narrow";
    if (width < 100) return "standard";
    return "wide";
  }

  private recordResizeDiagnostic(): void {
    const now = Date.now();
    this.resizeEvents.push(now);
    this.resizeEvents = this.resizeEvents.filter((at) => now - at <= 2000);
    this.recordTimelineEvent(this.buildDebugTimelineEvent("resize"));
    if (this.resizeEvents.length >= 6) {
      const path = this.saveRendererSnapshot("resize-churn");
      this.recordLog("warn", `Renderer snapshot saved after resize churn: ${path}`);
      this.resizeEvents = [];
    }
  }

  private handleSubmit(rawText: string): void {
    const text = rawText.replace(/\r\n/g, "\n");
    const trimmed = text.trim();

    // An active prompt resolver (prompt / promptSecret) consumes the input
    // directly — including empty input, which lets the caller treat it as
    // "cancel". Secret input is never echoed to history and exits mask mode.
    if (this.promptResolver) {
      const resolve = this.promptResolver;
      this.promptResolver = null;
      const wasSecret = this.editor.isSecret();
      if (wasSecret) this.editor.setSecret(false);
      if (trimmed && !wasSecret) {
        this.editor.addToHistory(text);
        this.history.append(text);
      }
      resolve(text);
      return;
    }

    const attachments = this.pendingAttachments;
    // Allow submitting with just an image (no text) — same as the old Ink flow.
    if (!trimmed && attachments.length === 0) return;
    if (trimmed) {
      this.editor.addToHistory(text);
      this.history.append(text);
    }

    if (!this.onSubmitCallback) return;

    // Hand the queued attachments off with this turn, then reset.
    this.pendingAttachments = [];
    this.refreshFooter();

    if (!isSlashCommandInput(trimmed)) {
      this.appendUserMessage(trimmed, {
        optimistic: true,
        attachmentCount: attachments.length,
      });
    }
    this.onSubmitCallback(text, attachments.length > 0 ? attachments : undefined);
  }

  // ── ChatAdapter: transcript ────────────────────────────────────────────────

  appendUserMessage(
    content: string,
    options?: {
      optimistic?: boolean;
      consumeOptimistic?: boolean;
      attachmentCount?: number;
    }
  ): void {
    const normalized = content.trim();
    const attachmentCount = options?.attachmentCount ?? 0;
    if (!normalized && attachmentCount === 0) return;

    if (options?.consumeOptimistic && this.pendingUserMessages.delete(normalized)) {
      return;
    }
    if (
      this.lastUserMessage &&
      this.lastUserMessage.content === normalized &&
      Date.now() - this.lastUserMessage.at < 2500
    ) {
      return;
    }
    if (options?.optimistic) {
      this.pendingUserMessages.add(normalized);
    }

    const displayed =
      attachmentCount > 0
        ? `${normalized}${normalized ? "\n\n" : ""}📎 ${attachmentCount} image${attachmentCount === 1 ? "" : "s"} attached`
        : normalized;
    this.lastUserMessage = { content: normalized, at: Date.now() };
    this.chat.addChild(new UserMessageComponent(displayed));
    this.recordLog("note", `User message${attachmentCount > 0 ? ` (${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"})` : ""}`);
    this.messageCount++;
    this.refreshFooter();
    this.ui.requestRender();
  }

  appendSystemMessage(content: string): void {
    if (!content.trim()) return;
    this.chat.addChild(new SystemMessageComponent(content));
    this.recordLog("info", content);
    this.ui.requestRender();
  }

  addCotMessage(content: string): void {
    if (!content.trim()) return;
    this.chat.addChild(new CotMessageComponent(content));
    this.ui.requestRender();
  }

  appendToolMessage(
    toolName: string,
    content: string,
    isError?: boolean,
    metadata?: { toolCallId?: string; details?: Record<string, unknown> }
  ): void {
    const id = metadata?.toolCallId;
    let row = id ? this.toolRows.get(id) : this.findRowByName(toolName);
    if (!row) {
      // Result arrived without a lifecycle (e.g. transcript replay) — show a
      // completed row so the work log stays truthful.
      row = this.createToolRow(id ?? `tool-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, toolName);
    }
    if (isError) {
      row.setStatus("error", content);
      this.recordLog("error", `Tool ${toolName} failed: ${content.split("\n")[0] ?? ""}`);
    } else {
      // Surface the tool's output (run_command stdout, grep matches, …) in the
      // transcript. No-op for edits, which render a diff instead.
      row.setOutput(content, metadata?.details);
      this.recordLog("note", `Tool ${toolName} output updated`);
    }
    this.ui.requestRender();
  }

  replayTranscript(entries: TranscriptEntry[]): void {
    for (const entry of entries) {
      const content = entry.content.trim();
      if (!content) continue;
      switch (entry.role) {
        case "user":
          this.chat.addChild(new UserMessageComponent(content, entry.timestamp));
          this.messageCount++;
          break;
        case "assistant": {
          const component = new AssistantMessageComponent(content, {
            timestamp: entry.timestamp,
          });
          this.chat.addChild(component);
          this.lastSettledContent = content;
          this.messageCount++;
          break;
        }
        case "system":
          this.chat.addChild(new SystemMessageComponent(content));
          this.recordLog("info", content);
          break;
        case "tool": {
          const row = this.createToolRow(
            `replay-${Math.random().toString(36).slice(2, 9)}`,
            entry.metadata?.toolName ?? "tool"
          );
          row.setStatus("success");
          this.recordLog("note", `Tool ${entry.metadata?.toolName ?? "tool"} replayed`);
          break;
        }
      }
    }
    this.refreshFooter();
    this.ui.requestRender();
  }

  clearMessages(): void {
    this.chat.clear();
    this.toolRows.clear();
    this.currentAssistant = null;
    this.turnAssistantParts = [];
    this.lastSettledContent = null;
    this.messageCount = 0;
    this.timelineEvents = [];
    // Force a full redraw so the large→empty transition leaves no ghost lines
    // behind from the differential renderer.
    this.refreshFooter();
    this.ui.requestRender(true);
  }

  getLastAssistantContent(): string | null {
    if (this.lastSettledContent) return this.lastSettledContent;
    const joined = this.turnAssistantParts
      .map((part) => part.getContent())
      .filter((text) => text.trim().length > 0)
      .join("\n\n");
    return joined.trim().length > 0 ? joined : null;
  }

  // ── ChatAdapter: assistant streaming ───────────────────────────────────────

  startAssistantMessage(): void {
    if (this.currentAssistant && this.currentAssistant.isEmpty()) {
      return; // reuse the empty block
    }
    const component = new AssistantMessageComponent("", {
      // Only the first block of a turn shows the "Meer" header; blocks after
      // tool calls continue the same response.
      showHeader: this.turnAssistantParts.length === 0,
    });
    this.chat.addChild(component);
    this.currentAssistant = component;
    this.turnAssistantParts.push(component);
    this.setLoaderMessage("Writing response");
    this.recordTask("assistant-stream", "started", "Assistant response");
    this.ui.requestRender();
  }

  appendAssistantChunk(chunk: string): void {
    if (!chunk) return;
    if (!this.currentAssistant) {
      this.startAssistantMessage();
    }
    this.currentAssistant?.appendContent(chunk);
    this.ui.requestRender();
  }

  finishAssistantMessage(): void {
    // The block stays in the transcript; the next startAssistantMessage opens
    // a new block. Nothing to flush — components update in place.
    this.currentAssistant = null;
    if (this.turnActive) {
      this.setLoaderMessage("Thinking");
    }
    this.ui.requestRender();
  }

  settleAssistantMessage(content: string): void {
    const settled = content.trim();
    this.lastSettledContent = settled.length > 0 ? settled : this.lastSettledContent;
    this.messageCount++;
    if (settled) {
      this.recordTask("assistant-message", "succeeded", "Assistant response");
    }

    const streamed = this.turnAssistantParts
      .map((part) => part.getContent())
      .join("\n\n");
    if (settled && collapseWhitespace(streamed).length === 0) {
      // Nothing streamed (non-streaming provider) — render the settled text.
      const component = new AssistantMessageComponent(settled, {
        showHeader: this.turnAssistantParts.length === 0,
      });
      this.chat.addChild(component);
      this.turnAssistantParts.push(component);
    } else if (
      settled &&
      this.turnAssistantParts.length === 1 &&
      collapseWhitespace(streamed) !== collapseWhitespace(settled)
    ) {
      // Single-block response whose settled text differs from the stream
      // (provider rewrote it) — trust the settled version.
      this.turnAssistantParts[0].setContent(settled);
    }
    this.currentAssistant = null;
    this.refreshFooter();
    this.ui.requestRender();
  }

  // ── ChatAdapter: tool lifecycle ────────────────────────────────────────────

  private findRowByName(toolName: string): ToolRowComponent | undefined {
    let found: ToolRowComponent | undefined;
    for (const row of this.toolRows.values()) {
      if (row.name === toolName) found = row;
    }
    return found;
  }

  private createToolRow(
    id: string,
    toolName: string,
    args?: Record<string, unknown>
  ): ToolRowComponent {
    const row = new ToolRowComponent(id, toolName, args, {
      displayMode: this.toolDisplayMode,
      outputSettings: this.config.ui?.toolOutput,
    });
    this.toolRows.set(id, row);
    this.chat.addChild(row);
    if (this.turnActive && this.turnSummary) {
      this.turnSummary.toolCount++;
    }
    return row;
  }

  addTool(toolName: string, args?: Record<string, unknown>, idOverride?: string): string {
    const id = idOverride ?? `tool-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const existing = this.toolRows.get(id);
    if (existing) {
      existing.setName(toolName);
      existing.setArgs(args);
    } else {
      // A tool call ends the current assistant block — the next text resumes
      // in a fresh component below the row.
      this.currentAssistant = null;
      this.createToolRow(id, toolName, args);
    }
    this.setLoaderMessage(`Running ${toolName}`);
    this.recordTask(id, "started", `Tool ${toolName}`, getToolTimelineDetail(args));
    this.ensureTicker();
    this.ui.requestRender();
    return id;
  }

  previewToolCall(id: string, toolName?: string, inputTextDelta?: string): void {
    let row = this.toolRows.get(id);
    if (row) {
      if (toolName) row.setName(toolName);
    } else if (toolName) {
      this.currentAssistant = null;
      row = this.createToolRow(id, toolName);
      this.ensureTicker();
    }
    if (inputTextDelta) row?.appendStreamingArgs(inputTextDelta);
    if (row) this.recordTask(id, "updated", `Tool ${row.name}`, "receiving arguments");
    this.ui.requestRender();
  }

  startTool(id: string): void {
    const row = this.resolveRow(id);
    row?.setStatus("running");
    if (row) this.recordTask(id, "updated", `Tool ${row.name}`, "running");
    this.ensureTicker();
    this.ui.requestRender();
  }

  updateToolProgress(id: string, partial?: string): void {
    const row = this.resolveRow(id);
    if (partial) row?.setOutput(partial);
    row?.refresh();
    if (row && partial) this.recordTask(id, "updated", `Tool ${row.name}`, partial.split("\n")[0]);
    this.ui.requestRender();
  }

  completeTool(id: string, _result?: string, details?: Record<string, unknown>): void {
    const row = this.resolveRow(id);
    row?.setStatus("success");
    row?.setResult(details);
    if (row) this.recordTask(id, "succeeded", `Tool ${row.name}`, getToolTimelineDetail(details));
    this.checkTicker();
    if (this.turnActive) this.setLoaderMessage("Thinking");
    this.ui.requestRender();
  }

  failTool(id: string, error: string, _details?: Record<string, unknown>): void {
    const row = this.resolveRow(id);
    row?.setStatus("error", error);
    if (row) this.recordTask(id, "failed", `Tool ${row.name}`, error.split("\n")[0]);
    this.checkTicker();
    this.ui.requestRender();
  }

  /** Tool updates may address rows by call id or by tool name. */
  private resolveRow(handle: string): ToolRowComponent | undefined {
    return this.toolRows.get(handle) ?? this.findRowByName(handle);
  }

  clearTools(): void {
    // Rows are durable transcript entries; only the ticker state resets.
    this.checkTicker();
  }

  private ensureTicker(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      let anyActive = false;
      for (const row of this.toolRows.values()) {
        if (row.isActive()) {
          row.refresh();
          anyActive = true;
        }
      }
      if (!anyActive && !this.turnActive) {
        this.stopTicker();
      }
      this.ui.requestRender();
    }, 120);
    this.ticker.unref?.();
  }

  private checkTicker(): void {
    const anyActive = [...this.toolRows.values()].some((row) => row.isActive());
    if (!anyActive && !this.turnActive) {
      this.stopTicker();
    }
  }

  private stopTicker(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  // ── ChatAdapter: turn lifecycle ────────────────────────────────────────────

  beginTurn(): void {
    // A new user turn means any finished plan from the previous turn should stop
    // sticking to the input. (An unfinished plan stays — it spans turns.)
    this.dismissCompletedPlan();
    this.turnActive = true;
    this.turnAssistantParts = [];
    this.currentAssistant = null;
    this.lastSettledContent = null;
    this.statusText = null;
    this.iteration = null;
    this.turnSummary = {
      startedAt: Date.now(),
      toolCount: 0,
      startTokens: this.lastTokenUsage?.used,
      tokensEstimated: this.lastTokenUsage?.estimated,
    };
    this.startLoader("Thinking");
    this.recordTask("turn", "started", "Turn started");
    this.ui.requestRender();
  }

  endTurn(): void {
    this.turnActive = false;
    this.currentAssistant = null;
    this.stopLoader();
    this.finalizeActiveToolRows();
    this.checkTicker();
    this.addTurnSummary();
    this.turnSummary = null;
    this.recordTask("turn", "succeeded", "Turn finished");
    this.refreshFooter();
    this.ui.requestRender();
  }

  forceResetWorkState(): void {
    this.endTurn();
  }

  /**
   * Any tool row still pending/running when the turn ends never received its
   * completion (interrupt, provider error, or an abandoned tool). Mark them as
   * interrupted so the work log stops showing an eternal spinner with a frozen
   * timer and reads truthfully about what actually finished.
   */
  private finalizeActiveToolRows(): void {
    for (const row of this.toolRows.values()) {
      if (row.isActive()) {
        row.setStatus("interrupted");
        this.recordTask(row.id, "failed", `Tool ${row.name}`, "interrupted");
      }
    }
  }

  private addTurnSummary(): void {
    if (!this.turnSummary) return;
    const endTokens = this.lastTokenUsage?.used;
    const tokenDelta =
      typeof endTokens === "number" && typeof this.turnSummary.startTokens === "number"
        ? endTokens - this.turnSummary.startTokens
        : undefined;
    this.chat.addChild(
      new TurnSummaryComponent({
        durationMs: Date.now() - this.turnSummary.startedAt,
        toolCount: this.turnSummary.toolCount,
        tokenDelta,
        tokensEstimated: this.lastTokenUsage?.estimated ?? this.turnSummary.tokensEstimated,
      })
    );
  }

  private startLoader(message: string): void {
    if (!this.loader) {
      const s = getTuiStyles();
      this.loader = new Loader(
        this.ui,
        (text) => s.accent(text),
        (text) => s.muted(text),
        message,
        { frames: getWaveLoaderFrames(), intervalMs: WAVE_LOADER_INTERVAL_MS }
      );
      this.statusContainer.addChild(this.loader);
    }
    this.loader.setMessage(this.decorateLoaderMessage(message));
    this.loader.start();
  }

  private stopLoader(): void {
    if (this.loader) {
      this.loader.stop();
      this.statusContainer.removeChild(this.loader);
      this.loader = null;
    }
  }

  private setLoaderMessage(message: string): void {
    if (this.turnActive) {
      this.startLoader(message);
    }
  }

  private decorateLoaderMessage(message: string): string {
    const parts = [message];
    if (this.iteration && this.iteration.max) {
      parts.push(`${this.iteration.current}/${this.iteration.max}`);
    }
    parts.push("Esc stop");
    return parts.join(" · ");
  }

  // ── ChatAdapter: workflow stages / status ──────────────────────────────────

  addWorkflowStage(name: string): void {
    this.recordTask(`stage-${name}`, "started", name);
  }
  startWorkflowStage(name: string): void {
    this.recordTask(`stage-${name}`, "updated", name, "running");
    this.setLoaderMessage(name);
  }
  completeWorkflowStage(name: string): void {
    this.recordTask(`stage-${name}`, "succeeded", name);
  }
  failWorkflowStage(name: string): void {
    this.recordTask(`stage-${name}`, "failed", name);
  }

  setIteration(current: number, max?: number): void {
    this.iteration = { current, max };
    if (this.loader && this.statusText) {
      this.loader.setMessage(this.decorateLoaderMessage(this.statusText));
    }
  }

  setStatus(text: string): void {
    this.statusText = text;
    if (this.turnActive) {
      this.startLoader(text);
    } else {
      // Outside a turn, surface short statuses in the transcript instead of
      // keeping a live spinner around.
      this.stopLoader();
    }
    this.ui.requestRender();
  }

  updateTokens(used: number, limit?: number, estimated = false): void {
    this.lastTokenUsage = { used, estimated };
    this.header.update({ tokens: { used, limit }, tokensEstimated: estimated });
    this.footer.update({ tokens: { used, limit }, tokensEstimated: estimated });
    this.ui.requestRender();
  }

  updateCost(current: number, limit?: number): void {
    this.footer.update({ cost: { current, limit } });
    this.ui.requestRender();
  }

  incrementMessageCount(): void {
    this.messageCount++;
    this.refreshFooter();
  }

  private refreshFooter(): void {
    this.footer.update({
      mode: this.mode,
      screenReaderMode: this.screenReaderMode,
      alternateBufferMode: this.alternateBufferMode,
      toolDisplay: this.toolDisplayMode,
      messageCount: this.messageCount,
      queued: this.queueState.steering + this.queueState.followUp,
      attachments: this.pendingAttachments.length,
    });
    this.ui.requestRender();
  }

  // ── ChatAdapter: queue ─────────────────────────────────────────────────────

  setQueueState(queue: { steering: string[]; followUp: string[] }): void {
    this.queueState = {
      steering: queue.steering.length,
      followUp: queue.followUp.length,
    };
    this.refreshFooter();
  }

  getQueueMode(): "steer" | "followUp" {
    return this.queueMode;
  }

  // ── ChatAdapter: input ─────────────────────────────────────────────────────

  enableContinuousChat(
    onSubmit: (text: string, attachments?: MessageAttachment[]) => void
  ): void {
    this.onSubmitCallback = onSubmit;
  }

  async prompt(): Promise<string> {
    if (this.promptResolver) {
      throw new Error("Prompt already active");
    }
    return new Promise<string>((resolve) => {
      this.promptResolver = resolve;
    });
  }

  async promptSecret(): Promise<string> {
    if (this.promptResolver) {
      throw new Error("Prompt already active");
    }
    this.editor.setSecret(true);
    return new Promise<string>((resolve) => {
      this.promptResolver = resolve;
    });
  }

  async promptChoice<T extends string>(
    message: string,
    options: Array<ChoiceOption<T>>,
    defaultValue: T
  ): Promise<T> {
    if (this.activePrompt) {
      throw new Error("Prompt already active");
    }
    return new Promise<T>((resolve) => {
      const items: SelectItem[] = options.map((option) => ({
        value: option.value,
        label: option.label,
      }));
      const prompt = new InlinePrompt(message, items, "↑/↓ select · Enter confirm · Esc default");
      const finish = (value: T) => {
        this.promptContainer.removeChild(prompt);
        this.activePrompt = null;
        this.ui.setFocus(this.editor as unknown as Component);
        this.ui.requestRender();
        resolve(value);
      };
      prompt.list.onSelect = (item) => finish(item.value as T);
      prompt.onCancel = () => finish(defaultValue);
      this.activePrompt = prompt;
      this.promptContainer.addChild(prompt);
      this.ui.setFocus(prompt);
      this.ui.requestRender();
    });
  }

  async promptForm(
    title: string,
    questions: FormQuestion[],
    _submitLabel = "Submit answers"
  ): Promise<Record<string, string | string[]>> {
    const answers: Record<string, string | string[]> = {};
    for (const question of questions) {
      const label = `${title} — ${question.label}`;
      if (question.type === "select") {
        const fallback = question.options[0]?.value ?? "";
        answers[question.id] = await this.promptChoice(
          label,
          question.options.map((option) => ({ label: option.label, value: option.value })),
          fallback
        );
      } else {
        answers[question.id] = await this.promptMultiSelect(label, question.options);
      }
    }
    return answers;
  }

  private async promptMultiSelect(
    message: string,
    options: Array<{ label: string; value: string; description?: string }>
  ): Promise<string[]> {
    const selected = new Set<string>();
    const DONE = "__meer_done__";
    // Re-prompt after each toggle; Done confirms. Simple but dependable.
    for (;;) {
      const items: ChoiceOption[] = [
        ...options.map((option) => ({
          label: `${selected.has(option.value) ? "[x]" : "[ ]"} ${option.label}`,
          value: option.value,
        })),
        { label: `✓ Done (${selected.size} selected)`, value: DONE },
      ];
      const choice = await this.promptChoice(message, items, DONE);
      if (choice === DONE) return [...selected];
      if (selected.has(choice)) selected.delete(choice);
      else selected.add(choice);
    }
  }

  setInterruptHandler(handler: () => void): void {
    this.interruptHandler = handler;
  }

  setModeChangeHandler(handler: (mode: ChatMode) => void): void {
    this.modeChangeHandler = handler;
  }

  getMode(): ChatMode {
    return this.mode;
  }

  setMode(mode: ChatMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.modeChangeHandler?.(mode);
    this.refreshFooter();
  }

  /** Advance to the next permission mode (Shift+Tab) and announce the change. */
  private cycleMode(): void {
    const order: ChatMode[] = ["normal", "auto-accept", "plan"];
    const next = order[(order.indexOf(this.mode) + 1) % order.length];
    this.setMode(next);
    this.appendSystemMessage(`${describeMode(next)} (Shift+Tab to cycle)`);
  }

  private toggleShortcutsOverlay(): void {
    if (this.shortcutsOverlay) {
      this.hideShortcutsOverlay();
      return;
    }
    const overlay = new ShortcutsOverlayComponent(
      this.buildShortcutSections(),
      () => this.hideShortcutsOverlay()
    );
    this.shortcutsOverlay = this.ui.showOverlay(overlay, {
      width: 74,
      maxHeight: "95%",
      anchor: "center",
      margin: 2,
    });
    this.recordLog("info", "Shortcuts overlay shown");
  }

  private hideShortcutsOverlay(): void {
    if (!this.shortcutsOverlay) return;
    const handle = this.shortcutsOverlay;
    this.shortcutsOverlay = null;
    handle.hide();
    this.recordLog("info", "Shortcuts overlay hidden");
  }

  private buildShortcutSections(): ShortcutSection[] {
    return [
      {
        title: "Global",
        entries: [
          { keys: ["?"], description: "Show or hide this shortcuts overlay" },
          { keys: ["ctrl+c"], description: "Interrupt active turn; press twice while idle to exit" },
          { keys: ["escape"], description: "Stop active turn, close detail panels, or close overlays" },
          { keys: ["shift+tab"], description: "Cycle permission mode" },
          { keys: ["ctrl+v"], description: "Attach image from clipboard when available" },
          { keys: ["ctrl+o"], description: "Cycle inline tool output: compact → auto → expanded" },
          {
            keys: ["scroll"],
            description:
              "Scroll & select/copy use the terminal natively (its own scrollback) — meer doesn't capture the mouse",
          },
        ],
      },
      {
        title: "Commands",
        entries: [
          { keys: ["/"], description: "Open slash command autocomplete" },
          { keys: ["/tool"], description: "Show latest tool detail" },
          { keys: ["/settings show"], description: "Inspect YAML-backed UI settings" },
        ],
      },
      {
        title: "Composer",
        entries: [
          this.shortcutEntry("tui.input.submit", "Send message"),
          this.shortcutEntry("tui.input.newLine", "Insert newline"),
          this.shortcutEntry("tui.input.tab", "Accept or move through autocomplete"),
          this.shortcutEntry("tui.editor.historySearch", "Search prompt history"),
          this.shortcutEntry("tui.editor.cursorLineStart", "Move to line start"),
          this.shortcutEntry("tui.editor.cursorLineEnd", "Move to line end"),
        ],
      },
      {
        title: "Lists And Prompts",
        entries: [
          this.shortcutEntry("tui.select.up", "Move selection up"),
          this.shortcutEntry("tui.select.down", "Move selection down"),
          this.shortcutEntry("tui.select.confirm", "Confirm selected option"),
        ],
      },
    ];
  }

  private shortcutEntry(keybinding: Keybinding, description: string): { keys: string[]; description: string } {
    return {
      keys: getKeybindings().getKeys(keybinding),
      description,
    };
  }

  /** A plan with at least one task and none left pending/in-progress. */
  private isPlanComplete(plan: Plan | null): boolean {
    return (
      !!plan &&
      plan.tasks.length > 0 &&
      plan.tasks.every((t) => t.status === "completed" || t.status === "skipped")
    );
  }

  /**
   * Drop the sticky plan panel once the work is finished and the user has moved
   * on. A completed plan that keeps hugging the input is just noise — but an
   * in-progress plan must persist across turns, so only a fully-done plan is
   * cleared here.
   */
  private dismissCompletedPlan(): void {
    if (this.isPlanComplete(this.plan)) {
      this.plan = null;
      this.planContainer.clear();
    }
  }

  setPlan(plan: Plan | null): void {
    this.plan = plan;
    this.planContainer.clear();
    if (plan && plan.tasks.length > 0) {
      const s = getTuiStyles();
      const done = plan.tasks.filter((t) => t.status === "completed").length;
      const title = plan.title?.trim() ? ` ${plan.title.trim()}` : "";
      this.planContainer.addChild(new Spacer(1));
      this.planContainer.addChild(
        new Text(s.bold(s.text(`Plan${title}`)) + s.muted(` (${done}/${plan.tasks.length})`), 1, 0)
      );
      for (const task of plan.tasks.slice(0, 8)) {
        const { icon, label } = this.renderPlanTask(s, task);
        this.planContainer.addChild(new Text(`${icon} ${label}`, 1, 0));
      }
      if (plan.tasks.length > 8) {
        this.planContainer.addChild(
          new Text(s.muted(`… ${plan.tasks.length - 8} more tasks`), 1, 0)
        );
      }
    }
    this.ui.requestRender();
  }

  /** Status glyph + styled description for one plan task. */
  private renderPlanTask(
    s: ReturnType<typeof getTuiStyles>,
    task: { status: string; description: string }
  ): { icon: string; label: string } {
    switch (task.status) {
      case "completed":
        return { icon: s.success("✓"), label: s.muted(task.description) };
      case "in_progress":
        return { icon: s.accent("◐"), label: s.text(task.description) };
      case "skipped":
        return { icon: s.muted("⊘"), label: s.muted(task.description) };
      default:
        return { icon: s.muted("○"), label: s.muted(task.description) };
    }
  }

  private recordLog(
    level: "info" | "note" | "warn" | "error",
    message: string
  ): void {
    const trimmed = message.trim();
    if (!trimmed) return;
    this.recordTimelineEvent({
      id: this.nextTimelineId("log"),
      type: "log",
      level,
      message: trimmed.slice(0, 500),
      timestamp: Date.now(),
    });
  }

  private recordTask(
    id: string,
    status: "started" | "updated" | "succeeded" | "failed",
    label: string,
    detail?: string
  ): void {
    this.recordTimelineEvent({
      id: this.nextTimelineId(id),
      type: "task",
      status,
      label,
      detail: detail?.trim().slice(0, 300),
      timestamp: Date.now(),
    });
  }

  private nextTimelineId(prefix: string): string {
    this.timelineSeq += 1;
    return `${prefix}-${this.timelineSeq}`;
  }

  private recordTimelineEvent(event: UITimelineEvent): void {
    this.timelineEvents.push(event);
    if (this.timelineEvents.length > MAX_TIMELINE_EVENTS) {
      this.timelineEvents.splice(0, this.timelineEvents.length - MAX_TIMELINE_EVENTS);
    }
  }

  private buildDebugTimelineEvent(reason = "state"): UITimelineEvent {
    const state = this.getDebugState();
    return {
      id: `tui-state-${reason}`,
      type: "log",
      level: "info",
      message:
        `TUI ${reason}: layout=${state.layoutMode}, terminal=${state.terminal.columns}x${state.terminal.rows}, ` +
        `viewport=${state.viewport.transcriptRows}/${state.viewport.transcriptLines}, ` +
        `scroll=${state.viewport.scrollOffset}, hiddenAbove=${state.viewport.hiddenAbove}, hiddenBelow=${state.viewport.hiddenBelow}`,
      timestamp: Date.now(),
    };
  }

  // ── ChatAdapter: environment ───────────────────────────────────────────────

  setBackgroundSessions(sessions: BackgroundTerminalSession[]): void {
    this.backgroundSessions = sessions;
  }

  setBackgroundSessionStopHandler(handler: (id: string) => void): void {
    this.backgroundStopHandler = handler;
  }

  captureConsole(): void {
    if (this.consolePatched) return;
    this.consolePatched = true;
    const levels = ["log", "info", "warn", "error", "debug"] as const;
    for (const level of levels) {
      this.savedConsole[level] = console[level];
      console[level] = (...args: unknown[]) => {
        // Raw console writes would corrupt the differential renderer's view
        // of the terminal; route them into the transcript as system lines.
        const text = formatArgs(...(args as [unknown, ...unknown[]])).trim();
        if (!text || this.destroyed) return;
        this.chat.addChild(new SystemMessageComponent(text.slice(0, 2000)));
        this.ui.requestRender();
      };
    }
  }

  restoreConsole(): void {
    if (!this.consolePatched) return;
    this.consolePatched = false;
    for (const [level, fn] of Object.entries(this.savedConsole)) {
      if (fn) (console as unknown as Record<string, unknown>)[level] = fn;
    }
    this.savedConsole = {};
  }

  async runWithTerminal<T>(task: () => Promise<T>): Promise<T> {
    this.restoreConsole();
    setToolConsoleQuiet(false);
    this.ui.stop();
    try {
      return await task();
    } finally {
      if (!this.destroyed) {
        setToolConsoleQuiet(true);
        this.captureConsole();
        this.ui.start();
        this.ui.requestRender(true);
      }
    }
  }

  setScreenReaderMode(mode: "auto" | "on" | "off"): void {
    this.screenReaderMode = mode;
    this.recordLog("info", `Screen reader mode set to ${mode}`);
    this.refreshFooter();
  }

  setAlternateBufferMode(mode: "on" | "off" | "auto"): void {
    this.alternateBufferMode =
      mode === "auto" ? (this.config.ui?.useAlternateBuffer ? "on" : "off") : mode;
    this.recordLog("info", `Alternate buffer preference set to ${mode}`);
    this.refreshFooter();
  }

  setToolDisplayMode(mode: ToolDisplayMode): void {
    this.toolDisplayMode = mode;
    for (const row of this.toolRows.values()) {
      row.setDisplayMode(mode);
    }
    this.recordLog("info", `Tool display mode set to ${mode}`);
    this.refreshFooter();
  }

  showToolDetail(handle?: string): boolean {
    const normalized = handle?.trim();
    let row: ToolRowComponent | undefined;
    if (!normalized || normalized === "last") {
      row = [...this.toolRows.values()].at(-1);
    } else {
      row = this.resolveRow(normalized);
    }
    if (!row) return false;
    this.toolDetailContainer.clear();
    this.toolDetailContainer.addChild(new ToolDetailPanelComponent(row.getSnapshot()));
    this.recordLog("info", `Tool detail shown for ${row.name}`);
    this.ui.requestRender();
    return true;
  }

  hideToolDetail(): void {
    if (this.toolDetailContainer.children.length === 0) return;
    this.toolDetailContainer.clear();
    this.recordLog("info", "Tool detail hidden");
    this.ui.requestRender();
  }

  getTimelineEvents(limit?: number): UITimelineEvent[] {
    const events = [...this.timelineEvents, this.buildDebugTimelineEvent("current")];
    if (typeof limit === "number" && limit > 0) {
      return events.slice(-limit);
    }
    return events;
  }

  getToolSnapshot(handle?: string): ToolSnapshot | null {
    const normalized = handle?.trim();
    let row: ToolRowComponent | undefined;
    if (!normalized || normalized === "last") {
      row = [...this.toolRows.values()].at(-1);
    } else {
      row = this.resolveRow(normalized);
    }
    if (!row) return null;
    const { outputSettings: _outputSettings, ...snapshot } = row.getSnapshot();
    return snapshot;
  }

  getDebugState(): TuiDebugState {
    // The transcript renders inline (no in-app windowing); the terminal owns
    // scrollback, so there is no app-side scroll offset or hidden-line count.
    const transcriptLines = this.getTranscriptLineCount();
    return {
      renderer: "tui",
      layoutMode: this.getLayoutMode(),
      terminal: {
        columns: this.ui.terminal.columns || 80,
        rows: this.ui.terminal.rows || 24,
        kittyProtocolActive: Boolean(this.ui.terminal.kittyProtocolActive),
      },
      viewport: {
        transcriptRows: this.ui.terminal.rows || 24,
        transcriptLines,
        scrollOffset: 0,
        hiddenAbove: 0,
        hiddenBelow: 0,
      },
      overlay: {
        shortcutsVisible: Boolean(this.shortcutsOverlay),
        toolDetailVisible: this.toolDetailContainer.children.length > 0,
        promptVisible: Boolean(this.activePrompt),
      },
      modes: {
        chat: this.mode,
        screenReader: this.screenReaderMode,
        alternateBuffer: this.alternateBufferMode,
        toolDisplay: this.toolDisplayMode,
      },
      counts: {
        messages: this.messageCount,
        tools: this.toolRows.size,
        timelineEvents: this.timelineEvents.length,
      },
      lastRendererSnapshotPath: this.lastRendererSnapshotPath,
    };
  }

  saveRendererSnapshot(reason = "manual"): string {
    const snapshotDir = join(homedir(), ".meer", "renderer-snapshots");
    mkdirSync(snapshotDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const safeReason = reason.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 48) || "snapshot";
    const outputPath = join(snapshotDir, `tui-${safeReason}-${ts}.json`);
    const width = this.ui.terminal.columns || 80;
    const uiInternals = this.ui as unknown as { previousLines?: string[]; render(width: number): string[] };
    const previousLines = Array.isArray(uiInternals.previousLines) ? uiInternals.previousLines : [];
    const payload = {
      schemaVersion: 1,
      reason,
      capturedAt: new Date().toISOString(),
      debugState: this.getDebugState(),
      rendered: {
        width,
        previousLines,
        currentBaseLines: uiInternals.render(width),
      },
      timelineTail: this.timelineEvents.slice(-25),
    };
    writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf8");
    this.lastRendererSnapshotPath = outputPath;
    return outputPath;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.hideShortcutsOverlay();
    if (this.onTerminalResize) {
      process.stdout.removeListener("resize", this.onTerminalResize);
      this.onTerminalResize = undefined;
    }
    this.stopTicker();
    this.stopLoader();
    this.restoreConsole();
    setToolConsoleQuiet(false);
    this.ui.stop();
  }
}

function isShortcutHelpKey(data: string): boolean {
  return data === "?" || matchesKey(data, "?");
}

export default TuiChatAdapter;

function getToolTimelineDetail(value?: Record<string, unknown>): string | undefined {
  if (!value) return undefined;
  const path = typeof value.path === "string" ? value.path : undefined;
  if (path) return path;
  const command = typeof value.command === "string" ? value.command : undefined;
  if (command) return command;
  const diff = typeof value.diff === "string" ? value.diff : undefined;
  if (diff) {
    const lines = diff.split("\n").filter((line) => line.startsWith("+") || line.startsWith("-"));
    return `${lines.length} changed line${lines.length === 1 ? "" : "s"}`;
  }
  return undefined;
}
