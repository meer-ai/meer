# meer architecture & migration plan

> Status: **in progress.** This document tracks the multi-phase restructuring of
> meer from a single package into a layered monorepo. It is the source of truth
> for the target shape and the migration sequence — update it as phases land.

## Why

meer today is one package where the agent loop, provider quirks, session/memory,
and the TUI all reach into each other. That coupling is the root cause of a class
of bugs (e.g. context-history corruption fixed by canonicalizing the message
list) and it blocks capabilities that the best harnesses have: headless/scripted
runs, an RPC interface, deterministic tests, and a clean provider catalog.

The goal is for meer to be a harness people choose over opencode / codex / claude
code / cursor — which means the *generic agent* must be cleanly separable from
the *coding assistant* built on top of it.

## Target shape

A pnpm-workspace monorepo, mirroring the proven split used by the `pi` harness:

```
packages/
  @meer/core           Cross-cutting infra: HTTP (fetch), auth/OAuth. The base
                       layer — LLM-agnostic, depends on nothing meer.
  @meer/tui            Vendored differential renderer. No agent/provider deps.
  @meer/ai             LLM I/O: message model, Provider contract, attachments,
                       providers, model catalog. Depends on @meer/core (auth/HTTP).
  @meer/agent          GENERIC agent: loop, canonical message model + convertToLlm,
                       transformContext seam, compaction-as-a-message, session
                       store. No coding tools, no TUI, no concrete provider.
  @meer/coding-agent   The meer assistant: tools, slash commands, config, trust,
                       skills, MCP, and modes/{interactive,print,rpc}.
meer (root bin)        Thin CLI entry that wires the packages together.
```

Dependency DAG (lower may not import higher): `core ← ai ← agent ← coding-agent`;
`tui` is independent. Build order: core → ai → tui → app.

### The one rule that keeps it well-written

**`@meer/agent` must not import from `@meer/tui`, `@meer/coding-agent`, or any
concrete provider.** Its only inbound dependency is `@meer/ai` types. That single
constraint is what lets the agent run headless, over RPC, and in tests. Any PR
that violates it is wrong by definition.

## Decisions (locked)

- **Migration style:** incremental strangler. `meer` stays runnable and the test
  suite stays green at every commit. No long-lived rewrite branch.
- **First focus:** foundation — workspace tooling + a deterministic test
  substrate (the faux provider) + extracting the lowest-dependency package.
- **Regression posture:** opportunistic cleanups allowed. Module moves may also
  fix design warts (message model, config shape), as long as tests stay green.
- **Boundaries:** mirror pi — `ai` / `agent` / `coding-agent` / `tui`.

## Phases

Each phase ships independently with a green suite.

- **Phase 0 — Foundation + safety net** *(in progress)*
  - [x] Faux provider (`src/providers/faux.ts`) + deterministic agent-loop test
        (`scripts/verify-faux-provider.ts`). This is the substrate everything
        else is verified against; it also removes the need to shell out to real
        binaries (which fails on Windows).
  - [ ] pnpm workspaces + tsconfig project references + build/CI wiring.
- **Phase 1 — Extract `@meer/tui`.** ✅ **DONE.** Proves the workspace wiring.
  - [x] Decouple the renderer from meer app code via injection seams
        (`FuzzyFileFinder`, `setTuiDiagnosticReporter`). Zero `../../` imports.
        Guarded by `scripts/verify-autocomplete-injection.ts`.
  - [x] `pnpm-workspace.yaml`; moved `src/ui/tui/` → `packages/tui/src/`
        (`@meer/tui`, builds to `dist`); repointed all importers (3 app files +
        5 test scripts) to `@meer/tui/*`; added `@meer/tui: workspace:*` to the
        root deps. Build + tsc + full test suite green; bin runs.

### Package resolution strategy (reused for every package)

