import { EventEmitter } from "events";
import type { Plan } from "./types.js";

const PLAN_UPDATED_EVENT = "plan:updated";

type PlanListener = (plan: Plan | null) => void;

const clonePlan = (plan: Plan): Plan => ({
  ...plan,
  tasks: plan.tasks.map((task) => ({ ...task })),
});

export class PlanStore {
  private plan: Plan | null = null;
  private readonly emitter = new EventEmitter();

  getSnapshot(): Plan | null {
    return this.plan ? clonePlan(this.plan) : null;
  }

  setPlan(plan: Plan | null): Plan | null {
    this.plan = plan ? clonePlan(plan) : null;
    this.emit();
    return this.getSnapshot();
  }

  update(mutator: (plan: Plan) => void): Plan | null {
    if (!this.plan) {
      return null;
    }
    mutator(this.plan);
    this.plan.updatedAt = Date.now();
    this.emit();
    return this.getSnapshot();
  }

  clear(): void {
    if (!this.plan) {
      return;
    }
    this.plan = null;
    this.emit();
  }

  subscribe(listener: PlanListener): () => void {
    this.emitter.on(PLAN_UPDATED_EVENT, listener);
    return () => {
      this.emitter.off(PLAN_UPDATED_EVENT, listener);
    };
  }

  private emit(): void {
    this.emitter.emit(PLAN_UPDATED_EVENT, this.getSnapshot());
  }
}

export const planStore = new PlanStore();
export { PLAN_UPDATED_EVENT };
export type { Plan } from "./types.js";

