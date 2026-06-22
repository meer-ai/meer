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
import { createUpdateCommand } from "./commands/update.js";
import { createAgentsCommand } from "./commands/agents.js";
import { createRunCommand } from "./commands/run.js";
import { SessionTracker } from "./session/tracker.js";
import { ChatBoxUI } from "./ui/chatbox.js";
import { TuiChatAdapter } from "./ui/tui-adapter/TuiChatAdapter.js";
import type { ChatAdapter } from "./ui/chat-adapter.js";
import { setVerboseLogging } from "./logger.js";
import { ProjectContextManager } from "./context/manager.js";
import { planStore } from "./plan/store.js";
import type { Plan } from "./plan/types.js";
import { AgentEventBus } from "./agent/eventBus.js";
import { AgentEventRecorder } from "./agent/eventRecorder.js";
import { BusTimeline } from "./agent/busTimeline.js";
import { WorkflowTimeline } from "./ui/workflowTimeline.js";
import { showWelcomeScreen } from "./chat/welcome.js";
import { TrustStore } from "./trust/store.js";
import { resolveTrustMode, describeTrustMode } from "./trust/gate.js";
import { memory } from "./memory/index.js";
import {
  handleSlashCommand,
  type SlashCommandResult,
} from "./chat/slash.js";
import { isSlashCommandInput } from "./slash/utils.js";
import type { ChatMessage } from "@meer-ai/ai/base.js";
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

/**
 * Bash mode: run a shell command directly without invoking the LLM.
 * Triggered by the `!` prefix on composer input. Echoes the command and
 * its output as system messages so the user sees both. Errors come back
 * formatted but never throw out to the input loop.
 *
 * Deliberately does NOT add the command/output to the conversation
 * history — the LLM doesn't see it unless the user explicitly asks
 * about it in a follow-up. Same convention as pi's bash mode.
 */
