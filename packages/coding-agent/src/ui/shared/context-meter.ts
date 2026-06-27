import { contextFillColor } from "../../utils/model-context.js";

/**
 * A small "how deep are we" gauge for the footer: how full the model's context
 * window is, as a cell-count bar + percent + a green/yellow/red level. Pure so
 * it's testable; the footer paints the cells with theme colours.
 */
export type MeterColor = "green" | "yellow" | "red";

export interface ContextMeter {
  /** Fill percentage, 0..100 (clamped). */
  percent: number;
  /** Number of filled cells. */
  filled: number;
  /** Total cells in the bar. */
  total: number;
  /** Severity, reusing the same thresholds as the footer's context indicator. */
  color: MeterColor;
}

/**
 * Compute the gauge from live usage. Returns null when there's nothing
 * meaningful to show (no limit, no usage, bad input) so the footer can simply
 * omit it.
 */
export function computeContextMeter(
  usedTokens: number,
  limitTokens: number,
  cells = 8
): ContextMeter | null {
  if (!Number.isFinite(usedTokens) || !Number.isFinite(limitTokens)) return null;
  if (limitTokens <= 0 || usedTokens <= 0 || cells <= 0) return null;
  const percent = Math.max(0, Math.min(100, Math.round((usedTokens / limitTokens) * 100)));
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)));
  return { percent, filled, total: cells, color: contextFillColor(percent) as MeterColor };
}
