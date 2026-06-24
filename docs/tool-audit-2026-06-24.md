# Meer Tool Audit — kill / keep / merge (2026-06-24)

Comparison baseline: **Codex ~20 primitives**, **pi 7 tools** (`bash, edit, find, grep, ls, read, write`). Meer currently exposes **68** model-facing tools (all schemas sent every turn; no `tool_search`). `tools/index.ts` is 8,079 lines.

**Verdict legend:** `KEEP` = stays as a model tool · `MERGE→x` = collapse into another tool · `FOLD→run_command` = delete, model uses shell · `REMOVE` = delete outright · `REVIEW` = keep only if reliable+tested, else remove.

Sign-off column is for you — edit the verdict if you disagree.

---

## A. Core primitives — KEEP (every agent needs these)

| # | Tool | Verdict | Notes |
|---|------|---------|-------|
| 3 | `read_file` | KEEP | Core. Confirm pagination/truncation is on (offset/limit). |
| 5 | `edit_file` | KEEP | Already consolidated (pi engine + mutation queue). |
| 6 | `propose_edit` | KEEP | Full-file create/overwrite. |
| 7 | `run_command` | KEEP★ | The workhorse. Should absorb interactive stdin + sandbox (see ADD). |
| 8 | `find_files` | KEEP | = pi `find`. |
| 17 | `grep` | KEEP | Canonical content search. |
| 9 | `read_many_files` | KEEP | Cheap batch-read convenience; low cost to keep. |

## B. Dedupe — MERGE (you have two tools doing one job)

| # | Tool | Verdict | Notes |
|---|------|---------|-------|
| 4 | `list_files` | KEEP (merge target) | Keep as the single dir-listing tool. |
| 12 | `read_folder` | MERGE→`list_files` | Overlaps; add a `depth` param to list_files instead. |
| 10 | `search_text` | MERGE→`grep` | Two search tools confuse selection. |
| 33 | `http_request` | MERGE→`web_fetch` | Fold method/body params into one web tool. |
| 14 | `web_fetch` | KEEP (merge target) | Canonical web retrieval. |
| 43 | `start_background_command` | MERGE→`run_command` | Codex model: `run_command(background:true)` + stdin. |

## C. Plan tools — CONSOLIDATE 4 → 1 (Codex uses a single `update_plan`)

| # | Tool | Verdict | Notes |
|---|------|---------|-------|
| 38 | `set_plan` | MERGE→`update_plan` | |
| 39 | `update_plan_task` | MERGE→`update_plan` | |
| 40 | `show_plan` | REMOVE | Plan already lives in context; no need to fetch it. |
| 41 | `clear_plan` | MERGE→`update_plan` | |

## D. Git — FOLD into run_command (Codex & pi have ZERO git tools)

| # | Tool | Verdict | Notes |
|---|------|---------|-------|
| 18 | `git_status` | FOLD→run_command | If you keep any for nicer rendering, keep only this + git_diff. |
| 19 | `git_diff` | FOLD→run_command | |
| 20 | `git_log` | FOLD→run_command | |
| 21 | `git_commit` | FOLD→run_command | Approval is on run_command, not the tool. |
| 22 | `git_branch` | FOLD→run_command | |
| 62 | `git_blame` | FOLD→run_command | |

## E. Package / build / test / lint — FOLD into run_command (shell wrappers)

| # | Tool | Verdict | Notes |
|---|------|---------|-------|
| 26 | `package_install` | FOLD→run_command | `npm/pnpm install`. |
| 27 | `package_run_script` | FOLD→run_command | |
| 28 | `package_list` | FOLD→run_command | |
| 37 | `validate_project` | FOLD→run_command | build/test/typecheck are shell. |
| 47 | `dependency_audit` | FOLD→run_command | `npm audit`. |
| 48 | `run_tests` | FOLD→run_command | |
| 50 | `security_scan` | FOLD→run_command | (or REMOVE if heuristic-only). |
| 46 | `format_code` | FOLD→run_command | `prettier`. |
| 53 | `fix_lint` | FOLD→run_command | `eslint --fix`. |
| 54 | `organize_imports` | FOLD→run_command | |
| 57 | `analyze_coverage` | FOLD→run_command | |
| 36 | `check_syntax` | FOLD→run_command | `tsc --noEmit` / `node --check`. |

## F. Heuristic "AI" tools — REMOVE (verified: plain template functions, NOT LLM calls)

An LLM agent calling a heuristic function to "explain/generate/review" gets worse output than doing it itself in-turn.

