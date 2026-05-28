/**
 * ToolExecutionPanel - Professional tool execution display with real-time updates
 * Enhanced with collapsible UI, better formatting, and visual improvements
 */

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { DiffViewer, parseDiff } from './DiffViewer.js';

export interface ToolCall {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'success' | 'error';
  startTime?: number;
  endTime?: number;
  result?: string;
  error?: string;
  args?: Record<string, any>;
  details?: Record<string, unknown>;
}

export interface ToolExecutionPanelProps {
  tools: ToolCall[];
  isParallel?: boolean;
  collapsed?: boolean;
}

export const ToolExecutionPanel: React.FC<ToolExecutionPanelProps> = React.memo(({
  tools,
  isParallel = false,
  collapsed = false,
}) => {
  const [elapsedTimes, setElapsedTimes] = useState<Map<string, number>>(new Map());

  // Update elapsed times for running tools
  useEffect(() => {
    // Only run interval if there are actually running tools
    const hasRunningTools = tools.some(tool => tool.status === 'running');

    if (!hasRunningTools) {
      return;
    }

    // Elapsed times only need sub-second precision for the first ~10s, then
    // tick once per second. Running at 100ms causes whole-chat re-renders.
    const interval = setInterval(() => {
      const newElapsed = new Map<string, number>();
      tools.forEach((tool: ToolCall) => {
        if (tool.status === 'running' && tool.startTime) {
          newElapsed.set(tool.id, Date.now() - tool.startTime);
        }
      });
      setElapsedTimes(newElapsed);
    }, 500);

    return () => clearInterval(interval);
  }, [tools]);

  const getIcon = (status: ToolCall['status']) => {
    switch (status) {
      case 'pending':
        return '○';
      case 'running':
        return '◉';
      case 'success':
        return '✓';
      case 'error':
        return '✗';
    }
  };

  const formatDuration = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  };

  const getDuration = (tool: ToolCall): string => {
    if (tool.status === 'running' && tool.startTime) {
      const elapsed = elapsedTimes.get(tool.id) || 0;
      return formatDuration(elapsed);
    }
    if (!tool.startTime || !tool.endTime) return '';
    return formatDuration(tool.endTime - tool.startTime);
  };

  const getColor = (status: ToolCall['status']): string => {
    switch (status) {
      case 'running':
        return 'cyan';
      case 'success':
        return 'green';
      case 'error':
        return 'red';
      default:
        return 'dim';
    }
  };

  const summarizeArgs = (args?: Record<string, any>): string => {
    if (!args || Object.keys(args).length === 0) return '';
    const preferredKeys = ['path', 'filePath', 'pattern', 'query', 'command', 'symbol', 'oldName', 'newName'];
    for (const key of preferredKeys) {
      if (key in args) {
        return `${key}: ${truncateResult(formatValue(args[key]), 56)}`;
      }
    }
    const [firstKey, firstValue] = Object.entries(args)[0];
    return `${firstKey}: ${truncateResult(formatValue(firstValue), 56)}`;
  };

  const getToolLabel = (toolName: string): string => {
    const label = toolName.replace(/[_-]+/g, ' ').trim();
    return label.charAt(0).toUpperCase() + label.slice(1);
  };

  const getToolIcon = (toolName: string): string => {
    const lower = toolName.toLowerCase();
    if (lower.includes('read') || lower.includes('list') || lower.includes('find') || lower.includes('grep') || lower.includes('search')) return '→';
    if (lower.includes('write') || lower.includes('edit') || lower.includes('rename') || lower.includes('move') || lower.includes('format')) return '↻';
    if (lower.includes('test') || lower.includes('lint') || lower.includes('check') || lower.includes('scan')) return '•';
    if (lower.includes('run') || lower.includes('command') || lower.includes('bash') || lower.includes('exec')) return '›';
    return '·';
  };

  const getResultSummary = (tool: ToolCall): string => {
    if (tool.error) {
      return truncateResult(tool.error, 92);
    }
    if (tool.result) {
      return truncateResult(tool.result.replace(/\s+/g, ' ').trim(), 92);
    }
    if (tool.status === 'running') {
      return 'Working…';
    }
    if (tool.status === 'success') {
      return 'Done';
    }
    return '';
  };

  const isEditTool = (toolName: string): boolean => {
    const lower = toolName.toLowerCase();
    return lower.includes('edit') || lower.includes('write') || lower.includes('rename') || lower.includes('move') || lower.includes('format');
  };

  const isShellTool = (toolName: string): boolean => {
    const lower = toolName.toLowerCase();
    return lower.includes('run') || lower.includes('command') || lower.includes('bash') || lower.includes('exec');
  };

  const truncateResult = (result?: string, maxLength = 60): string => {
    if (!result) return '';
    if (result.length <= maxLength) return result;
    return `${result.substring(0, maxLength)}...`;
  };

  if (tools.length === 0) return null;

  const totalDuration = tools.reduce((sum, tool) => {
    if (tool.startTime && tool.endTime) {
      return sum + (tool.endTime - tool.startTime);
    }
    return sum;
  }, 0);

  const completedTools = tools.filter(t => t.status === 'success' || t.status === 'error').length;
  const successTools = tools.filter(t => t.status === 'success').length;
  const errorTools = tools.filter(t => t.status === 'error').length;
  const runningTools = tools.filter(t => t.status === 'running').length;

  return (
    <Box flexDirection="column" marginY={1}>
      {!collapsed && (
        <Box flexDirection="column">
          {tools.map((tool: ToolCall, idx: number) => {
            const showConnector = idx < tools.length - 1;
            const argsSummary = summarizeArgs(tool.args);
            const resultSummary = getResultSummary(tool);
            const toolLabel = getToolLabel(tool.name);
            const diffText = tool.result && tool.result.includes('@@ ') ? tool.result : '';
            const diffHunks = diffText ? parseDiff(diffText) : [];
            const shellCommand =
              isShellTool(tool.name) && tool.args?.command
                ? formatValue(tool.args.command)
                : '';
            const backgroundColor =
              tool.status === 'error'
                ? 'red'
                : tool.status === 'success'
                  ? 'green'
                  : 'gray';
            const foregroundColor =
              tool.status === 'success'
                ? 'black'
                : 'white';

            return (
              <React.Fragment key={tool.id}>
                <Box
                  flexDirection="column"
                  paddingX={1}
                  paddingY={0}
                  backgroundColor={backgroundColor}
                >
                  <Box justifyContent="space-between">
                    <Box gap={1}>
                      {tool.status === 'running' ? (
                        <>
                          <Text color={foregroundColor}>
                            <Spinner type="dots" />
                          </Text>
                          <Text color={foregroundColor}>
                            {getToolIcon(tool.name)}
                          </Text>
                          <Text color={foregroundColor} bold>
                            {toolLabel}
                          </Text>
                        </>
                      ) : (
                        <>
                          <Text color={foregroundColor}>
                            {getIcon(tool.status)}
                          </Text>
                          <Text color={foregroundColor}>
                            {getToolIcon(tool.name)}
                          </Text>
                          <Text color={foregroundColor}>
                            {toolLabel}
                          </Text>
                        </>
                      )}
                      {argsSummary && (
                        <Text color={foregroundColor}>
                          {argsSummary}
                        </Text>
                      )}
                    </Box>
                    <Text color={foregroundColor}>
                      {getDuration(tool)}
                    </Text>
                  </Box>

                  {shellCommand && (
                    <Box marginLeft={4}>
                      <Text color={foregroundColor}>
                        $ {truncateResult(shellCommand, 96)}
                      </Text>
                    </Box>
                  )}

                  {resultSummary && (
                    <Box marginLeft={4}>
                      <Text color={foregroundColor}>
                        {resultSummary}
                      </Text>
                    </Box>
                  )}

                  {diffHunks.length > 0 && isEditTool(tool.name) && (
                    <Box marginLeft={4}>
                      <DiffViewer
                        filePath={String(tool.args?.path || tool.args?.filePath || tool.name)}
                        hunks={diffHunks.slice(0, 2)}
                        showActions={false}
                      />
                    </Box>
                  )}
                </Box>

                {showConnector && (
                  <Box paddingLeft={2}>
                    <Text color="dim">│</Text>
                  </Box>
                )}
              </React.Fragment>
            );
          })}
        </Box>
      )}

      {(runningTools > 0 || errorTools > 0) && (
        <Box marginTop={0} gap={2}>
          <Text color={runningTools > 0 ? "cyan" : "dim"}>
            {runningTools > 0
              ? `${runningTools} running`
              : `${successTools} done · ${errorTools} failed`}
          </Text>
          {completedTools === tools.length && totalDuration > 0 && (
            <Text color="dim">{formatDuration(totalDuration)}</Text>
          )}
        </Box>
      )}
    </Box>
  );
});

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.replace(/\s+/g, ' ').trim();
  }
  return JSON.stringify(value);
}

export default ToolExecutionPanel;
