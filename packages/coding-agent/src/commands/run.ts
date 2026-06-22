import { Command } from "commander";
import { readFileSync } from "fs";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import type { Provider } from "@meer-ai/ai/base.js";
import { isRetryableProviderError } from "@meer-ai/core/provider-errors.js";
import {
  createRunEventEmitter,
  RUN_PROTOCOL_VERSION,
} from "../runtime/run-events.js";

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
      (value) => {
        const n = parseInt(value, 10);
        if (!Number.isFinite(n) || n < 1) {
          throw new Error(`--max-steps must be a positive integer, got: ${value}`);
        }
        return n;
      },
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
        const exitCode = await runHeadless(promptParts, options);
        process.exit(exitCode);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        if (options.json) {
          const emitter = createRunEventEmitter((s) => process.stdout.write(s));
          emitter.emit({ type: "run.error", message });
          emitter.emit({ type: "run.completed", exitCode: 1 });
        }
        process.stderr.write(`! error: ${message}\n`);
        process.exit(1);
      }
    });

  return command;
}

export interface RunOptions {
  file?: string;
  yes?: boolean;
  maxSteps?: number;
  model?: string;
  cwd?: string;
  verbose?: boolean;
  json?: boolean;
}

/**
 * Injection seam for {@link runHeadless}. Production passes nothing (config is
 * loaded from disk, output goes to the process streams). Tests pass a `provider`
 * (e.g. the faux provider) and a capturing `write` to drive the headless flow
 * end-to-end with no network, no real config, and no bin spawn.
 */
export interface RunHeadlessIO {
  /** stdout sink. Defaults to `process.stdout.write`. */
  write?: (chunk: string) => void;
  /** stderr sink. Defaults to `process.stderr.write`. */
  writeErr?: (chunk: string) => void;
  /** Inject a provider, bypassing `loadConfig()`. */
  provider?: Provider;
  /** Provider label when a provider is injected. */
  providerType?: string;
  /** Model label when a provider is injected. */
  model?: string;
  /**
   * Auto-retry config for transient provider failures. Omitted by default for
   * injected-provider runs so tests stay deterministic (no retry).
   */
  retry?: { attempts: number; delayMs: number; backoffFactor: number };
  /** Register a SIGINT handler for abort. Defaults to true. */
  handleSignals?: boolean;
}

/**
 * Non-interactive agent run shared by the `meer run` subcommand and the
 * top-level `meer --print` alias. Returns an exit code; never calls
 * `process.exit` (the caller owns that). Output is fully routed through the
 * `io` sinks so it can be captured in tests.
 */
