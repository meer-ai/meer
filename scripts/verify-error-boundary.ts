/**
 * Verify the RenderErrorBoundary's logic without a full Ink render. We
 * exercise the class's static lifecycle directly — the same hooks React
 * itself uses when a child throws. Avoids pulling ink-testing-library
 * into the dev dependency surface for a single test.
 *
 * Coverage:
 *  - getDerivedStateFromError returns the error in state (this is what
 *    triggers the fallback render in real React).
 *  - componentDidCatch fires the onError prop, which we use to push to
 *    the diagnostics ring buffer.
 *  - componentDidUpdate clears the error when the label changes (so a
 *    different message id reuses the same slot cleanly).
 *  - The diagnostics ring buffer captures the entry with the right
 *    scope/message/context.
 */

import { RenderErrorBoundary } from "../src/ui/ink/components/shared/ErrorBoundary.js";
import {
  clearDiagnostics,
  getDiagnostics,
  recordDiagnostic,
} from "../src/utils/diagnostics.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// 1. getDerivedStateFromError populates state.
const derived = RenderErrorBoundary.getDerivedStateFromError(
  new Error("synthetic render failure")
);
assert(
  derived.error instanceof Error && derived.error.message === "synthetic render failure",
  "getDerivedStateFromError captures the error"
);

// 2. componentDidCatch invokes onError prop.
clearDiagnostics();
let captured: { error: Error; info: { componentStack?: string } } | null = null;
const props = {
  label: "tool run_command",
  onError: (error: Error, info: { componentStack?: string }) => {
    captured = { error, info };
    recordDiagnostic("ui.MessageView", error, {
      messageId: "abc",
      toolName: "run_command",
    });
  },
};
const instance = new RenderErrorBoundary(props);
instance.componentDidCatch(new Error("synthetic"), {
  componentStack: "  in BadChild\n  in RenderErrorBoundary\n",
});

assert(captured !== null, "onError invoked");
assert((captured as any)!.error.message === "synthetic", "error forwarded");
assert(
  (captured as any)!.info.componentStack?.includes("BadChild"),
  "component stack forwarded"
);

const entries = getDiagnostics();
assert(entries.length === 1, "diagnostics ring buffer captured one entry");
assert(entries[0].scope === "ui.MessageView", "diagnostic scope");
assert(entries[0].message === "synthetic", "diagnostic message");
assert(
  entries[0].context?.toolName === "run_command",
  "diagnostic context preserved"
);

// 3. componentDidUpdate resets the error when label changes.
// React would call this after a re-render with new props.
const stateful = new RenderErrorBoundary(props);
stateful.state = { error: new Error("old error") };
let updated = false;
stateful.setState = ((s: any) => {
  updated = s.error === null;
}) as any;
stateful.componentDidUpdate({ ...props, label: "different-label" });
assert(updated, "boundary resets state when label changes");

// 4. componentDidUpdate keeps the error when label is unchanged.
const stale = new RenderErrorBoundary(props);
stale.state = { error: new Error("still broken") };
let touched = false;
stale.setState = (() => {
  touched = true;
}) as any;
stale.componentDidUpdate(props); // same label
assert(!touched, "boundary leaves state alone when label is unchanged");

// 5. Ring buffer caps at MAX_ENTRIES (200).
clearDiagnostics();
for (let i = 0; i < 250; i++) {
  recordDiagnostic("flood", new Error(`err-${i}`));
}
const flooded = getDiagnostics();
assert(flooded.length === 200, "ring buffer caps at 200 entries");
assert(
  flooded[0].message === "err-50",
  "oldest entries dropped (kept the last 200)"
);
assert(flooded[199].message === "err-249", "newest entry retained");

clearDiagnostics();
console.log("error boundary verification passed");
