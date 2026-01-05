/**
 * StatusHeader - Enhanced persistent header with real-time metrics
 * Displays provider, model, tokens, cost, and session info
 * Enhanced with better visualization, warnings, and compact layout
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
  compact?: boolean;
}

export const StatusHeader: React.FC<StatusHeaderProps> = React.memo(({
  provider,
  model,
  cwd,
  mode = 'edit',
  tokens,
  cost,
  messages,
  uptime,
  compact = false,
}) => {
  const getModeColor = () => mode === 'plan' ? 'blue' : 'green';
  const getModeIcon = () => mode === 'plan' ? '??' : '??';
  const getModeLabel = () => mode === 'plan' ? 'PLAN' : 'EDIT';

  const formatUptime = (seconds?: number): string => {
    if (seconds === undefined) return '';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m ${secs}s`;
  };

  const formatTokens = (num: number): string => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
  };

  const tokenPercent = tokens?.limit ? (tokens.used / tokens.limit) * 100 : 0;
  const costPercent = cost?.limit ? (cost.current / cost.limit) * 100 : 0;

  const getUsageStatus = (percent: number): { icon: string; color: string; label: string } => {
    if (percent >= 90) return { icon: '??', color: 'red', label: 'CRITICAL' };
    if (percent >= 75) return { icon: '?', color: 'yellow', label: 'HIGH' };
    if (percent >= 50) return { icon: '??', color: 'cyan', label: 'MODERATE' };
    return { icon: 'ű', color: 'green', label: 'GOOD' };
  };

  const tokenStatus = tokens?.limit ? getUsageStatus(tokenPercent) : null;
  const costStatus = cost?.limit ? getUsageStatus(costPercent) : null;

  // Compact mode - flat, minimal line for the landing view
  if (compact) {
    return (
      <Box justifyContent="space-between" width="100%" marginBottom={1} paddingX={1}>
        <Box gap={1} flexShrink={1}>
          <Text color="cyan" bold>Meer</Text>
          {provider && <Text color="dim">{provider}</Text>}
          {model && <Text color="dim">/ {model}</Text>}
          {cwd && <Text color="dim">{cwd}</Text>}
        </Box>
        <Box gap={2} flexShrink={0}>
          <Text color={getModeColor()}>{getModeLabel()}</Text>
          {tokens && tokens.used > 0 && (
            <Text color="dim">
              {formatTokens(tokens.used)}
              {tokens.limit ? `/${formatTokens(tokens.limit)}` : ""} tok
            </Text>
          )}
          {cost && cost.current > 0 && (
            <Text color="dim">${cost.current.toFixed(3)}</Text>
          )}
          {messages !== undefined && (
            <Text color="dim">{messages} msgs</Text>
          )}
          {uptime !== undefined && (
            <Text color="dim">{formatUptime(uptime)}</Text>
          )}
        </Box>
      </Box>
    );
  }

  // Full mode - detailed view
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} paddingY={0} marginBottom={1}>
      {/* Title and Mode */}
      <Box justifyContent="space-between" paddingY={0}>
        <Box gap={1}>
          <Gradient name="cristal">
            <Text bold>?? Meer AI</Text>
          </Gradient>
          <Text color="dim">ú</Text>
          <Text color="cyan">{provider || 'unknown'}</Text>
          <Text color="dim">/</Text>
          <Text color="white">{model || 'unknown'}</Text>
        </Box>
        <Box gap={1}>
          <Text color={getModeColor()} bold>
            {getModeIcon()} {getModeLabel()}
          </Text>
        </Box>
      </Box>

      {/* Metrics Grid - Compact */}
      <Box justifyContent="space-between" marginTop={1} gap={2}>
        {/* Tokens */}
        {tokens && (
          <Box flexDirection="column">
            <Box gap={1}>
              <Text color="cyan">??</Text>
              <Text color={tokenStatus?.color || 'dim'}>
                {formatTokens(tokens.used)}
                {tokens.limit && `/${formatTokens(tokens.limit)}`}
              </Text>
              {tokenStatus && tokenPercent > 75 && (
                <Text color={tokenStatus.color}>{tokenStatus.icon}</Text>
              )}
            </Box>
            {tokens.limit && tokenPercent > 0 && (
              <Box marginTop={0}>
                <ProgressBar
                  value={tokenPercent}
                  width={20}
                  color={tokenPercent > 85 ? 'red' : tokenPercent > 70 ? 'yellow' : 'cyan'}
                  showPercentage={false}
                />
              </Box>
            )}
          </Box>
        )}

        {/* Cost */}
        {cost && (
          <Box flexDirection="column">
            <Box gap={1}>
              <Text color="yellow">??</Text>
              <Text color={costStatus?.color || 'dim'}>
                ${cost.current.toFixed(4)}
                {cost.limit && `/$${cost.limit.toFixed(2)}`}
              </Text>
              {costStatus && costPercent > 75 && (
                <Text color={costStatus.color}>{costStatus.icon}</Text>
              )}
            </Box>
            {cost.limit && costPercent > 0 && (
              <Box marginTop={0}>
                <ProgressBar
                  value={costPercent}
                  width={20}
                  color={costPercent > 85 ? 'red' : costPercent > 70 ? 'yellow' : 'green'}
                  showPercentage={false}
                />
              </Box>
            )}
          </Box>
        )}

        {/* Messages & Uptime */}
        <Box gap={3}>
          {messages !== undefined && (
            <Box gap={1}>
              <Text color="green">??</Text>
              <Text color="dim">{messages}</Text>
            </Box>
          )}
          {uptime !== undefined && (
            <Box gap={1}>
              <Text color="blue">??</Text>
              <Text color="dim">{formatUptime(uptime)}</Text>
            </Box>
          )}
        </Box>
      </Box>

      {/* Warning messages */}
      {(tokenStatus?.label === 'CRITICAL' || costStatus?.label === 'CRITICAL') && (
        <Box marginTop={1} paddingX={1} borderStyle="round" borderColor="red">
          <Text color="red" bold>
            ??  {tokenStatus?.label === 'CRITICAL' ? 'Token limit' : 'Cost limit'} approaching!
          </Text>
        </Box>
      )}

      {/* Working Directory - Compact */}
      {cwd && (
        <Box marginTop={1}>
          <Text color="dim">?? {cwd.split('/').slice(-2).join('/')}</Text>
        </Box>
      )}
    </Box>
  );
});

export default StatusHeader;
