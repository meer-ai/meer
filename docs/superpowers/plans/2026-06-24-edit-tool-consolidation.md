# Edit Tool Consolidation (Options A + C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink Meer's model-facing file-mutation surface from four overlapping tools (`edit_file`, `propose_edit`, `write_file`, `edit_line`) down to two (`edit_file` for targeted edits, `propose_edit` for full-file create/overwrite), and close the concurrent-write corruption gap by routing all edits through a per-file mutation queue ported from pi.

**Architecture:** Meer's edit *engine* (`packages/coding-agent/src/tools/edit-engine.ts`) is already a pi-grade port (fuzzy match, duplicate/overlap/no-op guards, BOM + CRLF preservation). The redundancy is purely at the model-facing tool surface defined in `packages/coding-agent/src/agent/tools/agent.ts` (`baseToolDefinitions` array + the `callMeerTool` dispatch switch). We (A) delete the two weakest/redundant tools (`edit_line`, `write_file`) and scrub their references from prompts, heuristics, tool-filters, and agent presets; and (C) port pi's `withFileMutationQueue` and wrap the read→compute→write region of the surviving edit dispatch cases so concurrent edits to the same file serialize (different files still run in parallel).

**Tech Stack:** TypeScript (ESM, NodeNext), Zod schemas, pnpm workspaces. Tests are standalone `scripts/verify-*.ts` files run with `tsx` (no vitest/jest); discovered by glob and executed by `scripts/run-verifications.mjs` via `pnpm test`. Each verify script uses `node:assert/strict`, imports from `@meer-ai/*` workspace deep paths (e.g. `@meer-ai/coding-agent/tools/index.js`), and prints a `... passed` line on success / throws on failure.

## Global Constraints

- Language: TypeScript, ESM only. All intra-package imports use `.js` extensions (NodeNext resolution). Cross-package imports use `@meer-ai/<pkg>/<path>.js`.
- Tests are `scripts/verify-<name>.ts`. A test "fails" by throwing / `assert` rejection (non-zero exit). It "passes" by reaching a final `console.log("... passed")`. There is NO `describe`/`it` harness — top-level `await` + `assert`.
- Run a single test with: `pnpm exec tsx scripts/verify-<name>.ts`.
- Run the whole suite with: `pnpm test` (alias for `node scripts/run-verifications.mjs`); filter with `pnpm test <substr>`.
- Typecheck the monorepo with: `pnpm run check` (`tsc -p tsconfig.json --noEmit`).
- The canonical surviving tools are exactly: `edit_file` (targeted replacements) and `propose_edit` (full-file create/overwrite). Do NOT rename them.
- **Non-goal (YAGNI):** pi's `EditOperations` (pluggable local/SSH file IO) abstraction is explicitly OUT of scope — Meer has no remote-editing consumer. Only the mutation queue is ported from pi.
- Keep `delete_file` and `move_file` exactly as they are; they are not part of this consolidation.

---

## File Structure

- `packages/coding-agent/src/tools/file-mutation-queue.ts` — **new**. Per-absolute-path async mutation lock. Ported verbatim from pi (`packages/coding-agent/src/core/tools/file-mutation-queue.ts` in the pi repo). Single responsibility: serialize mutations targeting the same file.
- `packages/coding-agent/src/agent/tools/agent.ts` — **modify**. Remove `edit_line` and `write_file` from `baseToolDefinitions` and the `callMeerTool` switch; wrap the `edit_file` and `propose_edit` dispatch bodies in `withFileMutationQueue`.
- `packages/coding-agent/src/tools/index.ts` — **modify**. Remove the now-unused `editLine` export (only caller is the deleted dispatch case).
- `packages/coding-agent/src/agent/session-heuristics.ts` — **modify**. Drop `edit_line` and `write_file` from the mutating-tool-name list.
- `packages/coding-agent/src/agents/tool-filter.ts` — **modify**. Drop `edit_line` and `write_file` from the allow lists.
- `packages/coding-agent/src/commands/agents.ts` — **modify**. Drop `edit_line` from the `Edit` preset.
- `packages/coding-agent/src/agent/prompts/{agentSystemPrompt,nativeSystemPrompt,systemPrompt,systemPrompt.optimized,systemPrompt.ts}` — **modify**. Remove `edit_line`/`write_file` mentions; point line-edit guidance at `edit_file`.
- `packages/coding-agent/src/agent/meer-agent.ts` — **modify** (one prompt string at line ~194 listing mutating commands).
- `scripts/verify-file-mutation-queue.ts` — **new** test.
- `scripts/verify-edit-dispatch-concurrency.ts` — **new** test.
- `scripts/verify-tool-surface.ts` — **new** test (asserts the consolidated tool name set).

