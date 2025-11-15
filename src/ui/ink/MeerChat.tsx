/**
 * MeerChat - Modern TUI using Ink (React for CLIs)
 * Inspired by Claude Code, Cursor, and Bubble Tea
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Box, Text, useInput, useApp, render } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';
import Gradient from 'ink-gradient';
import BigText from 'ink-big-text';
import {
  getAllCommands,
  type SlashCommandListEntry,
} from '../../slash/registry.js';
import { getSlashCommandBadges } from '../../slash/utils.js';
import { StatusHeader } from './components/core/index.js';
import { ToolExecutionPanel, type ToolCall } from './components/tools/index.js';
import { WorkflowProgress, type WorkflowStage } from './components/workflow/index.js';

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
  // New props for enhanced UI
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
}

// Code Block Component - Minimal clean design
const CodeBlock: React.FC<{ code: string; language?: string }> = ({ code, language }) => {
  const getLanguageIcon = (lang?: string): string => {
    if (!lang) return '📄';
    const lower = lang.toLowerCase();
    if (lower.includes('typescript') || lower === 'ts') return '🔷';
    if (lower.includes('javascript') || lower === 'js') return '🟨';
    if (lower.includes('python') || lower === 'py') return '🐍';
    if (lower.includes('rust') || lower === 'rs') return '🦀';
    if (lower.includes('go')) return '🔵';
    if (lower.includes('java')) return '☕';
    if (lower.includes('c++') || lower === 'cpp') return '⚡';
    if (lower.includes('shell') || lower === 'bash' || lower === 'sh') return '🐚';
    if (lower.includes('json')) return '📦';
    if (lower.includes('yaml') || lower === 'yml') return '📋';
    return '📝';
  };

  return (
    <Box flexDirection="column" paddingLeft={0}>
      {/* Language tag - inline, no box */}
      {language && (
        <Box marginBottom={0}>
          <Text color="dim" dimColor>
            {getLanguageIcon(language)} {language}
          </Text>
        </Box>
      )}
      {/* Code content with subtle left bar */}
      <Box flexDirection="column" borderLeft={true} paddingLeft={2} marginTop={language ? 0 : 0}>
        <Text color="white" dimColor>{code}</Text>
      </Box>
    </Box>
  );
};

// Tool Call Component - Clean inline design
const ToolCall: React.FC<{ toolName: string; content: string }> = ({ toolName, content }) => {
  const getToolIcon = (name: string): string => {
    const lower = name.toLowerCase();
    if (lower.includes('read') || lower.includes('file')) return '📖';
    if (lower.includes('write') || lower.includes('edit')) return '✍️';
    if (lower.includes('bash') || lower.includes('exec')) return '⚡';
    if (lower.includes('search') || lower.includes('grep')) return '🔍';
    if (lower.includes('web') || lower.includes('fetch')) return '🌐';
    if (lower.includes('task') || lower.includes('agent')) return '🤖';
    return '🛠️';
  };

  // Truncate very long content
  const displayContent = content.length > 200
    ? `${content.substring(0, 200)}... (${content.length} chars total)`
    : content;

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={2} paddingLeft={0}>
      {/* Tool header - inline style */}
      <Box gap={1}>
        <Text color="magenta">▎</Text>
        <Box gap={1}>
          <Text color="magenta">{getToolIcon(toolName)}</Text>
          <Text color="magenta" bold>{toolName}</Text>
        </Box>
      </Box>
      {/* Tool result with left padding */}
      <Box paddingLeft={2} marginTop={0}>
        <Text color="dim" dimColor>{displayContent}</Text>
      </Box>
    </Box>
  );
};

