# get_context_remaining Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `get_context_remaining` native tool that reports the model's context-window usage (used / total / remaining tokens, percent, green/yellow/red status, and a guidance line) so the model can self-manage headroom.

**Architecture:** A new pure module `agent/context-usage.ts` holds two functions — `computeContextUsage` (turns raw token/char data + model id into used/total/estimated) and `formatContextRemaining` (turns that into the displayed text). The tool in `agent/tools/agent.ts` is a thin formatter that calls a new `MeerAgentToolContext.getContextUsage` callback and passes the result to `formatContextRemaining`. `MeerAgent` retains the latest provider-reported `promptTokens` and implements the callback via `computeContextUsage`. This is the 22nd native tool; both surface-lock tests move 21 → 22.

**Tech Stack:** TypeScript (ESM / NodeNext, `.js` import extensions), Zod schemas, standalone `tsx` verify scripts using `node:assert/strict`.

## Global Constraints

- ESM / NodeNext: all relative imports use `.js` extensions even though sources are `.ts`.
- Token source is **provider usage with char/4 estimate fallback**: use the last-reported `promptTokens` when present; otherwise estimate `ceil(totalChars / 4)` and mark `estimated: true`.
- Status thresholds (reuse `contextFillColor` from `utils/model-context.ts`): `>= 80` red, `>= 50` yellow, else green.
- Number formatting uses `.toLocaleString("en-US")` so thousands separators are deterministic regardless of host locale (tests assert `47,200`).
- `pnpm test` runner is broken on Windows; verify each script via `pnpm exec tsx scripts/<name>.ts` plus `pnpm run check` (`tsc --noEmit`).
- Tool-surface additions MUST be reflected in BOTH `scripts/verify-tool-surface.ts` and `scripts/verify-agent-tools.ts` or those gates fail.
- Module resolution is build-free: root `tsconfig.json` `paths` maps `@meer-ai/coding-agent/*` → `packages/coding-agent/src/*`, so `tsx` and `tsc` read source directly. New module import path: `@meer-ai/coding-agent/agent/context-usage.js`.

---

### Task 1: Pure context-usage module (compute + format)

**Files:**
- Create: `packages/coding-agent/src/agent/context-usage.ts`
- Test: `scripts/verify-context-remaining.ts`

**Interfaces:**
- Consumes: `getContextWindow`, `contextFillColor` from `packages/coding-agent/src/utils/model-context.ts` (existing). Signatures: `getContextWindow(model: string | undefined): { tokens: number }`; `contextFillColor(percent: number): "green" | "yellow" | "red"`.
- Produces (relied on by Tasks 2 and 3):
  - `interface ContextUsage { usedTokens: number; totalTokens: number; estimated: boolean; }`
  - `computeContextUsage(input: { lastPromptTokens?: number; totalChars: number; model: string | undefined }): ContextUsage`
  - `formatContextRemaining(usage: ContextUsage | null): string`

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-context-remaining.ts`:

```ts
import assert from "node:assert/strict";
import {
  computeContextUsage,
  formatContextRemaining,
} from "@meer-ai/coding-agent/agent/context-usage.js";

// --- computeContextUsage: exact (provider usage present) ---
const exact = computeContextUsage({
  lastPromptTokens: 47200,
  totalChars: 999999, // ignored when lastPromptTokens is present
  model: "claude-opus-4-7",
});
assert.equal(exact.usedTokens, 47200, "exact path uses provider promptTokens");
assert.equal(exact.totalTokens, 200000, "window resolved from model id");
assert.equal(exact.estimated, false, "exact path is not estimated");

// --- computeContextUsage: estimate (no provider usage yet) ---
const est = computeContextUsage({
  totalChars: 400000,
  model: "claude-opus-4-7",
});
assert.equal(est.usedTokens, 100000, "estimate is ceil(totalChars / 4)");
assert.equal(est.estimated, true, "estimate path flagged");

// --- formatContextRemaining: real-usage (green) ---
const green = formatContextRemaining({
  usedTokens: 47200,
  totalTokens: 200000,
  estimated: false,
});
assert.match(green, /47,200/, "shows used with separators");
assert.match(green, /200,000/, "shows total with separators");
assert.match(green, /24%/, "computes percent");
assert.match(green, /green/, "green status");
assert.match(green, /Remaining: ~152,800 tokens/, "remaining line");
assert.doesNotMatch(green, /\(estimated\)/, "real usage not marked estimated");
assert.match(green, /Plenty of headroom\./, "green guidance");

