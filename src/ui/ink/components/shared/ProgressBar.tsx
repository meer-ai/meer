/**
 * ProgressBar - Reusable progress bar component for Ink
 */

import React from 'react';
import { Box, Text } from 'ink';

export interface ProgressBarProps {
  value: number; // 0-100
  width?: number;
  color?: string;
  showPercentage?: boolean;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
  value,
  width = 40,
  color = 'cyan',
  showPercentage = true,
}) => {
  const clampedValue = Math.max(0, Math.min(100, value));
  const filled = Math.round((clampedValue / 100) * width);
  const empty = width - filled;

  return (
    <Box>
      <Text color={color}>
        {'█'.repeat(filled)}
      </Text>
      <Text color="gray" dimColor>
        {'░'.repeat(empty)}
      </Text>
      {showPercentage && (
        <Text color={color}> {clampedValue.toFixed(0)}%</Text>
      )}
    </Box>
  );
};

export default ProgressBar;
