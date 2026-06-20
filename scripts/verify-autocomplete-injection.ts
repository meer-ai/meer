/**
 * Verifies the @-picker's file-finder is a clean injection seam.
 *
 * The tui package no longer imports a concrete file finder; the host passes one
 * into CombinedAutocompleteProvider. This guards both halves of that contract:
 * with a finder the @ picker returns file suggestions, without one it degrades
 * to no file suggestions instead of throwing. (See docs/ARCHITECTURE.md — this
 * decoupling is what lets @meer/tui be extracted as a standalone package.)
 */

import assert from "node:assert/strict";
import { CombinedAutocompleteProvider } from "@meer/tui/autocomplete.js";
import { findFilesFuzzy } from "@meer/coding-agent/utils/file-finder.js";

const repoRoot = process.cwd();

async function atSuggestionCount(provider: CombinedAutocompleteProvider, line: string): Promise<number> {
  const ac = new AbortController();
  const result = await provider.getSuggestions([line], 0, line.length, { signal: ac.signal });
  return result?.items.length ?? 0;
}

// ── With an injected finder, @ yields file suggestions ───────────────────────
{
  const provider = new CombinedAutocompleteProvider([], repoRoot, null, findFilesFuzzy);
  const count = await atSuggestionCount(provider, "@config");
  assert.ok(count > 0, "an injected file finder makes the @ picker return suggestions");
}

// ── Without a finder, @ degrades gracefully to no suggestions ────────────────
{
  const provider = new CombinedAutocompleteProvider([], repoRoot, null, null);
  const count = await atSuggestionCount(provider, "@config");
  assert.equal(count, 0, "no finder → no file suggestions, no throw");
}

console.log("autocomplete-injection verification passed");
