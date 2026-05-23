import React from "react";
import { Box, Text } from "ink";

export interface ScrollState {
  offset: number;
  windowSize: number;
  totalCount: number;
}

export interface VirtualizedListProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  scroll: ScrollState;
  renderGap?: (
    position: "top" | "bottom",
    hiddenCount: number
  ) => React.ReactNode;
}

/**
 * Placeholder virtualized list that simply renders the provided items.
 * Intended as a scaffold for a future scrollable list with off-screen culling.
 */
export function VirtualizedList<T>({
  items,
  renderItem,
  scroll,
  renderGap,
}: VirtualizedListProps<T>): React.ReactElement {
  const windowSize = Math.max(
    1,
    Math.min(scroll.windowSize, items.length || scroll.windowSize),
  );
  const maxStart = Math.max(0, items.length - windowSize);
  const start = Math.max(0, Math.min(scroll.offset, maxStart));
  const end = Math.min(items.length, start + windowSize);
  const visibleItems = items.slice(start, end);
  const hiddenTop = start;
  const hiddenBottom = Math.max(0, items.length - end);

  return (
    <Box flexDirection="column" data-scroll-offset={scroll.offset}>
      {hiddenTop > 0 &&
        (renderGap ? (
          renderGap("top", hiddenTop)
        ) : (
          <Box marginBottom={1}>
            <Text color="dim">{hiddenTop} items above</Text>
          </Box>
        ))}
      {visibleItems.map((item, index) => (
        <React.Fragment key={start + index}>
          {renderItem(item, start + index)}
        </React.Fragment>
      ))}
      {hiddenBottom > 0 &&
        (renderGap ? (
          renderGap("bottom", hiddenBottom)
        ) : (
          <Box marginTop={1}>
            <Text color="dim">{hiddenBottom} items below</Text>
          </Box>
        ))}
    </Box>
  );
}
