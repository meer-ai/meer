export type PlanTaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "skipped";

export interface PlanTask {
  id: string;
  description: string;
  status: PlanTaskStatus;
  notes?: string;
}

export interface Plan {
  title: string;
  tasks: PlanTask[];
  createdAt: number;
  updatedAt: number;
}

