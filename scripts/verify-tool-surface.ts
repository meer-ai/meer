import assert from "node:assert/strict";
import { createMeerAgentTools } from "@meer-ai/coding-agent/agent/tools/agent.js";

const tools = createMeerAgentTools({ cwd: process.cwd() } as never);
const names = new Set(tools.map((t) => t.name));

// Consolidated surface: the two survivors remain...
assert.ok(names.has("edit_file"), "edit_file must remain");
assert.ok(names.has("propose_edit"), "propose_edit must remain");
// ...and the removed tools are gone.
assert.ok(!names.has("edit_line"), "edit_line must be removed");
assert.ok(!names.has("write_file"), "write_file must be removed (use propose_edit)");

for (const removed of [
  "explain_code", "generate_docstring", "generate_tests", "code_review",
  "generate_readme", "generate_test_suite", "generate_mocks", "generate_api_docs",
  "check_complexity", "detect_smells",
]) {
  assert.ok(!names.has(removed), `${removed} must be removed`);
}

for (const removed of [
  "rename_symbol", "extract_function", "extract_variable",
  "inline_variable", "move_symbol", "convert_to_async",
]) {
  assert.ok(!names.has(removed), `${removed} must be removed`);
}

console.log("tool surface verification passed");
