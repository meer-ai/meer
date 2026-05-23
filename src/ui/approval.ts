/**
 * Terminal approval flow for file edits and shell commands.
 * Renders colored diffs and prompts the user via readline.
 * Used in non-TUI mode and as a fallback.
 */

import chalk from "chalk";
import { createInterface } from "readline";

export type ApprovalDecision = "apply" | "skip" | "apply-all" | "skip-all";

export function renderDiff(diffLines: string[]): void {
  const lines = diffLines.slice(0, 50);
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      process.stdout.write(chalk.green(line) + "\n");
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      process.stdout.write(chalk.red(line) + "\n");
    } else if (line.startsWith("@@")) {
      process.stdout.write(chalk.cyan(line) + "\n");
    } else {
      process.stdout.write(chalk.gray(line) + "\n");
    }
  }
  if (diffLines.length > 50) {
    console.log(chalk.dim(`  … ${diffLines.length - 50} more lines`));
  }
}

/**
 * Show a diff and ask the user whether to apply it.
 * Supports: y(es) / n(o) / a(ll) / s(kip-all)
 */
export async function promptEditApproval(
  path: string,
  diffLines: string[],
  description?: string
): Promise<ApprovalDecision> {
  console.log("\n" + chalk.bold.blue("─".repeat(60)));
  console.log(
    chalk.bold.white("  Proposed edit: ") + chalk.cyan(path)
  );
  if (description) {
    console.log(chalk.gray("  " + description));
  }
  console.log(chalk.bold.blue("─".repeat(60)));
  renderDiff(diffLines);
  console.log(chalk.bold.blue("─".repeat(60)));

  const hint =
    chalk.green("y") +
    chalk.gray("/") +
    chalk.red("n") +
    chalk.gray("/") +
    chalk.yellow("a") +
    chalk.gray("ll/") +
    chalk.yellow("s") +
    chalk.gray("kip-all");

  return askDecision(
    `Apply? [${hint}] ` + chalk.dim("(y)") + ": ",
    "apply"
  );
}

/**
 * Show a command and ask whether to run it.
 * Supports: y(es) / n(o) — no "apply-all" for commands (safer).
 */
export async function promptCommandApproval(
  command: string
): Promise<ApprovalDecision> {
  console.log("\n" + chalk.bold.yellow("─".repeat(60)));
  console.log(chalk.bold.white("  Shell command: ") + chalk.yellow(command));
  console.log(chalk.bold.yellow("─".repeat(60)));

  const hint = chalk.green("y") + chalk.gray("/") + chalk.red("n");
  return askDecision(
    `Run? [${hint}] ` + chalk.dim("(n)") + ": ",
    "skip"
  );
}

async function askDecision(
  prompt: string,
  defaultDecision: ApprovalDecision
): Promise<ApprovalDecision> {
  if (!process.stdin.isTTY) {
    process.stdout.write(prompt + "(auto-" + defaultDecision + ")\n");
    return defaultDecision;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      const input = answer.trim().toLowerCase();
      if (input === "a" || input === "all" || input === "apply-all") {
        resolve("apply-all");
      } else if (input === "s" || input === "skip-all") {
        resolve("skip-all");
      } else if (
        input === "n" ||
        input === "no" ||
        input === "skip" ||
        (defaultDecision === "skip" && input === "")
      ) {
        resolve("skip");
      } else {
        resolve("apply");
      }
    });
  });
}
