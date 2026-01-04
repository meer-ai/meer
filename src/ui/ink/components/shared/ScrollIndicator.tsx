import React from "react";
import { Box, Text } from "ink";

export interface ScrollIndicatorProps {
  offset: number;
  windowSize: number;
  totalCount: number;
}

const BAR_SEGMENTS = 8;

export const ScrollIndicator: React.FC<ScrollIndicatorProps> = ({
  offset,
  windowSize,
  totalCount,
}) => {
  if (totalCount === 0 || windowSize >= totalCount) {
    return (
      <Box flexDirection="column" alignItems="flex-end">
        <Text color="gray">100%</Text>
        <Text color="gray">Top</Text>
      </Box>
    );
  }

  const visibleRatio = Math.min(1, windowSize / totalCount);
  const startRatio = Math.min(1, offset / totalCount);

  const startSegment = Math.floor(startRatio * BAR_SEGMENTS);
  const visibleSegments = Math.max(
    1,
    Math.round(visibleRatio * BAR_SEGMENTS),
  );

  const segments: string[] = [];
  for (let i = 0; i < BAR_SEGMENTS; i++) {
    if (i >= startSegment && i < startSegment + visibleSegments) {
      segments.push("█");
    } else {
      segments.push("·");
    }
  }

  const percentage = Math.min(
    100,
    Math.round(((offset + windowSize) / totalCount) * 100),
  );

  // Check if user is at the bottom
  const isAtBottom = offset + windowSize >= totalCount;
  const hasNewMessages = !isAtBottom;

  return (
    <Box flexDirection="column" alignItems="flex-end">
      <Text color="gray">Scroll</Text>
      <Text color="cyan">{segments.join("")}</Text>
      <Text color="gray">{percentage}%</Text>
      {hasNewMessages && (
        <Text color="yellow" bold>↓ New</Text>
      )}
    </Box>
  );
};
