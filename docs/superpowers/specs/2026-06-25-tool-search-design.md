# Design: `tool_search` for MCP tool discovery

**Date:** 2026-06-25
**Status:** Approved (brainstorming) — pending implementation plan
**Related:** [[tool-consolidation-2026-06]] (cut native tools 68→21; deferred `tool_search` to its own design pass), `docs/tool-audit-2026-06-24.md` (ADD: `tool_search`, P0→deferred).

## Problem

After the tool consolidation, Meer exposes **21 native tools** — a small per-turn schema payload. But MCP tools are flattened into the **same** per-turn tool list (`createMeerAgentTools(ctx, { mcpTools })` in `meer-agent.ts:989`, assembled in `buildAgentTools()`). A user running several MCP servers can have **dozens** of MCP tools sent to the provider on **every turn**, which is now the dominant source of tool-schema bloat and tool-selection confusion.

`tool_search` keeps the MCP catalog out of per-turn context: the model searches a catalog and only the matched MCP tools are promoted to first-class tools.

## Goals

- Remove large MCP tool catalogs from the per-turn provider payload.
- Let the model discover and then call MCP tools on demand, with a native feel (discovered tools become real first-class tools).
- Zero behavior change for users with few MCP tools.

## Non-goals (YAGNI)

- Embedding/semantic matching (keyword is sufficient for dozens of tools).
- A deactivation tool (the active set only grows within a session).
- Cross-session persistence (resets on new session/process).
- Hiding any of the 21 native tools behind search — they are always active.
- A user-configurable threshold UI (it is a constant).
- Re-adding the ~48 culled native tools behind search (out of scope; `run_command` covers them).

## Design decisions (from brainstorming)

1. **Target:** MCP tools only. Native tools stay always-active.
2. **Activation model:** *Expand the live tool set* (Codex-style) — matched MCP tools become first-class tools in the provider tool list for subsequent turns, not a generic dispatch proxy.
3. **Matching:** keyword/token scoring over `name` + `description` + server name (case-insensitive). Deterministic, no new infra.
4. **Lifecycle:** threshold gate (`>10` MCP tools engages search; `≤10` inlines as today) + **session-sticky** activation (activated tools persist for the whole session).

## Architecture

### Three tiers of tools per turn

- **Always-active:** the 21 native tools + `load_skill` + (conditionally) `tool_search`.
- **MCP catalog:** the full MCP tool list, held aside (NOT sent to the provider) when count `> threshold`.
- **Activated MCP tools:** the subset surfaced via `tool_search`, promoted to first-class provider tools.

### Threshold gate

`MCP_SEARCH_THRESHOLD = 10` (constant).

- `mcpTools.length <= 10`: inline all MCP tools (current behavior). `tool_search` is **not** registered.
- `mcpTools.length > 10`: hold MCP tools in the catalog; register `tool_search`; the active MCP set is only what has been activated.

The rule is evaluated per `buildAgentTools()` call. Because MCP servers connect in the background, the count may cross the threshold between messages; dropping to `≤10` inlines everything (a superset of the activated set — never hides an activated tool).

### The invasive change: dynamic tools in `runLoop` (`@meer-ai/agent/loop.ts`)

Today `runLoop` builds `toolDefs` (line 110) and `toolMap` (line 111) **once** and reuses them for every internal turn (`streamWithTools(llmMessages, toolDefs, signal)` at line 182). A tool activated mid-interaction therefore cannot appear.

**Change:** `runLoop`'s `tools` parameter accepts `AgentTool[] | (() => AgentTool[])`. At the **top of each turn** (inside `while (canStartAnotherTurn())`, before the provider call), re-derive `toolDefs` and `toolMap` from the resolver. Array callers are wrapped as `() => array` — fully backward-compatible.

This is the load-bearing change and the primary risk (shared package), but it is contained to the loop's turn boundary and backward-compatible.

### State ownership (`MeerAgent`)

- `mcpTools` — full catalog from `mcpManager.listAllTools()` (already exists).
- `activatedMcpToolNames: Set<string>` — session-persistent; lives on the instance so it survives across `sendMessage` calls within a session.
- `buildAgentTools()` returns: native + skill tools + (`tool_search` if `>threshold`) + active MCP tools, where active = *all* MCP tools if `≤threshold`, else `mcpTools.filter(t => activatedMcpToolNames.has(t.name))`.
- `runLoop` is invoked with the resolver `() => this.buildAgentTools()` instead of a fixed array.

