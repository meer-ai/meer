/**
 * ToolExecutionPanel - Professional tool execution display with real-time updates
 * Enhanced with collapsible UI, better formatting, and visual improvements
 */

import React, { useState, useEffect } from 'react';
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

export const ToolExecutionPanel: React.FC<ToolExecutionPanelProps> = React.memo(({
  tools,
  isParallel = false,
  collapsed = false,
}) => {
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [elapsedTimes, setElapsedTimes] = useState<Map<string, number>>(new Map());

  // Update elapsed times for running tools
  useEffect(() => {
    // Only run interval if there are actually running tools
    const hasRunningTools = tools.some(tool => tool.status === 'running');

    if (!hasRunningTools) {
      return;
    }

    const interval = setInterval(() => {
      const newElapsed = new Map<string, number>();
      tools.forEach((tool: ToolCall) => {
        if (tool.status === 'running' && tool.startTime) {
          newElapsed.set(tool.id, Date.now() - tool.startTime);
        }
      });
      setElapsedTimes(newElapsed);
    }, 100);

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

  const formatArgs = (args?: Record<string, any>): string => {
    if (!args || Object.keys(args).length === 0) return '';
    const entries = Object.entries(args);
    if (entries.length === 1) {
      const [key, value] = entries[0];
      const strValue = typeof value === 'string' ? value : JSON.stringify(value);
      return strValue.length > 40 ? `${strValue.substring(0, 40)}...` : strValue;
    }
    return `${entries.length} args`;
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
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      paddingY={0}
      marginY={1}
    >
      {/* Header */}
      <Box justifyContent="space-between" paddingY={0}>
        <Box gap={1}>
          <Text color="cyan" bold>🛠️  Tools</Text>
          {isParallel && (
            <Text color="magenta">⚡ Parallel</Text>
          )}
          <Text color="dim">
            [{completedTools}/{tools.length}]
          </Text>
        </Box>
        {completedTools === tools.length && totalDuration > 0 && (
          <Text color="dim">
            {formatDuration(totalDuration)} total
          </Text>
        )}
      </Box>

      {/* Progress summary */}
      {!collapsed && runningTools > 0 && (
        <Box marginTop={0} marginBottom={1}>
          <Text color="cyan">
            {runningTools} running · {successTools} success · {errorTools} failed
          </Text>
        </Box>
      )}

      {/* Tool list */}
      {!collapsed && (
        <Box flexDirection="column" marginTop={0} gap={0}>
          {tools.map((tool: ToolCall, idx: number) => {
            const isExpanded = expandedTools.has(tool.id);
            const hasDetails = tool.args || tool.result || tool.error;
            const showConnector = idx < tools.length - 1;

            return (
              <React.Fragment key={tool.id}>
                <Box flexDirection="column">
                  {/* Tool header */}
                  <Box justifyContent="space-between">
                    <Box gap={1}>
                      {tool.status === 'running' ? (
                        <>
                          <Text color={getColor(tool.status)}>
                            <Spinner type="dots" />
                          </Text>
                          <Text color={getColor(tool.status)} bold>
                            {tool.name}
                          </Text>
                        </>
                      ) : (
                        <>
                          <Text color={getColor(tool.status)}>
                            {getIcon(tool.status)}
                          </Text>
                          <Text
                            color={getColor(tool.status)}
                            dimColor={tool.status === 'pending'}
                          >
                            {tool.name}
                          </Text>
                        </>
                      )}
                      {tool.args && !isExpanded && (
                        <Text color="dim">
                          ({formatArgs(tool.args)})
                        </Text>
                      )}
                    </Box>
                    <Text
                      color={tool.status === 'running' ? 'cyan' : 'dim'}
                      dimColor={tool.status !== 'running'}
                    >
                      {getDuration(tool)}
                    </Text>
                  </Box>

                  {/* Tool details (when expanded or on error) */}
                  {(isExpanded || tool.error) && hasDetails && (
                    <Box flexDirection="column" marginLeft={2} marginTop={0}>
                      {tool.error && (
                        <Text color="red">
                          ↳ Error: {truncateResult(tool.error, 80)}
                        </Text>
                      )}
                      {isExpanded && tool.result && (
                        <Text color="green">
                          ↳ {truncateResult(tool.result, 80)}
                        </Text>
                      )}
                      {isExpanded && tool.args && (
                        <Text color="dim">
                          ↳ Args: {JSON.stringify(tool.args, null, 2).substring(0, 100)}
                        </Text>
                      )}
                    </Box>
                  )}
                </Box>

                {/* Connector line */}
                {showConnector && (
                  <Box paddingLeft={0}>
                    <Text color={tool.status === 'success' ? 'green' : tool.status === 'error' ? 'red' : 'dim'}>
                      │
                    </Text>
                  </Box>
                )}
              </React.Fragment>
            );
          })}
        </Box>
      )}

      {/* Collapsed summary */}
      {collapsed && tools.length > 0 && (
        <Box marginTop={1} gap={2}>
          <Text color="dim">
            {completedTools}/{tools.length} done
          </Text>
          {errorTools > 0 && (
            <Text color="red">
              {errorTools} failed
            </Text>
          )}
        </Box>
      )}

      {/* Footer */}
      {!collapsed && completedTools === tools.length && tools.length > 0 && (
        <Box marginTop={1} justifyContent="space-between">
          <Text color="dim">
            {successTools} succeeded · {errorTools} failed
          </Text>
          {errorTools === 0 && (
            <Text color="green">
              ✨ All tools succeeded
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
});

export default ToolExecutionPanel;
