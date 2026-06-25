# tool_search (MCP tool discovery) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep large MCP tool catalogs out of the per-turn provider payload by adding a `tool_search` tool that keyword-searches the MCP catalog and promotes matched tools to first-class provider tools (Codex-style live tool-set expansion), session-sticky, gated behind a `>10` MCP-tool threshold.

**Architecture:** Three pieces. (1) `@meer-ai/agent`'s `runLoop` learns to accept a tools *resolver* (`() => AgentTool[]`) and re-derives its tool defs/map each turn, so a tool activated mid-interaction becomes callable. (2) A new pure, exported `tool-search.ts` module holds the threshold constant, the keyword ranker, the active-set selector, and the `tool_search` tool factory — all unit-testable without a `MeerAgent`. (3) `MeerAgent` gains a session-persistent activated-set, applies the threshold in `buildAgentTools()`, and passes `() => this.buildAgentTools()` to `runLoop`.

**Tech Stack:** TypeScript (ESM, NodeNext), Zod (native tools), pnpm workspaces. Tests are standalone `scripts/verify-*.ts` run with `tsx`; `pnpm run check` runs `tsc --noEmit`.

Design reference: `docs/superpowers/specs/2026-06-25-tool-search-design.md`.

## Global Constraints

- Language: TypeScript, ESM only. Intra-package imports use `.js` extensions (NodeNext).
- Run a single test: `pnpm exec tsx scripts/<name>.ts`. Typecheck: `pnpm run check`.
- **`pnpm test` (full-suite runner) is broken on Windows** (`spawn node_modules/.bin/tsx ENOENT`) — pre-existing, not in scope. Verify via individual `pnpm exec tsx <script>` + `pnpm run check`. (On Linux/WSL the full runner works.)
- Threshold is the module constant `MCP_SEARCH_THRESHOLD = 10`. Search engages only when `mcpTools.length > 10`; at `≤10` all MCP tools inline exactly as today and `tool_search` is NOT registered.
- The 21 native tools + `load_skill` are ALWAYS active and MUST NOT be moved behind search. Do not touch the tool-consolidation work.
- `runLoop`'s change MUST be backward-compatible: existing `AgentTool[]` callers keep working unchanged (the array is wrapped as `() => array`).
- Matching is keyword/token scoring over each MCP tool's `name` + `description` + `serverName`, case-insensitive. No embeddings.
- Activation is session-sticky: once `tool_search` activates a tool, it stays active for the life of the `MeerAgent` instance.
- Locate edits by **anchor text**, not line number.

---

## File Structure

- `packages/agent/src/loop.ts` — **modify**. `runLoop` accepts `AgentTool[] | (() => AgentTool[])`; re-derive `toolDefs`/`toolMap` per turn.
- `packages/coding-agent/src/agent/tool-search.ts` — **create**. Pure, exported: `MCP_SEARCH_THRESHOLD`, `shouldUseToolSearch`, `rankMcpTools`, `selectActiveMcpTools`, `buildToolSearchTool`.
- `packages/coding-agent/src/agent/meer-agent.ts` — **modify**. Add `activatedMcpToolNames`; apply threshold + selector + `tool_search` in `buildAgentTools()`; pass the resolver to `runLoop`.
- `packages/coding-agent/src/agent/prompts/nativeSystemPrompt.ts` — **modify**. One-line `tool_search` guidance.
- `scripts/verify-loop-dynamic-tools.ts` — **create**. Proves `runLoop` re-reads the resolver each turn + array backward-compat.
- `scripts/verify-tool-search.ts` — **create**. Unit tests for the `tool-search.ts` module.

---

## Task 1: `runLoop` accepts a dynamic tools resolver

**Files:**
- Modify: `packages/agent/src/loop.ts` (`runLoop` signature + per-turn tool derivation)
- Test: `scripts/verify-loop-dynamic-tools.ts` (create)

