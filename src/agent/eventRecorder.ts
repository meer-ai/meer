import type { AgentEventBus, AgentLogEvent, AgentTaskEvent, AgentToolEvent } from "./eventBus.js";
import type { UITimelineEvent } from "../ui/ink/timelineTypes.js";
import type { Plan } from "../plan/types.js";

const MAX_EVENTS = 400;

const clonePlan = (plan: Plan): Plan => ({
  ...plan,
  tasks: plan.tasks.map((task) => ({ ...task })),
});

export class AgentEventRecorder {
  private timelineEvents: UITimelineEvent[] = [];
  private plan: Plan | null = null;
  private toolEvents: AgentToolEvent[] = [];
  private readonly disposers: Array<() => void> = [];

  constructor(private readonly bus: AgentEventBus) {
    this.disposers.push(
      bus.onTask((event) => this.handleTask(event)),
      bus.onLog((event) => this.handleLog(event)),
      bus.onPlan(({ plan }) => {
        this.plan = plan ? clonePlan(plan) : null;
      }),
      bus.onTool((event) => this.handleTool(event)),
    );
  }

  dispose(): void {
    this.disposers.forEach((dispose) => dispose());
    this.disposers.length = 0;
  }

  getTimelineEvents(limit?: number): UITimelineEvent[] {
    if (typeof limit === "number" && limit > 0) {
      return this.timelineEvents.slice(-limit);
    }
    return [...this.timelineEvents];
  }

  getPlanSnapshot(): Plan | null {
    return this.plan ? clonePlan(this.plan) : null;
  }

  getToolEvents(): AgentToolEvent[] {
    return [...this.toolEvents];
  }

  private handleTask(event: AgentTaskEvent): void {
    this.recordEvent({
      id: event.id,
      type: "task",
      status: event.status,
      label: event.label,
      detail: event.detail,
      timestamp: event.timestamp,
    });
  }

  private handleLog(event: AgentLogEvent): void {
    this.recordEvent({
      id: event.id,
      type: "log",
      level: event.level,
      message: event.message,
      timestamp: event.timestamp,
    });
  }

  private handleTool(event: AgentToolEvent): void {
    this.toolEvents = [...this.toolEvents, event].slice(-MAX_EVENTS);
    const summary =
      event.status === "failed"
        ? `Tool ${event.tool} failed${event.error ? `: ${event.error}` : ""}`
        : event.status === "succeeded"
        ? `Tool ${event.tool} completed`
        : `Tool ${event.tool} ${event.status}`;
    this.recordEvent({
      id: event.id,
      type: "log",
      level: event.status === "failed" ? "error" : "note",
      message: summary,
      timestamp: event.timestamp,
    });
  }

  private recordEvent(event: UITimelineEvent): void {
    const events = [...this.timelineEvents, event];
    if (events.length > MAX_EVENTS) {
      events.splice(0, events.length - MAX_EVENTS);
    }
    this.timelineEvents = events;
  }
}