// --- formatContextRemaining: estimate marker ---
const estimatedOut = formatContextRemaining({
  usedTokens: 100000,
  totalTokens: 200000,
  estimated: true,
});
assert.match(estimatedOut, /\(estimated\)/, "estimate marker present");
assert.match(estimatedOut, /estimate until the first model response/, "estimate note");

// --- formatContextRemaining: yellow threshold (>= 50) ---
const yellow = formatContextRemaining({
  usedTokens: 120000,
  totalTokens: 200000,
  estimated: false,
});
assert.match(yellow, /60%/, "yellow percent");
assert.match(yellow, /yellow/, "yellow status");
assert.match(yellow, /Getting full/, "yellow guidance");

// --- formatContextRemaining: red threshold (>= 80) ---
const red = formatContextRemaining({
  usedTokens: 180000,
  totalTokens: 200000,
  estimated: false,
});
assert.match(red, /90%/, "red percent");
assert.match(red, /red/, "red status");
assert.match(red, /wrap up/, "red guidance");

// --- formatContextRemaining: unavailable ---
const none = formatContextRemaining(null);
assert.equal(
  none,
  "Context usage is not available in this session.",
  "null usage yields graceful line"
);

console.log("✅ get_context_remaining compute + format verification passed");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx scripts/verify-context-remaining.ts`
Expected: FAIL — cannot resolve `@meer-ai/coding-agent/agent/context-usage.js` (module does not exist yet).

- [ ] **Step 3: Write the module**

Create `packages/coding-agent/src/agent/context-usage.ts`:

```ts
import {
  getContextWindow,
  contextFillColor,
} from "../utils/model-context.js";

/**
 * Current context-window occupancy for the active session, as surfaced to the
 * model by the get_context_remaining tool.
 */
export interface ContextUsage {
  /** Tokens currently occupying the context window. */
  usedTokens: number;
  /** The model's context-window size in tokens. */
  totalTokens: number;
  /** True when usedTokens is a char/4 estimate (no provider usage yet). */
  estimated: boolean;
}

/**
 * Resolve current usage from whatever the agent knows. Prefers the provider's
 * last-reported prompt-token count (exact); before any response exists this
 * turn, falls back to a chars/4 estimate of the visible transcript.
 */
export function computeContextUsage(input: {
  lastPromptTokens?: number;
  totalChars: number;
  model: string | undefined;
}): ContextUsage {
  const estimated = input.lastPromptTokens === undefined;
  const usedTokens = input.lastPromptTokens ?? Math.ceil(input.totalChars / 4);
  const totalTokens = getContextWindow(input.model).tokens;
  return { usedTokens, totalTokens, estimated };
}

/**
 * Format usage into the text the model sees. Returns a graceful line when
 * usage cannot be determined (null), rather than throwing.
 */
export function formatContextRemaining(usage: ContextUsage | null): string {
  if (!usage) {
    return "Context usage is not available in this session.";
  }

  const { usedTokens, totalTokens, estimated } = usage;
  const percent =
    totalTokens > 0
      ? Math.max(0, Math.min(100, Math.round((usedTokens / totalTokens) * 100)))
      : 0;
  const status = contextFillColor(percent);
  const remaining = Math.max(0, totalTokens - usedTokens);
  const estMark = estimated ? " (estimated)" : "";

  const guidance =
    percent >= 80
      ? "Context nearly full — wrap up, summarize, or compact soon; avoid large reads."
      : percent >= 50
        ? "Getting full — prefer concise responses and avoid re-reading large files."
        : "Plenty of headroom.";

  const lines = [
    `Context: ${usedTokens.toLocaleString("en-US")} / ${totalTokens.toLocaleString("en-US")} tokens used (${percent}%)${estMark} — ${status}`,
    `Remaining: ~${remaining.toLocaleString("en-US")} tokens`,
    guidance,
  ];

  if (estimated) {
    lines.push("(Token count is an estimate until the first model response.)");
  }

  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx scripts/verify-context-remaining.ts`
Expected: PASS — prints `✅ get_context_remaining compute + format verification passed`

- [ ] **Step 5: Type-check**

Run: `pnpm run check`
Expected: PASS (no errors).

- [ ] **Step 6: Commit**

```bash
git add packages/coding-agent/src/agent/context-usage.ts scripts/verify-context-remaining.ts
git commit -m "feat(context): pure compute/format helpers for get_context_remaining"
```

---

### Task 2: Register the get_context_remaining tool + lock the surface

**Files:**
- Modify: `packages/coding-agent/src/agent/tools/agent.ts` (add `getContextUsage` to `MeerAgentToolContext` ~line 11–71; add a `case "get_context_remaining"` in the `callMeerTool` switch ~line 399; add a tool definition to `baseToolDefinitions` ~line 1095, just before the closing `];`)
- Modify: `scripts/verify-agent-tools.ts:26-48` (add the name; add a behavioral assertion)
- Modify: `scripts/verify-tool-surface.ts:73` area (add a `names.has` assertion)

**Interfaces:**
- Consumes: `formatContextRemaining`, `ContextUsage` from `../context-usage.js` (Task 1).
- Produces (relied on by Task 3): `MeerAgentToolContext.getContextUsage?: () => ContextUsage | null` — the callback MeerAgent implements.

- [ ] **Step 1: Add the import**

In `packages/coding-agent/src/agent/tools/agent.ts`, near the existing imports at the top of the file, add:

```ts
import {
  formatContextRemaining,
  type ContextUsage,
} from "../context-usage.js";
```

- [ ] **Step 2: Add the callback to the context interface**

In `MeerAgentToolContext` (ends at `}` ~line 71), add this member before the closing brace:

```ts
  /**
   * Report current context-window usage for get_context_remaining.
   * Returns null when usage cannot be determined for this session.
   */
  getContextUsage?: () => ContextUsage | null;
