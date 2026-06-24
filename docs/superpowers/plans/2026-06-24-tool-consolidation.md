# Tool Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink Meer's model-facing tool surface from 68 tools to ~24 by removing heuristic/dead tools, folding shell-wrapper tools into `run_command`, and consolidating duplicate/4-way tools — reducing per-turn context bloat and tool-selection confusion.

**Architecture:** All model-facing tools are registered in the `baseToolDefinitions` array and dispatched by the `callMeerTool` switch, both in `packages/coding-agent/src/agent/tools/agent.ts`. Implementations live in `packages/coding-agent/src/tools/index.ts`. Removing a tool = delete its `baseToolDefinitions` entry + its `callMeerTool` case + its now-unused implementation function + references in `nativeSystemPrompt.ts` (the live prompt), `session-heuristics.ts`, `tool-filter.ts`, and `commands/agents.ts`. The single regression test `scripts/verify-tool-surface.ts` asserts the resulting tool-name set via `createMeerAgentTools`.

**Tech Stack:** TypeScript (ESM, NodeNext), Zod schemas, pnpm workspaces. Tests are standalone `scripts/verify-*.ts` run with `tsx` (no vitest/jest); `pnpm run check` runs `tsc --noEmit` and is the dangling-reference gate.

## Global Constraints

- Language: TypeScript, ESM only. Intra-package imports use `.js` extensions (NodeNext).
- Run a single test: `pnpm exec tsx scripts/verify-tool-surface.ts`. Typecheck: `pnpm run check`.
- **`pnpm test` (the full-suite runner) is broken on Windows** (`spawn node_modules/.bin/tsx ENOENT`) — pre-existing, not in scope. Verify via individual `pnpm exec tsx <script>` runs + `pnpm run check`.
- The live system prompt is `buildNativeSystemPrompt` in `packages/coding-agent/src/agent/prompts/nativeSystemPrompt.ts`. (The old `systemPrompt.ts`/`systemPrompt.optimized.ts`/`agentSystemPrompt.ts` were deleted; do not recreate references to them.)
- Locate every edit by **anchor text** (e.g. `case "run_tests": {`, `name: "run_tests",`, `export function runTests`), NOT by line number — line numbers shift as earlier tasks delete code.
- After each removal task, `pnpm run check` MUST pass (it is the proof that no live code depended on the removed function). If `tsc` flags a dangling reference, that reference is itself a removal/fold target — handle it.
- Backward-compat: a model that emits a now-removed tool name gets an unknown-tool error from the runtime's per-tool try/catch (recoverable, not a crash) — this is acceptable and requires no shim.
- Do NOT touch the surviving canonical tools: `read_file`, `edit_file`, `propose_edit`, `run_command`, `find_files`, `grep`, `list_files`, `read_many_files`, `semantic_search`, `get_file_outline`, `find_symbol_definition`, `find_references`, `save_memory`, `load_memory`, `request_user_input`, `web_fetch`, `google_search`, `delete_file`, `move_file`, `analyze_project`.

---

## File Structure

- `packages/coding-agent/src/agent/tools/agent.ts` — **modify** in every task. Remove `baseToolDefinitions` entries and `callMeerTool` cases; in Phase 3, add params to surviving tools and add the new `update_plan` tool.
- `packages/coding-agent/src/tools/index.ts` — **modify** in every task. Remove now-unused implementation functions; in Phase 3, extend `grep`/`listFiles`/`webFetch`/`runCommand` and add `updatePlan`.
- `packages/coding-agent/src/agent/prompts/nativeSystemPrompt.ts` — **modify**. Scrub removed tool names; add a one-line instruction to use `run_command` for git/build/test/lint.
- `packages/coding-agent/src/agent/session-heuristics.ts` — **modify**. Drop removed tool names from the mutating/relevant-tool lists.
- `packages/coding-agent/src/agents/tool-filter.ts` — **modify**. Drop removed tool names from allow lists.
- `packages/coding-agent/src/commands/agents.ts` — **modify**. Drop removed tool names from presets.
- `scripts/verify-tool-surface.ts` — **modify** in every task. Add `assert.ok(!names.has("<removed>"))` lines.

---

## Phase 1 — REMOVE dead/heuristic tools (pure deletion, lowest risk)

### Task 1: Remove heuristic "AI" tools

These are verified plain synchronous heuristic functions (no LLM call); an LLM agent produces better output doing the work in-turn.

