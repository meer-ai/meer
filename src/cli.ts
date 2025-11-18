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
import { createMCPCommand } from "./commands/mcp.js";
import { createLoginCommand } from "./commands/login.js";
import { createLogoutCommand } from "./commands/logout.js";
import { createWhoamiCommand } from "./commands/whoami.js";
import { createIndexCommand } from "./commands/indexCmd.js";
import { createDoctorCommand } from "./commands/doctor.js";
import { handleVersion } from "./commands/version.js";
import { createAgentsCommand } from "./commands/agents.js";
import { SessionTracker } from "./session/tracker.js";
import { ChatBoxUI } from "./ui/chatbox.js";
import { WorkflowTimeline, type Timeline } from "./ui/workflowTimeline.js";
import { InkChatAdapter } from "./ui/ink/index.js";
import { logVerbose, setVerboseLogging } from "./logger.js";
import { showSlashHelp } from "./ui/slashHelp.js";
import { ProjectContextManager } from "./context/manager.js";
import { runCommand } from "./tools/index.js";
import {
  resolveCustomCommand,
  getSlashCommandErrors,
} from "./slash/registry.js";
import type { SlashCommandDefinition } from "./slash/schema.js";
import { renderSlashTemplate } from "./slash/template.js";

// Get package.json path and read version
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = join(__dirname, "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
const VERSION = packageJson.version;

async function showWelcomeScreen() {
  console.clear();

  // Large MEER ASCII art logo with ocean wave pattern
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
    chalk.bold.cyan(
      "            🌊 Dive deep into your code like the vast ocean"
    )
  );
  console.log(
    chalk.gray(
      "          Model-agnostic CLI • Ollama • OpenAI • Anthropic • Gemini • OpenRouter"
    )
  );
  console.log("");
  console.log(chalk.hex("#0ea5e9")("═".repeat(85)));
  console.log("");

  // Check if this is first-time setup
  const { configExists } = await import("./config.js");
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
          chalk.yellow(" anytime to configure Meer.\n")
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
        : config.providerType === "anthropic"
        ? "🧠 Anthropic"
        : config.providerType === "openrouter"
        ? "🌐 OpenRouter"
        : config.providerType === "meer"
        ? "🌊 Meer Managed"
        : config.providerType === "zaiCodingPlan"
        ? "⚡ Z.ai Coding Plan"
        : config.providerType === "zaiCredit"
        ? "⚡ Z.ai Credit"
        : config.providerType === "zai"
        ? "⚡ Z.ai (legacy)"
        : config.providerType;

    console.log(chalk.bold.blue("📋 Configuration:"));
    console.log(chalk.white("  Provider:") + " " + chalk.yellow(providerLabel));
    console.log(chalk.white("  Model:") + " " + chalk.green(config.model));
    console.log(chalk.white("  Version:") + " " + chalk.gray(VERSION));

    // Show auth status
    const { AuthStorage } = await import("./auth/storage.js");
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
  } catch (error) {
    console.log(chalk.yellow("⚠️  Configuration not loaded"));
    console.log("");
  }

  console.log(chalk.bold.yellow("🚀 Quick Commands:"));
  console.log(chalk.white("• Setup wizard:") + " " + chalk.cyan("meer setup"));
  console.log(chalk.white("• Login/logout:") + " " + chalk.cyan("meer login") + " " + chalk.gray("| meer logout"));
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

  // Check if input contains image-related keywords
  const hasImageKeywords = imageKeywords.some((keyword) =>
    userInput.toLowerCase().includes(keyword.toLowerCase())
  );

  // If keywords are present, it's likely an image request
  if (hasImageKeywords) {
    return true;
  }

  // Otherwise, only consider it an image request if it's a clean path ending with an image extension
  // Not just any occurrence of image extension in the text (to avoid false positives from error messages)
  const cleanPathPattern = new RegExp(`\\b\\S+\\.(${imageExtensions.map(ext => ext.slice(1)).join('|')})\\b`, 'i');
  const hasCleanImagePath = cleanPathPattern.test(userInput);

  // Additional check: must not look like an error message or webpack path
  const looksLikeError = userInput.includes('Error') ||
                         userInput.includes('webpack') ||
                         userInput.includes('loader') ||
                         userInput.includes('!=!') ||
                         userInput.includes('??');

  return hasCleanImagePath && !looksLikeError;
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
  // Only surface path-parsing traces when verbose logging is enabled
  logVerbose(chalk.gray(`  🔍 Raw input: "${userInput}"`));

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
      logVerbose(
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
    logVerbose(
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
    logVerbose(
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
    logVerbose(chalk.gray(`  🔧 Cleaned escaped path: "${cleanedPath}"`));
    return cleanedPath;
  }

  // Handle paths that start with /Users (common on macOS)
  const usersPathPattern = /\/Users\/[^\s]+(?:\\\s[^\s]*)*/;
  const usersPathMatch = userInput.match(usersPathPattern);
  if (usersPathMatch) {
    const cleanedPath = usersPathMatch[0].replace(/\\\s/g, " ").trim();
    logVerbose(chalk.gray(`  🔧 Cleaned /Users path: "${cleanedPath}"`));
    return cleanedPath;
  }

  // Handle other absolute paths starting with /
  const absolutePathPattern = /\/[^\s]+(?:\\\s[^\s]*)*/;
  const absolutePathMatch = userInput.match(absolutePathPattern);
  if (absolutePathMatch) {
    const cleanedPath = absolutePathMatch[0].replace(/\\\s/g, " ").trim();
    logVerbose(chalk.gray(`  🔧 Cleaned absolute path: "${cleanedPath}"`));
    return cleanedPath;
  }

  // Handle Windows paths
  const windowsPathPattern = /[C-Z]:\\[^\s]+(?:\\\s[^\s]*)*/;
  const windowsPathMatch = userInput.match(windowsPathPattern);
  if (windowsPathMatch) {
    const cleanedPath = windowsPathMatch[0].replace(/\\\s/g, " ").trim();
    logVerbose(chalk.gray(`  🔧 Cleaned Windows path: "${cleanedPath}"`));
    return cleanedPath;
  }

  // Handle relative paths
  const relativePathPattern = /\.\/[^\s]+(?:\\\s[^\s]*)*/;
  const relativePathMatch = userInput.match(relativePathPattern);
  if (relativePathMatch) {
    const cleanedPath = relativePathMatch[0].replace(/\\\s/g, " ").trim();
    logVerbose(chalk.gray(`  🔧 Cleaned relative path: "${cleanedPath}"`));
    return cleanedPath;
  }

  const parentPathPattern = /\.\.\/[^\s]+(?:\\\s[^\s]*)*/;
  const parentPathMatch = userInput.match(parentPathPattern);
  if (parentPathMatch) {
    const cleanedPath = parentPathMatch[0].replace(/\\\s/g, " ").trim();
    logVerbose(chalk.gray(`  🔧 Cleaned parent path: "${cleanedPath}"`));
    return cleanedPath;
  }

  // Try to find any path-like string that might have been dropped
  const anyPathPattern = /(\/[^\s]+(?:\\\s[^\s]*)*)/;
  const anyPathMatch = userInput.match(anyPathPattern);
  if (anyPathMatch) {
    const cleanedPath = anyPathMatch[1].replace(/\\\s/g, " ").trim();
    logVerbose(chalk.gray(`  🔧 Cleaned any path: "${cleanedPath}"`));
    return cleanedPath;
  }

  return null;
}

type SlashCommandResult =
  | { status: "continue" }
  | { status: "restart" }
  | { status: "exit" }
  | { status: "send"; message: string };

interface SlashCommandContext {
  args: string[];
  argsText: string;
  rawInput: string;
  config: any;
  sessionTracker?: SessionTracker;
  tui?: InkChatAdapter | null;
}

type SlashCommandHandler = (
  context: SlashCommandContext,
) => Promise<SlashCommandResult>;

const SLASH_RESULT_CONTINUE: SlashCommandResult = { status: "continue" };
const SLASH_RESULT_RESTART: SlashCommandResult = { status: "restart" };
const SLASH_RESULT_EXIT: SlashCommandResult = { status: "exit" };

const continueResult = () => SLASH_RESULT_CONTINUE;
const restartResult = () => SLASH_RESULT_RESTART;
const exitResult = () => SLASH_RESULT_EXIT;

function parseSlashInput(input: string): {
  command: string;
  args: string[];
  argsText: string;
} {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return { command: trimmed, args: [], argsText: "" };
  }

  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace === -1) {
    return { command: trimmed, args: [], argsText: "" };
  }

  const command = trimmed.slice(0, firstSpace);
  const argsText = trimmed.slice(firstSpace + 1).trim();
  const args = argsText.length > 0 ? argsText.split(/\s+/) : [];
  return { command, args, argsText };
}

function tokenizeCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && quote === '"' && i + 1 < input.length) {
        i += 1;
        current += input[i];
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

const MEER_CLI_FACTORIES: Record<string, () => Command> = {
  ask: createAskCommand,
  "commit-msg": createCommitMsgCommand,
  review: createReviewCommand,
  memory: createMemoryCommand,
  setup: createSetupCommand,
  mcp: createMCPCommand,
  login: createLoginCommand,
  logout: createLogoutCommand,
  whoami: createWhoamiCommand,
  index: createIndexCommand,
  agents: createAgentsCommand,
};

type ToggleMode = "on" | "off" | "auto";

const SCREEN_READER_USAGE = chalk.gray(
  "Usage: /screen-reader <on|off|auto>",
);
const ALT_BUFFER_USAGE = chalk.gray("Usage: /alt-buffer <on|off|auto>");

const parseToggleMode = (value?: string): ToggleMode | null => {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (normalized === "on" || normalized === "off" || normalized === "auto") {
    return normalized;
  }
  return null;
};

const ensureTuiAvailable = (
  context: SlashCommandContext,
  feature: string,
): InkChatAdapter | null => {
  if (context.tui) {
    return context.tui;
  }
  console.log(
    chalk.yellow(
      `${feature} is only available in the interactive TUI. Re-run Meer without disabling the TUI to use this command.`,
    ),
  );
  return null;
};

const builtInSlashHandlers: Record<string, SlashCommandHandler> = {
  "/ask": async ({ args }) => {
    if (args.length === 0) {
      console.log(
        chalk.gray(
          "\nTip: use /ask <question>. Example: /ask What does main.ts do?\n",
        ),
      );
      return continueResult();
    }
    await runStandaloneCommand(createAskCommand, args);
    return continueResult();
  },
  "/commit-msg": async ({ args }) => {
    await runStandaloneCommand(createCommitMsgCommand, args);
    return continueResult();
  },
  "/index": async ({ args }) => {
    await runStandaloneCommand(createIndexCommand, args);
    return continueResult();
  },
  "/init": async () => {
    await handleInitCommand();
    return continueResult();
  },
  "/help": async () => {
    showSlashHelp();
    return continueResult();
  },
  "/history": async () => {
    const entries = ChatBoxUI.getHistoryEntries(10);
    console.log(chalk.bold.blue("\n?? Recent Prompts:"));
    if (entries.length === 0) {
      console.log(chalk.gray("  (history is empty for this profile)"));
    } else {
      entries.forEach((entry, index) => {
        console.log(
          chalk.cyan(`${index + 1}. `) +
            chalk.gray(entry.length > 120 ? `${entry.slice(0, 117)}...` : entry),
        );
      });
    }
    console.log("");
    return continueResult();
  },
  "/stats": async ({ sessionTracker }) => {
    if (sessionTracker) {
      ChatBoxUI.displayStats(sessionTracker.getCurrentStats());
    } else {
      console.log(chalk.yellow("??  Session tracking not available"));
    }
    return continueResult();
  },
  "/account": async () => {
    await handleAccountCommand();
    return continueResult();
  },
  "/login": async ({ args }) => {
    await runStandaloneCommand(createLoginCommand, args);
    return continueResult();
  },
  "/logout": async ({ args }) => {
    await runStandaloneCommand(createLogoutCommand, args);
    return continueResult();
  },
  "/mcp": async ({ args }) => {
    await runStandaloneCommand(createMCPCommand, args);
    return continueResult();
  },
  "/memory": async ({ args }) => {
    await runStandaloneCommand(createMemoryCommand, args);
    return continueResult();
  },
  "/model": async ({ config }) => {
    await handleModelCommand(config);
    return continueResult();
  },
  "/provider": async () => {
    await handleProviderCommand();
    return restartResult();
  },
  "/review": async ({ args }) => {
    await runStandaloneCommand(createReviewCommand, args);
    return continueResult();
  },
  "/setup": async () => {
    await handleSetupCommand();
    return restartResult();
  },
  "/screen-reader": async (context) => {
    const tui = ensureTuiAvailable(context, "Screen reader mode");
    if (!tui) return continueResult();
    const mode = parseToggleMode(context.args[0]);
    if (!mode) {
      console.log(SCREEN_READER_USAGE);
      return continueResult();
    }
    tui.setScreenReaderMode(mode);
    const message =
      mode === "on"
        ? "Screen reader layout enabled."
        : mode === "off"
          ? "Screen reader layout disabled."
          : "Screen reader layout reset to config defaults.";
    tui.appendSystemMessage(message);
    return continueResult();
  },
  "/alt-buffer": async (context) => {
    const tui = ensureTuiAvailable(context, "Alternate buffer mode");
    if (!tui) return continueResult();
    const mode = parseToggleMode(context.args[0]);
    if (!mode) {
      console.log(ALT_BUFFER_USAGE);
      return continueResult();
    }
    tui.setAlternateBufferMode(mode);
    const message =
      mode === "on"
        ? "Alternate screen buffer enabled."
        : mode === "off"
          ? "Alternate screen buffer disabled."
          : "Alternate screen buffer reset to config defaults.";
    tui.appendSystemMessage(message);
    return continueResult();
  },
  "/version": async () => {
    await handleVersion();
    return continueResult();
  },
  "/whoami": async ({ args }) => {
    await runStandaloneCommand(createWhoamiCommand, args);
    return continueResult();
  },
  "/exit": async () => {
    console.log(chalk.gray("Exiting chat session..."));
    return exitResult();
  },
};

async function executePromptSlashCommand(
  definition: SlashCommandDefinition,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  const template = definition.template ?? "";
  const variables: Record<string, string> = {
    args: context.argsText,
    input: context.argsText,
    command: definition.command,
    raw: context.rawInput,
    cwd: process.cwd(),
  };

  context.args.forEach((value, index) => {
    variables[`arg${index}`] = value;
  });

  const rendered = renderSlashTemplate(template, variables);
  const trimmed = rendered.trim();

  if (!trimmed) {
    console.log(
      chalk.yellow(
        "Generated prompt is empty. Update the template or provide arguments.",
      ),
    );
    return continueResult();
  }

  return { status: "send", message: trimmed };
}

async function executeShellSlashCommand(
  definition: SlashCommandDefinition,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  const baseFragments = [
    definition.action ?? "",
    ...(definition.args ?? []),
  ].filter((fragment) => fragment && fragment.length > 0);

  const baseCommand = baseFragments.join(" ").trim();
  const fullCommand =
    context.argsText.length > 0
      ? `${baseCommand}${baseCommand ? " " : ""}${context.argsText}`
      : baseCommand;

  if (!fullCommand) {
    console.log(
      chalk.red("Shell command configuration is missing the action to run."),
    );
    return continueResult();
  }

  const result = await runCommand(fullCommand, process.cwd());
  if (result.error) {
    console.log(chalk.red(`? ${result.error}`));
  }
  return continueResult();
}

async function executeMeerCliSlashCommand(
  definition: SlashCommandDefinition,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  if (!definition.action) {
    console.log(
      chalk.red("Meer CLI command configuration requires an action string."),
    );
    return continueResult();
  }

  const baseTokens = tokenizeCommandLine(definition.action);
  if (baseTokens.length === 0) {
    console.log(
      chalk.red("Meer CLI command configuration did not provide a sub-command."),
    );
    return continueResult();
  }

  const subCommand = baseTokens[0];
  const factory = MEER_CLI_FACTORIES[subCommand];
  if (!factory) {
    console.log(
      chalk.yellow(
        `Unknown Meer CLI sub-command "${subCommand}". Update the action field.`,
      ),
    );
    return continueResult();
  }

  const configuredArgs = baseTokens.slice(1);
  const extraArgs = definition.args ?? [];
  const combinedArgs = [...configuredArgs, ...extraArgs, ...context.args];

  await runStandaloneCommand(factory, combinedArgs);
  return continueResult();
}

async function executeCustomSlashCommand(
  definition: SlashCommandDefinition,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  switch (definition.type) {
    case "prompt":
      return executePromptSlashCommand(definition, context);
    case "shell":
      return executeShellSlashCommand(definition, context);
    case "meer-cli":
      return executeMeerCliSlashCommand(definition, context);
    default:
      console.log(
        chalk.red(
          `Unsupported slash command type "${definition.type}". Update your configuration.`,
        ),
      );
      return continueResult();
  }
}

async function handleSlashCommand(
  command: string,
  config: any,
  sessionTracker?: SessionTracker,
  tui?: InkChatAdapter | null,
): Promise<SlashCommandResult> {
  const { command: name, args, argsText } = parseSlashInput(command);
  const context: SlashCommandContext = {
    args,
    argsText,
    rawInput: command,
    config,
    sessionTracker,
    tui,
  };

  const handler = builtInSlashHandlers[name];
  if (handler) {
    return handler(context);
  }

  const resolved = resolveCustomCommand(name);
  if (!resolved) {
    console.log(chalk.red(`Unknown command: ${name}`));

    const errors = getSlashCommandErrors();
    if (errors.length > 0) {
      console.log(chalk.gray("Custom slash commands failed to load:"));
      errors.forEach((error) => {
        console.log(chalk.gray(`  - ${error.file}: ${error.message}`));
      });
    } else {
      console.log(chalk.gray("Type /help for available commands"));
    }
    return continueResult();
  }

  if (!resolved.overrideEnabled) {
    console.log(
      chalk.yellow(
        `${name} is reserved by Meer. Set override: true in your configuration to replace the built-in command.`,
      ),
    );
    return continueResult();
  }

  return executeCustomSlashCommand(resolved.definition, context);
}
async function runStandaloneCommand(
  factory: () => Command,
  args: string[] = []
): Promise<void> {
  const command = factory();
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => process.stdout.write(str),
    writeErr: (str) => process.stderr.write(str),
    outputError: (str, write) => write(chalk.red(str)),
  });

  try {
    await command.parseAsync(args, { from: "user" });
  } catch (error) {
    const err = error as { code?: string; exitCode?: number; message?: string };
    if (err?.code === "commander.helpDisplayed" || err?.code === "commander.version") {
      return;
    }
    if (typeof err?.exitCode === "number") {
      if (err.exitCode === 0) {
        return;
      }
      const message = err.message ?? "Command exited with an error.";
      console.log(chalk.red(`
⚠ ${message.trim()}
`));
      return;
    }
    throw error;
  }
}

