import chalk from "chalk";
import { createInterface } from "readline";
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
      // Create readline interface
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: chalk.cyan("> ")
      });

      rl.prompt();

      rl.on('line', (input) => {
        rl.close();
        
        // Display status bar after input
        const cols = process.stdout.columns || 80;
        const cwd = config.cwd || process.cwd();
        const shortCwd = cwd.length > 30 ? `...${cwd.slice(-27)}` : cwd;
        
        console.log(chalk.gray("─".repeat(cols)));
        console.log(
          chalk.white(shortCwd) + 
          chalk.gray(" | ready | ") + 
          chalk.white(`${config.provider}:${config.model}`)
        );
        
        resolve(input.trim());
      });

      rl.on('SIGINT', () => {
        rl.close();
        process.exit(0);
      });
    });
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
    console.log(chalk.gray(bottomBorder));
    console.log("");
  }
}
