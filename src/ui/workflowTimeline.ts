import ora, { type Ora } from "ora";
import chalk from "chalk";

type TaskStatus = "pending" | "success" | "error";

interface Task {
  id: string;
  label: string;
  detail?: string;
  spinner?: Ora;
  status: TaskStatus;
  startedAt: number;
  color?: string;
}

export interface TaskOptions {
  detail?: string;
  spinner?: boolean;
  color?: string;
}

export interface InfoOptions {
  icon?: string;
  color?: string;
  dim?: boolean;
}

const PALETTE = {
  primary: "#0ea5e9",
  accent: "#06b6d4",
  success: "#14b8a6",
  danger: "#f87171",
  warning: "#f97316",
  muted: "#64748b",
};

export interface Timeline {
  startTask(label: string, options?: TaskOptions): string;
  updateTask(id: string, detail: string): void;
  succeed(id: string, detail?: string): void;
  fail(id: string, detail?: string): void;
  info(message: string, options?: InfoOptions): void;
  note(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  close(): void;
}

/**
 * WorkflowTimeline provides a consistent, ocean-themed task log for CLI workflows.
 * It wraps ora spinners so tasks can be promoted to success/error states with
 * clean, color-coordinated output that matches Meer's brand.
 */
export class WorkflowTimeline implements Timeline {
  private tasks = new Map<string, Task>();
  private sequence = 0;

  startTask(label: string, options: TaskOptions = {}): string {
    const id = `task-${++this.sequence}`;
    const color = options.color || PALETTE.accent;
    const detail = options.detail;
    const spinnerEnabled = options.spinner !== false;

    if (!spinnerEnabled) {
      console.log(this.formatLine("•", label, detail, color));
      this.tasks.set(id, {
        id,
        label,
        detail,
        status: "pending",
        startedAt: Date.now(),
        color,
      });
      return id;
    }

    const spinner = ora({
      text: this.formatSpinnerText(label, detail, color),
      color: "cyan",
    }).start();

    this.tasks.set(id, {
      id,
      label,
      detail,
      spinner,
      status: "pending",
      startedAt: Date.now(),
      color,
    });

    return id;
  }

  updateTask(id: string, detail: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.detail = detail;
    if (task.spinner) {
      task.spinner.text = this.formatSpinnerText(task.label, detail, task.color);
    }
  }

  succeed(id: string, detail?: string): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== "pending") return;
    task.status = "success";
    task.detail = detail ?? task.detail;
    if (task.spinner) {
      task.spinner.succeed(
        this.formatLine("✔", task.label, task.detail, PALETTE.success)
      );
    } else {
      console.log(this.formatLine("✔", task.label, task.detail, PALETTE.success));
    }
    this.tasks.delete(id);
  }

  fail(id: string, detail?: string): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== "pending") return;
    task.status = "error";
    task.detail = detail ?? task.detail;
    if (task.spinner) {
      task.spinner.fail(
        this.formatLine("✖", task.label, task.detail, PALETTE.danger)
      );
    } else {
      console.log(this.formatLine("✖", task.label, task.detail, PALETTE.danger));
    }
    this.tasks.delete(id);
  }

  info(message: string, options: InfoOptions = {}): void {
    const icon = options.icon ?? "•";
    const color = options.color ?? PALETTE.accent;
    const content = options.dim ? chalk.dim(message) : chalk.white(message);
    console.log(`${chalk.hex(color)(icon)} ${content}`);
  }

  note(message: string): void {
    this.info(message, { icon: "·", color: PALETTE.primary, dim: true });
  }

  warn(message: string): void {
    this.info(message, { icon: "⚠", color: PALETTE.warning });
  }

  error(message: string): void {
    this.info(message, { icon: "✖", color: PALETTE.danger });
  }

  close(): void {
    for (const task of this.tasks.values()) {
      if (task.status !== "pending") continue;
      if (task.spinner) {
        task.spinner.stopAndPersist({
          symbol: chalk.hex(PALETTE.muted)("•"),
          text: this.formatLine("•", task.label, task.detail, PALETTE.muted),
        });
      } else {
        console.log(this.formatLine("•", task.label, task.detail, PALETTE.muted));
      }
    }
    this.tasks.clear();
  }

  private formatLine(
    icon: string,
    label: string,
    detail?: string,
    color?: string
  ): string {
    const main = `${chalk.hex(color ?? PALETTE.accent)(icon)} ${chalk.white(label)}`;
    const extra =
      detail && detail.trim().length > 0 ? chalk.gray(` (${detail})`) : "";
    return `${main}${extra}`;
  }

  private formatSpinnerText(label: string, detail?: string, color?: string): string {
    const detailText =
      detail && detail.trim().length > 0 ? chalk.gray(` (${detail})`) : "";
    return `${chalk.hex(color ?? PALETTE.accent)(label)}${detailText}`;
  }
}