**Interfaces:**
- Consumes: existing `AgentTool` (`packages/agent/src/types.ts` — `{ name, description, inputSchema, execute() }`), existing `buildToolDefinitions(tools: AgentTool[])`.
- Produces: `runLoop(initialMessages, tools: AgentTool[] | (() => AgentTool[]), provider, config, emit, signal?)`. When `tools` is a function it is called once per turn to get the active tool list for that turn; array callers are unchanged.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-loop-dynamic-tools.ts`:

```ts
import assert from "node:assert/strict";
import { runLoop } from "@meer-ai/agent/loop.js";
import type { AgentTool } from "@meer-ai/agent/types.js";
import type { ChatMessage, Provider, ProviderEvent } from "@meer-ai/ai/base.js";

// Turn 1 → call tool_a; turn 2 → call tool_b; turn 3 → finish.
class TwoStepProvider implements Provider {
  calls = 0;
  async chat(_m: ChatMessage[]): Promise<string> { return "unused"; }
  async *stream(_m: ChatMessage[]): AsyncIterable<string> { yield "unused"; }
  async *streamWithTools(): AsyncIterable<ProviderEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      const id = "a";
      yield { type: "tool-call", toolCall: { id, name: "tool_a", input: {} } };
      yield { type: "done", rawText: "", turn: { assistantMessage: "", rawText: "", toolCalls: [{ id, name: "tool_a", input: {} }] } };
      return;
    }
    if (this.calls === 2) {
      const id = "b";
      yield { type: "tool-call", toolCall: { id, name: "tool_b", input: {} } };
      yield { type: "done", rawText: "", turn: { assistantMessage: "", rawText: "", toolCalls: [{ id, name: "tool_b", input: {} }] } };
      return;
    }
    yield { type: "text-delta", text: "done" };
    yield { type: "done", rawText: "done" };
  }
}

let aRan = false;
const toolA: AgentTool = {
  name: "tool_a", description: "a",
  inputSchema: { type: "object", properties: {} },
  async execute() { aRan = true; return { content: "a-ran" }; },
};
const toolB: AgentTool = {
  name: "tool_b", description: "b",
  inputSchema: { type: "object", properties: {} },
  async execute() { return { content: "b-ran" }; },
};

// tool_b only becomes available AFTER tool_a has run — proves the loop
// re-reads the resolver between turns.
const resolver = () => (aRan ? [toolA, toolB] : [toolA]);

const provider = new TwoStepProvider();
const messages = await runLoop(
  [{ role: "user", content: "go" }],
  resolver,
  provider,
  { systemPrompt: "test", maxTurns: 5 },
  async () => {},
);
const contents = messages
  .filter((m) => m.role === "tool_result")
  .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
assert.ok(contents.some((c) => c.includes("a-ran")), "tool_a runs on turn 1");
assert.ok(contents.some((c) => c.includes("b-ran")), "tool_b callable on turn 2 (resolver re-read)");

// Backward-compat: the array form still executes tools.
const arrProvider = new TwoStepProvider();
const arrMessages = await runLoop(
  [{ role: "user", content: "go" }],
  [toolA, toolB],
  arrProvider,
  { systemPrompt: "test", maxTurns: 5 },
  async () => {},
);
assert.ok(
  arrMessages.filter((m) => m.role === "tool_result").length >= 1,
  "array form still executes tools",
);

console.log("loop dynamic tools verification passed");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx scripts/verify-loop-dynamic-tools.ts`
Expected: FAIL — passing a function where `AgentTool[]` is expected makes `buildToolDefinitions(tools)` call `tools.map(...)` on a function → `TypeError: tools.map is not a function` (or `tool_b` is not callable). Either way it throws before printing the success line.

- [ ] **Step 3: Change the signature and resolve tools**

In `packages/agent/src/loop.ts`, change the `runLoop` signature parameter from:

```ts
  tools: AgentTool[],
```
to:
```ts
  tools: AgentTool[] | (() => AgentTool[]),
```

Immediately after the `messages` array is built (anchor: the line `const toolDefs = buildToolDefinitions(tools);`), REPLACE these two lines:

```ts
  const toolDefs = buildToolDefinitions(tools);
  const toolMap = new Map(tools.map((t) => [t.name, t]));