**Tools (10):** `explain_code`, `generate_docstring`, `generate_tests`, `code_review`, `generate_readme`, `generate_test_suite`, `generate_mocks`, `generate_api_docs`, `check_complexity`, `detect_smells`

**Files:**
- Modify: `packages/coding-agent/src/agent/tools/agent.ts` (registration entries + `callMeerTool` cases)
- Modify: `packages/coding-agent/src/tools/index.ts` (impl functions `explainCode`, `generateDocstring`, `generateTests`, `codeReview`, `generateReadme`, `generateTestSuite`, `generateMocks`, `generateApiDocs`, `checkComplexity`, `detectSmells`)
- Modify: `packages/coding-agent/src/agent/session-heuristics.ts` (drop `explain_code`, `code_review`, `check_complexity`, `detect_smells`, `analyze_coverage` if present in the lists)
- Modify: `packages/coding-agent/src/agents/tool-filter.ts`, `packages/coding-agent/src/commands/agents.ts` (drop any of these names)
- Test: `scripts/verify-tool-surface.ts`

**Interfaces:**
- Consumes: `createMeerAgentTools(context, options): AgentTool[]` (each tool has `.name`) — existing.
- Produces: the tool-name set excludes all 10 names; survivors unchanged.

- [ ] **Step 1: Extend the test (RED)**

In `scripts/verify-tool-surface.ts`, add before the final `console.log`:

```ts
for (const removed of [
  "explain_code", "generate_docstring", "generate_tests", "code_review",
  "generate_readme", "generate_test_suite", "generate_mocks", "generate_api_docs",
  "check_complexity", "detect_smells",
]) {
  assert.ok(!names.has(removed), `${removed} must be removed`);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx scripts/verify-tool-surface.ts`
Expected: FAIL — `explain_code must be removed` (first still-present tool).

- [ ] **Step 3: Delete registrations + dispatch cases**

In `packages/coding-agent/src/agent/tools/agent.ts`, delete the `baseToolDefinitions` object literal AND the `callMeerTool` `case` block for each of the 10 tools. Locate each by anchor (`name: "explain_code",` … and `case "explain_code": {` …). Anchor lines for the cases: `case "explain_code"`, `case "generate_docstring"`, `case "generate_tests"`, `case "code_review"`, `case "generate_readme"`, `case "generate_test_suite"`, `case "generate_mocks"`, `case "generate_api_docs"`, `case "check_complexity"`, `case "detect_smells"`.

- [ ] **Step 4: Delete implementation functions**

In `packages/coding-agent/src/tools/index.ts`, delete each `export function` body: `explainCode`, `generateDocstring`, `generateTests`, `codeReview`, `generateReadme`, `generateTestSuite`, `generateMocks`, `generateApiDocs`, `checkComplexity`, `detectSmells`. (Locate by `export function <name>`.)

- [ ] **Step 5: Scrub references**

Remove these tool-name strings from the arrays in `session-heuristics.ts` (the relevant-tool lists around the `includes([...])` checks), `tool-filter.ts`, and `commands/agents.ts`. Then grep to confirm none remain:

Run: `grep -rnE "explain_code|generate_docstring|generate_tests|code_review|generate_readme|generate_test_suite|generate_mocks|generate_api_docs|check_complexity|detect_smells" packages/coding-agent/src --include='*.ts'`
Expected: no matches (camelCase `explainCode` etc. also gone).

- [ ] **Step 6: Typecheck + test (GREEN)**

Run: `pnpm run check`
Expected: PASS (proves nothing live depended on the deleted functions).

Run: `pnpm exec tsx scripts/verify-tool-surface.ts`
Expected: PASS — prints `tool surface verification passed`.

- [ ] **Step 7: Commit**

```bash
git add packages/coding-agent/src/agent/tools/agent.ts packages/coding-agent/src/tools/index.ts packages/coding-agent/src/agent/session-heuristics.ts packages/coding-agent/src/agents/tool-filter.ts packages/coding-agent/src/commands/agents.ts scripts/verify-tool-surface.ts
git commit -m "refactor(tools): remove heuristic generate_*/explain/review tools"
```

### Task 2: Remove AST refactor tools

**Tools (6):** `rename_symbol`, `extract_function`, `extract_variable`, `inline_variable`, `move_symbol`, `convert_to_async`

