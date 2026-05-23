/**
 * MeerChatV2 - Production-ready TUI component
 * Optimized with Context API, memoization, and smooth UX
 */

import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import { Box, Text, useInput, useApp } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";
import {
  getAllCommands,
  type SlashCommandListEntry,
} from "../../slash/registry.js";
import { getSlashCommandBadges } from "../../slash/utils.js";
import type { Plan } from "../../plan/types.js";
import { ToolExecutionPanel, type ToolCall } from "./components/tools/index.js";
import { PlanPanel } from "./components/plan/index.js";
import type { WorkflowStage } from "./components/workflow/index.js";
import { VirtualizedList, ScrollIndicator } from "./components/shared/index.js";
import type { Message } from "./contexts/ChatContext.js";
import { debounce } from "./utils/debounce.js";

// ============================================================================
// Types
// ============================================================================

export interface MeerChatV2Props {
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
  tokens?: {
    used: number;
    limit?: number;
  };
  cost?: {
    current: number;
    limit?: number;
  };
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
}

// ============================================================================
// Constants
// ============================================================================

const SCROLL_WINDOW_SIZE = 20;
const MAX_HISTORY_SIZE = 500;
const STREAM_DEBOUNCE_MS = 50;
const SLASH_DEBOUNCE_MS = 150;

// ============================================================================
// Helper Components (Memoized)
// ============================================================================

// Code Block Component - Optimized with memo
const CodeBlock: React.FC<{ code: string; language?: string }> = React.memo(
  ({ code, language }) => {
    const getLanguageIcon = (lang?: string): string => {
      if (!lang) return "📄";
      const lower = lang.toLowerCase();
      if (lower.includes("typescript") || lower === "ts") return "🔷";
      if (lower.includes("javascript") || lower === "js") return "🟨";
      if (lower.includes("python") || lower === "py") return "🐍";
      if (lower.includes("rust") || lower === "rs") return "🦀";
      if (lower.includes("go")) return "🔵";
      if (lower.includes("java")) return "☕";
      if (lower.includes("c++") || lower === "cpp") return "⚡";
      if (lower.includes("shell") || lower === "bash" || lower === "sh")
        return "🐚";
      if (lower.includes("json")) return "📦";
      if (lower.includes("yaml") || lower === "yml") return "📋";
      return "📝";
    };

    return (
      <Box flexDirection="column" paddingLeft={0}>
        {language && (
          <Box marginBottom={0}>
            <Text color="dim" dimColor>
              {getLanguageIcon(language)} {language}
            </Text>
          </Box>
        )}
        <Box
          flexDirection="column"
          borderLeft={true}
          paddingLeft={2}
          marginTop={language ? 0 : 0}
        >
          <Text color="white" dimColor>
            {code}
          </Text>
        </Box>
      </Box>
    );
  },
  (prev, next) => prev.code === next.code && prev.language === next.language
);

// Tool Call Component - Optimized with memo
const ToolCallView: React.FC<{ toolName: string; content: string }> =
  React.memo(
    ({ toolName, content }) => {
      const getToolIcon = (name: string): string => {
        const lower = name.toLowerCase();
        if (lower.includes("read") || lower.includes("file")) return "📖";
        if (lower.includes("write") || lower.includes("edit")) return "✍️";
        if (lower.includes("bash") || lower.includes("exec")) return "⚡";
        if (lower.includes("search") || lower.includes("grep")) return "🔍";
        if (lower.includes("web") || lower.includes("fetch")) return "🌐";
        if (lower.includes("task") || lower.includes("agent")) return "🤖";
        return "🛠️";
      };

      const displayContent =
        content.length > 200
          ? `${content.substring(0, 200)}... (${content.length} chars total)`
          : content;

      return (
        <Box
          flexDirection="column"
          marginTop={1}
          marginBottom={2}
          paddingLeft={0}
        >
          <Box gap={1}>
            <Text color="magenta">▎</Text>
            <Box gap={1}>
              <Text color="magenta">{getToolIcon(toolName)}</Text>
              <Text color="magenta" bold>
                {toolName}
              </Text>
            </Box>
          </Box>
          <Box paddingLeft={2} marginTop={0}>
            <Text color="dim" dimColor>
              {displayContent}
            </Text>
          </Box>
        </Box>
      );
    },
    (prev, next) =>
      prev.toolName === next.toolName && prev.content === next.content
  );