async function runBashModeCommand(
  command: string,
  chatUI: import("./ui/chat-adapter.js").ChatAdapter | null
): Promise<void> {
  const { runCommand } = await import("./tools/index.js");
  chatUI?.appendSystemMessage(`$ ${command}`);
  try {
    const result = await runCommand(command, process.cwd(), {
      silent: chatUI !== null,
    });
    if (chatUI) {
      const trimmed = (result.result ?? "").trim();
      const body = result.error
        ? trimmed
          ? `${trimmed}\n\n❌ ${result.error}`
          : `❌ ${result.error}`
        : trimmed || "(no output)";
      chatUI.appendSystemMessage(body);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (chatUI) {
      chatUI.appendSystemMessage(`❌ ${message}`);
    } else {
      console.log(chalk.red(`\n❌ ${message}\n`));
    }
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
    .option(
      "--print <prompt>",
      "Run a single prompt headlessly and exit (non-interactive; alias for `meer run --yes`)"
    )
    .option("--json", "With --print: emit newline-delimited JSON events instead of text")
    .option("--model <id>", "With --print: override the model id for this run")
    .option("--cwd <path>", "With --print: working directory for the agent")
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
  program.addCommand(createUpdateCommand());

  // ── Interactive chat (default action) ──────────────────────────────────────
  const runChatAction = async (actionOverrides?: {
    resume?: string | boolean;
    fork?: string;
  }) => {
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
        const cliOptions = {
          ...(program.opts() as {
            resume?: string | boolean;
            fork?: string;
            alwaysAsk?: boolean;
          }),
          ...(actionOverrides ?? {}),
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
        let restoredPlan: Plan | null = null;

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
          restoredPlan = memory.loadLatestPlan(source.path);
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
          restoredPlan = memory.loadLatestPlan(source.path);
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

        type PendingInput = {
          text: string;
          attachments?: import("@meer-ai/agent/types.js").MessageAttachment[];
        };
        const pendingInputs: PendingInput[] = [];
        let pendingResolver: ((value: PendingInput) => void) | null = null;
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

        // Unblock the main loop when it is parked on `askQuestion()`. Slash
        // commands submitted through the TUI run in the async path below, so a
        // restart/exit/queued-message they trigger would otherwise sit unnoticed
        // until the user typed again. Resolving with empty text makes the loop
        // `continue` and re-check its `!restarting && !exitRequested` guard.
        const wakeMainLoop = () => {
          if (pendingResolver) {
            const resolve = pendingResolver;
            pendingResolver = null;
            resolve({ text: "" });
          }
        };

        const enqueueInput = (
          value: string,
          attachments?: import("@meer-ai/agent/types.js").MessageAttachment[]
        ) => {
          const trimmed = value.trim();
          const hasAttachments = (attachments?.length ?? 0) > 0;
          if (!trimmed && !hasAttachments) {
            return;
          }
          // Slash commands never carry attachments — they're CLI verbs, not chat.
          if (!hasAttachments && isSlashCommandInput(trimmed)) {
            void (async () => {
              try {
                const result = await executeSlashCommand(trimmed);
                const shouldBreak = await applySlashResult(result);
                // Restart/exit, or a command that queued a message, must wake the
                // idle loop so it acts now instead of after the next keystroke.
                if (shouldBreak || queuedMessage !== null) {
                  wakeMainLoop();
                }
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : String(error);
                chatUI?.appendSystemMessage(`❌ ${message}`);
              }
            })();
            return;
          }
          // Bash mode: a leading `!` runs the rest as a shell command,
          // skipping the LLM entirely. Saves tokens on trivial peeks
          // (`!ls`, `!git status`). The output is shown as a system
          // message and is NOT added to the conversation history, so the
          // model doesn't see it unless the user follows up with a real
          // chat turn.
          if (!hasAttachments && trimmed.startsWith("!") && trimmed !== "!") {
            const command = trimmed.slice(1).trim();
            if (command) {
              void runBashModeCommand(command, chatUI ?? null);
            }
            return;
          }
          // Queueing mid-turn currently only carries text (the queue is text-only
          // for steering/follow-up). If the user attached an image while the
          // agent is processing, fall through to the pending-input path so it
          // lands on the next live turn instead of being silently dropped.
          if (
            trimmed &&
            !hasAttachments &&
            session?.isProcessing() &&
            session.queueMessage(
              trimmed,
              chatUI?.getQueueMode?.() ?? "steer"
            )
          ) {
            return;
          }
          const payload: PendingInput = {
            text: value,
            attachments: hasAttachments ? attachments : undefined,
          };
          if (pendingResolver) {
            const resolve = pendingResolver;
            pendingResolver = null;
            resolve(payload);
          } else {
            pendingInputs.push(payload);
          }
        };

        const chatUI: ChatAdapter | null = useTui
          ? new TuiChatAdapter({
              provider: providerType,
              model: config.model,
              cwd: currentCwd,
              ui: config.ui,
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

        // ── Project trust gate ────────────────────────────────────────────────
        // Ask once per folder whether the user trusts it. The result selects how
        // shell commands are gated for this session. Headless/non-TUI runs skip
        // the prompt and default to trusted (preserving prior behavior).
        const trustStore = new TrustStore();
        const trustMode = await resolveTrustMode({
          cwd: currentCwd,
          store: trustStore,
          promptChoice: chatUI
            ? (message, choices, def) => chatUI.promptChoice(message, choices, def ?? choices[0]?.value ?? "")
            : undefined,
        });
        if (chatUI) {
          chatUI.appendSystemMessage(describeTrustMode(trustMode));
        }

        // ── Agent setup ───────────────────────────────────────────────────────
        const agentConfig = {
          provider: config.provider,
          cwd: currentCwd,
          trustStore,
          trustMode,
          approvalsEnabled,
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
          onToolCallDelta: (
            toolName: string | undefined,
            inputTextDelta: string,
            metadata: { toolCallId: string }
          ) => {
            chatUI?.previewToolCall(
              metadata.toolCallId,
              toolName,
              inputTextDelta
            );
          },
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
          onUsage: ({ promptTokens, completionTokens }: { promptTokens?: number; completionTokens?: number }) => {
            // Real billed usage reported by the provider. Accumulate into the
            // tracker (each request bills its full prompt) and show real
            // tokens + cost in the footer.
            if (promptTokens) sessionTracker.trackPromptTokens(promptTokens);
            if (completionTokens) sessionTracker.trackCompletionTokens(completionTokens);
            const usage = sessionTracker.getTokenUsage();
            chatUI?.updateTokens(usage.total, sessionTracker.getMaxTokens(), false);
            const cost = sessionTracker.getCostUsage().total;
            if (cost > 0) chatUI?.updateCost(cost);
          },
          // Always wired so an untrusted (restricted) project can prompt before
          // shell commands even when approvals are otherwise off. Whether a
          // prompt actually appears is decided inside the agent based on
          // approvalsEnabled and the trust mode.
          promptChoice: async (
            promptMessage: string,
            choices: Array<{ label: string; value: string }>,
            defaultChoice?: string
          ) => {
            if (chatUI) {
              const fallback = defaultChoice ?? choices[0]?.value ?? "";
              return chatUI.promptChoice(promptMessage, choices, fallback);
            }
            return defaultChoice ?? choices[0]?.value ?? "";
          },
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
        const agent = new MeerAgent(agentConfig);
        const runtime: SessionAgentRuntime = agent;

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

        // MCP servers connect in the background (so the prompt is usable right
        // away). Surface a live "Starting MCP servers …" indicator — like Codex
        // — so the user knows why tools aren't ready yet instead of staring at a
        // silent prompt. The subscription replays the latest state immediately,
        // so we don't miss progress fired before we attached.
        const unsubscribeMcpProgress = agent.subscribeMcpInitProgress((p) => {
          if (!chatUI) return;
          if (p.phase === "done") {
            chatUI.setStartupStatus(null);
            if (p.failed > 0) {
              chatUI.appendSystemMessage(
                `⚠️  ${p.failed} of ${p.total} MCP server(s) failed to connect. Run /mcp for details.`
              );
            }
            return;
          }
          const settled = p.connected + p.failed;
          const suffix = p.lastServer ? `: ${p.lastServer}` : "";
          chatUI.setStartupStatus(
            `Starting MCP servers (${settled}/${p.total})${suffix}`
          );
        });

        chatUI?.setInterruptHandler(() => session?.abort());

        // Shift+Tab in the TUI cycles the permission mode; keep the agent's
        // runtime mode in sync. Seed the footer with the agent's launch default.
        chatUI?.setModeChangeHandler((mode) => agent.setPermissionMode(mode));
        chatUI?.setMode(agent.getPermissionMode());

        if (sessionBanner && !chatUI) {
          console.log(chalk.gray(`${sessionBanner}\n`));
        }

        // ── Plan subscriptions ────────────────────────────────────────────────
        // The plan store drives the live task panel: render it into the TUI and
        // mirror it onto the event bus for recorders/timeline. Without the
        // chatUI.setPlan call the panel never updates, so set_plan /
        // update_plan_task were invisible.
        //
        // Restore an unfinished plan from the resumed/forked session BEFORE the
        // first snapshot and before the subscribe is attached: seeding now means
        // the panel renders the restored plan immediately, and the seed itself
        // isn't re-persisted (no listener is wired yet).
        if (restoredPlan) {
          planStore.setPlan(restoredPlan);
        }
        const pushPlanSnapshot = (plan = planStore.getSnapshot()) => {
          chatUI?.setPlan(plan);
          eventBus.emitPlan(plan);
        };
        pushPlanSnapshot();
        const detachPlanListener = planStore.subscribe((plan) => {
          pushPlanSnapshot(plan);
          // Persist every plan change so a later resume picks up where we left.
          memory.recordPlan(plan, currentCwd);
        });

        chatUI?.captureConsole();
        chatUI?.enableContinuousChat(enqueueInput);
        const backgroundSessionTimer = chatUI
          ? setInterval(() => {
              chatUI.setBackgroundSessions(backgroundTerminals.list());
            }, 1000)
          : null;

        // ── Exit handler ──────────────────────────────────────────────────────
        let isExiting = false;
        const handleExit = async () => {
          if (isExiting) return;
          isExiting = true;
          process.off("SIGINT", handleSigint);
          process.off("SIGTERM", handleExit);
          if (backgroundSessionTimer) {
            clearInterval(backgroundSessionTimer);
          }
          const finalStats = await sessionTracker.endSession();
          unsubscribeMcpProgress();
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

        // First SIGINT while the agent is processing → abort the turn (and
        // kill in-flight tool subprocesses), don't quit. Second SIGINT
        // within ~2s, or any SIGINT when idle → full exit. Matches the
        // Ctrl+C behavior wired into MeerChat.useInput so users see a
        // consistent "stop work" vs "exit" distinction whether the press
        // is captured by the Ink raw-mode reader or by the OS signal
        // pipeline (depends on which terminal/terminfo combo they're on).
        let sigintArmedUntil = 0;
        const handleSigint = () => {
          const now = Date.now();
          const armed = now < sigintArmedUntil;
          const busy = Boolean(session?.isProcessing());
          if (busy && !armed) {
            sigintArmedUntil = now + 2000;
            try {
              session?.abort();
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              chatUI?.appendSystemMessage(`❌ abort failed: ${msg}`);
            }
            return;
          }
          void handleExit();
        };

        process.on("SIGINT", handleSigint);
        process.on("SIGTERM", handleExit);

        // ── Input helper ──────────────────────────────────────────────────────
        const askQuestion = async (): Promise<PendingInput> => {
          if (chatUI) {
            if (pendingInputs.length > 0) {
              return pendingInputs.shift() as PendingInput;
            }
            return new Promise<PendingInput>((resolve) => {
              pendingResolver = resolve;
            });
          }
          const text = await ChatBoxUI.handleInput({
            provider: providerType,
            model: config.model,
            cwd: process.cwd(),
          });
          return { text };
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
          let userAttachments:
            | import("@meer-ai/agent/types.js").MessageAttachment[]
            | undefined;
          if (queuedMessage !== null) {
            userInput = queuedMessage;
            queuedMessage = null;
          } else {
            const payload = await askQuestion();
            userInput = payload.text.trim();
            userAttachments = payload.attachments;
          }
          if (!userInput && (userAttachments?.length ?? 0) === 0) continue;

          // Exit shortcuts
          const lowered = userInput.toLowerCase();
          if (lowered === "exit" || lowered === "quit") {
            if (chatUI) chatUI.appendSystemMessage("Exiting chat session...");
            exitRequested = true;
            break;
          }

          // Slash commands (attachments never accompany slash routes).
          if (
            (userAttachments?.length ?? 0) === 0 &&
            isSlashCommandInput(userInput)
          ) {
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
            chatUI.appendUserMessage(userInput, {
              consumeOptimistic: true,
              attachmentCount: userAttachments?.length,
            });
          }
          sessionTracker.trackMessage();

          const timeline = new BusTimeline(
            eventBus,
            chatUI ? undefined : new WorkflowTimeline()
          );

          // Pre-turn budget check. If the user set a token cap via /budget
          // and we're already over, refuse the turn with a clear message
          // rather than firing the LLM call. Protects runaway autonomous
          // loops from incurring further spend after the user said "stop."
          if (sessionTracker.isOverBudget()) {
            const usage = sessionTracker.getTokenUsage();
            const cap = sessionTracker.getMaxTokens();
            const msg = `Session token budget reached (${usage.total.toLocaleString()} / ${cap?.toLocaleString() ?? "?"}). Use /budget set N to raise the cap or /budget unset to remove it.`;
            if (chatUI) {
              chatUI.appendSystemMessage(`💰 ${msg}`);
            } else {
              console.log(chalk.yellow(`\n💰 ${msg}\n`));
            }
            continue;
          }

          try {
            const start = Date.now();
            await session.prompt(userInput, { attachments: userAttachments });
            sessionTracker.trackApiCall(Date.now() - start);
            // If the provider reported real usage this turn (onUsage), the
            // footer already shows billed tokens + cost. Otherwise fall back to
            // a char-based estimate of context size, clearly marked with "~ctx".
            if (sessionTracker.getTokenUsage().total === 0) {
              const ctxTokens = sessionTracker.getContextTokens();
              if (ctxTokens > 0) {
                chatUI?.updateTokens(ctxTokens, sessionTracker.getMaxTokens(), true);
              }
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            const isAbort = error instanceof Error && error.name === "AbortError";
            if (chatUI) {
              // Defense in depth: forceResetWorkState clears ALL transient
              // indicators (tools, workflow stages, status text, draft) so a
              // thrown event-sink listener in meer-agent can't strand
              // "Running …" or a partial tool widget on screen.
              chatUI.forceResetWorkState();
              chatUI.setStatus("");
              if (isAbort) {
                chatUI.appendSystemMessage("Interrupted.");
              } else {
                chatUI.appendSystemMessage(`❌ ${message}`);
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
        process.off("SIGINT", handleSigint);
        process.off("SIGTERM", handleExit);
        if (backgroundSessionTimer) {
          clearInterval(backgroundSessionTimer);
        }

        const finalStats = await sessionTracker.endSession();
        unsubscribeMcpProgress();
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
  };

  program.action(async () => {
    // Top-level `--print` runs the headless agent and exits — an ergonomic
    // alias over `meer run --yes`. It shares the exact same protocol/output as
    // the `run` subcommand (see commands/run.ts → runHeadless), so the meer-code
    // and cloud-agent integrations see an identical stream either way.
    const opts = program.opts() as {
      print?: string;
      json?: boolean;
      model?: string;
      cwd?: string;
      verbose?: boolean;
    };
    if (opts.print !== undefined) {
      const { runHeadless } = await import("./commands/run.js");
      const exitCode = await runHeadless([opts.print], {
        yes: true,
        json: opts.json,
        model: opts.model,
        cwd: opts.cwd,
        verbose: opts.verbose,
        maxSteps: 50,
      });
      process.exit(exitCode);
    }
    await runChatAction();
  });

  // ── Resume sub-command ──────────────────────────────────────────────────────
  // `meer resume [session]` is an explicit alias for the `--resume` flag so the
  // Ctrl+C exit hint ("meer resume <id>") is directly runnable. Without an
  // argument it resumes the latest saved session in this project.
  program
    .command("resume [session]")
    .description("Resume the latest or a specific saved session")
    .action(async (session?: string) => {
      await runChatAction({ resume: session ?? true });
    });

  program.configureOutput({
    writeErr: (str) => process.stderr.write(str),
    writeOut: (str) => process.stdout.write(str),
    outputError: (str, write) => write(chalk.red(str)),
  });

  return program;
}
