import React from "react";
import { Box, Text } from "ink";
import type { ToolRendererProps } from "./types.js";
import {
  FILE_MAX_LINES,
  getFilePath,
  stripToolHeader,
} from "./utils.js";

export const FileRenderer: React.FC<ToolRendererProps> = React.memo(({
  toolName,
  content,
  args,
  isError,
}) => {
  const lower = toolName.toLowerCase();
  const verb = lower.includes("write")
    ? "write"
    : lower.includes("list")
      ? "list"
      : lower.includes("edit")
        ? "edit"
        : "read";
  const filePath = getFilePath(args);
  const body = stripToolHeader(content);
  const lines = body.split("\n");
  const shown = lines.slice(0, FILE_MAX_LINES).join("\n");
  const extra = lines.length - FILE_MAX_LINES;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={isError ? "red" : "green"}>
        {verb} {filePath || toolName}
      </Text>
      {shown.trim() ? (
        <Box paddingLeft={2}>
          <Text color="gray" dimColor>
            {shown}
          </Text>
        </Box>
      ) : null}
      {extra > 0 ? (
        <Box paddingLeft={2}>
          <Text color="gray" dimColor>
            ... ({extra} more lines)
          </Text>
        </Box>
      ) : null}
    </Box>
  );
});