```
with a resolver (no per-turn defs yet — those move into the loop):

```ts
  const resolveTools = typeof tools === "function" ? tools : () => tools;
```

- [ ] **Step 4: Re-derive tools each turn**

Inside the inner `while ((hasMoreToolCalls || pendingMessages.length > 0) && canStartAnotherTurn())` loop, right after `turns++;` and `await emit({ type: "turn_start" });` (anchor: `await emit({ type: "turn_start" });`), insert:

```ts
        const activeTools = resolveTools();
        const toolDefs = buildToolDefinitions(activeTools);
        const toolMap = new Map(activeTools.map((t) => [t.name, t]));
```

These `const` bindings are scoped to the loop body, so the provider call (`streamWithTools(llmMessages, toolDefs, signal)`) and the later tool dispatch (`toolMap.get(...)`) both use the current turn's snapshot. Removing the outer `toolDefs`/`toolMap` (Step 3) means no stale outer binding remains; if `tsc` reports either name as undefined anywhere outside the loop, that reference must move inside the loop too.

- [ ] **Step 5: Run typecheck + test (GREEN)**

Run: `pnpm run check`
Expected: PASS (proves no other `runLoop` caller broke — the union keeps array callers valid).

Run: `pnpm exec tsx scripts/verify-loop-dynamic-tools.ts`
Expected: PASS — prints `loop dynamic tools verification passed`.

Run: `pnpm exec tsx scripts/verify-agent-loop-limits.ts`
Expected: PASS (existing loop test still green — array form unchanged).

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/loop.ts scripts/verify-loop-dynamic-tools.ts
git commit -m "feat(agent): runLoop accepts a per-turn tools resolver"
```

---

## Task 2: `tool-search.ts` pure module (threshold, ranker, selector, tool factory)

**Files:**
- Create: `packages/coding-agent/src/agent/tool-search.ts`
- Test: `scripts/verify-tool-search.ts` (create)

**Interfaces:**
- Consumes: `MCPTool` (`packages/coding-agent/src/mcp/types.ts` — `{ name, originalName, serverName, description, inputSchema }`); `AgentTool` (`@meer-ai/agent/types.js`).
- Produces:
  - `MCP_SEARCH_THRESHOLD: number` (= 10).
  - `shouldUseToolSearch(mcpToolCount: number): boolean` — `count > MCP_SEARCH_THRESHOLD`.
  - `rankMcpTools(catalog: MCPTool[], query: string, maxResults: number): MCPTool[]` — keyword-scored, score>0, sorted score desc then name asc, capped to `maxResults`.
  - `selectActiveMcpTools(catalog: MCPTool[], activated: Set<string>, useSearch: boolean): MCPTool[]` — `useSearch ? catalog.filter(t => activated.has(t.name)) : catalog`.
  - `buildToolSearchTool(getCatalog: () => MCPTool[], activated: Set<string>): AgentTool` — the `tool_search` tool; its `execute` ranks, mutates `activated`, returns a summary (or a no-match message).

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-tool-search.ts`:

```ts
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
const res = await tool.execute("tc-1", { query: "create github pull request" });
assert.ok(activated.has("github:create_pr"), "activates the matched tool (sticky in the set)");
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx scripts/verify-tool-search.ts`
Expected: FAIL — module `tool-search.js` does not exist (import error).

- [ ] **Step 3: Create the module**

Create `packages/coding-agent/src/agent/tool-search.ts`:

```ts
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
```

- [ ] **Step 4: Run test (GREEN)**

Run: `pnpm exec tsx scripts/verify-tool-search.ts`
Expected: PASS — prints `tool-search verification passed`.

Run: `pnpm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/agent/tool-search.ts scripts/verify-tool-search.ts
git commit -m "feat(tools): tool-search module (threshold, ranker, selector, tool factory)"
```

---

## Task 3: Wire `tool_search` into `MeerAgent` + prompt guidance

**Files:**
- Modify: `packages/coding-agent/src/agent/meer-agent.ts` (activated set field; threshold + selector + tool in `buildAgentTools()`; resolver to `runLoop`)
- Modify: `packages/coding-agent/src/agent/prompts/nativeSystemPrompt.ts` (one-line guidance)

**Interfaces:**
- Consumes: `shouldUseToolSearch`, `selectActiveMcpTools`, `buildToolSearchTool` from `./tool-search.js`; existing `createMeerAgentTools`, `runLoop`, `this.mcpTools: MCPTool[]`, `buildAgentTools(): AgentTool[]`.
- Produces: `buildAgentTools()` returns native + skills + (`tool_search` if `>threshold`) + active MCP tools; `runLoop` is driven by `() => this.buildAgentTools()`.

This task is integration glue; its gate is `pnpm run check` plus the Task 1 and Task 2 verify scripts (which cover the behavior) staying green. No new standalone test — `buildAgentTools` is a private method whose units are already tested in `tool-search.ts`, and the dynamic-resolver behavior is proven by `verify-loop-dynamic-tools.ts`.

- [ ] **Step 1: Add the activated-set field + import**

In `packages/coding-agent/src/agent/meer-agent.ts`, add the import near the other `./agent/...` imports (anchor: `import { createMeerAgentTools } from "./tools/agent.js";`):

```ts
import {
  shouldUseToolSearch,
  selectActiveMcpTools,
  buildToolSearchTool,
} from "./tool-search.js";
```

Add the field next to the existing `private mcpTools: MCPTool[] = [];` (anchor: `private mcpTools: MCPTool[] = [];`):

```ts
  /** MCP tools the model has activated via tool_search; sticky for the session. */
  private activatedMcpToolNames = new Set<string>();