```

- [ ] **Step 3: Add the dispatch case**

In the `callMeerTool` switch (starts ~line 399), add a case alongside the others (e.g. right after `case "analyze_project"`):

```ts
    case "get_context_remaining": {
      return formatContextRemaining(context.getContextUsage?.() ?? null);
    }
```

- [ ] **Step 4: Register the tool definition**

In `baseToolDefinitions`, add this entry immediately before the closing `];` (after the `find_references` entry ~line 1095):

```ts
  {
    name: "get_context_remaining",
    description:
      "Report how full the context window is (used/total/remaining tokens, percent, and a status). Call it to check headroom before large operations; treat yellow/red as a cue to be concise or wrap up.",
    schema: z.object({}),
    execute: (input, context) =>
      callMeerTool(
        "get_context_remaining",
        input as Record<string, unknown>,
        context
      ),
  },
```

- [ ] **Step 5: Update the exact-surface test**

In `scripts/verify-agent-tools.ts`, add `"get_context_remaining",` to the `expectedNames` array (anywhere in the list, lines 26–48). Then add a behavioral assertion after the `update_plan` block (after line 126), before the `commandUpdates` block:

```ts
const contextTool = toolkit.find(
  (tool) => tool.name === "get_context_remaining"
);
assert(contextTool, "get_context_remaining tool should exist");
// No getContextUsage wired on this bare context → graceful unavailable line.
const contextResult = await contextTool.call({});
assert.match(
  typeof contextResult === "string"
    ? contextResult
    : JSON.stringify(contextResult),
  /not available in this session/,
  "get_context_remaining degrades gracefully without a usage provider"
);
```

- [ ] **Step 6: Update the surface-lock test**

In `scripts/verify-tool-surface.ts`, add this assertion just before the final `console.log` (line 81):

```ts
// 22nd tool: context self-awareness.
assert.ok(names.has("get_context_remaining"), "get_context_remaining must exist");
```

- [ ] **Step 7: Run the tests**

Run each:
```
pnpm run check
pnpm exec tsx scripts/verify-agent-tools.ts
pnpm exec tsx scripts/verify-tool-surface.ts
pnpm exec tsx scripts/verify-context-remaining.ts
```
Expected: all PASS. `verify-agent-tools.ts` prints `✅ Agent tool wrappers cover all core CLI tools.`; `verify-tool-surface.ts` prints `tool surface verification passed`.

- [ ] **Step 8: Commit**

```bash
git add packages/coding-agent/src/agent/tools/agent.ts scripts/verify-agent-tools.ts scripts/verify-tool-surface.ts
git commit -m "feat(tools): register get_context_remaining (surface 21->22)"
```

---

### Task 3: Wire live usage into MeerAgent + prompt bullet

**Files:**
- Modify: `packages/coding-agent/src/agent/meer-agent.ts` (add import; add `lastPromptTokens` field near other private fields ~line 141; set it in the `case "usage":` handler ~line 462; implement `getContextUsage` in the `createMeerAgentTools` context object ~line 1027, alongside `getShellCwd`/`setShellCwd`)
- Modify: `packages/coding-agent/src/agent/prompts/nativeSystemPrompt.ts:107` (add a bullet after the `tool_search` bullet)

**Interfaces:**
- Consumes: `computeContextUsage` from `./context-usage.js` (Task 1); `getContextStats(): { visibleMessages: number; totalChars: number } | null` (existing method ~line 785); `this.model: string` (existing field ~line 141); `MeerAgentToolContext.getContextUsage` (Task 2).
- Produces: a fully wired `get_context_remaining` returning live token data in real sessions.

- [ ] **Step 1: Add the import**

In `packages/coding-agent/src/agent/meer-agent.ts`, near the existing `./tool-search.js` import (line ~9 region), add:

```ts
import { computeContextUsage } from "./context-usage.js";
```

- [ ] **Step 2: Add the field**

Near the other private fields (after `private model: string;` ~line 141), add:

```ts
  /** Latest provider-reported prompt-token count; current context occupancy. */
  private lastPromptTokens?: number;
