import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import { Box, Text, useInput, useApp } from "ink";
import {
  getAllCommands,
  type SlashCommandListEntry,
} from "../../slash/registry.js";
import { getSlashCommandBadges } from "../../slash/utils.js";
import type { Plan } from "../../plan/types.js";
import { type ToolCall } from "./components/tools/index.js";
import { PlanPanel } from "./components/plan/index.js";
import { BrandMark } from "./components/core/index.js";
import { WrappedComposerInput } from "./components/input/WrappedComposerInput.js";
import type { WorkflowStage } from "./components/workflow/index.js";
import { VirtualizedList, ScrollIndicator } from "./components/shared/index.js";
import type { Message } from "./contexts/ChatContext.js";
import { debounce } from "./utils/debounce.js";
import type { BackgroundTerminalSession } from "../../runtime/backgroundTerminals.js";
import type { UITimelineEvent } from "./timelineTypes.js";
import { getToolRenderer } from "./tool-renderers/registry.js";
import {
  classifyTool,
  formatDurationMs,
  getCommand,
  getFilePath,
  isMutationTool,
  stripToolHeader,
} from "./tool-renderers/utils.js";

// ============================================================================
// Types
// ============================================================================

export interface MeerChatProps {
  onMessage: (message: string) => void;
  messages: Message[];
  draftAssistant?: Message;
  isThinking: boolean;
  status?: string;
  provider?: string;
  model?: string;
  cwd?: string;
  onExit?: () => void;
  onInterrupt?: () => void;
  mode?: "edit" | "plan";
  onModeChange?: (mode: "edit" | "plan") => void;
  tools?: ToolCall[];
  workflowStages?: WorkflowStage[];
  currentIteration?: number;
  maxIterations?: number;
  tokens?: { used: number; limit?: number };
  cost?: { current: number; limit?: number };
  messageCount?: number;
  sessionUptime?: number;
  virtualizeHistory?: boolean;
  screenReader?: boolean;
  timelineEvents?: UITimelineEvent[];
  plan?: Plan | null;
  slashSuggestions?: SlashCommandListEntry[];
  choicePrompt?: {
    message: string;
    options: Array<{ label: string; value: string }>;
    defaultValue: string;
  };
  onChoiceSelect?: (value: string) => void;
  formPrompt?: {
    title: string;
    questions: Array<{
      id: string;
      label: string;
      type: "select" | "multiselect";
      required?: boolean;
      options: Array<{ label: string; value: string; description?: string }>;
    }>;
    submitLabel: string;
  };
  onFormSubmit?: (answers: Record<string, string | string[]>) => void;
  queuedMessages?: string[];
  queueMode?: "steer" | "followUp";
  onQueueModeChange?: (mode: "steer" | "followUp") => void;
  backgroundSessions?: BackgroundTerminalSession[];
  onStopBackgroundSession?: (id: string) => void;
}

// ============================================================================
// Constants
// ============================================================================

const SLASH_DEBOUNCE_MS = 150;
const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
type WorkRow = {
  id: string;
  icon: string;
  label: string;
  detail?: string;
  tone?: "default" | "success" | "error" | "dim" | "active";
};

const SLASH_SUGGESTION_WINDOW = 8;

function shouldRenderTranscriptMessage(message: Message): boolean {
  if (message.role !== "tool") return true;
  const toolName = message.toolName || "";
  const kind = classifyTool(toolName);

  // Keep reviewable edits and failures in the transcript. Everything else is
  // represented by the live work panel to avoid log-style duplication.
  if (kind === "mutation") return true;
  return Boolean(message.isError);
}

function getCompactHiddenToolCount(messages: Message[]): number {
  return messages.reduce(
    (count, message) => count + (shouldRenderTranscriptMessage(message) ? 0 : 1),
    0
  );
}

function getToolTarget(tool: ToolCall): string {
  const args = tool.args ?? {};
  const path = getFilePath(args);
  if (path) {
    return truncateLine(path, 64);
  }

  const command = getCommand(args);
  if (command) {
    return `$ ${truncateLine(command, 64)}`;
  }

  if (tool.name === "package_install") {
    const packages = args.packages;
    const joined = Array.isArray(packages)
      ? packages.join(", ")
      : typeof packages === "string"
        ? packages
        : "";
    if (joined) {
      return truncateLine(joined, 64);
    }
  }

  if (tool.name === "scaffold_project") {
    const type = typeof args.projectType === "string" ? args.projectType : "";
    const name = typeof args.projectName === "string" ? args.projectName : "";
    const label = [type, name].filter(Boolean).join(" ");
    if (label) {
      return truncateLine(label, 64);
    }
  }

  if (tool.name === "update_plan_task") {
    const taskId = typeof args.taskId === "string" ? args.taskId : "";
    const status = typeof args.status === "string" ? args.status : "";
    const label = [taskId, status].filter(Boolean).join(" → ");
    if (label) {
      return truncateLine(label, 64);
    }
  }

  return "";
}

function getToolProgressSummary(tool: ToolCall): string {
  const details = tool.details ?? {};
  if (typeof details.outputTail === "string" && details.outputTail.trim()) {
    return truncateLine(details.outputTail.replace(/\s+/g, " ").trim(), 92);
  }
  if (typeof details.error === "string" && details.error.trim()) {
    return truncateLine(details.error.replace(/\s+/g, " ").trim(), 92);
  }
  const source = tool.error || tool.result || "";
  const normalized = stripToolHeader(source).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  return truncateLine(normalized, 92);
}

function getToolDetail(tool: ToolCall): string {
  const kind = classifyTool(tool.name);
  const details = tool.details ?? {};
  if (kind === "shell") {
    const tail =
      typeof details.outputTail === "string" && details.outputTail.trim()
        ? details.outputTail
        : typeof details.stderrTail === "string" && details.stderrTail.trim()
          ? details.stderrTail
          : "";
    if (tail) {
      const lines = tail
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0);
      const meta: string[] = [];
      if (typeof details.exitCode === "number") {
        meta.push(`exit ${details.exitCode}`);
      }
      if (typeof details.durationMs === "number") {
        meta.push(formatDurationMs(details.durationMs));
      }
      if (typeof details.fullOutputPath === "string") {
        meta.push(`full ${details.fullOutputPath}`);
      }
      return [
        meta.length > 0 ? meta.join(" · ") : "",
        ...lines.slice(-4).map((line) => truncateLine(line, 132)),
      ].filter(Boolean).join("\n");
    }
  }
  const progress = stripToolHeader(tool.error || tool.result || "").trim();

  if (kind === "shell" && progress) {
    const lines = progress
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);
    return lines.slice(-4).map((line) => truncateLine(line, 132)).join("\n");
  }

  if (tool.status === "running") {
    return getToolProgressSummary(tool) || getToolTarget(tool);
  }

  return getToolTarget(tool) || getToolProgressSummary(tool);
}

