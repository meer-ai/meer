/**
 * MeerChat - Modern TUI using Ink (React for CLIs)
 * Inspired by Claude Code, Cursor, and Bubble Tea
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useApp, render } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';
import Gradient from 'ink-gradient';
import BigText from 'ink-big-text';
import { slashCommands, type SlashCommandDefinition } from '../slashCommands.js';

// Types
interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolName?: string;
  timestamp?: number;
}

type Mode = 'edit' | 'plan';

interface MeerChatProps {
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
}

// Code Block Component
const CodeBlock: React.FC<{ code: string; language?: string }> = ({ code, language }) => {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1}>
      {language && (
        <Box>
          <Text color="cyan" bold>
            {language}
          </Text>
        </Box>
      )}
      <Text color="white">{code}</Text>
    </Box>
  );
};

// Tool Call Component
const ToolCall: React.FC<{ toolName: string; content: string }> = ({ toolName, content }) => {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
      <Box>
        <Text color="yellow" bold>
          🛠️  {toolName}
        </Text>
      </Box>
      <Text color="gray" dimColor>
        {content}
      </Text>
    </Box>
  );
};

// Message Component
const MessageView: React.FC<{ message: Message; isLast: boolean }> = ({ message, isLast }) => {
  const parseContent = (content: string) => {
    // Parse code blocks
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    const parts: Array<{ type: 'text' | 'code'; content: string; language?: string }> = [];
    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(content)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ type: 'text', content: content.slice(lastIndex, match.index) });
      }
      parts.push({ type: 'code', content: match[2], language: match[1] });
      lastIndex = codeBlockRegex.lastIndex;
    }

    if (lastIndex < content.length) {
      parts.push({ type: 'text', content: content.slice(lastIndex) });
    }

    return parts.length > 0 ? parts : [{ type: 'text', content }];
  };

  const parts = parseContent(message.content);

  if (message.role === 'tool') {
    return <ToolCall toolName={message.toolName || 'unknown'} content={message.content} />;
  }

  const getIcon = () => {
    switch (message.role) {
      case 'user':
        return '❯';
      case 'assistant':
        return '🤖';
      case 'system':
        return 'ℹ️';
      default:
        return '•';
    }
  };

  const getColor = () => {
    switch (message.role) {
      case 'user':
        return 'cyan';
      case 'assistant':
        return 'green';
      case 'system':
        return 'yellow';
      default:
        return 'white';
    }
  };

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={getColor()} bold>
          {getIcon()} {message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Meer AI' : 'System'}
        </Text>
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        {parts.map((part, idx) =>
          part.type === 'code' ? (
            <CodeBlock key={idx} code={part.content} language={'language' in part ? part.language : undefined} />
          ) : (
            <Text key={idx} color="white">
              {part.content}
            </Text>
          )
        )}
      </Box>
    </Box>
  );
};

// Header Component
const Header: React.FC<{
  provider?: string;
  model?: string;
  cwd?: string;
  mode?: Mode;
}> = ({ provider, model, cwd, mode = 'edit' }) => {
  const getModeColor = () => mode === 'plan' ? 'blue' : 'green';
  const getModeIcon = () => mode === 'plan' ? '📋' : '✏️';
  const getModeLabel = () => mode === 'plan' ? 'PLAN' : 'EDIT';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginBottom={1}>
      <Box justifyContent="center">
        <Gradient name="rainbow">
          <Text bold>🌊 Meer AI</Text>
        </Gradient>
      </Box>
      <Box justifyContent="space-between">
        <Box>
          <Text color="cyan">Provider: </Text>
          <Text color="white">{provider || 'unknown'}</Text>
          <Text color="gray"> / </Text>
          <Text color="white">{model || 'unknown'}</Text>
        </Box>
        <Box>
          <Text color={getModeColor()} bold>
            {getModeIcon()} {getModeLabel()} MODE
          </Text>
        </Box>
      </Box>
      <Box>
        <Text color="gray" dimColor>{cwd || process.cwd()}</Text>
      </Box>
    </Box>
  );
};

// Thinking Indicator Component (shows after last message)
const ThinkingIndicator: React.FC = () => {
  return (
    <Box marginBottom={1} marginLeft={2}>
      <Text color="yellow">
        <Spinner type="dots" />
      </Text>
      <Text color="yellow"> Thinking...</Text>
    </Box>
  );
};

// Input Component
const InputArea: React.FC<{
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  isThinking: boolean;
  queuedMessages: number;
  mode?: Mode;
  slashSuggestions: SlashCommandDefinition[];
  selectedSuggestion: number;
}> = ({
  value,
  onChange,
  onSubmit,
  placeholder,
  isThinking,
  queuedMessages,
  mode = 'edit',
  slashSuggestions,
  selectedSuggestion,
}) => {
  const getPlaceholder = () => {
    if (mode === 'plan') {
      return 'Ask for analysis and planning... (read-only mode)';
    }
    return placeholder || 'Type a message... (/ for commands)';
  };

  const getModeHint = () => {
    if (mode === 'plan') {
      return '📋 Plan Mode: AI will analyze and plan without making changes';
    }
    return '✏️ Edit Mode: AI can read and modify files';
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Box>
        <Text color="cyan" bold>
          Input {value.startsWith('/') && <Text color="gray" dimColor>(slash command)</Text>}
          {isThinking && <Text color="yellow"> (Agent working...)</Text>}
          {queuedMessages > 0 && <Text color="magenta"> ({queuedMessages} queued)</Text>}
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={mode === 'plan' ? 'blue' : 'green'} dimColor>
          {getModeHint()}
        </Text>
      </Box>
      <Box>
        <Text color="cyan">❯ </Text>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder={getPlaceholder()}
          showCursor={true}
        />
      </Box>
      {slashSuggestions.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">Slash commands:</Text>
          {slashSuggestions.map((item, index) => (
            <Box key={item.command}>
              <Text color={index === selectedSuggestion ? 'cyan' : 'gray'}>
                {index === selectedSuggestion ? '› ' : '  '}
                {item.command}
              </Text>
              <Text color="gray"> - {item.description}</Text>
            </Box>
          ))}
          <Text color="gray" dimColor>
            Enter or Tab to insert · use ↑/↓ to pick
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          <Text color="cyan">Enter</Text> to send • <Text color="cyan">ESC</Text> to interrupt • <Text color="cyan">Ctrl+P</Text> to toggle mode • <Text color="cyan">Ctrl+C</Text> to exit
        </Text>
      </Box>
    </Box>
  );
};

// Status Bar Component
const StatusBar: React.FC<{ status?: string }> = ({ status }) => {
  if (!status) return null;

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} marginY={1}>
      <Text color="yellow">
        <Spinner type="dots" />
      </Text>
      <Text color="yellow"> {status}</Text>
    </Box>
  );
};

// Main Chat Component
export const MeerChat: React.FC<MeerChatProps> = ({
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
}) => {
  const [input, setInput] = useState('');
  const [scrollOffset, setScrollOffset] = useState(0);
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  const [internalMode, setInternalMode] = useState<Mode>('edit');
  const [slashSuggestions, setSlashSuggestions] = useState<SlashCommandDefinition[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const { exit } = useApp();

  // Use external mode if provided, otherwise use internal state
  const mode = externalMode !== undefined ? externalMode : internalMode;

  const toggleMode = useCallback(() => {
    const newMode: Mode = mode === 'edit' ? 'plan' : 'edit';

    if (onModeChange) {
      onModeChange(newMode);
    } else {
      setInternalMode(newMode);
    }

    // Show a system message about the mode change
    // This will be handled by the adapter
  }, [mode, onModeChange]);

  const clearSlashSuggestions = useCallback(() => {
    setSlashSuggestions([]);
    setSelectedSuggestion(0);
  }, []);

  const updateSlashSuggestions = useCallback(
    (value: string) => {
      if (!value || !value.startsWith('/')) {
        clearSlashSuggestions();
        return;
      }

      const commandToken = value.split(/\s+/)[0] ?? '';
      const normalized = commandToken.toLowerCase();
      const options =
        commandToken === '/'
          ? slashCommands
          : slashCommands.filter((entry) =>
              entry.command.toLowerCase().startsWith(normalized)
            );

      if (options.length === 0) {
        clearSlashSuggestions();
        return;
      }

      setSlashSuggestions(options);
      setSelectedSuggestion((prev) =>
        prev < options.length ? prev : 0
      );
    },
    [clearSlashSuggestions]
  );

  const handleInputChange = useCallback(
    (value: string) => {
      setInput(value);
      updateSlashSuggestions(value);
    },
    [updateSlashSuggestions]
  );

  const applySlashSuggestion = useCallback(() => {
    if (slashSuggestions.length === 0) return;
    const suggestion = slashSuggestions[selectedSuggestion];
    setInput(`${suggestion.command} `);
    clearSlashSuggestions();
  }, [clearSlashSuggestions, selectedSuggestion, slashSuggestions]);

  const hasSlashSuggestions = slashSuggestions.length > 0;

  // Handle keyboard shortcuts
  useInput((inputKey, key) => {
    if (key.ctrl && inputKey === 'c') {
      onExit?.();
      exit();
      return;
    }
    if (key.ctrl && inputKey === 'p') {
      // Toggle between plan and edit mode
      toggleMode();
      return;
    }
    if (key.escape) {
      // Interrupt agent with ESC key
      if (isThinking && onInterrupt) {
        onInterrupt();
      }
      if (hasSlashSuggestions) {
        clearSlashSuggestions();
      }
      return;
    }
    if (key.ctrl && inputKey === 'l') {
      // Clear screen (handled by parent)
      return;
    }

    if (hasSlashSuggestions) {
      if (key.tab) {
        applySlashSuggestion();
        return;
      }
      if (key.upArrow) {
        setSelectedSuggestion(
          (prev) => (prev - 1 + slashSuggestions.length) % slashSuggestions.length
        );
        return;
      }
      if (key.downArrow) {
        setSelectedSuggestion(
          (prev) => (prev + 1) % slashSuggestions.length
        );
        return;
      }
    }
    if (key.upArrow) {
      setScrollOffset((prev) => Math.min(prev + 1, messages.length - 1));
    } else if (key.downArrow) {
      setScrollOffset((prev) => Math.max(prev - 1, 0));
    }
  });

  const handleSubmit = useCallback(() => {
    const trimmed = input.trim();

    if (hasSlashSuggestions && trimmed === '/') {
      applySlashSuggestion();
      return;
    }

    if (!trimmed) {
      return;
    }

    if (isThinking) {
      setMessageQueue((prev) => [...prev, trimmed]);
      handleInputChange('');
      return;
    }

    onMessage(trimmed);
    handleInputChange('');
  }, [
    applySlashSuggestion,
    handleInputChange,
    hasSlashSuggestions,
    input,
    isThinking,
    onMessage,
  ]);

  // Process queued messages when agent finishes
  useEffect(() => {
    if (!isThinking && messageQueue.length > 0) {
      const nextMessage = messageQueue[0];
      setMessageQueue((prev) => prev.slice(1));
      onMessage(nextMessage);
    }
  }, [isThinking, messageQueue, onMessage]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    setScrollOffset(0);
  }, [messages.length]);

  const displayMessages = messages.slice(Math.max(0, messages.length - 10 + scrollOffset));

  return (
    <Box flexDirection="column" height="100%" width="100%">
      <Header provider={provider} model={model} cwd={cwd} mode={mode} />

      {/* Only show status bar if there's a status AND agent is NOT thinking (thinking shows after messages) */}
      {status && !isThinking && <StatusBar status={status} />}

      <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0}>
        {messages.length === 0 ? (
          <Box flexDirection="column" alignItems="center" justifyContent="center" paddingY={2}>
            <Text color="gray" dimColor>
              Welcome to Meer AI! Ask me anything about your code.
            </Text>
            <Text color="gray" dimColor>
              Try: "list files in src/" or "explain how authentication works"
            </Text>
            <Text color="gray" dimColor>
              Type / for slash commands (e.g., /help, /model, /setup)
            </Text>
            <Text color={mode === 'plan' ? 'blue' : 'green'} dimColor>
              Press Ctrl+P to toggle between Plan and Edit modes
            </Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            {displayMessages.map((msg, idx) => (
              <MessageView key={idx} message={msg} isLast={idx === displayMessages.length - 1} />
            ))}
            {/* Show thinking indicator after last message */}
            {isThinking && <ThinkingIndicator />}
            {/* Show status after messages if provided and not thinking */}
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

// Render function for standalone use
export function renderMeerChat(props: Omit<MeerChatProps, 'messages'>) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isThinking, setIsThinking] = useState(false);

  const handleMessage = async (message: string) => {
    // Add user message
    setMessages((prev) => [...prev, { role: 'user', content: message, timestamp: Date.now() }]);
    setIsThinking(true);

    try {
      await props.onMessage(message);
    } finally {
      setIsThinking(false);
    }
  };

  const { unmount } = render(
    <MeerChat
      {...props}
      messages={messages}
      isThinking={isThinking}
      onMessage={handleMessage}
    />
  );

  return {
    unmount,
    addMessage: (message: Message) => setMessages((prev) => [...prev, message]),
    setThinking: setIsThinking,
  };
}

export default MeerChat;
