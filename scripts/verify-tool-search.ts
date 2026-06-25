import assert from "node:assert/strict";
import type { MCPTool } from "@meer-ai/coding-agent/mcp/types.js";
import {
  MCP_SEARCH_THRESHOLD,
  shouldUseToolSearch,
  rankMcpTools,
  selectActiveMcpTools,
  buildToolSearchTool,
} from "@meer-ai/coding-agent/agent/tool-search.js";

const mk = (name: string, serverName: string, description: string): MCPTool => ({
  name,
  originalName: name,
  serverName,
  description,
  inputSchema: { type: "object", properties: { title: { type: "string" } } },
});

const catalog: MCPTool[] = [
  mk("github:create_pr", "github", "Create a GitHub pull request"),
  mk("github:list_prs", "github", "List open pull requests"),
  mk("weather:forecast", "weather", "Get the weather forecast"),
];

// threshold
assert.equal(MCP_SEARCH_THRESHOLD, 10, "threshold constant");
assert.equal(shouldUseToolSearch(10), false, "10 inlines");
assert.equal(shouldUseToolSearch(11), true, "11 engages search");

// ranking: the create-PR tool ranks first for this query
const ranked = rankMcpTools(catalog, "create github pull request", 5);
assert.equal(ranked[0]?.name, "github:create_pr", "best match first");
assert.ok(!ranked.some((t) => t.name === "weather:forecast"), "irrelevant tool excluded");

// maxResults cap
assert.equal(rankMcpTools(catalog, "pull request github", 1).length, 1, "respects maxResults");

// selector
const activated = new Set<string>();
assert.equal(selectActiveMcpTools(catalog, activated, false).length, 3, "no search → all");
assert.equal(selectActiveMcpTools(catalog, activated, true).length, 0, "search + none activated → none");

// the tool: activation + session-stickiness (mutates the shared set)
const tool = buildToolSearchTool(() => catalog, activated);
assert.equal(tool.name, "tool_search", "tool name");
const res = await tool.execute("tc-1", { query: "create github pull request", maxResults: 1 });
assert.ok(activated.has("github:create_pr"), "activates the matched tool (sticky in the set)");
assert.equal(activated.size, 1, "exactly one tool activated with maxResults:1");
assert.match(res.content, /github:create_pr/, "summary names the activated tool");
// now the selector surfaces it
assert.equal(
  selectActiveMcpTools(catalog, activated, true).map((t) => t.name).join(","),
  "github:create_pr",
  "activated tool becomes selectable",
);

// no-match path lists servers
const noMatch = await tool.execute("tc-2", { query: "zzzzzqqq" });
assert.match(noMatch.content, /No tools matched/i, "no-match message");
assert.match(noMatch.content, /github/, "no-match lists server names");

// server-drop: an activated name absent from the current catalog is dropped
const dropped = selectActiveMcpTools(
  [mk("weather:forecast", "weather", "Get the weather forecast")],
  new Set(["github:create_pr"]),
  true,
);
assert.equal(dropped.length, 0, "activated-but-absent tool drops from the active set");

console.log("tool-search verification passed");
