import React from "react";
import { Box, Text } from "ink";
import type { ToolRendererProps } from "./types.js";
import {
  GENERIC_MAX_CHARS,
  getDurationMs,
  shouldRenderCompact,
  stripToolHeader,
} from "./utils.js";
import { CompactToolRow } from "./CompactToolRow.js";

export const GenericRenderer: React.FC<ToolRendererProps> = React.memo(({
  toolName,
  content,
  details,
  isError,
}) => {
  const body = stripToolHeader(content);
  const duration = getDurationMs(details);
  if (shouldRenderCompact({ duration, isError, body })) {
    return (
      <CompactToolRow
        toolName={toolName}
        summary={body.replace(/\s+/g, " ").trim()}
        durationMs={duration}
      />
    );
  }
  const truncated =
    body.length > GENERIC_MAX_CHARS
      ? `${body.slice(0, GENERIC_MAX_CHARS)}\n… (${body.length - GENERIC_MAX_CHARS} more chars)`
      : body;
  const label = toolName.replace(/_/g, " ");

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box gap={1}>
        <Text color="magenta" dimColor>
          ▸
        </Text>
        <Text color="magenta">{label}</Text>
      </Box>
      {truncated.trim() ? (
        <Box paddingLeft={2}>
          <Text color={isError ? "red" : "gray"} dimColor={!isError}>
            {truncated}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
});