---

## Task 1: Port pi's per-file mutation queue

**Files:**
- Create: `packages/coding-agent/src/tools/file-mutation-queue.ts`
- Test: `scripts/verify-file-mutation-queue.ts`

**Interfaces:**
- Consumes: nothing (leaf module; only `node:fs/promises` + `node:path`).
- Produces: `export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T>` — runs `fn` with an exclusive lock keyed on the file's `realpath` (falling back to the resolved path if the file does not exist yet). Calls for different files run concurrently; calls for the same file serialize in registration order.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-file-mutation-queue.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "@meer-ai/coding-agent/tools/file-mutation-queue.js";

const dir = mkdtempSync(join(tmpdir(), "meer-mutq-"));
const file = join(dir, "counter.txt");
writeFileSync(file, "0\n", "utf-8");

// Two concurrent read-modify-write operations on the SAME file.
// Each reads the current line count and appends one line. Without
// serialization they race on the stale read and one append is lost.
async function appendLine(tag: string): Promise<void> {
  await withFileMutationQueue(file, async () => {
    const current = readFileSync(file, "utf-8");
    // Yield to the event loop to widen the race window.
    await new Promise((r) => setTimeout(r, 5));
    writeFileSync(file, current + tag + "\n", "utf-8");
  });
}

await Promise.all([appendLine("a"), appendLine("b"), appendLine("c")]);

const lines = readFileSync(file, "utf-8").trim().split("\n");
// Original "0" plus three appends, none lost.
assert.equal(lines.length, 4, `expected 4 lines, got ${lines.length}: ${JSON.stringify(lines)}`);
assert.deepEqual(new Set(lines.slice(1)), new Set(["a", "b", "c"]));

// Different files run concurrently (no deadlock / no cross-file blocking).
const fileX = join(dir, "x.txt");
const fileY = join(dir, "y.txt");
let yStarted = false;
const xPromise = withFileMutationQueue(fileX, async () => {
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(yStarted, true, "different-file op should not be blocked by another file's lock");
});
const yPromise = withFileMutationQueue(fileY, async () => {
  yStarted = true;
});
await Promise.all([xPromise, yPromise]);

console.log("file-mutation-queue verification passed");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx scripts/verify-file-mutation-queue.ts`
Expected: FAIL — module resolution error for `@meer-ai/coding-agent/tools/file-mutation-queue.js` (file does not exist yet).

- [ ] **Step 3: Create the queue module**

Create `packages/coding-agent/src/tools/file-mutation-queue.ts` (ported from pi):

```ts
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

const fileMutationQueues = new Map<string, Promise<void>>();
let registrationQueue = Promise.resolve();

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" ||
      (error as { code?: unknown }).code === "ENOTDIR")
  );
}