| # | Tool | Verdict |
|---|------|---------|
| 44 | `explain_code` | REMOVE |
| 45 | `generate_docstring` | REMOVE |
| 49 | `generate_tests` | REMOVE |
| 51 | `code_review` | REMOVE |
| 52 | `generate_readme` | REMOVE |
| 59 | `generate_test_suite` | REMOVE |
| 60 | `generate_mocks` | REMOVE |
| 61 | `generate_api_docs` | REMOVE |
| 55 | `check_complexity` | REMOVE | (heuristic, low value) |
| 56 | `detect_smells` | REMOVE | (heuristic, low value) |

## G. AST refactor tools — REVIEW (real babel-based; neither competitor has them; high maintenance)

Keep only if they are reliable AND test-covered. Otherwise remove — the model can do these via `edit_file`.

| # | Tool | Verdict |
|---|------|---------|
| 63 | `rename_symbol` | REVIEW (most defensible — cross-file rename is hard to do by hand) |
| 64 | `extract_function` | REVIEW |
| 65 | `extract_variable` | REVIEW |
| 66 | `inline_variable` | REVIEW |
| 67 | `move_symbol` | REVIEW |
| 68 | `convert_to_async` | REMOVE (too narrow) |

## H. Code intelligence — KEEP & strengthen (genuine differentiator; back with real LSP)

| # | Tool | Verdict | Notes |
|---|------|---------|-------|
| 34 | `get_file_outline` | KEEP | Symbols/imports/exports. |
| 35 | `find_symbol_definition` | KEEP | Strengthen via LSP (you have `lsp/diagnostics.ts`). |
| 58 | `find_references` | KEEP | |
| 11 | `semantic_search` | KEEP | Embedding search — neither Codex nor pi has this. |

## I. Memory / interaction / web — KEEP (Codex has equivalents)

| # | Tool | Verdict |
|---|------|---------|
| 15 | `save_memory` | KEEP |
| 16 | `load_memory` | KEEP |
| 42 | `request_user_input` | KEEP (Codex has it) |
| 13 | `google_search` | KEEP (Codex `web_search`) |

## J. Filesystem misc & env — trim

| # | Tool | Verdict | Notes |
|---|------|---------|-------|
| 23 | `delete_file` | KEEP | Small, approval-gated; OK to keep (or fold to `rm`). |
| 24 | `move_file` | KEEP | (or fold to `mv`). |
| 25 | `create_directory` | FOLD→run_command | `mkdir -p`; no value standalone. |
| 31 | `set_env` | REVIEW | Keep only if writing `.env` is a real feature (distinct from shell export). |
| 30 | `get_env` | FOLD→run_command | `echo $VAR`. |
| 32 | `list_env` | REMOVE | |

## K. Project bootstrap — trim

| # | Tool | Verdict | Notes |
|---|------|---------|-------|
| 1 | `analyze_project` | DEMOTE | Useful for first-turn context — run it automatically once, don't expose as a model tool. |
| 2 | `suggest_setup` | REMOVE | Niche. |
| 29 | `scaffold_project` | REMOVE | Model can create files directly. |

---

## ADD — capabilities Codex/pi have that Meer lacks (new tools / infra)

| Capability | Source | Priority | Why |
|---|---|---|---|
| **`tool_search` / dynamic tool discovery** | Codex | **P0** | Keeps a large catalog out of per-turn context. Lets you retain many tools without bloat/selection-confusion. Highest leverage. |
| **Interactive shell (stdin to running process)** | Codex `unified_exec`/`write_stdin` | P1 | `run_command` is one-shot; can't drive REPLs / interactive prompts. |
| **OS sandbox + `request_permissions`** | Codex | P1 | Real execution boundary; model can ask to escalate. (Regex classifier is bypassable.) |
| **`get_context_remaining`** | Codex | P2 | Model-facing context-budget query → self-triggered compaction. |
| **`view_image` as a tool** | Codex | P2 | Multimodal input (you have `attachments.ts`, not a model tool). |

---

## Summary tally

- **KEEP:** ~18 (cores + code-intel + memory/web + merge targets)
- **MERGE/CONSOLIDATE:** ~9 → folds into ~4 survivors
- **FOLD→run_command:** ~19
- **REMOVE:** ~16
- **REVIEW (AST):** 6
- **ADD:** 5 (1× P0, 2× P1, 2× P2)

**Net:** 68 → roughly **22–26** model tools, plus `tool_search` so even that catalog is cheap. The biggest single win is `tool_search` (P0); the biggest cleanup win is deleting the heuristic `generate_*`/`explain_code`/`code_review` tools (Section F) since they hurt on every model tier.
