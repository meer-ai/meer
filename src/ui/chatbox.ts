import chalk from "chalk";
import inquirer from "inquirer";
import { createInterface } from "readline";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { showSlashHelp } from "./slashHelp.js";
import { slashCommands } from "./slashCommands.js";
import { SessionStats, SessionTracker } from "../session/tracker.js";

export class ChatBoxUI {
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

      let slashHelpShown = false;
      let menuActive = false;
      let inlineListenerAttached = false;
      const bufferedLines: string[] = [];
      let finalizeTimer: NodeJS.Timeout | null = null;

      const promptUser = (preserve: boolean = false) => rl.prompt(preserve);

      const handleInlineSlash = (chunk: Buffer | string) => {
        if (menuActive) {
          return;
        }

        const inputChunk =
          typeof chunk === "string" ? chunk : chunk.toString("utf8");

        const lineTrimmed = rl.line.trim();
        if (slashHelpShown && lineTrimmed !== "/") {
          slashHelpShown = false;
          return;
        }

        const isPrintable = /[\w\s/]/.test(inputChunk) || inputChunk === "/";
        if (!slashHelpShown && isPrintable && lineTrimmed === "/") {
          slashHelpShown = true;
          console.log("");
          showSlashHelp();
          promptUser(true);
        }
      };

      const inputStream = (rl as unknown as {
        input?: NodeJS.ReadableStream;
      }).input;

      if (inputStream) {
        inputStream.on("data", handleInlineSlash);
        inlineListenerAttached = true;
      }

      const finalizeInput = () => {
        if (finalizeTimer) {
          clearTimeout(finalizeTimer);
          finalizeTimer = null;
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
          if (inlineListenerAttached) {
            inputStream?.removeListener("data", handleInlineSlash);
            inlineListenerAttached = false;
          }

          menuActive = true;

          void ChatBoxUI.pickSlashCommand()
            .then((selection) => {
              menuActive = false;

              if (!selection) {
                if (inputStream && !inlineListenerAttached) {
                  inputStream.on("data", handleInlineSlash);
                  inlineListenerAttached = true;
                }
                promptUser();
                return;
              }

              rl.close();
              resolve(selection);
            })
            .catch(() => {
              menuActive = false;
              if (inputStream && !inlineListenerAttached) {
                inputStream.on("data", handleInlineSlash);
                inlineListenerAttached = true;
              }
              promptUser();
            });
          return;
        }

        ChatBoxUI.appendHistory(historyPath, trimmed);
        rl.close();
        resolve(trimmed);
      };

      const scheduleFinalize = () => {
        if (finalizeTimer) {
          clearTimeout(finalizeTimer);
        }
        finalizeTimer = setTimeout(finalizeInput, 15);
      };

      rl.on("line", (input) => {
        bufferedLines.push(input);
        scheduleFinalize();
      });

      rl.on("SIGINT", () => {
        rl.close();
        process.exit(0);
      });

      rl.on("close", () => {
        if (inlineListenerAttached) {
          inputStream?.removeListener("data", handleInlineSlash);
          inlineListenerAttached = false;
        }
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

    const choices: Array<{ name: string; value: string | null }> =
      slashCommands.map((item) => ({
        name: `${chalk.cyan(item.command)} ${chalk.gray(`- ${item.description}`)}`,
        value: item.command,
      }));

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

    console.log(
      "\n" + chalk.blue("Agent powering down. ") + chalk.magenta("Goodbye!")
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
