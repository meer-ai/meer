import React from "react";
import { Box, Text } from "ink";
import { formatDurationMs, truncateLine } from "./utils.js";

interface CompactToolRowProps {
  toolName: string;
  /** Short, semantic summary — for grep that's the pattern, for read_file the path, etc. */
  summary?: string;
  durationMs?: number;
}

/**
 * One-line compact rendering for "fast" tool results. The full widget shape
 * is the right thing for a `run_command` that took 30s and dumped 200 lines;
 * it's overkill for a `read_file` that finished in 12ms with a small body.
 *
 * Visually quiet (dim gray) so a flurry of fast tools fades into the
 * background — the eye lands on the slow / interesting ones.
 */
export const CompactToolRow: React.FC<CompactToolRowProps> = React.memo(
  ({ toolName, summary, durationMs }) => {
    const label = toolName.replace(/_/g, " ");
    const summaryText = summary ? truncateLine(summary, 80) : "";
    return (
      <Box marginBottom={0}>
        <Text color="gray" dimColor>
          → {label}
          {summaryText ? ` ${summaryText}` : ""}
          {typeof durationMs === "number" ? ` (${formatDurationMs(durationMs)})` : ""}
        </Text>
      </Box>
    );
  }
);
