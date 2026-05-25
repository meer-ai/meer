import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import { Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";
import {
  getAllCommands,
  type SlashCommandListEntry,
} from "../../slash/registry.js";
import { getSlashCommandBadges } from "../../slash/utils.js";
import type { Plan } from "../../plan/types.js";
import type { ToolCall } from "./components/tools/index.js";
import type { WorkflowStage } from "./components/workflow/index.js";
import { VirtualizedList, ScrollIndicator } from "./components/shared/index.js";
import type { Message } from "./contexts/ChatContext.js";
import { debounce } from "./utils/debounce.js";

// ============================================================================
// Types
// ============================================================================

export interface MeerChatProps {
  onMessage: (message: string) => void;
  messages: Message[];
  draftAssistant?: Message;
  isThinking: boolean;
  status?: string;
  provider?: string;
  model?: string;
  cwd?: string;
  onExit?: () => void;
  onInterrupt?: () => void;
  mode?: "edit" | "plan";
  onModeChange?: (mode: "edit" | "plan") => void;
  tools?: ToolCall[];
  workflowStages?: WorkflowStage[];
  currentIteration?: number;
  maxIterations?: number;
  tokens?: { used: number; limit?: number };
  cost?: { current: number; limit?: number };
  messageCount?: number;
  sessionUptime?: number;
  virtualizeHistory?: boolean;
  screenReader?: boolean;
  timelineEvents?: any[];
  plan?: Plan | null;
  slashSuggestions?: SlashCommandListEntry[];
  choicePrompt?: {
    message: string;
    options: Array<{ label: string; value: string }>;
    defaultValue: string;
  };
  onChoiceSelect?: (value: string) => void;
  queuedMessages?: string[];
  queueMode?: "steer" | "followUp";
  onQueueModeChange?: (mode: "steer" | "followUp") => void;
}

// ============================================================================
// Constants
// ============================================================================

const SLASH_DEBOUNCE_MS = 150;
const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FILE_MAX_LINES = 30;
const SHELL_MAX_LINES = 20;
const GENERIC_MAX_CHARS = 400;

// ============================================================================
// Tool classification
// ============================================================================

function classifyTool(name: string): "file" | "shell" | "generic" {
  const lower = name.toLowerCase();
  if (/run_command|bash|exec|package_run_script/.test(lower)) return "shell";
  if (
    /read_file|read_folder|read_many|list_files|find_files|write_file|propose_edit|edit/.test(
      lower
    )
  )
    return "file";
  return "generic";
}

function stripToolHeader(content: string): string {
  return content.replace(/^Tool:\s*\S+\s*\n(?:Result[^\n]*:\s*)?\n?/i, "").trim();
}

function getFilePath(args?: Record<string, unknown>): string {
  if (!args) return "";
  const v = args.path ?? args.filePath ?? args.file ?? args.directory ?? args.filepath ?? "";
  return typeof v === "string" ? v : "";
}

function getCommand(args?: Record<string, unknown>): string {
  if (!args) return "";
  const v = args.command ?? args.cmd ?? args.script ?? args.args ?? "";
  return typeof v === "string" ? v : Array.isArray(v) ? v.join(" ") : "";
}

// ============================================================================
// Tool Block Components
// ============================================================================

const FileBlock: React.FC<{
  toolName: string;
  content: string;
  args?: Record<string, unknown>;
  isError?: boolean;
}> = React.memo(({ toolName, content, args, isError }) => {
  const lower = toolName.toLowerCase();
  const verb = lower.includes("write")
    ? "write"
    : lower.includes("list")
    ? "list"
    : lower.includes("edit")
    ? "edit"
    : "read";
  const filePath = getFilePath(args);
  const body = stripToolHeader(content);
  const lines = body.split("\n");
  const shown = lines.slice(0, FILE_MAX_LINES).join("\n");
  const extra = lines.length - FILE_MAX_LINES;

  return (
    <Box
      flexDirection="column"
      marginBottom={1}
      borderLeft={true}
      borderStyle="single"
      borderColor={isError ? "red" : "green"}
      paddingLeft={1}
    >
      <Text color={isError ? "red" : "green"}>
        {verb}
        {filePath ? " " + filePath : ""}
      </Text>
      {shown.trim() ? (
        <Text color="gray" dimColor>
          {shown}
        </Text>
      ) : null}
      {extra > 0 ? (
        <Text color="gray" dimColor>
          ... ({extra} more lines)
        </Text>
      ) : null}
    </Box>
  );
});

const ShellBlock: React.FC<{
  toolName: string;
  content: string;
  args?: Record<string, unknown>;
  isError?: boolean;
}> = React.memo(({ content, args, isError }) => {
  const command = getCommand(args);
  const body = stripToolHeader(content);
  const cols = process.stdout.columns || 80;
  const sep = "─".repeat(Math.min(cols - 4, 60));
  const lines = body.split("\n").filter((l) => l.trim());
  const shown = lines.slice(0, SHELL_MAX_LINES).join("\n");
  const extra = lines.length - SHELL_MAX_LINES;

  return (
    <Box flexDirection="column" marginBottom={1} marginTop={1}>
      <Text color="cyan" dimColor>
        {sep}
      </Text>
      {command ? (
        <Text color="cyan" bold>
          $ {command}
        </Text>
      ) : null}
      {shown.trim() ? (
        <Text color="gray" dimColor>
          {shown}
        </Text>
      ) : null}
      {extra > 0 ? (
        <Text color="gray" dimColor>
          ... ({extra} more lines)
        </Text>
      ) : null}
      {isError ? <Text color="red">(exited with error)</Text> : null}
    </Box>
  );
});

const GenericBlock: React.FC<{
  toolName: string;
  content: string;
  isError?: boolean;
}> = React.memo(({ toolName, content, isError }) => {
  const body = stripToolHeader(content);
  const truncated =
    body.length > GENERIC_MAX_CHARS
      ? body.slice(0, GENERIC_MAX_CHARS) +
        `\n… (${body.length - GENERIC_MAX_CHARS} more chars)`
      : body;
  const label = toolName.replace(/_/g, " ");

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box gap={1}>
        <Text color="magenta" dimColor>
          ▸
        </Text>
        <Text color="magenta">{label}</Text>
      </Box>
      {truncated.trim() ? (
        <Box paddingLeft={2}>
          <Text color={isError ? "red" : "gray"} dimColor={!isError}>
            {truncated}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
});

// ============================================================================
// Working Indicator
// ============================================================================

const WorkingIndicator: React.FC<{ isThinking: boolean; status?: string }> =
  ({ isThinking, status }) => {
    const [frame, setFrame] = useState(0);

    useEffect(() => {
      if (!isThinking) return;
      setFrame(0);
      const timer = setInterval(() => {
        setFrame((f) => (f + 1) % BRAILLE_FRAMES.length);
      }, 80);
      return () => clearInterval(timer);
    }, [isThinking]);

    if (!isThinking) return null;
    return (
      <Box paddingX={1} marginTop={1}>
        <Text color="yellow">{BRAILLE_FRAMES[frame]} </Text>
        <Text color="gray" dimColor>
          {status?.trim() || "Working..."}
        </Text>
      </Box>
    );
  };

// ============================================================================
// Code Block
// ============================================================================

const CodeBlock: React.FC<{ code: string; language?: string }> = React.memo(
  ({ code, language }) => (
    <Box flexDirection="column" paddingLeft={0}>
      {language ? (
        <Text color="dim" dimColor>
          {language}
        </Text>
      ) : null}
      <Box flexDirection="column" borderLeft={true} paddingLeft={2}>
        <Text color="white" dimColor>
          {code}
        </Text>
      </Box>
    </Box>
  ),
  (prev, next) => prev.code === next.code && prev.language === next.language
);

// ============================================================================
// Message View
// ============================================================================

const MessageView: React.FC<{ message: Message; isDraft?: boolean }> =
  React.memo(
    ({ message, isDraft = false }) => {
      const parseContent = (content: string) => {
        const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
        const parts: Array<{
          type: "text" | "code";
          content: string;
          language?: string;
        }> = [];
        let lastIndex = 0;
        let match;

        while ((match = codeBlockRegex.exec(content)) !== null) {
          if (match.index > lastIndex) {
            parts.push({ type: "text", content: content.slice(lastIndex, match.index) });
          }
          parts.push({ type: "code", content: match[2], language: match[1] });
          lastIndex = codeBlockRegex.lastIndex;
        }

        if (lastIndex < content.length) {
          parts.push({ type: "text", content: content.slice(lastIndex) });
        }

        return parts.length > 0 ? parts : [{ type: "text" as const, content }];
      };

      // Tool result blocks
      if (message.role === "tool") {
        const toolName = message.toolName || "unknown";
        const kind = classifyTool(toolName);
        if (kind === "file") {
          return (
            <FileBlock
              toolName={toolName}
              content={message.content}
              args={message.toolArgs}
              isError={message.isError}
            />
          );
        }
        if (kind === "shell") {
          return (
            <ShellBlock
              toolName={toolName}
              content={message.content}
              args={message.toolArgs}
              isError={message.isError}
            />
          );
        }
        return (
          <GenericBlock
            toolName={toolName}
            content={message.content}
            isError={message.isError}
          />
        );
      }

      // CoT (chain-of-thought / inter-turn reasoning) — italic muted, no header
      if (message.isCot) {
        const text = message.content.trim();
        if (!text) return null;
        return (
          <Box flexDirection="column" marginBottom={1} paddingLeft={1}>
            <Text italic dimColor>
              {text}
            </Text>
          </Box>
        );
      }

      // Streaming draft — show as italic muted inline (no header), matches pi agent style
      if (isDraft && message.role === "assistant") {
        const text = message.content.trim();
        return (
          <Box flexDirection="column" marginBottom={1} paddingLeft={1}>
            {text ? (
              <Text italic dimColor>
                {text}
              </Text>
            ) : (
              <Text dimColor>...</Text>
            )}
          </Box>
        );
      }

      const getColor = () => {
        switch (message.role) {
          case "user": return "cyan";
          case "assistant": return "green";
          case "system": return "yellow";
          default: return "white";
        }
      };

      const getName = () => {
        switch (message.role) {
          case "user": return "You";
          case "assistant": return "Meer";
          case "system": return "System";
          default: return message.role;
        }
      };

      const parts = useMemo(() => parseContent(message.content), [message.content]);
      const normalizedContent = message.content.trim();

      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box gap={1}>
            <Text color={getColor()} bold>
              {getName()}
            </Text>
            {message.timestamp && (
              <Text color="dim" dimColor>
                {formatTimestamp(message.timestamp)}
              </Text>
            )}
          </Box>
          <Box flexDirection="column" paddingLeft={2}>
            {normalizedContent.length === 0 && (
              <Text color="dim">...</Text>
            )}
            {parts.map((part, idx) =>
              part.type === "code" ? (
                <Box key={idx} marginTop={1} marginBottom={1}>
                  <CodeBlock
                    code={part.content}
                    language={"language" in part ? part.language : undefined}
                  />
                </Box>
              ) : part.content.trim().length > 0 ? (
                <Box key={idx}>
                  <Text>{part.content.trim()}</Text>
                </Box>
              ) : null
            )}
          </Box>
        </Box>
      );
    },
    (prev, next) =>
      prev.message.id === next.message.id &&
      prev.message.content === next.message.content &&
      prev.isDraft === next.isDraft
  );

const formatTimestamp = (timestamp?: number): string => {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const h = date.getHours().toString().padStart(2, "0");
  const m = date.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
};

// ============================================================================
// Input Area
// ============================================================================

const InputArea: React.FC<{
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  isThinking: boolean;
  queuedMessages: number;
  queuedPreview: string[];
  queueMode: "steer" | "followUp";
  mode?: "edit" | "plan";
  slashSuggestions: SlashCommandListEntry[];
  selectedSuggestion: number;
  choicePrompt?: {
    message: string;
    options: Array<{ label: string; value: string }>;
    defaultValue: string;
  };
  onChoiceSelect?: (value: string) => void;
}> = React.memo(
  ({
    value,
    onChange,
    onSubmit,
    placeholder,
    isThinking,
    queuedMessages,
    queuedPreview,
    queueMode,
    mode = "edit",
    slashSuggestions,
    selectedSuggestion,
    choicePrompt,
    onChoiceSelect,
  }) => (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      {queuedPreview.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="magenta">Queued</Text>
          {queuedPreview.slice(0, 3).map((msg, i) => (
            <Box key={`${i}-${msg}`} paddingLeft={2}>
              <Text color="dim">{truncateLine(msg, 90)}</Text>
            </Box>
          ))}
          {queuedMessages > queuedPreview.length && (
            <Box paddingLeft={2}>
              <Text color="dim">
                +{queuedMessages - queuedPreview.length} more queued
              </Text>
            </Box>
          )}
        </Box>
      )}
      <Box
        flexDirection="row"
        paddingX={1}
        paddingY={0}
        borderStyle="single"
        borderColor="gray"
      >
        <Text color={isThinking ? "yellow" : "white"} bold>
          ›
        </Text>
        <Text color="dim"> </Text>
        <Box flexGrow={1}>
          <TextInput
            value={value}
            onChange={onChange}
            onSubmit={onSubmit}
            placeholder={
              mode === "plan" ? "Ask for analysis and planning" : placeholder || "Explain this codebase"
            }
            showCursor={true}
          />
        </Box>
        {value.startsWith("/") && (
          <Box marginLeft={1}>
            <Text color="yellow">command</Text>
          </Box>
        )}
        {queuedMessages > 0 && (
          <Box marginLeft={1}>
            <Text color="magenta">queued {queuedMessages}</Text>
          </Box>
        )}
        {isThinking && (
          <Box marginLeft={1}>
            <Text color="cyan">
              {queueMode === "followUp" ? "follow-up" : "steer"}
            </Text>
          </Box>
        )}
      </Box>

      {choicePrompt && onChoiceSelect && (
        <InlineChoicePrompt
          message={choicePrompt.message}
          options={choicePrompt.options}
          defaultValue={choicePrompt.defaultValue}
          onSelect={onChoiceSelect}
        />
      )}

      {slashSuggestions.length > 0 && (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          <Text color="yellow">Commands</Text>
          {slashSuggestions.slice(0, 5).map((item, index) => {
            const badges = getSlashCommandBadges(item);
            const isSelected = index === selectedSuggestion;
            return (
              <Box key={item.command} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text color={isSelected ? "cyan" : "yellow"} bold={isSelected}>
                    {isSelected ? "▶" : "●"}
                  </Text>
                  <Text color={isSelected ? "cyan" : "white"} bold={isSelected}>
                    {item.command}
                  </Text>
                  {badges.length > 0 && (
                    <Text color="magenta" dimColor>
                      {" "}[{badges.join(", ")}]
                    </Text>
                  )}
                </Box>
                <Box paddingLeft={2}>
                  <Text color="gray" dimColor>
                    {item.description.substring(0, 60)}
                    {item.description.length > 60 ? "..." : ""}
                  </Text>
                </Box>
              </Box>
            );
          })}
          {slashSuggestions.length > 5 && (
            <Text color="dim" italic>
              ... and {slashSuggestions.length - 5} more commands
            </Text>
          )}
          <Text color="dim">Tab insert · ↑↓ navigate · Enter run</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="dim">
          Enter send · Esc interrupt · Ctrl+P mode · Ctrl+Q queue · Ctrl+C exit
        </Text>
      </Box>
    </Box>
  ),
  (prev, next) =>
    prev.value === next.value &&
    prev.isThinking === next.isThinking &&
    prev.slashSuggestions === next.slashSuggestions &&
    prev.selectedSuggestion === next.selectedSuggestion &&
    prev.queuedMessages === next.queuedMessages &&
    prev.queueMode === next.queueMode &&
    prev.queuedPreview.join("\n") === next.queuedPreview.join("\n")
);

// ============================================================================
// Footer Bar
// ============================================================================

const FooterBar: React.FC<{
  provider?: string;
  model?: string;
  cwd?: string;
  mode: "edit" | "plan";
  tokens?: { used: number; limit?: number };
  cost?: { current: number; limit?: number };
  messageCount?: number;
  sessionUptime?: number;
}> = React.memo(({ provider, model, cwd, mode, tokens, cost, messageCount, sessionUptime }) => {
  const location = cwd || process.cwd();
  const modeLabel = mode === "plan" ? "plan" : "edit";
  const tokenLabel = tokens?.used ? `${formatCompactNumber(tokens.used)} tok` : null;
  const costLabel = cost && cost.current > 0 ? `$${cost.current.toFixed(3)}` : null;
  const uptimeLabel = typeof sessionUptime === "number" ? formatDurationSeconds(sessionUptime) : null;

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text color="dim">{truncateLine(location, 140)}</Text>
      <Box justifyContent="space-between">
        <Box gap={2} flexShrink={1}>
          <Text color="cyan">Meer</Text>
          <Text color="dim">{provider || "unknown"}/{model || "unknown"}</Text>
          <Text color={mode === "plan" ? "blue" : "green"}>{modeLabel}</Text>
        </Box>
        <Box gap={2} flexShrink={0}>
          {tokenLabel && <Text color="dim">{tokenLabel}</Text>}
          {costLabel && <Text color="dim">{costLabel}</Text>}
          {typeof messageCount === "number" && <Text color="dim">{messageCount} msgs</Text>}
          {uptimeLabel && <Text color="dim">{uptimeLabel}</Text>}
        </Box>
      </Box>
    </Box>
  );
});

// ============================================================================
// Main Chat Component
// ============================================================================

export const MeerChat: React.FC<MeerChatProps> = ({
  onMessage,
  messages,
  draftAssistant,
  isThinking,
  status,
  provider,
  model,
  cwd,
  onExit,
  onInterrupt,
  mode: externalMode,
  onModeChange,
  tools,
  workflowStages,
  tokens,
  cost,
  messageCount,
  sessionUptime,
  virtualizeHistory = false,
  screenReader = false,
  plan,
  slashSuggestions: providedSlashSuggestions,
  choicePrompt,
  onChoiceSelect,
  queuedMessages: externalQueuedMessages,
  queueMode: externalQueueMode = "steer",
  onQueueModeChange,
}) => {
  const [input, setInput] = useState("");
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  const [internalMode, setInternalMode] = useState<"edit" | "plan">("edit");
  const [internalQueueMode, setInternalQueueMode] = useState<"steer" | "followUp">("steer");
  const [slashSuggestions, setSlashSuggestions] = useState<SlashCommandListEntry[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [scrollAnchor, setScrollAnchor] = useState<"end" | "manual">("end");
  const { exit } = useApp();

  const slashCommandEntries = useMemo(
    () =>
      providedSlashSuggestions && providedSlashSuggestions.length > 0
        ? providedSlashSuggestions
        : getAllCommands(),
    [providedSlashSuggestions]
  );

  const isScreenReader = Boolean(screenReader);
  const mode = externalMode !== undefined ? externalMode : internalMode;
  const queueMode =
    onQueueModeChange !== undefined ? externalQueueMode : internalQueueMode;
  const activeQueue = externalQueuedMessages ?? messageQueue;
  const queuedPreview = useMemo(() => activeQueue.slice(0, 3), [activeQueue]);
  const hasDraftContent = Boolean(draftAssistant?.content.trim());

  const toggleMode = useCallback(() => {
    const newMode: "edit" | "plan" = mode === "edit" ? "plan" : "edit";
    if (onModeChange) {
      onModeChange(newMode);
    } else {
      setInternalMode(newMode);
    }
  }, [mode, onModeChange]);

  const clearSlashSuggestions = useCallback(() => {
    setSlashSuggestions([]);
    setSelectedSuggestion(0);
  }, []);

  const updateSlashSuggestionsImmediate = useCallback(
    (value: string) => {
      const trimmed = value.trimStart();
      if (!trimmed.startsWith("/")) { clearSlashSuggestions(); return; }

      const firstSpace = trimmed.indexOf(" ");
      const commandToken = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
      const hasArguments = firstSpace !== -1 && trimmed.slice(firstSpace + 1).trim().length > 0;

      if (hasArguments) { clearSlashSuggestions(); return; }

      const normalized = commandToken.toLowerCase();
      const options =
        commandToken === "/"
          ? slashCommandEntries
          : slashCommandEntries.filter((e) => e.command.toLowerCase().startsWith(normalized));

      if (options.length === 0) { clearSlashSuggestions(); return; }

      setSlashSuggestions(options);
      setSelectedSuggestion((prev) => (prev < options.length ? prev : 0));
    },
    [clearSlashSuggestions, slashCommandEntries]
  );

  const updateSlashSuggestions = useMemo(
    () => debounce(updateSlashSuggestionsImmediate, { delay: SLASH_DEBOUNCE_MS }),
    [updateSlashSuggestionsImmediate]
  );

  const handleInputChange = useCallback(
    (value: string) => {
      setInput(value);
      updateSlashSuggestions(value);
    },
    [updateSlashSuggestions]
  );

  const sendMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (isThinking && externalQueuedMessages === undefined) {
        setMessageQueue((prev) => [...prev, trimmed]);
      } else {
        setScrollAnchor("end");
        onMessage(trimmed);
      }
    },
    [externalQueuedMessages, isThinking, onMessage]
  );

  const applySlashSuggestion = useCallback(
    (applyMode: "insert" | "send" = "insert") => {
      if (slashSuggestions.length === 0) return;
      const suggestion = slashSuggestions[selectedSuggestion];
      if (applyMode === "send") {
        clearSlashSuggestions();
        handleInputChange("");
        sendMessage(suggestion.command);
        return;
      }
      setInput(`${suggestion.command} `);
      clearSlashSuggestions();
    },
    [clearSlashSuggestions, handleInputChange, sendMessage, slashSuggestions, selectedSuggestion]
  );

  const hasSlashSuggestions = slashSuggestions.length > 0;
  const hasChoicePrompt =
    Boolean(choicePrompt) &&
    Boolean(onChoiceSelect) &&
    (choicePrompt?.options.length ?? 0) > 0;

  const terminalHeight =
    process.stdout.isTTY && process.stdout.rows ? process.stdout.rows : 24;

  const maxVisibleMessages = useMemo(() => {
    if (!virtualizeHistory) return Number.POSITIVE_INFINITY;
    return Math.max(terminalHeight * 4, 200);
  }, [virtualizeHistory, terminalHeight]);

  const { visibleMessages, hiddenCount } = useMemo(() => {
    if (!virtualizeHistory) return { visibleMessages: messages, hiddenCount: 0 };
    if (!Number.isFinite(maxVisibleMessages) || messages.length <= maxVisibleMessages) {
      return { visibleMessages: messages, hiddenCount: 0 };
    }
    return {
      visibleMessages: messages.slice(-maxVisibleMessages),
      hiddenCount: messages.length - maxVisibleMessages,
    };
  }, [messages, virtualizeHistory, maxVisibleMessages]);

  const scrollWindowSize = Math.max(1, Math.min(visibleMessages.length, terminalHeight * 3));
  const maxScrollOffset = Math.max(0, visibleMessages.length - scrollWindowSize);

  useEffect(() => {
    if (!virtualizeHistory || scrollAnchor === "end") {
      setScrollOffset(maxScrollOffset);
      return;
    }
    setScrollOffset((prev) => Math.max(0, Math.min(prev, maxScrollOffset)));
  }, [virtualizeHistory, scrollAnchor, maxScrollOffset, visibleMessages.length]);

  useEffect(() => {
    if (!virtualizeHistory) {
      setScrollAnchor("end");
      setScrollOffset(0);
    }
  }, [virtualizeHistory]);

  const adjustScroll = useCallback(
    (delta: number) => {
      if (!virtualizeHistory) return;
      setScrollAnchor("manual");
      setScrollOffset((prev) => Math.max(0, Math.min(prev + delta, maxScrollOffset)));
    },
    [virtualizeHistory, maxScrollOffset]
  );

  const jumpToLatest = useCallback(() => {
    setScrollAnchor("end");
    setScrollOffset(maxScrollOffset);
  }, [maxScrollOffset]);

  useInput(
    (inputKey, key) => {
      if (key.ctrl && inputKey === "c") { onExit?.(); exit(); return; }
      if (key.ctrl && inputKey === "p") { toggleMode(); return; }
      if (key.ctrl && inputKey === "q") {
        const nextMode: "steer" | "followUp" =
          queueMode === "steer" ? "followUp" : "steer";
        if (onQueueModeChange) {
          onQueueModeChange(nextMode);
        } else {
          setInternalQueueMode(nextMode);
        }
        return;
      }

      if (key.escape) {
        if (hasSlashSuggestions) { clearSlashSuggestions(); return; }
        if (isThinking && onInterrupt) { onInterrupt(); return; }
      }

      if (hasSlashSuggestions) {
        if (key.tab) { applySlashSuggestion("insert"); return; }
        if (key.upArrow) {
          setSelectedSuggestion((prev) => (prev - 1 + slashSuggestions.length) % slashSuggestions.length);
          return;
        }
        if (key.downArrow) {
          setSelectedSuggestion((prev) => (prev + 1) % slashSuggestions.length);
          return;
        }
      }

      if (!virtualizeHistory || hasSlashSuggestions) return;

      if (key.pageUp) { adjustScroll(-Math.max(1, Math.floor(scrollWindowSize * 0.75))); return; }
      if (key.pageDown) { adjustScroll(Math.max(1, Math.floor(scrollWindowSize * 0.75))); return; }
      if (key.home) { setScrollAnchor("manual"); setScrollOffset(0); return; }
      if (key.end) { jumpToLatest(); }
    },
    { isActive: !hasChoicePrompt }
  );

  const handleSubmit = useCallback(() => {
    const trimmed = input.trim();
    const commandToken = trimmed.split(/\s+/)[0] ?? "";
    const suggestion = slashSuggestions[selectedSuggestion];
    const shouldApplySlash =
      hasSlashSuggestions &&
      commandToken.startsWith("/") &&
      trimmed === commandToken &&
      suggestion &&
      suggestion.command.toLowerCase().startsWith(commandToken.toLowerCase());

    if (shouldApplySlash) { applySlashSuggestion("send"); return; }
    if (!trimmed) return;

    sendMessage(trimmed);
    handleInputChange("");
  }, [applySlashSuggestion, handleInputChange, input, hasSlashSuggestions, sendMessage, selectedSuggestion, slashSuggestions]);

  useEffect(() => {
    if (externalQueuedMessages !== undefined) {
      return;
    }
    if (!isThinking && messageQueue.length > 0) {
      const nextMessage = messageQueue[0];
      setMessageQueue((prev) => prev.slice(1));
      onMessage(nextMessage);
    }
  }, [externalQueuedMessages, isThinking, messageQueue, onMessage]);

  if (isScreenReader) {
    return (
      <ScreenReaderLayout
        provider={provider}
        model={model}
        cwd={cwd}
        mode={mode}
        status={status}
        isThinking={isThinking}
        tokens={tokens}
        cost={cost}
        hiddenCount={hiddenCount}
        totalMessages={messages.length}
        tools={tools}
        workflowStages={workflowStages}
        messages={visibleMessages}
        plan={plan}
      >
        <InputArea
          value={input}
          onChange={handleInputChange}
          onSubmit={handleSubmit}
          isThinking={isThinking}
          queuedMessages={activeQueue.length}
          queuedPreview={queuedPreview}
          queueMode={queueMode}
          mode={mode}
          slashSuggestions={slashSuggestions}
          selectedSuggestion={selectedSuggestion}
          choicePrompt={choicePrompt}
          onChoiceSelect={onChoiceSelect}
        />
      </ScreenReaderLayout>
    );
  }

  const displayMessages =
    draftAssistant && hasDraftContent
      ? [...visibleMessages, draftAssistant]
      : visibleMessages;

  const displayWindowSize = Math.max(1, Math.min(displayMessages.length, terminalHeight * 3));

  return (
    <Box flexDirection="column" height="100%" width="100%">
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0}>
        {messages.length === 0 ? (
          <Box flexDirection="column" alignItems="center" justifyContent="center" paddingY={2}>
            <Text color="gray" dimColor>
              Welcome to Meer AI. Type a message to get started.
            </Text>
            <Text color="gray" dimColor>
              Type / for slash commands (e.g., /help, /model, /setup)
            </Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            {hiddenCount > 0 && (
              <Box marginBottom={1} marginLeft={2}>
                <Text color="gray" dimColor>
                  Showing last {visibleMessages.length} of {messages.length} messages.
                </Text>
              </Box>
            )}
            <Box flexDirection="row">
              <Box flexGrow={1}>
                <VirtualizedList
                  items={displayMessages}
                  scroll={{
                    offset: scrollOffset,
                    windowSize: displayWindowSize,
                    totalCount: displayMessages.length,
                  }}
                  renderGap={(position, hidden) => (
                    <Box marginY={1} paddingLeft={2}>
                      <Text color="dim">
                        {position === "top"
                          ? `${hidden} earlier message${hidden === 1 ? "" : "s"}`
                          : `${hidden} later message${hidden === 1 ? "" : "s"}`}
                      </Text>
                    </Box>
                  )}
                  renderItem={(msg) => (
                    <MessageView
                      message={msg}
                      isDraft={Boolean(draftAssistant && msg.id === draftAssistant.id)}
                    />
                  )}
                />
              </Box>
              {virtualizeHistory && displayMessages.length > 0 && (
                <Box marginLeft={1}>
                  <ScrollIndicator
                    offset={scrollOffset}
                    windowSize={displayWindowSize}
                    totalCount={displayMessages.length}
                  />
                </Box>
              )}
            </Box>
            {virtualizeHistory && scrollAnchor === "manual" && (
              <Box marginLeft={2}>
                <Text color="gray" dimColor>
                  PageUp/PageDown to scroll · End for latest
                </Text>
              </Box>
            )}
          </Box>
        )}
      </Box>

      <WorkingIndicator isThinking={isThinking} status={status} />

      <InputArea
        value={input}
        onChange={handleInputChange}
        onSubmit={handleSubmit}
        isThinking={isThinking}
        queuedMessages={activeQueue.length}
        queuedPreview={queuedPreview}
        queueMode={queueMode}
        mode={mode}
        slashSuggestions={slashSuggestions}
        selectedSuggestion={selectedSuggestion}
        choicePrompt={choicePrompt}
        onChoiceSelect={onChoiceSelect}
      />

      <FooterBar
        provider={provider}
        model={model}
        cwd={cwd}
        mode={mode}
        tokens={tokens}
        cost={cost}
        messageCount={messageCount}
        sessionUptime={sessionUptime}
      />
    </Box>
  );
};

