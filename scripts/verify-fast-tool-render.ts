/**
 * Lock the fast-vs-slow tool rendering decision.
 *
 * The heuristic: a tool result renders compact (single dim line) only when
 *   - the tool finished in under FAST_TOOL_DURATION_MS (1s)
 *   - it didn't fail (errors always get the full widget)
 *   - the body has at most FAST_TOOL_MAX_LINES non-blank lines (anything
 *     bigger is genuinely interesting and gets full real estate)
 *
 * If the agent loop didn't surface a duration in details, we err on the
 * side of showing the full widget — we'd rather over-render than hide a
 * result the user might care about.
 */

import { shouldRenderCompact } from "../src/ui/shared/tool-utils.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// --- Fast, small, success → compact ----------------------------------------
assert(
  shouldRenderCompact({ duration: 12, body: "module.exports = 42;\n" }),
  "12ms small body collapses"
);

// --- Fast, multi-line but still under threshold → compact -----------------
assert(
  shouldRenderCompact({
    duration: 800,
    body: "line1\nline2\nline3\nline4",
  }),
  "fast with 4 lines stays compact"
);

// --- Fast but body too big → full widget ----------------------------------
assert(
  !shouldRenderCompact({
    duration: 500,
    body: "a\nb\nc\nd\ne\nf",
  }),
  "fast but 6 lines forces full"
);

// --- Slow → full widget regardless of body size ---------------------------
assert(
  !shouldRenderCompact({ duration: 1500, body: "ok" }),
  "1.5s is slow"
);
assert(
  !shouldRenderCompact({ duration: 1001, body: "" }),
  "1001ms is slow (just over threshold)"
);

// --- Errors are never compact --------------------------------------------
assert(
  !shouldRenderCompact({ duration: 12, isError: true, body: "boom" }),
  "errors always full widget"
);

// --- No duration provided → full widget (conservative) -------------------
assert(
  !shouldRenderCompact({ duration: undefined, body: "tiny" }),
  "missing duration → full widget"
);

// --- Edge: exactly at the threshold → full widget ------------------------
assert(
  !shouldRenderCompact({ duration: 1000, body: "ok" }),
  "exactly 1s is treated as slow"
);

// --- Edge: blank-only body still counts as one line ----------------------
assert(
  shouldRenderCompact({ duration: 50, body: "   \n   \n" }),
  "blank lines don't count toward FAST_TOOL_MAX_LINES"
);

console.log("fast-tool render verification passed");
