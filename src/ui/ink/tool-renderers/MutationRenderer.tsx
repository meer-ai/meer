import React from "react";
import { Box, Text } from "ink";
import { DiffViewer, parseDiff } from "../components/tools/index.js";
import type { ToolRendererProps } from "./types.js";
import {
  extractDiffPreview,
  formatWritePreview,
  getFilePath,
  getWriteContent,
  stripToolHeader,
  truncateLine,
} from "./utils.js";

export const MutationRenderer: React.FC<ToolRendererProps> = React.memo(({
  toolName,
  content,
  args,
  details,
  isError,
}) => {
  const filePath = getFilePath(args) || toolName;
  const body = stripToolHeader(content);
  const firstLine = body.split("\n").find((line) => line.trim())?.trim() ?? "";
  const structuredDiff = typeof details?.diff === "string" ? details.diff : "";
  const diffPreview = structuredDiff || extractDiffPreview(body);
  const hunks = diffPreview ? parseDiff(diffPreview) : [];
  const additions = hunks.reduce(
    (sum, hunk) => sum + hunk.lines.filter((line) => line.type === "add").length,
    0
  );
  const removals = hunks.reduce(
    (sum, hunk) => sum + hunk.lines.filter((line) => line.type === "remove").length,
    0
  );
  const contentValue = getWriteContent(args);
  const structuredLineCount =
    typeof details?.lineCount === "number" ? details.lineCount : undefined;
  const lineCount =
    structuredLineCount ?? (contentValue ? contentValue.split("\n").length : undefined);
  const summary = isError
    ? firstLine || "Edit failed"
    : firstLine || (lineCount ? `Updated ${lineCount} lines` : "Applied");
  const action = toolName.toLowerCase().includes("write") ? "write" : "edit";
  const reviewLabel = isError ? "edit failed" : hunks.length > 0 ? "review changes" : action;
  const writePreview =
    !isError && hunks.length === 0 && contentValue
      ? formatWritePreview(contentValue)
      : null;

  return (
    <Box
      flexDirection="column"
      marginBottom={1}
      paddingLeft={1}
      borderLeft
      borderColor={isError ? "red" : "green"}
    >
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text color={isError ? "red" : "green"}>{reviewLabel}</Text>
          <Text color="white">{filePath}</Text>
        </Box>
        {!isError && hunks.length > 0 ? (
          <Box gap={1}>
            <Text color="green">+{additions}</Text>
            <Text color="red">-{removals}</Text>
            {typeof details?.firstChangedLine === "number" ? (
              <Text color="dim">L{details.firstChangedLine}</Text>
            ) : null}
          </Box>
        ) : lineCount ? (
          <Text color="dim">{lineCount} lines</Text>
        ) : null}
      </Box>
      {summary ? (
        <Text color={isError ? "red" : "dim"} dimColor={!isError}>
          {truncateLine(summary, 140)}
        </Text>
      ) : null}
      {!isError && hunks.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Box gap={1}>
            <Text color="dim">diff</Text>
            <Text color="green">+{additions}</Text>
            <Text color="red">-{removals}</Text>
            <Text color="dim">{hunks.length} hunk{hunks.length === 1 ? "" : "s"}</Text>
          </Box>
          <DiffViewer filePath={filePath} hunks={hunks.slice(0, 2)} showActions={false} />
          {hunks.length > 2 ? (
            <Text color="gray" dimColor>
              ... ({hunks.length - 2} more hunks)
            </Text>
          ) : null}
        </Box>
      ) : writePreview?.preview ? (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          <Text color="gray" dimColor>
            {writePreview.preview}
          </Text>
          {writePreview.hiddenLines > 0 ? (
            <Text color="gray" dimColor>
              ... ({writePreview.hiddenLines} more lines, {writePreview.totalLines} total)
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
});
