/**
 * Verifies the @-picker file finder (findFilesFuzzy). Runs against the meer
 * repo itself, so it exercises whichever backend is present — fd if installed,
 * otherwise the pure-JS walk. Either way the @ picker must return matches
 * (the bug being fixed: it returned nothing because fd was never wired up).
 */

import assert from "node:assert/strict";
import { findFilesFuzzy, isFdAvailable } from "../src/utils/file-finder.js";

const repoRoot = process.cwd();

// 1. A file we know exists is found by name.
{
  const results = await findFilesFuzzy({ basePath: repoRoot, query: "config" });
  assert.ok(results.length > 0, "fuzzy query 'config' returns results");
  assert.ok(
    results.some((r) => r.path.toLowerCase().includes("config")),
    "results actually contain a 'config' path"
  );
}

// 2. An exact filename resolves.
{
  const results = await findFilesFuzzy({ basePath: repoRoot, query: "package.json" });
  assert.ok(
    results.some((r) => r.path.endsWith("package.json")),
    "package.json is findable"
  );
}

// 3. Ignored directories (node_modules) never leak into results.
{
  const results = await findFilesFuzzy({ basePath: repoRoot, query: "" , maxResults: 500 });
  assert.ok(results.length > 0, "empty query returns a directory listing");
  assert.ok(
    !results.some((r) => r.path.split("/").includes("node_modules")),
    "node_modules is excluded from results"
  );
}

// 4. Directory entries carry a trailing slash (the autocomplete layer relies on it).
{
  const results = await findFilesFuzzy({ basePath: repoRoot, query: "src", maxResults: 200 });
  const dirHit = results.find((r) => r.isDirectory);
  if (dirHit) {
    assert.ok(dirHit.path.endsWith("/"), "directory results end with '/'");
  }
}

// 5. An aborted signal yields no work.
{
  const ac = new AbortController();
  ac.abort();
  const results = await findFilesFuzzy({ basePath: repoRoot, query: "config", signal: ac.signal });
  assert.equal(results.length, 0, "aborted search returns nothing");
}

console.log(`file-finder verification passed (fd ${isFdAvailable() ? "available" : "absent — JS fallback exercised"})`);