Rationale: untested babel-based code; `edit_file` + `find_references` covers the need. Can return later behind tool discovery if demand emerges.

**Files:**
- Modify: `agent/tools/agent.ts` (registrations + cases: `case "rename_symbol"`, `case "extract_function"`, `case "extract_variable"`, `case "inline_variable"`, `case "move_symbol"`, `case "convert_to_async"`)
- Modify: `tools/index.ts` (impl functions `renameSymbol`, `extractFunction`, `extractVariable`, `inlineVariable`, `moveSymbol`, `convertToAsync`)
- Modify: `session-heuristics.ts`, `tool-filter.ts`, `commands/agents.ts` (drop any of these names)
- Test: `scripts/verify-tool-surface.ts`

**Interfaces:** Consumes/Produces same as Task 1 — tool-name set excludes the 6 names.

- [ ] **Step 1: Extend the test (RED)**

Add to `scripts/verify-tool-surface.ts`:

```ts
for (const removed of [
  "rename_symbol", "extract_function", "extract_variable",
  "inline_variable", "move_symbol", "convert_to_async",
]) {
  assert.ok(!names.has(removed), `${removed} must be removed`);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx scripts/verify-tool-surface.ts`
Expected: FAIL — `rename_symbol must be removed`.

- [ ] **Step 3: Delete registrations + dispatch cases**

In `agent/tools/agent.ts`, delete the `baseToolDefinitions` entry and `callMeerTool` case for each of the 6 tools (locate by anchors above).

- [ ] **Step 4: Delete implementation functions**

In `tools/index.ts`, delete `export function` bodies: `renameSymbol`, `extractFunction`, `extractVariable`, `inlineVariable`, `moveSymbol`, `convertToAsync`. If any shared babel helper becomes unused after this (e.g. an AST parse helper used only by these), `tsc` with `noUnusedLocals` may flag it — if so, delete it too; otherwise leave shared helpers alone.

- [ ] **Step 5: Scrub references + grep clean**

Remove the 6 names from `session-heuristics.ts`, `tool-filter.ts`, `commands/agents.ts`.

Run: `grep -rnE "rename_symbol|extract_function|extract_variable|inline_variable|move_symbol|convert_to_async|renameSymbol|extractFunction|extractVariable|inlineVariable|moveSymbol|convertToAsync" packages/coding-agent/src --include='*.ts'`
Expected: no matches.

- [ ] **Step 6: Typecheck + test (GREEN)**

Run: `pnpm run check` → PASS.
Run: `pnpm exec tsx scripts/verify-tool-surface.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(tools): remove untested AST refactor tools"
```

### Task 3: Remove bootstrap/misc tools

**Tools (3):** `suggest_setup`, `scaffold_project`, `list_env`

**Files:**
- Modify: `agent/tools/agent.ts` (registrations + cases `case "suggest_setup"`, `case "scaffold_project"`, `case "list_env"`)
- Modify: `tools/index.ts` (impl functions `suggestSetup`, `scaffoldProject`, `listEnv`)
- Modify: `nativeSystemPrompt.ts` (remove the `scaffold_project` mention — confirmed present), `session-heuristics.ts`, `tool-filter.ts`, `commands/agents.ts`
- Test: `scripts/verify-tool-surface.ts`

**Interfaces:** tool-name set excludes the 3 names.

- [ ] **Step 1: Extend the test (RED)**

```ts
for (const removed of ["suggest_setup", "scaffold_project", "list_env"]) {
  assert.ok(!names.has(removed), `${removed} must be removed`);
}
```

- [ ] **Step 2: Run test** — Run: `pnpm exec tsx scripts/verify-tool-surface.ts` → FAIL `suggest_setup must be removed`.

- [ ] **Step 3: Delete registrations + dispatch cases** for the 3 tools (anchors above).

- [ ] **Step 4: Delete impl functions** `suggestSetup`, `scaffoldProject`, `listEnv` from `tools/index.ts`.

- [ ] **Step 5: Scrub references.** Remove `scaffold_project` from `nativeSystemPrompt.ts` (and the other 2 names wherever they appear in heuristics/filter/presets).

Run: `grep -rnE "suggest_setup|scaffold_project|list_env|suggestSetup|scaffoldProject|listEnv" packages/coding-agent/src --include='*.ts'`
Expected: no matches.

- [ ] **Step 6: Typecheck + test (GREEN)** — `pnpm run check` → PASS; `pnpm exec tsx scripts/verify-tool-surface.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(tools): remove suggest_setup, scaffold_project, list_env"
```

