/**
 * ToolExecutionPanel - Professional tool execution display with real-time updates
 * Inspired by Claude Code and GitHub Copilot CLI
 */

import React, { useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

export interface ToolCall {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'success' | 'error';
  startTime?: number;
  endTime?: number;
  result?: string;
  error?: string;
  args?: Record<string, any>;
}

export interface ToolExecutionPanelProps {
  tools: ToolCall[];
  isParallel?: boolean;
  collapsed?: boolean;
}

export const ToolExecutionPanel: React.FC<ToolExecutionPanelProps> = ({
  tools,
  isParallel = false,
  collapsed = false,
}) => {
  const getIcon = (status: ToolCall['status']) => {
    switch (status) {
      case 'pending':
        return '⏸';
      case 'running':
        return '⏳';
      case 'success':
        return '✓';
      case 'error':
        return '✗';
    }
  };

  const getDuration = (tool: ToolCall): string => {
    if (!tool.startTime) return '';
    const end = tool.endTime || Date.now();
    const duration = end - tool.startTime;

    if (duration < 1000) {
      return `${duration}ms`;
    }
    return `${(duration / 1000).toFixed(2)}s`;
  };

  const getColor = (status: ToolCall['status']): string => {
    switch (status) {
      case 'running':
        return 'yellow';
      case 'success':
        return 'green';
      case 'error':
        return 'red';
      default:
        return 'gray';
    }
  };

  if (tools.length === 0) return null;

  const totalDuration = tools.reduce((sum, tool) => {
    if (tool.startTime && tool.endTime) {
      return sum + (tool.endTime - tool.startTime);
    }
    return sum;
  }, 0);

  const completedTools = tools.filter(t => t.status === 'success' || t.status === 'error').length;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginY={1}
    >
      <Box justifyContent="space-between">
        <Box>
          <Text color="cyan" bold>
            🔧 Tools ({tools.length})
          </Text>
          {isParallel && (
            <Text color="yellow" bold> ⚡ Parallel</Text>
          )}
        </Box>
        {completedTools === tools.length && totalDuration > 0 && (
          <Text color="gray" dimColor>
            Total: {totalDuration < 1000 ? `${totalDuration}ms` : `${(totalDuration / 1000).toFixed(2)}s`}
          </Text>
        )}
      </Box>

      {!collapsed && (
        <Box flexDirection="column" marginTop={1}>
          {tools.map((tool) => (
            <Box key={tool.id} justifyContent="space-between" marginY={0}>
              <Box>
                {tool.status === 'running' ? (
                  <Text color={getColor(tool.status)}>
                    <Spinner type="dots" /> {tool.name}
                  </Text>
                ) : (
                  <Text color={getColor(tool.status)}>
                    {getIcon(tool.status)} {tool.name}
                  </Text>
                )}
                {tool.error && (
                  <Text color="red" dimColor> - {tool.error.substring(0, 50)}</Text>
                )}
              </Box>
              <Text color="gray" dimColor>
                {getDuration(tool)}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {collapsed && tools.length > 0 && (
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            {completedTools} / {tools.length} completed
          </Text>
        </Box>
      )}
    </Box>
  );
};

export default ToolExecutionPanel;
