# TUI Production Stabilization Plan

This plan tracks the Grok Build-inspired improvements we want in Meer's TUI.
The goal is production usability: stable layout, compact work visibility, and
debuggable long-running sessions.

## P0 - Layout Stability

- [x] Add full preflight gate before publishing.
- [x] Add terminal lifecycle stress tests.
- [x] Add long-session render stress tests.
- [x] Add compact status header with branch, cwd, provider/model, and context usage.
- [x] Keep header, transcript viewport, composer, and footer visible during long sessions.
- [x] Add transcript overflow indicators for hidden history.
- [x] Add narrow/wide snapshot-style assertions for the full TUI shell.

## P1 - Work Visibility

- [x] Show user/assistant timestamps.
- [x] Preserve completed tool durations.
- [x] Add concise tool row summaries for file ranges, shell commands, searches, and edits.
- [x] Add optional expanded tool detail view without flooding the transcript.
- [x] Add per-turn summary rows with total duration, tool count, and token delta.

## P1 - Output Management

- [x] Collapse long tool output and diff previews.
- [x] Surface full-output file paths when command output is capped.
- [x] Add configurable TUI output budgets for preview/detail lines and line width.
- [x] Preserve structured/media output behind compact transcript rows.

## P2 - Operator Controls

- [x] Surface renderer modes in the footer.
- [x] Add YAML-backed `/settings` command for TUI preferences.
- [x] Add a shortcuts overlay that lists active keybindings.
- [x] Add explicit scroll controls for transcript history.
- [x] Add copy/export controls for selected tool output and timeline slices.

## P2 - Diagnostics

- [x] Merge TUI timeline events with agent timeline events.
- [x] Record layout mode, viewport state, and terminal size in timeline/debug output.
- [x] Add renderer crash snapshots for width overflow, resize churn, and corrupted terminal state.