```

- [ ] **Step 2: Apply the threshold + selector + tool in `buildAgentTools()`**

In `buildAgentTools()`, the MCP tools are currently passed wholesale via `{ mcpTools: this.mcpTools }` (anchor: `{ mcpTools: this.mcpTools }`). Replace the body so it computes the active subset and conditionally adds `tool_search`.

Find (anchor — the `createMeerAgentTools(... , { mcpTools: this.mcpTools })` call assigned to `legacyTools`) and change the options argument from:

```ts
      { mcpTools: this.mcpTools }
```
to:
```ts
      { mcpTools: selectActiveMcpTools(this.mcpTools, this.activatedMcpToolNames, shouldUseToolSearch(this.mcpTools.length)) }
```

Then change the `return [ ...skillTools, ...legacyTools.map(...) ]` to insert `tool_search` between skills and the legacy/MCP tools. At the `return [` (anchor: `return [\n      ...skillTools,`), insert a search-tools spread:

```ts
    const useSearch = shouldUseToolSearch(this.mcpTools.length);
    const searchTools = useSearch
      ? [buildToolSearchTool(() => this.mcpTools, this.activatedMcpToolNames)]
      : [];

    return [
      ...skillTools,
      ...searchTools,
      ...legacyTools.map((tool) => ({
```

(`buildToolSearchTool` returns an `AgentTool` already in the runtime shape with `execute`, so it sits alongside `skillTools` directly — do NOT pass it through the `legacyTools.map` adapter.)

- [ ] **Step 3: Drive `runLoop` with the resolver**

The turn currently builds the tools once and passes the array (anchors: `const agentTools = this.buildAgentTools();` and the `runLoop(` call's `agentTools,` argument). Remove the one-time build and pass the resolver.

Delete the line:
```ts
        const agentTools = this.buildAgentTools();
```
and change the `runLoop` argument from:
```ts
            agentTools,
```
to:
```ts
            () => this.buildAgentTools(),
```

(`this.mcpTools` is refreshed just above this point each turn; `buildAgentTools()` reads it plus the sticky `activatedMcpToolNames`, so each internal loop turn sees the current active set.)

- [ ] **Step 4: Add prompt guidance**

In `packages/coding-agent/src/agent/prompts/nativeSystemPrompt.ts`, find the tools/instructions section that mentions MCP or the shell-usage bullet (anchor: the bullet added during consolidation, `For git, package management, builds, tests, linting, and formatting, use \`run_command\``). After that bullet, add:

```
- When you need an integration capability that is not in your current tool list (and many MCP tools exist), call `tool_search` with keywords to find and activate the right tool, then call that tool by name on a following step.
```

- [ ] **Step 5: Typecheck + regression (GREEN)**

Run: `pnpm run check`
Expected: PASS (proves the wiring is type-correct: resolver accepted by `runLoop`, `buildToolSearchTool`/selector signatures line up, no dangling `agentTools`).

Run these and expect each to print its pass line:
```bash
pnpm exec tsx scripts/verify-tool-search.ts
pnpm exec tsx scripts/verify-loop-dynamic-tools.ts
pnpm exec tsx scripts/verify-agent-tools.ts
pnpm exec tsx scripts/verify-tool-surface.ts
```
Expected: all PASS (no regression to the existing tool surface; `agentTools` removal is clean).

- [ ] **Step 6: Commit**

```bash
git add packages/coding-agent/src/agent/meer-agent.ts packages/coding-agent/src/agent/prompts/nativeSystemPrompt.ts
git commit -m "feat(agent): gate MCP tools behind tool_search above threshold"
```

---

## Self-Review

**1. Spec coverage (against `docs/superpowers/specs/2026-06-25-tool-search-design.md`):**
- Three tiers (always-active / catalog / activated) → Task 3 `buildAgentTools` + Task 2 `selectActiveMcpTools`. ✅
- Threshold gate (`>10`, `tool_search` absent at `≤10`) → Task 2 `shouldUseToolSearch` + Task 3 `useSearch` gate. ✅
- `runLoop` dynamic tools (per-turn re-derivation, backward-compatible) → Task 1. ✅
- `activatedMcpToolNames` session-sticky on the instance → Task 3 field + Task 2 set-mutation. ✅
- Keyword matching over name+description+serverName → Task 2 `rankMcpTools`. ✅
- `tool_search` schema `{query, maxResults?}`, summary return, no-match recovery message → Task 2 `buildToolSearchTool`. ✅
- Edge cases: server-drop (selector filters current catalog) ✅; idempotent activation (Set.add) ✅; threshold flapping (per-build evaluation, ≤10 inlines superset) ✅; name collisions (MCP names are server-prefixed per `MCPTool.name`, native assembled first) ✅.
- Prompt guidance → Task 3 Step 4. ✅
- Testing: `verify-tool-search.ts` (module) + `verify-loop-dynamic-tools.ts` (loop) → Tasks 2 & 1. ✅
- Non-goals (embeddings, deactivation, cross-session persistence, hiding native tools, config UI) → none introduced. ✅

**2. Placeholder scan:** No TBD/"handle edge cases"/"similar to Task N". Every code step shows full code; every test step shows full test code; grep/commands are exact. ✅

**3. Type consistency:**
- `rankMcpTools(catalog, query, maxResults)` defined (Task 2 Step 3) and called identically in the test (Task 2 Step 1) and inside `buildToolSearchTool`. ✅
- `selectActiveMcpTools(catalog, activated, useSearch)` and `shouldUseToolSearch(count)` signatures match between module (Task 2) and `meer-agent` wiring (Task 3). ✅
- `buildToolSearchTool(getCatalog, activated)` returns `AgentTool` (with `execute`) — consumed directly alongside `skillTools` in Task 3 Step 2 (not through the `.call`→`.execute` adapter). ✅
- `runLoop`'s new `tools: AgentTool[] | (() => AgentTool[])` (Task 1) is satisfied by `() => this.buildAgentTools()` (Task 3 Step 3), where `buildAgentTools(): AgentTool[]`. ✅
- `MCPTool` fields used (`name`, `serverName`, `description`, `inputSchema.properties`) all exist on the interface (`packages/coding-agent/src/mcp/types.ts`). ✅

**Risk note for the implementer:** Task 1 touches the shared `@meer-ai/agent` loop — its safety gate is `pnpm run check` (every existing `runLoop` caller must still compile against the union type) plus `verify-agent-loop-limits.ts` staying green (array path unchanged). Task 3 is glue; if `tsc` flags a dangling `agentTools` or a shape mismatch, that is the signal to fix the wiring, not to weaken a type.
