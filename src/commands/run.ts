import { Command } from "commander";
import { readFileSync } from "fs";
import chalk from "chalk";
import { loadConfig } from "../config.js";

/**
 * `meer run` — non-interactive agentic execution.
 *
 * Designed for headless environments (CI, cloud sandboxes). Reads a prompt,
 * runs the structured agent loop with auto-approval, streams tool activity
 * and assistant text as plain stdout lines, and exits with a status code.
 *
 *   meer run "add a TODO to README.md explaining the project"
 *   meer run --file ./PROMPT.txt --yes --max-steps 30
 *   meer run --model anthropic/claude-3.5-sonnet --yes "fix the failing tests"
 *
 * Auto-approval policy when `--yes` is set:
 *   • File edits apply without prompting (MeerAgent already does this when
 *     no `promptChoice` callback is supplied).
 *   • Shell commands are filtered through MeerAgent's built-in safe/blocked
 *     pattern list (blocks rm -rf, mkfs, shutdown, etc.; auto-approves
 *     read-only and standard dev commands).
 *
 * Exit codes:
 *   0   — agent completed without throwing
 *   1   — hard failure (config, init, or unhandled agent error)
 *   130 — interrupted (SIGINT)
 */
export function createRunCommand(): Command {
  const command = new Command("run");

  command
    .description(
      "Run the agent non-interactively against a single prompt (cloud / CI mode)"
    )
    .argument("[prompt...]", "Prompt for the agent (omit if using --file)")
    .option(
      "-f, --file <path>",
      "Read the prompt from a file instead of positional args"
    )
    .option(
      "-y, --yes",
      "Auto-approve file edits and non-destructive shell commands",
      false
    )
    .option(
      "--max-steps <n>",
      "Maximum agent loop iterations",
      (value) => parseInt(value, 10),
      50
    )
    .option(
      "--model <id>",
      "Override the model id for this run (e.g. anthropic/claude-3.5-sonnet)"
    )
    .option(
      "--cwd <path>",
      "Working directory for the agent (defaults to process.cwd())"
    )
    .option(
      "-v, --verbose",
      "Also print chain-of-thought / reasoning lines",
      false
    )
    .option("--json", "Emit newline-delimited JSON events on stdout", false)
    .action(async (promptParts: string[], options: RunOptions) => {
      try {
        const exitCode = await runAgent(promptParts, options);
        process.exit(exitCode);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        if (options.json) {
          emitJson({ type: "run.error", message });
          emitJson({ type: "run.completed", exitCode: 1 });
        }
        process.stderr.write(`! error: ${message}\n`);
        process.exit(1);
      }
    });

  return command;
}

interface RunOptions {
  file?: string;
  yes?: boolean;
  maxSteps?: number;
  model?: string;
  cwd?: string;
  verbose?: boolean;
  json?: boolean;
}

