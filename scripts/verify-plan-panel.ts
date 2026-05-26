import assert from "node:assert/strict";
import { selectVisiblePlanTasks } from "../src/ui/ink/components/plan/PlanPanel.js";
import type { PlanTask } from "../src/plan/types.js";

function task(index: number, status: PlanTask["status"]): PlanTask {
  return {
    id: `task-${index}`,
    description: `Task ${index}`,
    status,
  };
}

function verifyShowsLatePendingTask(): void {
  const tasks = [
    task(1, "completed"),
    task(2, "completed"),
    task(3, "completed"),
    task(4, "completed"),
    task(5, "completed"),
    task(6, "completed"),
    task(7, "completed"),
    task(8, "completed"),
    task(9, "pending"),
  ];
  const visible = selectVisiblePlanTasks(tasks, 6);
  assert.ok(
    visible.some((candidate) => candidate.id === "task-9"),
    "late pending task should stay visible in compact mode"
  );
}

function verifyShowsLateActiveTask(): void {
  const tasks = [
    task(1, "completed"),
    task(2, "completed"),
    task(3, "completed"),
    task(4, "completed"),
    task(5, "completed"),
    task(6, "completed"),
    task(7, "in_progress"),
    task(8, "pending"),
    task(9, "pending"),
  ];
  const visible = selectVisiblePlanTasks(tasks, 6);
  assert.ok(
    visible.some((candidate) => candidate.id === "task-7"),
    "late active task should stay visible in compact mode"
  );
  assert.ok(
    visible.some((candidate) => candidate.id === "task-8"),
    "neighboring pending task should stay visible near active task"
  );
}

verifyShowsLatePendingTask();
verifyShowsLateActiveTask();
console.log("✅ Plan panel selection verified.");
