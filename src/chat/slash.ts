/**
 * Slash command dispatch and built-in command handlers.
 * Extracted from cli.ts to keep the main orchestrator lean.
 */

import type { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname, resolve as resolvePath } from "path";
import { homedir } from "os";
import { createAskCommand } from "../commands/ask.js";
import { createCommitMsgCommand } from "../commands/commitMsg.js";
import { createReviewCommand } from "../commands/review.js";
import { createMemoryCommand } from "../commands/memory.js";
import { createSetupCommand } from "../commands/setup.js";
import { createMCPCommand } from "../commands/mcp.js";
import { createLoginCommand } from "../commands/login.js";
import { createLogoutCommand } from "../commands/logout.js";
import { createWhoamiCommand } from "../commands/whoami.js";
import { createIndexCommand } from "../commands/indexCmd.js";
import { createAgentsCommand } from "../commands/agents.js";
import { handleVersion } from "../commands/version.js";
import type { SessionTracker } from "../session/tracker.js";
import { ChatBoxUI } from "../ui/chatbox.js";
import { showSlashHelp } from "../ui/slashHelp.js";
import { runCommand } from "../tools/index.js";
import { memory } from "../memory/index.js";
import { generateCompactionSummaryWithProvider } from "../agent/session-compaction.js";
import {
  resolveCustomCommand,
  getSlashCommandErrors,
} from "../slash/registry.js";
import type { SlashCommandDefinition } from "../slash/schema.js";
import { renderSlashTemplate } from "../slash/template.js";
import type { InkChatAdapter, UITimelineEvent } from "../ui/ink/index.js";
import type { AgentEventRecorder } from "../agent/eventRecorder.js";
import { backgroundTerminals } from "../runtime/backgroundTerminals.js";
import { loadSkillsForCwd } from "../skills/index.js";
import type { SkillDiagnostic } from "../skills/index.js";
import { getDiagnostics } from "../utils/diagnostics.js";
import { spawnSync } from "child_process";
import { writeClipboardText } from "../utils/clipboard-write.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type SlashCommandResult =
  | { status: "continue" }
  | { status: "restart"; resumeSession?: string }
  | { status: "exit" }
  | { status: "send"; message: string };

interface SlashCommandContext {
  args: string[];
  argsText: string;
  rawInput: string;
  config: any;
  sessionTracker?: SessionTracker;
  tui?: InkChatAdapter | null;
  eventRecorder?: AgentEventRecorder | null;
}

type SlashCommandHandler = (
  context: SlashCommandContext
) => Promise<SlashCommandResult>;

// ─── Result helpers ───────────────────────────────────────────────────────────

const SLASH_CONTINUE: SlashCommandResult = { status: "continue" };
const SLASH_RESTART: SlashCommandResult = { status: "restart" };
const SLASH_EXIT: SlashCommandResult = { status: "exit" };

const continueResult = (): SlashCommandResult => SLASH_CONTINUE;
const restartResult = (): SlashCommandResult => SLASH_RESTART;
const restartWithResumeResult = (resumeSession: string): SlashCommandResult => ({
  status: "restart",
  resumeSession,
});
const exitResult = (): SlashCommandResult => SLASH_EXIT;

// ─── Input parsing ────────────────────────────────────────────────────────────

export function parseSlashInput(input: string): {
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

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && quote === '"' && i + 1 < input.length) {
        current += input[++i];
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
  if (current.length > 0) tokens.push(current);
  return tokens;
}

// ─── Sub-command runner ───────────────────────────────────────────────────────

export async function runStandaloneCommand(
  factory: () => Command,
  args: string[] = [],
  tui?: InkChatAdapter | null
): Promise<void> {
  const showError = (msg: string) => {
    const clean = msg.trim();
    if (tui) {
      tui.appendSystemMessage(`❌ ${clean}`);
    } else {
      console.log(chalk.red(`\n❌ ${clean}\n`));
    }
  };

  const run = async () => {
    const command = factory();
    command.exitOverride();
    command.configureOutput({
      writeOut: (str) => process.stdout.write(str),
      writeErr: (str) => process.stderr.write(str),
      outputError: (str, write) => write(chalk.red(str)),
    });
    await command.parseAsync(args, { from: "user" });
  };

  try {
    if (tui) {
      await tui.runWithTerminal(run);
    } else {
      await run();
    }
  } catch (error) {
    const err = error as { code?: string; exitCode?: number; message?: string };
    // Commander's help/version display — not an error
    if (
      err?.code === "commander.helpDisplayed" ||
      err?.code === "commander.version"
    ) {
      return;
    }
    // Commander's exitOverride — exit code 0 means success
    if (typeof err?.exitCode === "number" && err.exitCode === 0) {
      return;
    }
    // All other errors (including explicit throws from action handlers)
    showError(err?.message ?? String(error));
  }
}

// ─── Timeline helpers ─────────────────────────────────────────────────────────

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

const parseToggleMode = (value?: string): ToggleMode | null => {
  if (!value) return null;
  const n = value.toLowerCase();
  if (n === "on" || n === "off" || n === "auto") return n;
  return null;
};

const ensureTui = (
  context: SlashCommandContext,
  feature: string
): InkChatAdapter | null => {
  if (context.tui) return context.tui;
  console.log(
    chalk.yellow(
      `${feature} is only available in the interactive TUI. Re-run Meer without disabling the TUI to use this command.`
    )
  );
  return null;
};

