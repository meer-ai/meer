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
import type {
  ChatAdapter,
  ChatMode,
  ChoiceOption,
  FormQuestion,
  TranscriptEntry,
} from "../chat-adapter.js";
import { readFileSync } from "node:fs";
import type { MessageAttachment } from "../../agent/core/types.js";
import { readClipboardImage } from "../../utils/clipboard-image.js";
import { saveAttachmentBytes } from "../../utils/attachments.js";
import type { Plan } from "../../plan/types.js";
import type { BackgroundTerminalSession } from "../../runtime/backgroundTerminals.js";
import type { UITimelineEvent } from "../shared/timelineTypes.js";
import { collapseWhitespace } from "../shared/streamCommit.js";
import type { UISettings } from "../ui-settings.js";
import { getAllCommands } from "../../slash/registry.js";
import { isSlashCommandInput } from "../../slash/utils.js";
import { setToolConsoleQuiet } from "../../tools/index.js";
import { CombinedAutocompleteProvider, type SlashCommand } from "../tui/autocomplete.js";
import { Editor } from "../tui/components/editor.js";
import { PromptHistoryStore } from "../promptHistory.js";
import { Loader } from "../tui/components/loader.js";
import { SelectList, type SelectItem } from "../tui/components/select-list.js";
import { Spacer } from "../tui/components/spacer.js";
import { Text } from "../tui/components/text.js";
import { matchesKey } from "../tui/keys.js";
import { ProcessTerminal, type Terminal } from "../tui/terminal.js";
import { type Component, Container, TUI } from "../tui/tui.js";
import {
  AssistantMessageComponent,
  CotMessageComponent,
  FooterComponent,
  HeaderComponent,
  SystemMessageComponent,
  ToolRowComponent,
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

export class TuiChatAdapter implements ChatAdapter {
  private config: TuiChatConfig;
  private ui: TUI;
  private chat = new Container();
  private statusContainer = new Container();
  private planContainer = new Container();
  private promptContainer = new Container();
  private editor: Editor;
  private readonly history = new PromptHistoryStore();
  private footer: FooterComponent;
  private loader: Loader | null = null;

  private mode: ChatMode = "normal";
  private screenReaderMode: "auto" | "on" | "off";
  private alternateBufferMode: "on" | "off";
  private turnActive = false;
  private destroyed = false;
  private messageCount = 0;
  private queueState = { steering: 0, followUp: 0 };
  private queueMode: "steer" | "followUp" = "steer";
  private statusText: string | null = null;
  private iteration: { current: number; max?: number } | null = null;

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
    // Tool functions must not write raw progress lines while the TUI owns
    // the terminal — the differential renderer can't account for them.
    setToolConsoleQuiet(true);

    this.ui = new TUI(config.terminal ?? new ProcessTerminal());

    this.ui.addChild(new HeaderComponent(config.provider, config.model, config.cwd));
    this.ui.addChild(this.chat);
    this.ui.addChild(this.statusContainer);
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
    this.onTerminalResize = () => this.applyAutocompleteHeight();
    process.stdout.on("resize", this.onTerminalResize);
    const editorContainer = new Container();
    editorContainer.addChild(new Spacer(1));
    editorContainer.addChild(this.editor as unknown as Component);
    this.ui.addChild(editorContainer);

    this.footer = new FooterComponent({
      provider: config.provider,
      model: config.model,
      cwd: config.cwd,
      mode: this.mode,
      screenReaderMode: this.screenReaderMode,
      alternateBufferMode: this.alternateBufferMode,
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
      new CombinedAutocompleteProvider(commands, this.config.cwd)
    );
  }

  private handleGlobalInput(data: string): { consume?: boolean } | undefined {
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
    // Shift+Tab: cycle the permission mode (normal → auto-accept → plan).
    // Ignored mid-turn and while a modal prompt is open.
    if (matchesKey(data, "shift+tab") && !this.activePrompt && !this.turnActive) {
      this.cycleMode();
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
    this.refreshFooter();
    this.ui.requestRender();
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
    const row = new ToolRowComponent(id, toolName, args);
    this.toolRows.set(id, row);
    this.chat.addChild(row);
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
    this.startLoader("Thinking");
    this.recordTask("turn", "started", "Turn started");
    this.ui.requestRender();
  }

  endTurn(): void {
    this.turnActive = false;
    this.currentAssistant = null;
    this.stopLoader();
    this.checkTicker();
    this.recordTask("turn", "succeeded", "Turn finished");
    this.refreshFooter();
    this.ui.requestRender();
  }

  forceResetWorkState(): void {
    this.endTurn();
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

  getTimelineEvents(limit?: number): UITimelineEvent[] {
    if (typeof limit === "number" && limit > 0) {
      return this.timelineEvents.slice(-limit);
    }
    return [...this.timelineEvents];
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
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
