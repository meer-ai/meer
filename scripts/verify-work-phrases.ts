import assert from "node:assert/strict";
import {
  SEA_PHRASES,
  PHRASE_ROTATE_MS,
  phraseForElapsed,
  randomPhraseIndex,
} from "../packages/coding-agent/src/ui/tui-adapter/work-phrases.js";

// --- the pool is real and sane ----------------------------------------------
assert.ok(SEA_PHRASES.length >= 12, "expected a healthy pool of status words");
const seen = new Set<string>();
for (const phrase of SEA_PHRASES) {
  assert.ok(phrase.trim().length > 0, "no empty phrases");
  assert.ok(phrase.length <= 22, `phrase should fit the status line: "${phrase}"`);
  assert.ok(!/\s$/.test(phrase), `phrase should not have trailing whitespace: "${phrase}"`);
  assert.ok(!seen.has(phrase), `duplicate phrase: "${phrase}"`);
  seen.add(phrase);
}

// --- a word shows immediately (no initial delay, unlike tips) ---------------
assert.equal(phraseForElapsed(0, 0), SEA_PHRASES[0], "first word shows from t=0");

// --- rotation advances one step per ROTATE window ---------------------------
assert.equal(phraseForElapsed(PHRASE_ROTATE_MS - 1, 0), SEA_PHRASES[0], "same word before the first roll");
assert.equal(phraseForElapsed(PHRASE_ROTATE_MS, 0), SEA_PHRASES[1], "rolls to the next word after one window");
assert.equal(
  phraseForElapsed(5 * PHRASE_ROTATE_MS, 0),
  SEA_PHRASES[5 % SEA_PHRASES.length],
  "rotation count maps to index"
);

// --- baseIndex offsets the opening word and wraps ---------------------------
assert.equal(phraseForElapsed(0, 3), SEA_PHRASES[3], "baseIndex shifts the opening word");
assert.equal(phraseForElapsed(0, SEA_PHRASES.length), SEA_PHRASES[0], "baseIndex wraps");

// --- defensive inputs never throw or escape the range -----------------------
assert.equal(phraseForElapsed(-100, 0), SEA_PHRASES[0], "negative elapsed clamps to the first word");
assert.equal(phraseForElapsed(Number.NaN, 0), SEA_PHRASES[0]);
assert.equal(phraseForElapsed(0, -1), SEA_PHRASES[1 % SEA_PHRASES.length]);
assert.equal(phraseForElapsed(0, Number.NaN), SEA_PHRASES[0]);
assert.equal(phraseForElapsed(0, 0, []), "Working", "empty pool falls back to a safe word");

// --- randomPhraseIndex stays in range ---------------------------------------
assert.equal(randomPhraseIndex(SEA_PHRASES, () => 0), 0);
assert.equal(randomPhraseIndex(SEA_PHRASES, () => 0.999999), SEA_PHRASES.length - 1);
assert.equal(randomPhraseIndex([], () => 0.5), 0);

console.log("verify-work-phrases: all assertions passed");