// Message Component - Optimized with memo
const MessageView: React.FC<{ message: Message; isDraft?: boolean }> = React.memo(
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
          parts.push({
            type: "text",
            content: content.slice(lastIndex, match.index),
          });
        }
        parts.push({ type: "code", content: match[2], language: match[1] });
        lastIndex = codeBlockRegex.lastIndex;
      }

      if (lastIndex < content.length) {
        parts.push({ type: "text", content: content.slice(lastIndex) });
      }

      return parts.length > 0 ? parts : [{ type: "text", content }];
    };

    const parts = useMemo(
      () => parseContent(message.content),
      [message.content]
    );

    if (message.role === "tool") {
      return (
        <ToolCallView
          toolName={message.toolName || "unknown"}
          content={message.content}
        />
      );
    }

    const getIcon = () => {
      switch (message.role) {
        case "user":
          return "You";
        case "assistant":
          return "Meer";
        case "system":
          return "System";
        default:
          return message.toolName || "Tool";
      }
    };

    const getColor = () => {
      switch (message.role) {
        case "user":
          return "cyan";
        case "assistant":
          return "green";
        case "system":
          return "yellow";
        default:
          return "white";
      }
    };

    const getName = () => {
      switch (message.role) {
        case "user":
          return "You";
        case "assistant":
          return "Meer";
        case "system":
          return "System";
        default:
          return message.role;
      }
    };

    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box gap={1}>
          <Text color={getColor()} bold>
            {getIcon()}
          </Text>
          <Text color={getColor()} bold>
            {getName()}
          </Text>
          {isDraft && (
            <Text color="dim" dimColor>
              streaming
            </Text>
          )}
          {message.timestamp && (
            <Text color="dim" dimColor>
              {formatTimestamp(message.timestamp)}
            </Text>
          )}
        </Box>
        <Box flexDirection="column" paddingLeft={2}>
          {parts.map((part, idx) =>
            part.type === "code" ? (
              <Box key={idx} marginTop={1} marginBottom={1}>
                <CodeBlock
                  code={part.content}
                  language={"language" in part ? part.language : undefined}
                />
              </Box>
            ) : (
              <Box key={idx} marginTop={0}>
                <Text>{part.content.trim()}</Text>
              </Box>
            )
          )}
        </Box>
      </Box>
    );
  },
  (prev, next) =>
    prev.message.id === next.message.id &&
    prev.message.content === next.message.content
);

const formatTimestamp = (timestamp?: number): string => {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
};

// Thinking Indicator - Memoized
const ThinkingIndicator: React.FC = React.memo(() => {
  const [dots, setDots] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setDots((prev) => (prev + 1) % 4);
    }, 500);
    return () => clearInterval(interval);
  }, []);

  const messages = ["Thinking", "Processing", "Analyzing", "Working"];
  const currentMessage =
    messages[Math.floor(Date.now() / 2000) % messages.length];

  return (
    <Box marginBottom={2} marginTop={1} paddingLeft={0}>
      <Box gap={1}>
        <Text color="cyan">▎</Text>
        <Text color="cyan">
          <Spinner type="dots" />
        </Text>
        <Text color="cyan" dimColor>
          {currentMessage}
          {".".repeat(dots)}
        </Text>
      </Box>
    </Box>
  );
});

