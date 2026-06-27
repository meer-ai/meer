import assert from "node:assert/strict";
import {
  WORK_TIPS,
  TIP_INITIAL_DELAY_MS,
  TIP_ROTATE_MS,
  tipForElapsed,
  randomTipIndex,
} from "../packages/coding-agent/src/ui/tui-adapter/work-tips.js";

// --- the list is real and sane ----------------------------------------------
assert.ok(WORK_TIPS.length >= 8, "expected a healthy pool of tips");
for (const tip of WORK_TIPS) {
  assert.ok(tip.trim().length > 0, "no empty tips");
  assert.ok(tip.length <= 80, `tip should stay short enough for one line: "${tip}"`);
  assert.ok(!/\s$/.test(tip), `tip should not have trailing whitespace: "${tip}"`);
}
// every tip references a real meer command or shortcut (cheap guard against drift)
for (const tip of WORK_TIPS) {
  assert.ok(/\/[a-z]|Ctrl|Shift|Esc|\?|scrollback/i.test(tip), `tip names no feature: "${tip}"`);
}

// --- hidden during the initial delay ----------------------------------------
assert.equal(tipForElapsed(0, 0), null, "no tip at turn start");
assert.equal(tipForElapsed(TIP_INITIAL_DELAY_MS - 1, 0), null, "no tip just before the delay");

// --- first tip appears exactly at the delay boundary ------------------------
assert.equal(tipForElapsed(TIP_INITIAL_DELAY_MS, 0), WORK_TIPS[0], "first tip shows at the boundary");
assert.equal(
  tipForElapsed(TIP_INITIAL_DELAY_MS + TIP_ROTATE_MS - 1, 0),
  WORK_TIPS[0],
  "still the first tip just before the first rotation"
);

// --- rotation advances one step per ROTATE window ---------------------------
assert.equal(
  tipForElapsed(TIP_INITIAL_DELAY_MS + TIP_ROTATE_MS, 0),
  WORK_TIPS[1],
  "rotates to the next tip after one window"
);
assert.equal(
  tipForElapsed(TIP_INITIAL_DELAY_MS + 5 * TIP_ROTATE_MS, 0),
  WORK_TIPS[5 % WORK_TIPS.length],
  "rotation count maps to index"
);

// --- baseIndex offsets which tip a turn opens on, and wraps ------------------
assert.equal(
  tipForElapsed(TIP_INITIAL_DELAY_MS, 3),
  WORK_TIPS[3],
  "baseIndex shifts the opening tip"
);
assert.equal(
  tipForElapsed(TIP_INITIAL_DELAY_MS, WORK_TIPS.length),
  WORK_TIPS[0],
  "baseIndex wraps around the list"
);
// defensive: bad baseIndex never throws or returns out of range
assert.equal(tipForElapsed(TIP_INITIAL_DELAY_MS, -1), WORK_TIPS[1 % WORK_TIPS.length]);
assert.equal(tipForElapsed(TIP_INITIAL_DELAY_MS, Number.NaN), WORK_TIPS[0]);

// --- empty pool is handled -------------------------------------------------
assert.equal(tipForElapsed(TIP_INITIAL_DELAY_MS, 0, []), null, "empty pool shows nothing");

// --- randomTipIndex stays in range -----------------------------------------
assert.equal(randomTipIndex(WORK_TIPS, () => 0), 0);
assert.equal(randomTipIndex(WORK_TIPS, () => 0.999999), WORK_TIPS.length - 1);
assert.equal(randomTipIndex([], () => 0.5), 0);

console.log("verify-work-tips: all assertions passed");
