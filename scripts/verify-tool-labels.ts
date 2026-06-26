import assert from "node:assert/strict";
import {
  getToolLabel,
  humanizeToolName,
} from "../packages/coding-agent/src/ui/shared/tool-utils.js";

// --- known tools: present-continuous while active, past tense when done ------
assert.equal(getToolLabel("run_command", "active"), "Running");
assert.equal(getToolLabel("run_command", "done"), "Ran");
assert.equal(getToolLabel("read_file", "active"), "Reading");
assert.equal(getToolLabel("read_file", "done"), "Read");
assert.equal(getToolLabel("edit_file", "active"), "Editing");
assert.equal(getToolLabel("edit_file", "done"), "Edited");
assert.equal(getToolLabel("delete_file", "done"), "Deleted");
assert.equal(getToolLabel("grep", "done"), "Searched");

// --- case-insensitive lookup -------------------------------------------------
assert.equal(getToolLabel("RUN_COMMAND", "done"), "Ran");

// --- unknown / MCP tools fall back to a humanized name -----------------------
assert.equal(getToolLabel("some_unknown_tool", "done"), "Some unknown tool");
assert.equal(getToolLabel("some_unknown_tool", "active"), "Some unknown tool");
assert.equal(humanizeToolName("mcp_fetch_url"), "Mcp fetch url");
assert.equal(humanizeToolName("camelCaseTool"), "Camel Case Tool");
assert.equal(humanizeToolName("Already Nice"), "Already Nice");

// --- never returns an empty label --------------------------------------------
assert.equal(humanizeToolName(""), "");
assert.ok(getToolLabel("x", "done").length > 0);

console.log("verify-tool-labels: all assertions passed");