async function getMutationQueueKey(filePath: string): Promise<string> {
  const resolvedPath = resolve(filePath);
  try {
    return await realpath(resolvedPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return resolvedPath;
    }
    throw error;
  }
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 *
 * Ported from the pi coding agent (MIT). `filePath` should be absolute;
 * callers in dispatch resolve against the tool context cwd before calling.
 */
export async function withFileMutationQueue<T>(
  filePath: string,
  fn: () => Promise<T>
): Promise<T> {
  const registration = registrationQueue.then(async () => {
    const key = await getMutationQueueKey(filePath);
    const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

    let releaseNext!: () => void;
    const nextQueue = new Promise<void>((resolveQueue) => {
      releaseNext = resolveQueue;
    });
    const chainedQueue = currentQueue.then(() => nextQueue);
    fileMutationQueues.set(key, chainedQueue);

    return { key, currentQueue, chainedQueue, releaseNext };
  });
  registrationQueue = registration.then(
    () => undefined,
    () => undefined
  );

  const { key, currentQueue, chainedQueue, releaseNext } = await registration;
  await currentQueue;
  try {
    return await fn();
  } finally {
    releaseNext();
    if (fileMutationQueues.get(key) === chainedQueue) {
      fileMutationQueues.delete(key);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx scripts/verify-file-mutation-queue.ts`
Expected: PASS — prints `file-mutation-queue verification passed`.

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/tools/file-mutation-queue.ts scripts/verify-file-mutation-queue.ts
git commit -m "feat(tools): port per-file mutation queue from pi"
```

---

## Task 2: Route edit dispatch through the mutation queue

**Files:**
- Modify: `packages/coding-agent/src/agent/tools/agent.ts` (`callMeerTool` cases `edit_file` ~432-440 and `propose_edit` ~419-431; add `resolve` import)
- Test: `scripts/verify-edit-dispatch-concurrency.ts`

**Interfaces:**
- Consumes: `withFileMutationQueue` from Task 1; existing `tools.editFileSections`, `tools.proposeEdit`, `tools.applyEdit`, `ensureEditApproval`, `unwrapStructured`, `normalizeEditFileEdits`.
- Produces: no new exports; the `edit_file` and `propose_edit` dispatch cases now perform their read→compute→approve→write region inside `withFileMutationQueue(resolve(context.cwd, path), ...)`.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-edit-dispatch-concurrency.ts`. This tests the exact composition the dispatch uses (`editFileSections` to read+compute, then `applyEdit` to write) under concurrency, proving the queue prevents a lost update:

```ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editFileSections, applyEdit } from "@meer-ai/coding-agent/tools/index.js";
import { withFileMutationQueue } from "@meer-ai/coding-agent/tools/file-mutation-queue.js";

const dir = mkdtempSync(join(tmpdir(), "meer-editdisp-"));
const file = join(dir, "src.txt");
writeFileSync(file, "line-one\nline-two\n", "utf-8");

// Two disjoint edits issued concurrently, each computed against current
// disk content then written — mirroring the dispatch read→compute→write.
async function runEdit(oldText: string, newText: string): Promise<void> {
  await withFileMutationQueue(file, async () => {
    const edit = editFileSections(file, [{ oldText, newText }], dir);
    if (edit.error) throw new Error(edit.error);
    await new Promise((r) => setTimeout(r, 5)); // widen race window
    const res = applyEdit(edit, dir);
    if (res.error) throw new Error(res.error);
  });
}

await Promise.all([
  runEdit("line-one", "LINE-ONE"),
  runEdit("line-two", "LINE-TWO"),
]);

const out = readFileSync(file, "utf-8");
assert.equal(out, "LINE-ONE\nLINE-TWO\n", `lost update: ${JSON.stringify(out)}`);

console.log("edit dispatch concurrency verification passed");
```

Note: `editFileSections` reads file content relative to the cwd arg; pass `dir` as cwd and an absolute `file` path (Meer's `resolvePath` returns the absolute path unchanged).

- [ ] **Step 2: Run test to verify it fails or is flaky**

Run: `pnpm exec tsx scripts/verify-edit-dispatch-concurrency.ts`
Expected: This test passes once the queue exists (Task 1 is done), but its purpose is to **lock in** the queued composition. If `editFileSections`/`applyEdit` are not exported from `tools/index.js`, it fails with an import error — in that case add the missing `export` keyword to those functions in `packages/coding-agent/src/tools/index.ts` (they are declared `export function` already per the registry; confirm and re-run).

- [ ] **Step 3: Wire the dispatch cases through the queue**

In `packages/coding-agent/src/agent/tools/agent.ts`, add the import near the other `node:` imports at the top of the file:

```ts
import { resolve } from "node:path";
import { withFileMutationQueue } from "../../tools/file-mutation-queue.js";
```

Replace the `edit_file` case body (currently ~lines 432-440):

```ts
    case "edit_file": {
      const path = String(input.path);
      return withFileMutationQueue(resolve(context.cwd, path), async () => {
        const edits = normalizeEditFileEdits(input);
        const edit = tools.editFileSections(path, edits, context.cwd);
        if (!(await ensureEditApproval(context, edit))) {
          return `⏭️ Edit skipped for ${edit.path}`;
        }
        return unwrapStructured(tools.applyEdit(edit, context.cwd));
      });
    }
```

Replace the `propose_edit` case body (currently ~lines 419-431):

```ts
    case "propose_edit": {
      const path = String(input.path);
      const contents = String(input.contents ?? input.content ?? "");
      const description =
        typeof input.description === "string" ? input.description : "Edit file";
      return withFileMutationQueue(resolve(context.cwd, path), async () => {
        const edit = tools.proposeEdit(path, contents, description, context.cwd);
        if (!(await ensureEditApproval(context, edit))) {
          return `⏭️ Edit skipped for ${edit.path}`;
        }
        return unwrapStructured(tools.applyEdit(edit, context.cwd));
      });
    }
```

- [ ] **Step 4: Typecheck and run the test**

Run: `pnpm run check`
Expected: PASS (no type errors).

Run: `pnpm exec tsx scripts/verify-edit-dispatch-concurrency.ts`
Expected: PASS — prints `edit dispatch concurrency verification passed`.

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/agent/tools/agent.ts scripts/verify-edit-dispatch-concurrency.ts
git commit -m "feat(tools): serialize edit_file/propose_edit writes via mutation queue"
```

---

## Task 3: Remove `edit_line` from the model surface

**Files:**
- Modify: `packages/coding-agent/src/agent/tools/agent.ts` (registration ~1400-1411; dispatch case ~723-740)
- Modify: `packages/coding-agent/src/tools/index.ts` (remove unused `editLine`, ~line 1972)
- Modify: `packages/coding-agent/src/agent/session-heuristics.ts:106`
- Modify: `packages/coding-agent/src/agents/tool-filter.ts:24,61`
- Modify: `packages/coding-agent/src/commands/agents.ts:222`
- Modify: prompts: `agentSystemPrompt.ts:33,52`, `systemPrompt.ts:74,153`, `systemPrompt.optimized.ts:70,71,148`, `meer-agent.ts:194`
- Test: `scripts/verify-tool-surface.ts`

**Interfaces:**
- Consumes: `createMeerAgentTools(context, options)` from `agent/tools/agent.ts` (returns `AgentTool[]`, each with a `.name`).
- Produces: the tool set returned by `createMeerAgentTools` no longer contains `edit_line`.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-tool-surface.ts`:

```ts
import assert from "node:assert/strict";
import { createMeerAgentTools } from "@meer-ai/coding-agent/agent/tools/agent.js";

const tools = createMeerAgentTools({ cwd: process.cwd() } as never);
const names = new Set(tools.map((t) => t.name));

// Consolidated surface: the two survivors remain...
assert.ok(names.has("edit_file"), "edit_file must remain");
assert.ok(names.has("propose_edit"), "propose_edit must remain");
// ...and the removed tools are gone.
assert.ok(!names.has("edit_line"), "edit_line must be removed");

console.log("tool surface verification passed");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx scripts/verify-tool-surface.ts`
Expected: FAIL — assertion `edit_line must be removed` throws (the tool is still registered).

- [ ] **Step 3: Remove the registration and dispatch**

In `packages/coding-agent/src/agent/tools/agent.ts`:
- Delete the entire `edit_line` object literal from `baseToolDefinitions` (the block starting `name: "edit_line",` at ~line 1400 through its closing `},` at ~1411).
- Delete the entire `case "edit_line": { ... }` block from `callMeerTool` (~lines 723-740).

In `packages/coding-agent/src/tools/index.ts`:
- Delete the now-unused `export function editLine(...)` (starts ~line 1972) and its doc comment. (Its only caller was the dispatch case just removed.)

- [ ] **Step 4: Scrub `edit_line` references**

- `packages/coding-agent/src/agent/session-heuristics.ts:106` — remove the `"edit_line"` string from the array literal.
- `packages/coding-agent/src/agents/tool-filter.ts` — remove the `'edit_line'` entries (lines ~24 and ~61).
- `packages/coding-agent/src/commands/agents.ts:222` — remove `'edit_line'` from the `Edit:` preset array (leave `'propose_edit'`).
- `packages/coding-agent/src/agent/meer-agent.ts:194` — in the mutating-commands prompt string, delete `edit_line, ` (keep the rest of the list well-formed).
- `packages/coding-agent/src/agent/prompts/agentSystemPrompt.ts:33` — remove `` `edit_line`, `` from the PLAN-mode forbidden list.
- `packages/coding-agent/src/agent/prompts/agentSystemPrompt.ts:52` — rewrite the sentence to: `"For file edits, use `edit_file` for targeted changes and `propose_edit` for new files or full-file rewrites. Always provide complete file contents—no ellipses or placeholders."`
- `packages/coding-agent/src/agent/prompts/systemPrompt.ts:74` — delete the `edit_line ...` tool-list bullet.
- `packages/coding-agent/src/agent/prompts/systemPrompt.ts:153` — replace `Use grep + edit_line for large files (>100 lines)` with `Use edit_file with surrounding context for targeted changes in large files`.
- `packages/coding-agent/src/agent/prompts/systemPrompt.optimized.ts:70,71` — delete the `grep ... (use before edit_line)` note and the `edit_line ...` numbered tool entry.
- `packages/coding-agent/src/agent/prompts/systemPrompt.optimized.ts:148` — replace `Line-specific edits: Use grep → edit_line` with `Targeted edits: Use edit_file with unique surrounding context`.

- [ ] **Step 5: Typecheck and run the test**

Run: `pnpm run check`
Expected: PASS (no references to the deleted `editLine`/`edit_line` remain; if `tsc` reports an unused/missing symbol, fix the offending reference).

Run: `pnpm exec tsx scripts/verify-tool-surface.ts`
Expected: PASS — prints `tool surface verification passed`.

- [ ] **Step 6: Commit**

```bash
git add packages/coding-agent/src/agent/tools/agent.ts packages/coding-agent/src/tools/index.ts packages/coding-agent/src/agent/session-heuristics.ts packages/coding-agent/src/agents/tool-filter.ts packages/coding-agent/src/commands/agents.ts packages/coding-agent/src/agent/meer-agent.ts packages/coding-agent/src/agent/prompts/agentSystemPrompt.ts packages/coding-agent/src/agent/prompts/systemPrompt.ts packages/coding-agent/src/agent/prompts/systemPrompt.optimized.ts scripts/verify-tool-surface.ts
git commit -m "refactor(tools): remove redundant edit_line tool"
```

---

## Task 4: Collapse `write_file` into `propose_edit`

**Files:**
- Modify: `packages/coding-agent/src/agent/tools/agent.ts` (registration ~1467-1475; dispatch case `write_file` ~785-800)
- Modify: `packages/coding-agent/src/agent/session-heuristics.ts:106`
- Modify: `packages/coding-agent/src/agents/tool-filter.ts` (`write_file` entries)
- Modify: prompts: `meer-agent.ts:194`, `agentSystemPrompt.ts:33,52`, `nativeSystemPrompt.ts` (if it lists `write_file`), `systemPrompt.ts:20,72`, `systemPrompt.optimized.ts:25,53`
- Test: extend `scripts/verify-tool-surface.ts`

**Rationale:** the `write_file` and `propose_edit` dispatch cases are byte-for-byte equivalent (both call `tools.proposeEdit` → `applyEdit`). `propose_edit` has far more references and is the approval/diff-preview path, so `propose_edit` is kept as the single full-file create/overwrite tool and `write_file` is removed.

**Interfaces:**
- Consumes: same `createMeerAgentTools` surface as Task 3.
- Produces: the tool set no longer contains `write_file`; `propose_edit` remains the canonical full-file writer.

- [ ] **Step 1: Extend the test (make it fail again)**

In `scripts/verify-tool-surface.ts`, add before the final `console.log`:

```ts
assert.ok(!names.has("write_file"), "write_file must be removed (use propose_edit)");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx scripts/verify-tool-surface.ts`
Expected: FAIL — assertion `write_file must be removed` throws.

- [ ] **Step 3: Remove `write_file` registration and dispatch**

In `packages/coding-agent/src/agent/tools/agent.ts`:
- Delete the `write_file` object literal from `baseToolDefinitions` (block at ~lines 1467-1475).
- Delete the `case "write_file": { ... }` block from `callMeerTool` (~lines 785-800).

- [ ] **Step 4: Scrub `write_file` references**

- `packages/coding-agent/src/agent/session-heuristics.ts:106` — remove `"write_file"` from the array.
- `packages/coding-agent/src/agents/tool-filter.ts` — remove `'write_file'` entries.
- `packages/coding-agent/src/agent/meer-agent.ts:194` — remove `write_file, ` from the mutating-commands list.
- `packages/coding-agent/src/agent/prompts/agentSystemPrompt.ts:33` — remove `` `write_file`, `` from the forbidden list (line 52 was already rewritten in Task 3 — confirm it no longer mentions `write_file`).
- `packages/coding-agent/src/agent/prompts/nativeSystemPrompt.ts` — if a `write_file` line exists, change it to reference `propose_edit`.
- `packages/coding-agent/src/agent/prompts/systemPrompt.ts:20` — change `NEVER batch multiple propose_edit/write_file in one response` to `NEVER batch multiple propose_edit calls in one response`.
- `packages/coding-agent/src/agent/prompts/systemPrompt.ts:72` — confirm the `propose_edit` bullet stands alone; delete any separate `write_file` bullet.
- `packages/coding-agent/src/agent/prompts/systemPrompt.optimized.ts:25` — change `Batching multiple propose_edit/write_file calls` to `Batching multiple propose_edit calls`.
- `packages/coding-agent/src/agent/prompts/systemPrompt.optimized.ts:53` — change `For content-bearing tools (propose_edit, write_file)` to `For the content-bearing tool (propose_edit)`.

- [ ] **Step 5: Typecheck and run tests**

Run: `pnpm run check`
Expected: PASS.

Run: `pnpm exec tsx scripts/verify-tool-surface.ts`
Expected: PASS — prints `tool surface verification passed`.

- [ ] **Step 6: Run the full suite**

Run: `pnpm test`
Expected: PASS — all `verify-*.ts` scripts green, including the three added here.

- [ ] **Step 7: Commit**

```bash
git add packages/coding-agent/src/agent/tools/agent.ts packages/coding-agent/src/agent/session-heuristics.ts packages/coding-agent/src/agents/tool-filter.ts packages/coding-agent/src/agent/meer-agent.ts packages/coding-agent/src/agent/prompts/agentSystemPrompt.ts packages/coding-agent/src/agent/prompts/nativeSystemPrompt.ts packages/coding-agent/src/agent/prompts/systemPrompt.ts packages/coding-agent/src/agent/prompts/systemPrompt.optimized.ts scripts/verify-tool-surface.ts
git commit -m "refactor(tools): collapse write_file into propose_edit"
```

---

## Self-Review

**1. Spec coverage:**
- Option A — remove `edit_line`: Task 3. ✅
- Option A — unify the two full-file writers: Task 4 (keep `propose_edit`, remove `write_file`). ✅
- Option C — port `withFileMutationQueue`: Task 1. ✅
- Option C — wire edits through the queue: Task 2. ✅
- Option C — `EditOperations`/SSH seam: explicitly declared a non-goal (YAGNI) in Global Constraints. ✅
- Net model-facing mutation surface ends at `edit_file` + `propose_edit` (+ untouched `delete_file`/`move_file`), matching pi's two-mutation model. ✅

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Every code step shows full code; every reference scrub names an exact `file:line` and the concrete replacement text. ✅

**3. Type consistency:**
- `withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T>` — defined in Task 1, consumed identically in Task 2 (`withFileMutationQueue(resolve(context.cwd, path), async () => ...)`). ✅
- `createMeerAgentTools(context, options): AgentTool[]` with `.name` per tool — used consistently in Tasks 3 & 4 test. ✅
- `editFileSections(path, edits, cwd)` / `applyEdit(edit, cwd)` / `proposeEdit(path, contents, description, cwd)` — signatures match the existing dispatch usage carried into the queued bodies. ✅
- `edit.error` / `res.error` fields used in the Task 2 test match `ToolResult`'s `error?: string`. ✅

**Risk note for the implementer:** line numbers in this plan are from the snapshot at planning time. If a removal target has shifted, locate it by the quoted anchor text (e.g. `name: "edit_line",`) rather than the line number. After Tasks 3-4, grep the repo for `edit_line` and `write_file` to confirm no stray references survive in prompts, presets, or docs (`docs/AGENTS_GUIDE.md` and README may mention them — update prose mentions if found, but they are not load-bearing).
