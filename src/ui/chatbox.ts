import chalk from "chalk";
import inquirer from "inquirer";
import { glob } from "glob";
import { createInterface, Interface } from "readline";
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { showSlashHelp } from "./slashHelp.js";
import {
  getAllCommands,
  type SlashCommandListEntry,
} from "../slash/registry.js";
import { getSlashCommandBadges } from "../slash/utils.js";

function formatBadgeLabel(badge: string): string {
  switch (badge) {
    case "custom":
      return chalk.green("custom");
    case "override":
      return chalk.yellow("override");
    case "custom metadata":
      return chalk.magenta("custom metadata");
    case "reserved":
      return chalk.red("reserved");
    default:
      return badge;
  }
}

function formatSlashCommandLabel(entry: SlashCommandListEntry): string {
  const base = `${chalk.cyan(entry.command)} ${chalk.gray(`- ${entry.description}`)}`;
  const badges = getSlashCommandBadges(entry);
  if (badges.length === 0) {
    return base;
  }

  const badgeText = badges
    .map((badge) => formatBadgeLabel(badge))
    .join(chalk.gray(", "));

  return `${base} ${chalk.gray("[")}${badgeText}${chalk.gray("]")}`;
}
import { SessionStats, SessionTracker } from "../session/tracker.js";
import { displayWave } from "./logo.js";
import { DEFAULT_IGNORE_GLOBS } from "../tools/index.js";
import { LineEditor } from "./lineEditor.js";
import { MentionController } from "./mentionController.js";
import { formatCost } from "../pricing/config.js";

export class ChatBoxUI {
  private static readonly MENTION_KEEP = "__MEER_MENTION_KEEP__";
  private static readonly MENTION_CANCEL = "__MEER_MENTION_CANCEL__";
  private static readonly MENTION_REFINE = "__MEER_MENTION_REFINE__";
  private static readonly MENTION_MAX_RESULTS = 25;
  private static readonly MENTION_RECENT_WINDOW_MS =
    1000 * 60 * 60 * 24 * 14;
  private static fileCache: {
    cwd: string;
    files: string[];
    loadedAt: number;
  } | null = null;
  private static fileMtimeCache = new Map<string, number>();

