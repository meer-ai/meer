/**
 * Parse leading `cd` prefixes out of a shell command so the agent's
 * directory state survives across `run_command` invocations.
 *
 * Each tool call spawns a fresh shell, so a bare `cd src/foo` in one call
 * and `npm test` in the next would land in two different cwds. Pi's full
 * fix is a persistent bash backend; this is the light version — we peel
 * `cd …` off the front of the command, update an in-memory shellCwd,
 * and run only the tail.
 *
 * Handles:
 *   - `cd /abs/path`                         (bare cd; nothing else to run)
 *   - `cd relative`                          (resolved against current cwd)
 *   - `cd ~/foo`, `cd ~`                     (home expansion)
 *   - `cd /a && cd /b && cmd …`             (chained leading cd's)
 *   - `cd /a ; cmd …`                        (semicolon separator)
 *   - `cd /a; cmd …`                         (no whitespace before ;)
 *
 * Deliberately does NOT handle:
 *   - `cd -`                                 (no $OLDPWD tracking)
 *   - `pushd`/`popd`                         (no stack)
 *   - `cmd && cd /x`                         (only LEADING cd's count;
 *                                             keeping the parse predictable)
 *   - `cd "path with spaces"`                (quoted paths) — caller can
 *                                             still escape spaces with `\ `
 *                                             which we tolerate via the
 *                                             leading-token regex below.
 *
 * Returns `{ newCwd, remainingCommand }`. `newCwd` is null when no cd was
 * detected. `remainingCommand` is the tail of the command after all
 * leading cd's are stripped (may be empty).
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export interface CdParseResult {
  /** Final cwd after applying all leading cd's. Null = no cd in this command. */
  newCwd: string | null;
  /** The command remaining after stripping leading cd's. May be "". */
  remainingCommand: string;
  /**
   * When the agent typed something like `cd /missing && rest`, we couldn't
   * apply the cd safely. Caller can surface this as an error and skip the
   * tail rather than silently running in the wrong dir.
   */
  error?: string;
}

const SEPARATOR_PATTERN = /^\s*(?:&&|;)\s*/;
const CD_TOKEN_PATTERN = /^cd(?:\s+([^\s;&]+(?:\\\s[^\s;&]+)*))?\s*/;

export function extractLeadingCd(
  command: string,
  startingCwd: string
): CdParseResult {
  let remaining = command;
  let currentCwd = startingCwd;
  let changed = false;

  // Strip leading cd's one at a time. Each iteration either advances past
  // a `cd <target>` segment (with its trailing separator) or breaks.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const cdMatch = remaining.match(CD_TOKEN_PATTERN);
    if (!cdMatch) break;

    const rawTarget = cdMatch[1];
    const target = rawTarget ? rawTarget.replace(/\\ /g, " ") : homedir();
    const resolved = resolveCdTarget(target, currentCwd);

    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      return {
        newCwd: changed ? currentCwd : null,
        remainingCommand: remaining.trim(),
        error: `cd: not a directory: ${target}`,
      };
    }

    currentCwd = resolved;
    changed = true;
    remaining = remaining.slice(cdMatch[0].length);

    // Expect a separator (or end-of-string). Anything else is a syntax
    // we don't handle, so stop peeling and let the shell run the rest as
    // a single command — which will fail naturally if it's malformed.
    const sepMatch = remaining.match(SEPARATOR_PATTERN);
    if (sepMatch) {
      remaining = remaining.slice(sepMatch[0].length);
      continue;
    }
    if (remaining.length === 0) {
      break;
    }
    // No separator and there's still text → not a chained-cd shape we
    // know how to handle (e.g. `cd /a foo bar`). Stop here.
    break;
  }

  return {
    newCwd: changed ? currentCwd : null,
    remainingCommand: remaining.trim(),
  };
}

function resolveCdTarget(target: string, base: string): string {
  if (target === "~") return homedir();
  if (target.startsWith("~/")) return resolve(homedir(), target.slice(2));
  if (isAbsolute(target)) return target;
  return resolve(base, target);
}
