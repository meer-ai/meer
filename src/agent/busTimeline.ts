import type { Timeline, TaskOptions, InfoOptions } from "../ui/workflowTimeline.js";
import type { AgentEventBus, AgentLogLevel } from "./eventBus.js";

export class BusTimeline implements Timeline {
  private sequence = 0;
  private readonly labelMap = new Map<string, string>();
  private readonly fallbackIds = new Map<string, string>();

  constructor(
    private readonly bus?: AgentEventBus,
    private readonly fallback?: Timeline,
  ) {}

  startTask(label: string, options?: TaskOptions): string {
    const id = this.nextId("task");
    this.labelMap.set(id, label);
    this.bus?.emitTask({
      id,
      label,
      detail: options?.detail,
      status: "started",
      timestamp: Date.now(),
    });
    if (this.fallback) {
      const fallbackId = this.fallback.startTask(label, options);
      this.fallbackIds.set(id, fallbackId);
    }
    return id;
  }

  updateTask(id: string, detail: string): void {
    const label = this.labelMap.get(id) ?? detail;
    this.bus?.emitTask({
      id,
      label,
      detail,
      status: "updated",
      timestamp: Date.now(),
    });
    this.withFallback(id, (fallbackId) => this.fallback?.updateTask(fallbackId, detail));
  }

  succeed(id: string, detail?: string): void {
    const label = this.labelMap.get(id) ?? detail ?? "";
    this.labelMap.delete(id);
    this.bus?.emitTask({
      id,
      label,
      detail,
      status: "succeeded",
      timestamp: Date.now(),
    });
    this.withFallback(id, (fallbackId) => this.fallback?.succeed(fallbackId, detail));
  }

  fail(id: string, detail?: string): void {
    const label = this.labelMap.get(id) ?? detail ?? "";
    this.labelMap.delete(id);
    this.bus?.emitTask({
      id,
      label,
      detail,
      status: "failed",
      timestamp: Date.now(),
    });
    this.withFallback(id, (fallbackId) => this.fallback?.fail(fallbackId, detail));
  }

  info(message: string, options?: InfoOptions): void {
    this.emitLog("info", message);
    this.fallback?.info(message, options);
  }

  note(message: string): void {
    this.emitLog("note", message);
    this.fallback?.note(message);
  }

  warn(message: string): void {
    this.emitLog("warn", message);
    this.fallback?.warn(message);
  }

  error(message: string): void {
    this.emitLog("error", message);
    this.fallback?.error(message);
  }

  close(): void {
    if (this.fallback) {
      this.fallback.close();
    }
  }

  private emitLog(level: AgentLogLevel, message: string): void {
    this.bus?.emitLog({
      id: this.nextId("log"),
      level,
      message,
      timestamp: Date.now(),
    });
  }

  private withFallback(id: string, action: (fallbackId: string) => void): void {
    const fallbackId = this.fallbackIds.get(id);
    if (fallbackId) {
      action(fallbackId);
    }
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }
}

