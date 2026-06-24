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

console.log("tool surface verification passed");
