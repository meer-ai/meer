import React from "react";
import { Box, Text } from "ink";
import type { Plan, PlanTask } from "../../../../plan/types.js";

export interface PlanPanelProps {
  plan: Plan;
  maxVisibleTasks?: number;
  hiddenHint?: string;
}

const STATUS_MARK: Record<
  string,
  { mark: string; color: "gray" | "yellow" | "green" | "magenta"; dim?: boolean }
> = {
  pending: { mark: "[ ]", color: "gray", dim: true },
  in_progress: { mark: "[~]", color: "yellow" },
  completed: { mark: "[x]", color: "green" },
  skipped: { mark: "[-]", color: "magenta", dim: true },
};

function countByStatus(tasks: PlanTask[]): Record<string, number> {
  return tasks.reduce<Record<string, number>>((counts, task) => {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
    return counts;
  }, {});
}

function formatHiddenSummary(tasks: PlanTask[]): string {
  const counts = countByStatus(tasks);
  const parts = [
    counts.in_progress ? `${counts.in_progress} active` : "",
    counts.pending ? `${counts.pending} pending` : "",
    counts.completed ? `${counts.completed} done` : "",
    counts.skipped ? `${counts.skipped} skipped` : "",
  ].filter(Boolean);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

export function selectVisiblePlanTasks(
  tasks: PlanTask[],
  maxVisibleTasks: number
): PlanTask[] {
  if (!Number.isFinite(maxVisibleTasks) || tasks.length <= maxVisibleTasks) {
    return tasks;
  }

  const limit = Math.max(1, Math.floor(maxVisibleTasks));
  const selected = new Map<string, PlanTask>();
  const add = (task: PlanTask | undefined) => {
    if (task && selected.size < limit) selected.set(task.id, task);
  };

  const activeIndex = tasks.findIndex((task) => task.status === "in_progress");
  const firstPendingIndex = tasks.findIndex((task) => task.status === "pending");
  const focusIndex = activeIndex >= 0 ? activeIndex : firstPendingIndex;

  if (focusIndex >= 0) {
    add(tasks[focusIndex]);
    for (let radius = 1; selected.size < limit && radius < tasks.length; radius++) {
      add(tasks[focusIndex - radius]);
      add(tasks[focusIndex + radius]);
    }
  }

  for (const task of tasks) {
    if (selected.size >= limit) break;
    if (task.status !== "completed") add(task);
  }

  for (let index = tasks.length - 1; index >= 0 && selected.size < limit; index--) {
    add(tasks[index]);
  }

  return tasks.filter((task) => selected.has(task.id));
}

export const PlanPanel: React.FC<PlanPanelProps> = React.memo(({
  plan,
  maxVisibleTasks = 6,
  hiddenHint,
}) => {
  if (!plan || plan.tasks.length === 0) {
    return null;
  }

  const completed = plan.tasks.filter((t) => t.status === "completed").length;
  const active = plan.tasks.find((t) => t.status === "in_progress");
  const nextPending = plan.tasks.find((t) => t.status === "pending");
  const visibleTasks = selectVisiblePlanTasks(plan.tasks, maxVisibleTasks);
  const visibleIds = new Set(visibleTasks.map((task) => task.id));
  const hiddenTasks = plan.tasks.filter((task) => !visibleIds.has(task.id));
  const hiddenCount = hiddenTasks.length;
  const progress =
    plan.tasks.length > 0 ? Math.round((completed / plan.tasks.length) * 100) : 0;

  return (
    <Box flexDirection="column" marginBottom={1} paddingX={1}>
      <Box gap={1}>
        <Text color="blue">Plan</Text>
        <Text color="gray" dimColor>{completed}/{plan.tasks.length}</Text>
        <Text color="gray" dimColor>{progress}%</Text>
        <Text color="gray" dimColor>{plan.title}</Text>
      </Box>
      {active ? (
        <Box marginLeft={2}>
          <Text color="yellow">now </Text>
          <Text>{active.description}</Text>
        </Box>
      ) : nextPending ? (
        <Box marginLeft={2}>
          <Text color="yellow">next </Text>
          <Text>{nextPending.description}</Text>
        </Box>
      ) : completed === plan.tasks.length ? (
        <Box marginLeft={2}>
          <Text color="green">done </Text>
          <Text color="gray" dimColor>all tasks completed</Text>
        </Box>
      ) : null}
      {visibleTasks.map((task, index) => {
        const meta = STATUS_MARK[task.status] ?? STATUS_MARK.pending;
        const taskIndex = plan.tasks.findIndex((candidate) => candidate.id === task.id) + 1;
        return (
          <Box key={task.id} flexDirection="column" marginLeft={2}>
            <Box gap={1}>
              <Text color={meta.color} dimColor={meta.dim}>{meta.mark}</Text>
              <Text color="gray" dimColor>{taskIndex > 0 ? `${taskIndex}.` : `${index + 1}.`}</Text>
              <Text color={meta.color} dimColor={meta.dim}>
                {task.description}
              </Text>
            </Box>
            {task.notes ? (
              <Box marginLeft={6}>
                <Text color="gray" dimColor>{task.notes}</Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
      {hiddenCount > 0 && (
        <Box marginLeft={2}>
          <Text color="gray" dimColor>
            +{hiddenCount} more{formatHiddenSummary(hiddenTasks)}
            {hiddenHint ? ` · ${hiddenHint}` : ""}
          </Text>
        </Box>
      )}
    </Box>
  );
});

export default PlanPanel;
