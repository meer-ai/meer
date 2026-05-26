import { Command } from "commander";
import chalk from "chalk";
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
import { createAgentsCommand } from "./commands/agents.js";
import { createRunCommand } from "./commands/run.js";
import { SessionTracker } from "./session/tracker.js";
import { ChatBoxUI } from "./ui/chatbox.js";
import { InkChatAdapter } from "./ui/ink/index.js";
import { setVerboseLogging } from "./logger.js";
import { ProjectContextManager } from "./context/manager.js";
import { planStore } from "./plan/store.js";
import { AgentEventBus } from "./agent/eventBus.js";
import { AgentEventRecorder } from "./agent/eventRecorder.js";
import { BusTimeline } from "./agent/busTimeline.js";
import { WorkflowTimeline } from "./ui/workflowTimeline.js";
import { showWelcomeScreen } from "./chat/welcome.js";
import { memory } from "./memory/index.js";
import {
  handleSlashCommand,
  type SlashCommandResult,
} from "./chat/slash.js";
import type { ChatMessage } from "./providers/base.js";
import { backgroundTerminals } from "./runtime/backgroundTerminals.js";
import { AgentSession, type SessionAgentRuntime } from "./agent/agent-session.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const VERSION = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8")
).version;

async function ensureConfiguredForChat(): Promise<boolean> {
  const { configExists } = await import("./config.js");
  if (configExists()) {
    return true;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(chalk.yellow("Meer is not configured yet."));
    console.error(chalk.gray("Run `meer setup` in an interactive terminal first."));
    return false;
  }

  const { runSetupWizard } = await import("./commands/setup.js");
  await runSetupWizard();

  if (!configExists()) {
    console.log(chalk.gray("Setup did not create a configuration. Exiting."));
    return false;
  }

  return true;
}