  /**
   * Simple, clean input using readline - like successful CLI tools
   */
  static handleInput(config: {
    provider: string;
    model: string;
    cwd?: string;
  }): Promise<string> {
    return new Promise((resolve) => {
      const isInteractive = Boolean(
        process.stdin.isTTY && process.stdout.isTTY
      );

      if (!isInteractive) {
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
          terminal: false,
        });

        const lines: string[] = [];
        let resolved = false;

        const finish = (value: string) => {
          if (!resolved) {
            resolved = true;
            const trimmed = value.trim();
            if (trimmed) {
              ChatBoxUI.appendHistory(ChatBoxUI.getHistoryPath(), trimmed);
            }
            resolve(trimmed);
          }
        };

        rl.on("line", (input) => {
          lines.push(input);
        });

        rl.on("close", () => {
          finish(lines.join("\n"));
        });

        rl.on("SIGINT", () => {
          rl.close();
          process.exit(0);
        });

        return;
      }

      const currentCwd = config.cwd || process.cwd();
      const historyPath = ChatBoxUI.getHistoryPath();
      const history = ChatBoxUI.loadHistory(historyPath);

      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: chalk.cyan("> "),
        terminal: true,
        history,
        historySize: 500,
      });

      const editor = new LineEditor(rl);

      let slashHelpShown = false;
      let menuActive = false;
      const bufferedLines: string[] = [];
      let finalizeTimer: NodeJS.Timeout | null = null;

      const promptUser = (preserve: boolean = false) => rl.prompt(preserve);

      let mentionController: MentionController;

      const setMenuActive = (active: boolean) => {
        menuActive = active;
        if (mentionController) {
          mentionController.setEnabled(!active);
        }

        if (active) {
          if (finalizeTimer) {
            clearTimeout(finalizeTimer);
            finalizeTimer = null;
          }
          bufferedLines.length = 0;
        }
      };

      const exitMenu = (callback?: () => void) => {
        // Immediately set menu inactive to allow input processing
        setMenuActive(false);
        // Run callback on next tick to allow UI cleanup
        if (callback) {
          setImmediate(callback);
        }
      };

      const editorChangeUnsubscribe = editor.onChange((event) => {
        if (menuActive) {
          return;
        }

        const { state, source, data } = event;
        const trimmed = state.buffer.trim();

        if (slashHelpShown && trimmed !== "/") {
          slashHelpShown = false;
        }

        if (source !== "user") {
          return;
        }

        const chunkText =
          typeof data === "string"
            ? data
            : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : "";

        const isPrintable =
          (chunkText.length > 0 && /[\w\s/]/.test(chunkText)) ||
          chunkText === "/";

        if (!slashHelpShown && isPrintable && trimmed === "/") {
          slashHelpShown = true;
          console.log("");
          showSlashHelp();
          promptUser(true);
        }
      });

      mentionController = new MentionController(editor, {
        debounceMs: 300,
        minChars: 2,
        onTrigger: async ({ fragment, start, state }) => {
          if (menuActive) {
            return;
          }

          setMenuActive(true);
          const originalState = { ...state };
          rl.pause();

          try {
            const selection = await ChatBoxUI.promptMentionSelection(
              fragment,
              currentCwd,
              {
                inputStream: (rl as Interface & {
                  input?: NodeJS.ReadableStream;
                }).input,
              }
            );

            if (selection === ChatBoxUI.MENTION_CANCEL) {
              editor.setState(originalState.buffer, originalState.cursor);
              return;
            }

            if (selection === ChatBoxUI.MENTION_KEEP) {
              editor.setState(originalState.buffer, originalState.cursor);
              return;
            }

            const sanitized = ChatBoxUI.normalizePath(selection);
            const mentionText = `\`${sanitized}\``;
            const before = originalState.buffer.slice(0, start);
            const afterOriginal = originalState.buffer.slice(
              start + fragment.length + 1
            );
            const needsSpace =
              afterOriginal.length > 0 && !/^\s/.test(afterOriginal);
            const newBuffer = `${before}${mentionText}${
              needsSpace ? " " : ""
            }${afterOriginal}`;
            const cursorPos =
              before.length + mentionText.length + (needsSpace ? 1 : 0);

            editor.setState(newBuffer, cursorPos);
          } catch (error) {
            // Handle errors gracefully - restore original state
            const message =
              error instanceof Error ? error.message : String(error);
            console.log(chalk.yellow(`\n  ⚠️  Mention error: ${message}`));
            editor.setState(originalState.buffer, originalState.cursor);
          } finally {
            rl.resume();
            exitMenu(() => {
              editor.refresh();
              promptUser(true);
            });
          }
        },
      });

      const finalizeInput = () => {
        if (finalizeTimer) {
          clearTimeout(finalizeTimer);
          finalizeTimer = null;
        }

        if (menuActive) {
          bufferedLines.length = 0;
          return;
        }

        slashHelpShown = false;

        const rawInput = bufferedLines.join("\n");
        bufferedLines.length = 0;

        const trimmed = rawInput.trim();

        if (!trimmed) {
          promptUser(true);
          return;
        }

        if (trimmed === "/") {
          setMenuActive(true);
          rl.pause();

          void ChatBoxUI.pickSlashCommand()
            .then((selection) => {
              rl.resume();
              exitMenu(() => {
                if (!selection) {
                  promptUser();
                  return;
                }

                rl.close();
                resolve(selection);
              });
            })
            .catch(() => {
              rl.resume();
              exitMenu(() => {
                promptUser();
              });
            });
          return;
        }

      const processMessage = async () => {
        setMenuActive(true);

        try {
          const resolved =
            (await ChatBoxUI.resolveMentions(trimmed, currentCwd)) ?? null;

          if (resolved === null) {
            setMenuActive(false);
            promptUser(true);
            return;
          }

          setMenuActive(false);
          ChatBoxUI.appendHistory(historyPath, resolved);
          rl.close();
          resolve(resolved);
        } catch (error) {
          setMenuActive(false);
          const message =
            error instanceof Error ? error.message : String(error);
          console.log(chalk.red(`  ❌ ${message}`));
          promptUser(true);
        }
      };

        void processMessage();
      };

      const scheduleFinalize = () => {
        if (finalizeTimer) {
          clearTimeout(finalizeTimer);
        }
        finalizeTimer = setTimeout(finalizeInput, 15);
      };

      rl.on("line", (input) => {
        if (menuActive) {
          bufferedLines.length = 0;
          return;
        }

        bufferedLines.push(input);
        scheduleFinalize();
      });

      rl.on("SIGINT", () => {
        rl.close();
        process.exit(0);
      });

      rl.on("close", () => {
        editorChangeUnsubscribe();
        mentionController.dispose();
        editor.dispose();
        if (finalizeTimer) {
          clearTimeout(finalizeTimer);
        }
      });

      promptUser();
    });
  }

  private static async pickSlashCommand(): Promise<string | null> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return null;
    }

    console.log("");

    const entries = getAllCommands();
    const choices: Array<{ name: string; value: string | null }> = entries.map(
      (entry) => ({
        name: formatSlashCommandLabel(entry),
        value: entry.command,
      }),
    );

    choices.push({ name: chalk.gray("Cancel"), value: null });

    const { selectedSlash } = await inquirer.prompt<{
      selectedSlash: string | null;
    }>([
      {
        type: "list",
        name: "selectedSlash",
        message: "Select a slash command:",
        choices,
      },
    ]);

    return selectedSlash;
  }

  private static async resolveMentions(
    input: string,
    cwd?: string
  ): Promise<string | null> {
    if (!cwd || !process.stdin.isTTY || !process.stdout.isTTY) {
      return input;
    }

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

      // Skip if looks like error message context (webpack, decorators, etc.)
      if (nextChars.includes('webpack[') ||
          nextChars.includes('!=!') ||
          nextChars.includes('??') ||
          working.includes('Error') && working.includes('loader')) {
        continue;
      }

      const fragment = match[1];
      if (!fragment) {
        continue;
      }

      hasMentions = true;
      const selection = await ChatBoxUI.promptMentionSelection(fragment, cwd);

      if (selection === ChatBoxUI.MENTION_CANCEL) {
        return null;
      }

      if (selection === ChatBoxUI.MENTION_KEEP) {
        continue;
      }

      const sanitized = ChatBoxUI.normalizePath(selection);
      const replacement = `\`${sanitized}\``;
      working =
        working.slice(0, atIndex) +
        replacement +
        working.slice(atIndex + match[0].length);

      mentionPattern.lastIndex = atIndex + replacement.length;
    }

    return hasMentions ? working : input;
  }

  private static async promptMentionSelection(
    fragment: string,
    cwd: string,
    options?: { inputStream?: NodeJS.ReadableStream }
  ): Promise<string> {
    // Safeguard: if fragment is empty or just whitespace, return keep
    if (!fragment || !fragment.trim()) {
      return ChatBoxUI.MENTION_KEEP;
    }

    let query = fragment;
    const original = fragment;

    while (true) {
      const matches = ChatBoxUI.getFileMatches(query, cwd);
      const limited = matches.slice(0, ChatBoxUI.MENTION_MAX_RESULTS);

      const displayQuery = query.replace(/\\/g, "/");
      const choices: any[] = limited.map((file) => ({
        name: ChatBoxUI.highlightMatch(file, displayQuery),
        value: file,
      }));

      if (limited.length === 0) {
        choices.push({
          name: chalk.yellow("No matching files – refine your search"),
          value: ChatBoxUI.MENTION_REFINE,
        });
      } else if (matches.length > limited.length) {
        choices.push({
          name: chalk.gray(
            `Show more results (${matches.length - limited.length} hidden)`
          ),
          value: ChatBoxUI.MENTION_REFINE,
        });
      } else {
        choices.push({
          name: chalk.gray("Refine search"),
          value: ChatBoxUI.MENTION_REFINE,
        });
      }

      choices.push(new inquirer.Separator());
      choices.push({
        name: chalk.yellow(`Keep @${original} as typed`),
        value: ChatBoxUI.MENTION_KEEP,
      });
      choices.push({
        name: chalk.gray("Cancel message"),
        value: ChatBoxUI.MENTION_CANCEL,
      });

      const promptModule = inquirer.createPromptModule();
      const prompt = promptModule<{
        selection: string;
      }>([
        {
          type: "list",
          name: "selection",
          message: `Select file for @${original}${
            query !== original && query
              ? chalk.gray(` (filtered: "${query}")`)
              : ""
          }`,
          choices,
          pageSize: Math.max(choices.length, 10),
        },
      ]);

      const ui = (prompt as unknown as { ui?: { close?: () => void } }).ui;
      const inputStream = options?.inputStream;
      let cancelledByTyping = false;
      const pendingReplay: Array<Buffer | string> = [];
      let replayScheduled = false;

      const scheduleReplay = () => {
        if (!inputStream || replayScheduled || pendingReplay.length === 0) {
          return;
        }

        replayScheduled = true;

        // Use setImmediate to ensure inquirer has fully cleaned up
        setImmediate(() => {
          replayScheduled = false;

          if (!inputStream || typeof (inputStream as any).unshift !== "function") {
            pendingReplay.length = 0;
            return;
          }

          // Replay all pending chunks in FIFO order
          const chunks = [...pendingReplay];
          pendingReplay.length = 0;

          // Push chunks back to stream in reverse order since unshift adds to front
          for (let i = chunks.length - 1; i >= 0; i--) {
            const chunk = chunks[i];
            if (chunk !== undefined) {
              (inputStream as any).unshift(chunk);
            }
          }
        });
      };

      const shouldCancelForChunk = (chunk: Buffer | string): boolean => {
        const value =
          typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (!value) {
          return false;
        }
        // Allow enter/return to be handled by inquirer
        if (value === "\r" || value === "\n") {
          return false;
        }
        // Allow Ctrl+C to be handled by inquirer
        if (value === "\u0003") {
          return false;
        }
        // Allow all escape sequences (arrows, function keys, etc)
        if (value.startsWith("\u001b")) {
          return false;
        }
        // Allow tab for navigation
        if (value === "\t") {
          return false;
        }
        // Allow backspace/delete in some contexts
        if (value === "\x7f" || value === "\b") {
          return false;
        }
        // Cancel on any other printable character
        return true;
      };

      const handleStreamData = (chunk: Buffer | string) => {
        if (!shouldCancelForChunk(chunk)) {
          return;
        }

        // User typed something - cancel the menu
        cancelledByTyping = true;
        pendingReplay.push(chunk);

        // Immediately remove listener to prevent duplicate handling
        if (inputStream) {
          inputStream.removeListener("data", handleStreamData);
        }

        // Close the inquirer UI
        if (ui && typeof ui.close === "function") {
          ui.close();
        }

        // Schedule replay on next tick to ensure menu is fully closed
        scheduleReplay();
      };

      if (inputStream) {
        inputStream.on("data", handleStreamData);
      }

      let selection: string;

      try {
        ({ selection } = await prompt);
      } catch (error) {
        if (cancelledByTyping) {
          scheduleReplay();
          return ChatBoxUI.MENTION_KEEP;
        }
        throw error;
      } finally {
        if (inputStream) {
          inputStream.removeListener("data", handleStreamData);
        }
        scheduleReplay();
      }

      if (cancelledByTyping) {
        return ChatBoxUI.MENTION_KEEP;
      }

      if (selection === ChatBoxUI.MENTION_REFINE) {
        const { nextQuery } = await inquirer.prompt<{ nextQuery: string }>([
          {
            type: "input",
            name: "nextQuery",
            message: "Refine file search:",
            default: query,
          },
        ]);
        query = nextQuery.trim();
        continue;
      }

      if (
        selection === ChatBoxUI.MENTION_KEEP ||
        selection === ChatBoxUI.MENTION_CANCEL
      ) {
        return selection;
      }

      return selection;
    }
  }

  private static getFileMatches(query: string, cwd: string): string[] {
    const files = ChatBoxUI.loadProjectFiles(cwd);
    const normalized = (query || "").trim().toLowerCase().replace(/\\/g, "/");
    const tokens = normalized.split(/[\\/\s]+/).filter(Boolean);

    const withScores = (tokens.length === 0 ? files : files)
      .map((file) => {
        const lower = file.toLowerCase();

        if (tokens.length > 0 && !tokens.every((token) => lower.includes(token))) {
          return null;
        }

        const segments = lower.split("/");
        const filename = segments[segments.length - 1] ?? lower;

        const scoreToken = (segment: string, token: string): number => {
          if (!token) {
            return 0;
          }
          const idx = segment.indexOf(token);
          if (idx === -1) {
            return 0;
          }

          let score = token.length * 5;

          if (idx === 0) {
            score += 25;
          } else {
            score += Math.max(0, 12 - idx);
          }

          if (segment.length === token.length) {
            score += 10;
          }

          return score;
        };

        let nameScore = 0;
        let bestSegmentScore = 0;
        let pathScore = 0;

        if (tokens.length > 0) {
          nameScore = tokens.reduce(
            (acc, token) => acc + scoreToken(filename, token),
            0
          );

          if (segments.length > 1) {
            bestSegmentScore = segments
              .slice(0, -1)
              .reduce((best, segment) => {
                const segmentScore = tokens.reduce(
                  (acc, token) => acc + scoreToken(segment, token),
                  0
                );
                return segmentScore > best ? segmentScore : best;
              }, 0);
          }

          pathScore = tokens.reduce(
            (acc, token) => acc + scoreToken(lower, token) * 0.5,
            0
          );

          if (nameScore === 0 && bestSegmentScore === 0 && pathScore === 0) {
            return null;
          }
        }

        const recencyBoost = ChatBoxUI.getRecencyBoost(cwd, file);
        const extensionBoost = ChatBoxUI.getExtensionBoost(file);

        const score =
          nameScore * 4 +
          bestSegmentScore * 2 +
          pathScore +
          recencyBoost +
          extensionBoost;

        return { file, score };
      })
      .filter((item): item is { file: string; score: number } => item !== null);

    if (withScores.length === 0) {
      return [];
    }

    return withScores
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        if (a.file.length !== b.file.length) {
          return a.file.length - b.file.length;
        }
        return a.file.localeCompare(b.file);
      })
      .map((item) => item.file);
  }

  private static getExtensionBoost(file: string): number {
    const lower = file.toLowerCase();
    if (lower.endsWith(".tsx") || lower.endsWith(".ts")) {
      return 15;
    }
    if (lower.endsWith(".jsx") || lower.endsWith(".js")) {
      return 10;
    }
    if (lower.endsWith(".md") || lower.endsWith(".json")) {
      return 6;
    }
    return 0;
  }

  private static getRecencyBoost(cwd: string, relative: string): number {
    const cacheKey = `${cwd}::${relative}`;
    const now = Date.now();
    const cached = ChatBoxUI.fileMtimeCache.get(cacheKey);

    let mtime = cached;
    if (mtime === undefined) {
      try {
        mtime = statSync(join(cwd, relative)).mtimeMs;
      } catch {
        mtime = 0;
      }
      ChatBoxUI.fileMtimeCache.set(cacheKey, mtime);
    }

    if (!mtime) {
      return 0;
    }

    const age = now - mtime;

    if (age <= 0) {
      return 20;
    }

    if (age >= ChatBoxUI.MENTION_RECENT_WINDOW_MS) {
      return 0;
    }

    const freshness = 1 - age / ChatBoxUI.MENTION_RECENT_WINDOW_MS;
    return Math.round(freshness * 20);
  }

  private static loadProjectFiles(cwd: string): string[] {
    const now = Date.now();
    const cache = ChatBoxUI.fileCache;

    if (cache && cache.cwd === cwd && now - cache.loadedAt < 5 * 60 * 1000) {
      return cache.files;
    }

    if (!cache || cache.cwd !== cwd) {
      ChatBoxUI.fileMtimeCache.clear();
    }

    const files = glob.sync("**/*", {
      cwd,
      nodir: true,
      ignore: DEFAULT_IGNORE_GLOBS,
      dot: false,
    }).map((file) => ChatBoxUI.normalizePath(file));

    const maxFiles = 10000;
    const limited =
      files.length > maxFiles ? files.slice(0, maxFiles) : files;

    ChatBoxUI.fileCache = { cwd, files: limited, loadedAt: now };
    return limited;
  }

  private static highlightMatch(text: string, query: string): string {
    if (!query) {
      return text;
    }

    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!escaped) {
      return text;
    }

    const regex = new RegExp(escaped, "ig");
    let lastIndex = 0;
    let highlighted = "";
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      highlighted += text.slice(lastIndex, match.index);
      highlighted += chalk.cyan(match[0]);
      lastIndex = match.index + match[0].length;
    }

    highlighted += text.slice(lastIndex);
    return highlighted;
  }

  private static normalizePath(path: string): string {
    return path.replace(/\\/g, "/").replace(/^\.\//, "");
  }

  private static lastStatusSignature: string | null = null;

  private static getHistoryPath(): string {
    return join(homedir(), ".meer", "history.log");
  }

  private static loadHistory(path: string): string[] {
    try {
      if (existsSync(path)) {
        const contents = readFileSync(path, "utf-8");
        return contents.split("\n").filter(Boolean).slice(-500).reverse();
      }
    } catch {
      // Ignore history loading errors
    }
    return [];
  }

  private static appendHistory(path: string, entry: string): void {
    const trimmed = entry.trim();
    if (!trimmed) {
      return;
    }

    try {
      mkdirSync(join(homedir(), ".meer"), { recursive: true });
      const stream = createWriteStream(path, { flags: "a" });
      stream.write(`${trimmed}\n`);
      stream.end();
    } catch {
      // Ignore history write errors
    }
  }

  static getHistoryEntries(limit = 10): string[] {
    const history = ChatBoxUI.loadHistory(ChatBoxUI.getHistoryPath());
    return history.slice(0, limit);
  }

  static async printPaged(lines: string[], pageSize?: number): Promise<void> {
    if (lines.length === 0) {
      return;
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      lines.forEach((line) => console.log(line));
      return;
    }

    const rows = Math.max(10, (process.stdout.rows || 24) - 4);
    const size = Math.max(10, pageSize ?? rows);

    for (let offset = 0; offset < lines.length; offset += size) {
      const chunk = lines.slice(offset, offset + size);
      chunk.forEach((line) => console.log(line));

      if (offset + size >= lines.length) {
        break;
      }

      const { continuePaging } = await inquirer.prompt<{
        continuePaging: boolean;
      }>([
        {
          type: "confirm",
          name: "continuePaging",
          message: "Show more output?",
          default: true,
        },
      ]);

      if (!continuePaging) {
        break;
      }
    }
  }

  static colorizeDiffLine(line: string): string {
    if (line.startsWith("@@")) {
      return chalk.cyan(line);
    }
    if (line.startsWith("+")) {
      return chalk.green(line);
    }
    if (line.startsWith("-")) {
      return chalk.red(line);
    }
    if (line.startsWith(" ")) {
      return chalk.gray(line);
    }
    return chalk.white(line);
  }

  static renderStatusBar(config: {
    provider: string;
    model: string;
    cwd?: string;
    status?: string;
    force?: boolean;
  }): void {
    if (!process.stdout.isTTY) {
      ChatBoxUI.lastStatusSignature = null;
      return;
    }

    const cols = Math.max(10, Math.min(process.stdout.columns || 80, 120));
    const cwd = config.cwd || process.cwd();
    const shortCwd = cwd.length > 40 ? `...${cwd.slice(-37)}` : cwd;
    const statusLabel = config.status || "ready";

    // Get auth status
    let authInfo = "";
    try {
      const fs = require("fs");
      const path = require("path");
      const os = require("os");
      const authPath = path.join(os.homedir(), ".meer", "auth.json");
      if (fs.existsSync(authPath)) {
        const authData = JSON.parse(fs.readFileSync(authPath, "utf-8"));
        if (authData.user) {
          const name = authData.user.name.split(" ")[0]; // First name only
          const tier = authData.user.subscription_tier;
          authInfo = ` ${chalk.gray("|")} ${chalk.cyan(name)} ${chalk.dim(`(${tier})`)}`;
        }
      }
    } catch (error) {
      // Silently ignore auth errors
    }

    const signature = `${shortCwd}|${statusLabel}|${config.provider}:${config.model}|${authInfo}`;

    if (!config.force && ChatBoxUI.lastStatusSignature === signature) {
      return;
    }

    ChatBoxUI.lastStatusSignature = signature;

    console.log(chalk.gray("─".repeat(cols)));
    console.log(
      chalk.white(shortCwd) +
        chalk.gray(" | ") +
        chalk.green(statusLabel) +
        chalk.gray(" | ") +
        chalk.white(`${config.provider}:${config.model}`) +
        authInfo
    );
  }

  /**
   * Display the initial input prompt
   */
  static displayInitialPrompt(): void {
    // Nothing to do - handleInput will show the prompt
  }


  /**
   * Display session statistics in a formatted way
   */
  static displayStats(stats: SessionStats): void {
    const wallTime = SessionTracker.formatDuration(
      stats.endTime
        ? stats.endTime - stats.startTime
        : Date.now() - stats.startTime
    );
    const agentTime = SessionTracker.formatDuration(
      stats.apiTime + stats.toolTime
    );
    const successRate = SessionTracker.formatPercentage(
      stats.toolCalls.total > 0
        ? (stats.toolCalls.successful / stats.toolCalls.total) * 100
        : 0
    );
    const apiTimeFormatted = SessionTracker.formatDuration(stats.apiTime);
    const toolTimeFormatted = SessionTracker.formatDuration(stats.toolTime);
    const apiPercentage =
      stats.apiTime + stats.toolTime > 0
        ? SessionTracker.formatPercentage(
            (stats.apiTime / (stats.apiTime + stats.toolTime)) * 100
          )
        : "0.0%";
    const toolPercentage =
      stats.apiTime + stats.toolTime > 0
        ? SessionTracker.formatPercentage(
            (stats.toolTime / (stats.apiTime + stats.toolTime)) * 100
          )
        : "0.0%";

    console.log(chalk.bold.blue("\n📊 Session Statistics\n"));

    // Session Info
    console.log(chalk.bold.white("Session Info"));
    console.log(
      chalk.gray("Session ID:") + " ".repeat(20) + chalk.white(stats.sessionId)
    );
    console.log(
      chalk.gray("Provider:") + " ".repeat(22) + chalk.yellow(stats.provider)
    );
    console.log(
      chalk.gray("Model:") + " ".repeat(25) + chalk.green(stats.model)
    );
    console.log(
      chalk.gray("Messages:") +
        " ".repeat(20) +
        chalk.cyan(stats.messagesCount.toString())
    );
    console.log("");

    // Tool Calls
    console.log(chalk.bold.white("Tool Calls"));
    console.log(
      chalk.gray("Total:") +
        " ".repeat(25) +
        chalk.white(stats.toolCalls.total.toString()) +
        ` ( ${chalk.green("✓")} ${stats.toolCalls.successful} ${chalk.red(
          "✗"
        )} ${stats.toolCalls.failed} )`
    );
    console.log(
      chalk.gray("Success Rate:") +
        " ".repeat(16) +
        (stats.toolCalls.total > 0 &&
        stats.toolCalls.successful / stats.toolCalls.total >= 0.8
          ? chalk.green(successRate)
          : stats.toolCalls.total > 0
          ? chalk.yellow(successRate)
          : chalk.gray(successRate))
    );
    console.log("");

    // Performance
    console.log(chalk.bold.white("Performance"));
    console.log(
      chalk.gray("Wall Time:") + " ".repeat(19) + chalk.blue(wallTime)
    );
    console.log(
      chalk.gray("Agent Active:") + " ".repeat(16) + chalk.blue(agentTime)
    );
    console.log(
      chalk.gray("  » API Time:") +
        " ".repeat(16) +
        chalk.blue(apiTimeFormatted) +
        chalk.gray(` (${apiPercentage})`)
    );
    console.log(
      chalk.gray("  » Tool Time:") +
        " ".repeat(15) +
        chalk.blue(toolTimeFormatted) +
        chalk.gray(` (${toolPercentage})`)
    );

    console.log("");
    console.log(chalk.bold.white("Tokens"));
    console.log(
      chalk.gray("Prompt:") +
        " ".repeat(23) +
        chalk.white(stats.promptTokens.toLocaleString())
    );
    console.log(
      chalk.gray("Completion:") +
        " ".repeat(18) +
        chalk.white(stats.completionTokens.toLocaleString())
    );
    console.log(
      chalk.gray("Total:") +
        " ".repeat(24) +
        chalk.white(
          (stats.promptTokens + stats.completionTokens).toLocaleString()
        )
    );
    if (typeof stats.contextLimit === "number") {
      const currentPercent = (
        (stats.currentPromptTokens / stats.contextLimit) * 100
      ).toFixed(1);
      const maxPercent = (
        (stats.maxPromptTokens / stats.contextLimit) * 100
      ).toFixed(1);
      console.log(
        chalk.gray("Context (current):") +
          " ".repeat(6) +
          chalk.white(
            `${stats.currentPromptTokens.toLocaleString()} / ${stats.contextLimit.toLocaleString()} (${currentPercent}%)`
          )
      );
      console.log(
        chalk.gray("Context (max):") +
          " ".repeat(10) +
          chalk.white(
            `${stats.maxPromptTokens.toLocaleString()} / ${stats.contextLimit.toLocaleString()} (${maxPercent}%)`
          )
      );
    }

    // Costs section
    if (stats.totalCost > 0) {
      console.log("");
      console.log(chalk.bold.white("Costs"));
      console.log(
        chalk.gray("Input:") +
          " ".repeat(24) +
          chalk.white(formatCost(stats.inputCost))
      );
      console.log(
        chalk.gray("Output:") +
          " ".repeat(23) +
          chalk.white(formatCost(stats.outputCost))
      );
      console.log(
        chalk.gray("Total:") +
          " ".repeat(24) +
          chalk.green(formatCost(stats.totalCost))
      );
    }

    // Tool breakdown if there are tools used
    if (Object.keys(stats.toolCalls.byType).length > 0) {
      console.log("");
      console.log(chalk.bold.white("Tool Breakdown"));
      Object.entries(stats.toolCalls.byType)
        .sort((a, b) => b[1].count - a[1].count)
        .forEach(([tool, data]) => {
          const rate =
            data.count > 0
              ? SessionTracker.formatPercentage(
                  (data.success / data.count) * 100
                )
              : "0.0%";
          console.log(
            chalk.gray(`  ${tool}:`) +
              " ".repeat(Math.max(2, 20 - tool.length)) +
              chalk.white(data.count.toString()) +
              ` (${chalk.green(data.success.toString())}/${chalk.red(
                data.fail.toString()
              )}) ` +
              (data.success / data.count >= 0.8
                ? chalk.green(rate)
                : chalk.yellow(rate))
          );
        });
    }
  }

  /**
   * Display goodbye message with session summary
   */
  static displayGoodbye(stats: SessionStats): void {
    const wallTime = SessionTracker.formatDuration(
      stats.endTime
        ? stats.endTime - stats.startTime
        : Date.now() - stats.startTime
    );
    const successRate = SessionTracker.formatPercentage(
      stats.toolCalls.total > 0
        ? (stats.toolCalls.successful / stats.toolCalls.total) * 100
        : 0
    );

    console.log("");
    displayWave();
    console.log(
      chalk.cyan("  Agent powering down. ") + chalk.blue("Thanks for diving in!")
    );
    console.log("");

    // Summary box (responsive to terminal width)
    const terminalWidth = process.stdout.columns || 80;
    const width = Math.min(terminalWidth - 4, 100); // Max 100 chars, leave 4 chars margin
    const topBorder = "┌" + "─".repeat(width - 2) + "┐";
    const bottomBorder = "└" + "─".repeat(width - 2) + "┘";

    console.log(chalk.gray(topBorder));
    console.log(
      chalk.gray("│") +
        chalk.bold.white(" Interaction Summary".padEnd(width - 2)) +
        chalk.gray("│")
    );
    console.log(
      chalk.gray("│") +
        chalk.blue("Session ID:").padEnd(30) +
        chalk
          .white(stats.sessionId.substring(0, width - 32))
          .padEnd(width - 31) +
        chalk.gray("│")
    );
    console.log(
      chalk.gray("│") +
        chalk.blue("Tool Calls:").padEnd(30) +
        chalk
          .white(
            `${stats.toolCalls.total} ( ${chalk.green("✓")} ${
              stats.toolCalls.successful
            } ${chalk.red("✗")} ${stats.toolCalls.failed} )`
          )
          .padEnd(width - 31) +
        chalk.gray("│")
    );
    console.log(
      chalk.gray("│") +
        chalk.blue("Success Rate:").padEnd(30) +
        (stats.toolCalls.total > 0 &&
        stats.toolCalls.successful / stats.toolCalls.total >= 0.8
          ? chalk.green(successRate)
          : stats.toolCalls.total > 0
          ? chalk.yellow(successRate)
          : chalk.gray(successRate)
        ).padEnd(width - 31) +
        chalk.gray("│")
    );
    console.log(chalk.gray("│".padEnd(width - 1)) + chalk.gray("│"));
    console.log(
      chalk.gray("│") +
        chalk.bold.white(" Performance".padEnd(width - 2)) +
        chalk.gray("│")
    );
    console.log(
      chalk.gray("│") +
        chalk.blue("Wall Time:").padEnd(30) +
        chalk.blue(wallTime).padEnd(width - 31) +
        chalk.gray("│")
    );
    console.log(
      chalk.gray("│") +
        chalk.blue("Agent Active:").padEnd(30) +
        chalk
          .blue(SessionTracker.formatDuration(stats.apiTime + stats.toolTime))
          .padEnd(width - 31) +
        chalk.gray("│")
    );
    console.log(
      chalk.gray("│") +
        chalk.blue("  » API Time:").padEnd(30) +
        chalk
          .blue(SessionTracker.formatDuration(stats.apiTime))
          .padEnd(width - 31) +
        chalk.gray("│")
    );
    console.log(
      chalk.gray("│") +
        chalk.blue("  » Tool Time:").padEnd(30) +
        chalk
          .blue(SessionTracker.formatDuration(stats.toolTime))
          .padEnd(width - 31) +
        chalk.gray("│")
    );
    console.log(
      chalk.gray("│") +
        chalk.blue("Prompt Tokens:").padEnd(30) +
        chalk.white(stats.promptTokens.toLocaleString()).padEnd(width - 31) +
        chalk.gray("│")
    );
    console.log(
      chalk.gray("│") +
        chalk.blue("Completion Tokens:").padEnd(30) +
        chalk.white(stats.completionTokens.toLocaleString()).padEnd(width - 31) +
        chalk.gray("│")
    );
    if (stats.totalCost > 0) {
      console.log(
        chalk.gray("│") +
          chalk.blue("Total Cost:").padEnd(30) +
          chalk.green(formatCost(stats.totalCost)).padEnd(width - 31) +
          chalk.gray("│")
      );
    }
    if (typeof stats.contextLimit === "number") {
      const currentPercent = (
        (stats.currentPromptTokens / stats.contextLimit) * 100
      ).toFixed(1);
      const maxPercent = (
        (stats.maxPromptTokens / stats.contextLimit) * 100
      ).toFixed(1);
      console.log(
        chalk.gray("│") +
          chalk.blue("Context (current):").padEnd(30) +
          chalk
            .white(
              `${stats.currentPromptTokens.toLocaleString()} / ${stats.contextLimit.toLocaleString()} (${currentPercent}%)`
            )
            .padEnd(width - 31) +
          chalk.gray("│")
      );
      console.log(
        chalk.gray("│") +
          chalk.blue("Context (max):").padEnd(30) +
          chalk
            .white(
              `${stats.maxPromptTokens.toLocaleString()} / ${stats.contextLimit.toLocaleString()} (${maxPercent}%)`
            )
            .padEnd(width - 31) +
          chalk.gray("│")
      );
    }
    console.log(chalk.gray(bottomBorder));
    console.log("");
  }
}
