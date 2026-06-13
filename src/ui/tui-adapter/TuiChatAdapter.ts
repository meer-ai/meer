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
import type { MessageAttachment } from "../../agent/core/types.js";
import type { Plan } from "../../plan/types.js";
import type { BackgroundTerminalSession } from "../../runtime/backgroundTerminals.js";
import type { UITimelineEvent } from "../shared/timelineTypes.js";
import { collapseWhitespace } from "../shared/streamCommit.js";
import { getAllCommands } from "../../slash/registry.js";
import { isSlashCommandInput } from "../../slash/utils.js";
import { setToolConsoleQuiet } from "../../tools/index.js";
import { CombinedAutocompleteProvider, type SlashCommand } from "../tui/autocomplete.js";
import { Editor } from "../tui/components/editor.js";
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
  /** Injected for tests; defaults to a real ProcessTerminal. */
  terminal?: Terminal;
}

const EXIT_CONFIRM_WINDOW_MS = 1500;

/** Inline prompt (choice/form question) shown above the editor. */
class InlinePrompt extends Container {
  list: SelectList;
  onCancel?: () => void;

  constructor(message: string, items: SelectItem[], hint: string) {
    super();
    const s = getTuiStyles();
    this.addChild(new Spacer(1));
    this.addChild(new Text(s.bold(s.text(message)), 1, 0));
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

export class TuiChatAdapter implements ChatAdapter {
  private config: TuiChatConfig;
  private ui: TUI;
  private chat = new Container();
  private statusContainer = new Container();
  private planContainer = new Container();
  private promptContainer = new Container();
  private editor: Editor;
  private footer: FooterComponent;
  private loader: Loader | null = null;

  private mode: ChatMode = "edit";
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

  private consolePatched = false;
  private savedConsole: Partial<
    Record<"log" | "info" | "warn" | "error" | "debug", (...args: unknown[]) => void>
  > = {};

  constructor(config: TuiChatConfig) {
    this.config = config;
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
    return undefined;
  }

  private handleSubmit(rawText: string): void {
    const text = rawText.replace(/\r\n/g, "\n");
    const trimmed = text.trim();
    if (!trimmed) return;
    this.editor.addToHistory(text);

    if (this.promptResolver) {
      const resolve = this.promptResolver;
      this.promptResolver = null;
      resolve(text);
      return;
    }
    if (!this.onSubmitCallback) return;

    if (!isSlashCommandInput(trimmed)) {
      this.appendUserMessage(trimmed, { optimistic: true });
    }
    this.onSubmitCallback(text);
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
    this.messageCount++;
    this.refreshFooter();
    this.ui.requestRender();
  }

  appendSystemMessage(content: string): void {
    if (!content.trim()) return;
    this.chat.addChild(new SystemMessageComponent(content));
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
          break;
        case "tool": {
          const row = this.createToolRow(
            `replay-${Math.random().toString(36).slice(2, 9)}`,
            entry.metadata?.toolName ?? "tool"
          );
          row.setStatus("success");
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
    this.ensureTicker();
    this.ui.requestRender();
    return id;
  }

  previewToolCall(id: string, toolName?: string, _inputTextDelta?: string): void {
    const row = this.toolRows.get(id);
    if (row) {
      if (toolName) row.setName(toolName);
    } else if (toolName) {
      this.currentAssistant = null;
      this.createToolRow(id, toolName);
      this.ensureTicker();
    }
    this.ui.requestRender();
  }

  startTool(id: string): void {
    this.resolveRow(id)?.setStatus("running");
    this.ensureTicker();
    this.ui.requestRender();
  }

  updateToolProgress(id: string, _partial?: string): void {
    // The spinner row already animates; detailed progress stays out of the
    // transcript to keep the work log quiet.
    this.resolveRow(id)?.refresh();
    this.ui.requestRender();
  }

  completeTool(id: string, _result?: string, _details?: Record<string, unknown>): void {
    this.resolveRow(id)?.setStatus("success");
    this.checkTicker();
    if (this.turnActive) this.setLoaderMessage("Thinking");
    this.ui.requestRender();
  }

  failTool(id: string, error: string, _details?: Record<string, unknown>): void {
    this.resolveRow(id)?.setStatus("error", error);
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
    this.turnActive = true;
    this.turnAssistantParts = [];
    this.currentAssistant = null;
    this.lastSettledContent = null;
    this.statusText = null;
    this.iteration = null;
    this.startLoader("Thinking");
    this.ui.requestRender();
  }

  endTurn(): void {
    this.turnActive = false;
    this.currentAssistant = null;
    this.stopLoader();
    this.checkTicker();
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

  addWorkflowStage(_name: string): void {}
  startWorkflowStage(name: string): void {
    this.setLoaderMessage(name);
  }
  completeWorkflowStage(_name: string): void {}
  failWorkflowStage(_name: string): void {}

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

  updateTokens(used: number, limit?: number): void {
    this.footer.update({ tokens: { used, limit } });
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
      messageCount: this.messageCount,
      queued: this.queueState.steering + this.queueState.followUp,
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

  setPlan(plan: Plan | null): void {
    this.plan = plan;
    this.planContainer.clear();
    if (plan && plan.tasks.length > 0) {
      const s = getTuiStyles();
      this.planContainer.addChild(new Spacer(1));
      for (const task of plan.tasks.slice(0, 8)) {
        const icon =
          task.status === "completed"
            ? s.success("✓")
            : task.status === "in_progress"
              ? s.accent("›")
              : s.muted("○");
        this.planContainer.addChild(new Text(`${icon} ${s.muted(task.description)}`, 1, 0));
      }
      if (plan.tasks.length > 8) {
        this.planContainer.addChild(
          new Text(getTuiStyles().muted(`… ${plan.tasks.length - 8} more tasks`), 1, 0)
        );
      }
    }
    this.ui.requestRender();
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
      this.savedConsole[level] = console[level].bind(console);
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
    this.ui.stop();
    try {
      return await task();
    } finally {
      this.captureConsole();
      this.ui.start();
      this.ui.requestRender(true);
    }
  }

  setScreenReaderMode(_mode: "auto" | "on" | "off"): void {
    // The differential renderer emits plain lines; no separate SR layout yet.
  }

  setAlternateBufferMode(_mode: "on" | "off" | "auto"): void {
    // pi-tui renders in the main buffer by design (scrollback is the point).
  }

  getTimelineEvents(_limit?: number): UITimelineEvent[] {
    return [];
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
    this.ui.stop();
  }
}

export default TuiChatAdapter;