function emitQueueChanges(
  eventBus: AgentEventBus,
  queue: {
    steering: string[];
    followUp: string[];
    changes?: Array<{
      action: "queued" | "delivered";
      mode: "steer" | "followUp";
      message: string;
    }>;
  }
): void {
  for (const change of queue.changes ?? []) {
    eventBus.emitQueue({
      id: `queue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      action: change.action,
      mode: change.mode,
      message: change.message,
      pendingSteering: queue.steering.length,
      pendingFollowUp: queue.followUp.length,
      timestamp: Date.now(),
    });
  }
}

export function createCLI(): Command {
  const program = new Command();

  program
    .name("meer")
    .description(
      "MeerAI — Dive deep into your code. Open-source, local-first AI CLI for developers."
    )
    .version(VERSION)
    .option("-p, --profile <name>", "Override the active profile")
    .option("-v, --verbose", "Enable verbose logging output")
    .option("--always-ask", "Enable approval prompts for edits and commands")
    .option("--resume [session]", "Resume the latest or a specific saved session")
    .option("--fork <session>", "Fork a saved session into a new one")
    .hook("preAction", (thisCommand) => {
      const options = thisCommand.opts();
      if (options.profile) {
        process.env.DEVAI_PROFILE = options.profile;
      }
      setVerboseLogging(Boolean(options.verbose));
    });

  // ── Sub-commands ────────────────────────────────────────────────────────────
  program.addCommand(createSetupCommand());
  program.addCommand(createLoginCommand());
  program.addCommand(createLogoutCommand());
  program.addCommand(createWhoamiCommand());
  program.addCommand(createAskCommand());
  program.addCommand(createRunCommand());
  program.addCommand(createCommitMsgCommand());
  program.addCommand(createReviewCommand());
  program.addCommand(createMemoryCommand());
  program.addCommand(createMCPCommand());
  program.addCommand(createIndexCommand());
  program.addCommand(createAgentsCommand());
  program.addCommand(createDoctorCommand());

  // ── Interactive chat (default action) ──────────────────────────────────────
  program.action(async () => {
    const { loadConfig } = await import("./config.js");
    let restarting = false;
    let restartResumeSession: string | undefined;

    do {
      restarting = false;

      try {
        if (!(await ensureConfiguredForChat())) {
          break;
        }

        const config = loadConfig();
        const cliOptions = program.opts() as {
          resume?: string | boolean;
          fork?: string;
          alwaysAsk?: boolean;
        };
        const effectiveResume =
          restartResumeSession ??
          (typeof cliOptions.resume === "string" ? cliOptions.resume : cliOptions.resume);
        restartResumeSession = undefined;
        const approvalsEnabled =
          Boolean(cliOptions.alwaysAsk) ||
          Boolean(config.approvals?.alwaysAsk);
        const providerType = config.providerType ?? "unknown";
        const currentCwd = process.cwd();
        if (effectiveResume && cliOptions.fork) {
          throw new Error("Use either --resume or --fork, not both.");
        }

        let previousSessionContext: string | null = null;
        let startedSession: { sessionId: string; sessionPath: string } | null = null;
        let sessionBanner: string | null = null;
        let restoredTranscript:
          | Array<{
              role: "user" | "assistant" | "system" | "tool";
              content: string;
              timestamp: number;
            }>
          | null = null;
        let restoredModelMessages:
          | Array<{ role: "user" | "assistant" | "system"; content: string }>
          | null = null;

        if (cliOptions.fork) {
          const source = memory.resolveSession(cliOptions.fork, currentCwd);
          if (!source) {
            throw new Error(`Could not find session '${cliOptions.fork}'.`);
          }

          const forked = memory.forkSession(source.path, currentCwd);
          if (!forked) {
            throw new Error(`Failed to fork session '${cliOptions.fork}'.`);
          }

          startedSession = forked;
          const sourceView = memory.loadSessionView(source.path);
          restoredTranscript = sourceView?.entries ?? null;
          restoredModelMessages = memory.loadChatMessages(source.path, {
            maxMessages: 24,
          });
          sessionBanner = `Forked session ${source.id.slice(0, 8)} into ${forked.sessionId.slice(0, 8)}.`;
        } else if (effectiveResume) {
          const requested =
            typeof effectiveResume === "string" ? effectiveResume : undefined;
          const source = requested
            ? memory.resolveSession(requested, currentCwd)
            : memory.listSessions(currentCwd)[0] ?? null;
          if (!source) {
            throw new Error(
              requested
                ? `Could not find session '${requested}'.`
                : "No saved session found to resume in this project."
            );
          }

          const resumed = memory.resumeSession(source.path);
          if (!resumed) {
            throw new Error(`Failed to resume session '${source.id}'.`);
          }

          startedSession = resumed;
          const sourceView = memory.loadSessionView(source.path);
          restoredTranscript = sourceView?.entries ?? null;
          restoredModelMessages = memory.loadChatMessages(source.path, {
            maxMessages: 24,
          });
          sessionBanner = `Resumed session ${source.id.slice(0, 8)}.`;
        } else {
          previousSessionContext = memory.buildRecentContext(currentCwd, {
            excludeCurrent: true,
            maxMessages: 8,
          });
          startedSession = memory.startSession(currentCwd);
          if (previousSessionContext) {
            sessionBanner = `Loaded recent project context into session ${startedSession.sessionId.slice(0, 8)}.`;
          }
        }

        ProjectContextManager.getInstance().configureEmbeddings({
          enabled: config.contextEmbedding?.enabled ?? false,
          dimensions: config.contextEmbedding?.dimensions,
          maxFileSize: config.contextEmbedding?.maxFileSize,
        });

        const sessionTracker = new SessionTracker(providerType, config.model);
        const eventBus = new AgentEventBus();
        const eventRecorder = new AgentEventRecorder(eventBus);
        if (approvalsEnabled && process.stdout.isTTY) {
          console.log(
            chalk.dim(
              "Approval prompts enabled for edits and shell commands."
            )
          );
        }

        // ── TUI setup ─────────────────────────────────────────────────────────
        const useTui =
          Boolean(process.stdout.isTTY && process.stdin.isTTY) &&
          process.env.MEER_NO_TUI !== "1";

        if (!useTui) {
          await showWelcomeScreen();
        }

        const pendingInputs: string[] = [];
        let pendingResolver: ((value: string) => void) | null = null;
        let session: AgentSession | null = null;
        let exitRequested = false;
        let queuedMessage: string | null = null;

        const executeSlashCommand = async (
          rawInput: string
        ): Promise<SlashCommandResult> => {
          if (chatUI) {
            chatUI.appendSystemMessage(rawInput);
          }
          return handleSlashCommand(
            rawInput,
            config,
            sessionTracker,
            chatUI,
            eventRecorder
          );
        };

        const applySlashResult = async (
          slashResult: SlashCommandResult
        ): Promise<boolean> => {
          if (slashResult.status === "exit") {
            exitRequested = true;
            return true;
          }
          if (slashResult.status === "restart") {
            restarting = true;
            restartResumeSession = slashResult.resumeSession;
            if (!chatUI) {
              console.log(chalk.yellow("\n🔄 Reloading configuration...\n"));
            } else {
              chatUI.appendSystemMessage(
                slashResult.resumeSession
                  ? "Reloading into selected session..."
                  : "Reloading configuration..."
              );
            }
            return true;
          }
          if (slashResult.status === "send") {
            queuedMessage = slashResult.message;
            if (!chatUI) {
              console.log(chalk.gray(`\n> ${slashResult.message}\n`));
            }
          }
          if (!chatUI) console.log("");
          return false;
        };

        const enqueueInput = (value: string) => {
          const trimmed = value.trim();
          if (!trimmed) {
            return;
          }
          if (trimmed.startsWith("/")) {
            void (async () => {
              try {
                const result = await executeSlashCommand(trimmed);
                await applySlashResult(result);
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : String(error);
                chatUI?.appendSystemMessage(`❌ ${message}`);
              }
            })();
            return;
          }
          if (
            trimmed &&
            session?.isProcessing() &&
            session.queueMessage(
              trimmed,
              chatUI?.getQueueMode?.() ?? "steer"
            )
          ) {
            return;
          }
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
              cwd: currentCwd,
              uiSettings: config.ui,
              eventBus,
            })
          : null;

        if (chatUI && restoredTranscript?.length) {
          chatUI.replayTranscript(restoredTranscript);
        }
        chatUI?.setBackgroundSessions(backgroundTerminals.list());
        chatUI?.setBackgroundSessionStopHandler((id: string) => {
          backgroundTerminals.stop(id);
          chatUI.setBackgroundSessions(backgroundTerminals.list());
        });

        // ── Agent setup ───────────────────────────────────────────────────────
        const agentConfig = {
          provider: config.provider,
          cwd: currentCwd,
          maxIterations: config.maxIterations,
          autoCollectContext: config.autoCollectContext,
          compaction: config.compaction,
          providerType,
          model: config.model,
          sessionTracker,
          eventBus,
          onStreamingStart: () => chatUI?.startAssistantMessage(),
          onStreamingChunk: (chunk: string) => chatUI?.appendAssistantChunk(chunk),
          onStreamingEnd: () => chatUI?.finishAssistantMessage(),
          onAssistantMessage: (content: string) => chatUI?.settleAssistantMessage(content),
          onCotMessage: (content: string) => chatUI?.addCotMessage(content),
          onToolStart: (tool: string, args: any, metadata?: { toolCallId?: string }) =>
            chatUI?.addTool(tool, args, metadata?.toolCallId),
          onToolUpdate: (
            toolName: string,
            status: string,
            result?: string,
            metadata?: { toolCallId?: string; details?: Record<string, unknown> }
          ) => {
            const handle = metadata?.toolCallId ?? toolName;
            if (status === "running") {
              chatUI?.startTool(handle);
              if (result) {
                chatUI?.updateToolProgress(handle, result);
              }
            } else if (status === "succeeded") {
              chatUI?.completeTool(handle, result, metadata?.details);
            } else if (status === "failed") {
              chatUI?.failTool(handle, result || "Error", metadata?.details);
            }
          },
          onToolMessage: (
            toolName: string,
            result: string,
            metadata?: { toolCallId?: string; isError?: boolean; details?: Record<string, unknown> }
          ) => {
            chatUI?.appendToolMessage(toolName, result, metadata?.isError, {
              toolCallId: metadata?.toolCallId,
              details: metadata?.details,
            });
          },
          onToolEnd: () => chatUI?.clearTools(),
          onError: () => {},
          promptChoice: approvalsEnabled
            ? async (
                promptMessage: string,
                choices: Array<{ label: string; value: string }>,
                defaultChoice?: string
              ) => {
                if (chatUI) {
                  const fallback = defaultChoice ?? choices[0]?.value ?? "";
                  return chatUI.promptChoice(promptMessage, choices, fallback);
                }
                return defaultChoice ?? choices[0]?.value ?? "";
              }
            : undefined,
          promptForm: async (
            title: string,
            questions: Array<{
              id: string;
              label: string;
              type: "select" | "multiselect";
              required?: boolean;
              options: Array<{
                label: string;
                value: string;
                description?: string;
              }>;
            }>,
            submitLabel?: string
          ) => {
            if (chatUI) {
              return chatUI.promptForm(title, questions, submitLabel);
            }

            const fallback: Record<string, string | string[]> = {};
            for (const question of questions) {
              fallback[question.id] =
                question.type === "multiselect"
                  ? question.options[0]
                    ? [question.options[0].value]
                    : []
                  : question.options[0]?.value ?? "";
            }
            return fallback;
          },
        };

        const { MeerAgent } = await import("./agent/meer-agent.js");
        const runtime: SessionAgentRuntime = new MeerAgent(agentConfig);

        session = new AgentSession({
          runtime,
          retry: config.retry,
          sessionTracker,
          compaction: config.compaction,
          onEvent: (event) => {
            if (event.type === "turn_start") {
              chatUI?.beginTurn();
            } else if (event.type === "iteration_change") {
              chatUI?.setIteration(event.current, event.max);
            } else if (event.type === "workflow_stage") {
              if (event.status === "started") {
                chatUI?.addWorkflowStage(event.name);
                chatUI?.startWorkflowStage(event.name);
              } else if (event.status === "completed") {
                chatUI?.completeWorkflowStage(event.name);
              } else {
                chatUI?.failWorkflowStage(event.name);
              }
            } else if (event.type === "turn_end") {
              chatUI?.endTurn();
              if (!event.success && event.error) {
                chatUI?.appendSystemMessage(`❌ ${event.error}`);
              }
            } else if (event.type === "status_change") {
              chatUI?.setStatus(event.status);
            } else if (event.type === "queue_update") {
              chatUI?.setQueueState(event);
              emitQueueChanges(eventBus, event);
            } else if (event.type === "auto_retry_start") {
              const label = `Retrying in ${Math.round(event.delayMs / 1000)}s (attempt ${event.attempt}/${event.maxAttempts})…`;
              chatUI?.setStatus(label);
              eventBus.emitLog({
                id: `retry-start-${Date.now()}-${event.attempt}`,
                level: "warn",
                message: `${label} ${event.errorMessage}`,
                timestamp: Date.now(),
              });
            } else if (event.type === "auto_retry_end") {
              if (!event.success) {
                eventBus.emitLog({
                  id: `retry-end-${Date.now()}-${event.attempt}`,
                  level: "error",
                  message: event.finalError
                    ? `Retry failed after ${event.attempt} attempts: ${event.finalError}`
                    : `Retry failed after ${event.attempt} attempts.`,
                  timestamp: Date.now(),
                });
              }
            }
          },
        });

        await session.initialize({
          contextPrompt: previousSessionContext ?? undefined,
          priorMessages: restoredModelMessages ?? undefined,
        });

        chatUI?.setInterruptHandler(() => session?.abort());

        if (sessionBanner && !chatUI) {
          console.log(chalk.gray(`${sessionBanner}\n`));
        }

        // ── Plan subscriptions ────────────────────────────────────────────────
        const pushPlanSnapshot = (plan = planStore.getSnapshot()) => {
          eventBus.emitPlan(plan);
        };
        pushPlanSnapshot();
        const detachPlanListener = planStore.subscribe((plan) => {
          pushPlanSnapshot(plan);
        });

        chatUI?.captureConsole();
        chatUI?.enableContinuousChat(enqueueInput);
        const backgroundSessionTimer = chatUI
          ? setInterval(() => {
              chatUI.setBackgroundSessions(backgroundTerminals.list());
            }, 1000)
          : null;

        // ── Exit handler ──────────────────────────────────────────────────────
        const handleExit = async () => {
          if (backgroundSessionTimer) {
            clearInterval(backgroundSessionTimer);
          }
          const finalStats = await sessionTracker.endSession();
          if (chatUI) {
            chatUI.appendSystemMessage("Session ended. Goodbye! 🌊");
            detachPlanListener();
            chatUI.destroy();
          } else {
            console.log("\n");
          }
          eventRecorder.dispose();
          eventBus.removeAllListeners();
          ChatBoxUI.displayGoodbye(finalStats);
          process.exit(0);
        };

        process.on("SIGINT", handleExit);
        process.on("SIGTERM", handleExit);

        // ── Input helper ──────────────────────────────────────────────────────
        const askQuestion = async (): Promise<string> => {
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

        // ── Main chat loop ────────────────────────────────────────────────────
        while (!exitRequested && !restarting) {
          if (!chatUI) {
            ChatBoxUI.renderStatusBar({
              provider: providerType,
              model: config.model,
              cwd: process.cwd(),
            });
          }

          let userInput: string;
          if (queuedMessage !== null) {
            userInput = queuedMessage;
            queuedMessage = null;
          } else {
            userInput = (await askQuestion()).trim();
          }
          if (!userInput) continue;

          // Exit shortcuts
          const lowered = userInput.toLowerCase();
          if (lowered === "exit" || lowered === "quit") {
            if (chatUI) chatUI.appendSystemMessage("Exiting chat session...");
            exitRequested = true;
            break;
          }

          // Slash commands
          if (userInput.startsWith("/")) {
            if (chatUI) chatUI.appendSystemMessage(userInput);

            const slashResult = await executeSlashCommand(userInput);
            const shouldBreak = await applySlashResult(slashResult);
            if (shouldBreak) {
              break;
            }
            continue;
          }

          // Regular message
          if (chatUI) {
            chatUI.appendUserMessage(userInput, { consumeOptimistic: true });
          }
          sessionTracker.trackMessage();

          const timeline = new BusTimeline(
            eventBus,
            chatUI ? undefined : new WorkflowTimeline()
          );

          try {
            const start = Date.now();
            await session.prompt(userInput);
            sessionTracker.trackApiCall(Date.now() - start);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            const isAbort = error instanceof Error && error.name === "AbortError";
            if (chatUI) {
              chatUI.discardAssistantMessage();
              chatUI.setStatus("");
              if (isAbort) {
                chatUI.appendSystemMessage("Interrupted.");
              }
            } else {
              if (isAbort) {
                console.log(chalk.yellow("\nInterrupted."));
              } else {
                console.log(chalk.red("\n❌ Error:"), message);
              }
            }
          } finally {
            timeline.close();
          }

          if (!chatUI) console.log("\n");
        }

        // ── Session teardown ──────────────────────────────────────────────────
        process.off("SIGINT", handleExit);
        process.off("SIGTERM", handleExit);
        if (backgroundSessionTimer) {
          clearInterval(backgroundSessionTimer);
        }

        const finalStats = await sessionTracker.endSession();
        if (chatUI) {
          detachPlanListener();
          chatUI.destroy();
        }
        eventRecorder.dispose();
        eventBus.removeAllListeners();

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

  program.configureOutput({
    writeErr: (str) => process.stderr.write(str),
    writeOut: (str) => process.stdout.write(str),
    outputError: (str, write) => write(chalk.red(str)),
  });

  return program;
}
