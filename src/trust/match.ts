/**
 * Command normalization for the trust allowlist.
 *
 * Persisted "always allow" rules are matched against future commands by
 * EXACT normalized equality — never by prefix or fuzzy match. Prefix matching
 * would be a privilege-escalation hazard: allowing `npm test` must not also
 * allow `npm test && rm -rf /`. Normalization only collapses insignificant
 * whitespace so that cosmetic spacing differences don't force a re-prompt.
 */

/**
 * Normalize a shell command for allowlist comparison.
 * - Trims leading/trailing whitespace
 * - Collapses runs of internal whitespace (spaces, tabs) to a single space
 *
 * Note: this is intentionally conservative. We do NOT reorder, lowercase, or
 * strip quotes — two commands that differ in any meaningful character remain
 * distinct rules.
 */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/**
 * True when `command` exactly matches one of the normalized `allowedRules`.
 */
export function isCommandInAllowlist(
  command: string,
  allowedRules: readonly string[]
): boolean {
  const normalized = normalizeCommand(command);
  if (!normalized) return false;
  return allowedRules.some((rule) => normalizeCommand(rule) === normalized);
}