### The `tool_search` tool

- **Schema:** `{ query: string, maxResults?: number (default 5) }`.
- **Matching:** lowercase the query into tokens; score each catalog tool by the number of query tokens occurring in `name` + `description` + server name; sort by score desc, then name; take top `maxResults` with score > 0.
- **Side effect:** add matched tool names to `activatedMcpToolNames`.
- **Return value (text):** for each activated tool — `server:name`, description, and parameter names — plus a line stating they are now available as tools. This lets the model call them next turn without guessing the schema.
- **Construction:** built with closures over the agent's `mcpTools` (to search) and `activatedMcpToolNames` (to mutate), in `buildAgentTools()` / `meer-agent.ts`.

## Data flow

1. `sendMessage` → `mcpManager.whenReady()` → `this.mcpTools = listAllTools()`.
2. `buildAgentTools()` applies the threshold logic and assembles the active set.
3. `runLoop(inputMessages, () => this.buildAgentTools(), provider, …)`.
4. Turn 1: model sees native + `tool_search`; calls `tool_search("github pr")`.
5. `tool_search` ranks the catalog, adds `github:create_pr`, `github:list_prs` to `activatedMcpToolNames`, returns a summary.
6. Turn 2: the resolver re-runs `buildAgentTools()`; the active set now includes those tools as first-class; the model calls `create_pr` directly.
7. The activation persists on the instance → subsequent `sendMessage` calls keep those tools active.

## Error handling / edge cases

- **No matches:** return `"No tools matched '<query>'. N MCP tools available across servers: <server list>. Try broader terms."`
- **Already active:** idempotent — re-confirm availability, no duplication.
- **Server disconnects mid-session:** active tools are derived by filtering the *current* catalog, so a vanished tool drops from the active set automatically (no dangling definitions).
- **Threshold flapping:** evaluated per build; dropping to `≤10` inlines everything (superset of activated).
- **Name collisions (native vs MCP):** activation keys on `tool.name`; native tools are assembled first and win on dedupe. Confirm MCP naming during implementation and dedupe defensively.

## Testing

Standalone `scripts/verify-*.ts` (tsx + `node:assert`), per repo convention. `pnpm test` runner is broken on Windows — run individually via `pnpm exec tsx` + `pnpm run check`.

- **`scripts/verify-tool-search.ts`** — harness builds tools with a stub MCP catalog:
  - `≤10` MCP tools: all inlined; `tool_search` absent.
  - `>10` MCP tools: `tool_search` present; MCP tools absent from the initial set.
  - Matching: `tool_search("create github pull request")` ranks `create_pr` above unrelated tools; respects `maxResults`.
  - Activation + sticky: after `tool_search`, the active set includes matches; a second build still includes them.
  - No-match path: returns the recovery message listing servers.
  - Server-drop: an activated tool absent from the catalog drops from the active set.
- **`@meer-ai/agent` loop dynamic-tools test** (`scripts/verify-loop-dynamic-tools.ts` or extend an existing loop verify): a resolver returning `[A]` on turn 1 and `[A, B]` on turn 2 makes `B` callable on turn 2; the array form still works (backward-compat).
- Gates: `pnpm run check` (tsc, dangling-ref gate) + the new scripts.

## Files (anticipated)

- `packages/agent/src/loop.ts` — dynamic `tools` resolver; re-derive `toolDefs`/`toolMap` per turn.
- `packages/coding-agent/src/agent/meer-agent.ts` — `activatedMcpToolNames` state; threshold logic in `buildAgentTools()`; pass resolver to `runLoop`; construct `tool_search`.
- `packages/coding-agent/src/agent/tools/agent.ts` — possibly host the `tool_search` schema/impl (or co-locate in meer-agent where the catalog/state live).
- `packages/coding-agent/src/agent/prompts/nativeSystemPrompt.ts` — one-line guidance: when many MCP tools exist, use `tool_search` to find and activate them.
- `scripts/verify-tool-search.ts`, `scripts/verify-loop-dynamic-tools.ts` — new tests.

## Risks

- **`runLoop` change (shared package):** mitigated by backward-compatible signature (array still works) and per-turn re-derivation only.
- **Provider re-sends tool schemas each turn:** already the case; the active set is small, so net payload drops.
- **Token cost of the search round-trip:** only paid when `>10` MCP tools, and amortized by session-sticky activation.