function formatTimelineClock(ts: number): string {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

function formatTimelineEventLine(event: UITimelineEvent): string {
  const clock = chalk.gray(formatTimelineClock(event.timestamp));
  if (event.type === "queue") {
    const icon = event.action === "queued" ? "↳" : "↱";
    const color = event.action === "queued" ? chalk.magenta : chalk.cyan;
    const mode = event.mode === "followUp" ? "follow-up" : "steer";
    const counts =
      event.pendingSteering + event.pendingFollowUp > 0
        ? chalk.gray(
            ` — ${event.pendingSteering} steer, ${event.pendingFollowUp} follow-up pending`
          )
        : "";
    return `${clock} ${color(icon)} ${chalk.white(
      `${event.action === "queued" ? "Queued" : "Delivered"} ${mode}: ${event.message}`
    )}${counts}`;
  }
  if (event.type === "task") {
    let icon = "⏳";
    let color = chalk.cyan;
    if (event.status === "succeeded") { icon = "✔"; color = chalk.green; }
    else if (event.status === "failed") { icon = "✖"; color = chalk.red; }
    else if (event.status === "updated") { icon = "…"; color = chalk.blue; }
    const detail =
      event.detail?.trim()
        ? chalk.gray(` — ${event.detail.trim()}`)
        : "";
    return `${clock} ${color(icon)} ${chalk.white(event.label)}${detail}`;
  }
  let icon = "ℹ";
  let color = chalk.cyan;
  if (event.level === "warn") { icon = "⚠"; color = chalk.yellow; }
  else if (event.level === "error") { icon = "✖"; color = chalk.red; }
  else if (event.level === "note") { icon = "📝"; color = chalk.magenta; }
  return `${clock} ${color(icon)} ${chalk.white(event.message)}`;
}

function printTimelinePreview(events: UITimelineEvent[], limit = 10): void {
  const visible = events.slice(-limit);
  console.log(
    chalk.bold.cyan(
      `\nTimeline — showing last ${visible.length} of ${events.length} events:\n`
    )
  );
  visible.forEach((e) => console.log(formatTimelineEventLine(e)));
  console.log("");
}

function prepareTimelineOutputPath(requested?: string): string {
  if (requested?.trim()) {
    const resolved = resolvePath(process.cwd(), requested);
    mkdirSync(dirname(resolved), { recursive: true });
    return resolved;
  }
  const logsDir = join(homedir(), ".meer", "logs");
  mkdirSync(logsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(logsDir, `timeline-${ts}.json`);
}

function formatSkillDiagnostic(diagnostic: SkillDiagnostic): string {
  return `${diagnostic.source}:${diagnostic.code} ${diagnostic.path} - ${diagnostic.message}`;
}

async function handleSkillsCommand(tui?: InkChatAdapter | null): Promise<void> {
  const result = await loadSkillsForCwd(process.cwd());
  const lines: string[] = [];
  lines.push(`Skills: ${result.skills.length}`);

  if (result.sources.length > 0) {
    lines.push(`Sources: ${result.sources.join(", ")}`);
  } else {
    lines.push("Sources: none found (.meer/skills, ~/.meer/skills)");
  }

  if (result.skills.length > 0) {
    lines.push("");
    for (const skill of result.skills) {
      const hidden = skill.disableModelInvocation ? " hidden" : "";
      lines.push(`- ${skill.name} [${skill.source}${hidden}]`);
      lines.push(`  ${skill.description}`);
      lines.push(`  ${skill.filePath}`);
    }
  }

  if (result.diagnostics.length > 0) {
    lines.push("");
    lines.push(`Warnings: ${result.diagnostics.length}`);
    for (const diagnostic of result.diagnostics.slice(0, 8)) {
      lines.push(`- ${formatSkillDiagnostic(diagnostic)}`);
    }
    if (result.diagnostics.length > 8) {
      lines.push(`- ... ${result.diagnostics.length - 8} more`);
    }
  }

  const output = lines.join("\n");
  if (tui) tui.appendSystemMessage(output);
  else console.log(output);
}

// ─── Inline command implementations ──────────────────────────────────────────

/**
 * Parse a token-budget input like "100k", "1.5M", or "250000" into an
 * integer count. Returns null for malformed input so the caller can print
 * usage. Negative or zero values also return null (use /budget unset
 * to disable).
 */
export function parseTokenBudget(input: string): number | null {
  if (!input) return null;
  const trimmed = input.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)([kKmM])?$/);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const suffix = (match[2] ?? "").toLowerCase();
  const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  return Math.round(value * multiplier);
}

/**
 * Build a self-contained diagnostics dump for bug reports. Writes JSON to
 * ~/.meer/diagnostics-<timestamp>.json with runtime info, recent recorded
 * errors, and environment capabilities. Also tries to copy the path to the
 * clipboard (best-effort, platform-dependent) so users can paste it
 * straight into an issue.
 *
 * Intentionally avoids exposing secrets: no API keys, no env vars beyond a
 * curated allowlist of capability checks.
 */
