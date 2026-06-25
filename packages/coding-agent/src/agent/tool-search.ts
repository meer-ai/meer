import type { AgentTool } from "@meer-ai/agent/types.js";
import type { MCPTool } from "../mcp/types.js";

/** Above this many MCP tools, hold them behind tool_search instead of inlining. */
export const MCP_SEARCH_THRESHOLD = 10;

export function shouldUseToolSearch(mcpToolCount: number): boolean {
  return mcpToolCount > MCP_SEARCH_THRESHOLD;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Keyword-rank the catalog against a query. Score = number of distinct query
 * tokens that appear anywhere in the tool's name + description + serverName.
 * Keeps score>0, sorts by score desc then name asc, caps to maxResults.
 */
export function rankMcpTools(
  catalog: MCPTool[],
  query: string,
  maxResults: number,
): MCPTool[] {
  const queryTokens = Array.from(new Set(tokenize(query)));
  if (queryTokens.length === 0) return [];
  const scored = catalog
    .map((tool) => {
      const haystack = `${tool.name} ${tool.description ?? ""} ${tool.serverName}`.toLowerCase();
      const score = queryTokens.reduce(
        (acc, t) => (haystack.includes(t) ? acc + 1 : acc),
        0,
      );
      return { tool, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
  return scored.slice(0, Math.max(0, maxResults)).map((s) => s.tool);
}

/** The set of MCP tools to expose as real tools this build. */
export function selectActiveMcpTools(
  catalog: MCPTool[],
  activated: Set<string>,
  useSearch: boolean,
): MCPTool[] {
  if (!useSearch) return catalog;
  return catalog.filter((tool) => activated.has(tool.name));
}

function summarizeTool(tool: MCPTool): string {
  const params = Object.keys(
    (tool.inputSchema?.properties as Record<string, unknown> | undefined) ?? {},
  );
  const paramText = params.length ? ` — params: ${params.join(", ")}` : "";
  const desc = tool.description?.trim() ? tool.description.trim() : "(no description)";
  return `- ${tool.name}: ${desc}${paramText}`;
}

/**
 * The tool_search tool. Searches the live MCP catalog, marks matches as
 * activated (mutating the shared set so they persist for the session), and
 * returns a summary so the model can call them on the next turn.
 */
export function buildToolSearchTool(
  getCatalog: () => MCPTool[],
  activated: Set<string>,
): AgentTool {
  return {
    name: "tool_search",
    description:
      "Search the available MCP tool catalog by keyword and activate matching tools so you can call them. Use this when you need an integration capability (e.g. \"create github pull request\") that is not already one of your active tools. After activating, call the returned tool by its name on a following step.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords describing the capability you need." },
        maxResults: { type: "number", description: "Max tools to activate (default 5)." },
      },
      required: ["query"],
    },
    async execute(_toolCallId, input) {
      const query = typeof input.query === "string" ? input.query : "";
      const maxResults =
        typeof input.maxResults === "number" && input.maxResults > 0
          ? Math.floor(input.maxResults)
          : 5;
      const catalog = getCatalog();
      const matches = rankMcpTools(catalog, query, maxResults);

      if (matches.length === 0) {
        const servers = Array.from(new Set(catalog.map((t) => t.serverName))).sort();
        return {
          content:
            `No tools matched "${query}". ${catalog.length} MCP tools are available across servers: ${servers.join(", ")}. Try broader or different keywords.`,
        };
      }

      for (const tool of matches) activated.add(tool.name);
      const summary = matches.map(summarizeTool).join("\n");
      return {
        content:
          `Activated ${matches.length} tool(s) — you can now call them by name:\n${summary}`,
      };
    },
  };
}
