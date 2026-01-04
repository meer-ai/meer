/**
 * MeerChatV2 - Production-ready TUI component
 * Optimized with Context API, memoization, and smooth UX
 */

import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { Box, Text, useInput, useApp, render } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";
import Gradient from "ink-gradient";
import BigText from "ink-big-text";
import {
  getAllCommands,
  type SlashCommandListEntry,
} from "../../slash/registry.js";
import { getSlashCommandBadges } from "../../slash/utils.js";
import type { Plan } from "../../plan/types.js";
import { StatusHeader } from "./components/core/index.js";
import { ToolExecutionPanel, type ToolCall } from "./components/tools/index.js";
import {
  WorkflowProgress,
  type WorkflowStage,
} from "./components/workflow/index.js";
import { PlanPanel } from "./components/plan/index.js";
import { TimelinePanel } from "./components/timeline/index.js";
import { VirtualizedList, ScrollIndicator } from "./components/shared/index.js";
import type { Message } from "./contexts/ChatContext.js";
import { debounce } from "./utils/debounce.js";

// ============================================================================
// Types
// ============================================================================

export interface MeerChatV2Props {
  onMessage: (message: string) => void;
  messages: Message[];
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
const MessageView: React.FC<{ message: Message; isLast: boolean }> = React.memo(
  ({ message, isLast }) => {
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
          return "👤";
        case "assistant":
          return "🌊";
        case "system":
          return "ℹ️";
        default:
          return "•";
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
          return "Meer AI";
        case "system":
          return "System";
        default:
          return message.role;
      }
    };

    const getAccentBar = () => {
      switch (message.role) {
        case "user":
          return "▎";
        case "assistant":
          return "▎";
        case "system":
          return "▎";
        default:
          return "│";
      }
    };