async function writeDiagnosticsDump(args: {
  config: any;
  tui?: InkChatAdapter | null;
}): Promise<{ path: string; copied: boolean }> {
  const { config, tui } = args;
  const tsLabel = new Date().toISOString().replace(/[:.]/g, "-");
  const dumpDir = join(homedir(), ".meer");
  mkdirSync(dumpDir, { recursive: true });
  const dumpPath = join(dumpDir, `diagnostics-${tsLabel}.json`);

  const recentDiagnostics = getDiagnostics(50);
  const recentTimeline =
    tui
      ?.getTimelineEvents?.(50)
      ?.map((event) => ({ ...event, timestamp: event.timestamp })) ?? [];

  const payload = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    process: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      cwd: process.cwd(),
      uptimeSeconds: Math.round(process.uptime()),
      memory: process.memoryUsage(),
    },
    config: {
      provider:
        config && typeof config === "object" && "providerType" in config
          ? (config as { providerType?: unknown }).providerType
          : undefined,
      model:
        config && typeof config === "object" && "model" in config
          ? (config as { model?: unknown }).model
          : undefined,
      hasApiKey:
        config && typeof config === "object" && "apiKey" in config
          ? Boolean((config as { apiKey?: unknown }).apiKey)
          : undefined,
    },
    capabilities: {
      tty: Boolean(process.stdout.isTTY),
      columns: process.stdout.columns ?? null,
      rows: process.stdout.rows ?? null,
      colorDepth:
        typeof process.stdout.getColorDepth === "function"
          ? process.stdout.getColorDepth()
          : null,
    },
    recentTimeline,
    recentDiagnostics,
  };

  writeFileSync(dumpPath, JSON.stringify(payload, null, 2));

  // Best-effort: copy the path (not the contents) to clipboard so the user
  // has it ready to paste into a bug report. Failures are silent.
  const copied = writeClipboardText(dumpPath);

  return { path: dumpPath, copied };
}

async function handleAccountCommand(): Promise<void> {
  const { AuthStorage } = await import("../auth/storage.js");
  const { fetchCurrentSubscription, formatUsd, hasMeerCredentials } =
    await import("../auth/subscription.js");
  const authStorage = new AuthStorage();
  const user = authStorage.getUser();
  const hasCredentials = await hasMeerCredentials();

  if (!authStorage.isAuthenticated() && !hasCredentials) {
    console.log(chalk.yellow("\n⚠️  Not logged in"));
    console.log(
      chalk.gray("   Run ") +
        chalk.cyan("meer login") +
        chalk.gray(" to authenticate, or configure a Meer API key with ") +
        chalk.cyan("meer setup")
    );
    console.log("");
    return;
  }

  const subscription = await fetchCurrentSubscription();
  if (!user && !subscription) {
    console.log(chalk.yellow("\n⚠️  No account information found"));
    console.log(chalk.gray('   Check your Meer API key or run "meer login"\n'));
    return;
  }

  const planName =
    subscription?.plan.display_name || user?.subscription_tier.toUpperCase() || "Unknown";

  console.log(chalk.bold.blue("\n👤 Account Information\n"));
  if (user) {
    console.log(chalk.white("   Name:") + "          " + chalk.cyan(user.name));
    console.log(
      chalk.white("   Email:") + "         " + chalk.gray(user.email)
    );
    console.log(chalk.white("   ID:") + "            " + chalk.dim(user.id));
  } else {
    console.log(chalk.white("   Auth:") + "          " + chalk.gray("Meer API key"));
  }
  console.log(
    chalk.white("   Plan:") +
      "  " +
      chalk.yellow(planName)
  );
  if (subscription?.limits) {
    console.log(
      chalk.white("   Limits:") +
        "        " +
        chalk.gray(
          `${formatUsd(subscription.limits["5h"]?.limit_usd)} / 5h, ` +
            `${formatUsd(subscription.limits.weekly?.limit_usd)} / week, ` +
            `${formatUsd(subscription.limits.monthly?.limit_usd)} / month`
        )
    );
  }
  if (user?.avatar_url) {
    console.log(
      chalk.white("   Avatar:") + "        " + chalk.blue(user.avatar_url)
    );
  }

  if (user?.created_at) {
    const memberSince = new Date(user.created_at).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    console.log(
      chalk.white("   Member since:") + "  " + chalk.gray(memberSince)
    );
  }

  console.log("");
  console.log(chalk.bold.white("   Benefits:"));
  if (subscription?.plan.name === "starter") {
    console.log(chalk.green("   ✓ Starter hosted coding models"));
    console.log(chalk.green("   ✓ GLM, Kimi, MiniMax, Qwen, DeepSeek, MiMo"));
    console.log(chalk.green("   ✓ Rolling 5-hour, weekly, and monthly limits"));
    console.log(chalk.green("   ✓ Usage analytics"));
  } else if (subscription?.plan.name === "pro") {
    console.log(chalk.green("   ✓ Pro hosted coding models"));
    console.log(chalk.green("   ✓ Claude, GPT, Gemini, and Starter models"));
    console.log(chalk.green("   ✓ Higher rolling cost limits"));
    console.log(chalk.green("   ✓ Usage analytics"));
  } else if (user?.subscription_tier === "free") {
    console.log(chalk.gray("   • Basic features"));
    console.log(chalk.gray("   • Local model support"));
    console.log(chalk.gray("   • Session history"));
    console.log("");
    console.log(chalk.yellow("   💡 Upgrade to unlock:"));
    console.log(chalk.gray("   • Cloud sync across devices"));
    console.log(chalk.gray("   • Priority support"));
    console.log(chalk.gray("   • Advanced features"));
  } else if (user?.subscription_tier === "pro") {
    console.log(chalk.green("   ✓ All basic features"));
    console.log(chalk.green("   ✓ Cloud sync"));
    console.log(chalk.green("   ✓ Priority support"));
    console.log(chalk.green("   ✓ Advanced features"));
  } else if (user?.subscription_tier === "enterprise") {
    console.log(chalk.cyan("   ✓ All Pro features"));
    console.log(chalk.cyan("   ✓ Team collaboration"));
    console.log(chalk.cyan("   ✓ Custom integrations"));
    console.log(chalk.cyan("   ✓ Dedicated support"));
  }

  console.log("");
  console.log(
    chalk.gray("   Commands: ") +
      chalk.cyan("meer whoami") +
      chalk.gray(" | ") +
      chalk.cyan("meer logout")
  );
  console.log("");
}