---

## Phase 2 — FOLD shell-wrapper tools into run_command

Each fold removes the tool and relies on the model calling `run_command`. Phase 2 adds ONE prompt instruction (Task 4) so the model knows to use shell for these; subsequent tasks reuse it.

### Task 4: Fold git tools into run_command

**Tools (6):** `git_status`, `git_diff`, `git_log`, `git_commit`, `git_branch`, `git_blame`

**Files:**
- Modify: `agent/tools/agent.ts` (registrations + cases `case "git_status"` … `case "git_blame"`)
- Modify: `tools/index.ts` (impl functions `gitStatus`, `gitDiff`, `gitLog`, `gitCommit`, `gitBranch`, `gitBlame`)
- Modify: `nativeSystemPrompt.ts` (add shell-usage guidance)
- Modify: `session-heuristics.ts`, `tool-filter.ts`, `commands/agents.ts`
- Test: `scripts/verify-tool-surface.ts`

**Interfaces:** tool-name set excludes the 6 git names; `run_command` unchanged.

- [ ] **Step 1: Extend the test (RED)**

```ts
for (const removed of [
  "git_status", "git_diff", "git_log", "git_commit", "git_branch", "git_blame",
]) {
  assert.ok(!names.has(removed), `${removed} must be removed (use run_command)`);
}
assert.ok(names.has("run_command"), "run_command must remain");
```

- [ ] **Step 2: Run test** → FAIL `git_status must be removed (use run_command)`.

- [ ] **Step 3: Delete registrations + dispatch cases** for the 6 git tools.

- [ ] **Step 4: Delete impl functions** `gitStatus`, `gitDiff`, `gitLog`, `gitCommit`, `gitBranch`, `gitBlame` from `tools/index.ts`. (If a shared git helper like `runGit` becomes unused, delete it; if still used by `git_diff` rendering elsewhere, leave it.)

- [ ] **Step 5: Add prompt guidance.** In `nativeSystemPrompt.ts`, in the tools/instructions section, add one bullet (place it near the `run_command` guidance):

```
- For git, package management, builds, tests, linting, and formatting, use `run_command` (e.g. `git status`, `git commit -m "..."`, `npm test`, `npx prettier -w .`). There are no dedicated tools for these.
```

- [ ] **Step 6: Scrub references + grep clean.** Remove the 6 names from heuristics/filter/presets.

Run: `grep -rnE "\bgit_(status|diff|log|commit|branch|blame)\b" packages/coding-agent/src --include='*.ts'`
Expected: no matches.

