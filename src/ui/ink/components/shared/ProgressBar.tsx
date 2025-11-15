/**
 * ProgressBar - Enhanced reusable progress bar component for Ink
 * Features: gradient fill, smooth transitions, customizable styles
 */

import React from 'react';
import { Box, Text } from 'ink';

export interface ProgressBarProps {
  value: number; // 0-100
  width?: number;
  color?: string;
  showPercentage?: boolean;
  style?: 'blocks' | 'smooth' | 'dots' | 'line';
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
  value,
  width = 40,
  color = 'cyan',
  showPercentage = true,
  style = 'smooth',
}) => {
  const clampedValue = Math.max(0, Math.min(100, value));
  const filled = Math.round((clampedValue / 100) * width);
  const empty = width - filled;

  // Get the appropriate characters based on style
  const getChars = () => {
    switch (style) {
      case 'blocks':
        return { filled: '█', empty: '░' };
      case 'smooth':
        return { filled: '━', empty: '─' };
      case 'dots':
        return { filled: '●', empty: '○' };
      case 'line':
        return { filled: '▰', empty: '▱' };
      default:
        return { filled: '━', empty: '─' };
    }
  };

  const chars = getChars();

  // Get color based on percentage for gradient effect
  const getProgressColor = (): string => {
    if (color === 'auto') {
      if (clampedValue >= 90) return 'red';
      if (clampedValue >= 75) return 'yellow';
      if (clampedValue >= 50) return 'cyan';
      return 'green';
    }
    return color;
  };

  const progressColor = getProgressColor();

  // Add partial fill character for more precision
  const partialFill = ((clampedValue / 100) * width) % 1;
  const hasPartial = partialFill > 0.2 && filled < width;
  const partialChar = getPartialChar(partialFill, style);

  return (
    <Box>
      <Text color={progressColor}>
        {chars.filled.repeat(filled)}
      </Text>
      {hasPartial && (
        <Text color={progressColor} dimColor>
          {partialChar}
        </Text>
      )}
      <Text color="dim">
        {chars.empty.repeat(empty - (hasPartial ? 1 : 0))}
      </Text>
      {showPercentage && (
        <Text color={progressColor} bold>
          {' '}{clampedValue.toFixed(0)}%
        </Text>
      )}
    </Box>
  );
};

// Helper function to get partial fill character
function getPartialChar(fraction: number, style: string): string {
  if (style === 'blocks') {
    if (fraction > 0.75) return '▓';
    if (fraction > 0.5) return '▒';
    if (fraction > 0.25) return '░';
    return '░';
  }
  if (style === 'dots') {
    return fraction > 0.5 ? '◐' : '○';
  }
  return '╸';
}

export default ProgressBar;
