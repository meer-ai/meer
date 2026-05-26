import chalk from "chalk";
import inquirer from "inquirer";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { ProjectContextManager } from "../context/manager.js";
import { AuthStorage } from "../auth/storage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const VERSION = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8")
).version;

const PROVIDER_LABELS: Record<string, string> = {
  ollama: "🦙 Ollama",
  openai: "🤖 OpenAI",
  gemini: "✨ Gemini",
  anthropic: "🧠 Anthropic",
  openrouter: "🌐 OpenRouter",
  meer: "🌊 Meer Managed",
  zaiCodingPlan: "⚡ Z.ai Coding Plan",
  zaiCredit: "⚡ Z.ai Credit",
  zai: "⚡ Z.ai",
};

export async function showWelcomeScreen(): Promise<void> {
  console.clear();

  console.log(
    chalk.hex("#06b6d4")("    ███╗   ███╗███████╗███████╗██████╗     ") +
      chalk.hex("#0ea5e9")("   ~≈~≈~≈")
  );
  console.log(
    chalk.hex("#0ea5e9")("    ████╗ ████║██╔════╝██╔════╝██╔══██╗    ") +
      chalk.hex("#06b6d4")("  ~≈~≈~≈~")
  );
  console.log(
    chalk.hex("#0284c7")("    ██╔████╔██║█████╗  █████╗  ██████╔╝    ") +
      chalk.hex("#0ea5e9")(" ~≈~≈~≈~≈")
  );
  console.log(
    chalk.hex("#0ea5e9")("    ██║╚██╔╝██║██╔══╝  ██╔══╝  ██╔══██╗    ") +
      chalk.hex("#06b6d4")("~≈~≈~≈~≈~")
  );
  console.log(
    chalk.hex("#06b6d4")("    ██║ ╚═╝ ██║███████╗███████╗██║  ██║    ") +
      chalk.hex("#0ea5e9")("~≈~≈~≈~≈")
  );
  console.log(
    chalk.hex("#0369a1")("    ╚═╝     ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝    ") +
      chalk.hex("#06b6d4")(" ~≈~≈~≈~")
  );
  console.log("");
  console.log(
    chalk.bold.cyan("            🌊 Dive deep into your code like the vast ocean")
  );
  console.log(
    chalk.gray(
      "          Model-agnostic CLI • Ollama • OpenAI • Anthropic • Gemini • OpenRouter"
    )
  );
  console.log("");
  console.log(chalk.hex("#0ea5e9")("═".repeat(85)));
  console.log("");

  const { configExists } = await import("../config.js");
  if (!configExists()) {
    console.log(
      chalk.yellow(
        "👋 Welcome! It looks like this is your first time using Meer.\n"
      )
    );

    const { runSetup } = await inquirer.prompt([
      {
        type: "confirm",
        name: "runSetup",
        message: "Would you like to run the setup wizard?",
        default: true,
      },
    ]);

    if (runSetup) {
      const { runSetupWizard } = await import("../commands/setup.js");
      await runSetupWizard();
      console.log("");
    } else {
      console.log(
        chalk.gray("\nSkipping setup. A default configuration will be created.")
      );
      console.log(
        chalk.yellow("💡 Tip: Run ") +
          chalk.cyan("meer setup") +
          chalk.yellow(" anytime to configure Meer.\n")
      );
    }
  }

  try {
    const { loadConfig } = await import("../config.js");
    const config = loadConfig();

    ProjectContextManager.getInstance().configureEmbeddings({
      enabled: config.contextEmbedding?.enabled ?? false,
      dimensions: config.contextEmbedding?.dimensions,
      maxFileSize: config.contextEmbedding?.maxFileSize,
    });

    const providerLabel =
      PROVIDER_LABELS[config.providerType ?? ""] ?? config.providerType;

    console.log(chalk.bold.blue("📋 Configuration:"));
    console.log(
      chalk.white("  Provider:") + " " + chalk.yellow(providerLabel)
    );
    console.log(chalk.white("  Model:") + " " + chalk.green(config.model));
    console.log(chalk.white("  Version:") + " " + chalk.gray(VERSION));

    const authStorage = new AuthStorage();
    if (authStorage.isAuthenticated()) {
      const user = authStorage.getUser();
      console.log(
        chalk.white("  Account:") +
          " " +
          chalk.cyan(user?.name || "Unknown") +
          " " +
          chalk.gray(`(${user?.subscription_tier || "free"})`)
      );
    } else {
      console.log(
        chalk.white("  Account:") +
          " " +
          chalk.gray("Not logged in") +
          " " +
          chalk.dim("(run 'meer login')")
      );
    }
    console.log("");
  } catch {
    console.log(chalk.yellow("⚠️  Configuration not loaded"));
    console.log("");
  }

  console.log(chalk.bold.yellow("🚀 Quick Commands:"));
  console.log(
    chalk.white("• Setup wizard:") + " " + chalk.cyan("meer setup")
  );
  console.log(
    chalk.white("• Login/logout:") +
      " " +
      chalk.cyan("meer login") +
      " " +
      chalk.gray("| meer logout")
  );
  console.log(
    chalk.white("• Ask questions:") +
      " " +
      chalk.cyan('meer ask "What does this code do?"')
  );
  console.log(
    chalk.white("• Interactive chat:") + " " + chalk.cyan("meer")
  );
  console.log(
    chalk.white("• Generate commits:") + " " + chalk.cyan("meer commit-msg")
  );
  console.log(
    chalk.white("• Code review:") + " " + chalk.cyan("meer review")
  );
  console.log("");
  console.log(
    chalk.gray('Type "/help" for slash commands  •  Ctrl+C to exit')
  );
  console.log("");
}