- [ ] **Step 7: Typecheck + test (GREEN)** — `pnpm run check` → PASS; `pnpm exec tsx scripts/verify-tool-surface.ts` → PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(tools): fold git tools into run_command"
```

### Task 5: Fold package/build/test/lint tools into run_command

**Tools (12):** `package_install`, `package_run_script`, `package_list`, `validate_project`, `dependency_audit`, `run_tests`, `security_scan`, `format_code`, `fix_lint`, `organize_imports`, `analyze_coverage`, `check_syntax`

**Files:**
- Modify: `agent/tools/agent.ts` (registrations + cases for all 12)
- Modify: `tools/index.ts` (impl functions `packageInstall`, `packageRunScript`, `packageList`, `validateProject`, `dependencyAudit`, `runTests`, `securityScan`, `formatCode`, `fixLint`, `organizeImports`, `analyzeCoverage`, `checkSyntax`)
- Modify: `nativeSystemPrompt.ts` (remove `dependency_audit`, `security_scan` mentions — confirmed present), `session-heuristics.ts`, `tool-filter.ts`, `commands/agents.ts`
- Test: `scripts/verify-tool-surface.ts`

**Interfaces:** tool-name set excludes all 12.

- [ ] **Step 1: Extend the test (RED)**

```ts
for (const removed of [
  "package_install", "package_run_script", "package_list", "validate_project",
  "dependency_audit", "run_tests", "security_scan", "format_code", "fix_lint",
  "organize_imports", "analyze_coverage", "check_syntax",
]) {
  assert.ok(!names.has(removed), `${removed} must be removed (use run_command)`);
}
```

- [ ] **Step 2: Run test** → FAIL `package_install must be removed (use run_command)`.

- [ ] **Step 3: Delete registrations + dispatch cases** for all 12 (anchors `case "package_install"` … `case "check_syntax"`).

- [ ] **Step 4: Delete impl functions** (the 12 camelCase names above) from `tools/index.ts`.

- [ ] **Step 5: Scrub references.** Remove `dependency_audit` and `security_scan` from `nativeSystemPrompt.ts`; remove all 12 from heuristics/filter/presets. (The shell-usage prompt bullet from Task 4 already covers these — do not add another.)

Run: `grep -rnE "package_install|package_run_script|package_list|validate_project|dependency_audit|run_tests|security_scan|format_code|fix_lint|organize_imports|analyze_coverage|check_syntax" packages/coding-agent/src --include='*.ts'`
Expected: no matches (camelCase impls also gone).

- [ ] **Step 6: Typecheck + test (GREEN)** — `pnpm run check` → PASS; `pnpm exec tsx scripts/verify-tool-surface.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(tools): fold package/build/test/lint tools into run_command"
```

### Task 6: Fold create_directory + env reads into run_command

**Tools (3):** `create_directory`, `get_env`, `set_env`

**Files:**
- Modify: `agent/tools/agent.ts` (registrations + cases `case "create_directory"`, `case "get_env"`, `case "set_env"`)
- Modify: `tools/index.ts` (impl functions `createDirectory`, `getEnv`, `setEnv`)
- Modify: `session-heuristics.ts` (drop `create_directory`), `tool-filter.ts`, `commands/agents.ts`
- Test: `scripts/verify-tool-surface.ts`

**Interfaces:** tool-name set excludes the 3 names. `delete_file` and `move_file` remain (NOT folded).

- [ ] **Step 1: Extend the test (RED)**

```ts
for (const removed of ["create_directory", "get_env", "set_env"]) {
  assert.ok(!names.has(removed), `${removed} must be removed`);
}
assert.ok(names.has("delete_file"), "delete_file must remain");
assert.ok(names.has("move_file"), "move_file must remain");
```

- [ ] **Step 2: Run test** → FAIL `create_directory must be removed`.

- [ ] **Step 3: Delete registrations + dispatch cases** for the 3 tools.

- [ ] **Step 4: Delete impl functions** `createDirectory`, `getEnv`, `setEnv` from `tools/index.ts`. (Leave `mkdirSync`/fs usage that other tools rely on — only remove the tool-level wrappers.)

- [ ] **Step 5: Scrub references + grep clean.** Remove `create_directory` from `session-heuristics.ts` and the 3 names from filter/presets.

Run: `grep -rnE "\bcreate_directory\b|\bget_env\b|\bset_env\b" packages/coding-agent/src --include='*.ts'`
Expected: no matches.

- [ ] **Step 6: Typecheck + test (GREEN)** — `pnpm run check` → PASS; `pnpm exec tsx scripts/verify-tool-surface.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(tools): fold create_directory and env tools into run_command"
```

---

## Phase 3 — MERGE duplicates and consolidate the plan tools

### Task 7: Merge duplicate read/search/web tools

Collapse `search_text`→`grep`, `read_folder`→`list_files`, `http_request`→`web_fetch`. Each removed tool's capability must survive on the merge target.

**Files:**
- Modify: `agent/tools/agent.ts` (remove `search_text`/`read_folder`/`http_request` registrations + cases; ensure `grep`/`list_files`/`web_fetch` schemas cover the merged params)
- Modify: `tools/index.ts` (ensure `grep`, `listFiles`, `webFetch` accept the superset of options; remove `searchText`, `readFolder`, `httpRequest` if their behavior is fully covered)
- Modify: `nativeSystemPrompt.ts` (replace `search_text` mention with `grep`; remove `read_folder` guidance), `tool-filter.ts` (drop `read_folder`, `search_text`), `session-heuristics.ts` (drop `read_folder`, `search_text`)
- Test: `scripts/verify-tool-surface.ts`

**Interfaces:**
- Consumes: existing `tools.grep(path, pattern, cwd, opts)`, `tools.listFiles(path, cwd)`, `tools.webFetch(url, opts)`, `tools.searchText(...)`, `tools.readFolder(...)`, `tools.httpRequest(url, opts)`.
- Produces: tool-name set has `grep`, `list_files`, `web_fetch` and excludes `search_text`, `read_folder`, `http_request`. `grep` schema gains an optional `includePattern`/`excludePattern` (carried from `search_text`); `list_files` schema gains optional `maxDepth` (carried from `read_folder`); `web_fetch` schema gains optional `method`/`headers`/`body` (carried from `http_request`).

- [ ] **Step 1: Write the failing test (RED)**

Add to `scripts/verify-tool-surface.ts`:

```ts
for (const removed of ["search_text", "read_folder", "http_request"]) {
  assert.ok(!names.has(removed), `${removed} must be merged away`);
}
for (const kept of ["grep", "list_files", "web_fetch"]) {
  assert.ok(names.has(kept), `${kept} must remain as merge target`);
}
// merged params present on the survivors
const byName = new Map(tools.map((t) => [t.name, t]));
const gp = JSON.stringify(byName.get("grep")?.inputSchema ?? {});
assert.ok(gp.includes("excludePattern") || gp.includes("includePattern"),
  "grep must absorb search_text include/exclude params");