async function promptResumeSession(
  tui?: InkChatAdapter | null
): Promise<string | null> {
  const sessions = memory.listSessions(process.cwd()).slice(0, 20);
  if (sessions.length === 0) {
    const msg = "No saved sessions for this project.";
    if (tui) tui.appendSystemMessage(msg);
    else console.log(chalk.gray(msg));
    return null;
  }

  const choices = sessions.map((session) => {
    const parent = session.parentSessionId
      ? ` ← fork of ${session.parentSessionId.slice(0, 8)}`
      : "";
    return {
      label:
        `${session.id.slice(0, 8)} ` +
        `(${session.messageCount} msgs • ${new Date(session.createdAt).toLocaleString()})` +
        parent,
      value: session.path,
    };
  });

  if (tui) {
    choices.push({ label: "Cancel", value: "__cancel__" });
    const selected = await tui.promptChoice(
      "Resume which session?",
      choices,
      choices[0]?.value ?? "__cancel__"
    );
    return selected === "__cancel__" ? null : selected;
  }

  const promptModule = inquirer.createPromptModule();
  const { selectedSession } = await promptModule([
    {
      type: "list",
      name: "selectedSession",
      message: "Resume which session?",
      choices: [
        ...choices.map((choice) => ({
          name: choice.label,
          value: choice.value,
        })),
        new inquirer.Separator(),
        { name: chalk.gray("Cancel"), value: null },
      ],
    },
  ]);
  return selectedSession;
}

