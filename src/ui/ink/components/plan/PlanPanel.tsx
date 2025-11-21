import React from "react";
import { Box, Text } from "ink";
import type { Plan } from "../../../../plan/types.js";

export interface PlanPanelProps {
  plan: Plan;
  maxVisibleTasks?: number;
}

const STATUS_META = {
  pending: { icon: "📌", color: "gray" as const },
  in_progress: { icon: "⏳", color: "yellow" as const },
  completed: { icon: "✅", color: "green" as const },
  skipped: { icon: "⏭️", color: "magenta" as const },
};

export const PlanPanel: React.FC<PlanPanelProps> = ({
  plan,
  maxVisibleTasks = 6,
}) => {
  if (!plan || plan.tasks.length === 0) {
    return null;
  }

  const completed = plan.tasks.filter((task) => task.status === "completed").length;
  const visibleTasks = plan.tasks.slice(0, maxVisibleTasks);
  const hiddenCount = plan.tasks.length - visibleTasks.length;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      paddingY={0}
      marginBottom={1}
    >
      <Box justifyContent="space-between" alignItems="center">
        <Text color="magenta" bold>
          📋 {plan.title}
        </Text>
        <Text color="gray" dimColor>
          {completed}/{plan.tasks.length} complete
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1} gap={0}>
        {visibleTasks.map((task, index) => {
          const meta = STATUS_META[task.status];
          return (
            <Box key={task.id} flexDirection="column" marginBottom={0}>
              <Box gap={1}>
                <Text color={meta.color}>{meta.icon}</Text>
                <Text
                  color={meta.color}
                  dimColor={task.status === "pending"}
                >
                  {index + 1}. {task.description}
                </Text>
              </Box>
              {task.notes && (
                <Box marginLeft={4}>
                  <Text color="gray" dimColor>
                    Note: {task.notes}
                  </Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>

      {hiddenCount > 0 && (
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            +{hiddenCount} more task{hiddenCount === 1 ? "" : "s"}
          </Text>
        </Box>
      )}
    </Box>
  );
};

export default PlanPanel;

