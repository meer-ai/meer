/**
 * Locks the edit-tool's pre-apply validator (`@meer-ai/coding-agent/lsp/diagnostics`)
 * to SYNTAX-ONLY behavior.
 *
 * Regression: the validator used to also run TypeScript SEMANTIC diagnostics on
 * a virtual single-file program. That can't resolve project-wide types — a
 * missing `@types/react` surfaces as TS7016 ("Could not find a declaration file
 * for module 'react'") — and it flags PRE-EXISTING errors unrelated to the
 * edit, so it blocked perfectly valid edits. The edit gate must only reject
 * changes that introduce a true PARSE error; type-checking is the user's build's
 * job.
 */

import assert from "node:assert/strict";
import { validateSyntax } from "@meer-ai/coding-agent/lsp/diagnostics.js";

// ── Valid TSX with an unresolved import must PASS (no false TS7016) ───────────
{
  const tsx =
    `import React from "react";\n\n` +
    `export function App(): React.ReactElement {\n` +
    `  return <div className="x">hi</div>;\n` +
    `}\n`;
  // cwd is the meer repo, which HAS a tsconfig.json — the old code path would
  // have run semantic diagnostics here and flagged the unresolved "react".
  const result = validateSyntax("App.tsx", tsx, process.cwd());
  assert.equal(result.valid, true, "valid TSX with unresolved import passes (no false TS7016)");
  assert.deepEqual(result.errors, [], "type-resolution issues are not reported as errors");
}

// ── A genuine syntax error is still REJECTED ─────────────────────────────────
{
  const broken = `export function f() {\n  const x = ;\n}\n`;
  const result = validateSyntax("broken.ts", broken, process.cwd());
  assert.equal(result.valid, false, "a true syntax error is rejected");
  assert.ok(result.errors.length > 0, "reports at least one parse error");
}

// ── Non-code files are not validated ─────────────────────────────────────────
{
  const result = validateSyntax("notes.md", "# heading {", process.cwd());
  assert.equal(result.valid, true, "non-code files pass through");
}

console.log("syntax-validation verification passed");