async function handleInitCommand(): Promise<void> {
  const { writeFileSync, existsSync } = await import("fs");
  const { join } = await import("path");

  const projectName = process.cwd().split(/[\\/]/).pop() || "My Project";
  const agentsContent = `# AI Agent Configuration

This file helps AI models understand your project structure and coding preferences.

## Project Overview
- **Name**: ${projectName}
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
*Generated by Meer CLI*
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
    console.log(chalk.gray("This file helps AI understand your project better"));
    console.log(
      chalk.cyan("Edit it to customize AI behavior for your project")
    );
  } catch (error) {
    console.log(chalk.red("❌ Failed to create AGENTS.md:"), error);
  }
}

async function handleModelCommand(config: any, tui?: InkChatAdapter | null): Promise<void> {
  try {
    const provider = config.provider;

    if (!(provider.listModels && typeof provider.listModels === "function")) {
      const msg = "⚠️  Current provider does not support model listing\nAvailable for: Ollama, OpenAI-compatible providers";
      if (tui) { tui.appendSystemMessage(msg); } else { console.log(chalk.yellow(msg)); }
      return;
    }

    if (!tui) {
      ora(chalk.blue("Fetching available models...")).start().stop();
    }
    let models: any[];

    try {
      models = await provider.listModels();
    } catch (error) {
      const msg = `❌ Failed to fetch models: ${error instanceof Error ? error.message : String(error)}`;
      if (tui) { tui.appendSystemMessage(msg); } else { console.log(chalk.red(msg)); }
      return;
    }

    if (models.length === 0) {
      const msg = "⚠️  No models found";
      if (tui) { tui.appendSystemMessage(msg); } else { console.log(chalk.yellow(msg)); }
      return;
    }

    const currentModel: string = provider.getCurrentModel
      ? provider.getCurrentModel()
      : config.model;

    let selectedModel: string | null;

    if (tui) {
      const choices = models.map((model: any) => {
        const displayName = model.name || model;
        const modelId: string = model.id || model.name || model;
        return {
          label: modelId === currentModel ? `${displayName} (current)` : displayName,
          value: modelId,
        };
      });
      choices.push({ label: "Cancel", value: "__cancel__" });
      const picked = await tui.promptChoice("Select a model:", choices, currentModel);
      selectedModel = picked === "__cancel__" ? null : picked;
    } else {
      console.log(chalk.bold.blue("\n📦 Available Models:\n"));
      const choices = models.map((model: any) => {
        const displayName = model.name || model;
        const modelId = model.id || model.name || model;
        const isCurrent = modelId === currentModel;
        return {
          name: isCurrent ? `${displayName} ${chalk.green("(current)")}` : displayName,
          value: modelId,
        };
      });
      const promptModule = inquirer.createPromptModule();
      const { selectedModel: picked } = await promptModule([
        {
          type: "list",
          name: "selectedModel",
          message: "Select a model:",
          choices: [...choices, new inquirer.Separator(), { name: chalk.gray("Cancel"), value: null }],
        },
      ]);
      selectedModel = picked;
    }

    if (!selectedModel) {
      const msg = "Cancelled";
      if (tui) { tui.appendSystemMessage(msg); } else { console.log(chalk.gray("\nCancelled\n")); }
      return;
    }

    if (selectedModel === currentModel) {
      const msg = "No change — already using this model";
      if (tui) { tui.appendSystemMessage(msg); } else { console.log(chalk.gray("\nNo change — already using this model\n")); }
      return;
    }

    if (provider.switchModel && typeof provider.switchModel === "function") {
      provider.switchModel(selectedModel);
      const successMsg = `✅ Switched to model: ${selectedModel}`;
      if (tui) { tui.appendSystemMessage(successMsg); } else { console.log(chalk.green(`\n${successMsg}\n`)); }

      try {
        const { readFileSync, writeFileSync, existsSync } = await import("fs");
        const configPath = join(homedir(), ".meer", "config.yaml");
        const yaml = await import("yaml");

        if (existsSync(configPath)) {
          const fullConfig = yaml.parse(readFileSync(configPath, "utf-8"));
          fullConfig.model = selectedModel;
          writeFileSync(configPath, yaml.stringify(fullConfig), "utf-8");
          const persistMsg = "Configuration updated in config.yaml";
          if (tui) { tui.appendSystemMessage(persistMsg); } else { console.log(chalk.gray(persistMsg + "\n")); }
        } else {
          const warnMsg = "⚠️  Config file not found, model changed for this session only";
          if (tui) { tui.appendSystemMessage(warnMsg); } else { console.log(chalk.yellow(warnMsg + "\n")); }
        }
      } catch {
        const warnMsg = "⚠️  Could not persist model change to config file";
        if (tui) { tui.appendSystemMessage(warnMsg); } else { console.log(chalk.yellow(warnMsg + "\n")); }
      }
    } else {
      const msg = "⚠️  Provider does not support model switching";
      if (tui) { tui.appendSystemMessage(msg); } else { console.log(chalk.yellow(msg)); }
    }
  } catch (error) {
    const msg = `❌ Error: ${error instanceof Error ? error.message : String(error)}`;
    if (tui) { tui.appendSystemMessage(msg); } else { console.log(chalk.red(msg)); }
  }
}

async function handleProviderCommand(tui?: InkChatAdapter | null): Promise<void> {
  try {
    const { readFileSync, writeFileSync, existsSync } = await import("fs");
    const configPath = join(homedir(), ".meer", "config.yaml");

    if (!existsSync(configPath)) {
      const msg = "❌ Config file not found";
      if (tui) { tui.appendSystemMessage(msg); } else { console.log(chalk.red(msg)); }
      return;
    }

    const yaml = await import("yaml");
    const config = yaml.parse(readFileSync(configPath, "utf-8"));
    const currentProvider = config.provider || "ollama";

    const providers = [
      { name: "meer", icon: "🌊", label: "Meer Managed" },
      { name: "ollama", icon: "🦙", label: "Ollama (Local)" },
      { name: "openai", icon: "🤖", label: "OpenAI" },
      { name: "gemini", icon: "✨", label: "Google Gemini" },
      { name: "anthropic", icon: "🧠", label: "Anthropic Claude" },
      { name: "openrouter", icon: "🌐", label: "OpenRouter" },
      { name: "zaiCodingPlan", icon: "⚡", label: "Z.ai Coding Plan" },
      { name: "zaiCredit", icon: "⚡", label: "Z.ai Credit (PAYG)" },
    ];

    const DEFAULT_MODELS: Record<string, string> = {
      openai: "gpt-4o",
      gemini: "gemini-2.0-flash-exp",
      ollama: "mistral:7b-instruct",
      anthropic: "claude-3-5-sonnet-20241022",
      openrouter: "anthropic/claude-3.5-sonnet",
      meer: "auto",
      zaiCodingPlan: "glm-4",
      zaiCredit: "glm-4",
    };

    let selectedProvider: string | null;

    if (tui) {
      const choices = providers.map((p) => ({
        label: p.name === currentProvider ? `${p.icon} ${p.label} (current)` : `${p.icon} ${p.label}`,
        value: p.name,
      }));
      choices.push({ label: "Cancel", value: "__cancel__" });
      const picked = await tui.promptChoice("Select a provider:", choices, currentProvider);
      selectedProvider = picked === "__cancel__" ? null : picked;
    } else {
      console.log(chalk.bold.blue("\n🔌 Available Providers:\n"));
      const choices = providers.map((p) => ({
        name: p.name === currentProvider
          ? `${p.icon} ${p.label} ${chalk.green("(current)")}`
          : `${p.icon} ${p.label}`,
        value: p.name,
      }));
      const promptModule = inquirer.createPromptModule();
      const { selectedProvider: picked } = await promptModule([
        {
          type: "list",
          name: "selectedProvider",
          message: "Select a provider:",
          choices: [...choices, new inquirer.Separator(), { name: chalk.gray("Cancel"), value: null }],
        },
      ]);
      selectedProvider = picked;
    }

    if (!selectedProvider) {
      const msg = "Cancelled";
      if (tui) { tui.appendSystemMessage(msg); } else { console.log(chalk.gray("\nCancelled\n")); }
      return;
    }

    if (selectedProvider === currentProvider) {
      const msg = "No change — already using this provider";
      if (tui) { tui.appendSystemMessage(msg); } else { console.log(chalk.gray("\nNo change — already using this provider\n")); }
      return;
    }

    config.provider = selectedProvider;
    if (DEFAULT_MODELS[selectedProvider]) {
      config.model = DEFAULT_MODELS[selectedProvider];
    }

    writeFileSync(configPath, yaml.stringify(config), "utf-8");

    const selected = providers.find((p) => p.name === selectedProvider);
    const successMsg = `✅ Switched to provider: ${selected?.label}\n   Default model: ${config.model}\n⚠️  Restarting to apply changes…`;
    if (tui) { tui.appendSystemMessage(successMsg); } else {
      console.log(chalk.green(`\n✅ Switched to provider: ${chalk.bold(selected?.label)}`));
      console.log(chalk.gray(`   Default model: ${config.model}`));
      console.log(chalk.yellow("\n⚠️  Please restart the CLI for changes to take effect\n"));
    }
  } catch (error) {
    const msg = `❌ Error: ${error instanceof Error ? error.message : String(error)}`;
    if (tui) { tui.appendSystemMessage(msg); } else { console.log(chalk.red(msg)); }
  }
}

async function handleSetupCommand(): Promise<void> {
  try {
    console.log(chalk.blue("\n🔧 Starting setup wizard...\n"));
    const { createSetupCommand } = await import("../commands/setup.js");
    const setupCmd = createSetupCommand();
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

// ─── Custom slash command executors ──────────────────────────────────────────

async function executePromptSlashCommand(
  definition: SlashCommandDefinition,
  context: SlashCommandContext
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

  const rendered = renderSlashTemplate(template, variables).trim();
  if (!rendered) {
    console.log(
      chalk.yellow(
        "Generated prompt is empty. Update the template or provide arguments."
      )
    );
    return continueResult();
  }
  return { status: "send", message: rendered };
}

async function executeShellSlashCommand(
  definition: SlashCommandDefinition,
  context: SlashCommandContext
): Promise<SlashCommandResult> {
  const baseFragments = [
    definition.action ?? "",
    ...(definition.args ?? []),
  ].filter(Boolean);

  const baseCommand = baseFragments.join(" ").trim();
  const fullCommand = context.argsText
    ? `${baseCommand}${baseCommand ? " " : ""}${context.argsText}`
    : baseCommand;

  if (!fullCommand) {
    console.log(
      chalk.red("Shell command configuration is missing the action to run.")
    );
    return continueResult();
  }

  const result = await runCommand(fullCommand, process.cwd());
  if (result.error) {
    console.log(chalk.red(`❌ ${result.error}`));
  }
  return continueResult();
}

async function executeMeerCliSlashCommand(
  definition: SlashCommandDefinition,
  context: SlashCommandContext
): Promise<SlashCommandResult> {
  if (!definition.action) {
    console.log(
      chalk.red("Meer CLI command configuration requires an action string.")
    );
    return continueResult();
  }

  const baseTokens = tokenizeCommandLine(definition.action);
  if (baseTokens.length === 0) {
    console.log(
      chalk.red(
        "Meer CLI command configuration did not provide a sub-command."
      )
    );
    return continueResult();
  }

  const subCommand = baseTokens[0];
  const factory = MEER_CLI_FACTORIES[subCommand];
  if (!factory) {
    console.log(
      chalk.yellow(
        `Unknown Meer CLI sub-command "${subCommand}". Update the action field.`
      )
    );
    return continueResult();
  }

  const combinedArgs = [
    ...baseTokens.slice(1),
    ...(definition.args ?? []),
    ...context.args,
  ];
  await runStandaloneCommand(factory, combinedArgs, context.tui);
  return continueResult();
}

async function executeCustomSlashCommand(
  definition: SlashCommandDefinition,
  context: SlashCommandContext
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
          `Unsupported slash command type "${(definition as any).type}". Update your configuration.`
        )
      );
      return continueResult();
  }
}

// ─── Built-in slash handlers ──────────────────────────────────────────────────

const builtInSlashHandlers: Record<string, SlashCommandHandler> = {
  "/ask": async ({ args, tui }) => {
    if (args.length === 0) {
      console.log(
        chalk.gray(
          "\nTip: use /ask <question>. Example: /ask What does main.ts do?\n"
        )
      );
      return continueResult();
    }
    await runStandaloneCommand(createAskCommand, args, tui);
    return continueResult();
  },

  "/commit-msg": async ({ args, tui }) => {
    await runStandaloneCommand(createCommitMsgCommand, args, tui);
    return continueResult();
  },

  "/index": async ({ args, tui }) => {
    await runStandaloneCommand(createIndexCommand, args, tui);
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

  "/resume": async ({ args, tui }) => {
    const requested = args[0];
    if (requested) {
      const source = memory.resolveSession(requested, process.cwd());
      if (!source) {
        const msg = `Could not find session '${requested}'.`;
        if (tui) tui.appendSystemMessage(`❌ ${msg}`);
        else console.log(chalk.red(msg));
        return continueResult();
      }
      const msg = `Resuming session ${source.id.slice(0, 8)}...`;
      if (tui) tui.appendSystemMessage(msg);
      else console.log(chalk.gray(msg));
      return restartWithResumeResult(source.path);
    }

    const selected = await promptResumeSession(tui);
    if (!selected) {
      const msg = "Resume cancelled.";
      if (tui) tui.appendSystemMessage(msg);
      else console.log(chalk.gray(msg));
      return continueResult();
    }

    const source = memory.resolveSession(selected, process.cwd());
    const msg = source
      ? `Resuming session ${source.id.slice(0, 8)}...`
      : "Resuming selected session...";
    if (tui) tui.appendSystemMessage(msg);
    else console.log(chalk.gray(msg));
    return restartWithResumeResult(selected);
  },

  "/stats": async ({ sessionTracker }) => {
    if (sessionTracker) {
      ChatBoxUI.displayStats(sessionTracker.getCurrentStats());
    } else {
      console.log(chalk.yellow("⚠️  Session tracking not available"));
    }
    return continueResult();
  },

  "/sessions": async () => {
    const sessions = memory.listSessions(process.cwd()).slice(0, 20);
    console.log(chalk.bold.blue("\n🗂️  Project Sessions:\n"));
    if (sessions.length === 0) {
      console.log(chalk.gray("  No saved sessions for this project.\n"));
      return continueResult();
    }

    sessions.forEach((session, index) => {
      const parent = session.parentSessionId
        ? chalk.gray(` ← fork of ${session.parentSessionId.slice(0, 8)}`)
        : "";
      console.log(
        `${chalk.cyan(`${index + 1}.`)} ${chalk.yellow(session.id.slice(0, 8))} ` +
          chalk.gray(`(${session.messageCount} msgs • ${new Date(session.createdAt).toLocaleString()})`) +
          parent
      );
    });
    console.log(
      chalk.gray(
        "\nUse `/resume` to continue one, or `meer --fork <id>` to branch from it.\n"
      )
    );
    return continueResult();
  },

  "/account": async () => {
    await handleAccountCommand();
    return continueResult();
  },

  "/login": async ({ args, tui }) => {
    await runStandaloneCommand(createLoginCommand, args, tui);
    return continueResult();
  },

  "/logout": async ({ args, tui }) => {
    await runStandaloneCommand(createLogoutCommand, args, tui);
    return continueResult();
  },

  "/mcp": async ({ args, tui }) => {
    await runStandaloneCommand(createMCPCommand, args, tui);
    return continueResult();
  },

  "/memory": async ({ args, tui }) => {
    await runStandaloneCommand(createMemoryCommand, args, tui);
    return continueResult();
  },

  "/model": async ({ config, tui }) => {
    await handleModelCommand(config, tui);
    return continueResult();
  },

  "/provider": async ({ tui }) => {
    await handleProviderCommand(tui);
    return restartResult();
  },

  "/ps": async ({ tui }) => {
    const sessions = backgroundTerminals.list();
    if (sessions.length === 0) {
      const message = "No background terminals.";
      if (tui) tui.appendSystemMessage(message);
      else console.log(chalk.gray(message));
      return continueResult();
    }

    const lines = [
      "Background terminals:",
      ...sessions.slice(0, 10).map((session) => {
        const ageSeconds = Math.max(
          0,
          Math.floor((Date.now() - session.startedAt) / 1000)
        );
        return `- ${session.id} [${session.status}] ${session.command} (${ageSeconds}s)`;
      }),
    ];
    if (tui) tui.appendSystemMessage(lines.join("\n"));
    else console.log(lines.join("\n"));
    return continueResult();
  },

  "/review": async ({ args, tui }) => {
    await runStandaloneCommand(createReviewCommand, args, tui);
    return continueResult();
  },

  "/setup": async () => {
    await handleSetupCommand();
    return restartResult();
  },

  "/skills": async ({ tui }) => {
    await handleSkillsCommand(tui);
    return continueResult();
  },

  "/screen-reader": async (context) => {
    const tui = ensureTui(context, "Screen reader mode");
    if (!tui) return continueResult();
    const mode = parseToggleMode(context.args[0]);
    if (!mode) {
      console.log(chalk.gray("Usage: /screen-reader <on|off|auto>"));
      return continueResult();
    }
    tui.setScreenReaderMode(mode);
    tui.appendSystemMessage(
      mode === "on"
        ? "Screen reader layout enabled."
        : mode === "off"
        ? "Screen reader layout disabled."
        : "Screen reader layout reset to config defaults."
    );
    return continueResult();
  },

  "/stop": async ({ args, tui }) => {
    const target = args[0];
    if (!target) {
      const usage = "Usage: /stop <background-terminal-id>";
      if (tui) tui.appendSystemMessage(usage);
      else console.log(chalk.gray(usage));
      return continueResult();
    }
    const stopped = backgroundTerminals.stop(target);
    const message = stopped
      ? `Stopping background terminal ${target}.`
      : `Background terminal ${target} not found or already exited.`;
    if (tui) tui.appendSystemMessage(message);
    else console.log(stopped ? chalk.green(message) : chalk.yellow(message));
    return continueResult();
  },

  "/alt-buffer": async (context) => {
    const tui = ensureTui(context, "Alternate buffer mode");
    if (!tui) return continueResult();
    const mode = parseToggleMode(context.args[0]);
    if (!mode) {
      console.log(chalk.gray("Usage: /alt-buffer <on|off|auto>"));
      return continueResult();
    }
    tui.setAlternateBufferMode(mode);
    tui.appendSystemMessage(
      mode === "on"
        ? "Alternate screen buffer enabled."
        : mode === "off"
        ? "Alternate screen buffer disabled."
        : "Alternate screen buffer reset to config defaults."
    );
    return continueResult();
  },

  "/timeline": async (context) => {
    const [actionArg, targetArg] = context.args;
    const action = actionArg ? actionArg.toLowerCase() : "show";
    const events =
      context.eventRecorder?.getTimelineEvents() ??
      context.tui?.getTimelineEvents() ??
      [];

    if (events.length === 0) {
      console.log(chalk.gray("Timeline is empty for this session."));
      return continueResult();
    }

    if (action === "show") {
      printTimelinePreview(events);
      return continueResult();
    }

    if (action === "save") {
      const outputPath = prepareTimelineOutputPath(targetArg);
      const payload = {
        generatedAt: new Date().toISOString(),
        cwd: process.cwd(),
        events,
        plan: context.eventRecorder?.getPlanSnapshot() ?? null,
      };
      writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf8");
      console.log(chalk.green(`Saved timeline to ${outputPath}`));
      return continueResult();
    }

    console.log(chalk.gray("Usage: /timeline [show|save [filename]]"));
    return continueResult();
  },

  "/version": async () => {
    await handleVersion();
    return continueResult();
  },

  "/whoami": async ({ args, tui }) => {
    await runStandaloneCommand(createWhoamiCommand, args, tui);
    return continueResult();
  },

  "/clear": async ({ tui }) => {
    if (tui) {
      tui.clearMessages();
      tui.appendSystemMessage("Conversation cleared.");
    } else {
      process.stdout.write("\x1b[2J\x1b[H");
    }
    return continueResult();
  },

  "/compact": async ({ tui, config }) => {
    const result = await memory.compactCurrentSession(process.cwd(), {
      summaryGenerator: (input) =>
        generateCompactionSummaryWithProvider(config.provider, input),
    });
    if (!result) {
      if (tui) {
        tui.appendSystemMessage("Nothing to compact yet.");
      } else {
        console.log(chalk.gray("Nothing to compact yet."));
      }
      return continueResult();
    }
    const kept = result.firstKeptTimestamp ? "recent messages kept" : "all prior context summarized";
    if (tui) {
      tui.appendSystemMessage(
        `Compacted ${result.summarizedMessageCount} messages into a session summary; ${kept}.`
      );
    } else {
      console.log(
        chalk.gray(
          `Compacted ${result.summarizedMessageCount} messages into a session summary; ${kept}.`
        )
      );
    }
    return continueResult();
  },

  "/budget": async ({ tui, sessionTracker, args }) => {
    const reportLine = (msg: string) => {
      if (tui) tui.appendSystemMessage(msg);
      else console.log(chalk.gray(msg));
    };

    if (!sessionTracker) {
      reportLine("Session tracker not available — /budget is a no-op.");
      return continueResult();
    }

    const sub = (args[0] ?? "").toLowerCase();

    if (sub === "set") {
      const raw = (args[1] ?? "").trim();
      const parsed = parseTokenBudget(raw);
      if (parsed === null) {
        reportLine(
          `Usage: /budget set <N>[k|M]   (e.g. "/budget set 100k", "/budget set 1.5M", or a raw integer)`
        );
        return continueResult();
      }
      sessionTracker.setMaxTokens(parsed);
      reportLine(
        `💰 Budget set to ${parsed.toLocaleString()} tokens. Current usage: ${sessionTracker
          .getTokenUsage()
          .total.toLocaleString()}.`
      );
      return continueResult();
    }

    if (sub === "unset" || sub === "clear" || sub === "off") {
      sessionTracker.setMaxTokens(undefined);
      reportLine("💰 Budget cleared. Token usage is now uncapped.");
      return continueResult();
    }

    // No args (or unknown) → show status.
    const usage = sessionTracker.getTokenUsage();
    const cap = sessionTracker.getMaxTokens();
    if (!cap) {
      reportLine(
        `💰 No budget set. Used ${usage.total.toLocaleString()} tokens this session. Run "/budget set 100k" to enable a cap.`
      );
    } else {
      const remaining = sessionTracker.getRemainingBudget();
      const pct = Math.round((usage.total / cap) * 100);
      reportLine(
        `💰 Budget: ${usage.total.toLocaleString()} / ${cap.toLocaleString()} tokens (${pct}%) — ${remaining.toLocaleString()} remaining.`
      );
    }
    return continueResult();
  },

  "/copy": async ({ tui }) => {
    if (!tui) {
      console.log(
        chalk.yellow(
          "/copy needs the interactive TUI to find the last assistant message."
        )
      );
      return continueResult();
    }
    const content = tui.getLastAssistantContent();
    if (!content) {
      tui.appendSystemMessage("Nothing to copy yet — no assistant message in this session.");
      return continueResult();
    }
    const ok = writeClipboardText(content);
    if (ok) {
      const preview = content.replace(/\s+/g, " ").trim();
      const summary =
        preview.length > 60 ? `${preview.slice(0, 57)}…` : preview;
      tui.appendSystemMessage(
        `Copied last assistant message to clipboard (${content.length} chars): ${summary}`
      );
    } else {
      tui.appendSystemMessage(
        `Couldn't write to clipboard. On Linux install \`wl-clipboard\` or \`xclip\`; on macOS \`pbcopy\` is built in.`
      );
    }
    return continueResult();
  },

  "/diagnose": async ({ tui, config }) => {
    const result = await writeDiagnosticsDump({ config, tui });
    if (tui) {
      tui.appendSystemMessage(
        `Diagnostics written to ${result.path}${result.copied ? " (also on clipboard)" : ""}`
      );
    } else {
      console.log(
        chalk.gray(
          `Diagnostics written to ${result.path}${result.copied ? " (also on clipboard)" : ""}`
        )
      );
    }
    return continueResult();
  },

  "/exit": async () => {
    console.log(chalk.gray("Exiting chat session..."));
    return exitResult();
  },
};

// ─── Main dispatch ────────────────────────────────────────────────────────────

export async function handleSlashCommand(
  command: string,
  config: any,
  sessionTracker?: SessionTracker,
  tui?: InkChatAdapter | null,
  eventRecorder?: AgentEventRecorder | null
): Promise<SlashCommandResult> {
  const { command: name, args, argsText } = parseSlashInput(command);
  const context: SlashCommandContext = {
    args,
    argsText,
    rawInput: command,
    config,
    sessionTracker,
    tui,
    eventRecorder,
  };

  const handler = builtInSlashHandlers[name];
  if (handler) return handler(context);

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
        `${name} is reserved by Meer. Set override: true in your configuration to replace the built-in command.`
      )
    );
    return continueResult();
  }

  return executeCustomSlashCommand(resolved.definition, context);
}