    return (
      <Box flexDirection="column" marginBottom={2} marginTop={1}>
        <Box gap={1}>
          <Text color={getColor()} bold>
            {getAccentBar()}
          </Text>
          <Box gap={1} flexGrow={1} justifyContent="space-between">
            <Box gap={1}>
              <Text color={getColor()}>{getIcon()}</Text>
              <Text color={getColor()} bold>
                {getName()}
              </Text>
            </Box>
            {message.timestamp && (
              <Text color="dim" dimColor>
                {formatTimestamp(message.timestamp)}
              </Text>
            )}
          </Box>
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

// Header Component - Memoized
const Header: React.FC<{
  provider?: string;
  model?: string;
  cwd?: string;
  mode?: "edit" | "plan";
}> = React.memo(({ provider, model, cwd, mode = "edit" }) => {
  const getModeColor = () => (mode === "plan" ? "blue" : "green");
  const getModeIcon = () => (mode === "plan" ? "📋" : "✏️");
  const getModeLabel = () => (mode === "plan" ? "PLAN" : "EDIT");

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginBottom={1}
    >
      <Box justifyContent="center">
        <Gradient name="cristal">
          <Text bold>🌊 Meer AI</Text>
        </Gradient>
      </Box>
      <Box justifyContent="space-between">
        <Box>
          <Text color="cyan">Provider: </Text>
          <Text color="white">{provider || "unknown"}</Text>
          <Text color="gray"> / </Text>
          <Text color="white">{model || "unknown"}</Text>
        </Box>
        <Box>
          <Text color={getModeColor()} bold>
            {getModeIcon()} {getModeLabel()} MODE
          </Text>
        </Box>
      </Box>
      <Box>
        <Text color="gray" dimColor>
          {cwd || process.cwd()}
        </Text>
      </Box>
    </Box>
  );
});

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
  mode?: "edit" | "plan";
  slashSuggestions: SlashCommandListEntry[];
  selectedSuggestion: number;
}> = React.memo(
  ({
    value,
    onChange,
    onSubmit,
    placeholder,
    isThinking,
    queuedMessages,
    mode = "edit",
    slashSuggestions,
    selectedSuggestion,
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
      <Box
        flexDirection="column"
        borderStyle="double"
        borderColor={isThinking ? "yellow" : "cyan"}
        paddingX={1}
        paddingY={0}
        marginTop={1}
      >
        <Box justifyContent="space-between" paddingY={0}>
          <Box gap={1}>
            <Text color="cyan" bold>
              💭 Input
            </Text>
            {value.startsWith("/") && (
              <Text color="yellow" bold>
                ⚡ COMMAND
              </Text>
            )}
          </Box>
          <Box gap={1}>
            {isThinking && (
              <Text color="yellow" bold>
                ⏳ AI thinking...
              </Text>
            )}
            {queuedMessages > 0 && (
              <Text color="magenta" bold>
                📬 {queuedMessages} queued
              </Text>
            )}
          </Box>
        </Box>

        <Box marginTop={0} marginBottom={1} paddingLeft={0}>
          <Text color={mode === "plan" ? "blue" : "green"} bold>
            {mode === "plan" ? "📋" : "✏️"} {getModeHint()}
          </Text>
        </Box>

        <Box paddingY={0} flexDirection="row">
          <Text color={isThinking ? "yellow" : "cyan"} bold>
            {isThinking ? "⏸ " : "❯ "}
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

        {slashSuggestions.length > 0 && (
          <Box
            flexDirection="column"
            marginTop={1}
            paddingTop={0}
            borderStyle="round"
            borderColor="yellow"
          >
            <Box marginBottom={0} paddingX={1} paddingY={0}>
              <Text color="yellow" bold>
                ⚡ Commands ({slashSuggestions.length} found)
              </Text>
            </Box>
            <Box flexDirection="column" marginTop={0}>
              {slashSuggestions.slice(0, 5).map((item, index) => {
                const badges = getSlashCommandBadges(item);
                const isSelected = index === selectedSuggestion;
                return (
                  <Box
                    key={item.command}
                    paddingX={1}
                    paddingY={0}
                    borderStyle={isSelected ? "single" : undefined}
                    borderColor={isSelected ? "cyan" : undefined}
                  >
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
                <Box paddingX={1}>
                  <Text color="dim" italic>
                    ... and {slashSuggestions.length - 5} more commands
                  </Text>
                </Box>
              )}
            </Box>
            <Box
              marginTop={0}
              paddingX={1}
              paddingTop={0}
              borderStyle="single"
              borderColor="dim"
            >
              <Text color="dim">
                <Text color="yellow" bold>
                  Tab
                </Text>{" "}
                <Text color="dim">insert · </Text>
                <Text color="yellow" bold>
                  ↑↓
                </Text>{" "}
                <Text color="dim">navigate · </Text>
                <Text color="yellow" bold>
                  Enter
                </Text>{" "}
                <Text color="dim">execute</Text>
              </Text>
            </Box>
          </Box>
        )}

        <Box
          marginTop={1}
          paddingTop={0}
          borderStyle="single"
          borderColor="dim"
        >
          <Text color="gray">
            <Text color="cyan" bold>
              Enter
            </Text>{" "}
            <Text color="dim">send</Text> │
            <Text color="yellow" bold>
              {" "}
              ESC
            </Text>{" "}
            <Text color="dim">interrupt</Text> │
            <Text color="green" bold>
              {" "}
              Ctrl+P
            </Text>{" "}
            <Text color="dim">toggle mode</Text> │
            <Text color="red" bold>
              {" "}
              Ctrl+C
            </Text>{" "}
            <Text color="dim">exit</Text>
          </Text>
        </Box>
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
    <Box borderStyle="single" borderColor="gray" paddingX={1} marginY={1}>
      <Text color="yellow">
        <Spinner type="dots" />
      </Text>
      <Text color="yellow"> {status}</Text>
    </Box>
  );
});

// ============================================================================
// Main Chat Component
// ============================================================================

export const MeerChatV2: React.FC<MeerChatV2Props> = ({
  onMessage,
  messages,
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
}) => {
  const [input, setInput] = useState("");
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  const [internalMode, setInternalMode] = useState<"edit" | "plan">("edit");
  const [slashSuggestions, setSlashSuggestions] = useState<
    SlashCommandListEntry[]
  >([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const { exit } = useApp();
  const slashCommandEntries = useMemo(() => getAllCommands(), []);
  const isScreenReader = Boolean(screenReader);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [scrollAnchor, setScrollAnchor] = useState<"end" | "manual">("end");

  const mode = externalMode !== undefined ? externalMode : internalMode;

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
  });

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
          mode={mode}
          slashSuggestions={slashSuggestions}
          selectedSuggestion={selectedSuggestion}
        />
      </ScreenReaderLayout>
    );
  }

  return (
    <Box flexDirection="column" height="100%" width="100%">
      <StatusHeader
        provider={provider}
        model={model}
        cwd={cwd}
        mode={mode}
        tokens={tokens}
        cost={cost}
        messages={messageCount}
        uptime={sessionUptime}
      />

      {tools && tools.length > 0 && <ToolExecutionPanel tools={tools} />}
      {workflowStages && workflowStages.length > 0 && (
        <WorkflowProgress
          stages={workflowStages}
          currentIteration={currentIteration}
          maxIterations={maxIterations}
        />
      )}
      {plan && plan.tasks.length > 0 && <PlanPanel plan={plan} />}
      {timelineEvents && timelineEvents.length > 0 && (
        <TimelinePanel events={timelineEvents} maxEvents={8} />
      )}

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
                <VirtualizedList
                  items={visibleMessages}
                  scroll={{
                    offset: scrollOffset,
                    windowSize: scrollWindowSize,
                    totalCount: visibleMessages.length,
                  }}
                  renderItem={(msg, idx) => (
                    <MessageView
                      message={msg}
                      isLast={idx === visibleMessages.length - 1}
                    />
                  )}
                />
              </Box>
              {virtualizeHistory && visibleMessages.length > 0 && (
                <Box marginLeft={1}>
                  <ScrollIndicator
                    offset={scrollOffset}
                    windowSize={scrollWindowSize}
                    totalCount={visibleMessages.length}
                  />
                </Box>
              )}
            </Box>
            {virtualizeHistory && scrollAnchor === "manual" && (
              <Box marginLeft={2}>
                <Text color="gray" dimColor>
                  Manual scroll active — Ctrl+E to jump to latest, Ctrl+A for
                  oldest.
                </Text>
              </Box>
            )}
            {isThinking && <ThinkingIndicator />}
            {status && !isThinking && (
              <Box marginBottom={1} marginLeft={2}>
                <Text color="blue">{status}</Text>
              </Box>
            )}
          </Box>
        )}
      </Box>

      <InputArea
        value={input}
        onChange={handleInputChange}
        onSubmit={handleSubmit}
        isThinking={isThinking}
        queuedMessages={messageQueue.length}
        mode={mode}
        slashSuggestions={slashSuggestions}
        selectedSuggestion={selectedSuggestion}
      />
    </Box>
  );
};

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