function formatToolDuration(tool: ToolCall): string {
  if (!tool.startTime) return "";
  const end = tool.endTime ?? Date.now();
  const ms = Math.max(0, end - tool.startTime);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

// ============================================================================
// Working Indicator
// ============================================================================

const TurnActivityIndicator: React.FC<{
  active: boolean;
  status?: string;
  isStreaming: boolean;
  activeTask?: string;
  activeTool?: string;
  tokens?: { used: number; limit?: number };
}> = React.memo(({ active, status, isStreaming, activeTask, activeTool, tokens }) => {
  const [frame, setFrame] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!active) {
      setStartedAt(null);
      setFrame(0);
      return;
    }
    setStartedAt((previous) => previous ?? Date.now());
    const timer = setInterval(() => {
      setFrame((previous) => (previous + 1) % BRAILLE_FRAMES.length);
      setNow(Date.now());
    }, 120);
    return () => clearInterval(timer);
  }, [active]);

  if (!active) {
    return null;
  }

  const elapsed =
    startedAt === null
      ? ""
      : formatDurationSeconds(Math.floor((now - startedAt) / 1000));
  const normalizedStatus = status?.trim() ?? "";
  const label =
    activeTool
      ? `Running ${activeTool.replace(/_/g, " ")}`
      : normalizedStatus && activeTask && /thinking/i.test(normalizedStatus)
      ? `${normalizedStatus} - ${activeTask}`
      : normalizedStatus ||
        (isStreaming
          ? "Writing response"
          : activeTask
            ? `Working on ${activeTask}`
            : "Thinking");
  const tokenText =
    typeof tokens?.used === "number" && tokens.used > 0
      ? `${formatCompactNumber(tokens.used)} tokens`
      : "";

  return (
    <Box paddingX={1} marginTop={0}>
      <Text color="#67E8F9">{BRAILLE_FRAMES[frame]} </Text>
      <Text color="#67E8F9">{label}</Text>
      {elapsed ? <Text color="dim"> · {elapsed}</Text> : null}
      {tokenText ? <Text color="dim"> · {tokenText}</Text> : null}
      <Text color="dim"> · Esc stop</Text>
    </Box>
  );
});

function buildWorkRows({
  timelineEvents = [],
  tools = [],
  backgroundSessions = [],
}: {
  timelineEvents?: UITimelineEvent[];
  tools?: ToolCall[];
  status?: string;
  backgroundSessions?: BackgroundTerminalSession[];
}): WorkRow[] {
  const rows: WorkRow[] = [];

  const now = Date.now();
  const visibleTools = tools.filter((tool) => {
    const lower = tool.name.toLowerCase();
    if (
      lower === "set_plan" ||
      lower === "show_plan" ||
      lower === "update_plan_task"
    ) {
      return false;
    }
    if (tool.status === "running" || tool.status === "pending" || tool.status === "error") return true;
    if (tool.status === "success" && tool.endTime) {
      return isMutationTool(tool.name) && now - tool.endTime < 5000;
    }
    return false;
  });

  for (const tool of [...visibleTools].slice(-4)) {
    const tone =
      tool.status === "error"
        ? "error"
        : tool.status === "success"
        ? "success"
        : tool.status === "running"
        ? "active"
        : "dim";
    const icon =
      tool.status === "error"
        ? "✕"
        : tool.status === "success"
        ? "✓"
        : tool.status === "running"
        ? "•"
        : "◦";
    rows.push({
      id: tool.id,
      icon,
      label: `${tool.name.replace(/_/g, " ")}${formatToolDuration(tool) ? ` ${formatToolDuration(tool)}` : ""}`,
      detail: getToolDetail(tool) || undefined,
      tone,
    });
  }

  for (const event of [...timelineEvents].slice(-3)) {
    if (event.type === "task") {
      if (rows.some((row) => row.label === event.label)) {
        continue;
      }
      rows.push({
        id: `timeline-task-${event.id}`,
        icon:
          event.status === "failed"
            ? "✕"
            : event.status === "succeeded"
            ? "✓"
            : "•",
        label: event.label,
        detail: event.detail,
        tone:
          event.status === "failed"
            ? "error"
            : event.status === "succeeded"
            ? "success"
            : "dim",
      });
      continue;
    }
    if (event.type === "log") {
      if (rows.length > 0 && event.level !== "error") {
        continue;
      }
      rows.push({
        id: `timeline-log-${event.id}`,
        icon: "•",
        label: event.message,
        tone: event.level === "error" ? "error" : "dim",
      });
    }
  }

  for (const session of backgroundSessions.slice(1, 3)) {
    rows.push({
      id: `bg-${session.id}`,
      icon: session.status === "running" ? "•" : session.status === "failed" ? "✕" : "✓",
      label: truncateLine(session.command, 80),
      detail: truncateLine(session.cwd, 80),
      tone:
        session.status === "failed"
          ? "error"
          : session.status === "running"
          ? "active"
          : "dim",
    });
  }

  return dedupeWorkRows(rows).slice(-5);
}

function dedupeWorkRows(rows: WorkRow[]): WorkRow[] {
  const seen = new Set<string>();
  const deduped: WorkRow[] = [];
  for (const row of rows) {
    const key = `${row.label}|${row.detail ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

// ============================================================================
// Code Block
// ============================================================================

const CodeBlock: React.FC<{ code: string; language?: string }> = React.memo(
  ({ code, language }) => (
    <Box flexDirection="column" paddingLeft={0}>
      {language ? (
        <Text color="dim" dimColor>
          {language}
        </Text>
      ) : null}
      <Box flexDirection="column" borderLeft={true} paddingLeft={2}>
        <Text color="white" dimColor>
          {code}
        </Text>
      </Box>
    </Box>
  ),
  (prev, next) => prev.code === next.code && prev.language === next.language
);

const RichTextBlock: React.FC<{
  text: string;
  tone?: "default" | "dim";
}> = React.memo(({ text, tone = "default" }) => {
  const lines = text.split("\n");

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return <Box key={index} height={0} />;
        }

        if (/^###\s+/.test(trimmed) || /^##\s+/.test(trimmed) || /^#\s+/.test(trimmed)) {
          const level = trimmed.startsWith("###") ? 3 : trimmed.startsWith("##") ? 2 : 1;
          return (
            <Text
              key={index}
              color={tone === "dim" ? "dim" : "white"}
              bold={tone !== "dim"}
              dimColor={tone === "dim"}
            >
              {`${"#".repeat(level)} ${trimmed.replace(/^#+\s+/, "")}`}
            </Text>
          );
        }

        if (/^[-*]\s+/.test(trimmed)) {
          return (
            <Box key={index} gap={1}>
              <Text color={tone === "dim" ? "dim" : "cyan"} dimColor={tone === "dim"}>
                •
              </Text>
              <Text color={tone === "dim" ? "dim" : "white"} dimColor={tone === "dim"}>
                {trimmed.replace(/^[-*]\s+/, "")}
              </Text>
            </Box>
          );
        }

        if (/^\d+\.\s+/.test(trimmed)) {
          const match = trimmed.match(/^(\d+\.)\s+(.*)$/);
          return (
            <Box key={index} gap={1}>
              <Text color={tone === "dim" ? "dim" : "cyan"} dimColor={tone === "dim"}>
                {match?.[1] ?? ""}
              </Text>
              <Text color={tone === "dim" ? "dim" : "white"} dimColor={tone === "dim"}>
                {match?.[2] ?? trimmed}
              </Text>
            </Box>
          );
        }

        return (
          <Text key={index} color={tone === "dim" ? "dim" : "white"} dimColor={tone === "dim"}>
            {trimmed}
          </Text>
        );
      })}
    </Box>
  );
});

// ============================================================================
// Message View
// ============================================================================

