import {
  buildWrappedInputView,
  deleteBeforeCursor,
  insertAtCursor,
  normalizePastedInput,
} from "../src/ui/ink/components/input/wrapInput.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const pasted = normalizePastedInput("\x1b[200~first\r\nsecond\rthird\x1b[201~");
assert(pasted === "first\nsecond\nthird", "normalizes CRLF and CR paste text");

const inserted = insertAtCursor("hello world", 5, "\nwide pasted text");
assert(
  inserted.value === "hello\nwide pasted text world",
  "inserts multiline paste at cursor"
);
assert(inserted.cursorOffset === "hello\nwide pasted text".length, "moves cursor after paste");

const wrapped = buildWrappedInputView("abcdef\nghijkl", 12, 3, 10);
assert(wrapped.totalLines === 4, "wraps logical lines by width");
assert(wrapped.lines.map((line) => line.text).join("|") === "abc|def|ghi|jkl", "keeps wrapped order");

const longInput = "one\ntwo\nthree\nfour\nfive";
const long = buildWrappedInputView(longInput, longInput.length, 80, 3);
assert(long.hiddenAbove === 2, "keeps cursor line visible when viewporting");
assert(long.lines.map((line) => line.text).join("|") === "three|four|five", "shows latest visible input lines");

const deleted = deleteBeforeCursor("abc", 2);
assert(deleted.value === "ac", "deletes before cursor");
assert(deleted.cursorOffset === 1, "moves cursor after delete");

console.log("composer wrap verification passed");
