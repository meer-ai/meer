import assert from "node:assert/strict";
import {
  applyTextEdits,
  detectLineEnding,
  normalizeForFuzzyMatch,
  normalizeToLF,
  stripBom,
} from "../src/tools/edit-engine.js";

// --- Basic exact replacement ---
{
  const result = applyTextEdits("const a = 1;\nconst b = 2;\n", [
    { oldText: "const b = 2;", newText: "const b = 3;" },
  ], "test.ts");
  assert.equal(result.newContent, "const a = 1;\nconst b = 3;\n");
  assert.equal(result.usedFuzzyMatch, false);
}

// --- CRLF file edited with LF oldText (the classic Windows failure) ---
{
  const crlfContent = "line one\r\nline two\r\nline three\r\n";
  const result = applyTextEdits(crlfContent, [
    { oldText: "line two", newText: "line 2" },
  ], "test.txt");
  assert.equal(result.newContent, "line one\r\nline 2\r\nline three\r\n");
}

// --- CRLF file with multi-line LF oldText ---
{
  const crlfContent = "alpha\r\nbeta\r\ngamma\r\n";
  const result = applyTextEdits(crlfContent, [
    { oldText: "alpha\nbeta", newText: "alpha\nBETA" },
  ], "test.txt");
  assert.equal(result.newContent, "alpha\r\nBETA\r\ngamma\r\n");
}

// --- BOM is stripped for matching and restored on output ---
{
  const bomContent = "﻿hello world\n";
  const result = applyTextEdits(bomContent, [
    { oldText: "hello world", newText: "hello meer" },
  ], "test.txt");
  assert.equal(result.newContent, "﻿hello meer\n");
}

// --- Fuzzy match: smart quotes in file, ASCII quotes in oldText ---
{
  const content = "console.log(‘hello’);\n";
  const result = applyTextEdits(content, [
    { oldText: "console.log('hello');", newText: "console.log('bye');" },
  ], "test.ts");
  assert.equal(result.usedFuzzyMatch, true);
  assert.match(result.newContent, /bye/);
}

// --- Fuzzy match: trailing whitespace differences ---
{
  const content = "function foo() {   \n  return 1;\n}\n";
  const result = applyTextEdits(content, [
    { oldText: "function foo() {\n  return 1;\n}", newText: "function foo() {\n  return 2;\n}" },
  ], "test.ts");
  assert.equal(result.usedFuzzyMatch, true);
  assert.match(result.newContent, /return 2/);
}

// --- Multiple edits applied against the original content ---
{
  const content = "one\ntwo\nthree\nfour\n";
  const result = applyTextEdits(content, [
    { oldText: "two", newText: "2" },
    { oldText: "four", newText: "4" },
  ], "test.txt");
  assert.equal(result.newContent, "one\n2\nthree\n4\n");
}

// --- Non-unique oldText rejected with helpful error ---
{
  assert.throws(
    () => applyTextEdits("dup\ndup\n", [{ oldText: "dup", newText: "x" }], "test.txt"),
    /2 occurrences/
  );
}

// --- Missing oldText rejected ---
{
  assert.throws(
    () => applyTextEdits("abc\n", [{ oldText: "zzz", newText: "x" }], "test.txt"),
    /Could not find/
  );
}

// --- Empty oldText rejected ---
{
  assert.throws(
    () => applyTextEdits("abc\n", [{ oldText: "", newText: "x" }], "test.txt"),
    /must not be empty/
  );
}

// --- Overlapping edits rejected ---
{
  assert.throws(
    () =>
      applyTextEdits("abcdef\n", [
        { oldText: "abcd", newText: "x" },
        { oldText: "cdef", newText: "y" },
      ], "test.txt"),
    /overlap/
  );
}

// --- No-op replacement rejected ---
{
  assert.throws(
    () => applyTextEdits("abc\n", [{ oldText: "abc", newText: "abc" }], "test.txt"),
    /identical content/
  );
}

// --- Helpers ---
assert.equal(detectLineEnding("a\r\nb"), "\r\n");
assert.equal(detectLineEnding("a\nb"), "\n");
assert.equal(detectLineEnding("no newlines"), "\n");
assert.equal(normalizeToLF("a\r\nb\rc"), "a\nb\nc");
assert.deepEqual(stripBom("﻿x"), { bom: "﻿", text: "x" });
assert.deepEqual(stripBom("x"), { bom: "", text: "x" });
assert.equal(normalizeForFuzzyMatch("a – b"), "a - b");
assert.equal(normalizeForFuzzyMatch("line   \nnext"), "line\nnext");

console.log("✅ Edit engine handles CRLF, BOM, fuzzy matching, and multi-edit correctly.");
