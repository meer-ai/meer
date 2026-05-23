/**
 * Minimal Gemini-style layout for Meer.
 * Keeps the Meer logo idea but adopts a clean header > history > input structure.
 * Now with slash command autocomplete support.
 */

import React, { useCallback, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, Static } from "ink";
import TextInput from "ink-text-input";
import Gradient from "ink-gradient";
import Spinner from "ink-spinner";
import { StatusHeader } from "./components/core/index.js";
import { ToolExecutionPanel, type ToolCall } from "./components/tools/index.js";

type Mode = "edit" | "plan";

interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolName?: string;
  timestamp?: number;
}

export interface SlashCommandSuggestion {
  name: string;
  description?: string;
}

export interface MeerChatProps {
  onMessage: (message: string) => void;
  messages: Message[];
  isThinking: boolean;
  status?: string;
  provider?: string;
  model?: string;
  cwd?: string;
  onExit?: () => void;
  onInterrupt?: () => void;
  mode?: Mode;
  onModeChange?: (mode: Mode) => void;
  tools?: ToolCall[];
  workflowStages?: import('./components/workflow/index.js').WorkflowStage[];
  currentIteration?: number;
  maxIterations?: number;
  tokens?: { used: number; limit?: number };
  cost?: { current: number; limit?: number };
  messageCount?: number;
  sessionUptime?: number;
  timelineEvents?: any[];
  plan?: import('../../plan/types.js').Plan | null;
  slashSuggestions?: SlashCommandSuggestion[];
  onSlashSelect?: (command: string) => void;
}

const Hero = ({
  provider,
  model,
}: {
  provider?: string;
  model?: string;
}) => (
  <Box flexDirection="column" gap={0} marginBottom={1}>
    <Text color="dim">
      Tips: Ask questions, edit files, or run commands. Use /help for commands.
    </Text>
  </Box>
);

const MessageItem: React.FC<{ message: Message }> = ({ message }) => {
  const color =
    message.role === "assistant"
      ? "cyan"
      : message.role === "user"
        ? "green"
        : message.role === "tool"
          ? "magenta"
          : "dim";
  return (
    <Box gap={1}>
      <Text color={color}>{message.role === "assistant" ? "Meer AI" : message.role}</Text>
      <Text color="white">{message.content || "(no content)"}</Text>
    </Box>
  );
};

const History = ({
  messages,
  isThinking,
  status,
}: {
  messages: Message[];
  isThinking: boolean;
  status?: string;
}) => {
  const staticMessages = messages.slice(0, Math.max(0, messages.length - 1));
  const liveMessage = messages[messages.length - 1];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      paddingY={0}
      marginBottom={1}
      gap={0}
    >
      <Static items={staticMessages}>
        {(item, index) => <MessageItem key={item.timestamp ?? index} message={item} />}
      </Static>
      {liveMessage && <MessageItem message={liveMessage} />}
      {isThinking && (
        <Box gap={1} marginTop={0}>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text color="cyan">{status || "Thinking..."}</Text>
        </Box>
      )}
    </Box>
  );
};

const SlashSuggestionsOverlay: React.FC<{
  suggestions: SlashCommandSuggestion[];
  selectedIndex: number;
}> = ({ suggestions, selectedIndex }) => {
  if (suggestions.length === 0) return null;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      paddingY={0}
      marginBottom={1}
    >
      <Box gap={1} marginBottom={0}>
        <Text color="yellow" bold>⚡ Commands</Text>
        <Text color="dim">({suggestions.length} found)</Text>
      </Box>
      {suggestions.slice(0, 8).map((cmd, idx) => (
        <Box key={cmd.name} gap={1}>
          <Text color={idx === selectedIndex ? "cyan" : "dim"}>
            {idx === selectedIndex ? "❯" : " "}
          </Text>
          <Text color={idx === selectedIndex ? "cyan" : "white"} bold={idx === selectedIndex}>
            /{cmd.name}
          </Text>
          {cmd.description && (
            <Text color="dim">{cmd.description}</Text>
          )}
        </Box>
      ))}
      {suggestions.length > 8 && (
        <Text color="dim" italic>... and {suggestions.length - 8} more</Text>
      )}
      <Box marginTop={0}>
        <Text color="dim">↑↓ navigate · Enter select · Esc cancel</Text>
      </Box>
    </Box>
  );
};