// ============================================================================
// Inline Choice Prompt
// ============================================================================

const InlineChoicePrompt: React.FC<{
  message: string;
  options: Array<{ label: string; value: string }>;
  defaultValue: string;
  onSelect: (value: string) => void;
}> = ({ message, options, defaultValue, onSelect }) => {
  const items = useMemo(
    () => options.map((o) => ({ label: o.label, value: o.value })),
    [options]
  );
  const initialIndex = useMemo(() => {
    const idx = options.findIndex((o) => o.value === defaultValue);
    return idx >= 0 ? idx : 0;
  }, [defaultValue, options]);

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={2}>
      <Text color="yellow">{message}</Text>
      <Text color="dim">↑↓ navigate · Enter select</Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          initialIndex={initialIndex}
          onSelect={(item) => onSelect(String(item.value))}
        />
      </Box>
    </Box>
  );
};

// ============================================================================
// Screen Reader Layout
// ============================================================================

const ScreenReaderLayout: React.FC<{
  provider?: string;
  model?: string;
  cwd?: string;
  mode: "edit" | "plan";
  status?: string;
  isThinking: boolean;
  tokens?: { used: number; limit?: number };
  cost?: { current: number; limit?: number };
  hiddenCount: number;
  totalMessages: number;
  tools?: ToolCall[];
  workflowStages?: WorkflowStage[];
  messages: Message[];
  plan?: Plan | null;
  children: React.ReactNode;
}> = ({
  provider, model, cwd, mode, status, isThinking, tokens, cost,
  hiddenCount, totalMessages, tools, workflowStages, messages, plan, children,
}) => {
  const modeLabel = mode === "plan" ? "Plan" : "Edit";

  return (
    <Box flexDirection="column" gap={1}>
      <Text color="cyan" bold>Screen reader mode enabled</Text>
      <Text>Profile: {provider ?? "unknown"} / {model ?? "unknown"} · Mode: {modeLabel}</Text>
      <Text>Directory: {cwd ?? process.cwd()}</Text>
      {tokens && <Text>Tokens: {tokens.used}{tokens.limit ? ` / ${tokens.limit}` : ""}</Text>}
      {cost && cost.current > 0 && <Text>Cost: ${cost.current.toFixed(4)}</Text>}
      {tools && tools.length > 0 && (
        <Text>Active tools: {tools.map((t) => t.name ?? "tool").join(", ")}</Text>
      )}
      {workflowStages && workflowStages.length > 0 && (
        <Box flexDirection="column">
          <Text>Workflow:</Text>
          {workflowStages.map((s, i) => (
            <Text key={s.name}>{i + 1}. {s.name} - {s.status}</Text>
          ))}
        </Box>
      )}
      {plan && (
        <Box flexDirection="column">
          <Text>Plan: {plan.title}</Text>
          {plan.tasks.slice(0, 5).map((task, i) => (
            <Text key={task.id}>{i + 1}. {task.description} - {task.status}</Text>
          ))}
          {plan.tasks.length > 5 && <Text color="dim">+{plan.tasks.length - 5} more</Text>}
        </Box>
      )}
      <Box flexDirection="column">
        {messages.length === 0 ? (
          <Text>No messages yet.</Text>
        ) : (
          messages.map((msg, i) => (
            <Text key={i}>
              {formatTimestamp(msg.timestamp) ? `[${formatTimestamp(msg.timestamp)}] ` : ""}
              {msg.role === "assistant" ? "Meer" : msg.role === "user" ? "You" : msg.role === "system" ? "System" : "Tool"}:{" "}
              {msg.content?.replace(/\s+/g, " ").trim() || "[empty]"}
            </Text>
          ))
        )}
        {hiddenCount > 0 && (
          <Text dimColor>Showing {messages.length} of {totalMessages} messages.</Text>
        )}
        {isThinking && <Text>Assistant is thinking…</Text>}
        {status && !isThinking && <Text>Status: {status}</Text>}
      </Box>
      {children}
    </Box>
  );
};

// ============================================================================
// Utilities
// ============================================================================

function truncateLine(value: string, maxLength: number): string {
  const s = value.replace(/\s+/g, " ").trim();
  return s.length <= maxLength ? s : `${s.slice(0, maxLength - 1)}…`;
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatDurationSeconds(value: number): string {
  const total = Math.max(0, Math.floor(value));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}

export default MeerChat;
