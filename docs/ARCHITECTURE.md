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
  @meer/tui            Vendored differential renderer. No agent/provider deps.
  @meer/ai             Providers + unified message transform + model catalog +
                       auth. Pure LLM I/O — knows nothing about agents.
  @meer/agent          GENERIC agent: loop, canonical message model + convertToLlm,
                       transformContext seam, compaction-as-a-message, session
                       store. No coding tools, no TUI, no concrete provider.
  @meer/coding-agent   The meer assistant: tools, slash commands, config, trust,
                       skills, MCP, and modes/{interactive,print,rpc}.
meer (root bin)        Thin CLI entry that wires the packages together.
```

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
- **Phase 1 — Extract `@meer/tui`.** Lowest risk; proves the workspace wiring.
- **Phase 2 — Extract `@meer/ai`.** Collapse the per-provider `convertAgentMessages`
  duplication into one shared transform; centralize model metadata (generated
  catalog). Move the faux provider here.
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
