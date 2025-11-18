# MeerAI Production-Readiness Plan

This roadmap adapts the operational maturity in Google's Gemini CLI to make MeerAI a production-ready developer assistant.

---

## Guiding Objectives

- Ship confidently: predictable release cadence, automated quality gates, reproducible builds.
- Delight in the terminal: fast, accessible Ink UI that scales to long sessions.
- Trust the agent: deterministic workflows, typed sub-agents, auditable tool calls.
- Operate safely: telemetry, error budgets, and documentation for contributors and users.

---

## Workstreams & Milestones

### 1. Release & Packaging

| Milestone | Description | Dependencies |
| --------- | ----------- | ------------ |
| `R1.1` Nightly/Preview/Stable channels | Mirror Gemini’s dist-tag flow with automated promotion + integrity checks. | CI workflow design |
| `R1.2` `npm run preflight` | Single command wraps clean install, lint, typecheck, build, tests. | Script orchestration |
| `R1.3` Binary distribution | Publish npm tarball + `npx meer-ai/meer` launcher + optional Homebrew tap. | Build artifacts |
| `R1.4` Release confidence doc | Document promotion SOP, rollback, smoke checklist. | `R1.1` |

### 2. Quality & Testing

| Milestone | Description |
| --------- | ----------- |
| `Q2.1` Integration environments | Separate suites for sandboxed file ops, shell exec, MCP servers (similar to Gemini’s `integration-tests`). |
| `Q2.2` Vitest migration | Adopt Vitest + Ink testing patterns (mock ordering, hoisted spies, ink-testing-library). |
| `Q2.3` Deflake harness | Retry harness for flaky integration specs (`npm run deflake`). |
| `Q2.4` Contributor playbook | New `MEER.md` covering testing, mocking, TypeScript conventions, tool safety criteria. |

### 3. UI & UX Parity

| Milestone | Description |
| --------- | ----------- |
| `U3.1` Layout modes | Alternate-buffer toggle, screen-reader layout, virtualization for history/pending items. |
| `U3.2` Rich composer | Context summary/approval indicators, todo tray, queued message display, shell/markdown badges. |
| `U3.3` Timeline & plan widgets | Bring WorkflowTimeline + plan tracking into Ink UI with scrollback-safe rendering. |
| `U3.4` Slash command UX | Palette parity with Gemini’s dialog manager (search, history, config, remember). |
| `U3.5` Accessibility QA | Keyboard shortcut matrix, screen-reader audits, copy-mode adjustments. |

### 4. Agent Architecture & Tools

| Milestone | Description |
| --------- | ----------- |
| `A4.1` Executor abstraction | Separate orchestration loop from CLI, enforce explicit `complete_task` semantics, hook into compression services. |
| `A4.2` Typed agent definitions | Optional zod schemas for inputs/outputs; convert to JSON schema for sub-agent tooling. |
| `A4.3` Sub-agent tools | Wrap sub-agents as declarative tools so the main agent can delegate dynamically. |
| `A4.4` Tool registry hardening | Isolated per-agent registries, safety validation for non-interactive execution, policy-aware approval bus. |
| `A4.5` MCP/tooling surfacing | Render tool calls + approvals in UI timeline with clear iconography and diff previews. |

### 5. Operational Excellence

| Milestone | Description |
| --------- | ----------- |
| `O5.1` Telemetry & analytics | Optional opt-in metrics (latency, tool usage, errors) similar to Gemini’s telemetry. |
| `O5.2` Config schema generation | Scripted docs for CLI settings/keybindings (cf. Gemini’s `docs:settings`, `docs:keybindings`). |
| `O5.3` Troubleshooting guide | Mirror Gemini’s `docs/troubleshooting.md`, covering MCP, auth, shell integration, proxies. |
| `O5.4` Security checklist | Threat modeling for shell/file tools, approval prompts, audit logging of modifications. |

---

## Execution Phases

1. **Foundation (Weeks 1‑3)**
   - Implement `npm run preflight` + lint/test gaps (`R1.2`, `Q2.2`).
   - Draft `MEER.md` contributor guide (`Q2.4`).
   - Stand up release-channel CI scaffolding (`R1.1` draft).

2. **Release & Packaging (Weeks 4‑6)**
   - Finish dist-tag pipeline, automated promotions, docs (`R1.1–R1.4`).
   - Publish npm + `npx` bootstrap + Homebrew tap (`R1.3`).
   - Add deflake harness and sandboxed integration entrypoint (`Q2.1`, `Q2.3`).

3. **UI/UX Modernization (Weeks 7‑10)**
   - Introduce alternate-buffer + screen-reader layouts + virtualization (`U3.1`).
   - Port composer widgets, todo tray, timeline integration (`U3.2–U3.3`).
   - Accessibility QA sweep + slash command polish (`U3.4–U3.5`).