const MessageView: React.FC<{ message: Message; isDraft?: boolean }> =
  React.memo(
    ({ message, isDraft = false }) => {
      const parseContent = (content: string) => {
        const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
        const parts: Array<{
          type: "text" | "code";
          content: string;
          language?: string;
        }> = [];
        let lastIndex = 0;
        let match;

        while ((match = codeBlockRegex.exec(content)) !== null) {
          if (match.index > lastIndex) {
            parts.push({ type: "text", content: content.slice(lastIndex, match.index) });
          }
          parts.push({ type: "code", content: match[2], language: match[1] });
          lastIndex = codeBlockRegex.lastIndex;
        }

        if (lastIndex < content.length) {
          parts.push({ type: "text", content: content.slice(lastIndex) });
        }

        return parts.length > 0 ? parts : [{ type: "text" as const, content }];
      };

      // Tool result blocks
      if (message.role === "tool") {
        const toolName = message.toolName || "unknown";
        const ToolRendererComponent = getToolRenderer(toolName);
        return (
          <ToolRendererComponent
            toolName={toolName}
            content={message.content}
            args={message.toolArgs}
            details={message.toolDetails}
            isError={message.isError}
          />
        );
      }

      // CoT (chain-of-thought / inter-turn reasoning) — italic muted, no header
      if (message.isCot) {
        const text = message.content.trim();
        if (!text) return null;
        return (
          <Box flexDirection="column" marginBottom={0}>
            <Text italic dimColor>
              {text}
            </Text>
          </Box>
        );
      }

      // Streaming draft: render as the real assistant message, not a transient
      // status line. This keeps live output readable and prevents it from
      // looking like trimmed "thinking" text while tools are running.
      if (isDraft && message.role === "assistant") {
        const parts = parseContent(message.content);
        return (
          <Box flexDirection="column" marginBottom={1}>
            <Box gap={1}>
              <Text color="green" bold>
                Meer
              </Text>
              <Text color="dim" dimColor>
                streaming
              </Text>
              {message.timestamp ? (
                <Text color="dim" dimColor>
                  {formatTimestamp(message.timestamp)}
                </Text>
              ) : null}
            </Box>
            <Box flexDirection="column" paddingLeft={1}>
              {message.content.trim().length === 0 ? (
                <Text color="dim">...</Text>
              ) : (
                parts.map((part, idx) =>
                  part.type === "code" ? (
                    <Box key={idx} marginTop={0} marginBottom={0}>
                      <CodeBlock
                        code={part.content}
                        language={"language" in part ? part.language : undefined}
                      />
                    </Box>
                  ) : part.content.trim().length > 0 ? (
                    <Box key={idx}>
                      <RichTextBlock text={part.content.trim()} />
                    </Box>
                  ) : null
                )
              )}
            </Box>
          </Box>
        );
      }

      const getColor = () => {
        switch (message.role) {
          case "user": return "cyan";
          case "assistant": return "green";
          case "system": return "dim";
          default: return "white";
        }
      };

      const getName = () => {
        switch (message.role) {
          case "user": return "You";
          case "assistant": return "Meer";
          case "system": return "System";
          default: return message.role;
        }
      };

      const parts = useMemo(() => parseContent(message.content), [message.content]);
      const normalizedContent = message.content.trim();

      return (
        <Box flexDirection="column" marginBottom={message.role === "system" ? 0 : 1}>
          <Box gap={1}>
            <Text color={getColor()} bold={message.role !== "system"}>
              {getName()}
            </Text>
            {message.timestamp && (
              <Text color="dim" dimColor>
                {formatTimestamp(message.timestamp)}
              </Text>
            )}
          </Box>
          <Box flexDirection="column" paddingLeft={message.role === "system" ? 0 : 1}>
            {normalizedContent.length === 0 && (
              <Text color="dim">...</Text>
            )}
            {parts.map((part, idx) =>
              part.type === "code" ? (
                <Box key={idx} marginTop={0} marginBottom={0}>
                  <CodeBlock
                    code={part.content}
                    language={"language" in part ? part.language : undefined}
                  />
                </Box>
              ) : part.content.trim().length > 0 ? (
                <Box key={idx}>
                  <RichTextBlock
                    text={part.content.trim()}
                    tone={message.role === "system" ? "dim" : "default"}
                  />
                </Box>
              ) : null
            )}
          </Box>
        </Box>
      );
    },
    (prev, next) =>
      prev.message.id === next.message.id &&
      prev.message.content === next.message.content &&
      prev.message.toolDetails === next.message.toolDetails &&
      prev.isDraft === next.isDraft
  );

const formatTimestamp = (timestamp?: number): string => {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const h = date.getHours().toString().padStart(2, "0");
  const m = date.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
};

type SelectorItem = {
  key: string;
  label: string;
  description?: string;
  badges?: string[];
};

