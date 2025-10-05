import { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { SessionTracker } from "../session/tracker.js";
import { ChatBoxUI } from "../ui/chatbox.js";
import type { ChatMessage } from "../providers/base.js";

export function createChatCommand(): Command {
  const command = new Command("chat");

  command.description("Start an interactive chat session").action(async () => {
    try {
      const config = loadConfig();
      const sessionTracker = new SessionTracker(
        config.providerType,
        config.model
      );

      console.log(
        chalk.blue(`\n🤖 MeerAI Chat (${config.providerType}: ${config.model})`)
      );
      console.log(
        chalk.gray(
          "Type your messages below. Use slash commands for special actions.\n"
        )
      );

      // Show available slash commands
      // console.log(chalk.bold.yellow('📋 Available Slash Commands:'));
      // console.log(chalk.gray('• /stats - Show current session statistics'));
      // console.log(chalk.gray('• /exit, /quit - End the chat session'));
      // console.log(chalk.gray('• /help - Show this help message'));
      // console.log('');

      const messages: ChatMessage[] = [];

      // No need for initial prompt - handleInput will render the footer

      // Add a small delay to ensure everything is displayed before starting the loop
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Setup graceful exit handlers
      const handleExit = () => {
        const finalStats = sessionTracker.endSession();
        console.log("\n");
        ChatBoxUI.displayGoodbye(finalStats);
        process.exit(0);
      };

      process.on("SIGINT", handleExit);
      process.on("SIGTERM", handleExit);

      // Remove problematic resize handling - let the terminal handle it naturally

      const askQuestion = (): Promise<string> => {
        return ChatBoxUI.handleInput({
          provider: config.providerType,
          model: config.model,
          cwd: process.cwd(),
        });
      };

      while (true) {
        const userInput = await askQuestion();

        // Handle slash commands
        if (userInput.startsWith("/")) {
          const command = userInput.toLowerCase();

          if (command === "/exit" || command === "/quit") {
            break;
          } else if (command === "/stats") {
            ChatBoxUI.displayStats(sessionTracker.getCurrentStats());
            console.log("");
            continue;
          } else if (command === "/help") {
            console.log(chalk.bold.yellow("\n📋 Available Slash Commands:"));
            console.log(
              chalk.gray("• /stats - Show current session statistics")
            );
            console.log(chalk.gray("• /exit, /quit - End the chat session"));
            console.log(chalk.gray("• /help - Show this help message"));
            console.log("");
            continue;
          } else {
            console.log(chalk.red(`Unknown command: ${userInput}`));
            console.log(chalk.gray("Type /help to see available commands.\n"));
            continue;
          }
        }

        // Handle regular exit commands
        if (
          userInput.toLowerCase() === "exit" ||
          userInput.toLowerCase() === "quit"
        ) {
          break;
        }

        if (!userInput) {
          continue;
        }

        // Track the message
        sessionTracker.trackMessage();

        // Add user message to history
        messages.push({ role: "user", content: userInput });

        // Stream the response
        console.log(chalk.green("\n🤖 MeerAI:\n"));
        let assistantResponse = "";
        const apiStartTime = Date.now();

        try {
          for await (const chunk of config.provider.stream(messages)) {
            process.stdout.write(chunk);
            assistantResponse += chunk;
          }

          // Track API time
          sessionTracker.trackApiCall(Date.now() - apiStartTime);

          // Add assistant response to history
          messages.push({ role: "assistant", content: assistantResponse });
          console.log("\n");
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : String(error);
          console.log(chalk.red(`\nError: ${errorMsg}\n`));

          // Track failed API call
          sessionTracker.trackApiCall(Date.now() - apiStartTime);
        }
      }

      // End session and show goodbye
      const finalStats = sessionTracker.endSession();
      ChatBoxUI.displayGoodbye(finalStats);
    } catch (error) {
      console.error(
        chalk.red("Error:"),
        error instanceof Error ? error.message : String(error)
      );
      process.exit(1);
    }
  });

  return command;
}
