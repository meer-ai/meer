import chalk from "chalk";
import {
  getAllCommands,
  getSlashCommandSources,
  getSlashCommandErrors,
  type SlashCommandListEntry,
} from "../slash/registry.js";
import { getSlashCommandBadges } from "../slash/utils.js";

function formatBadge(badge: string): string {
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
      return chalk.gray(badge);
  }
}

function formatEntry(entry: SlashCommandListEntry, width: number): string {
  const command = entry.command.padEnd(width + 2, " ");
  const description = chalk.white(entry.description);
  const badges = getSlashCommandBadges(entry);

  if (badges.length === 0) {
    return chalk.cyan(command) + description;
  }

  const badgeText = badges
    .map((badge) => formatBadge(badge))
    .join(chalk.gray(", "));

  return (
    chalk.cyan(command) +
    description +
    ` ${chalk.gray("[")}${badgeText}${chalk.gray("]")}`
  );
}

export function showSlashHelp(): void {
  console.log(chalk.bold.blue("\n?? Slash Command Palette\n"));

  const commands = getAllCommands();
  const maxCommandLength =
    commands.length > 0
      ? Math.max(...commands.map((cmd) => cmd.command.length))
      : 7;

  const headerCommand = "Command".padEnd(maxCommandLength + 2, " ");
  console.log(chalk.gray(`${headerCommand}Description`));
  console.log(chalk.gray("-".repeat(headerCommand.length + 38)));

  commands.forEach((entry) => {
    console.log(formatEntry(entry, maxCommandLength));
  });

  const sources = getSlashCommandSources();
  if (sources.length > 0) {
    console.log("");
    console.log(chalk.gray("?? Loaded custom commands from:"));
    sources.forEach((source) => {
      console.log(`    ${chalk.white(source)}`);
    });
  }

  const errors = getSlashCommandErrors();
  if (errors.length > 0) {
    console.log("");
    console.log(chalk.red("? Some custom commands failed to load:"));
    errors.forEach((error) => {
      console.log(chalk.gray(`  - ${error.file}: ${error.message}`));
    });
  }

  console.log("");
  console.log(
    chalk.gray(
      "?? Type '/', press Enter, then use arrow keys—or enter a full command like /stats.",
    ),
  );
}
