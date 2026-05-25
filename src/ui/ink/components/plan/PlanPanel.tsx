import React from "react";
import { Box, Text } from "ink";
import type { Plan } from "../../../../plan/types.js";

export interface PlanPanelProps {
  plan: Plan;
  maxVisibleTasks?: number;
}

const STATUS_MARK: Record<string, { mark: string; color: "gray" | "yellow" | "green" | "magenta" }> = {
  pending:     { mark: "·", color: "gray" },
  in_progress: { mark: "◆", color: "yellow" },
  completed:   { mark: "✓", color: "green" },
  skipped:     { mark: "–", color: "magenta" },
};

export const PlanPanel: React.FC<PlanPanelProps> = React.memo(({
  plan,
  maxVisibleTasks = 8,
}) => {
  if (!plan || plan.tasks.length === 0) {
    return null;
  }

  const completed = plan.tasks.filter((t) => t.status === "completed").length;
  const visibleTasks = plan.tasks.slice(0, maxVisibleTasks);
  const hiddenCount = plan.tasks.length - visibleTasks.length;

  return (
    <Box flexDirection="column" marginBottom={1} paddingX={1}>
      <Box gap={1} marginBottom={0}>
        <Text color="blue" bold>{plan.title}</Text>
        <Text color="gray" dimColor>({completed}/{plan.tasks.length})</Text>
      </Box>
      {visibleTasks.map((task, index) => {
        const meta = STATUS_MARK[task.status] ?? STATUS_MARK.pending;
        const dimmed = task.status === "pending" || task.status === "skipped";
        return (
          <Box key={task.id} gap={1}>
            <Text color={meta.color} dimColor={dimmed}>{meta.mark}</Text>
            <Text color={meta.color} dimColor={dimmed}>
              {index + 1}. {task.description}
            </Text>
          </Box>
        );
      })}
      {hiddenCount > 0 && (
        <Box marginLeft={2}>
          <Text color="gray" dimColor>+{hiddenCount} more</Text>
        </Box>
      )}
    </Box>
  );
});

export default PlanPanel;
