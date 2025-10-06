import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createAskCommand } from "./commands/ask.js";
import { createCommitMsgCommand } from "./commands/commitMsg.js";
import { createReviewCommand } from "./commands/review.js";
import { createMemoryCommand } from "./commands/memory.js";
import { createSetupCommand } from "./commands/setup.js";
import { SessionTracker } from "./session/tracker.js";
import { ChatBoxUI } from "./ui/chatbox.js";
import { logVerbose, setVerboseLogging } from "./logger.js";
import { showSlashHelp } from "./ui/slashHelp.js";
import { ProjectContextManager } from "./context/manager.js";

// Get package.json path and read version
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = join(__dirname, "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
const VERSION = packageJson.version;

async function showWelcomeScreen() {
  console.clear();

  // Large MeerAI ASCII art logo with wave emoji-style pattern
  console.log(
    chalk.hex("#0077B6")("    ███╗   ███╗███████╗███████╗██████╗     ") +
      chalk.hex("#48CAE4")("   ∿∿∿∿∿∿")
  );
  console.log(
    chalk.hex("#0096C7")("    ████╗ ████║██╔════╝██╔════╝██╔══██╗    ") +
      chalk.hex("#0077B6")("  ∿∿∿∿∿∿∿")
  );
  console.log(
    chalk.hex("#00B4D8")("    ██╔████╔██║█████╗  █████╗  ██████╔╝    ") +
      chalk.hex("#48CAE4")(" ∿∿∿∿∿∿∿∿")
  );
  console.log(
    chalk.hex("#0096C7")("    ██║╚██╔╝██║██╔══╝  ██╔══╝  ██╔══██╗    ") +
      chalk.hex("#0077B6")("∿∿∿∿∿∿∿∿∿")
  );
  console.log(
    chalk.hex("#0077B6")("    ██║ ╚═╝ ██║███████╗███████╗██║  ██║    ") +
      chalk.hex("#48CAE4")("∿∿∿∿∿∿∿∿")
  );
  console.log(
    chalk.hex("#023E8A")("    ╚═╝     ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝    ") +
      chalk.hex("#0077B6")(" ∿∿∿∿∿∿∿")
  );
  console.log("");
  console.log(
    chalk.bold.cyan(
      "                  🌊 Your AI companion that flows like the sea"
    )
  );
  console.log(
    chalk.gray(
      "                Model-agnostic CLI supporting Ollama, OpenAI, Anthropic, Gemini, and OpenRouter"
    )
  );
  console.log("");
  console.log(chalk.hex("#48CAE4")("═".repeat(85)));
  console.log("");

  // Check if this is first-time setup
  const { configExists } = await import("./config.js");
  if (!configExists()) {
    console.log(
      chalk.yellow(
        "👋 Welcome! It looks like this is your first time using MeerAI.\n"
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
      const { createSetupCommand } = await import("./commands/setup.js");
      const setupCmd = createSetupCommand();
      await setupCmd.parseAsync(["setup"], { from: "user" });
      console.log("");
    } else {
      console.log(
        chalk.gray("\nSkipping setup. A default configuration will be created.")
      );
      console.log(
        chalk.yellow("💡 Tip: Run ") +
          chalk.cyan("meer setup") +
          chalk.yellow(" anytime to configure MeerAI.\n")
      );
    }
  }

  // Load and display config details
  try {
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();

    ProjectContextManager.getInstance().configureEmbeddings({
      enabled: config.contextEmbedding?.enabled ?? false,
      dimensions: config.contextEmbedding?.dimensions,
      maxFileSize: config.contextEmbedding?.maxFileSize,
    });

    const providerLabel =
      config.providerType === "ollama"
        ? "🦙 Ollama"
        : config.providerType === "openai"
        ? "🤖 OpenAI"
        : config.providerType === "gemini"
        ? "✨ Gemini"
        : config.providerType;

    console.log(chalk.bold.blue("📋 Configuration:"));
    console.log(chalk.white("  Provider:") + " " + chalk.yellow(providerLabel));
    console.log(chalk.white("  Model:") + " " + chalk.green(config.model));
    console.log(chalk.white("  Version:") + " " + chalk.gray(VERSION));
    console.log("");
  } catch (error) {
    console.log(chalk.yellow("⚠️  Configuration not loaded"));
    console.log("");
  }

  console.log(chalk.bold.yellow("🚀 Quick Commands:"));
  console.log(chalk.white("• Setup wizard:") + " " + chalk.cyan("meer setup"));
  console.log(
    chalk.white("• Ask questions:") +
      " " +
      chalk.cyan('meer ask "What does this code do?"')
  );
  console.log(chalk.white("• Interactive chat:") + " " + chalk.cyan("meer"));
  console.log(
    chalk.white("• Generate commits:") + " " + chalk.cyan("meer commit-msg")
  );
  console.log(chalk.white("• Code review:") + " " + chalk.cyan("meer review"));
  console.log(chalk.white("• View memory:") + " " + chalk.cyan("meer memory"));
  console.log("");

  // console.log(chalk.bold.magenta("⚡ Slash Commands:"));
  // console.log(
  //   chalk.white("• /init") +
  //     " " +
  //     chalk.gray("- Create AGENTS.md for project tracking")
  // );
  // console.log(
  //   chalk.white("• /setup") +
  //     " " +
  //     chalk.gray("- Run setup wizard to reconfigure providers")
  // );
  // console.log(
  //   chalk.white("• /provider") + " " + chalk.gray("- Switch AI provider")
  // );
  // console.log(chalk.white("• /model") + " " + chalk.gray("- Switch AI model"));
  // console.log(
  //   chalk.white("• /help") + " " + chalk.gray("- Show detailed help")
  // );
  // console.log(chalk.white("• /exit") + " " + chalk.gray("- Exit chat session"));
  // console.log("");
  // console.log(chalk.hex("#48CAE4")("═".repeat(85)));
  // console.log("");
  // console.log(chalk.bold.green("🚀 Starting interactive chat..."));
  // console.log(
  //   chalk.gray(
  //     'Type your messages below. Type "exit" or "quit" to end the session.'
  //   )
  // );
  console.log(chalk.gray('Type "/" to see available slash commands.'));
  console.log("");
}

/**
 * Check if the user input is requesting to read an image file
 */
async function isImageFileRequest(userInput: string): Promise<boolean> {
  // Check for common image file patterns
  const imageExtensions = [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".bmp",
    ".webp",
    ".svg",
  ];
  const imageKeywords = [
    "read this image",
    "analyze this image",
    "what does this image",
    "tell me what this image",
    "check this image",
    "examine this image",
    "describe this image",
    "what is in this image",
  ];

  // Check if input contains a file path with image extension
  const hasImagePath = imageExtensions.some((ext) =>
    userInput.toLowerCase().includes(ext.toLowerCase())
  );

  // Check if input contains image-related keywords
  const hasImageKeywords = imageKeywords.some((keyword) =>
    userInput.toLowerCase().includes(keyword.toLowerCase())
  );

  return hasImagePath || hasImageKeywords;
}

/**
 * Handle image file reading requests
 */
async function handleImageFileRequest(
  userInput: string,
  config: any
): Promise<void> {
  console.log(chalk.cyan("🖼️  Detected image file request"));
  console.log(chalk.gray("  Let me analyze the image for you"));

  try {
    // Extract file path from the input
    const filePath = extractFilePath(userInput);

    // Debug: show what was extracted
    console.log(chalk.gray(`  🔍 Extracted path: "${filePath}"`));

    if (!filePath) {
      console.log(chalk.red("❌ Could not determine the image file path"));
      console.log(
        chalk.gray("  Please provide the full path to the image file")
      );
      return;
    }

    // Check if file exists
    const { existsSync } = await import("fs");
    if (!existsSync(filePath)) {
      console.log(chalk.red(`❌ File not found: ${filePath}`));
      console.log(chalk.gray("  Please check the file path and try again"));
      return;
    }

    // Check if it's actually an image file
    const imageExtensions = [
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".bmp",
      ".webp",
      ".svg",
    ];
    const isImageFile = imageExtensions.some((ext) =>
      filePath.toLowerCase().endsWith(ext.toLowerCase())
    );

    if (!isImageFile) {
      console.log(chalk.yellow("⚠️  This doesn't appear to be an image file"));
      console.log(
        chalk.gray("  Supported formats: PNG, JPG, JPEG, GIF, BMP, WEBP, SVG")
      );
      return;
    }

    console.log(chalk.green(`✅ Found image file: ${filePath}`));
    console.log(chalk.cyan("🔍 Analyzing image content..."));

    // For now, provide basic file information
    // In a real implementation, you would use an image analysis service
    const { statSync } = await import("fs");
    const stats = statSync(filePath);
    const fileSizeKB = Math.round(stats.size / 1024);

    console.log(chalk.blue("📊 Image Information:"));
    console.log(chalk.gray(`  📁 File: ${filePath}`));
    console.log(chalk.gray(`  📏 Size: ${fileSizeKB} KB`));
    console.log(chalk.gray(`  📅 Modified: ${stats.mtime.toLocaleString()}`));

    console.log(chalk.yellow("\n⚠️  Image Analysis Limitation:"));
    console.log(
      chalk.gray("  Currently, I can only provide basic file information")
    );
    console.log(
      chalk.gray("  For actual image content analysis, you would need:")
    );
    console.log(chalk.gray("  • Google Vision API"));
    console.log(chalk.gray("  • OpenAI Vision API"));
    console.log(chalk.gray("  • Azure Computer Vision"));
    console.log(chalk.gray("  • Or other image analysis services"));

    console.log(chalk.blue("\n💡 To enable image analysis:"));
    console.log(chalk.gray("  1. Add an image analysis service to your CLI"));
    console.log(chalk.gray("  2. Configure API keys for the service"));
    console.log(
      chalk.gray("  3. Update the workflow to handle image analysis")
    );
  } catch (error) {
    console.log(chalk.red("❌ Error processing image file:"));
    console.log(
      chalk.gray(
        `  ${error instanceof Error ? error.message : "Unknown error"}`
      )
    );
  }
}

/**
 * Extract file path from user input
 */
function extractFilePath(userInput: string): string | null {
  // Debug: show the raw input
  console.log(chalk.gray(`  🔍 Raw input: "${userInput}"`));

  // Method 1: Manual parsing for paths with escaped spaces
  // Look for the start of a path and manually parse until we hit a non-escaped space
  const pathStart = userInput.indexOf("/");
  if (pathStart !== -1) {
    let path = "";
    let i = pathStart;

    while (i < userInput.length) {
      const char = userInput[i];
      const nextChar = userInput[i + 1];

      if (char === "\\" && nextChar === " ") {
        // This is an escaped space, add a regular space and skip both characters
        path += " ";
        i += 2;
      } else if (char === " " && !path.includes("\\")) {
        // This is a regular space that's not escaped, stop here
        break;
      } else if (char === " ") {
        // This is a space that might be part of the path, continue
        path += char;
        i++;
      } else {
        // Regular character, add it to the path
        path += char;
        i++;
      }
    }

    if (path.length > 1) {
      const cleanedPath = path.trim();
      console.log(
        chalk.gray(`  🔧 Method 1 - Manual parsing: "${cleanedPath}"`)
      );
      return cleanedPath;
    }
  }

  // Method 2: Look for paths that start with / and contain escaped spaces
  // This regex looks for / followed by non-space chars, then escaped spaces followed by more chars
  const pathWithEscapedSpaces = userInput.match(/(\/[^\s]+(?:\\\s[^\s]*)*)/);
  if (pathWithEscapedSpaces) {
    const cleanedPath = pathWithEscapedSpaces[1].replace(/\\\s/g, " ").trim();
    console.log(
      chalk.gray(
        `  🔧 Method 2 - Found path with escaped spaces: "${cleanedPath}"`
      )
    );
    return cleanedPath;
  }

  // Method 3: Look for any string that starts with / and contains backslashes
  const pathWithBackslashes = userInput.match(/(\/[^\s]+(?:\\[^\s]*)*)/);
  if (pathWithBackslashes) {
    const cleanedPath = pathWithBackslashes[1].replace(/\\\s/g, " ").trim();
    console.log(
      chalk.gray(
        `  🔧 Method 3 - Found path with backslashes: "${cleanedPath}"`
      )
    );
    return cleanedPath;
  }

  // Handle drag-and-drop files with escaped spaces
  // Look for patterns like: /Users/path/with\ spaces/file.png
  const escapedPathPattern = /(\/[^\s]+(?:\\\s[^\s]*)+)/;
  const escapedMatch = userInput.match(escapedPathPattern);
  if (escapedMatch) {
    // Clean up the path by removing backslashes before spaces
    const cleanedPath = escapedMatch[1].replace(/\\\s/g, " ").trim();
    console.log(chalk.gray(`  🔧 Cleaned escaped path: "${cleanedPath}"`));
    return cleanedPath;
  }

  // Handle paths that start with /Users (common on macOS)
  const usersPathPattern = /\/Users\/[^\s]+(?:\\\s[^\s]*)*/;
  const usersPathMatch = userInput.match(usersPathPattern);
  if (usersPathMatch) {
    const cleanedPath = usersPathMatch[0].replace(/\\\s/g, " ").trim();
    console.log(chalk.gray(`  🔧 Cleaned /Users path: "${cleanedPath}"`));
    return cleanedPath;
  }

  // Handle other absolute paths starting with /
  const absolutePathPattern = /\/[^\s]+(?:\\\s[^\s]*)*/;
  const absolutePathMatch = userInput.match(absolutePathPattern);
  if (absolutePathMatch) {
    const cleanedPath = absolutePathMatch[0].replace(/\\\s/g, " ").trim();
    console.log(chalk.gray(`  🔧 Cleaned absolute path: "${cleanedPath}"`));
    return cleanedPath;
  }

  // Handle Windows paths
  const windowsPathPattern = /[C-Z]:\\[^\s]+(?:\\\s[^\s]*)*/;
  const windowsPathMatch = userInput.match(windowsPathPattern);
  if (windowsPathMatch) {
    const cleanedPath = windowsPathMatch[0].replace(/\\\s/g, " ").trim();
    console.log(chalk.gray(`  🔧 Cleaned Windows path: "${cleanedPath}"`));
    return cleanedPath;
  }

  // Handle relative paths
  const relativePathPattern = /\.\/[^\s]+(?:\\\s[^\s]*)*/;
  const relativePathMatch = userInput.match(relativePathPattern);
  if (relativePathMatch) {
    const cleanedPath = relativePathMatch[0].replace(/\\\s/g, " ").trim();
    console.log(chalk.gray(`  🔧 Cleaned relative path: "${cleanedPath}"`));
    return cleanedPath;
  }

  const parentPathPattern = /\.\.\/[^\s]+(?:\\\s[^\s]*)*/;
  const parentPathMatch = userInput.match(parentPathPattern);
  if (parentPathMatch) {
    const cleanedPath = parentPathMatch[0].replace(/\\\s/g, " ").trim();
    console.log(chalk.gray(`  🔧 Cleaned parent path: "${cleanedPath}"`));
    return cleanedPath;
  }

  // Try to find any path-like string that might have been dropped
  const anyPathPattern = /(\/[^\s]+(?:\\\s[^\s]*)*)/;
  const anyPathMatch = userInput.match(anyPathPattern);
  if (anyPathMatch) {
    const cleanedPath = anyPathMatch[1].replace(/\\\s/g, " ").trim();
    console.log(chalk.gray(`  🔧 Cleaned any path: "${cleanedPath}"`));
    return cleanedPath;
  }

  return null;
}

async function handleSlashCommand(
  command: string,
  config: any,
  sessionTracker?: SessionTracker
) {
  const [cmd, ...args] = command.split(" ");

  switch (cmd) {
    case "/init":
      await handleInitCommand();
      return "continue"; // Continue chat session

    case "/help":
      showSlashHelp();
      return "continue"; // Continue chat session

    case "/history": {
      const entries = ChatBoxUI.getHistoryEntries(10);
      console.log(chalk.bold.blue("\n🕑 Recent Prompts:"));
      if (entries.length === 0) {
        console.log(chalk.gray("  (history is empty for this profile)"));
      } else {
        entries.forEach((entry, index) => {
          console.log(
            chalk.cyan(`${index + 1}. `) +
              chalk.gray(entry.length > 120 ? `${entry.slice(0, 117)}...` : entry)
          );
        });
      }
      console.log("");
      return "continue";
    }

    case "/stats":
      if (sessionTracker) {
        ChatBoxUI.displayStats(sessionTracker.getCurrentStats());
      } else {
        console.log(chalk.yellow("⚠️  Session tracking not available"));
      }
      return "continue"; // Continue chat session

    case "/model":
      await handleModelCommand(config);
      return "continue"; // Continue chat session

    case "/provider":
      await handleProviderCommand();
      return "restart"; // Need to restart to load new provider

    case "/setup":
      await handleSetupCommand();
      return "restart"; // Need to restart to load new configuration

    case "/exit":
      console.log(chalk.gray("Exiting chat session..."));
      return "exit"; // Exit the chat loop

    default:
      console.log(chalk.red(`Unknown command: ${cmd}`));
      console.log(chalk.gray("Type /help for available commands"));
      return "continue"; // Continue chat session
  }
}

async function handleInitCommand() {
  const { writeFileSync, existsSync } = await import("fs");
  const { join } = await import("path");

  const agentsContent = `# AI Agent Configuration

This file helps AI models understand your project structure and coding preferences.

## Project Overview
- **Name**: ${process.cwd().split("/").pop() || "My Project"}
- **Type**: [Describe your project type]
- **Tech Stack**: [List main technologies]

## Coding Standards
- **Language**: TypeScript/JavaScript
- **Style**: [Your preferred coding style]
- **Patterns**: [Architectural patterns you use]

## Key Directories
- \`src/\` - Source code
- \`tests/\` - Test files
- \`docs/\` - Documentation

## Important Files
- \`package.json\` - Dependencies and scripts
- \`tsconfig.json\` - TypeScript configuration
- \`README.md\` - Project documentation

## AI Instructions
When working with this codebase:
1. Follow existing code patterns
2. Maintain type safety with TypeScript
3. Write clear, self-documenting code
4. Include appropriate error handling
5. Follow the established project structure

## Recent Changes
- [Track important changes here]

---
*This file is automatically managed by DevAI CLI*
`;

  const agentsPath = join(process.cwd(), "AGENTS.md");

  if (existsSync(agentsPath)) {
    console.log(chalk.yellow("⚠️  AGENTS.md already exists"));
    console.log(chalk.gray("Use /help for other commands"));
    return;
  }

  try {
    writeFileSync(agentsPath, agentsContent);
    console.log(chalk.green("✅ Created AGENTS.md"));
    console.log(
      chalk.gray("This file helps AI understand your project better")
    );
    console.log(
      chalk.cyan("Edit it to customize AI behavior for your project")
    );
  } catch (error) {
    console.log(chalk.red("❌ Failed to create AGENTS.md:"), error);
  }
}

async function handleModelCommand(config: any) {
  try {
    const provider = config.provider;

    // Check if provider supports model listing
    if (provider.listModels && typeof provider.listModels === "function") {
      const spinner = ora(chalk.blue("Fetching available models...")).start();

      try {
        const models = await provider.listModels();
        spinner.stop();

        if (models.length === 0) {
          console.log(chalk.yellow("⚠️  No models found"));
          return;
        }

        const currentModel = provider.getCurrentModel
          ? provider.getCurrentModel()
          : config.name;

        console.log(chalk.bold.blue("\n📦 Available Models:\n"));

        const choices = models.map((model: any) => {
          const displayName = model.name || model;
          const modelId = model.id || model.name || model;
          const isCurrent = modelId === currentModel;
          const label = isCurrent
            ? `${displayName} ${chalk.green("(current)")}`
            : displayName;

          return {
            name: label,
            value: modelId,
          };
        });

        const { selectedModel } = await inquirer.prompt([
          {
            type: "list",
            name: "selectedModel",
            message: "Select a model:",
            choices: [
              ...choices,
              new inquirer.Separator(),
              { name: chalk.gray("Cancel"), value: null },
            ],
          },
        ]);

        if (selectedModel && selectedModel !== currentModel) {
          if (
            provider.switchModel &&
            typeof provider.switchModel === "function"
          ) {
            provider.switchModel(selectedModel);
            console.log(
              chalk.green(
                `\n✅ Switched to model: ${chalk.bold(selectedModel)}\n`
              )
            );

            // Update config file
            const { writeFileSync, readFileSync, existsSync } = await import(
              "fs"
            );
            const { join } = await import("path");
            const { homedir } = await import("os");
            const configPath = join(homedir(), ".meer", "config.yaml");

            const yaml = await import("yaml");

            if (existsSync(configPath)) {
              const content = readFileSync(configPath, "utf-8");
              const fullConfig = yaml.parse(content);

              // Update the model in config
              fullConfig.model = selectedModel;

              writeFileSync(configPath, yaml.stringify(fullConfig), "utf-8");
              console.log(chalk.gray("Configuration updated in config.yaml\n"));
            } else {
              console.log(
                chalk.yellow(
                  "⚠️  Config file not found, model changed for this session only\n"
                )
              );
            }
          } else {
            console.log(
              chalk.yellow("⚠️  Provider does not support model switching")
            );
          }
        } else if (selectedModel === currentModel) {
          console.log(chalk.gray("\nNo change - already using this model\n"));
        } else {
          console.log(chalk.gray("\nCancelled\n"));
        }
      } catch (error) {
        spinner.stop();
        console.log(
          chalk.red("❌ Failed to fetch models:"),
          error instanceof Error ? error.message : String(error)
        );
        console.log(chalk.yellow("\n💡 This could be due to:"));
        console.log(chalk.gray("  • Network connectivity issues"));
        console.log(chalk.gray("  • Invalid API key or credentials"));
        console.log(chalk.gray("  • Provider service unavailable"));
        console.log(chalk.gray("  • Ollama not running (for Ollama provider)"));
        console.log(
          chalk.gray("\nPlease check your configuration and try again.")
        );
      }
    } else {
      console.log(
        chalk.yellow("⚠️  Current provider does not support model listing")
      );
      console.log(
        chalk.gray("Available for: Ollama, OpenAI-compatible providers")
      );
    }
  } catch (error) {
    console.log(
      chalk.red("❌ Error:"),
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function handleProviderCommand() {
  try {
    const { readFileSync, writeFileSync, existsSync } = await import("fs");
    const { join } = await import("path");
    const { homedir } = await import("os");
    const configPath = join(homedir(), ".meer", "config.yaml");

    if (!existsSync(configPath)) {
      console.log(chalk.red("❌ Config file not found"));
      return;
    }

    const yaml = await import("yaml");
    const content = readFileSync(configPath, "utf-8");
    const config = yaml.parse(content);

    const currentProvider = config.provider || "ollama";

    const providers = [
      { name: "ollama", icon: "🦙", label: "Ollama (Local)" },
      { name: "openai", icon: "🤖", label: "OpenAI" },
      { name: "gemini", icon: "✨", label: "Google Gemini" },
    ];

    console.log(chalk.bold.blue("\n🔌 Available Providers:\n"));

    const choices = providers.map((p) => {
      const label =
        p.name === currentProvider
          ? `${p.icon} ${p.label} ${chalk.green("(current)")}`
          : `${p.icon} ${p.label}`;

      return {
        name: label,
        value: p.name,
      };
    });

    const { selectedProvider } = await inquirer.prompt([
      {
        type: "list",
        name: "selectedProvider",
        message: "Select a provider:",
        choices: [
          ...choices,
          new inquirer.Separator(),
          { name: chalk.gray("Cancel"), value: null },
        ],
      },
    ]);

    if (selectedProvider && selectedProvider !== currentProvider) {
      config.provider = selectedProvider;

      // Set default model based on provider if not already set
      if (!config.model || config.provider !== selectedProvider) {
        if (selectedProvider === "openai") {
          config.model = "gpt-4o";
        } else if (selectedProvider === "gemini") {
          config.model = "gemini-2.0-flash-exp";
        } else if (selectedProvider === "ollama") {
          config.model = "mistral:7b-instruct";
        }
      }

      writeFileSync(configPath, yaml.stringify(config), "utf-8");

      const selected = providers.find((p) => p.name === selectedProvider);
      console.log(
        chalk.green(`\n✅ Switched to provider: ${chalk.bold(selected?.label)}`)
      );
      console.log(chalk.gray(`   Default model: ${config.model}`));
      console.log(
        chalk.yellow(
          "\n⚠️  Please restart the CLI for changes to take effect\n"
        )
      );
      console.log(
        chalk.gray(
          `💡 Tip: Use ${chalk.cyan(
            "/model"
          )} to change the model after restart\n`
        )
      );
    } else if (selectedProvider === currentProvider) {
      console.log(chalk.gray("\nNo change - already using this provider\n"));
    } else {
      console.log(chalk.gray("\nCancelled\n"));
    }
  } catch (error) {
    console.log(
      chalk.red("❌ Error:"),
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function handleSetupCommand() {
  try {
    console.log(chalk.blue("\n🔧 Starting setup wizard...\n"));

    // Import and run the setup command
    const { createSetupCommand } = await import("./commands/setup.js");
    const setupCmd = createSetupCommand();

    // Run setup with empty args array (no command line args)
    await setupCmd.parseAsync(["setup"], { from: "user" });

    console.log(
      chalk.green(
        "\n✅ Setup completed! Restarting session with new configuration...\n"
      )
    );
  } catch (error) {
    console.log(
      chalk.red("❌ Setup failed:"),
      error instanceof Error ? error.message : String(error)
    );
    console.log(chalk.gray("Continuing with current configuration...\n"));
  }
}

async function handleCodeBlocks(aiResponse: string) {
  const { writeFileSync, existsSync, mkdirSync, readFileSync } = await import(
    "fs"
  );
  const { join, dirname } = await import("path");

  // Look for code blocks in the AI response
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
  const matches = [...aiResponse.matchAll(codeBlockRegex)];

  if (matches.length === 0) {
    return; // No code blocks found
  }

  // Check if always allow is enabled
  const alwaysAllow = process.env.DEVAI_ALWAYS_ALLOW === "true";

  console.log(
    chalk.bold.blue("\n📝 Creating/updating files from AI response...\n")
  );

  for (const match of matches) {
    const [, language, code] = match;
    let cleanCode = code.trim();

    // Try to extract filepath from comment at the top of the code block
    let filename = "";
    let filePath = "";
    const filepathMatch = cleanCode.match(
      /^(?:\/\/|#|<!--)\s*filepath:\s*(.+?)(?:-->)?\n/i
    );

    if (filepathMatch) {
      // Extract filepath from comment
      filename = filepathMatch[1].trim();
      // Remove the filepath comment from the code
      cleanCode = cleanCode
        .replace(/^(?:\/\/|#|<!--)\s*filepath:\s*.+?(?:-->)?\n/i, "")
        .trim();

      // Check if it's an absolute path
      const { isAbsolute } = await import("path");
      if (isAbsolute(filename)) {
        filePath = filename;
      } else {
        filePath = join(process.cwd(), filename);
      }
    } else {
      // Fallback: Determine file extension and name based on language
      if (language === "html") {
        filename = "index.html";
      } else if (language === "javascript" || language === "js") {
        filename = "app.js";
      } else if (language === "css") {
        filename = "style.css";
      } else if (language === "python" || language === "py") {
        filename = "main.py";
      } else if (language === "typescript" || language === "ts") {
        filename = "index.ts";
      } else if (language === "json") {
        filename = "config.json";
      } else {
        // Default to .txt for unknown languages
        filename = `code_${Date.now()}.txt`;
      }
      filePath = join(process.cwd(), filename);
    }

    // Check if file already exists
    const fileExists = existsSync(filePath);
    let existingContent = "";
    if (fileExists) {
      try {
        existingContent = readFileSync(filePath, "utf-8");
      } catch (error) {
        existingContent = "";
      }
    }

    // Get display name (basename for absolute paths)
    const { basename } = await import("path");
    const displayName = basename(filePath);

    // Show file analysis and diff
    if (fileExists && existingContent !== cleanCode) {
      console.log(chalk.yellow(`📄 Updating existing file: ${filePath}`));
      showColoredDiff(existingContent, cleanCode);
    } else if (!fileExists) {
      console.log(chalk.green(`📄 Creating new file: ${filePath}`));
      showFilePreview(cleanCode);
    } else {
      console.log(chalk.gray(`📄 File ${filePath} unchanged`));
      continue;
    }

    // Quick confirmation for non-always-allow mode
    let action = "apply";
    if (!alwaysAllow) {
      const { confirm } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirm",
          message: `Apply changes to ${filePath}?`,
          default: true,
        },
      ]);

      if (!confirm) {
        console.log(chalk.gray(`Skipped ${filePath}`));
        continue;
      }
    }

    // Apply changes
    try {
      // Ensure directory exists
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(filePath, cleanCode, "utf-8");
      console.log(chalk.green(`✅ Created/updated: ${filePath}`));
    } catch (error) {
      console.log(chalk.red(`❌ Failed to create ${filePath}:`), error);
    }
  }

  console.log(chalk.gray("\n💡 Files are ready to use!"));
}

function showColoredDiff(oldContent: string, newContent: string) {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  console.log(chalk.gray("┌─ Changes:"));

  // Show first few lines of changes
  let changeCount = 0;
  const maxChanges = 8;

  for (
    let i = 0;
    i < Math.max(oldLines.length, newLines.length) && changeCount < maxChanges;
    i++
  ) {
    const oldLine = oldLines[i] || "";
    const newLine = newLines[i] || "";

    if (oldLine !== newLine) {
      changeCount++;
      if (oldLine) {
        console.log(chalk.red(`- ${oldLine}`));
      }
      if (newLine) {
        console.log(chalk.green(`+ ${newLine}`));
      }
    } else if (changeCount > 0 && changeCount < 3) {
      // Show context lines
      console.log(chalk.gray(`  ${oldLine}`));
    }
  }

  if (changeCount >= maxChanges) {
    console.log(chalk.gray("  ... (more changes)"));
  }

  console.log(chalk.gray("└─"));
}

function showFilePreview(content: string) {
  const lines = content.split("\n");
  const previewLines = lines.slice(0, 5);

  console.log(chalk.gray("┌─ Preview:"));
  previewLines.forEach((line) => {
    console.log(chalk.gray(`│ ${line}`));
  });

  if (lines.length > 5) {
    console.log(chalk.gray(`│ ... (${lines.length - 5} more lines)`));
  }

  console.log(chalk.gray("└─"));
}

async function collectProjectContext() {
  const { ProjectContextManager } = await import(
    "./context/manager.js"
  );

  const manager = ProjectContextManager.getInstance();
  const { files } = manager.getContext(process.cwd());

  const includePatterns = [
    "*.html",
    "*.css",
    "*.js",
    "*.ts",
    "*.jsx",
    "*.tsx",
    "*.json",
    "*.py",
    "*.java",
    "*.go",
    "*.rs",
    "*.md",
    "readme",
    "package.json",
    "tsconfig.json",
    "agents.md",
    "*.yml",
    "*.yaml",
  ];

  let filtered = files
    .filter((file) => {
      const lowerPath = file.path.toLowerCase();
      return includePatterns.some((pattern) => {
        if (pattern.startsWith("*")) {
          return lowerPath.endsWith(pattern.slice(1));
        }
        return lowerPath === pattern || lowerPath.startsWith(pattern);
      });
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  if (filtered.length === 0) {
    filtered = [...files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, Math.min(files.length, 200));
  }

  return filtered.map((file) => ({ path: file.path }));
}

// Intelligent model-based decision making
async function tryDirectResponse(
  input: string,
  config: any
): Promise<{ needsContext: boolean; response: string }> {
  try {
    // Simple hardcoded rules for common cases (more reliable than AI classification)
    const lowerInput = input.toLowerCase().trim();

    // Only very simple greetings that definitely don't need context
    const simplePatterns = [
      /^hi$/i,
      /^hello$/i,
      /^hey$/i,
      /^yo$/i,
      /^thanks?$/i,
      /^thank you$/i,
      /^bye$/i,
      /^goodbye$/i,
    ];

    for (const pattern of simplePatterns) {
      if (pattern.test(input)) {
        return {
          needsContext: false,
          response:
            "Hello! I'm MeerAI, your AI coding companion. How can I help you with your project today?",
        };
      }
    }

    const provider = config.provider;

    // Ask the model to decide if it needs project context
    const decisionPrompt = `You are MeerAI, an AI coding companion. The user said: "${input}"

IMPORTANT: Set needsContext=true if the user is asking for ANY of the following:
- Code analysis, review, or debugging
- File modifications or creation
- Project setup or scaffolding
- Implementation of features (build, create, implement, add, etc.)
- Technical questions about the codebase
- Any request that involves working with code or files
- Questions about project structure or files
- Requests to build, create, or implement anything

Set needsContext=false ONLY for:
- Simple greetings (Hi, Hello, Hey, etc.)
- General questions about the AI (Who made you, What can you do, How do you work, etc.)
- Personal questions about the AI (Who are you, Who built you, What's your name, etc.)
- Thanks/goodbye messages
- General chat not related to code or implementation

Examples that need context:
- "build a backend" → needsContext=true
- "create a component" → needsContext=true  
- "implement auth" → needsContext=true
- "add a feature" → needsContext=true
- "fix this error" → needsContext=true
- "analyze my code" → needsContext=true

Examples that don't need context:
- "Hi" → needsContext=false
- "Who are you?" → needsContext=false
- "What can you do?" → needsContext=false
- "Thanks" → needsContext=false

Respond ONLY with this exact JSON format (no extra text):
{
  "needsContext": true,
  "response": ""
}

For the user input "${input}", respond with JSON:`;

    const response = await provider.chat([
      { role: "user", content: decisionPrompt },
    ]);

    logVerbose(
      chalk.gray(`🔍 AI raw response: ${response.substring(0, 300)}...`)
    );

    // Parse the JSON response
    try {
      // Clean the response to extract JSON
      let cleanResponse = response.trim();

      // Look for JSON content between ```json and ``` or { and }
      const jsonMatch =
        cleanResponse.match(/```json\s*([\s\S]*?)\s*```/) ||
        cleanResponse.match(/(\{[\s\S]*\})/);

      if (jsonMatch) {
        cleanResponse = jsonMatch[1];
      }

      const decision = JSON.parse(cleanResponse);

      // Validate the response structure
      if (typeof decision.needsContext === "boolean") {
        return {
          needsContext: decision.needsContext,
          response: decision.response || "",
        };
      } else {
        // Invalid structure, assume needs context
        return { needsContext: true, response: "" };
      }
    } catch (parseError) {
      console.log(
        chalk.yellow(
          `⚠️  JSON parsing error: ${
            parseError instanceof Error ? parseError.message : "Unknown error"
          }`
        )
      );
      console.log(chalk.gray(`Raw response: ${response.substring(0, 200)}...`));
      // If JSON parsing fails, assume it needs context
      return { needsContext: true, response: "" };
    }
  } catch (error) {
    // If API call fails, assume it needs context and fall back to agent workflow
    return { needsContext: true, response: "" };
  }
}

async function buildContextPrompt(
  contextFiles: Array<{ name: string; content: string; path: string }>
) {
  let contextPrompt =
    "You are an AI coding assistant with access to the user's project files. ";
  contextPrompt +=
    "When the user asks you to modify or improve code, you should:\n";
  contextPrompt +=
    "1. Analyze the existing files to understand the project structure\n";
  contextPrompt += "2. Identify which files need to be modified or created\n";
  contextPrompt +=
    "3. Provide complete, updated code in code blocks with the filename as a comment at the top\n";
  contextPrompt += "4. Use this format for file modifications:\n";
  contextPrompt +=
    "```language\n// filepath: path/to/file.ext\ncode here\n```\n\n";

  if (contextFiles.length > 0) {
    contextPrompt += "## Current Project Files:\n\n";

    for (const file of contextFiles.slice(0, 20)) {
      // Limit to 20 files
      contextPrompt += `### ${file.path}\n`;
      contextPrompt += "```\n";
      const lines = file.content.split("\n");
      if (lines.length > 50) {
        contextPrompt += lines.slice(0, 30).join("\n");
        contextPrompt += `\n... (${lines.length - 30} more lines)\n`;
      } else {
        contextPrompt += file.content;
      }
      contextPrompt += "\n```\n\n";
    }

    if (contextFiles.length > 20) {
      contextPrompt += `\n... and ${contextFiles.length - 20} more files\n\n`;
    }
  }

  return contextPrompt;
}

async function showFileAnalysis() {
  const { readFileSync, existsSync, statSync } = await import("fs");
  const { join } = await import("path");

  // Common file patterns to analyze
  const filePatterns = [
    "index.html",
    "app.js",
    "style.css",
    "main.py",
    "index.ts",
    "config.json",
  ];

  const analysisFiles = [];

  for (const pattern of filePatterns) {
    const filePath = join(process.cwd(), pattern);
    if (existsSync(filePath)) {
      const stats = statSync(filePath);
      const content = readFileSync(filePath, "utf-8");
      analysisFiles.push({ name: pattern, size: stats.size, content });
    }
  }

  if (analysisFiles.length > 0) {
    console.log(chalk.bold.blue("\n📊 File Analysis:\n"));

    for (const file of analysisFiles) {
      console.log(chalk.cyan(`📄 ${file.name}`));
      console.log(chalk.gray(`   Size: ${file.size} bytes`));
      console.log(chalk.gray(`   Lines: ${file.content.split("\n").length}`));

      // Show file type analysis
      if (file.name.endsWith(".html")) {
        const hasScript = file.content.includes("<script");
        const hasStyle = file.content.includes("<style");
        console.log(
          chalk.gray(
            `   Features: ${hasScript ? "JavaScript" : ""} ${
              hasStyle ? "CSS" : ""
            }`
          )
        );
      } else if (file.name.endsWith(".js")) {
        const functions = (file.content.match(/function\s+\w+/g) || []).length;
        const classes = (file.content.match(/class\s+\w+/g) || []).length;
        console.log(
          chalk.gray(`   Features: ${functions} functions, ${classes} classes`)
        );
      } else if (file.name.endsWith(".py")) {
        const functions = (file.content.match(/def\s+\w+/g) || []).length;
        const classes = (file.content.match(/class\s+\w+/g) || []).length;
        console.log(
          chalk.gray(`   Features: ${functions} functions, ${classes} classes`)
        );
      }

      console.log("");
    }

    console.log(
      chalk.gray("💡 Files are ready to run or open in your editor!")
    );
  }
}

export function createCLI(): Command {
  const program = new Command();

  program
    .name("meer")
    .description(
      "MeerAI - Dive deep into your code. An open-source, local-first AI CLI for developers."
    )
    .version("1.0.0")
    .option("-p, --profile <name>", "Override the active profile")
    .option("-v, --verbose", "Enable verbose logging output")
    .hook("preAction", (thisCommand) => {
      const options = thisCommand.opts();
      if (options.profile) {
        process.env.DEVAI_PROFILE = options.profile;
      }
      setVerboseLogging(Boolean(options.verbose));
    });

  // Add commands
  program.addCommand(createSetupCommand());
  program.addCommand(createAskCommand());
  program.addCommand(createCommitMsgCommand());
  program.addCommand(createReviewCommand());
  program.addCommand(createMemoryCommand());

  // Show welcome screen and start chat when no command is provided
  program.action(async () => {
    await showWelcomeScreen();

    const { loadConfig } = await import("./config.js");
    const { AgentWorkflow } = await import("./agent/workflow.js");

    let restarting = false;

    do {
      restarting = false;

      try {
        let config = loadConfig();

        ProjectContextManager.getInstance().configureEmbeddings({
          enabled: config.contextEmbedding?.enabled ?? false,
          dimensions: config.contextEmbedding?.dimensions,
          maxFileSize: config.contextEmbedding?.maxFileSize,
        });

        const sessionTracker = new SessionTracker(
          config.providerType,
          config.model
        );

        const agent = new AgentWorkflow({
          provider: config.provider,
          cwd: process.cwd(),
          maxIterations: 10,
          providerType: config.providerType,
          model: config.model,
          sessionTracker,
        });

        console.log(chalk.gray("📂 Scanning project..."));
        const contextFiles = await collectProjectContext();
        console.log(
          chalk.gray(`✓ Found ${contextFiles.length} relevant files\n`)
        );

        const fileList = contextFiles.map((f) => `- ${f.path}`).join("\n");
        const contextPrompt = `## Available Files in Project:\n\n${fileList}\n\nUse the read_file tool to read any files you need.`;

        agent.initialize(contextPrompt);

        const handleExit = () => {
          const finalStats = sessionTracker.endSession();
          console.log("\n");
          ChatBoxUI.displayGoodbye(finalStats);
          process.exit(0);
        };

        process.on("SIGINT", handleExit);
        process.on("SIGTERM", handleExit);

        const askQuestion = async (): Promise<string> => {
          return ChatBoxUI.handleInput({
            provider: config.providerType,
            model: config.model,
            cwd: process.cwd(),
          });
        };

        let exitRequested = false;

        while (!exitRequested && !restarting) {
          ChatBoxUI.renderStatusBar({
            provider: config.providerType,
            model: config.model,
            cwd: process.cwd(),
          });

          const userInput = await askQuestion();

          if (
            userInput.toLowerCase() === "exit" ||
            userInput.toLowerCase() === "quit"
          ) {
            exitRequested = true;
            break;
          }

          if (!userInput) {
            continue;
          }

          if (await isImageFileRequest(userInput)) {
            await handleImageFileRequest(userInput, config);
            console.log("");
            continue;
          }

          if (userInput.startsWith("/")) {
            const result = await handleSlashCommand(
              userInput,
              config,
              sessionTracker
            );

            if (result === "exit") {
              exitRequested = true;
              break;
            }

            if (result === "restart") {
              restarting = true;
              console.log(chalk.yellow("\n🔄 Reloading configuration...\n"));
              break;
            }

            console.log("");
            continue;
          }

          sessionTracker.trackMessage();

          try {
            const messageStartTime = Date.now();

            logVerbose(chalk.blue("🤔 Deciding whether context is necessary"));

            const quickResponse = await tryDirectResponse(userInput, config);

            if (quickResponse.needsContext) {
              logVerbose(chalk.blue("🔍 Context required, invoking agent"));
              await agent.processMessage(userInput);
            } else {
              logVerbose(chalk.blue("✨ Responding directly without project context"));
              console.log(chalk.green("\n💬 ") + quickResponse.response);
            }

            sessionTracker.trackApiCall(Date.now() - messageStartTime);
          } catch (error) {
            console.log(
              chalk.red("\n❌ Error:"),
              error instanceof Error ? error.message : String(error)
            );
          }

          console.log("\n");
        }

        process.off("SIGINT", handleExit);
        process.off("SIGTERM", handleExit);

        const finalStats = sessionTracker.endSession();

        if (!restarting) {
          ChatBoxUI.displayGoodbye(finalStats);
          break;
        }
      } catch (error) {
        console.error(
          chalk.red("\n❌ Failed to start chat session:"),
          error instanceof Error ? error.message : String(error)
        );
        console.error(
          chalk.gray(
            "💡 Tip: Run meer setup to configure your providers or check your config file."
          )
        );
        break;
      }
    } while (restarting);
  });

  // Global error handling
  program.configureOutput({
    writeErr: (str) => process.stderr.write(str),
    writeOut: (str) => process.stdout.write(str),
    outputError: (str, write) => write(chalk.red(str)),
  });

  return program;
}