const ScrollableSelector: React.FC<{
  title: string;
  items: SelectorItem[];
  selectedIndex: number;
  help: string;
  windowSize?: number;
}> = React.memo(({ title, items, selectedIndex, help, windowSize = SLASH_SUGGESTION_WINDOW }) => {
  if (items.length === 0) return null;

  const halfWindow = Math.floor(windowSize / 2);
  let start = Math.max(0, selectedIndex - halfWindow);
  let end = start + windowSize;

  if (end > items.length) {
    end = items.length;
    start = Math.max(0, end - windowSize);
  }

  const visible = items.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = items.length - end;

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={1}>
      <Box justifyContent="space-between">
        <Text color="yellow" dimColor>
          {title}
        </Text>
        <Text color="dim">
          {selectedIndex + 1}/{items.length}
        </Text>
      </Box>
      {hiddenAbove > 0 ? (
        <Text color="dim" italic>
          ... {hiddenAbove} earlier
        </Text>
      ) : null}
      {visible.map((item, offset) => {
        const actualIndex = start + offset;
        const isSelected = actualIndex === selectedIndex;
        return (
          <Box key={item.key} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color={isSelected ? "cyan" : "yellow"} bold={isSelected}>
                {isSelected ? "›" : "•"}
              </Text>
              <Text color={isSelected ? "cyan" : "white"} bold={isSelected}>
                {item.label}
              </Text>
              {item.badges && item.badges.length > 0 ? (
                <Text color="magenta" dimColor>
                  {" "}[{item.badges.join(", ")}]
                </Text>
              ) : null}
            </Box>
            {item.description ? (
              <Box paddingLeft={2}>
                <Text color="gray" dimColor>
                  {truncateLine(item.description, 72)}
                </Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
      {hiddenBelow > 0 ? (
        <Text color="dim" italic>
          ... {hiddenBelow} more
        </Text>
      ) : null}
      <Text color="dim">{help}</Text>
    </Box>
  );
});

// ============================================================================
// Input Area
// ============================================================================

const InputArea: React.FC<{
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  isThinking: boolean;
  queuedMessages: number;
  queuedPreview: string[];
  queueMode: "steer" | "followUp";
  mode?: "edit" | "plan";
  slashSuggestions: SlashCommandListEntry[];
  selectedSuggestion: number;
  choicePrompt?: {
    message: string;
    options: Array<{ label: string; value: string }>;
    defaultValue: string;
  };
  onChoiceSelect?: (value: string) => void;
  formPrompt?: {
    title: string;
    questions: Array<{
      id: string;
      label: string;
      type: "select" | "multiselect";
      required?: boolean;
      options: Array<{ label: string; value: string; description?: string }>;
    }>;
    submitLabel: string;
  };
  onFormSubmit?: (answers: Record<string, string | string[]>) => void;
  backgroundPanelOpen?: boolean;
  transcriptMode?: boolean;
  tasksExpanded?: boolean;
}> = React.memo(
  ({
    value,
    onChange,
    onSubmit,
    placeholder,
    isThinking,
    queuedMessages,
    queuedPreview,
    queueMode,
    mode = "edit",
    slashSuggestions,
    selectedSuggestion,
    choicePrompt,
    onChoiceSelect,
    formPrompt,
    onFormSubmit,
    backgroundPanelOpen,
    transcriptMode,
    tasksExpanded,
  }) => (
    <Box flexDirection="column" marginTop={2} paddingX={1}>
      {queuedPreview.length > 0 && (
        <Box flexDirection="row" justifyContent="space-between" marginBottom={0}>
          <Box gap={1} flexShrink={1}>
            {queuedPreview.length > 0 ? (
              <Text color="dim">
                queued: {truncateLine(queuedPreview[0], 64)}
                {queuedMessages > 1 ? ` +${queuedMessages - 1}` : ""}
              </Text>
            ) : null}
          </Box>
        </Box>
      )}
      {slashSuggestions.length > 0 && (
        <ScrollableSelector
          title="Commands"
          selectedIndex={selectedSuggestion}
          help="Tab insert · ↑↓ navigate · Enter run"
          items={slashSuggestions.map((item) => ({
            key: item.command,
            label: item.command,
            description: item.description,
            badges: getSlashCommandBadges(item),
          }))}
        />
      )}
      <Box
        flexDirection="column"
        backgroundColor="gray"
        paddingX={1}
        paddingY={1}
      >
        <Box flexDirection="row" alignItems="flex-start" minHeight={1}>
          <Text color={isThinking ? "yellow" : "white"}>
            ›
          </Text>
          <Text color="dim"> </Text>
          <Box flexGrow={1} flexDirection="column">
            {formPrompt || choicePrompt || backgroundPanelOpen ? (
              <Text color="dim">
                {formPrompt
                  ? "Complete the form below"
                  : choicePrompt
                  ? "Select an option below"
                  : "Background sessions panel open"}
              </Text>
            ) : (
              <WrappedComposerInput
                value={value}
                onChange={onChange}
                onSubmit={onSubmit}
                placeholder={
                  mode === "plan"
                    ? "Ask for analysis and planning"
                    : placeholder || "Explain this codebase"
                }
                maxVisibleLines={5}
                rightReserve={value.startsWith("/") || queuedMessages > 0 ? 18 : 0}
              />
            )}
          </Box>
          {!formPrompt && !backgroundPanelOpen && value.startsWith("/") && !choicePrompt && (
            <Box marginLeft={1}>
              <Text color="black">
                command
              </Text>
            </Box>
          )}
          {!formPrompt && !backgroundPanelOpen && queuedMessages > 0 && (
            <Box marginLeft={1}>
              <Text color="black">
                {queuedMessages} queued
              </Text>
            </Box>
          )}
        </Box>
      </Box>

      {choicePrompt && onChoiceSelect && (
        <InlineChoicePrompt
          message={choicePrompt.message}
          options={choicePrompt.options}
          defaultValue={choicePrompt.defaultValue}
          onSelect={onChoiceSelect}
        />
      )}

      {formPrompt && onFormSubmit && (
        <InlineFormPrompt
          title={formPrompt.title}
          questions={formPrompt.questions}
          submitLabel={formPrompt.submitLabel}
          onSubmit={onFormSubmit}
        />
      )}

      <Text color="dim">
        Enter send · Esc stop · / commands · ^O {transcriptMode ? "compact" : "transcript"} · ^T {tasksExpanded ? "tasks-" : "tasks+"} · ^B sessions
      </Text>
    </Box>
  ),
  (prev, next) =>
    prev.value === next.value &&
    prev.isThinking === next.isThinking &&
    prev.slashSuggestions === next.slashSuggestions &&
    prev.selectedSuggestion === next.selectedSuggestion &&
    prev.queuedMessages === next.queuedMessages &&
    prev.queueMode === next.queueMode &&
    prev.queuedPreview.join("\n") === next.queuedPreview.join("\n") &&
    prev.mode === next.mode &&
    prev.backgroundPanelOpen === next.backgroundPanelOpen &&
    prev.transcriptMode === next.transcriptMode &&
    prev.tasksExpanded === next.tasksExpanded &&
    prev.choicePrompt === next.choicePrompt &&
    prev.formPrompt === next.formPrompt
);

// ============================================================================
// Footer Bar
// ============================================================================

const FooterBar: React.FC<{
  provider?: string;
  model?: string;
  cwd?: string;
  mode: "edit" | "plan";
  tokens?: { used: number; limit?: number };
  cost?: { current: number; limit?: number };
  messageCount?: number;
  sessionUptime?: number;
}> = React.memo(({ provider, model, cwd, mode, tokens, cost, messageCount, sessionUptime }) => {
  const modeLabel = mode === "plan" ? "plan" : "edit";
  const tokenLabel = tokens?.used ? `${formatCompactNumber(tokens.used)} tok` : null;
  const costLabel = cost && cost.current > 0 ? `$${cost.current.toFixed(3)}` : null;
  const uptimeLabel = typeof sessionUptime === "number" ? formatDurationSeconds(sessionUptime) : null;
  const cwdLabel = basenamePath(cwd);

  return (
    <Box justifyContent="space-between" paddingX={1} marginTop={0}>
      <Box gap={1} flexShrink={1}>
        <Text color="cyan">Meer</Text>
        <Text color="dim">{provider || "unknown"}/{model || "unknown"}</Text>
        <Text color={mode === "plan" ? "blue" : "green"}>{modeLabel}</Text>
        {cwdLabel ? <Text color="dim">{cwdLabel}</Text> : null}
      </Box>
      <Box gap={1} flexShrink={0}>
        {tokenLabel && <Text color="dim">{tokenLabel}</Text>}
        {costLabel && <Text color="dim">{costLabel}</Text>}
        {typeof messageCount === "number" && <Text color="dim">{messageCount} msgs</Text>}
        {uptimeLabel && <Text color="dim">{uptimeLabel}</Text>}
      </Box>
    </Box>
  );
});

const WorkLogSection: React.FC<{
  timelineEvents?: UITimelineEvent[];
  tools?: ToolCall[];
  isThinking: boolean;
  status?: string;
  backgroundSessions?: BackgroundTerminalSession[];
}> = React.memo(({
  timelineEvents = [],
  tools = [],
  backgroundSessions = [],
}) => {
  const hasTools = tools.length > 0;
  const hasBackground = backgroundSessions.length > 0;
  const shouldShow = hasTools || hasBackground || timelineEvents.length > 0;

  if (!shouldShow) {
    return null;
  }

  const rows = buildWorkRows({ timelineEvents, tools, backgroundSessions });
  const activeBackground = backgroundSessions[0];

  return (
    <Box flexDirection="column" marginTop={0} paddingX={1}>
      {activeBackground ? (
        <Box flexDirection="column" marginTop={0} marginBottom={0}>
          <Text color="dim">
            {backgroundSessions.filter((session) => session.status === "running").length} background terminal running
          </Text>
          <Text color="cyan">$ {truncateLine(activeBackground.command, 120)}</Text>
          <Text color="dim">
            {truncateLine(
              activeBackground.output
                .split("\n")
                .filter((line) => line.trim())
                .slice(-1)[0] || "Waiting for background terminal",
              140
            )}
          </Text>
        </Box>
      ) : null}
      {rows
        .filter((row) => row.id !== "working")
        .slice(0, 5)
        .map((row) => (
        <Box key={row.id} flexDirection="column" paddingLeft={1}>
          <Box gap={1}>
            <Text color={row.tone === "error" ? "red" : row.tone === "success" ? "green" : row.tone === "active" ? "yellow" : "dim"}>
              {row.icon}
            </Text>
            <Text color={row.tone === "error" ? "red" : row.tone === "success" ? "white" : "dim"}>
              {row.label}
            </Text>
          </Box>
          {row.detail ? (
            <Box paddingLeft={2}>
              <Text color="dim">{row.detail}</Text>
            </Box>
          ) : null}
        </Box>
      ))}
    </Box>
  );
});

const BackgroundTerminalPanel: React.FC<{
  sessions: BackgroundTerminalSession[];
  selectedIndex: number;
  onStop?: (id: string) => void;
}> = React.memo(({ sessions, selectedIndex, onStop }) => {
  if (sessions.length === 0) {
    return (
      <Box
        flexDirection="column"
        marginTop={1}
        marginX={1}
        paddingX={1}
        borderStyle="round"
        borderColor="gray"
      >
        <Text color="white">Background sessions</Text>
        <Text color="dim">No background sessions.</Text>
      </Box>
    );
  }

  const active = sessions[Math.max(0, Math.min(selectedIndex, sessions.length - 1))];
  const tailLines = active.output
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-10);

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      marginX={1}
      paddingX={1}
      paddingY={0}
      borderStyle="round"
      borderColor="cyan"
    >
      <Box justifyContent="space-between">
        <Text color="cyan" bold>Background sessions</Text>
        <Text color="dim">↑↓ select · x stop · Esc close</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {sessions.slice(0, 6).map((session, index) => (
          <Text
            key={session.id}
            color={index === selectedIndex ? "green" : "white"}
          >
            {index === selectedIndex ? "› " : "  "}
            {session.id} [{session.status}] {truncateLine(session.command, 80)}
          </Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="dim">{truncateLine(active.cwd, 140)}</Text>
        {tailLines.length > 0 ? (
          tailLines.map((line, index) => (
            <Text key={`${active.id}-line-${index}`} color="dim">
              {truncateLine(line, 160)}
            </Text>
          ))
        ) : (
          <Text color="dim">No captured output yet.</Text>
        )}
        {onStop && active.status === "running" ? (
          <Text color="yellow">Press x to stop {active.id}</Text>
        ) : null}
      </Box>
    </Box>
  );
});

// ============================================================================
// Main Chat Component
// ============================================================================

export const MeerChat: React.FC<MeerChatProps> = ({
  onMessage,
  messages,
  draftAssistant,
  isThinking,
  status,
  provider,
  model,
  cwd,
  onExit,
  onInterrupt,
  mode: externalMode,
  onModeChange,
  tools,
  workflowStages,
  tokens,
  cost,
  messageCount,
  sessionUptime,
  virtualizeHistory = false,
  screenReader = false,
  timelineEvents,
  plan,
  slashSuggestions: providedSlashSuggestions,
  choicePrompt,
  onChoiceSelect,
  formPrompt,
  onFormSubmit,
  queuedMessages: externalQueuedMessages,
  queueMode: externalQueueMode = "steer",
  onQueueModeChange,
  backgroundSessions,
  onStopBackgroundSession,
}) => {
  const [input, setInput] = useState("");
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  const [internalMode, setInternalMode] = useState<"edit" | "plan">("edit");
  const [internalQueueMode, setInternalQueueMode] = useState<"steer" | "followUp">("steer");
  const [slashSuggestions, setSlashSuggestions] = useState<SlashCommandListEntry[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [scrollAnchor, setScrollAnchor] = useState<"end" | "manual">("end");
  const [showBackgroundPanel, setShowBackgroundPanel] = useState(false);
  const [selectedBackgroundIndex, setSelectedBackgroundIndex] = useState(0);
  const [showTranscript, setShowTranscript] = useState(false);
  const [showTasksExpanded, setShowTasksExpanded] = useState(false);
  const { exit } = useApp();

  const slashCommandEntries = useMemo(
    () =>
      providedSlashSuggestions && providedSlashSuggestions.length > 0
        ? providedSlashSuggestions
        : getAllCommands(),
    [providedSlashSuggestions]
  );

  const isScreenReader = Boolean(screenReader);
  const mode = externalMode !== undefined ? externalMode : internalMode;
  const queueMode =
    onQueueModeChange !== undefined ? externalQueueMode : internalQueueMode;
  const activeQueue = externalQueuedMessages ?? messageQueue;
  const queuedPreview = useMemo(() => activeQueue.slice(0, 3), [activeQueue]);
  const hasDraftContent = Boolean(draftAssistant?.content.trim());

  const toggleMode = useCallback(() => {
    const newMode: "edit" | "plan" = mode === "edit" ? "plan" : "edit";
    if (onModeChange) {
      onModeChange(newMode);
    } else {
      setInternalMode(newMode);
    }
  }, [mode, onModeChange]);

  const clearSlashSuggestions = useCallback(() => {
    setSlashSuggestions([]);
    setSelectedSuggestion(0);
  }, []);

  const updateSlashSuggestionsImmediate = useCallback(
    (value: string) => {
      const trimmed = value.trimStart();
      if (!trimmed.startsWith("/")) { clearSlashSuggestions(); return; }

      const firstSpace = trimmed.indexOf(" ");
      const commandToken = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
      const hasArguments = firstSpace !== -1 && trimmed.slice(firstSpace + 1).trim().length > 0;

      if (hasArguments) { clearSlashSuggestions(); return; }

      const normalized = commandToken.toLowerCase();
      const options =
        commandToken === "/"
          ? slashCommandEntries
          : slashCommandEntries.filter((e) => e.command.toLowerCase().startsWith(normalized));

      if (options.length === 0) { clearSlashSuggestions(); return; }

      setSlashSuggestions(options);
      setSelectedSuggestion((prev) => (prev < options.length ? prev : 0));
    },
    [clearSlashSuggestions, slashCommandEntries]
  );

  const updateSlashSuggestions = useMemo(
    () => debounce(updateSlashSuggestionsImmediate, { delay: SLASH_DEBOUNCE_MS }),
    [updateSlashSuggestionsImmediate]
  );

  const handleInputChange = useCallback(
    (value: string) => {
      setInput(value);
      updateSlashSuggestions(value);
    },
    [updateSlashSuggestions]
  );

  const sendMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (isThinking && externalQueuedMessages === undefined) {
        setMessageQueue((prev) => [...prev, trimmed]);
      } else {
        setScrollAnchor("end");
        onMessage(trimmed);
      }
    },
    [externalQueuedMessages, isThinking, onMessage]
  );

  const applySlashSuggestion = useCallback(
    (applyMode: "insert" | "send" = "insert") => {
      if (slashSuggestions.length === 0) return;
      const suggestion = slashSuggestions[selectedSuggestion];
      if (applyMode === "send") {
        clearSlashSuggestions();
        handleInputChange("");
        sendMessage(suggestion.command);
        return;
      }
      setInput(`${suggestion.command} `);
      clearSlashSuggestions();
    },
    [clearSlashSuggestions, handleInputChange, sendMessage, slashSuggestions, selectedSuggestion]
  );

  const hasSlashSuggestions = slashSuggestions.length > 0;
  const hasChoicePrompt =
    Boolean(choicePrompt) &&
    Boolean(onChoiceSelect) &&
    (choicePrompt?.options.length ?? 0) > 0;
  const hasFormPrompt =
    Boolean(formPrompt) &&
    Boolean(onFormSubmit) &&
    (formPrompt?.questions.length ?? 0) > 0;
  const hasBackgroundPanel =
    showBackgroundPanel && Boolean(backgroundSessions && backgroundSessions.length >= 0);

  const terminalHeight =
    process.stdout.isTTY && process.stdout.rows ? process.stdout.rows : 24;

  const maxVisibleMessages = useMemo(() => {
    if (!virtualizeHistory) return Number.POSITIVE_INFINITY;
    return Math.max(terminalHeight * 4, 200);
  }, [virtualizeHistory, terminalHeight]);

  const { visibleMessages, hiddenCount } = useMemo(() => {
    if (!virtualizeHistory) return { visibleMessages: messages, hiddenCount: 0 };
    if (!Number.isFinite(maxVisibleMessages) || messages.length <= maxVisibleMessages) {
      return { visibleMessages: messages, hiddenCount: 0 };
    }
    return {
      visibleMessages: messages.slice(-maxVisibleMessages),
      hiddenCount: messages.length - maxVisibleMessages,
    };
  }, [messages, virtualizeHistory, maxVisibleMessages]);

  const scrollWindowSize = Math.max(1, Math.min(visibleMessages.length, terminalHeight * 3));
  const maxScrollOffset = Math.max(0, visibleMessages.length - scrollWindowSize);

  useEffect(() => {
    if (!virtualizeHistory || scrollAnchor === "end") {
      setScrollOffset(maxScrollOffset);
      return;
    }
    setScrollOffset((prev) => Math.max(0, Math.min(prev, maxScrollOffset)));
  }, [virtualizeHistory, scrollAnchor, maxScrollOffset, visibleMessages.length]);

  useEffect(() => {
    if (!virtualizeHistory) {
      setScrollAnchor("end");
      setScrollOffset(0);
    }
  }, [virtualizeHistory]);

  useEffect(() => {
    const count = backgroundSessions?.length ?? 0;
    setSelectedBackgroundIndex((prev) =>
      count === 0 ? 0 : Math.max(0, Math.min(prev, count - 1))
    );
  }, [backgroundSessions]);

  const adjustScroll = useCallback(
    (delta: number) => {
      if (!virtualizeHistory) return;
      setScrollAnchor("manual");
      setScrollOffset((prev) => Math.max(0, Math.min(prev + delta, maxScrollOffset)));
    },
    [virtualizeHistory, maxScrollOffset]
  );

  const jumpToLatest = useCallback(() => {
    setScrollAnchor("end");
    setScrollOffset(maxScrollOffset);
  }, [maxScrollOffset]);

  useInput(
    (inputKey, key) => {
      if (key.ctrl && inputKey === "c") { onExit?.(); exit(); return; }
      if (key.ctrl && inputKey === "p") { toggleMode(); return; }
      if (key.ctrl && inputKey === "o") {
        setShowTranscript((prev) => !prev);
        setScrollAnchor("end");
        return;
      }
      if (key.ctrl && inputKey === "t") {
        setShowTasksExpanded((prev) => !prev);
        return;
      }
      if (key.ctrl && inputKey === "b") {
        setShowBackgroundPanel((prev) => !prev);
        return;
      }
      if (key.ctrl && inputKey === "q") {
        const nextMode: "steer" | "followUp" =
          queueMode === "steer" ? "followUp" : "steer";
        if (onQueueModeChange) {
          onQueueModeChange(nextMode);
        } else {
          setInternalQueueMode(nextMode);
        }
        return;
      }

      if (key.escape) {
        if (hasBackgroundPanel) {
          setShowBackgroundPanel(false);
          return;
        }
        if (hasSlashSuggestions) { clearSlashSuggestions(); return; }
        if (isThinking && onInterrupt) { onInterrupt(); return; }
      }

      if (hasBackgroundPanel) {
        const sessionCount = backgroundSessions?.length ?? 0;
        if (key.upArrow) {
          setSelectedBackgroundIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setSelectedBackgroundIndex((prev) =>
            Math.min(Math.max(0, sessionCount - 1), prev + 1)
          );
          return;
        }
        if ((inputKey === "x" || inputKey === "X") && backgroundSessions?.[selectedBackgroundIndex]) {
          onStopBackgroundSession?.(backgroundSessions[selectedBackgroundIndex].id);
          return;
        }
        return;
      }

      if (hasSlashSuggestions) {
        if (key.tab) { applySlashSuggestion("insert"); return; }
        if (key.upArrow) {
          setSelectedSuggestion((prev) => (prev - 1 + slashSuggestions.length) % slashSuggestions.length);
          return;
        }
        if (key.downArrow) {
          setSelectedSuggestion((prev) => (prev + 1) % slashSuggestions.length);
          return;
        }
      }

      if (!virtualizeHistory || hasSlashSuggestions) return;

      if (key.pageUp) { adjustScroll(-Math.max(1, Math.floor(scrollWindowSize * 0.75))); return; }
      if (key.pageDown) { adjustScroll(Math.max(1, Math.floor(scrollWindowSize * 0.75))); return; }
      if (key.home) { setScrollAnchor("manual"); setScrollOffset(0); return; }
      if (key.end) { jumpToLatest(); }
    },
    { isActive: !hasChoicePrompt && !hasFormPrompt }
  );

  const handleSubmit = useCallback(() => {
    const trimmed = input.trim();
    const commandToken = trimmed.split(/\s+/)[0] ?? "";
    const suggestion = slashSuggestions[selectedSuggestion];
    const shouldApplySlash =
      hasSlashSuggestions &&
      commandToken.startsWith("/") &&
      trimmed === commandToken &&
      suggestion &&
      suggestion.command.toLowerCase().startsWith(commandToken.toLowerCase());

    if (shouldApplySlash) { applySlashSuggestion("send"); return; }
    if (!trimmed) return;

    sendMessage(trimmed);
    handleInputChange("");
  }, [applySlashSuggestion, handleInputChange, input, hasSlashSuggestions, sendMessage, selectedSuggestion, slashSuggestions]);

  useEffect(() => {
    if (externalQueuedMessages !== undefined) {
      return;
    }
    if (!isThinking && messageQueue.length > 0) {
      const nextMessage = messageQueue[0];
      setMessageQueue((prev) => prev.slice(1));
      onMessage(nextMessage);
    }
  }, [externalQueuedMessages, isThinking, messageQueue, onMessage]);

  if (isScreenReader) {
    return (
      <ScreenReaderLayout
        provider={provider}
        model={model}
        cwd={cwd}
        mode={mode}
        status={status}
        isThinking={isThinking}
        tokens={tokens}
        cost={cost}
        hiddenCount={hiddenCount}
        totalMessages={messages.length}
        tools={tools}
        workflowStages={workflowStages}
        messages={visibleMessages}
        plan={plan}
      >
        <InputArea
          value={input}
          onChange={handleInputChange}
          onSubmit={handleSubmit}
          isThinking={isThinking}
          queuedMessages={activeQueue.length}
          queuedPreview={queuedPreview}
          queueMode={queueMode}
          mode={mode}
          slashSuggestions={slashSuggestions}
          selectedSuggestion={selectedSuggestion}
          choicePrompt={choicePrompt}
          onChoiceSelect={onChoiceSelect}
          formPrompt={formPrompt}
          onFormSubmit={onFormSubmit}
          backgroundPanelOpen={hasBackgroundPanel}
          transcriptMode={showTranscript}
          tasksExpanded={showTasksExpanded}
        />
      </ScreenReaderLayout>
    );
  }

  const compactHiddenToolCount = getCompactHiddenToolCount(visibleMessages);
  const transcriptMessages = showTranscript
    ? visibleMessages
    : visibleMessages.filter(shouldRenderTranscriptMessage);
  const displayMessages =
    draftAssistant && hasDraftContent
      ? [...transcriptMessages, draftAssistant]
      : transcriptMessages;

  const displayWindowSize = Math.max(1, Math.min(displayMessages.length, terminalHeight * 3));
  const displayScrollOffset = Math.min(
    scrollOffset,
    Math.max(0, displayMessages.length - displayWindowSize)
  );
  const activePlanTask =
    plan?.tasks.find((task) => task.status === "in_progress") ??
    plan?.tasks.find((task) => task.status === "pending");
  const activeTool = (tools ?? []).find(
    (tool) => tool.status === "running" || tool.status === "pending"
  );
  const turnLooksActive =
    isThinking ||
    Boolean(draftAssistant) ||
    Boolean(activeTool);
  const shouldPinConversationToBottom =
    scrollAnchor === "end" &&
    !hasBackgroundPanel &&
    !hasChoicePrompt &&
    !hasFormPrompt;

  return (
    <Box flexDirection="column" height="100%" width="100%">
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0}>
        {messages.length === 0 ? (
          <Box flexDirection="column" justifyContent="center" flexGrow={1}>
            <BrandMark
              provider={provider}
              model={model}
              cwd={cwd}
            />
            <Box flexDirection="column" alignItems="center">
              <Text color="gray" dimColor>
                Type / for commands · Enter to dive in
              </Text>
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column">
            {hiddenCount > 0 && (
              <Box marginBottom={1} marginLeft={2}>
                <Text color="gray" dimColor>
                  Showing last {visibleMessages.length} of {messages.length} messages.
                </Text>
              </Box>
            )}
            {!showTranscript && compactHiddenToolCount > 0 ? (
              <Box marginBottom={1} marginLeft={2}>
                <Text color="gray" dimColor>
                  Compact view hid {compactHiddenToolCount} completed tool result{compactHiddenToolCount === 1 ? "" : "s"} · ^O transcript
                </Text>
              </Box>
            ) : null}
            {showTranscript ? (
              <Box marginBottom={1} marginLeft={2}>
                <Text color="yellow">
                  Transcript mode
                </Text>
                <Text color="gray" dimColor>
                  {" "}showing raw tool results · ^O compact
                </Text>
              </Box>
            ) : null}
            <Box
              flexDirection="row"
              flexGrow={1}
              minHeight={0}
              alignItems={shouldPinConversationToBottom ? "flex-end" : "flex-start"}
            >
              <Box
                flexDirection="column"
                flexGrow={1}
                minHeight={0}
                justifyContent={shouldPinConversationToBottom ? "flex-end" : "flex-start"}
              >
                <VirtualizedList
                  items={displayMessages}
                  scroll={{
                    offset: displayScrollOffset,
                    windowSize: displayWindowSize,
                    totalCount: displayMessages.length,
                  }}
                  renderGap={(position, hidden) => (
                    <Box marginY={1} paddingLeft={2}>
                      <Text color="dim">
                        {position === "top"
                          ? `${hidden} earlier message${hidden === 1 ? "" : "s"}`
                          : `${hidden} later message${hidden === 1 ? "" : "s"}`}
                      </Text>
                    </Box>
                  )}
                  renderItem={(msg) => (
                    <MessageView
                      message={msg}
                      isDraft={Boolean(draftAssistant && msg.id === draftAssistant.id)}
                    />
                  )}
                />
              </Box>
              {virtualizeHistory && displayMessages.length > 0 && (
                <Box marginLeft={1}>
                  <ScrollIndicator
                    offset={displayScrollOffset}
                    windowSize={displayWindowSize}
                    totalCount={displayMessages.length}
                  />
                </Box>
              )}
            </Box>
            {virtualizeHistory && scrollAnchor === "manual" && (
              <Box marginLeft={2}>
                <Text color="gray" dimColor>
                  PageUp/PageDown to scroll · End for latest
                </Text>
              </Box>
            )}
          </Box>
        )}
      </Box>

      {plan ? (
        <PlanPanel
          plan={plan}
          maxVisibleTasks={showTasksExpanded ? Number.POSITIVE_INFINITY : 9}
          hiddenHint="^T tasks"
        />
      ) : null}

      <TurnActivityIndicator
        active={turnLooksActive}
        status={status}
        isStreaming={hasDraftContent}
        activeTask={activePlanTask?.description}
        activeTool={activeTool?.name}
        tokens={tokens}
      />

      <WorkLogSection
        timelineEvents={timelineEvents}
        tools={tools}
        isThinking={isThinking}
        status={status}
        backgroundSessions={backgroundSessions}
      />
      {hasBackgroundPanel && (
        <BackgroundTerminalPanel
          sessions={backgroundSessions ?? []}
          selectedIndex={selectedBackgroundIndex}
          onStop={onStopBackgroundSession}
        />
      )}

      <InputArea
        value={input}
        onChange={handleInputChange}
        onSubmit={handleSubmit}
        isThinking={isThinking}
        queuedMessages={activeQueue.length}
        queuedPreview={queuedPreview}
        queueMode={queueMode}
        mode={mode}
        slashSuggestions={slashSuggestions}
        selectedSuggestion={selectedSuggestion}
        choicePrompt={choicePrompt}
        onChoiceSelect={onChoiceSelect}
        formPrompt={formPrompt}
        onFormSubmit={onFormSubmit}
        backgroundPanelOpen={hasBackgroundPanel}
        transcriptMode={showTranscript}
        tasksExpanded={showTasksExpanded}
      />

      <FooterBar
        provider={provider}
        model={model}
        cwd={cwd}
        mode={mode}
        tokens={tokens}
        cost={cost}
        messageCount={messageCount}
        sessionUptime={sessionUptime}
      />
    </Box>
  );
};

// ============================================================================
// Inline Choice Prompt
// ============================================================================

const InlineChoicePrompt: React.FC<{
  message: string;
  options: Array<{ label: string; value: string }>;
  defaultValue: string;
  onSelect: (value: string) => void;
}> = ({ message, options, defaultValue, onSelect }) => {
  const initialIndex = useMemo(() => {
    const idx = options.findIndex((o) => o.value === defaultValue);
    return idx >= 0 ? idx : 0;
  }, [defaultValue, options]);
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);

  useEffect(() => {
    setSelectedIndex(initialIndex);
  }, [initialIndex]);

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelectedIndex((prev) => (prev - 1 + options.length) % options.length);
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => (prev + 1) % options.length);
      return;
    }
    if (key.return) {
      const selected = options[selectedIndex];
      if (selected) {
        onSelect(selected.value);
      }
    }
  });

  return (
    <ScrollableSelector
      title={message}
      selectedIndex={selectedIndex}
      help="↑↓ navigate · Enter select"
      items={options.map((option) => ({
        key: option.value,
        label: option.label,
      }))}
    />
  );
};