const InputBar: React.FC<{
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  cwd?: string;
  mode: Mode;
}> = ({ value, onChange, onSubmit, cwd, mode }) => {
  const { exit } = useApp();
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
    }
  });
  return (
    <Box flexDirection="column" gap={0} borderStyle="round" borderColor="blue" paddingX={1} paddingY={0}>
      <Box gap={1}>
        <Text color="dim">{cwd || ""}</Text>
        <Text color="dim">·</Text>
        <Text color={mode === "plan" ? "blue" : "green"}>{mode === "plan" ? "PLAN" : "EDIT"}</Text>
      </Box>
      <Box gap={1} alignItems="center">
        <Text color="blue">❯</Text>
        <TextInput value={value} onChange={onChange} onSubmit={onSubmit} placeholder="Type your message or path/to/file" />
      </Box>
      <Box gap={1} marginTop={0}>
        <Text color="dim">Press / for commands · Ctrl+C to exit · Ctrl+P to toggle mode</Text>
      </Box>
    </Box>
  );
};

export const MeerChat: React.FC<MeerChatProps> = ({
  onMessage,
  messages,
  isThinking,
  status,
  provider,
  model,
  cwd,
  mode = "edit",
  onModeChange,
  tools,
  workflowStages,
  currentIteration,
  maxIterations,
  tokens,
  cost,
  messageCount,
  sessionUptime,
  timelineEvents,
  plan,
  slashSuggestions = [],
  onSlashSelect,
}) => {
  const [input, setInput] = useState("");
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);

  // Filter suggestions based on input
  const filteredSuggestions = useMemo(() => {
    if (!input.startsWith("/")) return [];
    const query = input.slice(1).toLowerCase();
    return slashSuggestions.filter(cmd =>
      cmd.name.toLowerCase().includes(query)
    );
  }, [input, slashSuggestions]);

  const handleChange = useCallback((value: string) => {
    setInput(value);
    setSelectedSuggestion(0); // Reset selection when input changes
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed) return;

    // If showing suggestions and one is selected, expand to the full command
    if (filteredSuggestions.length > 0 && input.startsWith("/")) {
      const selected = filteredSuggestions[selectedSuggestion];
      if (selected) {
        onMessage("/" + selected.name);
        setInput("");
        return;
      }
    }

    onMessage(trimmed);
    setInput("");
  }, [input, filteredSuggestions, selectedSuggestion, onMessage]);

  useInput((inputKey, key) => {
    if (key.ctrl && inputKey === "p") {
      onModeChange?.(mode === "edit" ? "plan" : "edit");
    }

    // Navigate slash suggestions
    if (filteredSuggestions.length > 0) {
      if (key.upArrow) {
        setSelectedSuggestion(prev =>
          (prev - 1 + filteredSuggestions.length) % filteredSuggestions.length
        );
      }
      if (key.downArrow) {
        setSelectedSuggestion(prev =>
          (prev + 1) % filteredSuggestions.length
        );
      }
      if (key.tab) {
        // Tab complete the selected suggestion
        const selected = filteredSuggestions[selectedSuggestion];
        if (selected) {
          setInput(`/${selected.name} `);
        }
      }
      if (key.escape) {
        setInput("");
      }
    }
  });

  const runningStage = workflowStages?.find((s) => s.status === "running");

  return (
    <Box flexDirection="column" height="100%" width="100%" paddingX={1} paddingY={0} gap={1}>
      <Hero provider={provider} model={model} />
      <StatusHeader
        provider={provider}
        model={model}
        cwd={cwd}
        mode={mode}
        tokens={tokens}
        cost={cost}
        messages={messageCount}
        uptime={sessionUptime}
        compact
      />
      {/* Keep the middle clean: history only */}
      <History messages={messages} isThinking={isThinking} status={status} />

      {/* Slash command suggestions overlay */}
      {filteredSuggestions.length > 0 && (
        <SlashSuggestionsOverlay
          suggestions={filteredSuggestions}
          selectedIndex={selectedSuggestion}
        />
      )}

      <InputBar value={input} onChange={handleChange} onSubmit={handleSubmit} cwd={cwd} mode={mode} />
    </Box>
  );
};

export default MeerChat;
