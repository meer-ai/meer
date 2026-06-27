import assert from "node:assert/strict";
import {
  formatCompact,
  formatWorkElapsed,
  formatWorkMeta,
} from "../packages/coding-agent/src/ui/tui-adapter/status-format.js";

// --- formatCompact ----------------------------------------------------------
assert.equal(formatCompact(0), "0");
assert.equal(formatCompact(950), "950");
assert.equal(formatCompact(3600), "3.6k");
assert.equal(formatCompact(12_000), "12.0k");
assert.equal(formatCompact(2_000_000), "2.0M");
assert.equal(formatCompact(-5), "0", "negatives clamp to 0");
assert.equal(formatCompact(Number.NaN), "0");

// --- formatWorkElapsed ------------------------------------------------------
assert.equal(formatWorkElapsed(0), "0s");
assert.equal(formatWorkElapsed(900), "0s", "sub-second rounds down");
assert.equal(formatWorkElapsed(8_000), "8s");
assert.equal(formatWorkElapsed(73_000), "1m 13s");
assert.equal(formatWorkElapsed(3_600_000), "1h 0m");
assert.equal(formatWorkElapsed(3_725_000), "1h 2m");
assert.equal(formatWorkElapsed(-100), "0s", "negative clamps");

// --- formatWorkMeta ---------------------------------------------------------
assert.equal(formatWorkMeta({ elapsedMs: 73_000 }), "1m 13s", "no tokens → just elapsed");
assert.equal(
  formatWorkMeta({ elapsedMs: 73_000, usedTokens: 3600 }),
  "1m 13s · 3.6k tok",
  "billed usage reads as tok"
);
assert.equal(
  formatWorkMeta({ elapsedMs: 8_000, usedTokens: 12_000, estimated: true }),
  "8s · ~12.0k ctx",
  "estimated usage reads as ~ctx"
);
assert.equal(
  formatWorkMeta({ elapsedMs: 8_000, usedTokens: 0 }),
  "8s",
  "zero tokens are omitted"
);

console.log("verify-status-format: all assertions passed");
