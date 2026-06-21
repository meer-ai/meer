/**
 * Lock down the model→context-window lookup and the fill-percent math.
 *
 * The footer's `ctx 38%` indicator hangs on this; if the lookup silently
 * falls back to 128k for a model the user actually has 200k for, the
 * number is misleading. The lookup walks exact matches first, then
 * pattern fallbacks, then a hard default.
 */

import {
  contextFillColor,
  contextFillPercent,
  formatTokenCount,
  getContextWindow,
} from "@meer-ai/coding-agent/utils/model-context.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// --- Exact matches --------------------------------------------------------
assert(getContextWindow("claude-opus-4-7").tokens === 200_000, "opus-4-7 exact");
assert(getContextWindow("claude-sonnet-4-6").tokens === 200_000, "sonnet exact");
assert(getContextWindow("gpt-4o").tokens === 128_000, "gpt-4o exact");
assert(getContextWindow("gemini-1.5-pro").tokens === 2_000_000, "gemini 1.5 pro");

// --- Pattern fallbacks ---------------------------------------------------
assert(
  getContextWindow("claude-opus-4-future").tokens === 200_000,
  "claude opus pattern catches future variants"
);
assert(
  getContextWindow("gpt-4o-2026-01-01").tokens === 128_000,
  "dated gpt-4o variant via pattern"
);
assert(
  getContextWindow("gemini-3-flash").tokens === 1_000_000,
  "gemini family pattern"
);

// --- Provider prefix tolerated -------------------------------------------
assert(
  getContextWindow("anthropic/claude-opus-4-7").tokens === 200_000,
  "anthropic/ prefix stripped"
);
assert(
  getContextWindow("openrouter/anthropic/claude-sonnet-4-6").tokens === 200_000,
  "double-prefix stripped"
);

// --- Unknown model → default (not zero) ----------------------------------
assert(
  getContextWindow("totally-made-up-model-xyz").tokens === 128_000,
  "unknown model defaults sensibly"
);
assert(getContextWindow(undefined).tokens === 128_000, "undefined defaults");
assert(getContextWindow("").tokens === 128_000, "empty defaults");

// --- Fill-percent clamps -------------------------------------------------
assert(contextFillPercent(0, "gpt-4o") === 0, "zero used → 0%");
assert(contextFillPercent(64_000, "gpt-4o") === 50, "half-full → 50%");
assert(contextFillPercent(128_000, "gpt-4o") === 100, "exactly full → 100%");
assert(
  contextFillPercent(200_000, "gpt-4o") === 100,
  "over-full clamps to 100 (cache-hit inflation)"
);

// --- Color thresholds ----------------------------------------------------
assert(contextFillColor(0) === "green", "0% green");
assert(contextFillColor(49) === "green", "49% green");
assert(contextFillColor(50) === "yellow", "50% yellow");
assert(contextFillColor(79) === "yellow", "79% yellow");
assert(contextFillColor(80) === "red", "80% red");
assert(contextFillColor(100) === "red", "100% red");

// --- Token formatting ----------------------------------------------------
assert(formatTokenCount(500) === "500", "small count");
// toFixed(0) rounds; 2500 → 3k. That's fine — the indicator just
// needs a "roughly how full" feel, not exact accounting.
assert(formatTokenCount(2_500) === "3k", "thousands rounded");
assert(formatTokenCount(76_000) === "76k", "tens of thousands");
assert(formatTokenCount(200_000) === "200k", "hundreds of thousands");
assert(formatTokenCount(1_500_000) === "1.5M", "millions");

console.log("context window verification passed");
