import React from "react";
import { Box, Text } from "ink";
import type { UITimelineEvent } from "../../timelineTypes.js";

export interface TimelinePanelProps {
  events: UITimelineEvent[];
  maxEvents?: number;
}

const TASK_ICONS: Record<string, { icon: string; color: string; label: string }> = {
  started: { icon: "⏳", color: "cyan", label: "Started" },
  updated: { icon: "…", color: "cyan", label: "Updated" },
  succeeded: { icon: "✔", color: "green", label: "Done" },
  failed: { icon: "✖", color: "red", label: "Failed" },
};

const LOG_ICONS: Record<string, { icon: string; color: string }> = {
  info: { icon: "ℹ", color: "cyan" },
  note: { icon: "📝", color: "magenta" },
  warn: { icon: "⚠", color: "yellow" },
  error: { icon: "✖", color: "red" },
};

const formatTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
};

const TimelineRow: React.FC<{ event: UITimelineEvent }> = ({ event }) => {
  const time = formatTime(event.timestamp);

  if (event.type === "task") {
    const meta = TASK_ICONS[event.status] ?? TASK_ICONS.started;
    const detail =
      event.detail && event.detail.trim().length > 0
        ? ` — ${event.detail.trim()}`
        : "";
    return (
      <Box gap={1}>
        <Text color="gray">{time}</Text>
        <Text color={meta.color}>{meta.icon}</Text>
        <Box flexDirection="column">
          <Text color={meta.color}>
            {meta.label}: {event.label}
          </Text>
          {detail && (
            <Text color="gray" dimColor>
              {detail.slice(3)}
            </Text>
          )}
        </Box>
      </Box>
    );
  }

  const meta = LOG_ICONS[event.level] ?? LOG_ICONS.info;
  return (
    <Box gap={1}>
      <Text color="gray">{time}</Text>
      <Text color={meta.color}>{meta.icon}</Text>
      <Text color={event.level === "error" ? "red" : "white"}>{event.message}</Text>
    </Box>
  );
};

export const TimelinePanel: React.FC<TimelinePanelProps> = ({
  events,
  maxEvents = 8,
}) => {
  if (!events || events.length === 0) {
    return null;
  }

  const visible = events.slice(-Math.max(1, maxEvents));

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="blue"
      paddingX={1}
      paddingY={0}
      marginBottom={1}
    >
      <Text color="cyan" bold>
        🕑 Timeline
      </Text>
      <Box flexDirection="column" marginTop={1} gap={0}>
        {visible.map((event, index) => (
          <TimelineRow
            key={`${event.id}-${event.timestamp}-${index}`}
            event={event}
          />
        ))}
      </Box>
    </Box>
  );
};

export default TimelinePanel;