const lf = JSON.stringify(byName.get("list_files")?.inputSchema ?? {});
assert.ok(lf.includes("maxDepth"), "list_files must absorb read_folder maxDepth");
const wf = JSON.stringify(byName.get("web_fetch")?.inputSchema ?? {});
assert.ok(wf.includes("method"), "web_fetch must absorb http_request method");
```

- [ ] **Step 2: Run test** → FAIL `search_text must be merged away`.

- [ ] **Step 3: Extend survivor schemas + dispatch.**

In `agent/tools/agent.ts`, on the `grep` registration schema add:
```ts
includePattern: z.string().optional(),
excludePattern: z.string().optional(),
```
On the `list_files` registration schema add:
```ts
maxDepth: z.coerce.number().int().positive().optional(),
```
On the `web_fetch` registration schema add:
```ts
method: z.string().optional(),
headers: z.record(z.string()).optional(),
body: z.string().optional(),
```
Wire these through the existing `grep`/`list_files`/`web_fetch` `callMeerTool` cases into `tools.grep`/`tools.listFiles`/`tools.webFetch`. If `tools.listFiles` does not support depth, route the depth>1 path to the existing `tools.readFolder` implementation internally (keep `readFolder` as a private function, just remove its model-facing tool). Same for `grep` absorbing `searchText` filtering and `webFetch` absorbing `httpRequest` method/body — reuse the existing impl functions internally; only the model-facing tool entries are removed.

- [ ] **Step 4: Remove the merged tools' registrations + cases.**

Delete `search_text`, `read_folder`, `http_request` from `baseToolDefinitions` and their `callMeerTool` cases.

- [ ] **Step 5: Scrub references.** In `nativeSystemPrompt.ts` replace `search_text` with `grep`; remove `read_folder`. Drop `read_folder`/`search_text` from `tool-filter.ts` and `session-heuristics.ts`.

- [ ] **Step 6: Typecheck + test (GREEN)** — `pnpm run check` → PASS; `pnpm exec tsx scripts/verify-tool-surface.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(tools): merge search_text/read_folder/http_request into grep/list_files/web_fetch"
```

### Task 8: Consolidate the 4 plan tools into one `update_plan`

**Tools removed (4):** `set_plan`, `update_plan_task`, `show_plan`, `clear_plan` → replaced by a single `update_plan`.

**Files:**
- Modify: `agent/tools/agent.ts` (remove 4 registrations + cases; add 1 `update_plan` registration + case)
- Modify: `tools/index.ts` (add `updatePlan(...)`; keep the underlying `setPlan`/`updatePlanTask`/`clearPlan` as internal helpers it delegates to)
- Modify: `nativeSystemPrompt.ts` (replace `set_plan`/`update_plan_task` guidance with `update_plan`), `session-heuristics.ts`, `tool-filter.ts`, `commands/agents.ts`
- Test: `scripts/verify-tool-surface.ts`

**Interfaces:**
- Consumes: existing `tools.setPlan(title, tasks, cwd)`, `tools.updatePlanTask(taskId, status, notes)`, `tools.clearPlan()` (kept as internal helpers).
- Produces: a single model tool `update_plan` with schema `{ op: "set" | "update" | "clear", title?: string, tasks?: Array<{description: string}> | string, taskId?: string, status?: "pending"|"in_progress"|"completed"|"skipped", notes?: string }`; dispatch maps `op` to the right helper. tool-name set excludes the 4 old names and includes `update_plan`.

- [ ] **Step 1: Write the failing test (RED)**

```ts
for (const removed of ["set_plan", "update_plan_task", "show_plan", "clear_plan"]) {
  assert.ok(!names.has(removed), `${removed} must be consolidated into update_plan`);
}
assert.ok(names.has("update_plan"), "update_plan must exist");
```

- [ ] **Step 2: Run test** → FAIL `set_plan must be consolidated into update_plan`.

- [ ] **Step 3: Add `updatePlan` impl.** In `tools/index.ts`:

```ts
export function updatePlan(
  input: {
    op?: string;
    title?: string;
    tasks?: unknown;
    taskId?: string;
    status?: string;
    notes?: string;
  },
  cwd: string
): ToolResult {
  const op = String(input.op ?? "set");
  if (op === "clear") return clearPlan();
  if (op === "update") {
    const status = (input.status ?? "pending") as
      "pending" | "in_progress" | "completed" | "skipped";
    return updatePlanTask(String(input.taskId), status,
      typeof input.notes === "string" ? input.notes : undefined);
  }
  // op === "set"
  const tasksInput = input.tasks;
  const tasks = Array.isArray(tasksInput)
    ? tasksInput.map((t) =>
        typeof t === "object" && t !== null && "description" in t
          ? { description: String((t as { description: unknown }).description) }
          : { description: String(t) })
    : typeof tasksInput === "string"
    ? tasksInput.split(",").map((t) => t.trim()).filter(Boolean)
        .map((description) => ({ description }))
    : [];
  return setPlan(String(input.title ?? "Plan"), tasks, cwd);
}
```

(Leave `setPlan`/`updatePlanTask`/`clearPlan` exported — `updatePlan` delegates to them.)

- [ ] **Step 4: Add the `update_plan` tool; remove the 4 old ones.**

In `agent/tools/agent.ts`, add to `baseToolDefinitions`:

```ts
{
  name: "update_plan",
  description:
    "Manage the task plan. op=\"set\" creates/replaces the plan (title + tasks[]); op=\"update\" sets a task's status (taskId + status); op=\"clear\" removes the plan.",
  schema: z.object({
    op: z.enum(["set", "update", "clear"]).default("set"),
    title: z.string().optional(),
    tasks: z.union([
      z.array(z.object({ description: z.string() })),
      z.string(),
    ]).optional(),
    taskId: z.string().optional(),
    status: z.enum(["pending", "in_progress", "completed", "skipped"]).optional(),
    notes: z.string().optional(),
  }),
  execute: (input, context) =>
    callMeerTool("update_plan", input as Record<string, unknown>, context),
},
```

Add the dispatch case:

```ts
case "update_plan": {
  return unwrap(tools.updatePlan(input as Parameters<typeof tools.updatePlan>[0], context.cwd));
}
```

Delete the `set_plan`, `update_plan_task`, `show_plan`, `clear_plan` registrations and their `callMeerTool` cases.

- [ ] **Step 5: Scrub references.** In `nativeSystemPrompt.ts` replace `set_plan`/`update_plan_task` mentions with `update_plan`. Update `tool-filter.ts`/`session-heuristics.ts`/`commands/agents.ts` to use `update_plan` where they listed the old names.

- [ ] **Step 6: Typecheck + test (GREEN)** — `pnpm run check` → PASS; `pnpm exec tsx scripts/verify-tool-surface.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(tools): consolidate 4 plan tools into single update_plan"
```

### Task 9: Fold start_background_command into run_command

**Tool removed (1):** `start_background_command` → `run_command` gains an optional `background` flag.

**Files:**
- Modify: `agent/tools/agent.ts` (remove `start_background_command` registration + case; add `background` to `run_command` schema and wire it)
- Modify: `nativeSystemPrompt.ts` (replace `start_background_command` guidance with `run_command(background:true)`), `session-heuristics.ts`, `tool-filter.ts`, `commands/agents.ts`
- Test: `scripts/verify-tool-surface.ts`

**Interfaces:**
- Consumes: existing `run_command` dispatch and the existing background-command implementation that `start_background_command` used.
- Produces: tool-name set excludes `start_background_command`; `run_command` schema gains `background?: boolean`. When `background` is true, dispatch routes to the same background path the removed tool used.

- [ ] **Step 1: Write the failing test (RED)**

```ts
assert.ok(!names.has("start_background_command"),
  "start_background_command must be folded into run_command");