async function runAgent(
  promptParts: string[],
  options: RunOptions
): Promise<number> {
  const prompt = resolvePrompt(promptParts, options.file);
  if (!prompt) {
    if (options.json) {
      emitJson({
        type: "run.error",
        message: "No prompt provided. Pass it as arguments or use --file <path>.",
      });
      emitJson({ type: "run.completed", exitCode: 1 });
    }
    process.stderr.write(
      "! error: no prompt provided. Pass it as arguments or use --file <path>.\n"
    );
    return 1;
  }

  if (!options.yes) {
    if (options.json) {
      emitJson({
        type: "run.error",
        message:
          "meer run requires --yes (auto-approval) for now. Interactive approval is not yet supported in headless mode.",
      });
      emitJson({ type: "run.completed", exitCode: 1 });
    }
    process.stderr.write(
      "! error: meer run requires --yes (auto-approval) for now. Interactive\n" +
        "  approval is not yet supported in headless mode.\n"
    );
    return 1;
  }

  const config = loadConfig();

  if (options.model) {
    // ProviderWrapper / individual providers honor the current model field;
    // most provider implementations also expose it on `provider.model`.
    const providerWithModel = config.provider as { model?: string };
    if (providerWithModel && typeof providerWithModel === "object") {
      providerWithModel.model = options.model;
    }
    config.model = options.model;
  }

  const cwd = options.cwd ?? process.cwd();
  const isJson = options.json === true;
  if (isJson) {
    emitJson({
      type: "run.started",
      provider: config.providerType,
      model: config.model,
      cwd,
      maxSteps: options.maxSteps,
    });
  } else {
    process.stdout.write(
      `[run] provider=${config.providerType} model=${config.model} cwd=${cwd}\n`
    );
    process.stdout.write(`[run] max-steps=${options.maxSteps}\n`);
  }

  const { MeerAgent } = await import("../agent/meer-agent.js");

  const agent = new MeerAgent({
    provider: config.provider,
    cwd,
    maxIterations: options.maxSteps,
    enableMemory: false,
    autoCollectContext: true,
    providerType: config.providerType,
    model: config.model,

    // Plain stdout streaming. No Ink, no fancy UI.
    onStreamingStart: () => {
      if (isJson) {
        emitJson({ type: "assistant.started" });
        return;
      }
      process.stdout.write(`\n${chalk.bold("assistant:")} `);
    },
    onStreamingChunk: (chunk) => {
      if (isJson) {
        emitJson({ type: "assistant.delta", delta: chunk });
        return;
      }
      process.stdout.write(chunk);
    },
    onStreamingEnd: () => {
      if (isJson) {
        emitJson({ type: "assistant.completed" });
        return;
      }
      process.stdout.write("\n");
    },
    onAssistantMessage: (content) => {
      if (isJson) {
        if (content?.trim()) {
          emitJson({ type: "assistant.message", content });
        }
        return;
      }
      if (content?.trim()) {
        process.stdout.write(`\n${chalk.bold("assistant:")} ${content}\n`);
      }
    },
    onCotMessage: (content) => {
      if (isJson) {
        if (options.verbose && content?.trim()) {
          emitJson({ type: "reasoning.message", content });
        }
        return;
      }
      if (options.verbose && content?.trim()) {
        process.stdout.write(chalk.gray(`[thinking] ${content}\n`));
      }
    },
    onToolStart: (tool, args) => {
      if (isJson) {
        emitJson({ type: "tool.started", tool, args });
        return;
      }
      const preview = previewArgs(args);
      process.stdout.write(`→ ${chalk.cyan(tool)}${preview}\n`);
    },
    onToolMessage: (tool, result, metadata) => {
      if (isJson) {
        emitJson({ type: "tool.message", tool, result, metadata });
        return;
      }
      const trimmed = (result ?? "").trim();
      if (!trimmed) return;
      const head = trimmed.slice(0, 240);
      const ellipsis = trimmed.length > 240 ? " …" : "";
      const line = `  ↳ ${head.replace(/\n/g, " ")}${ellipsis}`;
      if (metadata?.isError) {
        process.stdout.write(chalk.red(line) + "\n");
      } else {
        process.stdout.write(chalk.gray(line) + "\n");
      }
    },
    onError: (error) => {
      if (isJson) {
        emitJson({ type: "run.error", message: error.message });
      }
      process.stderr.write(`! agent error: ${error.message}\n`);
    },

    // No promptChoice / promptForm — triggers the auto-approve fallbacks
    // inside MeerAgent.reviewFileEdit and MeerAgent.confirmCommand.
  });

  let interrupted = false;
  const onSigint = () => {
    if (interrupted) return;
    interrupted = true;
    if (isJson) {
      emitJson({ type: "run.error", message: "Interrupted, aborting agent." });
    }
    process.stderr.write("\n! interrupted, aborting agent…\n");
    agent.abort();
  };
  process.on("SIGINT", onSigint);

  try {
    await agent.initialize();
    await agent.processMessage(prompt, { persistUserMessage: false });
    const exitCode = interrupted ? 130 : 0;
    if (isJson) {
      emitJson({ type: "run.completed", exitCode });
    }
    return exitCode;
  } finally {
    process.off("SIGINT", onSigint);
  }
}

function emitJson(event: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      ...event,
    })}\n`
  );
}

function resolvePrompt(
  promptParts: string[],
  filePath: string | undefined
): string {
  if (filePath) {
    try {
      return readFileSync(filePath, "utf8").trim();
    } catch (error) {
      throw new Error(
        `failed to read --file ${filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  return promptParts.join(" ").trim();
}

function previewArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  try {
    if (typeof args === "string") {
      return ` ${truncate(args, 100)}`;
    }
    if (typeof args === "object") {
      const obj = args as Record<string, unknown>;
      const summary = Object.entries(obj)
        .slice(0, 3)
        .map(([k, v]) => {
          const value =
            typeof v === "string"
              ? truncate(v, 60)
              : typeof v === "object"
                ? "{…}"
                : String(v);
          return `${k}=${value}`;
        })
        .join(" ");
      return summary ? ` ${summary}` : "";
    }
    return ` ${truncate(String(args), 100)}`;
  } catch {
    return "";
  }
}

function truncate(input: string, max: number): string {
  const oneLine = input.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}
