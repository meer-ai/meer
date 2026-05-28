import React from "react";
import { Box, Text } from "ink";
import type { ToolRendererProps } from "./types.js";
import {
  SHELL_MAX_LINES,
  formatDurationMs,
  getCommand,
  getDurationMs,
  shouldRenderCompact,
  stripToolHeader,
  truncateLine,
} from "./utils.js";
import { CompactToolRow } from "./CompactToolRow.js";

export const ShellRenderer: React.FC<ToolRendererProps> = React.memo(({
  toolName,
  content,
  args,
  details,
  isError,
}) => {
  const command =
    typeof details?.command === "string" ? details.command : getCommand(args);
  const body = stripToolHeader(content);
  const compactDuration = getDurationMs(details);
  if (shouldRenderCompact({ duration: compactDuration, isError, body })) {
    return (
      <CompactToolRow
        toolName={toolName}
        summary={command ? `$ ${command}` : ""}
        durationMs={compactDuration}
      />
    );
  }
  const structuredTail =
    typeof details?.outputTail === "string" && details.outputTail.trim()
      ? details.outputTail
      : typeof details?.stderrTail === "string" && details.stderrTail.trim()
        ? details.stderrTail
        : "";
  const lines = (structuredTail || body).split("\n").filter((line) => line.trim());
  const shown = lines.slice(0, SHELL_MAX_LINES).join("\n");
  const extra = lines.length - SHELL_MAX_LINES;
  const duration =
    typeof details?.durationMs === "number" ? formatDurationMs(details.durationMs) : "";
  const exitCode =
    typeof details?.exitCode === "number" ? `exit ${details.exitCode}` : "";
  const fullOutputPath =
    typeof details?.fullOutputPath === "string" ? details.fullOutputPath : "";

  return (
    <Box
      flexDirection="column"
      marginBottom={1}
      paddingLeft={1}
      borderLeft
      borderColor={isError ? "red" : "gray"}
    >
      <Box gap={1}>
        <Text color={isError ? "red" : "green"}>
          {isError ? "command failed" : "command"}
        </Text>
        {duration ? <Text color="dim">{duration}</Text> : null}
        {exitCode ? <Text color={isError ? "red" : "dim"}>{exitCode}</Text> : null}
      </Box>
      {command ? <Text color="cyan">$ {truncateLine(command, 160)}</Text> : null}
      {shown.trim() ? (
        <Text color="gray" dimColor>
          {shown}
        </Text>
      ) : null}
      {fullOutputPath ? (
        <Text color="gray" dimColor>
          full output: {fullOutputPath}
        </Text>
      ) : null}
      {extra > 0 ? (
        <Text color="gray" dimColor>
          ... ({extra} more lines)
        </Text>
      ) : null}
    </Box>
  );
});
