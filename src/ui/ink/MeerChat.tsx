/**
 * Minimal Gemini-style layout for Meer.
 * Keeps the Meer logo idea but adopts a clean header > history > input structure.
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
  tokens?: { used: number; limit?: number };
  cost?: { current: number; limit?: number };
  messageCount?: number;
  sessionUptime?: number;
}

const Hero = ({
  provider,
  model,
}: {
  provider?: string;
  model?: string;
}) => (
  <Box flexDirection="column" gap={0} marginBottom={1}>
    {/* <Box gap={1} alignItems="center">
      <Text color="cyan">Gemini-style workflow</Text>
      <Text color="dim">·</Text>
      <Text color="dim">{provider || "provider"}</Text>
      {model && (
        <>
          <Text color="dim">/</Text>
          <Text color="dim">{model}</Text>
        </>
      )}
    </Box> */}
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
        {(item) => <MessageItem message={item} />}
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
}) => {
  const [input, setInput] = useState("");

  const handleSubmit = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed) return;
    onMessage(trimmed);
    setInput("");
  }, [input, onMessage]);

  useInput((inputKey, key) => {
    if (key.ctrl && inputKey === "p") {
      onModeChange?.(mode === "edit" ? "plan" : "edit");
    }
    if (key.escape && isThinking) {
      // Let caller handle interrupt if wired
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

      <InputBar value={input} onChange={setInput} onSubmit={handleSubmit} cwd={cwd} mode={mode} />
    </Box>
  );
};

export default MeerChat;
