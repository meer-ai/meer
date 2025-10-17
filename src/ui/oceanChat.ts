import blessed from "blessed";
import chalk from "chalk";
import { glob } from "glob";
import { existsSync, statSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import type {
  Timeline,
  InfoOptions as TimelineInfoOptions,
  TaskOptions as TimelineTaskOptions,
} from "./workflowTimeline.js";
import type { InputMode } from "./inputController.js";
import {
  SuggestionManager,
  type SuggestionItem,
} from "./suggestionManager.js";
import { DEFAULT_IGNORE_GLOBS } from "../tools/index.js";
import { slashCommands as slashCommandDefinitions } from "./slashCommands.js";
import { AuthStorage } from "../auth/storage.js";
import { getTheme, type ThemePalette } from "./theme.js";

const BUILTIN_SLASH_COMMANDS = slashCommandDefinitions.map(
  (entry) => entry.command
);

type MessageRole = "user" | "assistant" | "system" | "workflow";

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

type InputState = "idle" | "suggesting" | "submitting";

export class OceanChatUI {
  private screen: blessed.Widgets.Screen;
  private headerBox: blessed.Widgets.BoxElement;
  private chatBox: blessed.Widgets.BoxElement;
  private inputBox: blessed.Widgets.BoxElement;
  private statusBar: blessed.Widgets.BoxElement;
  private theme: ThemePalette = getTheme();
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
  private suspendedForPrompt = false;
  private statusSpinnerInterval?: NodeJS.Timeout;
  private statusSpinnerFrame = 0;
  private statusMessage: string | null = null;
  private statusRefreshInterval?: NodeJS.Timeout;
  private activeSpinnerTaskId?: string;
  private onSubmit?: (text: string) => void;
  private fileCache: {
    cwd: string;
    files: string[];
    loadedAt: number;
  } | null = null;
  private suggestionTimeout?: NodeJS.Timeout;
  private suggestionsBox?: blessed.Widgets.BoxElement;
  private suggestionManager: SuggestionManager;
  private inputMode: InputMode = null;
  private inputState: InputState = "idle";
  private lastStatusContent = "";
  private branchCache: { value: string | null; checkedAt: number } = {
    value: null,
    checkedAt: 0,
  };
  private showReasoning = false;
  private currentSuggestions: SuggestionItem[] = [];
  private suggestionIndex = 0;
  private inputBuffer = "";
  private cursorIndex = 0;
  private keypressHandler?: (
    ch: string,
    key: blessed.Widgets.Events.IKeyEventArg
  ) => void;
  private activeUserName: string | null = null;
  private mouseCaptureEnabled = false;

  constructor(config: OceanChatConfig) {
    this.config = config;
    this.screen = blessed.screen({
      smartCSR: true,
      dockBorders: true,
      autoPadding: false,
      warnings: false,
      fullUnicode: true,
      terminal: process.env.TERM || "xterm-256color",
    });

    this.screen.title = "Meer AI";

    // Suppress terminal capability errors
    this.screen.program.setupTput();
    this.screen.program.alternateBuffer();
    this.screen.program.hideCursor();
    this.enableMouseCapture(true);

    this.activeUserName = this.loadActiveUserName();

    const theme = this.theme;

    this.headerBox = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      right: 0,
      height: 3,
      tags: true,
      border: { type: "line", fg: theme.border as any },
      style: {
        fg: theme.text,
        bg: theme.surface,
        border: { fg: theme.border },
      },
    });

    // Single conversation box that includes everything
    this.chatBox = blessed.box({
      parent: this.screen,
      top: 3,
      left: 0,
      right: 0,
      bottom: 4,
      border: { type: "line", fg: theme.border as any },
      style: {
        fg: theme.text,
        bg: theme.background,
        border: { fg: theme.border },
      },
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      wrap: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollbar: {
        ch: "│",
        style: { fg: theme.primary },
      },
    });

    // Prompt display (we manage input manually for full control)
    this.inputBox = blessed.box({
      parent: this.screen,
      bottom: 1,
      left: 0,
      right: 0,
      height: 3,
      style: {
        fg: theme.text,
        bg: theme.background,
      },
      tags: true,
    });

    this.suggestionManager = new SuggestionManager({
      getProjectFiles: () => this.getProjectFiles(),
      slashCommands: BUILTIN_SLASH_COMMANDS,
    });

    this.statusBar = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      right: 0,
      height: 1,
      tags: true,
      style: {
        fg: theme.text,
        bg: theme.panel,
      },
    });

    this.bindKeys();
    this.renderStatus();
    this.renderMessages();
    this.postWelcomeMessage();
    this.initializeInputHandling();

    this.screen.render();

    this.statusRefreshInterval = setInterval(() => {
      if (this.statusSpinnerInterval) {
        return;
      }
      this.updateStatusBar();
    }, 5000);

    // Make the input live right away (even before enableContinuousChat/prompt)
    this.refocusInput();
  }

  private initializeInputHandling(): void {
    this.renderInput();
    this.keypressHandler = (ch, key) => {
      this.handleKeypress(ch ?? "", key);
    };
    this.screen.on("keypress", this.keypressHandler);
  }

  // Helper to keep input alive
  private refocusInput(): void {
    this.renderInput();
    this.screen.render();
  }

  private renderInput(): void {
    const width = this.getContentWidth() - 4;
    const cursor = Math.max(
      0,
      Math.min(this.cursorIndex, this.inputBuffer.length)
    );
    const before = this.escapeForTags(this.inputBuffer.slice(0, cursor));
    const rawChar =
      cursor < this.inputBuffer.length ? this.inputBuffer[cursor] : "";
    const after =
      cursor < this.inputBuffer.length
        ? this.escapeForTags(this.inputBuffer.slice(cursor + 1))
        : "";
    const cursorLabel =
      rawChar === "\n"
        ? " "
        : rawChar
        ? this.escapeForTags(rawChar)
        : " ";
    const cursorDisplay = `{inverse}${cursorLabel.slice(0, 1)}{/}`;
    const composed =
      this.inputBuffer.length === 0
        ? `{gray-fg}Type a message...{/}`
        : `${before}${cursorDisplay}${after}`;
    const lines = composed
      .split("\n")
      .map((line, index) =>
        `${index === 0 ? `{${this.fgTag(this.theme.accent)}}›{/}` : " "} ${
          line || " "
        }`
      )
      .flatMap((line) => this.wrapRichLine(line, width - 2));
    const frame = this.renderFramedBlock(
      "Input",
      lines.length > 0 ? lines : [" "],
      this.theme.accent
    );
    const desiredHeight = frame.split("\n").length;
    if ((this.inputBox.height as number) !== desiredHeight) {
      this.inputBox.height = desiredHeight;
      (this.inputBox as any).height = desiredHeight;
      this.inputBox.setHeight?.(desiredHeight);
      this.chatBox.bottom = desiredHeight + 1;
      (this.chatBox as any).bottom = desiredHeight + 1;
      this.chatBox.setBottom?.(desiredHeight + 1);
    }
    this.inputBox.setContent(frame);
  }

  private scrollChat(amount: number): void {
    if (!amount) {
      return;
    }
    this.chatBox.scroll(amount);
    this.screen.render();
  }

  private renderHeader(): void {
    if (!this.headerBox) {
      return;
    }
    this.headerBox.setContent(this.buildHeaderContent());
  }

  private buildHeaderContent(): string {
    const wave = "{cyan-fg}~{/}{blue-fg}≈{/}{cyan-fg}~{/}";
    const title = `{bold}{cyan-fg}🌊 Meer AI{/cyan-fg}{/bold}`;
    const providerLine = `${wave} {cyan-fg}⚙{/} {white-fg}${this.escapeForTags(this.config.provider)}:${this.escapeForTags(this.config.model)}{/}  {gray-fg}${this.escapeForTags(this.shortenPath(this.config.cwd, 48))}{/}`;
    const userLine = this.activeUserName
      ? `{green-fg}🧑  Signed in as{/} {white-fg}${this.escapeForTags(this.activeUserName)}{/}`
      : `{yellow-fg}🧑  Not signed in{/} {gray-fg}(run "meer login" to sync){/}`;
    return `${title}\n${providerLine}\n${userLine}`;
  }

  private escapeForTags(value: string): string {
    if (!value) {
      return "";
    }
    return value.replace(/\{/g, "\\{").replace(/\}/g, "\\}");
  }

  private shortenPath(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }
    return `...${value.slice(-(maxLength - 3))}`;
  }

  private loadActiveUserName(): string | null {
    try {
      const storage = new AuthStorage();
      if (!storage.isAuthenticated()) {
        return null;
      }
      const user = storage.getUser();
      if (!user) {
        return null;
      }
      return user.name || user.email || null;
    } catch {
      return null;
    }
  }

  private postWelcomeMessage(): void {
    const lines = [
      "🌊 Welcome to Meer AI!",
      "Tip: Type /help for slash commands or '@' to mention files.",
      "Press F2 to toggle text selection mode.",
    ];
    if (this.activeUserName) {
      lines.push(`Signed in as ${this.activeUserName}.`);
    } else {
      lines.push('You are not signed in. Run "meer login" to enable cloud features.');
    }
    this.appendSystemMessage(lines.join("\n"));
  }

  // Resolve @ mentions in user input
  private async resolveMentions(input: string): Promise<string> {
    const mentionPattern = /@([A-Za-z0-9._/-]+)/g;
    let working = input;
    let match: RegExpExecArray | null;
    let hasMentions = false;

    while ((match = mentionPattern.exec(working)) !== null) {
      const atIndex = match.index;
      const previousChar = atIndex > 0 ? working[atIndex - 1] : "";
      const nextChars = working.slice(atIndex, atIndex + 20);

      // Skip if part of an email or identifier
      if (previousChar && /[A-Za-z0-9._/-]/.test(previousChar)) {
        continue;
      }

      // Skip if looks like error message context
      if (
        nextChars.includes("webpack[") ||
        nextChars.includes("!=!") ||
        nextChars.includes("??") ||
        (working.includes("Error") && working.includes("loader"))
      ) {
        continue;
      }

      const fragment = match[1];
      if (!fragment) {
        continue;
      }

      hasMentions = true;
      const selection = await this.promptMentionSelection(fragment);

      if (selection === null) {
        continue; // Keep original @mention
      }

      const sanitized = this.normalizePath(selection);
      const replacement = `\`${sanitized}\``;
      working =
        working.slice(0, atIndex) +
        replacement +
        working.slice(atIndex + match[0].length);

      mentionPattern.lastIndex = atIndex + replacement.length;
    }

    return hasMentions ? working : input;
  }

  // Prompt user to select a file for @ mention
  private async promptMentionSelection(
    fragment: string
  ): Promise<string | null> {
    const files = await this.getProjectFiles();
    const matches = files
      .filter((file) => file.toLowerCase().includes(fragment.toLowerCase()))
      .slice(0, 25);

    if (matches.length === 0) {
      return null;
    }

    if (matches.length === 1) {
      return matches[0];
    }

    // For now, just return the first match
    // In a full implementation, you'd show a selection menu
    return matches[0];
  }

  // Get project files for mention resolution
  private async getProjectFiles(): Promise<string[]> {
    const cwd = this.config.cwd;

    // Check cache
    if (
      this.fileCache &&
      this.fileCache.cwd === cwd &&
      Date.now() - this.fileCache.loadedAt < 30000
    ) {
      return this.fileCache.files;
    }

    try {
      const files = await glob("**/*", {
        cwd,
        nodir: true,
        dot: false,
        ignore: DEFAULT_IGNORE_GLOBS,
      });

      const normalized = files
        .map((file) => this.normalizePath(file))
        .filter((file) => Boolean(file && file.trim()));

      this.fileCache = {
        cwd,
        files: normalized,
        loadedAt: Date.now(),
      };

      return normalized;
    } catch (error) {
      return [];
    }
  }

  // Normalize path for display
  private normalizePath(path: string): string {
    return path.replace(/\\/g, "/");
  }

  // Handle real-time input suggestions for slash commands and @ mentions
  private async handleInputSuggestions(value: string): Promise<void> {
    if (this.suggestionTimeout) {
      clearTimeout(this.suggestionTimeout);
      this.suggestionTimeout = undefined;
    }

    if (!value || (!value.startsWith("/") && !value.includes("@"))) {
      this.hideSuggestions();
      return;
    }

    const delay = value.startsWith("/") ? 0 : 150;

    this.suggestionTimeout = setTimeout(() => {
      this.suggestionTimeout = undefined;
      void this.refreshSuggestions();
    }, delay);
  }

  private async refreshSuggestions(): Promise<void> {
    const currentValue = this.inputBuffer;

    if (!currentValue || (!currentValue.startsWith("/") && !currentValue.includes("@"))) {
      this.hideSuggestions();
      return;
    }

    const suggestions = await this.suggestionManager.getSuggestions(currentValue);

    if (this.inputBuffer !== currentValue) {
      return;
    }

    if (suggestions.length > 0) {
      this.showSuggestions(suggestions);
    } else {
      this.hideSuggestions();
    }
  }

  // Show suggestions using a proper blessed List widget
  private showSuggestions(suggestions: SuggestionItem[]): void {
    if (suggestions.length === 0) return;

    // Remove existing suggestions list if any
    this.hideSuggestions();
    this.setInputState("suggesting");

    // Create a lightweight overlay above the input
    this.currentSuggestions = suggestions.slice(0, 8);
    this.suggestionIndex = 0;
    const height = Math.min(this.currentSuggestions.length, 8) + 2;
    const theme = this.theme;

    this.suggestionsBox = blessed.box({
      parent: this.screen,
      bottom: 4,
      left: 0,
      right: 0,
      height,
      border: { type: "line", fg: theme.border as any },
      style: {
        fg: theme.text,
        bg: theme.background,
        border: { fg: theme.border },
      },
      tags: true,
      mouse: true,
    });

    this.renderSuggestions();
    this.suggestionsBox.on("wheelup", () => {
      this.suggestionIndex = Math.max(0, this.suggestionIndex - 1);
      this.renderSuggestions();
      this.screen.render();
    });
    this.suggestionsBox.on("wheeldown", () => {
      this.suggestionIndex = Math.min(
        this.currentSuggestions.length - 1,
        this.suggestionIndex + 1
      );
      this.renderSuggestions();
      this.screen.render();
    });
    this.screen.render();
    this.refocusInput();
  }

  private renderSuggestions(): void {
    if (!this.suggestionsBox) {
      return;
    }
    if (this.currentSuggestions.length === 0) {
      this.suggestionsBox.setContent("");
      return;
    }

    if (this.suggestionIndex >= this.currentSuggestions.length) {
      this.suggestionIndex = Math.max(0, this.currentSuggestions.length - 1);
    }

    const lines = this.currentSuggestions.map((item, index) => {
      const isActive = index === this.suggestionIndex;
      const bullet = isActive ? "{cyan-fg}> {/}" : "  ";
      const label = isActive
        ? `{cyan-fg}${item.label}{/}`
        : item.label;
      return `${bullet}${label}`;
    });

    lines.push("{gray-fg}Tab to insert · Esc to close{/}");
    this.suggestionsBox.setContent(lines.join("\n"));
  }

  // Hide suggestions list
  private hideSuggestions(): void {
    if (this.suggestionsBox) {
      this.suggestionsBox.detach();
      this.suggestionsBox.destroy();
      this.suggestionsBox = undefined;
      this.screen.render();
    }
    this.currentSuggestions = [];
    this.suggestionIndex = 0;
    if (this.inputState === "suggesting") {
      this.setInputState("idle");
    }
  }

  private setInputValue(
    value: string,
    cursor?: number,
    options: { emitChange?: boolean } = {}
  ): void {
    this.inputBuffer = value;
    this.cursorIndex = Math.max(
      0,
      Math.min(cursor ?? value.length, value.length)
    );
    this.renderInput();
    const shouldEmit = options.emitChange !== false;
    if (shouldEmit) {
      void this.handleInputChange(this.inputBuffer);
    }
    this.handleModeChange(this.deriveInputMode(this.inputBuffer));
  }

  private insertText(text: string): void {
    if (!text) return;
    const before = this.inputBuffer.slice(0, this.cursorIndex);
    const after = this.inputBuffer.slice(this.cursorIndex);
    this.setInputValue(before + text + after, this.cursorIndex + text.length);
  }

  private deleteBackward(): void {
    if (this.cursorIndex === 0) return;
    const before = this.inputBuffer.slice(0, this.cursorIndex - 1);
    const after = this.inputBuffer.slice(this.cursorIndex);
    this.setInputValue(before + after, this.cursorIndex - 1);
  }

  private deleteForward(): void {
    if (this.cursorIndex >= this.inputBuffer.length) return;
    const before = this.inputBuffer.slice(0, this.cursorIndex);
    const after = this.inputBuffer.slice(this.cursorIndex + 1);
    this.setInputValue(before + after, this.cursorIndex);
  }

  private moveCursor(delta: number): void {
    if (delta === 0) return;
    const next = Math.max(
      0,
      Math.min(this.cursorIndex + delta, this.inputBuffer.length)
    );
    if (next === this.cursorIndex) return;
    this.cursorIndex = next;
    this.renderInput();
    this.screen.render();
  }

  private handleKeypress(
    ch: string,
    key: blessed.Widgets.Events.IKeyEventArg
  ): void {
    if (!key) {
      return;
    }
    if (!this.promptActive) {
      return;
    }

    if (!this.suggestionsBox) {
      if (key.name === "pageup") {
        this.scrollChat(-10);
        return;
      }
      if (key.name === "pagedown") {
        this.scrollChat(10);
        return;
      }
      if (key.ctrl && key.name === "up") {
        this.scrollChat(-1);
        return;
      }
      if (key.ctrl && key.name === "down") {
        this.scrollChat(1);
        return;
      }
    }

    if (key.ctrl && key.name === "c") {
      return; // let global handler process Ctrl+C
    }

    if (this.handleSuggestionNavigation(key)) {
      return;
    }

    if (key.name === "enter" || key.name === "return") {
      if (key.shift) {
        this.insertText("\n");
      } else {
        const raw = this.inputBuffer;
        if (!raw.trim()) {
          this.setInputValue("", 0, { emitChange: false });
          this.renderInput();
          this.screen.render();
          return;
        }
        this.submitInput(raw);
      }
      return;
    }

    if (key.name === "backspace") {
      this.deleteBackward();
      return;
    }

    if (key.name === "delete") {
      this.deleteForward();
      return;
    }

    if (key.name === "left") {
      this.moveCursor(-1);
      return;
    }

    if (key.name === "right") {
      this.moveCursor(1);
      return;
    }

    if (key.name === "home") {
      this.cursorIndex = 0;
      this.renderInput();
      this.screen.render();
      return;
    }

    if (key.name === "end") {
      this.cursorIndex = this.inputBuffer.length;
      this.renderInput();
      this.screen.render();
      return;
    }

    if (key.name === "escape") {
      if (this.suggestionsBox) {
        this.hideSuggestions();
        this.refocusInput();
      } else {
        this.handleInputCancel();
      }
      return;
    }

    if (key.ctrl && key.name === "u") {
      this.setInputValue("", 0);
      return;
    }

    if (key.ctrl && key.name === "a") {
      this.cursorIndex = 0;
      this.renderInput();
      this.screen.render();
      return;
    }

    if (key.ctrl && key.name === "e") {
      this.cursorIndex = this.inputBuffer.length;
      this.renderInput();
      this.screen.render();
      return;
    }

    if (ch && !key.ctrl && !key.meta) {
      this.insertText(ch);
    }
  }

  private handleSuggestionNavigation(
    key: blessed.Widgets.Events.IKeyEventArg
  ): boolean {
    if (!this.suggestionsBox) {
      return false;
    }

    if (
      key.name === "tab" &&
      !key.shift &&
      !key.ctrl &&
      !key.meta
    ) {
      this.applySuggestion();
      return true;
    }

    if (
      (key.name === "enter" || key.name === "return") &&
      !key.shift &&
      !key.ctrl &&
      !key.meta
    ) {
      this.applySuggestion();
      return true;
    }

    if (key.name === "down") {
      this.suggestionIndex = Math.min(
        this.currentSuggestions.length - 1,
        this.suggestionIndex + 1
      );
      this.renderSuggestions();
      this.screen.render();
      return true;
    }

    if (key.name === "up" || key.full === "S-tab") {
      this.suggestionIndex = Math.max(0, this.suggestionIndex - 1);
      this.renderSuggestions();
      this.screen.render();
      return true;
    }

    if (key.name === "escape") {
      this.hideSuggestions();
      this.refocusInput();
      return true;
    }

    return false;
  }

  private applySuggestion(index?: number): void {
    if (!this.currentSuggestions.length) {
      return;
    }
    const selectedIndex =
      typeof index === "number" ? index : this.suggestionIndex;
    this.suggestionIndex = selectedIndex;
    const suggestion = this.currentSuggestions[selectedIndex] ?? this.currentSuggestions[0];
    if (!suggestion) {
      return;
    }

    const currentValue = this.inputBuffer;
    const nextValue = suggestion.apply(currentValue);
    this.setInputValue(nextValue);
    this.hideSuggestions();
    this.refocusInput();
  }

  private submitInput(raw: string): void {
    this.setInputValue("", 0, { emitChange: false });
    this.handleModeChange(null);
    this.renderInput();
    this.screen.render();
    void this.handleInputSubmit(raw);
  }

  private deriveInputMode(value: string): InputMode {
    if (!value) return null;
    if (value.startsWith("/")) return "slash";
    if (value.includes("@")) return "mention";
    return null;
  }

  private handleModeChange(mode: InputMode): void {
    this.inputMode = mode;
    this.updateInputModeStatus(mode);
  }

  private setInputState(state: InputState): void {
    if (this.inputState === state) {
      return;
    }
    this.inputState = state;
    this.updateInputModeStatus(this.inputMode);
  }

  // Update status bar to show input mode
  private updateInputModeStatus(mode: InputMode): void {
    let modeTag = "";
    if (mode === "slash") {
      modeTag = " {yellow-fg}Slash Command{/}";
    } else if (mode === "mention") {
      modeTag = " {cyan-fg}File Mention{/}";
    }

    let stateTag = "";
    if (this.inputState === "suggesting") {
      stateTag = "{green-fg}● Suggestions{/}";
    } else if (this.inputState === "submitting") {
      stateTag = "{magenta-fg}● Sending{/}";
    }

    if (modeTag || stateTag) {
      const segments = [modeTag, stateTag].filter(Boolean);
      this.statusMessage = segments.join("  ");
      this.updateStatusBar();
      return;
    }

    this.statusMessage = null;
    this.updateStatusBar();
  }

  private handleInputChange(value: string): void {
    if (!value || (!value.startsWith("/") && !value.includes("@"))) {
      this.hideSuggestions();
    }

    void this.handleInputSuggestions(value);
    this.screen.render();
  }

  private async handleInputSubmit(raw: string): Promise<void> {
    const value = raw.trim();
      if (/^`[^`]+`$/.test(value)) {
        this.appendSystemMessage("{gray-fg}Add a short note along with the file mention before sending.{/}");
        this.setInputValue(`${value} `, value.length + 1, { emitChange: false });
        this.screen.render();
        return;
      }

    this.setInputState("submitting");
    this.hideSuggestions();

    try {
      if (!value) {
        this.refocusInput();
        return;
      }

      if (value.startsWith("/")) {
        if (this.onSubmit) {
          this.onSubmit(value);
          this.refocusInput();
          return;
        }

        const shouldContinue = await this.handleSlashCommand(value);
        this.refocusInput();
        if (!shouldContinue) {
          this.destroy();
          process.exit(0);
        }
        return;
      }

      const resolvedValue = await this.resolveMentions(value);

      if (this.onSubmit) {
        this.onSubmit(resolvedValue);
        this.refocusInput();
        return;
      }

      if (!this.promptActive) {
        this.refocusInput();
        return;
      }

      this.finishPrompt(resolvedValue);
    } finally {
      this.handleModeChange(null);
      this.setInputState("idle");
    }
  }

  private handleInputCancel(): void {
    this.hideSuggestions();

    if (this.onSubmit) {
      this.setInputValue("", 0, { emitChange: false });
      this.handleModeChange(null);
      this.refocusInput();
      this.setInputState("idle");
      return;
    }

    if (!this.promptActive) {
      this.setInputState("idle");
      return;
    }

    this.finishPrompt("");
    this.setInputState("idle");
  }

  // Show slash command help
  private showSlashHelp(): void {
    const helpText = `
{gray-fg}📚 Slash Command Palette{/}

{cyan-fg}/init{/}     Create AGENTS.md for project tracking
{cyan-fg}/stats{/}    Show current session statistics  
{cyan-fg}/account{/}  View account info and subscription benefits
{cyan-fg}/setup{/}    Run setup wizard to reconfigure providers
{cyan-fg}/provider{/} Switch AI provider (Ollama, OpenAI, Gemini)
{cyan-fg}/model{/}    Switch AI model
{cyan-fg}/help{/}     Show slash command help
{cyan-fg}/history{/}  Show recent prompts you've entered
{cyan-fg}/exit{/}      Exit chat session

{gray-fg}💡 Type '@' to mention files, or use slash commands above{/}
`;

    this.appendSystemMessage(helpText.trim());
  }

  // Handle slash commands
  private async handleSlashCommand(command: string): Promise<boolean> {
    const [cmd, ...args] = command.split(" ");

    switch (cmd) {
      case "/help":
        this.showSlashHelp();
        return true;

      case "/init":
        this.appendSystemMessage("Creating AGENTS.md for project tracking...");
        // You would implement the actual /init logic here
        return true;

      case "/stats":
        this.appendSystemMessage(
          "Session statistics would be displayed here..."
        );
        return true;

      case "/account":
        this.appendSystemMessage(
          "Account information would be displayed here..."
        );
        return true;

      case "/setup":
        this.appendSystemMessage("Setup wizard would be launched here...");
        return true;

      case "/provider":
        this.appendSystemMessage("Provider selection would be shown here...");
        return true;

      case "/model":
        this.appendSystemMessage("Model selection would be shown here...");
        return true;

      case "/history":
        this.appendSystemMessage("Recent prompts would be displayed here...");
        return true;

      case "/exit":
        this.appendSystemMessage("Exiting chat session...");
        return false; // Signal to exit

      default:
        this.appendSystemMessage(
          `Unknown command: ${cmd}. Type /help for available commands.`
        );
        return true;
    }
  }

  destroy(): void {
    if (this.promptActive) {
      this.promptRejecter?.(new Error("UI destroyed"));
    }
    if (this.keypressHandler) {
      this.screen.off("keypress", this.keypressHandler);
      this.keypressHandler = undefined;
    }
    this.hideSuggestions();
    this.restoreConsole();
    if (this.statusRefreshInterval) {
      clearInterval(this.statusRefreshInterval);
      this.statusRefreshInterval = undefined;
    }
    this.stopStatusSpinner();
    this.screen.program.showCursor();
    this.screen.program.normalBuffer();
    const input: any = this.screen.program?.input ?? process.stdin;
    if (input?.isTTY && typeof input.setRawMode === "function") {
      input.setRawMode(false);
    }
    this.screen.destroy();
  }

  // Continuous chat mode - better UX
  enableContinuousChat(onSubmit: (text: string) => void): void {
    this.onSubmit = onSubmit;
    this.promptActive = true;
    this.setInputValue("", 0, { emitChange: false });
    this.handleModeChange(null);
    this.refocusInput();
  }

  // Legacy prompt() API for backwards compatibility
  async prompt(): Promise<string> {
    if (this.promptActive) {
      throw new Error("Prompt already active");
    }

    this.promptActive = true;

    return new Promise((resolve, reject) => {
      this.promptResolver = resolve;
      this.promptRejecter = reject;

      // Clear input and focus
      this.setInputValue("", 0, { emitChange: false });
      this.handleModeChange(null);
      this.refocusInput();
    });
  }

  appendUserMessage(content: string): void {
    if (!content.trim()) return;
    this.messages.push({ role: "user", content });
    this.renderMessages();
    this.scrollToBottom();
  }

  startAssistantMessage(): void {
    this.currentAssistantIndex =
      this.messages.push({
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
    this.stopStatusSpinner(false);
    const trimmed = text?.trim();
    this.statusMessage = trimmed
      ? `{cyan-fg}${this.escapeForTags(trimmed)}{/}`
      : null;
    this.updateStatusBar();
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

  async runWithTerminal<T>(task: () => Promise<T>): Promise<T> {
    if (this.suspendedForPrompt) {
      return task();
    }

    this.suspendedForPrompt = true;
    const handler = this.keypressHandler;
    if (handler) {
      this.screen.off("keypress", handler);
    }

    this.restoreConsole();

    const program = (this.screen as unknown as { program?: any }).program;
    const screenAny = this.screen as unknown as {
      leave?: () => void;
      enter?: () => void;
    };

    const disableRawMode = () => {
      const input: any = program?.input ?? process.stdin;
      if (input?.isTTY && typeof input.setRawMode === "function") {
        input.setRawMode(false);
      }
    };
    const enableRawMode = () => {
      const input: any = program?.input ?? process.stdin;
      if (input?.isTTY && typeof input.setRawMode === "function") {
        input.setRawMode(true);
      }
    };

    disableRawMode();
    program?.showCursor?.();
    program?.disableMouse?.();
    program?.normalBuffer?.();
    screenAny.leave?.();
    program?.flush?.();
    console.log(""); // ensure prompt starts on a clean line

    try {
      return await task();
    } finally {
      screenAny.enter?.();
      program?.alternateBuffer?.();
      program?.enableMouse?.();
      program?.hideCursor?.();
      enableRawMode();
      if (handler) {
        this.screen.on("keypress", handler);
      }
      this.captureConsole();
      this.renderMessages();
      this.renderInput();
      this.screen.render();
      this.refocusInput();
      this.suspendedForPrompt = false;
    }
  }

  async promptChoice<T extends string>(
    message: string,
    options: Array<{ label: string; value: T }>,
    defaultValue: T
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      const theme = this.theme;
      const overlay = blessed.box({
        top: "center",
        left: "center",
        width: "50%",
        height: options.length + 6,
        border: { type: "line", fg: theme.accent },
        style: {
          bg: theme.background,
          border: { fg: theme.accent },
        },
        tags: true,
      } as any);

      blessed.text({
        parent: overlay,
        top: 1,
        left: 2,
        width: "90%",
        content: `{cyan-fg}${message}{/}`,
        tags: true,
      });

      const list = blessed.list({
        parent: overlay,
        top: 3,
        left: 2,
        width: "90%",
        height: options.length + 2,
        keys: true,
        mouse: true,
        vi: true,
        style: {
          item: { fg: theme.text },
          selected: { fg: theme.background, bg: theme.accent },
        },
      } as any) as blessed.Widgets.ListElement & { selected?: number };

      options.forEach((option) => list.addItem(option.label));

      const defaultIndex = Math.max(
        0,
        options.findIndex((option) => option.value === defaultValue)
      );
      (list as any).select(defaultIndex);

      const cleanup = (result: T) => {
        overlay.destroy();
        this.screen.render();
        this.refocusInput();
        resolve(result);
      };

      const getSelectedIndex = (): number => {
        const idx = list.selected;
        return typeof idx === "number" ? idx : defaultIndex;
      };

      list.key(["enter"], () => {
        const index = getSelectedIndex();
        const selected = options[index] ?? options[defaultIndex];
        cleanup(selected.value);
      });

      list.key(["escape", "q"], () => cleanup(defaultValue));

      this.screen.append(overlay);
      this.screen.render();
      list.focus();
    });
  }

  getTimelineAdapter(): Timeline {
    return {
      startTask: (label: string, options: TimelineTaskOptions = {}) =>
        this.startTask(label, options.detail),
      updateTask: (id: string, detail: string) => this.updateTask(id, detail),
      succeed: (id: string, detail?: string) =>
        this.completeTask(id, "success", detail),
      fail: (id: string, detail?: string) =>
        this.completeTask(id, "error", detail),
      info: (message: string, options?: TimelineInfoOptions) =>
        this.addTimelineEntry(
          "info",
          message,
          options?.icon,
          options?.color,
          options?.dim
        ),
      note: (message: string) => this.addTimelineEntry("note", message),
      warn: (message: string) => this.addTimelineEntry("warn", message),
      error: (message: string) => this.addTimelineEntry("error", message),
      close: () => this.stopStatusSpinner(),
    };
  }

  private bindKeys(): void {
    // Global Ctrl+C handler
    this.screen.key(["C-c"], () => {
      this.stopStatusSpinner();
      this.destroy();
      console.log("\n");
      process.exit(0);
    });

    // Also handle Ctrl+C on the input box
    this.inputBox.key(["C-c"], () => {
      this.stopStatusSpinner();
      this.destroy();
      console.log("\n");
      process.exit(0);
    });

    // Clear screen
    this.screen.key(["C-l"], () => {
      this.messages = [];
      this.timelineEntries = [];
      this.renderMessages();
    });

    // Enable scrolling with arrow keys
    this.chatBox.key(["up"], () => this.scrollChat(-1));
    this.chatBox.key(["down"], () => this.scrollChat(1));
    this.chatBox.key(["pageup"], () => this.scrollChat(-10));
    this.chatBox.key(["pagedown"], () => this.scrollChat(10));
    this.chatBox.on("wheelup", () => this.scrollChat(-3));
    this.chatBox.on("wheeldown", () => this.scrollChat(3));
    this.screen.key(["f2"], () => this.toggleMouseCapture());
    this.screen.key(["C-r"], () => {
      this.showReasoning = !this.showReasoning;
      const status = this.showReasoning
        ? "Showing reasoning blocks"
        : "Hiding reasoning blocks";
      this.setStatus(status);
      this.renderMessages();
    });
  }

  private finishPrompt(value: string): void {
    const resolver = this.promptResolver;
    this.promptResolver = null;
    this.promptRejecter = null;
    this.promptActive = false;

    this.setInputValue("", 0, { emitChange: false });
    this.handleModeChange(null);
    this.refocusInput();
    this.updateStatusBar();

    resolver?.(value.trim());
  }

  private renderStatus(): void {
    this.renderHeader();
    this.updateStatusBar();
  }
  private formatForChat(raw: string): string {
    const parts: string[] = [];
    const regex = /```([a-zA-Z0-9+-_.]*)?\n([\s\S]*?)```/g;
    let last = 0;
    let m: RegExpExecArray | null;

    while ((m = regex.exec(raw)) !== null) {
      if (m.index > last) {
        parts.push(this.escape(raw.slice(last, m.index)));
      }
      const lang = m[1] || "";
      const code = m[2].replace(/\r\n/g, "\n");
      parts.push(this.renderCodeBlock(code, lang));
      last = regex.lastIndex;
    }
    if (last < raw.length) {
      parts.push(this.escape(raw.slice(last)));
    }

    return parts.join("");
  }

  private pruneReasoningBlocks(content: string): string {
    if (this.showReasoning) {
      return content;
    }

    const withoutToolBlocks = content.replace(
      /<tool name="[^"]+"[\s\S]*?<\/tool>/g,
      ""
    );

    const withoutReasoningLines = withoutToolBlocks
      .replace(/^Thinking.*$/gm, "")
      .replace(/^Iteration\s+\d+.*$/gm, "")
      .replace(/^Executing\s+\d+\s+tool\(s\)\.\.\.$/gm, "")
      .replace(/^\s*🛠.*$/gm, "");

    const collapsed = withoutReasoningLines
      .split("\n")
      .filter((line, index, arr) => {
        if (line.trim().length > 0) {
          return true;
        }
        const nextLine = arr[index + 1];
        return Boolean(nextLine && nextLine.trim().length > 0);
      })
      .join("\n");

    return collapsed.trim();
  }

  private decorateAssistantContent(raw: string): string {
    const formatted = this.formatForChat(raw);
    const withoutReasoning = this.pruneReasoningBlocks(formatted);
    return this.highlightAssistantMarkup(withoutReasoning);
  }

  private renderCodeBlock(code: string, lang: string): string {
    const safe = this.escape(code);
    const title = lang ? ` {gray-fg}[${lang}]{/}` : "";
    const lines = safe.split("\n").map((l) => `  ${l}`);
    return (
      `\n{gray-fg}┌─ code${title} ─────────────────────┐{/}\n` +
      `{gray-fg}${lines.join("\n")}{/}\n` +
      `{gray-fg}└────────────────────────────────────┘{/}\n`
    );
  }

  private highlightAssistantMarkup(content: string): string {
    let result = content;

    result = result.replace(/^(Thinking.*)$/gm, (line) => `{cyan-fg}${line}{/}`);
    result = result.replace(/^(Tokens:.*)$/gm, (line) => `{gray-fg}${line}{/}`);
    result = result.replace(/^(Iteration\s+\d+\/\d+)/gm, (line) => `{yellow-fg}${line}{/}`);
    result = result.replace(/Executing\s+\d+\s+tool\(s\)\.\.\./g, (line) => `{magenta-fg}${line}{/}`);

    result = result.replace(/<tool name="([^"]+)"([^>]*)>/g, (_match, name, attrs) => {
      const friendly = this.getFriendlyToolLabel(name);
      const attrMatches = Array.from(attrs.matchAll(/(\w+)="([^"]*)"/g)) as RegExpMatchArray[];
      const attrDisplay = attrMatches
        .map((match) => {
          const key = match[1] ?? "";
          const val = match[2] ?? "";
          return `{green-fg}${this.escapeForTags(key)}{/}{gray-fg}="${this.escapeForTags(val)}"{/}`;
        })
        .join("  ");
      return attrDisplay
        ? `{cyan-fg}🛠  ${friendly}{/}  ${attrDisplay}`
        : `{cyan-fg}🛠  ${friendly}{/}`;
    });

    result = result.replace(/<\/tool>/g, `{cyan-fg}🛠  done{/}`);
    result = result.replace(/^(\s*)([a-z_]+)\s+running$/gm, (_match, indent, tool) =>
      `${indent}{cyan-fg}🛠  ${this.getFriendlyToolLabel(tool)} running{/}`
    );

    return result;
  }

  private getFriendlyToolLabel(name: string): string {
    const normalized = name.toLowerCase();
    const labels: Record<string, string> = {
      analyze_project: "Analyze Project",
      read_file: "Read File",
      read_many_files: "Read Files",
      read_folder: "Read Folder",
      list_files: "List Files",
      find_files: "Find Files",
      search_text: "Search Text",
      grep: "Grep",
      run_command: "Run Command",
      propose_edit: "Edit / Create File",
      write_file: "Write File",
      edit_line: "Edit Line",
      save_memory: "Save Memory",
      load_memory: "Load Memory",
      google_search: "Google Search",
      web_fetch: "Fetch Web",
      read_image: "Read Image",
      read_many_images: "Read Images",
      git_status: "Git Status",
      git_diff: "Git Diff",
      git_log: "Git Log",
      git_commit: "Git Commit",
      git_branch: "Git Branch",
    };
    if (labels[normalized]) {
      return labels[normalized];
    }
    return this.toTitleCase(normalized.replace(/_/g, " "));
  }

  private toTitleCase(value: string): string {
    return value.replace(/\b\w+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
  }


  private toggleMouseCapture(): void {
    if (this.mouseCaptureEnabled) {
      this.disableMouseCapture();
    } else {
      this.enableMouseCapture();
    }
  }

  private enableMouseCapture(silent = false): void {
    if (this.mouseCaptureEnabled) {
      return;
    }
    this.mouseCaptureEnabled = true;
    (this.screen as any).enableMouse?.();
    (this.screen.program as any).enableMouse?.();
    if (!silent) {
      this.appendSystemMessage("{gray-fg}Mouse capture re-enabled. Press F2 again to enter selection mode.{/}");
    }
  }

  private disableMouseCapture(): void {
    if (!this.mouseCaptureEnabled) {
      return;
    }
    this.mouseCaptureEnabled = false;
    (this.screen as any).disableMouse?.();
    (this.screen.program as any).disableMouse?.();
    this.appendSystemMessage("{yellow-fg}Selection mode active.{/} {gray-fg}Click and drag to highlight text. Press F2 to resume interactive mode.{/}");
  }

  private renderMessages(): void {
    const blocks: string[] = [];

    for (const message of this.messages) {
      switch (message.role) {
        case "user": {
          const block = this.renderUserBlock(message.content);
          if (block) blocks.push(block);
          break;
        }
        case "assistant": {
          const content = this.decorateAssistantContent(message.content);
          const block = this.renderAssistantBlock(content);
          if (block.trim()) blocks.push(block);
          break;
        }
        case "system": {
          const block = this.renderSystemBlock(message.content);
          if (block) blocks.push(block);
          break;
        }
        case "workflow":
          // workflow messages are handled via timeline rendering
          break;
      }
    }

    const activeWorkflow = this.timelineEntries
      .filter(
        (entry) =>
          entry.status === "pending" &&
          entry.label.trim().toLowerCase() !== "thinking"
      )
      .slice(-3);

    if (activeWorkflow.length > 0) {
      blocks.push(this.renderWorkflowBlock(activeWorkflow));
    }

    if (blocks.length === 0) {
      this.chatBox.setContent(
        "\n{gray-fg}Ask me anything about your code...{/}"
      );
    } else {
      this.chatBox.setContent(blocks.join("\n\n"));
    }

    this.screen.render();
  }

  private renderUserBlock(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) {
      return "";
    }
    const width = this.getContentWidth() - 4;
    const textWidth = Math.max(8, width - 2);
    const segments = trimmed.split(/\r?\n/);
    const wrapped: string[] = [];
    segments.forEach((segment, idx) => {
      const chunk = this.wrapPlainText(segment, textWidth - 2);
      wrapped.push(...(chunk.length ? chunk : [""]));
      if (idx < segments.length - 1) {
        wrapped.push("");
      }
    });
    const lines = wrapped.map((line, index) =>
      `${index === 0 ? `{${this.fgTag(this.theme.accent)}}›{/}` : " "} ${
        index === 0 ? "" : " "
      }{white-fg}${this.escape(line)}{/}`
    );
    return this.renderFramedBlock("You", lines, this.theme.accent);
  }

  private renderAssistantBlock(content: string): string {
    const trimmed = content.trim();
    if (!trimmed) {
      return "";
    }
    const width = this.getContentWidth() - 4;
    const textWidth = Math.max(8, width - 2);
    const segments = trimmed.split(/\r?\n/);
    const wrappedLines: string[] = [];
    segments.forEach((segment, idx) => {
      const chunk = this.wrapRichLine(segment, textWidth - 2);
      wrappedLines.push(...(chunk.length ? chunk : [""]));
      if (idx < segments.length - 1) {
        wrappedLines.push("");
      }
    });
    const lines = wrappedLines.map((line, index) =>
      `${index === 0 ? `{${this.fgTag(this.theme.primary)}}◦{/}` : " "} ${
        line || " "
      }`
    );
    return this.renderFramedBlock("Meer", lines, this.theme.primary);
  }

  private renderSystemBlock(raw: string): string {
    if (!raw.trim()) {
      return "";
    }
    const width = this.getContentWidth() - 4;
    const textWidth = Math.max(8, width - 2);
    const segments = raw.split(/\r?\n/);
    const wrapped: string[] = [];
    segments.forEach((segment, idx) => {
      const chunk = this.wrapPlainText(segment, textWidth);
      wrapped.push(...(chunk.length ? chunk : [""]));
      if (idx < segments.length - 1) {
        wrapped.push("");
      }
    });
    const lines = wrapped.map(
      (line) => `{gray-fg}${this.escape(line)}{/}`
    );
    return this.renderFramedBlock("System", lines, this.theme.muted);
  }

  private renderWorkflowBlock(entries: TimelineEntry[]): string {
    const items = entries.map((entry) => this.renderTimelineEntry(entry));
    return this.renderFramedBlock("Tasks", items, this.theme.accent);
  }

  private renderTimelineEntry(entry: TimelineEntry): string {
    switch (entry.type) {
      case "task": {
        let icon = `{${this.fgTag(this.theme.accent)}}○{/}`;
        if (entry.status === "success") {
          icon = `{${this.fgTag(this.theme.success)}}✓{/}`;
        } else if (entry.status === "error") {
          icon = `{${this.fgTag(this.theme.danger)}}✗{/}`;
        }
        const detail = entry.detail
          ? ` {gray-fg}${this.escape(entry.detail)}{/}`
          : "";
        return `${icon} ${this.escape(entry.label)}${detail}`;
      }
      case "info":
      case "note": {
        // Don't escape the label for notes as it may contain emojis/formatted text
        // Ensure the label is displayed properly without escaping
        return `${entry.label}`;
      }
      default:
        return `{gray-fg}${this.escape(entry.label)}{/}`;
    }
  }

  private scrollToBottom(): void {
    this.chatBox.setScrollPerc(100);
    this.screen.render();
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

    this.renderMessages();
    this.scrollToBottom();

    this.activeSpinnerTaskId = id;
    const spinnerLabel = detail ? `${label}` : label;
    this.startStatusSpinner(spinnerLabel);
    return id;
  }

  private updateTask(id: string, detail: string): void {
    const entry = this.timelineEntries.find((item) => item.id === id);
    if (!entry) return;

    entry.detail = detail;
    this.renderMessages();

    if (this.activeSpinnerTaskId === id) {
      this.startStatusSpinner(entry.label);
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

    this.renderMessages();

    if (this.activeSpinnerTaskId === id) {
      this.stopStatusSpinner();
      this.activeSpinnerTaskId = undefined;
    }
  }

  private addTimelineEntry(
    type: TimelineEntryType,
    label: string,
    _icon?: string,
    _color?: string,
    _dim?: boolean
  ): void {
    const entry: TimelineEntry = {
      id: `note-${++this.timelineSequence}`,
      type,
      label,
    };

    this.timelineEntries.push(entry);
    this.renderMessages();
    this.scrollToBottom();
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
    const content = this.buildStatusLine(activeText);
    this.setStatusContent(content);
  }

  private buildStatusLine(activeText?: string): string {
    const parts: string[] = [];
    const cwdLabel = this.escapeForTags(this.shortenPath(this.config.cwd, 40));
    parts.push(`{gray-fg}${cwdLabel}{/}`);

    const branch = this.getCurrentBranch();
    if (branch) {
      parts.push(
        `{green-fg}🌿{/} {white-fg}${this.escapeForTags(branch)}{/}`
      );
    }

    const providerLabel = `${this.escapeForTags(
      this.config.provider
    )}:${this.escapeForTags(this.config.model)}`;
    parts.push(`{cyan-fg}⚙{/} {white-fg}${providerLabel}{/}`);

    const userSegment = this.activeUserName
      ? `{green-fg}🧑{/} {white-fg}${this.escapeForTags(
          this.activeUserName
        )}{/}`
      : `{yellow-fg}🧑{/} {gray-fg}guest{/}`;
    parts.push(userSegment);

    parts.push(`{gray-fg}/help · Ctrl+C to exit{/}`);

    let statusSegment: string | null = null;
    if (activeText !== undefined) {
      const trimmed = activeText.trim();
      statusSegment = trimmed
        ? `{cyan-fg}${this.escapeForTags(trimmed)}{/}`
        : null;
    } else if (this.statusMessage) {
      statusSegment = this.statusMessage;
    }

    if (statusSegment) {
      parts.push(statusSegment);
    }

    return parts.filter(Boolean).join("  ");
  }

  private getCurrentBranch(): string | null {
    const now = Date.now();
    if (now - this.branchCache.checkedAt < 5000) {
      return this.branchCache.value;
    }

    this.branchCache.checkedAt = now;
    try {
      const output = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: this.config.cwd,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      if (!output || output === "HEAD") {
        this.branchCache.value = null;
      } else {
        this.branchCache.value = output;
      }
    } catch {
      this.branchCache.value = null;
    }

    return this.branchCache.value;
  }

  private startStatusSpinner(label: string): void {
    this.stopStatusSpinner(false);
    this.statusSpinnerFrame = 0;
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    this.statusSpinnerInterval = setInterval(() => {
      const frame = frames[this.statusSpinnerFrame % frames.length];
      this.statusSpinnerFrame += 1;
      this.updateStatusBar(`${frame} ${label}`);
    }, 80);
  }

  private stopStatusSpinner(refresh = true): void {
    if (this.statusSpinnerInterval) {
      clearInterval(this.statusSpinnerInterval);
      this.statusSpinnerInterval = undefined;
    }
    if (refresh) {
      this.updateStatusBar();
    }
  }

  private setStatusContent(content: string): void {
    if (this.lastStatusContent === content) {
      return;
    }
    this.lastStatusContent = content;
    this.statusBar.setContent(content);
    this.screen.render();
  }

  private getContentWidth(): number {
    const screenWidth =
      typeof this.screen.width === "number" ? this.screen.width : 100;
    return Math.max(40, screenWidth - 6);
  }

  private fgTag(color: string): string {
    const hex = color.startsWith("#") ? color.slice(1) : color;
    return color.startsWith("#") ? `#${hex}-fg` : color;
  }

  private renderFramedBlock(
    title: string,
    lines: string[],
    color: string
  ): string {
    const frameWidth = this.getContentWidth();
    const innerWidth = frameWidth - 2;
    const textWidth = Math.max(10, innerWidth - 2);
    const top = this.buildFrameEdge("┌", "┐", title, color, innerWidth);
    const bottom = this.buildFrameEdge("└", "┘", "", color, innerWidth);
    const contentLines =
      lines.length > 0 ? lines : [" "];
    const body = contentLines
      .flatMap((line) => this.wrapRichLine(line, textWidth))
      .map(
        (line) =>
          `{${this.fgTag(color)}}│{/} ${this.padVisible(
            line,
            textWidth
          )} {${this.fgTag(color)}}│{/}`
      );
    return [top, ...body, bottom].join("\n");
  }

  private buildFrameEdge(
    left: string,
    right: string,
    title: string,
    color: string,
    innerWidth: number
  ): string {
    const display = title ? ` ${title} ` : "";
    const visible = this.visibleLength(display);
    const available = Math.max(0, innerWidth - visible);
    const leftFill = Math.floor(available / 2);
    const rightFill = available - leftFill;
    return `{${this.fgTag(color)}}${left}${"─".repeat(leftFill)}${display}${"─".repeat(
      rightFill
    )}${right}{/}`;
  }

  private wrapPlainText(text: string, width: number): string[] {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > width && current) {
        lines.push(current);
        current = word;
      } else if (candidate.length > width) {
        lines.push(word);
        current = "";
      } else {
        current = candidate;
      }
    }
    if (current) {
      lines.push(current);
    }
    return lines.length ? lines : [text];
  }

  private wrapRichLine(line: string, width: number): string[] {
    if (this.visibleLength(line) <= width) {
      return [this.padVisible(line, width)];
    }

    const segments: string[] = [];
    let current = "";
    let visible = 0;
    const tokens = line.match(/\{[^}]+\}|./g) ?? [];
    for (const token of tokens) {
      if (token.startsWith("{") && token.endsWith("}")) {
        current += token;
        continue;
      }
      if (visible >= width) {
        segments.push(this.padVisible(current, width));
        current = "";
        visible = 0;
      }
      current += token;
      visible += 1;
    }
    if (current) {
      segments.push(this.padVisible(current, width));
    }
    return segments.length ? segments : [this.padVisible("", width)];
  }

  private padVisible(text: string, width: number): string {
    const visible = this.visibleLength(text);
    if (visible >= width) {
      return text;
    }
    return `${text}${" ".repeat(width - visible)}`;
  }

  private visibleLength(text: string): number {
    return this.stripFormatting(text).length;
  }

  private stripFormatting(text: string): string {
    return text.replace(/\{[^}]+\}/g, "");
  }
}

export type OceanChatTimeline = ReturnType<OceanChatUI["getTimelineAdapter"]>;
