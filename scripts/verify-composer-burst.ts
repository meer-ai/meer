/**
 * Regression test for the held-down-Backspace bug.
 *
 * Bug: WrappedComposerInput's useInput callback captured `value` and
 * `cursorOffset` from the render closure. When stdin delivered multiple
 * keystrokes before React committed the parent's setInput, each callback
 * re-read the same stale string and collapsed several deletions into one.
 *
 * Fix: the handler now coordinates through refs so consecutive events in the
 * same tick see the result of the previous handler.
 *
 * This script simulates that exact race: many backspace handlers fire
 * back-to-back without any "commit" of the controlled prop in between. We
 * verify that the ref-coordinated handler still produces the correct final
 * value and cursor.
 */

import {
  clampCursorOffset,
  deleteBeforeCursor,
  insertAtCursor,
} from "../src/ui/ink/components/input/wrapInput.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Stale-closure handler (mirrors the pre-fix behaviour)
// ---------------------------------------------------------------------------

function runWithStaleClosure(initial: string, presses: number): { value: string; cursor: number } {
  // The render closure captures these once, at render time. Between renders
  // they don't change, no matter how many keypress events fire. The parent's
  // setState calls (modelled as `lastCommitted`) only "land" when React
  // re-renders — which doesn't happen until after the burst.
  const closureValue = initial;
  const closureCursor = initial.length;
  let lastCommitted = { value: initial, cursor: initial.length };

  for (let i = 0; i < presses; i++) {
    const next = deleteBeforeCursor(closureValue, closureCursor);
    lastCommitted = { value: next.value, cursor: next.cursorOffset };
  }

  return lastCommitted;
}

// ---------------------------------------------------------------------------
// Ref-coordinated handler (mirrors the fix)
// ---------------------------------------------------------------------------

function runWithRefs(initial: string, presses: number): { value: string; cursor: number } {
  const valueRef = { current: initial };
  const cursorRef = { current: initial.length };

  for (let i = 0; i < presses; i++) {
    // Each handler reads from refs, which are updated synchronously by the
    // previous handler in the same tick.
    const current = valueRef.current;
    const cursor = cursorRef.current;
    const next = deleteBeforeCursor(current, cursor);
    valueRef.current = next.value;
    cursorRef.current = next.cursorOffset;
  }

  return { value: valueRef.current, cursor: cursorRef.current };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

{
  // Held-down Backspace on "hello": should delete every character.
  const stale = runWithStaleClosure("hello", 5);
  assert(
    stale.value === "hell" && stale.cursor === 4,
    `stale closure should drop all but one deletion (got "${stale.value}" / ${stale.cursor})`
  );

  const refs = runWithRefs("hello", 5);
  assert(
    refs.value === "" && refs.cursor === 0,
    `ref-coordinated handler should delete all 5 chars (got "${refs.value}" / ${refs.cursor})`
  );
}

{
  // Two presses on a longer string.
  const refs = runWithRefs("abcdef", 2);
  assert(refs.value === "abcd" && refs.cursor === 4, "two backspaces remove two chars");
}

{
  // Backspace beyond the start is a no-op.
  const refs = runWithRefs("ab", 5);
  assert(refs.value === "" && refs.cursor === 0, "deleting past start clamps to empty");
}

{
  // Interleaved insert + delete using the same ref pattern.
  const valueRef = { current: "abc" };
  const cursorRef = { current: 3 };

  const insert1 = insertAtCursor(valueRef.current, cursorRef.current, "X");
  valueRef.current = insert1.value;
  cursorRef.current = insert1.cursorOffset;

  const del1 = deleteBeforeCursor(valueRef.current, cursorRef.current);
  valueRef.current = del1.value;
  cursorRef.current = del1.cursorOffset;

  const insert2 = insertAtCursor(valueRef.current, cursorRef.current, "Y");
  valueRef.current = insert2.value;
  cursorRef.current = insert2.cursorOffset;

  assert(
    valueRef.current === "abcY" && cursorRef.current === 4,
    `interleaved ops via refs (got "${valueRef.current}" / ${cursorRef.current})`
  );
}

{
  // Cursor clamping when the prop changes externally (e.g. parent clears).
  const cursor = clampCursorOffset("hi", 10);
  assert(cursor === 2, "clamp cursor when prop shortens");
}

console.log("composer burst verification passed");
