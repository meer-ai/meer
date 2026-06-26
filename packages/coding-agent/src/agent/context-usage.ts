import {
  getContextWindow,
  contextFillColor,
} from "../utils/model-context.js";

/**
 * Current context-window occupancy for the active session, as surfaced to the
 * model by the get_context_remaining tool.
 */
export interface ContextUsage {
  /** Tokens currently occupying the context window. */
  usedTokens: number;
  /** The model's context-window size in tokens. */
  totalTokens: number;
  /** True when usedTokens is a char/4 estimate (no provider usage yet). */
  estimated: boolean;
}

/**
 * Resolve current usage from whatever the agent knows. Prefers the provider's
 * last-reported prompt-token count (exact); before any response exists this
 * turn, falls back to a chars/4 estimate of the visible transcript.
 */
export function computeContextUsage(input: {
  lastPromptTokens?: number;
  totalChars: number;
  model: string | undefined;
}): ContextUsage {
  const estimated = input.lastPromptTokens === undefined;
  const usedTokens = input.lastPromptTokens ?? Math.ceil(input.totalChars / 4);
  const totalTokens = getContextWindow(input.model).tokens;
  return { usedTokens, totalTokens, estimated };
}

/**
 * Format usage into the text the model sees. Returns a graceful line when
 * usage cannot be determined (null), rather than throwing.
 */
export function formatContextRemaining(usage: ContextUsage | null): string {
  if (!usage) {
    return "Context usage is not available in this session.";
  }

  const { usedTokens, totalTokens, estimated } = usage;
  const percent =
    totalTokens > 0
      ? Math.max(0, Math.min(100, Math.round((usedTokens / totalTokens) * 100)))
      : 0;
  const status = contextFillColor(percent);
  const remaining = Math.max(0, totalTokens - usedTokens);
  const estMark = estimated ? " (estimated)" : "";

  const guidance =
    percent >= 80
      ? "Context nearly full — wrap up, summarize, or compact soon; avoid large reads."
      : percent >= 50
        ? "Getting full — prefer concise responses and avoid re-reading large files."
        : "Plenty of headroom.";

  const lines = [
    `Context: ${usedTokens.toLocaleString("en-US")} / ${totalTokens.toLocaleString("en-US")} tokens used (${percent}%)${estMark} — ${status}`,
    `Remaining: ~${remaining.toLocaleString("en-US")} tokens`,
    guidance,
  ];

  if (estimated) {
    lines.push("(Token count is an estimate until the first model response.)");
  }

  return lines.join("\n");
}
