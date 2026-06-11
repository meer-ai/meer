import assert from "node:assert/strict";
import {
  classifyMarkdownLine,
  parseMarkdownBlocks,
  tokenizeInline,
} from "../src/ui/ink/markdown.js";

// ===========================================================================
// parseMarkdownBlocks
// ===========================================================================

// Plain text only
{
  const blocks = parseMarkdownBlocks("just text\nsecond line");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "text");
}

// Closed fence with language
{
  const blocks = parseMarkdownBlocks("before\n\n```ts\nconst a = 1;\n```\n\nafter");
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].type, "text");
  assert.equal(blocks[1].type, "code");
  assert.equal(blocks[1].language, "ts");
  assert.equal(blocks[1].content, "const a = 1;");
  assert.equal(blocks[1].closed, true);
  assert.equal(blocks[2].type, "text");
}

// UNCLOSED trailing fence renders as code (the mid-stream case)
{
  const blocks = parseMarkdownBlocks("text\n\n```python\nprint('hi')\nprint('still streaming");
  const code = blocks.find((b) => b.type === "code");
  assert.ok(code, "unclosed fence becomes a code block");
  assert.equal(code!.closed, false);
  assert.equal(code!.language, "python");
  assert.match(code!.content, /still streaming/);
}

// Blank line inside a fence does not close it
{
  const blocks = parseMarkdownBlocks("```\nline1\n\nline2\n```");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "code");
  assert.equal(blocks[0].content, "line1\n\nline2");
}

// ===========================================================================
// tokenizeInline
// ===========================================================================

// Bold / italic / code / strike / link
{
  const tokens = tokenizeInline("a **bold** and *ital* and `code` and ~~gone~~ end");
  assert.deepEqual(
    tokens.map((t) => [t.text, t.bold ?? false, t.italic ?? false, t.code ?? false, t.strike ?? false]),
    [
      ["a ", false, false, false, false],
      ["bold", true, false, false, false],
      [" and ", false, false, false, false],
      ["ital", false, true, false, false],
      [" and ", false, false, false, false],
      ["code", false, false, true, false],
      [" and ", false, false, false, false],
      ["gone", false, false, false, true],
      [" end", false, false, false, false],
    ]
  );
}

// Links: label + url captured
{
  const tokens = tokenizeInline("see [the docs](https://example.com) here");
  const link = tokens.find((t) => t.url);
  assert.ok(link);
  assert.equal(link!.text, "the docs");
  assert.equal(link!.url, "https://example.com");
}

// snake_case identifiers are never mangled (no underscore emphasis)
{
  const tokens = tokenizeInline("call run_command with file_path arg");
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].text, "call run_command with file_path arg");
}

// Inline code protects its contents from other formatting
{
  const tokens = tokenizeInline("use `**not bold**` here");
  const code = tokens.find((t) => t.code);
  assert.equal(code!.text, "**not bold**");
}

// No formatting at all → single plain token
{
  const tokens = tokenizeInline("plain sentence");
  assert.deepEqual(tokens, [{ text: "plain sentence" }]);
}

// ===========================================================================
// classifyMarkdownLine
// ===========================================================================

assert.deepEqual(classifyMarkdownLine(""), { kind: "blank" });
assert.deepEqual(classifyMarkdownLine("   "), { kind: "blank" });
assert.deepEqual(classifyMarkdownLine("# Title"), { kind: "heading", level: 1, text: "Title" });
assert.deepEqual(classifyMarkdownLine("### Sub"), { kind: "heading", level: 3, text: "Sub" });
assert.deepEqual(classifyMarkdownLine("---"), { kind: "hr" });
assert.deepEqual(classifyMarkdownLine("> quoted"), { kind: "quote", text: "quoted" });
assert.deepEqual(classifyMarkdownLine("- item"), {
  kind: "bullet",
  indent: "",
  marker: "•",
  text: "item",
});
// Nested list indentation is preserved
assert.deepEqual(classifyMarkdownLine("    - nested"), {
  kind: "bullet",
  indent: "    ",
  marker: "•",
  text: "nested",
});
assert.deepEqual(classifyMarkdownLine("2. second"), {
  kind: "ordered",
  indent: "",
  marker: "2.",
  text: "second",
});
assert.deepEqual(classifyMarkdownLine("plain words"), { kind: "plain", text: "plain words" });
// Indented plain text keeps its leading whitespace
assert.deepEqual(classifyMarkdownLine("    indented"), { kind: "plain", text: "    indented" });

console.log("markdown-render verification passed");
