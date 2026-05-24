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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const VERSION = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8")
).version;

interface InteractiveAgent {
  initialize(
    options?: string | { contextPrompt?: string; priorMessages?: ChatMessage[] }
  ): Promise<void>;
  processMessage(userMessage: string): Promise<string>;
  abort?(): void;
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

    do {
      restarting = false;

      try {
        const config = loadConfig();
        const cliOptions = program.opts() as {
          resume?: string | boolean;
          fork?: string;
        };
        const providerType = config.providerType ?? "unknown";
        const currentCwd = process.cwd();
        if (cliOptions.resume && cliOptions.fork) {
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
        } else if (cliOptions.resume) {
          const requested =
            typeof cliOptions.resume === "string" ? cliOptions.resume : undefined;
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

        // ── TUI setup ─────────────────────────────────────────────────────────
        const useTui =
          Boolean(process.stdout.isTTY && process.stdin.isTTY) &&
          process.env.MEER_NO_TUI !== "1";

        if (!useTui) {
          await showWelcomeScreen();
        }

        const pendingInputs: string[] = [];
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
              cwd: currentCwd,
              uiSettings: config.ui,
              eventBus,
            })
          : null;

        if (chatUI && restoredTranscript?.length) {
          chatUI.replayTranscript(restoredTranscript);
        }

        // ── Agent setup ───────────────────────────────────────────────────────
        const useClassicAgent =
          (process.env.MEER_AGENT || "").toLowerCase() === "classic";
        const agentConfig = {
          provider: config.provider,
          cwd: currentCwd,
          maxIterations: config.maxIterations,
          autoCollectContext: config.autoCollectContext,
          providerType,
          model: config.model,
          sessionTracker,
          eventBus,
          onStreamingStart: () => chatUI?.startAssistantMessage(),
          onStreamingChunk: (chunk: string) => chatUI?.appendAssistantChunk(chunk),
          onStreamingEnd: () => chatUI?.finishAssistantMessage(),
          onAssistantMessage: (content: string) => chatUI?.settleAssistantMessage(content),
          onTurnStart: () => chatUI?.beginTurn(),
          onTurnEnd: () => chatUI?.endTurn(),
          onIterationChange: (current: number, max: number) =>
            chatUI?.setIteration(current, max),
          onWorkflowStageStart: (name: string) => {
            chatUI?.addWorkflowStage(name);
            chatUI?.startWorkflowStage(name);
          },
          onWorkflowStageComplete: (name: string) =>
            chatUI?.completeWorkflowStage(name),
          onWorkflowStageFail: (name: string) => chatUI?.failWorkflowStage(name),
          onToolStart: (tool: string, args: any) => chatUI?.addTool(tool, args),
          onToolUpdate: (toolName: string, status: string, result?: string) => {
            if (status === "running") {
              chatUI?.startTool(toolName);
            } else if (status === "succeeded") {
              chatUI?.completeTool(toolName, result);
            } else if (status === "failed") {
              chatUI?.failTool(toolName, result || "Error");
            }
          },
          onToolMessage: (toolName: string, result: string) => {
            chatUI?.appendToolMessage(toolName, result);
          },
          onToolEnd: () => chatUI?.clearTools(),
          onStatusChange: (status: string) => chatUI?.setStatus(status),
          onError: () => {},
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
        };

        const agent: InteractiveAgent = useClassicAgent
          ? new (await import("./agent/workflow-v3.js")).AgentWorkflowV3(agentConfig)
          : new (await import("./agent/structured-workflow.js")).StructuredAgentWorkflow(agentConfig);

        await agent.initialize({
          contextPrompt: previousSessionContext ?? undefined,
          priorMessages: restoredModelMessages ?? undefined,
        });

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

        // ── Exit handler ──────────────────────────────────────────────────────
        const handleExit = async () => {
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
        let exitRequested = false;
        let queuedMessage: string | null = null;

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

            const runSlash = (): Promise<SlashCommandResult> =>
              handleSlashCommand(
                userInput,
                config,
                sessionTracker,
                chatUI,
                eventRecorder
              );

            const slashResult = await runSlash();

            if (slashResult.status === "exit") {
              exitRequested = true;
              break;
            }
            if (slashResult.status === "restart") {
              restarting = true;
              if (!chatUI) {
                console.log(chalk.yellow("\n🔄 Reloading configuration...\n"));
              } else {
                chatUI.appendSystemMessage("Reloading configuration...");
              }
              break;
            }
            if (slashResult.status === "send") {
              queuedMessage = slashResult.message;
              if (!chatUI) {
                console.log(chalk.gray(`\n> ${slashResult.message}\n`));
              }
            }
            if (!chatUI) console.log("");
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
            await agent.processMessage(userInput);
            sessionTracker.trackApiCall(Date.now() - start);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (chatUI) {
              chatUI.discardAssistantMessage();
              chatUI.setStatus("");
              chatUI.appendSystemMessage(`❌ ${message}`);
            } else {
              console.log(chalk.red("\n❌ Error:"), message);
            }
          } finally {
            timeline.close();
          }

          if (!chatUI) console.log("\n");
        }

        // ── Session teardown ──────────────────────────────────────────────────
        process.off("SIGINT", handleExit);
        process.off("SIGTERM", handleExit);

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
