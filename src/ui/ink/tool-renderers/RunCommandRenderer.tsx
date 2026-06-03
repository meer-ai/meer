import React from "react";
import { Box, Text } from "ink";
import { getTheme } from "../../theme.js";
const t = getTheme();
import type { ToolRendererProps } from "./types.js";
import {
  SHELL_MAX_LINES,
  formatDurationMs,
  getCommand,
  shouldRenderCompact,
  stripToolHeader,
  truncateLine,
} from "./utils.js";
import { CompactToolRow } from "./CompactToolRow.js";

function getStringDetail(details: Record<string, unknown> | undefined, key: string): string {
  const value = details?.[key];
  return typeof value === "string" ? value : "";
}

function getNumberDetail(details: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = details?.[key];
  return typeof value === "number" ? value : undefined;
}

export const RunCommandRenderer: React.FC<ToolRendererProps> = React.memo(({
  content,
  args,
  details,
  isError,
}) => {
  const command = getStringDetail(details, "command") || getCommand(args);
  const cwd = getStringDetail(details, "cwd");
  const state = getStringDetail(details, "state");
  const body = stripToolHeader(content);
  const outputTail = getStringDetail(details, "outputTail");
  const stderrTail = getStringDetail(details, "stderrTail");
  const stdoutTail = getStringDetail(details, "stdoutTail");
  const shownSource = outputTail || stderrTail || stdoutTail || body;
  const lines = shownSource.split("\n").filter((line) => line.trim());
  const shown = lines.slice(-SHELL_MAX_LINES).join("\n");
  const hidden = Math.max(0, lines.length - SHELL_MAX_LINES);
  const durationMs = getNumberDetail(details, "durationMs");
  const timeoutMs = getNumberDetail(details, "timeoutMs");
  const exitCode = getNumberDetail(details, "exitCode");
  const outputLines = getNumberDetail(details, "outputLines");
  const outputBytes = getNumberDetail(details, "outputBytes");
  const fullOutputPath = getStringDetail(details, "fullOutputPath");
  const commandError = getStringDetail(details, "error");
  const statusLabel =
    isError
      ? "failed"
      : state === "timed_out"
        ? "timed out"
        : state === "cancelled"
          ? "cancelled"
          : "completed";

  // Short successful commands collapse to a one-liner. We deliberately
  // never compact a failed/timed_out/cancelled run — the user always
  // wants to see what broke.
  if (
    shouldRenderCompact({
      duration: durationMs,
      isError,
      body: shown,
    }) &&
    state === "completed"
  ) {
    return (
      <CompactToolRow
        toolName="run"
        summary={command ? `$ ${command}` : ""}
        durationMs={durationMs}
      />
    );
  }

  const borderColor = isError ? t.danger : state === "timed_out" || state === "cancelled" ? t.warning : t.success;
  const statusTextColor = isError ? t.danger : state === "timed_out" || state === "cancelled" ? t.warning : t.success;

  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={1} borderLeft borderColor={borderColor}>
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text color={statusTextColor}>run</Text>
          <Text color={statusTextColor}>{statusLabel}</Text>
          {typeof durationMs === "number" ? (
            <Text color={t.muted}>{formatDurationMs(durationMs)}</Text>
          ) : null}
          {typeof exitCode === "number" ? (
            <Text color={isError ? t.danger : t.muted}>exit {exitCode}</Text>
          ) : null}
        </Box>
        {typeof timeoutMs === "number" ? (
          <Text color={t.muted}>timeout {formatDurationMs(timeoutMs)}</Text>
        ) : null}
      </Box>
      {command ? <Text color={t.accent}>$ {truncateLine(command, 180)}</Text> : null}
      {cwd ? (
        <Text color={t.muted} dimColor>
          {truncateLine(cwd, 180)}
        </Text>
      ) : null}
      {commandError ? <Text color={t.danger}>{truncateLine(commandError, 180)}</Text> : null}
      {shown.trim() ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={t.muted} dimColor>
            {shown}
          </Text>
        </Box>
      ) : null}
      <Box gap={1} marginTop={shown.trim() ? 0 : 1}>
        {typeof outputLines === "number" ? <Text color={t.muted}>{outputLines} lines</Text> : null}
        {typeof outputBytes === "number" ? <Text color={t.muted}>{formatBytes(outputBytes)}</Text> : null}
        {hidden > 0 ? <Text color={t.muted}>+{hidden} hidden</Text> : null}
      </Box>
      {fullOutputPath ? (
        <Text color={t.muted} dimColor>
          full output: {fullOutputPath}
        </Text>
      ) : null}
    </Box>
  );
});

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)}mb`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)}kb`;
  return `${value}b`;
}