4. **Agent & Tooling (Weeks 11‑14)**
   - Refactor agent workflow into executor abstraction with typed definitions (`A4.1–A4.2`).
   - Expose sub-agents as tools, enforce tool registry validation (`A4.3–A4.4`).
   - Enhance tool surfacing in UI (`A4.5`).

5. **Ops Hardening (Weeks 15+)**
   - Telemetry pipeline, config doc generators, troubleshooting/security docs (`O5.1–O5.4`).
   - Evaluate error budgets, SLOs, and automated alerting for failures.

---

## Success Criteria

- Weekly stable releases with ≤1% rollback rate; preview/nightly available to beta users.
- `npm run preflight` enforced in CI and locally before publish.
- Ink UI maintains <100 ms frame time with 1k-line transcripts; screen-reader mode verified.
- Agent workflows expose typed reports, todo lists, and approval history in UI.
- Contributors onboard via documented conventions; users have troubleshooting + config references.

---

## Current Focus — High-Impact UX Milestones

| Milestone | Priority | Status | Next Actions |
| --------- | -------- | ------ | ------------ |
| `U3.1` Layout modes | P0 | 🟢 In progress | Config/UI plumbing + screen-reader layout + runtime toggles shipped; next: alternate-buffer scrollbar + scroll controls. |
| `U3.2` Rich composer | P0 | ⚪ Not started | Inventory composer data sources (context summary, approvals, todo state) and design placement above prompt. |
| `U3.3` Timeline & plan widgets | P1 | ⚪ Not started | Define shared event bus between agent workflow and Ink timeline; prototype spinner/todo rendering. |
| `A4.3` Sub-agent tools | P1 | ⚪ Not started | Evaluate mapping from Markdown agent definitions to JSON schema so UI can display delegated tool calls. |

Legend: P0 = user-visible difference this cycle, P1 = queued next, 🟡 = active, ⚪ = queued.

---

## Design Notes

### `U3.1` Layout Modes & Virtualization

**Goals**
- Enable alternate-buffer output (smooth scrollback, custom scrollbar) with a config toggle.
- Provide a screen-reader-optimized layout that flattens regions and exposes semantic labels.
- Virtualize the history list and pending stream so very long sessions stay under 100 ms/frame.

**Proposed Architecture**
1. **Config surface**
   - Extend `ConfigSchema` with `ui` block:
     ```yaml
     ui:
       useAlternateBuffer: true
       screenReaderMode: auto   # auto | on | off
       virtualizedHistory: auto # auto -> enable when history > N items or terminal height > 40
     ```
   - Load into `LoadedConfig`, expose via a new `UISettingsContext`.
   - Support env overrides (`MEER_UI_SCREEN_READER=1`, `MEER_UI_ALT_BUFFER=0`) for scripts.

2. **Ink root layout**
   - Create `AppContainer` that inspects settings + runtime heuristics (detect tmux copy mode, `$TERM_PROGRAM`) to decide between:
     - `AlternateBufferLayout`: width = terminal width, reserves column for scrollbar, uses `<ScrollableList>` for history.
     - `StandardLayout`: current layout with minimal changes.
     - `ScreenReaderLayout`: single-column Box, disable gradients/BigText, replace icons with text labels.
   - Hook in/out of alternate buffer using `ansi-escapes` `enterAlternateScreen`/`exitAlternateScreen`, ensure cleanup on exit signals.

3. **Virtualized history**
   - Introduce `useVirtualizedHistory` hook that slices history + pending arrays based on scroll position.
   - Backed by existing `ScrollbackManager`? (if absent, add simple data structure storing `startIdx`, `endIdx`).
   - Render with new `VirtualizedList` component (similar to Gemini’s `ScrollableList`), using estimated heights and incremental rendering.
   - When not in alternate buffer, fall back to `ink`’s `<Static>` for committed items but cap total nodes (e.g., keep last 100, rest summarized as “Show older…” link).

4. **Screen-reader semantics**
   - Add `aria-label` equivalents using Ink’s `role` props, ensure prompts + responses announce speaker (`You`, `Meer`).
   - Provide textual indicators for tool calls (e.g., `[Tool] read_file src/index.ts`).
   - Expose a toggle via slash command `/accessibility screen-reader on`.

5. **Telemetry & guard rails**
   - Emit debug logs when switching layouts to help diagnose user reports.
   - Add smoke tests with `ink-testing-library` verifying each layout renders deterministic node counts and respects settings.

**Visible Impact**
- Users immediately see smoother scrolling, alternate buffer progress bar, and accessible mode hints—closing parity gap with Gemini.

### `U3.2` Rich Composer & Context Surface

**Goals**
- Surface context summary, approval/auto-apply state, slash command hints, and queued operations without leaving the prompt.
- Provide inline todo progress (tie-in with LangChain plan) and session stats (tokens, cost ceiling).

