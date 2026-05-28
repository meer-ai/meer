/**
 * Lock down the session token budget machinery.
 *
 *  - parseTokenBudget accepts plain integers, `k`, `M` suffixes (case
 *    insensitive), and fractional values like "1.5M".
 *  - SessionTracker's budget API rejects zero/undefined as "unlimited",
 *    correctly reports isOverBudget once usage crosses the cap, and
 *    reports remaining budget.
 */

import { parseTokenBudget } from "../src/chat/slash.js";
import { SessionTracker } from "../src/session/tracker.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// --- parseTokenBudget ----------------------------------------------------
assert(parseTokenBudget("100") === 100, "plain integer");
assert(parseTokenBudget("100000") === 100000, "larger plain integer");
assert(parseTokenBudget("100k") === 100_000, "lower-k suffix");
assert(parseTokenBudget("100K") === 100_000, "upper-k suffix");
assert(parseTokenBudget("1m") === 1_000_000, "lower-m suffix");
assert(parseTokenBudget("1.5M") === 1_500_000, "fractional M");
assert(parseTokenBudget(" 100k ") === 100_000, "whitespace tolerated");

// Malformed input → null (so callers can print usage).
assert(parseTokenBudget("") === null, "empty rejected");
assert(parseTokenBudget("abc") === null, "non-numeric rejected");
assert(parseTokenBudget("100x") === null, "unknown suffix rejected");
assert(parseTokenBudget("-5") === null, "negative rejected");
assert(parseTokenBudget("0") === null, "zero rejected (use /budget unset)");
assert(parseTokenBudget("100kb") === null, "extra letters rejected");

// --- SessionTracker budget API ------------------------------------------
{
  const tracker = new SessionTracker("test", "test-model");

  // No cap → never over budget.
  assert(tracker.getMaxTokens() === undefined, "no cap by default");
  assert(!tracker.isOverBudget(), "no cap → never over");
  assert(tracker.getRemainingBudget() === Number.POSITIVE_INFINITY, "no cap → infinite remaining");

  tracker.setMaxTokens(1000);
  assert(tracker.getMaxTokens() === 1000, "cap set");
  assert(!tracker.isOverBudget(), "0 usage < 1000 cap");
  assert(tracker.getRemainingBudget() === 1000, "1000 remaining");

  tracker.trackPromptTokens(500);
  assert(!tracker.isOverBudget(), "500 used, still under cap");
  assert(tracker.getRemainingBudget() === 500, "500 remaining");

  tracker.trackCompletionTokens(600);
  assert(tracker.isOverBudget(), "1100 total > 1000 cap");
  assert(tracker.getRemainingBudget() === 0, "0 remaining (clamped at 0)");

  // Removing the cap clears the over-budget state.
  tracker.setMaxTokens(undefined);
  assert(!tracker.isOverBudget(), "unset cap clears over-budget");
  assert(tracker.getRemainingBudget() === Number.POSITIVE_INFINITY, "unset → infinite again");

  // setMaxTokens(0) is treated as "unset".
  tracker.setMaxTokens(0);
  assert(tracker.getMaxTokens() === undefined, "zero treated as unset");
}

console.log("budget verification passed");
