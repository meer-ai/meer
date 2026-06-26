import assert from "node:assert/strict";
import {
  computeContextUsage,
  formatContextRemaining,
} from "@meer-ai/coding-agent/agent/context-usage.js";

// --- computeContextUsage: exact (provider usage present) ---
const exact = computeContextUsage({
  lastPromptTokens: 47200,
  totalChars: 999999, // ignored when lastPromptTokens is present
  model: "claude-opus-4-7",
});
assert.equal(exact.usedTokens, 47200, "exact path uses provider promptTokens");
assert.equal(exact.totalTokens, 200000, "window resolved from model id");
assert.equal(exact.estimated, false, "exact path is not estimated");

// --- computeContextUsage: estimate (no provider usage yet) ---
const est = computeContextUsage({
  totalChars: 400000,
  model: "claude-opus-4-7",
});
assert.equal(est.usedTokens, 100000, "estimate is ceil(totalChars / 4)");
assert.equal(est.estimated, true, "estimate path flagged");
assert.equal(est.totalTokens, 200000, "window resolved on estimate path too");

// --- formatContextRemaining: real-usage (green) ---
const green = formatContextRemaining({
  usedTokens: 47200,
  totalTokens: 200000,
  estimated: false,
});
assert.match(green, /47,200/, "shows used with separators");
assert.match(green, /200,000/, "shows total with separators");
assert.match(green, /24%/, "computes percent");
assert.match(green, /green/, "green status");
assert.match(green, /Remaining: ~152,800 tokens/, "remaining line");
assert.doesNotMatch(green, /\(estimated\)/, "real usage not marked estimated");
assert.match(green, /Plenty of headroom\./, "green guidance");

// --- formatContextRemaining: estimate marker ---
const estimatedOut = formatContextRemaining({
  usedTokens: 100000,
  totalTokens: 200000,
  estimated: true,
});
assert.match(estimatedOut, /\(estimated\)/, "estimate marker present");
assert.match(estimatedOut, /estimate until the first model response/, "estimate note");

// --- formatContextRemaining: yellow threshold (>= 50) ---
const yellow = formatContextRemaining({
  usedTokens: 120000,
  totalTokens: 200000,
  estimated: false,
});
assert.match(yellow, /60%/, "yellow percent");
assert.match(yellow, /yellow/, "yellow status");
assert.match(yellow, /Getting full/, "yellow guidance");

// --- formatContextRemaining: red threshold (>= 80) ---
const red = formatContextRemaining({
  usedTokens: 180000,
  totalTokens: 200000,
  estimated: false,
});
assert.match(red, /90%/, "red percent");
assert.match(red, /red/, "red status");
assert.match(red, /wrap up/, "red guidance");

// --- formatContextRemaining: unavailable ---
const none = formatContextRemaining(null);
assert.equal(
  none,
  "Context usage is not available in this session.",
  "null usage yields graceful line"
);

console.log("✅ get_context_remaining compute + format verification passed");