// Input Component - Optimized with memo
const InputArea: React.FC<{
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  isThinking: boolean;
  queuedMessages: number;
  queuedPreview: string[];
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
    mode = "edit",
    slashSuggestions,
    selectedSuggestion,
    choicePrompt,
    onChoiceSelect,
  }) => {
    const getPlaceholder = () => {
      if (mode === "plan") {
        return "Ask for analysis and planning... (read-only mode)";
      }
      return placeholder || "Type a message... (/ for commands)";
    };

    const getModeHint = () => {
      if (mode === "plan") {
        return "📋 Plan Mode: AI will analyze and plan without making changes";
      }
      return "✏️ Edit Mode: AI can read and modify files";
    };

    return (
      <Box flexDirection="column" marginTop={1} paddingX={1}>
        {queuedPreview.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text color="magenta">Queued</Text>
            {queuedPreview.slice(0, 3).map((message, index) => (
              <Box key={`${index}-${message}`} paddingLeft={2}>
                <Text color="dim">
                  {truncateLine(message, 90)}
                </Text>
              </Box>
            ))}
            {queuedMessages > queuedPreview.length && (
              <Box paddingLeft={2}>
                <Text color="dim">
                  +{queuedMessages - queuedPreview.length} more queued message
                  {queuedMessages - queuedPreview.length === 1 ? "" : "s"}
                </Text>
              </Box>
            )}
          </Box>
        )}
        <Box gap={2}>
          <Text color={mode === "plan" ? "blue" : "green"}>
            {mode === "plan" ? "plan" : "edit"}
          </Text>
          {value.startsWith("/") && <Text color="yellow">command</Text>}
          {isThinking && <Text color="yellow">thinking</Text>}
          {queuedMessages > 0 && <Text color="magenta">queued {queuedMessages}</Text>}
        </Box>
        <Box flexDirection="row">
          <Text color={isThinking ? "yellow" : "cyan"} bold>
            {isThinking ? "…" : "›"}{" "}
          </Text>
          <Box flexGrow={1}>
            <TextInput
              value={value}
              onChange={onChange}
              onSubmit={onSubmit}
              placeholder={getPlaceholder()}
              showCursor={!isThinking}
            />
          </Box>
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
            <Box flexDirection="column">
              {slashSuggestions.slice(0, 5).map((item, index) => {
                const badges = getSlashCommandBadges(item);
                const isSelected = index === selectedSuggestion;
                return (
                  <Box key={item.command}>
                    <Box flexDirection="row" gap={1}>
                      <Text
                        color={isSelected ? "cyan" : "yellow"}
                        bold={isSelected}
                      >
                        {isSelected ? "▶" : "●"}
                      </Text>
                      <Text
                        color={isSelected ? "cyan" : "white"}
                        bold={isSelected}
                      >
                        {item.command}
                      </Text>
                      {badges.length > 0 && (
                        <Text color="magenta" dimColor>
                          {" "}
                          [{badges.join(", ")}]
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
                <Box>
                  <Text color="dim" italic>
                    ... and {slashSuggestions.length - 5} more commands
                  </Text>
                </Box>
              )}
            </Box>
            <Text color="dim">Tab insert · ↑↓ navigate · Enter run</Text>
          </Box>
        )}

        <Text color="dim">
          Enter send · Esc interrupt · Ctrl+P mode · Ctrl+C exit
        </Text>
      </Box>
    );
  },
  (prev, next) =>
    prev.value === next.value && prev.isThinking === next.isThinking
);

// Status Bar - Memoized
const StatusBar: React.FC<{ status?: string }> = React.memo(({ status }) => {
  if (!status) return null;

  return (
    <Box paddingX={1} marginBottom={1}>
      <Text color="yellow">
        <Spinner type="dots" />
      </Text>
      <Text color="yellow"> {status}</Text>
    </Box>
  );
});

const FooterBar: React.FC<{
  provider?: string;
  model?: string;
  cwd?: string;
  mode: "edit" | "plan";
  tokens?: {
    used: number;
    limit?: number;
  };
  cost?: {
    current: number;
    limit?: number;
  };
  messageCount?: number;
  sessionUptime?: number;
  liveResponseVisible: boolean;
}> = React.memo(({
  provider,
  model,
  cwd,
  mode,
  tokens,
  cost,
  messageCount,
  sessionUptime,
  liveResponseVisible,
}) => {
  const location = cwd || process.cwd();
  const modeLabel = mode === "plan" ? "plan" : "edit";
  const tokenLabel = tokens?.used ? `${formatCompactNumber(tokens.used)} tok` : null;
  const costLabel =
    cost && cost.current > 0 ? `$${cost.current.toFixed(3)}` : null;
  const uptimeLabel =
    typeof sessionUptime === "number" ? formatDurationSeconds(sessionUptime) : null;

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text color="dim">{truncateLine(location, 140)}</Text>
      <Box justifyContent="space-between">
        <Box gap={2} flexShrink={1}>
          <Text color="cyan">Meer</Text>
          <Text color="dim">{provider || "unknown"}/{model || "unknown"}</Text>
          <Text color={mode === "plan" ? "blue" : "green"}>{modeLabel}</Text>
          <Text color="dim">live {liveResponseVisible ? "on" : "off"}</Text>
        </Box>
        <Box gap={2} flexShrink={0}>
          {tokenLabel && <Text color="dim">{tokenLabel}</Text>}
          {costLabel && <Text color="dim">{costLabel}</Text>}
          {typeof messageCount === "number" && <Text color="dim">{messageCount} msgs</Text>}
          {uptimeLabel && <Text color="dim">{uptimeLabel}</Text>}
        </Box>
      </Box>
      <Text color="dim">
        Enter send · Esc interrupt · Ctrl+P mode · Ctrl+T live response · Ctrl+C exit
      </Text>
    </Box>
  );
});

