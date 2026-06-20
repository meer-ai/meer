/**
 * Regression test for the "Enter does nothing after pasting a file path" bug.
 *
 * Repro: paste an image into the composer on macOS. macOS pastes the
 * temp-file path, which starts with `/var/folders/...`. The old code
 * treated anything starting with `/` as a slash command, routed it into
 * the slash executor, and silently failed — making Enter look broken.
 *
 * Fix: `isSlashCommandInput` requires the first token to look like a
 * real command identifier (letters/digits/dashes after `/`, then EOL or
 * whitespace) before routing to slash handling.
 */

import { isSlashCommandInput } from "@meer/coding-agent/slash/utils.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// --- Real slash commands ---------------------------------------------------
for (const input of [
  "/help",
  "/ask what is up",
  "/code-review",
  "/code-review ultra",
  "/mcp ls",
  "/screen-reader",
  "/version",
  "/v",
  "  /help  ", // leading whitespace is allowed
]) {
  assert(isSlashCommandInput(input), `should detect "${input}" as slash command`);
}

// --- File paths (the bug class) -------------------------------------------
for (const input of [
  "/var/folders/qt/nrkmdkj/T/TemporaryItems/Screenshot.png",
  "/var/folders/qt/T/foo bar.png",                  // path with literal space
  "/Users/moesaif/Code/ccsandbox/meer/src/index.ts",
  "/etc/passwd",
  "/usr/local/bin/node",
  "/tmp/test.log",
  "/.hidden",
  "/123-numeric-start",                              // starts with digit
  "/-leading-dash",                                  // starts with dash
  "/",                                               // bare slash (suggestion popup handles this case separately)
  "//comment",
  "/?query",
]) {
  assert(
    !isSlashCommandInput(input),
    `should NOT route "${input}" to slash executor`
  );
}

// --- Non-slash inputs ------------------------------------------------------
for (const input of [
  "what is the status",
  "hello world",
  "",
  "  ",
  "look at /foo/bar in the codebase", // slash in middle, not a command
]) {
  assert(
    !isSlashCommandInput(input),
    `non-slash input "${input}" must not be detected as slash`
  );
}

console.log("slash detection verification passed");
