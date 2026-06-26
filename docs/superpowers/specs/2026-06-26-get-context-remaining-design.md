# get_context_remaining — design spec

Date: 2026-06-26
Status: Approved (brainstorming complete)
Builds on: tool-consolidation (21-tool surface), tool-search (deferred-items list)

## Goal

Give the model self-awareness of its context-window budget. Add a native
`get_context_remaining` tool the model can call to see how full the context is
(used / total / remaining tokens, percent, a green/yellow/red status, and a
short recommendation), so it can decide to be concise, wrap up, or trigger
compaction before hitting overflow.

This is one of the audit's deferred items. It is intentionally small: it
surfaces token data that already flows through the agent; it does not add new
tracking, networking, or compaction logic.

## Key decisions (locked during brainstorming)

1. **Token source — provider usage with estimate fallback.** Use the
   provider's last-reported `promptTokens` (exact, billed) when available. On
   the very first turn, before any model response exists, fall back to a
   `chars / 4` estimate of the visible transcript and mark the result as
   estimated. Always returns something usable.
2. **Return shape — full breakdown + guidance.** used / total / remaining /
   percent, a green/yellow/red status, and a one-line recommendation. The model
   gets both the raw numbers and a nudge.

## Architecture & data flow

`get_context_remaining` becomes the **22nd** native tool. Three small wiring
changes, no new subsystems.

### 1. MeerAgent retains the last usage

In the existing `case "usage":` handler in `meer-agent.ts` (currently emits
`onUsage`), store the latest prompt-token count on the instance:

```ts
private lastPromptTokens?: number;
// ...
case "usage":
  this.lastPromptTokens = event.promptTokens ?? this.lastPromptTokens;
  this.config.onUsage?.({
    promptTokens: event.promptTokens,
    completionTokens: event.completionTokens,
  });
  break;
```

The latest `promptTokens` is the size of the full prompt just sent to the
model — i.e. current context occupancy. By the time the model calls the tool
mid-turn, this reflects the most recent request, which is the best available
measure of fill.

### 2. New tool-context callback

Extend `MeerAgentToolContext` (in `agent/tools/agent.ts`):

```ts
/**
 * Report current context-window usage for get_context_remaining.
 * Returns null when usage cannot be determined for this session.
 */
getContextUsage?: () => {
  usedTokens: number;
  totalTokens: number; // model's context window, via getContextWindow(model)
  estimated: boolean;  // true when falling back to a char/4 estimate
} | null;
```

`MeerAgent` implements it when building the legacy/native tool context:

```ts
getContextUsage: () => {
  const stats = this.getContextStats();
  const estimated = this.lastPromptTokens === undefined;
  const usedTokens = this.lastPromptTokens
    ?? Math.ceil((stats?.totalChars ?? 0) / 4);
  const totalTokens = getContextWindow(this.model).tokens;
  return { usedTokens, totalTokens, estimated };
},
```

The window-size lookup stays in one place (MeerAgent, reusing the existing
`model-context.ts` helper the footer already uses), so there is a single source
of truth for the window number. `this.model` is the active model id used
elsewhere in MeerAgent; if it is not already a field, read it from the same
config the agent uses for the footer/context indicator.

### 3. The tool itself

Lives in `agent/tools/agent.ts`: registered in the `baseToolDefinitions` array
and dispatched in the `callMeerTool` switch, like every other native tool. It is
purely presentational — it takes no input, calls `context.getContextUsage()`,
and formats the result.

If `getContextUsage` is absent or returns `null` (e.g. a headless path that does
not wire it), the tool returns a graceful "not available" line rather than
throwing.

## Tool I/O and return format

### Input

None. Empty object schema:

```ts
inputSchema: { type: "object", properties: {} }
```

### Output

A compact text block returned as the tool result. Example:

```
Context: 47,200 / 200,000 tokens used (24%) — green
Remaining: ~152,800 tokens
Plenty of headroom.
```

- **Numbers:** `used / total (percent%)` plus a `Remaining: ~N tokens` line,
  formatted with thousands separators for readability.
- **Status:** `green` / `yellow` / `red` from `contextFillColor`
  (≥80 → red, ≥50 → yellow, else green) in `model-context.ts`. Percent comes
  from `contextFillPercent(usedTokens, model)` semantics — i.e.
  `round(used / total * 100)`, clamped to 0..100.
- **Guidance line**, driven by percent:
  - green (<50%): "Plenty of headroom."
  - yellow (50–79%): "Getting full — prefer concise responses and avoid
    re-reading large files."
  - red (≥80%): "Context nearly full — wrap up, summarize, or compact soon;
    avoid large reads."
- **Estimated flag:** when `estimated` is true, append ` (estimated)` after the
  token count and note that the figure is approximate until the first model
  response.
- **Unavailable:** when usage is null/absent, return the single line:
  "Context usage is not available in this session."

### System-prompt bullet

Add one line to `nativeSystemPrompt.ts`: the model may call
`get_context_remaining` to check headroom before large operations, and crossing
into yellow/red is its cue to be concise or wrap up.

## Testing

### Surface-lock updates (existing regression gates)

Adding a tool moves the locked surface from **21 → 22**. Update both:

- `scripts/verify-tool-surface.ts`
- `scripts/verify-agent-tools.ts` (the exact-name deepEqual + behavioral calls)

Both must add `get_context_remaining` to their expected name lists / counts.
They fail loudly otherwise — that is the point of the lock.

`pnpm run check` (`tsc --noEmit`) remains the dangling-reference gate.

### New test: `scripts/verify-context-remaining.ts`

Standalone `tsx` + `node:assert/strict`, matching the house style. Exercises the
tool's formatter directly via a stubbed `getContextUsage` — no provider, no
network, fully deterministic.

1. **Real-usage path** — stub returns
   `{ usedTokens: 47200, totalTokens: 200000, estimated: false }` → assert the
   output contains `47,200`, `200,000`, `24%`, `green`, a `Remaining:` line, and
   no `(estimated)` marker.
2. **Estimate path** — `{ ..., estimated: true }` → assert the `(estimated)`
   marker / approximate note is present.
3. **Threshold guidance** — feed a yellow (≥50%) usage and a red (≥80%) usage;
   assert the status word and matching guidance phrase ("wrap up" for red, the
   "getting full" phrasing for yellow).
4. **Unavailable path** — `getContextUsage` returns `null` → assert the graceful
   "not available" line and that the call does not throw.

### Verification commands (Windows)

`pnpm test` runner is broken on this box; run each verify script directly:

- `pnpm run check`
- `pnpm exec tsx scripts/verify-context-remaining.ts`
- `pnpm exec tsx scripts/verify-tool-surface.ts`
- `pnpm exec tsx scripts/verify-agent-tools.ts`

## Scope summary

- 1 field + 1 callback implementation in `MeerAgent`.
- 1 new callback on `MeerAgentToolContext`.
- 1 thin formatter tool (definition + dispatch case) in `agent/tools/agent.ts`.
- 1 system-prompt bullet.
- 2 surface-test bumps (21 → 22).
- 1 new verify script.

## Out of scope

- Automatic action on the threshold (the model decides; compaction triggers stay
  as they are).
- Per-provider exact context-window registries (the existing pattern-based
  `getContextWindow` map is reused as-is).
- Output-token / cost reporting (already shown in the footer; not this tool's
  job).
- The other deferred audit items (interactive shell stdin, OS sandbox +
  request_permissions, view_image).