export async function runHeadless(
  promptParts: string[],
  options: RunOptions,
  io: RunHeadlessIO = {}
): Promise<number> {
  const write = io.write ?? ((chunk: string) => void process.stdout.write(chunk));
  const writeErr = io.writeErr ?? ((chunk: string) => void process.stderr.write(chunk));
  const emitter = createRunEventEmitter(write);
  const isJson = options.json === true;

  const prompt = resolvePrompt(promptParts, options.file);
  if (!prompt) {
    if (isJson) {
      emitter.emit({
        type: "run.error",
        message: "No prompt provided. Pass it as arguments or use --file <path>.",
      });
      emitter.emit({ type: "run.completed", exitCode: 1 });
    }
    writeErr(
      "! error: no prompt provided. Pass it as arguments or use --file <path>.\n"
    );
    return 1;
  }

  if (!options.yes) {
    if (isJson) {
      emitter.emit({
        type: "run.error",
        message:
          "meer run requires --yes (auto-approval) for now. Interactive approval is not yet supported in headless mode.",
      });
      emitter.emit({ type: "run.completed", exitCode: 1 });
    }
    writeErr(
      "! error: meer run requires --yes (auto-approval) for now. Interactive\n" +
        "  approval is not yet supported in headless mode.\n"
    );
    return 1;
  }

  // Resolve the provider: injected (tests) or loaded from disk (production).
  let provider: Provider;
  let providerType: string;
  let model: string | undefined;
  // Auto-retry config for transient provider failures (e.g. a cold-connection
  // timeout on the first request). The interactive CLI gets this via
  // AgentSession; headless calls processMessage directly, so we apply the same
  // retry here. Injected-provider (test) runs intentionally get no retry.
  let retryConfig: { attempts: number; delayMs: number; backoffFactor: number } | undefined;
  if (io.provider) {
    provider = io.provider;
    providerType = io.providerType ?? "faux";
    model = io.model;
    retryConfig = io.retry;
  } else {
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
    provider = config.provider;
    providerType = config.providerType;
    model = config.model;
    retryConfig = config.retry;
  }

  const cwd = options.cwd ?? process.cwd();
  if (isJson) {
    emitter.emit({
      type: "run.started",
      protocolVersion: RUN_PROTOCOL_VERSION,
      provider: providerType,
      model,
      cwd,
      maxSteps: options.maxSteps,
    });
  } else {
    write(`[run] provider=${providerType} model=${model} cwd=${cwd}\n`);
    write(`[run] max-steps=${options.maxSteps}\n`);
  }

  const { MeerAgent } = await import("../agent/meer-agent.js");

  // Text mode only: when the provider streams a turn, the chunks are already on
  // stdout, so the follow-up settled `onAssistantMessage` for the SAME content
  // must not reprint it. (JSON mode deliberately emits both assistant.delta and
  // assistant.message — meer-code dedupes by turn.)
  let textStreamed = false;

  const agent = new MeerAgent({
    provider,
    cwd,
    maxIterations: options.maxSteps,
    enableMemory: false,
    autoCollectContext: true,
    providerType,
    model,

    // Plain stdout streaming. No Ink, no fancy UI.
    onStreamingStart: () => {
      if (isJson) {
        emitter.emit({ type: "assistant.started" });
        return;
      }
      textStreamed = true;
      write(`\n${chalk.bold("assistant:")} `);
    },
    onStreamingChunk: (chunk) => {
      if (isJson) {
        emitter.emit({ type: "assistant.delta", delta: chunk });
        return;
      }
      write(chunk);
    },
    onStreamingEnd: () => {
      if (isJson) {
        emitter.emit({ type: "assistant.completed" });
        return;
      }
      write("\n");
    },
    onAssistantMessage: (content) => {
      if (isJson) {
        if (content?.trim()) {
          emitter.emit({ type: "assistant.message", content });
        }
        return;
      }
      // Already streamed to stdout this turn → don't reprint the settled copy.
      if (textStreamed) {
        textStreamed = false;
        return;
      }
      if (content?.trim()) {
        write(`\n${chalk.bold("assistant:")} ${content}\n`);
      }
    },
    onCotMessage: (content) => {
      if (isJson) {
        if (options.verbose && content?.trim()) {
          emitter.emit({ type: "reasoning.message", content });
        }
        return;
      }
      if (options.verbose && content?.trim()) {
        write(chalk.gray(`[thinking] ${content}\n`));
      }
    },
    onToolStart: (tool, args) => {
      if (isJson) {
        emitter.emit({ type: "tool.started", tool, args });
        return;
      }
      const preview = previewArgs(args);
      write(`→ ${chalk.cyan(tool)}${preview}\n`);
    },
    onToolMessage: (tool, result, metadata) => {
      if (isJson) {
        emitter.emit({ type: "tool.message", tool, result, metadata });
        return;
      }
      const trimmed = (result ?? "").trim();
      if (!trimmed) return;
      const head = trimmed.slice(0, 240);
      const ellipsis = trimmed.length > 240 ? " …" : "";
      const line = `  ↳ ${head.replace(/\n/g, " ")}${ellipsis}`;
      if (metadata?.isError) {
        write(chalk.red(line) + "\n");
      } else {
        write(chalk.gray(line) + "\n");
      }
    },
    onError: (error) => {
      if (isJson) {
        emitter.emit({ type: "run.error", message: error.message });
      }
      writeErr(`! agent error: ${error.message}\n`);
    },

    // No promptChoice / promptForm — triggers the auto-approve fallbacks
    // inside MeerAgent.reviewFileEdit and MeerAgent.confirmCommand.
  });

  let interrupted = false;
  const handleSignals = io.handleSignals ?? true;
  const onSigint = () => {
    if (interrupted) return;
    interrupted = true;
    if (isJson) {
      emitter.emit({ type: "run.error", message: "Interrupted, aborting agent." });
    }
    writeErr("\n! interrupted, aborting agent…\n");
    agent.abort();
  };
  if (handleSignals) {
    process.on("SIGINT", onSigint);
  }

  try {
    await agent.initialize();

    // Auto-retry transient provider failures (cold-connection timeouts, 5xx,
    // rate limits, "fetch failed", etc.) — parity with the interactive CLI's
    // AgentSession, which headless previously lacked. Without this, a one-off
    // first-request timeout (common with DeepSeek's cold TLS connect) failed
    // the whole `meer run`, and every retry from a caller like meer-code spawns
    // a fresh process that hits the same cold-start timeout.
    const maxRetries = Math.max(0, retryConfig?.attempts ?? 0);
    const baseDelay = Math.max(0, retryConfig?.delayMs ?? 0);
    const backoffFactor = Math.max(1, retryConfig?.backoffFactor ?? 1);
    let attempt = 0;
    for (;;) {
      try {
        await agent.processMessage(prompt, { persistUserMessage: false });
        break;
      } catch (error) {
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        const retryable =
          normalized.name !== "AbortError" &&
          isRetryableProviderError(normalized);
        if (attempt >= maxRetries || !retryable || interrupted) {
          throw normalized;
        }
        attempt += 1;
        const delayMs = Math.round(
          baseDelay * Math.pow(backoffFactor, attempt - 1)
        );
        writeErr(
          `! transient error, retrying (attempt ${attempt}/${maxRetries}) in ${Math.round(
            delayMs / 1000
          )}s: ${normalized.message}\n`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    const exitCode = interrupted ? 130 : 0;
    if (isJson) {
      emitter.emit({ type: "run.completed", exitCode });
    }
    return exitCode;
  } finally {
    if (handleSignals) {
      process.off("SIGINT", onSigint);
    }
  }
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