// ============================================================================
// Main Chat Component
// ============================================================================

export const MeerChatV2: React.FC<MeerChatV2Props> = ({
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
  currentIteration,
  maxIterations,
  tokens,
  cost,
  messageCount,
  sessionUptime,
  virtualizeHistory = false,
  screenReader = false,
  timelineEvents,
  plan,
  slashSuggestions: providedSlashSuggestions,
  choicePrompt,
  onChoiceSelect,
}) => {
  const [input, setInput] = useState("");
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  const [internalMode, setInternalMode] = useState<"edit" | "plan">("edit");
  const [slashSuggestions, setSlashSuggestions] = useState<
    SlashCommandListEntry[]
  >([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [showLiveResponse, setShowLiveResponse] = useState(true);
  const { exit } = useApp();
  const slashCommandEntries = useMemo(
    () =>
      providedSlashSuggestions && providedSlashSuggestions.length > 0
        ? providedSlashSuggestions
        : getAllCommands(),
    [providedSlashSuggestions]
  );
  const isScreenReader = Boolean(screenReader);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [scrollAnchor, setScrollAnchor] = useState<"end" | "manual">("end");

  const mode = externalMode !== undefined ? externalMode : internalMode;
  const queuedPreview = useMemo(() => messageQueue.slice(0, 3), [messageQueue]);

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

  // Debounced slash suggestions update
  const updateSlashSuggestionsImmediate = useCallback(
    (value: string) => {
      const trimmedLeading = value.trimStart();

      if (!trimmedLeading.startsWith("/")) {
        clearSlashSuggestions();
        return;
      }

      const firstSpace = trimmedLeading.indexOf(" ");
      const commandToken =
        firstSpace === -1
          ? trimmedLeading
          : trimmedLeading.slice(0, firstSpace);
      const hasArguments =
        firstSpace !== -1 &&
        trimmedLeading.slice(firstSpace + 1).trim().length > 0;

      if (hasArguments) {
        clearSlashSuggestions();
        return;
      }

      const normalized = commandToken.toLowerCase();
      const options =
        commandToken === "/"
          ? slashCommandEntries
          : slashCommandEntries.filter((entry) =>
              entry.command.toLowerCase().startsWith(normalized)
            );

      if (options.length === 0) {
        clearSlashSuggestions();
        return;
      }

      setSlashSuggestions(options);
      setSelectedSuggestion((prev) => (prev < options.length ? prev : 0));
    },
    [clearSlashSuggestions, slashCommandEntries]
  );

  const updateSlashSuggestions = useMemo(
    () =>
      debounce(updateSlashSuggestionsImmediate, { delay: SLASH_DEBOUNCE_MS }),
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
      if (!trimmed) {
        return;
      }

      if (isThinking) {
        setMessageQueue((prev) => [...prev, trimmed]);
      } else {
        setScrollAnchor("end");
        onMessage(trimmed);
      }
    },
    [isThinking, onMessage]
  );

  const applySlashSuggestion = useCallback(
    (mode: "insert" | "send" = "insert") => {
      if (slashSuggestions.length === 0) return;
      const suggestion = slashSuggestions[selectedSuggestion];

      if (mode === "send") {
        clearSlashSuggestions();
        handleInputChange("");
        sendMessage(suggestion.command);
        return;
      }

      setInput(`${suggestion.command} `);
      clearSlashSuggestions();
    },
    [
      clearSlashSuggestions,
      handleInputChange,
      sendMessage,
      slashSuggestions,
      selectedSuggestion,
    ]
  );

  const hasSlashSuggestions = slashSuggestions.length > 0;
  const hasChoicePrompt =
    Boolean(choicePrompt) &&
    Boolean(onChoiceSelect) &&
    (choicePrompt?.options.length ?? 0) > 0;

  // Handle keyboard shortcuts
  useInput((inputKey, key) => {
    if (key.ctrl && inputKey === "c") {
      onExit?.();
      exit();
      return;
    }
    if (key.ctrl && inputKey === "p") {
      toggleMode();
      return;
    }
    if (key.ctrl && inputKey === "t") {
      setShowLiveResponse((prev) => !prev);
      return;
    }

    if (key.escape) {
      if (hasSlashSuggestions) {
        clearSlashSuggestions();
        return;
      }
      if (isThinking && onInterrupt) {
        onInterrupt();
        return;
      }
    }

    if (hasSlashSuggestions) {
      if (key.tab) {
        applySlashSuggestion("insert");
        return;
      }
      if (key.upArrow) {
        setSelectedSuggestion(
          (prev) =>
            (prev - 1 + slashSuggestions.length) % slashSuggestions.length
        );
        return;
      }
      if (key.downArrow) {
        setSelectedSuggestion((prev) => (prev + 1) % slashSuggestions.length);
        return;
      }
    }

    if (!virtualizeHistory || hasSlashSuggestions) {
      return;
    }

    if (key.pageUp) {
      adjustScroll(-Math.max(1, Math.floor(scrollWindowSize * 0.75)));
      return;
    }

    if (key.pageDown) {
      adjustScroll(Math.max(1, Math.floor(scrollWindowSize * 0.75)));
      return;
    }

    if (key.home) {
      setScrollAnchor("manual");
      setScrollOffset(0);
      return;
    }

    if (key.end) {
      jumpToLatest();
    }
  }, { isActive: !hasChoicePrompt });

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

    if (shouldApplySlash) {
      applySlashSuggestion("send");
      return;
    }

    if (!trimmed) {
      return;
    }

    if (isThinking) {
      handleInputChange("");
      sendMessage(trimmed);
      return;
    }

    sendMessage(trimmed);
    handleInputChange("");
  }, [
    applySlashSuggestion,
    handleInputChange,
    input,
    isThinking,
    hasSlashSuggestions,
    sendMessage,
    selectedSuggestion,
    slashSuggestions,
  ]);

  // Process queued messages when agent finishes
  useEffect(() => {
    if (!isThinking && messageQueue.length > 0) {
      const nextMessage = messageQueue[0];
      setMessageQueue((prev) => prev.slice(1));
      onMessage(nextMessage);
    }
  }, [isThinking, messageQueue, onMessage]);

  const terminalHeight =
    process.stdout.isTTY && process.stdout.rows ? process.stdout.rows : 24;

  const maxVisibleMessages = useMemo(() => {
    if (!virtualizeHistory) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.max(terminalHeight * 4, 200);
  }, [virtualizeHistory, terminalHeight]);

  const { visibleMessages, hiddenCount } = useMemo(() => {
    if (!virtualizeHistory) {
      return { visibleMessages: messages, hiddenCount: 0 };
    }
    if (
      !Number.isFinite(maxVisibleMessages) ||
      messages.length <= maxVisibleMessages
    ) {
      return { visibleMessages: messages, hiddenCount: 0 };
    }
    return {
      visibleMessages: messages.slice(-maxVisibleMessages),
      hiddenCount: messages.length - maxVisibleMessages,
    };
  }, [messages, virtualizeHistory, maxVisibleMessages]);

  const scrollWindowSize = Math.max(
    1,
    Math.min(visibleMessages.length, terminalHeight * 3)
  );
  const maxScrollOffset = Math.max(
    0,
    Math.max(0, visibleMessages.length - scrollWindowSize)
  );

  useEffect(() => {
    if (!virtualizeHistory || scrollAnchor === "end") {
      setScrollOffset(maxScrollOffset);
      return;
    }
    setScrollOffset((prev) => Math.max(0, Math.min(prev, maxScrollOffset)));
  }, [
    virtualizeHistory,
    scrollAnchor,
    maxScrollOffset,
    visibleMessages.length,
  ]);

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
      setScrollOffset((prev) =>
        Math.max(0, Math.min(prev + delta, maxScrollOffset))
      );
    },
    [virtualizeHistory, maxScrollOffset]
  );

  const jumpToLatest = useCallback(() => {
    setScrollAnchor("end");
    setScrollOffset(maxScrollOffset);
  }, [maxScrollOffset]);

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
        queuedMessages={messageQueue.length}
        queuedPreview={queuedPreview}
        mode={mode}
        slashSuggestions={slashSuggestions}
        selectedSuggestion={selectedSuggestion}
        choicePrompt={choicePrompt}
        onChoiceSelect={onChoiceSelect}
      />
    </ScreenReaderLayout>
  );
  }

  return (
    <Box flexDirection="column" height="100%" width="100%">
      {plan && plan.tasks.length > 0 && <PlanPanel plan={plan} />}

      {status && !isThinking && <StatusBar status={status} />}

      <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0}>
        {messages.length === 0 ? (
          <Box
            flexDirection="column"
            alignItems="center"
            justifyContent="center"
            paddingY={2}
          >
            <Text color="gray" dimColor>
              Welcome to Meer AI! Ask me anything about your code.
            </Text>
            <Text color="gray" dimColor>
              Try: "list files in src/" or "explain how authentication works"
            </Text>
            <Text color="gray" dimColor>
              Type / for slash commands (e.g., /help, /model, /setup)
            </Text>
            <Text color={mode === "plan" ? "blue" : "green"} dimColor>
              Press Ctrl+P to toggle between Plan and Edit modes
            </Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            {hiddenCount > 0 && (
              <Box marginBottom={1} marginLeft={2}>
                <Text color="gray" dimColor>
                  Showing last {visibleMessages.length} of {messages.length}{" "}
                  messages. Older entries hidden for performance.
                </Text>
              </Box>
            )}
            <Box flexDirection="row">
              <Box flexGrow={1}>
                {(() => {
                  const displayMessages =
                    draftAssistant && showLiveResponse
                      ? [...visibleMessages, draftAssistant]
                      : visibleMessages;
                  const displayWindowSize = Math.max(
                    1,
                    Math.min(displayMessages.length, terminalHeight * 3)
                  );

                  return (
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
                  renderItem={(msg, idx) => (
                    <MessageView
                      message={msg}
                      isDraft={Boolean(draftAssistant && showLiveResponse && msg.id === draftAssistant.id)}
                    />
                  )}
                />
                  );
                })()}
              </Box>
              {virtualizeHistory && (visibleMessages.length > 0 || (draftAssistant && showLiveResponse)) && (
                <Box marginLeft={1}>
                  {(() => {
                    const displayMessagesCount =
                      draftAssistant && showLiveResponse
                        ? visibleMessages.length + 1
                        : visibleMessages.length;
                    const displayWindowSize = Math.max(
                      1,
                      Math.min(displayMessagesCount, terminalHeight * 3)
                    );

                    return (
                  <ScrollIndicator
                    offset={scrollOffset}
                    windowSize={displayWindowSize}
                    totalCount={displayMessagesCount}
                  />
                    );
                  })()}
                </Box>
              )}
            </Box>
            {virtualizeHistory && scrollAnchor === "manual" && (
              <Box marginLeft={2}>
                <Text color="gray" dimColor>
                  Manual scroll active — PageUp/PageDown to browse, Home for
                  oldest, End for latest.
                </Text>
              </Box>
            )}
            {tools && tools.length > 0 && <ToolExecutionPanel tools={tools} />}
            {isThinking && (!draftAssistant?.content || !showLiveResponse) && <ThinkingIndicator />}
          </Box>
        )}
      </Box>

      <InputArea
        value={input}
        onChange={handleInputChange}
        onSubmit={handleSubmit}
        isThinking={isThinking}
        queuedMessages={messageQueue.length}
        queuedPreview={queuedPreview}
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
        liveResponseVisible={showLiveResponse}
      />
    </Box>
  );
};