The published bin runs built `.js` (Node can't run `.ts`), but dev/test must
stay build-free (tsx-from-source). We get both with two tsconfigs + an exports
map, and no custom conditions:

- **`packages/<pkg>/package.json`** — `exports: { "./*.js": { types:
  "./dist/*.d.ts", default: "./dist/*.js" } }`. Real package resolution → built
  `dist`. This is what the bin and `node` use at runtime.
- **Root `tsconfig.json`** (dev typecheck + tsx tests) — `paths:
  { "@meer/<pkg>/*": ["./packages/<pkg>/src/*"] }`, and **no `rootDir`** (so
  pulling package source into the program doesn't trip TS6059 under `--noEmit`).
  tsx honors `paths` too, so tests resolve to source with no build.
- **Root `tsconfig.build.json`** (production build) — `extends tsconfig.json`
  but sets `paths: {}` (so `@meer/*` resolves to built `dist` `.d.ts`, not
  source) and restores `rootDir: "src"` (correct `dist/` layout).
- **Root `build` script** — build each package to `dist` first, then
  `tsc -p tsconfig.build.json` for the app. Packages build in dependency order.
- **Phase 2 — Extract `@meer/ai`.** *(in progress)*
  - [x] **Own the LLM I/O contract.** `@meer/ai/types.ts` now holds the
        conversation message model + tool schemas (`AgentMessage`,
        `ToolDefinition`, `ToolCallBlock`, `MessageAttachment`, `ToolResult`);
        `@meer/ai/base.ts` holds the `Provider` interface + `ProviderEvent`. The
        old homes (`src/agent/core/types.ts`, `src/providers/base.ts`) are now
        thin re-exports, so the ~100 indirect importers didn't move. Agent-
        orchestration types (`AgentTool` with `execute()`, `AgentEvent`) stay in
        `agent/core`. Faux provider moved to `@meer/ai/faux.ts`.
  - [x] **Concrete providers moved into `@meer/ai/providers/`** (15 files:
        anthropic, openai, openrouter, gemini, deepseek, ollama, together, zai,
        chatgpt, opencode, meer, provider-wrapper, structured, embeddingModels,
        toolNames). Also moved three leaf utils they needed — `retry`,
        `provider-errors`, `errors` — into `@meer/core`. `@meer/ai` now depends on
        `@meer/core` + `chalk`. `src/providers/` is gone; ~22 consumers repointed
        to `@meer/ai/providers/*` / `@meer/ai/base.js`. Build + tsc + 25-test
        slice green.
  - [ ] Collapse the per-provider `convertAgentMessages` duplication into one
        shared `transform-messages` (the Anthropic mid-conversation-system quirk
        lives here — fix it once).
  - [ ] Generated model catalog (context windows / costs / capabilities).

  - [x] **Base-layer decision: `@meer/core`** (chosen over absorbing into ai).
        Moved `utils/fetch` and the whole `auth/` subsystem into `@meer/core`;
        `attachments` went into `@meer/ai` instead (it needs `MessageAttachment`,
        an LLM type — keeping it in core would have cycled core→ai). All ~25
        importers (incl. dynamic `await import()` and single-quoted ones)
        repointed to `@meer/core/*` / `@meer/ai/*`. core is LLM-agnostic;
        verified no `agent/core/types` import remains in it. 22-test slice green.
- **Phase 3 — Extract `@meer/agent`** (the heart). Move loop/session/compaction,
  introduce the `transformContext` seam, and delete `buildRecentEvidenceSummary`
  — the context-history band-aid retires here, permanently.
- **Phase 4 — `@meer/coding-agent` + explicit modes.** Add `print`/JSON mode
  (unlocks scripting and true end-to-end tests without the TUI).
- **Phase 5 — RPC mode, generated model catalog, polish.**

## Reference

The `pi` harness (`@earendil-works/pi-*`) is the architectural reference for this
split — `packages/{ai,agent,coding-agent,tui}` with a generic `agent/harness`
and hook-based context/session management. meer's TUI is already a vendored copy
of pi's `tui` package.
