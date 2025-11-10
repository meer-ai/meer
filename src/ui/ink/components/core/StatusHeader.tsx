/**
 * StatusHeader - Enhanced persistent header with real-time metrics
 * Displays provider, model, tokens, cost, and session info
 */

import React from 'react';
import { Box, Text } from 'ink';
import Gradient from 'ink-gradient';
import { ProgressBar } from '../shared/ProgressBar.js';

export interface StatusHeaderProps {
  provider?: string;
  model?: string;
  cwd?: string;
  mode?: 'edit' | 'plan';
  tokens?: {
    used: number;
    limit?: number;
  };
  cost?: {
    current: number;
    limit?: number;
  };
  messages?: number;
  uptime?: number;
}

export const StatusHeader: React.FC<StatusHeaderProps> = ({
  provider,
  model,
  cwd,
  mode = 'edit',
  tokens,
  cost,
  messages,
  uptime,
}) => {
  const getModeColor = () => mode === 'plan' ? 'blue' : 'green';
  const getModeIcon = () => mode === 'plan' ? '📋' : '✏️';
  const getModeLabel = () => mode === 'plan' ? 'PLAN' : 'EDIT';

  const formatUptime = (seconds?: number): string => {
    if (seconds === undefined) return '';
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}m ${secs}s`;
  };

  const tokenPercent = tokens?.limit ? (tokens.used / tokens.limit) * 100 : 0;
  const costPercent = cost?.limit ? (cost.current / cost.limit) * 100 : 0;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
      {/* Title and Mode */}
      <Box justifyContent="space-between">
        <Box>
          <Gradient name="cristal">
            <Text bold>🌊 Meer AI</Text>
          </Gradient>
          <Text color="gray"> | </Text>
          <Text color="white">{provider || 'unknown'}</Text>
          <Text color="gray"> / </Text>
          <Text color="white">{model || 'unknown'}</Text>
        </Box>
        <Box>
          <Text color={getModeColor()} bold>
            {getModeIcon()} {getModeLabel()}
          </Text>
        </Box>
      </Box>

      {/* Metrics Row */}
      <Box justifyContent="space-between" marginTop={1}>
        <Box>
          {tokens && (
            <Box>
              <Text color="cyan">📊 </Text>
              <Text color="gray" dimColor>
                {tokens.used.toLocaleString()}
                {tokens.limit && ` / ${tokens.limit.toLocaleString()}`} tokens
              </Text>
            </Box>
          )}
        </Box>
        <Box>
          {cost && (
            <Box>
              <Text color="yellow">💰 </Text>
              <Text color="gray" dimColor>
                ${cost.current.toFixed(4)}
                {cost.limit && ` / $${cost.limit.toFixed(2)}`}
              </Text>
            </Box>
          )}
        </Box>
        <Box>
          {messages !== undefined && (
            <Box>
              <Text color="green">💬 </Text>
              <Text color="gray" dimColor>{messages} msgs</Text>
            </Box>
          )}
        </Box>
        <Box>
          {uptime !== undefined && (
            <Box>
              <Text color="blue">⏱️ </Text>
              <Text color="gray" dimColor>{formatUptime(uptime)}</Text>
            </Box>
          )}
        </Box>
      </Box>

      {/* Progress Bars for Limits */}
      {tokens?.limit && tokenPercent > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray" dimColor>Token Usage:</Text>
          <ProgressBar
            value={tokenPercent}
            width={60}
            color={tokenPercent > 85 ? 'red' : tokenPercent > 70 ? 'yellow' : 'cyan'}
          />
        </Box>
      )}

      {cost?.limit && costPercent > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray" dimColor>Cost Usage:</Text>
          <ProgressBar
            value={costPercent}
            width={60}
            color={costPercent > 85 ? 'red' : costPercent > 70 ? 'yellow' : 'green'}
          />
        </Box>
      )}

      {/* Working Directory */}
      <Box marginTop={1}>
        <Text color="gray" dimColor>{cwd || process.cwd()}</Text>
      </Box>
    </Box>
  );
};

export default StatusHeader;
