import React from "react";
import { Box } from "ink";

export interface ScrollState {
  offset: number;
  windowSize: number;
  totalCount: number;
}

export interface VirtualizedListProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  scroll: ScrollState;
}

/**
 * Placeholder virtualized list that simply renders the provided items.
 * Intended as a scaffold for a future scrollable list with off-screen culling.
 */
export function VirtualizedList<T>({
  items,
  renderItem,
  scroll,
}: VirtualizedListProps<T>): React.ReactElement {
  const windowSize = Math.max(
    1,
    Math.min(scroll.windowSize, items.length || scroll.windowSize),
  );
  const maxStart = Math.max(0, items.length - windowSize);
  const start = Math.max(0, Math.min(scroll.offset, maxStart));
  const end = Math.min(items.length, start + windowSize);
  const visibleItems = items.slice(start, end);

  return (
    <Box flexDirection="column" data-scroll-offset={scroll.offset}>
      {visibleItems.map((item, index) => (
        <React.Fragment key={start + index}>
          {renderItem(item, start + index)}
        </React.Fragment>
      ))}
    </Box>
  );
}