const rc = JSON.stringify(byName.get("run_command")?.inputSchema ?? {});
assert.ok(rc.includes("background"), "run_command must gain a background flag");
```

(Reuse the `byName` map from Task 7; if executing this task standalone, add `const byName = new Map(tools.map((t) => [t.name, t]));` above.)

- [ ] **Step 2: Run test** → FAIL `start_background_command must be folded into run_command`.

- [ ] **Step 3: Extend `run_command`; remove the old tool.**

On the `run_command` registration schema add `background: z.union([z.boolean(), z.string()]).optional(),`. In the `run_command` `callMeerTool` case, when `input.background` is truthy, call the same implementation `start_background_command`'s case used (locate that case body before deleting it and move its logic into the `background` branch). Then delete the `start_background_command` registration and case.

- [ ] **Step 4: Scrub references.** Replace `start_background_command` guidance in `nativeSystemPrompt.ts` with a note that `run_command` accepts `background: true` for long-running processes. Update filter/heuristics/presets.

Run: `grep -rnE "start_background_command" packages/coding-agent/src --include='*.ts'`
Expected: no matches.

- [ ] **Step 5: Typecheck + test (GREEN)** — `pnpm run check` → PASS; `pnpm exec tsx scripts/verify-tool-surface.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(tools): fold start_background_command into run_command(background)"
```

---

## Out of scope (separate design-required follow-on)

These ADD capabilities from the audit are NOT in this plan because they change the agent loop / provider contract and need their own design pass. The cull above reduces the urgency of `tool_search` (68→~24 roughly halves the tool-schema payload), so it is no longer a prerequisite:

- **`tool_search` / dynamic tool discovery** — needs the agent loop to expand the toolset mid-conversation; design separately.
- **Interactive shell (stdin to running process)** — extends `run_command`/background with a stdin channel.
- **OS sandbox + `request_permissions`** — execution-boundary work (subprocess sandbox per platform).
- **`get_context_remaining`, `view_image`** — context-budget query and multimodal input.

---

## Self-Review

**1. Spec coverage (against the audit `docs/tool-audit-2026-06-24.md`):**
- Section F (heuristic REMOVE, 10) → Task 1. ✅
- Section G (AST REVIEW→REMOVE, 6) → Task 2. ✅
- Section K + J `list_env` (bootstrap/misc REMOVE) → Task 3; `show_plan` REMOVE → Task 8 (plan consolidation). ✅
- Section D (git FOLD, 6) → Task 4. ✅
- Section E (package/build/test/lint FOLD, 12) → Task 5. ✅
- Section J `create_directory`/`get_env`/`set_env` FOLD → Task 6; `delete_file`/`move_file` KEEP asserted in Task 6. ✅
- Section B merges (`read_folder`,`search_text`,`http_request`) → Task 7; `start_background_command`→`run_command` → Task 9. ✅
- Section C (plan 4→1) → Task 8. ✅
- ADD capabilities → explicitly deferred with rationale. ✅
- KEEP set (read_file, edit_file, propose_edit, semantic_search, code-intel, memory, web, request_user_input) → never touched; protected by Global Constraints. ✅

**2. Placeholder scan:** No TBD/"handle edge cases"/"similar to Task N". Removal tasks list exact tool names, exact case/function anchors, exact grep commands, and exact test code. Merge tasks (7-9) show the full schema additions and the `updatePlan` body. ✅

**3. Type consistency:**
- `createMeerAgentTools(context, options): AgentTool[]`, each with `.name` and `.inputSchema` — used consistently in every test (`names = new Set(tools.map(t => t.name))`, `byName` for schema checks). ✅
- `updatePlan(input, cwd)` defined in Task 8 Step 3, called in Task 8 Step 4 with the same signature. ✅
- `update_plan` schema fields (`op`, `title`, `tasks`, `taskId`, `status`, `notes`) match between the registration (Step 4) and the `updatePlan` impl (Step 3). ✅
- `byName` map introduced in Task 7 Step 1 and reused in Task 9 Step 1 (with a standalone fallback noted). ✅

**Risk note for the implementer:** every removal's real safety gate is `pnpm run check` — if `tsc` passes after deleting a function, nothing live used it. Run the grep-clean command in each task; if a removed name still appears in a `docs/` or README prose file, that is out of scope (update only if trivial). Tasks 7-9 are the only ones that change surviving tools' behavior — review those diffs most carefully.