// Message Component - Redesigned with minimal borders
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
        return '👤';
      case 'assistant':
        return '🌊';
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

  const getName = () => {
    switch (message.role) {
      case 'user':
        return 'You';
      case 'assistant':
        return 'Meer AI';
      case 'system':
        return 'System';
      default:
        return message.role;
    }
  };

  // Format timestamp if available
  const formatTime = (timestamp?: number): string => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  };

  // Get accent bar character based on role
  const getAccentBar = () => {
    switch (message.role) {
      case 'user':
        return '▎';
      case 'assistant':
        return '▎';
      case 'system':
        return '▎';
      default:
        return '│';
    }
  };

  return (
    <Box flexDirection="column" marginBottom={2} marginTop={1}>
      {/* Message header - inline with accent */}
      <Box gap={1}>
        <Text color={getColor()} bold>{getAccentBar()}</Text>
        <Box gap={1} flexGrow={1} justifyContent="space-between">
          <Box gap={1}>
            <Text color={getColor()}>{getIcon()}</Text>
            <Text color={getColor()} bold>{getName()}</Text>
          </Box>
          {message.timestamp && (
            <Text color="dim" dimColor>{formatTime(message.timestamp)}</Text>
          )}
        </Box>
      </Box>

      {/* Message content with left padding for alignment */}
      <Box flexDirection="column" paddingLeft={2}>
        {parts.map((part, idx) =>
          part.type === 'code' ? (
            <Box key={idx} marginTop={1} marginBottom={1}>
              <CodeBlock code={part.content} language={'language' in part ? part.language : undefined} />
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
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
      <Box justifyContent="center">
        <Gradient name="cristal">
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

// Thinking Indicator Component - Clean inline design
const ThinkingIndicator: React.FC = () => {
  const [dots, setDots] = React.useState(0);

  React.useEffect(() => {
    const interval = setInterval(() => {
      setDots(prev => (prev + 1) % 4);
    }, 500);
    return () => clearInterval(interval);
  }, []);

  const messages = [
    'Thinking',
    'Processing',
    'Analyzing',
    'Working',
  ];

  const currentMessage = messages[Math.floor(Date.now() / 2000) % messages.length];

  return (
    <Box marginBottom={2} marginTop={1} paddingLeft={0}>
      <Box gap={1}>
        <Text color="cyan">▎</Text>
        <Text color="cyan">
          <Spinner type="dots" />
        </Text>
        <Text color="cyan" dimColor>
          {currentMessage}{'.'.repeat(dots)}
        </Text>
      </Box>
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
  slashSuggestions: SlashCommandListEntry[];
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
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} paddingY={0} marginTop={1}>
      {/* Input header with status indicators */}
      <Box justifyContent="space-between" paddingY={0}>
        <Box gap={1}>
          <Text color="cyan" bold>
            💭 Input
          </Text>
          {value.startsWith('/') && (
            <Text color="yellow">
              (command)
            </Text>
          )}
        </Box>
        <Box gap={1}>
          {isThinking && (
            <Text color="yellow">
              ⚡ working
            </Text>
          )}
          {queuedMessages > 0 && (
            <Text color="magenta">
              📬 {queuedMessages} queued
            </Text>
          )}
        </Box>
      </Box>

      {/* Mode hint */}
      <Box marginTop={0} marginBottom={1}>
        <Text color={mode === 'plan' ? 'blue' : 'green'} dimColor>
          {getModeHint()}
        </Text>
      </Box>

      {/* Input field */}
      <Box paddingY={0}>
        <Text color="cyan" bold>❯ </Text>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder={getPlaceholder()}
          showCursor={true}
        />
      </Box>

      {/* Slash command suggestions */}
      {slashSuggestions.length > 0 && (
        <Box flexDirection="column" marginTop={1} paddingTop={1} borderStyle="single" borderColor="yellow">
          <Box marginBottom={0}>
            <Text color="yellow" bold>
              ⚡ Suggestions ({slashSuggestions.length})
            </Text>
          </Box>
          {slashSuggestions.slice(0, 5).map((item, index) => {
            const badges = getSlashCommandBadges(item);
            const isSelected = index === selectedSuggestion;
            return (
              <Box key={item.command} paddingLeft={1}>
                <Text color={isSelected ? 'cyan' : 'dim'} bold={isSelected}>
                  {isSelected ? '▶ ' : '  '}
                  {item.command}
                </Text>
                {badges.length > 0 && (
                  <Text color="dim"> [{badges.join(', ')}]</Text>
                )}
                <Text color="dim"> - {item.description.substring(0, 50)}{item.description.length > 50 ? '...' : ''}</Text>
              </Box>
            );
          })}
          {slashSuggestions.length > 5 && (
            <Box paddingLeft={1}>
              <Text color="dim">
                ... and {slashSuggestions.length - 5} more
              </Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text color="dim">
              <Text color="yellow">Tab</Text> to insert · <Text color="yellow">↑/↓</Text> to navigate
            </Text>
          </Box>
        </Box>
      )}

      {/* Keyboard shortcuts */}
      <Box marginTop={1} paddingTop={1} borderStyle="single" borderColor="dim">
        <Text color="dim">
          <Text color="cyan">Enter</Text> send · <Text color="cyan">ESC</Text> interrupt · <Text color="cyan">Ctrl+P</Text> mode · <Text color="cyan">Ctrl+C</Text> exit
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
  tools,
  workflowStages,
  currentIteration,
  maxIterations,
  tokens,
  cost,
  messageCount,
  sessionUptime,
}) => {
  const [input, setInput] = useState('');
  const [scrollOffset, setScrollOffset] = useState(0);
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  const [internalMode, setInternalMode] = useState<Mode>('edit');
  const [slashSuggestions, setSlashSuggestions] = useState<SlashCommandListEntry[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const { exit } = useApp();
  const slashCommandEntries = useMemo(() => getAllCommands(), []);

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
      const trimmedLeading = value.trimStart();

      if (!trimmedLeading.startsWith('/')) {
        clearSlashSuggestions();
        return;
      }

      const firstSpace = trimmedLeading.indexOf(' ');
      const commandToken =
        firstSpace === -1 ? trimmedLeading : trimmedLeading.slice(0, firstSpace);
      const hasArguments =
        firstSpace !== -1 &&
        trimmedLeading
          .slice(firstSpace + 1)
          .trim()
          .length > 0;

      if (hasArguments) {
        clearSlashSuggestions();
        return;
      }

      const normalized = commandToken.toLowerCase();
      const options =
        commandToken === '/'
          ? slashCommandEntries
          : slashCommandEntries.filter((entry) =>
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
    [clearSlashSuggestions, slashCommandEntries]
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
        onMessage(trimmed);
      }
    },
    [isThinking, onMessage]
  );

  const applySlashSuggestion = useCallback(
    (mode: 'insert' | 'send' = 'insert') => {
      if (slashSuggestions.length === 0) return;
      const suggestion = slashSuggestions[selectedSuggestion];

      if (mode === 'send') {
        clearSlashSuggestions();
        handleInputChange('');
        sendMessage(suggestion.command);
        return;
      }

      setInput(`${suggestion.command} `);
      clearSlashSuggestions();
    },
    [
      clearSlashSuggestions,
      handleInputChange,
      selectedSuggestion,
      sendMessage,
      slashSuggestions,
    ]
  );

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
        applySlashSuggestion('insert');
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

    const commandToken = trimmed.split(/\s+/)[0] ?? '';
    const suggestion = slashSuggestions[selectedSuggestion];
    const shouldApplySlash =
      hasSlashSuggestions &&
      commandToken.startsWith('/') &&
      trimmed === commandToken &&
      suggestion &&
      suggestion.command.toLowerCase().startsWith(commandToken.toLowerCase());

    if (shouldApplySlash) {
      applySlashSuggestion('send');
      return;
    }

    if (!trimmed) {
      return;
    }

    if (isThinking) {
      handleInputChange('');
      sendMessage(trimmed);
      return;
    }

    sendMessage(trimmed);
    handleInputChange('');
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

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    setScrollOffset(0);
  }, [messages.length]);

  const displayMessages = messages.slice(Math.max(0, messages.length - 10 + scrollOffset));

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

      {/* Tool Execution Panel */}
      {tools && tools.length > 0 && <ToolExecutionPanel tools={tools} />}

      {/* Workflow Progress */}
      {workflowStages && workflowStages.length > 0 && (
        <WorkflowProgress
          stages={workflowStages}
          currentIteration={currentIteration}
          maxIterations={maxIterations}
        />
      )}

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