```

- [ ] **Step 3: Capture usage in the event handler**

In the `case "usage":` block (~line 462), set the field before emitting:

```ts
            case "usage":
              if (typeof event.promptTokens === "number") {
                this.lastPromptTokens = event.promptTokens;
              }
              this.config.onUsage?.({
                promptTokens: event.promptTokens,
                completionTokens: event.completionTokens,
              });
              break;
```

- [ ] **Step 4: Implement the callback**

In the context object passed to `createMeerAgentTools` (~line 1027, next to `getShellCwd` / `setShellCwd`), add:

```ts
        getContextUsage: () => {
          const stats = this.getContextStats();
          return computeContextUsage({
            lastPromptTokens: this.lastPromptTokens,
            totalChars: stats?.totalChars ?? 0,
            model: this.model,
          });
        },
```

- [ ] **Step 5: Add the system-prompt bullet**

In `packages/coding-agent/src/agent/prompts/nativeSystemPrompt.ts`, add a bullet immediately after the `tool_search` bullet (line 107):

```ts
- Call \`get_context_remaining\` to check how full the context window is; when it reports yellow or red, be concise, avoid large re-reads, and move to wrap up or summarize.
```

- [ ] **Step 6: Type-check and re-run the suite**

Run each:
```
pnpm run check
pnpm exec tsx scripts/verify-context-remaining.ts
pnpm exec tsx scripts/verify-agent-tools.ts
pnpm exec tsx scripts/verify-tool-surface.ts
```
Expected: all PASS. `pnpm run check` confirms `this.lastPromptTokens`, `computeContextUsage`, and the new context member all type-check against `event.promptTokens` and `getContextStats`.

- [ ] **Step 7: Commit**

```bash
git add packages/coding-agent/src/agent/meer-agent.ts packages/coding-agent/src/agent/prompts/nativeSystemPrompt.ts
git commit -m "feat(agent): wire live context usage into get_context_remaining"
```

---

## Self-Review

**Spec coverage:**
- Token source (provider usage + char/4 fallback) → Task 1 `computeContextUsage`; live wiring Task 3.
- Return shape (used/total/remaining/percent + status + guidance + estimated marker + unavailable line) → Task 1 `formatContextRemaining`, asserted in `verify-context-remaining.ts`.
- 22nd tool registered + dispatched → Task 2.
- Window lookup single source of truth (model-context.ts via computeContextUsage) → Task 1/3.
- MeerAgent retains last usage → Task 3 Step 2–3.
- System-prompt bullet → Task 3 Step 5.
- Surface lock 21 → 22 in both tests → Task 2 Steps 5–6.
- New deterministic verify script → Task 1.
- Graceful unavailable path → Task 1 (null) + Task 2 behavioral assertion.

**Placeholder scan:** none — every code step shows complete code and exact commands.

**Type consistency:** `ContextUsage` / `computeContextUsage` / `formatContextRemaining` names and signatures are identical across Tasks 1–3. The callback `getContextUsage?: () => ContextUsage | null` matches its implementation (returns the non-null `ContextUsage` from `computeContextUsage`, which satisfies `ContextUsage | null`) and its consumer (`context.getContextUsage?.() ?? null`). `event.promptTokens` typed `number | undefined`, guarded before assignment to `lastPromptTokens?: number`.
