import assert from "node:assert/strict";
import { computeContextMeter } from "../packages/coding-agent/src/ui/shared/context-meter.js";

// --- nothing to show → null --------------------------------------------------
assert.equal(computeContextMeter(0, 200_000), null, "no usage → no gauge");
assert.equal(computeContextMeter(1000, 0), null, "no limit → no gauge");
assert.equal(computeContextMeter(Number.NaN, 200_000), null);
assert.equal(computeContextMeter(1000, 200_000, 0), null, "no cells → no gauge");

// --- percent + fill ----------------------------------------------------------
const low = computeContextMeter(20_000, 200_000, 8);
assert.ok(low);
assert.equal(low!.percent, 10);
assert.equal(low!.total, 8);
assert.equal(low!.filled, 1, "10% of 8 cells ≈ 1");
assert.equal(low!.color, "green");

const mid = computeContextMeter(120_000, 200_000, 8);
assert.equal(mid!.percent, 60);
assert.equal(mid!.color, "yellow", ">=50% is yellow");
assert.equal(mid!.filled, 5);

const high = computeContextMeter(180_000, 200_000, 8);
assert.equal(high!.percent, 90);
assert.equal(high!.color, "red", ">=80% is red");

// --- clamping ----------------------------------------------------------------
const over = computeContextMeter(500_000, 200_000, 8);
assert.equal(over!.percent, 100, "percent clamps to 100");
assert.equal(over!.filled, 8, "fill clamps to total cells");

console.log("verify-context-meter: all assertions passed");