**Proposed Architecture**
1. **Composer data pipeline**
   - Extend `SessionTracker` to expose `todoList`, `pendingApprovals`, `streamingState`, `tokenStats`.
   - Pass into `MeerChat` via new `ComposerState` prop backed by Zustand/Context store so updates don’t rerender entire history.

2. **Layout structure**
   - Header row: warning/approval indicator + context summary (files, MCP servers, slash command hint).
   - Middle tray: 
     - Todo chip showing `n/m` completed + currently active item.
     - Tool/approval queue (e.g., “Applying edit: src/auth.ts” with progress spinner).
     - Memory status (enabled/disabled) and provider/model badges.
   - Footer row: shell/markdown toggle, Vim hint, instructions.

3. **Interactions**
   - Keyboard shortcuts: `Ctrl+Space` toggles context summary, `Ctrl+T` opens todo drawer, `Ctrl+P` cycle plan steps.
   - Slash commands auto-complete area uses `ink-select-input` positioned above or below prompt depending on alternate buffer mode.

4. **Testing**
   - Storybook-style snapshots via `ink-testing-library` verifying combinations (approval pending + todo active etc.).
   - Integration test feeding fake `composerState` to ensure no React warnings when props change rapidly.

**Visible Impact**
- Users always know what the agent is doing (thinking vs waiting for approval), what files are in context, and what plan stage they’re on, matching Gemini’s composer experience.

### `U3.3` Timeline & Plan Widgets

**Goals**
- Present a live workflow timeline with spinners, success/error icons, and tool outputs (diff previews, command logs).
- Track plan steps (from `/plan` or LangChain plan) so users can approve/skip per step.

**Proposed Architecture**
1. **Event bus**
   - Introduce `AgentEventBus` (Node EventEmitter or RxJS) emitting `TaskStarted`, `TaskUpdated`, `TaskFinished`, `PlanUpdated`, `ToolCall` payloads.
   - Agent workflow emits events whenever it starts tool calls, receives results, or updates plan states.

2. **Timeline store**
   - In Ink, maintain `TimelineContext` that subscribes to the bus and keeps bounded history (last 50 events).
   - Reuse `WorkflowTimeline` formatting for CLI logs but render as Ink component with icons + colors.

3. **Plan widget**
   - Represent plan as ordered list with statuses. Provide shortcuts (`[1]` skip, `[2]` mark done) when agent requests approval.
   - Display near composer (maybe left column) or as collapsible drawer.

4. **Tool output rendering**
   - For edits: show diff summary (lines added/removed) with ability to expand full diff via keybinding.
   - For shell commands: show command, truncated output, toggle to open in pager.

5. **Persistence**
   - Allow `/timeline save` to dump recent events to `~/.meer/logs/…` for debugging.

**Visible Impact**
- Timelines make the agent’s reasoning transparent; plan list reduces confusion about what’s next.

### `A4.3` Sub-agent Tools Exposure

**Goals**
- Allow the main agent to invoke sub-agents as first-class tools, with typed parameters and UI surfacing.

**Proposed Architecture**
1. **Agent schema extraction**
   - Extend Markdown agent definitions to include optional `inputs` + `outputs` metadata (name, description, type).
   - Provide converter that maps metadata to JSON Schema/Zod definitions.

2. **Tool wrapper**
   - Implement `SubAgentTool` similar to Gemini’s `SubagentToolWrapper`. When invoked, it spawns the sub-agent workflow with isolated context and returns structured result.
   - Register wrapper automatically during agent registry initialization so all enabled agents become tools.

3. **Safety/approval**
   - Before registration, validate sub-agent’s allowed tools subset (read-only vs write).
   - If sub-agent can modify files, propagate approval prompts back to the main UI with clear “delegated action” labels.

4. **UI integration**
   - Timeline shows `🤖 sub-agent-name` entries with nested tool calls.
   - Composer displays sub-agent summary once it finishes (e.g., Code Review findings).

5. **Testing**
   - Unit tests for schema conversion.
   - Integration test ensuring a sub-agent invoked as tool returns well-typed JSON consumed by main agent.

**Visible Impact**
- Users can request “have the debugger agent investigate the stack trace” and watch it run inside the same session, matching Gemini’s delegation story.

### Progress Log

- UI config surface + AppContainer scaffolded alternate-buffer + screen-reader toggles (U3.1 foundations). Pending: virtualization engine & accessibility layout pass.
- MeerChat now honors virtualized history windows (auto-bounded to terminal height) so large sessions stay responsive while showing a banner when older turns are hidden.
- Dedicated screen-reader layout delivers text-first status, plan, and message summaries with guidance on toggling the mode.
- `/screen-reader` and `/alt-buffer` slash commands (plus env overrides) let users flip layouts at runtime without restarting the CLI.
- Placeholder virtualized list + scroll controls (PgUp/PgDn/Ctrl+A/Ctrl+E) keep alternate-buffer sessions from flooding the screen while signaling manual scroll state.
