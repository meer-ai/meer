/**
 * Small pure formatters shared by the status header, footer, turn summary, and
 * the live "working" line. Kept dependency-free so they're trivially testable.
 */

/** Compact token/count formatting: 950 → "950", 3600 → "3.6k", 2_000_000 → "2.0M". */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const n = Math.max(0, Math.round(value));
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Elapsed wall-clock for the working line, in the terse style of the spinner:
 * "8s", "1m 13s", "1h 2m". Sub-second rounds down to "0s".
 */
export function formatWorkElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * The "· 1m 13s · 7.9k tok" metadata appended to the working line: always the
 * elapsed time, plus the live token figure once it's known. Mirrors the
 * footer's wording — billed usage as "tok", a char-based estimate as "~… ctx".
 */
export function formatWorkMeta(input: {
  elapsedMs: number;
  usedTokens?: number;
  estimated?: boolean;
}): string {
  const parts = [formatWorkElapsed(input.elapsedMs)];
  if (typeof input.usedTokens === "number" && input.usedTokens > 0) {
    const prefix = input.estimated ? "~" : "";
    const unit = input.estimated ? "ctx" : "tok";
    parts.push(`${prefix}${formatCompact(input.usedTokens)} ${unit}`);
  }
  return parts.join(" · ");
}