const InlineChoicePrompt: React.FC<{
  message: string;
  options: Array<{ label: string; value: string }>;
  defaultValue: string;
  onSelect: (value: string) => void;
}> = ({ message, options, defaultValue, onSelect }) => {
  const items = useMemo(
    () =>
      options.map((option) => ({
        label: option.label,
        value: option.value,
      })),
    [options]
  );

  const initialIndex = useMemo(() => {
    const index = options.findIndex((option) => option.value === defaultValue);
    return index >= 0 ? index : 0;
  }, [defaultValue, options]);

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={2}>
      <Text color="yellow">
        {message}
      </Text>
      <Text color="dim">
        Use ↑↓ or j/k to navigate, Enter to select, or press a number key.
      </Text>
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

function truncateLine(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function formatCompactNumber(value: number): string {
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}m`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function formatDurationSeconds(value: number): string {
  const totalSeconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m ${seconds}s`;
}

// Screen Reader Layout Component
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
  provider,
  model,
  cwd,
  mode,
  status,
  isThinking,
  tokens,
  cost,
  hiddenCount,
  totalMessages,
  tools,
  workflowStages,
  messages,
  plan,
  children,
}) => {
  const modeLabel = mode === "plan" ? "Plan" : "Edit";
  const describePlanStatus = (
    status: Plan["tasks"][number]["status"]
  ): string => {
    switch (status) {
      case "completed":
        return "completed";
      case "in_progress":
        return "in progress";
      case "skipped":
        return "skipped";
      default:
        return "pending";
    }
  };

  return (
    <Box flexDirection="column" gap={1}>
      <Text color="cyan" bold>
        Screen reader mode enabled
      </Text>
      <Text>
        Use Tab to move focus and Enter to send. Run `/screen-reader off` to
        return to visual layout.
      </Text>
      <Text>
        Profile: {provider ?? "unknown"} / {model ?? "unknown"} · Mode:{" "}
        {modeLabel}
      </Text>
      <Text>Directory: {cwd ?? process.cwd()}</Text>
      {tokens && (
        <Text>
          Tokens used: {tokens.used}
          {tokens.limit ? ` / ${tokens.limit}` : ""}
        </Text>
      )}
      {cost && typeof cost.current === "number" && cost.current > 0 && (
        <Text>
          Estimated cost: ${cost.current.toFixed(4)}
          {cost.limit ? ` / ${cost.limit}` : ""}
        </Text>
      )}
      {tools && tools.length > 0 && (
        <Text>
          Active tools: {tools.map((tool) => tool.name ?? "tool").join(", ")}
        </Text>
      )}
      {workflowStages && workflowStages.length > 0 && (
        <Box flexDirection="column">
          <Text>Workflow stages:</Text>
          {workflowStages.map((stage, index) => (
            <Text key={stage.name}>
              {index + 1}. {stage.name} - {stage.status}
            </Text>
          ))}
        </Box>
      )}
      {plan && (
        <Box flexDirection="column">
          <Text>Plan: {plan.title}</Text>
          {plan.tasks.slice(0, 5).map((task, index) => (
            <Text key={task.id}>
              {index + 1}. {task.description} -{" "}
              {describePlanStatus(task.status)}
            </Text>
          ))}
          {plan.tasks.length > 5 && (
            <Text color="dim">
              +{plan.tasks.length - 5} more task
              {plan.tasks.length - 5 === 1 ? "" : "s"}
            </Text>
          )}
        </Box>
      )}
      <Box flexDirection="column" aria-role="list">
        {messages.length === 0 ? (
          <Text>No messages yet. Ask a question to get started.</Text>
        ) : (
          messages.map((message, index) => (
            <ScreenReaderMessage
              key={index}
              message={message}
              ariaRole="listitem"
            />
          ))
        )}
        {hiddenCount > 0 && (
          <Text dimColor>
            Showing last {messages.length} messages of {totalMessages}.{" "}
            {hiddenCount} older messages hidden for performance.
          </Text>
        )}
        {isThinking && <Text>Assistant is thinking…</Text>}
        {status && !isThinking && <Text>Status: {status}</Text>}
      </Box>
      {children}
    </Box>
  );
};

const ScreenReaderMessage: React.FC<{
  message: Message;
  ariaRole?: "listitem";
}> = ({ message, ariaRole }) => {
  const roleLabel =
    message.role === "assistant"
      ? "Meer"
      : message.role === "user"
      ? "You"
      : message.role === "system"
      ? "System"
      : "Tool";
  const content =
    message.content?.replace(/\s+/g, " ").trim() || "[no content provided]";
  const time = formatTimestamp(message.timestamp);

  return (
    <Text aria-role={ariaRole}>
      {time ? `[${time}] ` : ""}
      {roleLabel}: {content}
    </Text>
  );
};

export default MeerChatV2;
