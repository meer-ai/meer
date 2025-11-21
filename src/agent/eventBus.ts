import { EventEmitter } from "events";
import type { Plan } from "../plan/types.js";

export type AgentTaskStatus = "started" | "updated" | "succeeded" | "failed";

export interface AgentTaskEvent {
  id: string;
  label: string;
  detail?: string;
  status: AgentTaskStatus;
  timestamp: number;
}

export type AgentLogLevel = "info" | "note" | "warn" | "error";

export interface AgentLogEvent {
  id: string;
  level: AgentLogLevel;
  message: string;
  timestamp: number;
}

export interface AgentPlanEvent {
  plan: Plan | null;
  timestamp: number;
}

export type AgentToolStatus = "pending" | "running" | "succeeded" | "failed";

export interface AgentToolEvent {
  id: string;
  tool: string;
  status: AgentToolStatus;
  timestamp: number;
  argsPreview?: string;
  resultPreview?: string;
  error?: string;
}

type AgentEventMap = {
  task: AgentTaskEvent;
  log: AgentLogEvent;
  plan: AgentPlanEvent;
  tool: AgentToolEvent;
};

type AgentEventName = keyof AgentEventMap;
type AgentEventListener<T extends AgentEventName> = (event: AgentEventMap[T]) => void;

export class AgentEventBus {
  private readonly emitter = new EventEmitter();

  emitTask(event: AgentTaskEvent): void {
    this.emitter.emit("task", event);
  }

  emitLog(event: AgentLogEvent): void {
    this.emitter.emit("log", event);
  }

  emitPlan(plan: Plan | null): void {
    this.emitter.emit("plan", { plan, timestamp: Date.now() });
  }

  emitTool(event: AgentToolEvent): void {
    this.emitter.emit("tool", event);
  }

  onTask(listener: AgentEventListener<"task">): () => void {
    this.emitter.on("task", listener);
    return () => this.emitter.off("task", listener);
  }

  onLog(listener: AgentEventListener<"log">): () => void {
    this.emitter.on("log", listener);
    return () => this.emitter.off("log", listener);
  }

  onPlan(listener: AgentEventListener<"plan">): () => void {
    this.emitter.on("plan", listener);
    return () => this.emitter.off("plan", listener);
  }

  onTool(listener: AgentEventListener<"tool">): () => void {
    this.emitter.on("tool", listener);
    return () => this.emitter.off("tool", listener);
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}
