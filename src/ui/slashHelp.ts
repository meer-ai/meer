import chalk from "chalk";
import { slashCommands } from "./slashCommands.js";

export function showSlashHelp(): void {
  console.log(chalk.bold.blue("\n📚 Slash Command Palette\n"));

  const maxCommandLength = Math.max(
    ...slashCommands.map((cmd) => cmd.command.length)
  );

  const headerCommand = "Command".padEnd(maxCommandLength + 2, " ");
  console.log(chalk.gray(`${headerCommand}Description`));
  console.log(chalk.gray("-".repeat(headerCommand.length + 32)));

  slashCommands.forEach(({ command, description }) => {
    const padded = command.padEnd(maxCommandLength + 2, " ");
    console.log(chalk.cyan(padded) + chalk.white(description));
  });

  console.log("");
  console.log(
    chalk.gray(
      "💡 Type '/', press Enter, then use arrow keys—or enter a full command like /stats."
    )
  );
}
