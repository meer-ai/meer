# meer architecture & migration plan

> Status: **structural migration complete.** meer is now a layered pnpm monorepo
> — five packages with an enforced dependency DAG, a thin root launcher, and a
> fully green test suite. What remains (Phases 4b–5) are *feature* additions
> (headless modes, generated model catalog), not structural work. This document
> is the source of truth for the shape and the remaining roadmap.

## Current shape (achieved)

```
packages/
  @meer/core           fetch, auth/OAuth, retry, errors, provider-errors
  @meer/ai             types, Provider contract, attachments, faux, providers/,
                       transform-messages
  @meer/agent          loop (with transformContext seam) + orchestration types
  @meer/tui            differential renderer
  @meer/coding-agent   the assistant: tools, slash, config, trust, skills, MCP,
                       the interactive TUI app (117 files) — has the `meer` bin
meerai (root)          thin launcher: bin/meer.js → @meer/coding-agent
```

Dependency DAG (lower may not import higher): `core ← ai ← agent ← coding-agent`;
`tui` independent. Build order: core → ai → agent → tui → coding-agent. The full
build is clean, the shipped `meer` bin works through the launcher, and `pnpm test`
(the whole suite) is green.

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
  - [x] **Unified the OpenAI-format conversion.** `@meer/ai/providers/transform-messages.ts`
        now owns `buildOpenAIUserContent` + `convertAgentMessagesToOpenAI`
        (with a `reasoningReplay` option). `OpenAIProvider` and `OpenRouterProvider`
        both delegate to it; the two copy-pasted `convertAgentMessages` bodies are
        gone (DeepSeek/Together/Opencode already inherit OpenAI's). The subtle
        rules — orphan tool_result → `user` (never inline `system`), reasoning
        replay — are in one place, locked by `scripts/verify-transform-messages.ts`.
        (Anthropic/Gemini keep their own format-specific converters.)
  - [ ] Generated model catalog (context windows / costs / capabilities).

  - [x] **Base-layer decision: `@meer/core`** (chosen over absorbing into ai).
        Moved `utils/fetch` and the whole `auth/` subsystem into `@meer/core`;
        `attachments` went into `@meer/ai` instead (it needs `MessageAttachment`,
        an LLM type — keeping it in core would have cycled core→ai). All ~25
        importers (incl. dynamic `await import()` and single-quoted ones)
        repointed to `@meer/core/*` / `@meer/ai/*`. core is LLM-agnostic;
        verified no `agent/core/types` import remains in it. 22-test slice green.
- **Phase 3 — Extract `@meer/agent`** (the heart). *(core done)*
  - [x] **Generic kernel extracted.** `src/agent/core/{loop,types}.ts` →
        `@meer/agent/{loop,types}.ts`. It's the provider-/UI-agnostic agent:
        the tool-calling loop + orchestration types (`AgentTool`, `AgentEvent`).
        Only dep is `@meer/ai`. ~15 importers repointed. (Session/compaction
        orchestration — `agent-session`, `meer-agent`, `session-*` — is app-
        coupled and stays in the app for now.)
  - [x] **`transformContext` seam added** to the loop: an optional hook applied
        to the full message list immediately before every model call. The loop's
        own `messages` stay canonical (transforms never accumulate). Locked by a
        faux-provider test asserting the transform reaches the provider but not
        the durable history.
  - [x] **`buildRecentEvidenceSummary` DELETED.** `prepareTurnInput` no longer
        synthesizes a "Recent Evidence" system block — the tool results it
        restated are already in the history. The band-aid from this session's
        first bug is gone at the root; the seam above is where any future
        context shaping goes. (`verify-turn-input` now asserts *zero* synthesized
        blocks for any history.)
  - [ ] (Later) Decouple session/compaction into `@meer/agent` — it's currently
        in `@meer/coding-agent` (app-coupled to memory/config). Optional.
- **Phase 4a — Extract `@meer/coding-agent`.** ✅ **DONE.** Moved the whole app
  (`src/` → `packages/coding-agent/src/`, 117 files). It owns the `meer` bin;
  the root `meerai` package is now a thin launcher (`bin/meer.js` →
  `@meer/coding-agent`). The app's npm deps moved with it; latent
  hoisting-masked deps were made explicit (`chalk` in core; `typescript`,
  `zod-to-json-schema` in coding-agent). Root `tsconfig.json` type-checks the
  whole app from source via `paths`; `pnpm test` (all ~45 scripts) is green.

### Remaining — feature additions, not structural (optional roadmap)

The harness restructuring is finished. These build *on* the now-clean layering:

- **Phase 4b — `print`/JSON headless mode.** `meer -p "prompt"` (text) and
  `--mode json` (event stream). Unlocks scripting/CI and true end-to-end tests
  driven through `@meer/coding-agent` without the TUI. Highest value next step.
- **Phase 5 — RPC mode** (jsonl protocol to drive the agent programmatically)
  and the **generated model catalog** (`@meer/ai/models.generated.ts`: context
  windows / costs / capabilities from an upstream source, replacing the
  hand-rolled `maxTokens`/`DEFAULT_MODELS` scraps).

## Reference

The `pi` harness (`@earendil-works/pi-*`) is the architectural reference for this
split — `packages/{ai,agent,coding-agent,tui}` with a generic `agent/harness`
and hook-based context/session management. meer's TUI is already a vendored copy
of pi's `tui` package.