async function handleAccountCommand() {
  const { AuthStorage } = await import("./auth/storage.js");
  const authStorage = new AuthStorage();

  if (!authStorage.isAuthenticated()) {
    console.log(chalk.yellow("\n⚠️  Not logged in"));
    console.log(chalk.gray("   Run ") + chalk.cyan("meer login") + chalk.gray(" to authenticate"));
    console.log("");
    return;
  }

  const user = authStorage.getUser();
  if (!user) {
    console.log(chalk.yellow("\n⚠️  No user information found\n"));
    return;
  }

  console.log(chalk.bold.blue("\n👤 Account Information\n"));
  console.log(chalk.white("   Name:") + "          " + chalk.cyan(user.name));
  console.log(chalk.white("   Email:") + "         " + chalk.gray(user.email));
  console.log(chalk.white("   ID:") + "            " + chalk.dim(user.id));
  console.log(chalk.white("   Subscription:") + "  " + chalk.yellow(user.subscription_tier.toUpperCase()));

  if (user.avatar_url) {
    console.log(chalk.white("   Avatar:") + "        " + chalk.blue(user.avatar_url));
  }

  const memberSince = new Date(user.created_at).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  console.log(chalk.white("   Member since:") + "  " + chalk.gray(memberSince));

  // Show tier benefits
  console.log("");
  console.log(chalk.bold.white("   Benefits:"));
  if (user.subscription_tier === "free") {
    console.log(chalk.gray("   • Basic features"));
    console.log(chalk.gray("   • Local model support"));
    console.log(chalk.gray("   • Session history"));
    console.log("");
    console.log(chalk.yellow("   💡 Upgrade to unlock:"));
    console.log(chalk.gray("   • Cloud sync across devices"));
    console.log(chalk.gray("   • Priority support"));
    console.log(chalk.gray("   • Advanced features"));
  } else if (user.subscription_tier === "pro") {
    console.log(chalk.green("   ✓ All basic features"));
    console.log(chalk.green("   ✓ Cloud sync"));
    console.log(chalk.green("   ✓ Priority support"));
    console.log(chalk.green("   ✓ Advanced features"));
  } else if (user.subscription_tier === "enterprise") {
    console.log(chalk.cyan("   ✓ All Pro features"));
    console.log(chalk.cyan("   ✓ Team collaboration"));
    console.log(chalk.cyan("   ✓ Custom integrations"));
    console.log(chalk.cyan("   ✓ Dedicated support"));
  }

  console.log("");
  console.log(chalk.gray("   Commands: ") + chalk.cyan("meer whoami") + chalk.gray(" | ") + chalk.cyan("meer logout"));
  console.log("");
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

        // Create a new prompt module to avoid conflicts with Ink
        const promptModule = inquirer.createPromptModule();
        const { selectedModel } = await promptModule([
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
      { name: "meer", icon: "🌊", label: "Meer Managed Provider" },
      { name: "ollama", icon: "🦙", label: "Ollama (Local)" },
      { name: "openai", icon: "🤖", label: "OpenAI" },
      { name: "gemini", icon: "✨", label: "Google Gemini" },
      { name: "anthropic", icon: "🧠", label: "Anthropic Claude" },
      { name: "openrouter", icon: "🌐", label: "OpenRouter" },
      { name: "zaiCodingPlan", icon: "⚡", label: "Z.ai Coding Plan" },
      { name: "zaiCredit", icon: "⚡", label: "Z.ai Credit (PAYG)" },
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

    // Create a new prompt module to avoid conflicts with Ink
    const promptModule = inquirer.createPromptModule();
    const { selectedProvider } = await promptModule([
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
        } else if (selectedProvider === "anthropic") {
          config.model = "claude-3-5-sonnet-20241022";
        } else if (selectedProvider === "openrouter") {
          config.model = "anthropic/claude-3.5-sonnet";
        } else if (selectedProvider === "meer") {
          config.model = "auto";
        } else if (selectedProvider === "zaiCodingPlan" || selectedProvider === "zaiCredit" || selectedProvider === "zai") {
          config.model = "glm-4";
        }

        if (selectedProvider === "meer") {
          config.meer = config.meer || {};
          config.meer.apiKey = config.meer.apiKey || "";
        } else if (selectedProvider === "zaiCodingPlan") {
          config.zaiCodingPlan = config.zaiCodingPlan || {};
          config.zaiCodingPlan.apiKey = config.zaiCodingPlan.apiKey || "";
        } else if (selectedProvider === "zaiCredit") {
          config.zaiCredit = config.zaiCredit || {};
          config.zaiCredit.apiKey = config.zaiCredit.apiKey || "";
        } else if (selectedProvider === "zai") {
          config.zai = config.zai || {};
          config.zai.apiKey = config.zai.apiKey || "";
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
  const { ProjectContextManager } = await import("./context/manager.js");

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
    .version(VERSION)
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
  program.addCommand(createLoginCommand());
  program.addCommand(createLogoutCommand());
  program.addCommand(createWhoamiCommand());
  program.addCommand(createAskCommand());
  program.addCommand(createCommitMsgCommand());
  program.addCommand(createReviewCommand());
  program.addCommand(createMemoryCommand());
  program.addCommand(createMCPCommand());
  program.addCommand(createIndexCommand());
  program.addCommand(createAgentsCommand());
  program.addCommand(createDoctorCommand());

  // Show welcome screen and start chat when no command is provided
  program.action(async () => {
    await showWelcomeScreen();

    const { loadConfig } = await import("./config.js");
    const agentMode = (process.env.MEER_AGENT || "").toLowerCase();
    const useLangChainAgent = agentMode === "langchain";
    const { AgentWorkflowV2 } = await import("./agent/workflow-v2.js");
    let LangChainAgentWorkflow: any;
    if (useLangChainAgent) {
      ({ LangChainAgentWorkflow } = await import(
        "./agent/langchainWorkflow.js"
      ));
    }

    let restarting = false;

    do {
      restarting = false;

      try {
        let config = loadConfig();

        const providerType = config.providerType ?? "unknown";

        ProjectContextManager.getInstance().configureEmbeddings({
          enabled: config.contextEmbedding?.enabled ?? false,
          dimensions: config.contextEmbedding?.dimensions,
          maxFileSize: config.contextEmbedding?.maxFileSize,
        });

        const sessionTracker = new SessionTracker(providerType, config.model);

        const agent = useLangChainAgent && LangChainAgentWorkflow
          ? new LangChainAgentWorkflow({
              provider: config.provider,
              cwd: process.cwd(),
              maxIterations: config.maxIterations,
              providerType,
              model: config.model,
              sessionTracker,
            })
          : new AgentWorkflowV2({
              provider: config.provider,
              cwd: process.cwd(),
              maxIterations: config.maxIterations,
              providerType,
              model: config.model,
              sessionTracker,
            });

        await agent.initialize();

        const useTui =
          Boolean(process.stdout.isTTY && process.stdin.isTTY) &&
          process.env.MEER_NO_TUI !== "1";
        const pendingInputs: string[] = [];
        let queuedMessage: string | null = null;
        let pendingResolver: ((value: string) => void) | null = null;
        const enqueueInput = (value: string) => {
          if (pendingResolver) {
            const resolve = pendingResolver;
            pendingResolver = null;
            resolve(value);
          } else {
            pendingInputs.push(value);
          }
        };
        const chatUI = useTui
          ? new InkChatAdapter({
              provider: providerType,
              model: config.model,
              cwd: process.cwd(),
              uiSettings: config.ui,
            })
          : null;

        chatUI?.captureConsole();
        chatUI?.enableContinuousChat(enqueueInput);

        const handleExit = async () => {
          const finalStats = await sessionTracker.endSession();
          if (chatUI) {
            chatUI.appendSystemMessage("Session ended. Goodbye! 🌊");
            chatUI.destroy();
          } else {
            console.log("\n");
          }
          ChatBoxUI.displayGoodbye(finalStats);
          process.exit(0);
        };

        process.on("SIGINT", handleExit);
        process.on("SIGTERM", handleExit);

        const askQuestion = async (): Promise<string> => {
          if (queuedMessage !== null) {
            const next = queuedMessage;
            queuedMessage = null;
            return next;
          }

          if (chatUI) {
            if (pendingInputs.length > 0) {
              return pendingInputs.shift() as string;
            }
            return new Promise<string>((resolve) => {
              pendingResolver = resolve;
            });
          }
          return ChatBoxUI.handleInput({
            provider: providerType,
            model: config.model,
            cwd: process.cwd(),
          });
        };

        let exitRequested = false;

        while (!exitRequested && !restarting) {
          if (!chatUI) {
            ChatBoxUI.renderStatusBar({
              provider: providerType,
              model: config.model,
              cwd: process.cwd(),
            });
          }

          const rawInput = await askQuestion();
          const userInput = rawInput.trim();

          if (!userInput) {
            continue;
          }

          const lowered = userInput.toLowerCase();
          if (lowered === "exit" || lowered === "quit") {
            if (chatUI) {
              chatUI.appendSystemMessage("Exiting chat session...");
            }
            exitRequested = true;
            break;
          }

          if (await isImageFileRequest(rawInput)) {
            if (chatUI) {
              chatUI.appendSystemMessage("Processing image command...");
            }
            await handleImageFileRequest(rawInput, config);
            if (!chatUI) {
              console.log("");
            }
            continue;
          }

          if (userInput.startsWith("/")) {
            if (chatUI) {
              chatUI.appendSystemMessage(userInput);
            }

            const runSlash = () =>
              handleSlashCommand(userInput, config, sessionTracker, chatUI);
            let slashResult: SlashCommandResult;
            if (chatUI) {
              const { result: capturedResult, stdout, stderr } =
                await chatUI.runWithTerminalCapture(runSlash);
              slashResult = capturedResult;

              const combinedOutput = `${stdout}${stderr}`.trim();
              if (combinedOutput.length > 0) {
                chatUI.appendSystemMessage(combinedOutput);
              }
            } else {
              slashResult = await runSlash();
            }

            if (slashResult.status === "exit") {
              exitRequested = true;
              break;
            }

            if (slashResult.status === "restart") {
              restarting = true;
              if (chatUI) {
                chatUI.appendSystemMessage("Reloading configuration...");
              } else {
                console.log(chalk.yellow("\n🔄 Reloading configuration...\n"));
              }
              break;
            }

            if (slashResult.status === "send") {
              queuedMessage = slashResult.message;
              if (!chatUI) {
                console.log(chalk.gray(`\n> ${slashResult.message}\n`));
              }
              continue;
            }

            if (!chatUI) {
              console.log("");
            }
            continue;
          }

          if (chatUI) {
            chatUI.appendUserMessage(userInput);
          }

          sessionTracker.trackMessage();

          const timeline: Timeline = chatUI
            ? chatUI.getTimelineAdapter()
            : new WorkflowTimeline();

          try {
            const messageStartTime = Date.now();

            await agent.processMessage(userInput, {
              timeline,
              onAssistantStart: chatUI
                ? () => chatUI.startAssistantMessage()
                : undefined,
              onAssistantChunk: chatUI
                ? (chunk: string) => chatUI.appendAssistantChunk(chunk)
                : undefined,
              onAssistantEnd: chatUI
                ? () => chatUI.finishAssistantMessage()
                : undefined,
              withTerminal: chatUI
                ? <T>(fn: () => Promise<T>) => chatUI.runWithTerminal(fn)
                : undefined,
              promptChoice: chatUI
                ? (
                    prompt: string,
                    choices: Array<{ label: string; value: string }>,
                    defaultValue: string
                  ) => chatUI.promptChoice(prompt, choices, defaultValue)
                : undefined,
            });

            sessionTracker.trackApiCall(Date.now() - messageStartTime);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (chatUI) {
              chatUI.appendSystemMessage(`❌ ${message}`);
            } else {
              console.log(chalk.red("\n❌ Error:"), message);
            }
          } finally {
            timeline.close();
          }

          if (!chatUI) {
            console.log("\n");
          }
        }

        process.off("SIGINT", handleExit);
        process.off("SIGTERM", handleExit);

        const finalStats = await sessionTracker.endSession();

        if (chatUI) {
          chatUI.destroy();
        }

        if (!restarting) {
          ChatBoxUI.displayGoodbye(finalStats);
          break;
        }
      } catch (error) {
        console.error(error);
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
