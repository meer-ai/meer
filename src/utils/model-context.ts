/**
 * Model → context-window size map for the footer's "context: N%" indicator.
 *
 * We deliberately keep this list small and pattern-based rather than
 * fetching from each provider — model registries drift and an out-of-date
 * exact-match map is worse than a sensible default. The lookup walks
 * specific entries first, then provider-wide defaults, then a hard fallback
 * at 128k (modern models settle around that range).
 *
 * Numbers reflect each model's *input* context window. We don't bother
 * with the small output-token cap separately; the user's interest is
 * "how full is the context window I'm typing into."
 */

export interface ContextWindow {
  /** Bytes? Tokens? Always tokens. Named explicitly for clarity at call sites. */
  tokens: number;
}

const EXACT_MATCHES: Record<string, ContextWindow> = {
  // Anthropic
  "claude-opus-4-7": { tokens: 200_000 },
  "claude-opus-4-6": { tokens: 200_000 },
  "claude-opus-4-5": { tokens: 200_000 },
  "claude-sonnet-4-6": { tokens: 200_000 },
  "claude-sonnet-4-5": { tokens: 200_000 },
  "claude-haiku-4-5": { tokens: 200_000 },
  "claude-3-7-sonnet-latest": { tokens: 200_000 },
  "claude-3-5-sonnet-latest": { tokens: 200_000 },
  "claude-3-5-haiku-latest": { tokens: 200_000 },
  // OpenAI
  "gpt-4o": { tokens: 128_000 },
  "gpt-4o-mini": { tokens: 128_000 },
  "gpt-4-turbo": { tokens: 128_000 },
  "o1": { tokens: 200_000 },
  "o1-mini": { tokens: 128_000 },
  "o3-mini": { tokens: 200_000 },
  // Google
  "gemini-2.5-pro": { tokens: 1_000_000 },
  "gemini-2.5-flash": { tokens: 1_000_000 },
  "gemini-1.5-pro": { tokens: 2_000_000 },
  "gemini-1.5-flash": { tokens: 1_000_000 },
  // DeepSeek / others popular with meer users
  "deepseek-chat": { tokens: 64_000 },
  "deepseek-coder": { tokens: 64_000 },
  "deepseek-v4-pro": { tokens: 64_000 },
};

/**
 * Pattern-based fallbacks. Walked in order; first match wins. Lets us
 * cover variants of a model family (provider-prefixed, dated suffixes,
 * routing aliases like opencode's `deepseek-v4-pro`) without listing
 * every permutation.
 */
const PATTERN_FALLBACKS: Array<{ pattern: RegExp; tokens: number }> = [
  { pattern: /claude.*opus/i, tokens: 200_000 },
  { pattern: /claude.*sonnet/i, tokens: 200_000 },
  { pattern: /claude.*haiku/i, tokens: 200_000 },
  { pattern: /claude/i, tokens: 200_000 },
  { pattern: /gpt-?4/i, tokens: 128_000 },
  { pattern: /gpt-?5/i, tokens: 256_000 },
  { pattern: /^o[1-9]/i, tokens: 200_000 },
  { pattern: /gemini/i, tokens: 1_000_000 },
  { pattern: /deepseek/i, tokens: 64_000 },
  { pattern: /llama/i, tokens: 128_000 },
  { pattern: /mistral|mixtral/i, tokens: 32_000 },
  { pattern: /qwen/i, tokens: 128_000 },
];

const DEFAULT_CONTEXT_TOKENS = 128_000;

/**
 * Look up the context window for a model identifier. Provider prefix is
 * tolerated (`anthropic/claude-…`, `openrouter/anthropic/…`) — we match
 * on the trailing model id.
 */
export function getContextWindow(model: string | undefined): ContextWindow {
  if (!model) return { tokens: DEFAULT_CONTEXT_TOKENS };
  const id = model.split("/").pop()?.toLowerCase() ?? model.toLowerCase();
  const exact = EXACT_MATCHES[id];
  if (exact) return exact;
  for (const { pattern, tokens } of PATTERN_FALLBACKS) {
    if (pattern.test(id)) return { tokens };
  }
  return { tokens: DEFAULT_CONTEXT_TOKENS };
}

/**
 * Compute the fill percentage for the footer indicator. Clamped to 100
 * even when the actual count exceeds the window (which can happen with
 * prompt-cache hits inflating reported tokens).
 */
export function contextFillPercent(
  usedTokens: number,
  model: string | undefined
): number {
  const { tokens } = getContextWindow(model);
  if (tokens <= 0) return 0;
  const pct = Math.round((usedTokens / tokens) * 100);
  return Math.max(0, Math.min(100, pct));
}

/** Color the indicator green / yellow / red based on fill. */
export function contextFillColor(percent: number): "green" | "yellow" | "red" {
  if (percent >= 80) return "red";
  if (percent >= 50) return "yellow";
  return "green";
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`;
  return String(tokens);
}