const InlineFormPrompt: React.FC<{
  title: string;
  questions: Array<{
    id: string;
    label: string;
    type: "select" | "multiselect";
    required?: boolean;
    options: Array<{ label: string; value: string; description?: string }>;
  }>;
  submitLabel: string;
  onSubmit: (answers: Record<string, string | string[]>) => void;
}> = ({ title, questions, submitLabel, onSubmit }) => {
  const [focusIndex, setFocusIndex] = useState(0);
  const [cursorByQuestion, setCursorByQuestion] = useState<Record<string, number>>(
    () =>
      Object.fromEntries(questions.map((question) => [question.id, 0]))
  );
  const [answers, setAnswers] = useState<Record<string, string | string[]>>(() =>
    Object.fromEntries(
      questions.map((question) => [
        question.id,
        question.type === "multiselect" ? [] : question.options[0]?.value ?? "",
      ])
    )
  );

  const totalStops = questions.length + 1;
  const isSubmitFocused = focusIndex === questions.length;
  const activeQuestion = questions[Math.min(focusIndex, questions.length - 1)];
  const activeCursor = activeQuestion ? cursorByQuestion[activeQuestion.id] ?? 0 : 0;

  const canSubmit = questions.every((question) => {
    if (!question.required) return true;
    const value = answers[question.id];
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  });

  useInput((input, key) => {
    if (key.tab || key.downArrow) {
      if (isSubmitFocused) return;
      setFocusIndex((prev) => Math.min(prev + 1, totalStops - 1));
      return;
    }

    if (key.upArrow) {
      setFocusIndex((prev) => Math.max(prev - 1, 0));
      return;
    }

    if (isSubmitFocused) {
      if (key.return && canSubmit) {
        onSubmit(answers);
      }
      return;
    }

    if (!activeQuestion) {
      return;
    }

    const optionCount = activeQuestion.options.length;
    if (key.leftArrow) {
      setCursorByQuestion((prev) => ({
        ...prev,
        [activeQuestion.id]: Math.max(0, activeCursor - 1),
      }));
      return;
    }

    if (key.rightArrow) {
      setCursorByQuestion((prev) => ({
        ...prev,
        [activeQuestion.id]: Math.min(optionCount - 1, activeCursor + 1),
      }));
      return;
    }

    if (input === " ") {
      if (activeQuestion.type === "multiselect") {
        const value = activeQuestion.options[activeCursor]?.value;
        if (!value) return;
        setAnswers((prev) => {
          const current = Array.isArray(prev[activeQuestion.id])
            ? [...(prev[activeQuestion.id] as string[])]
            : [];
          const next = current.includes(value)
            ? current.filter((entry) => entry !== value)
            : [...current, value];
          return {
            ...prev,
            [activeQuestion.id]: next,
          };
        });
      }
      return;
    }

    if (key.return) {
      const value = activeQuestion.options[activeCursor]?.value;
      if (!value) return;
      if (activeQuestion.type === "select") {
        setAnswers((prev) => ({
          ...prev,
          [activeQuestion.id]: value,
        }));
      }
      setFocusIndex((prev) => Math.min(prev + 1, totalStops - 1));
    }
  });

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      paddingX={1}
      paddingY={1}
      borderStyle="round"
      borderColor="cyan"
    >
      <Text color="cyan" bold>
        {title}
      </Text>
      <Text color="dim">
        Tab/↑↓ move · ←→ change option · Space toggle checkbox · Enter confirm
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {questions.map((question, questionIndex) => {
          const isFocused = focusIndex === questionIndex;
          const selectedValues = Array.isArray(answers[question.id])
            ? (answers[question.id] as string[])
            : [];
          const selectedValue =
            typeof answers[question.id] === "string" ? (answers[question.id] as string) : "";

          return (
            <Box key={question.id} flexDirection="column" marginBottom={1}>
              <Text color={isFocused ? "yellow" : "white"}>
                {isFocused ? "› " : "  "}
                {question.label}
                {question.required ? " *" : ""}
              </Text>
              <Box flexDirection="column" paddingLeft={3}>
                {question.options.map((option, optionIndex) => {
                  const isCursor =
                    isFocused &&
                    (cursorByQuestion[question.id] ?? 0) === optionIndex;
                  const selected =
                    question.type === "multiselect"
                      ? selectedValues.includes(option.value)
                      : selectedValue === option.value;
                  const marker =
                    question.type === "multiselect"
                      ? selected
                        ? "[x]"
                        : "[ ]"
                      : selected
                        ? "(•)"
                        : "( )";

                  return (
                    <Text
                      key={`${question.id}-${option.value}`}
                      color={isCursor ? "green" : selected ? "white" : "dim"}
                    >
                      {isCursor ? "→ " : "  "}
                      {marker} {option.label}
                      {option.description ? ` — ${option.description}` : ""}
                    </Text>
                  );
                })}
              </Box>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={isSubmitFocused ? (canSubmit ? "green" : "yellow") : "dim"}>
          {isSubmitFocused ? "› " : "  "}
          [{submitLabel}]
        </Text>
      </Box>
      {!canSubmit && (
        <Text color="yellow" dimColor>
          Complete all required questions before submitting.
        </Text>
      )}
    </Box>
  );
};

// ============================================================================
// Screen Reader Layout
// ============================================================================

const ScreenReaderLayout: React.FC<{
  provider?: string;
  model?: string;
  cwd?: string;
  mode: "edit" | "plan";
  status?: string;
  isThinking: boolean;
  tokens?: { used: number; limit?: number };
  cost?: { current: number; limit?: number };
  hiddenCount: number;
  totalMessages: number;
  tools?: ToolCall[];
  workflowStages?: WorkflowStage[];
  messages: Message[];
  plan?: Plan | null;
  children: React.ReactNode;
}> = ({
  provider, model, cwd, mode, status, isThinking, tokens, cost,
  hiddenCount, totalMessages, tools, workflowStages, messages, plan, children,
}) => {
  const modeLabel = mode === "plan" ? "Plan" : "Edit";

  return (
    <Box flexDirection="column" gap={1}>
      <Text color="cyan" bold>Screen reader mode enabled</Text>
      <Text>Profile: {provider ?? "unknown"} / {model ?? "unknown"} · Mode: {modeLabel}</Text>
      <Text>Directory: {cwd ?? process.cwd()}</Text>
      {tokens && <Text>Tokens: {tokens.used}{tokens.limit ? ` / ${tokens.limit}` : ""}</Text>}
      {cost && cost.current > 0 && <Text>Cost: ${cost.current.toFixed(4)}</Text>}
      {tools && tools.length > 0 && (
        <Text>Active tools: {tools.map((t) => t.name ?? "tool").join(", ")}</Text>
      )}
      {workflowStages && workflowStages.length > 0 && (
        <Box flexDirection="column">
          <Text>Workflow:</Text>
          {workflowStages.map((s, i) => (
            <Text key={s.name}>{i + 1}. {s.name} - {s.status}</Text>
          ))}
        </Box>
      )}
      {plan && (
        <Box flexDirection="column">
          <Text>Plan: {plan.title}</Text>
          {plan.tasks.slice(0, 5).map((task, i) => (
            <Text key={task.id}>
              {task.status === "completed"
                ? "[x]"
                : task.status === "in_progress"
                ? "[~]"
                : task.status === "skipped"
                ? "[-]"
                : "[ ]"}{" "}
              {task.id || String(i + 1)} {task.description}
            </Text>
          ))}
          {plan.tasks.length > 5 && <Text color="dim">+{plan.tasks.length - 5} more</Text>}
        </Box>
      )}
      <Box flexDirection="column">
        {messages.length === 0 ? (
          <Text>No messages yet.</Text>
        ) : (
          messages.map((msg, i) => (
            <Text key={i}>
              {formatTimestamp(msg.timestamp) ? `[${formatTimestamp(msg.timestamp)}] ` : ""}
              {msg.role === "assistant" ? "Meer" : msg.role === "user" ? "You" : msg.role === "system" ? "System" : "Tool"}:{" "}
              {msg.content?.replace(/\s+/g, " ").trim() || "[empty]"}
            </Text>
          ))
        )}
        {hiddenCount > 0 && (
          <Text dimColor>Showing {messages.length} of {totalMessages} messages.</Text>
        )}
        {isThinking && <Text>Assistant is thinking…</Text>}
        {status && !isThinking && <Text>Status: {status}</Text>}
      </Box>
      {children}
    </Box>
  );
};

// ============================================================================
// Utilities
// ============================================================================

function truncateLine(value: string, maxLength: number): string {
  const s = value.replace(/\s+/g, " ").trim();
  return s.length <= maxLength ? s : `${s.slice(0, maxLength - 1)}…`;
}

function basenamePath(value?: string): string {
  if (!value) return "";
  const normalized = value.replace(/\/+$/, "");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || normalized;
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatDurationSeconds(value: number): string {
  const total = Math.max(0, Math.floor(value));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}

export default MeerChat;
