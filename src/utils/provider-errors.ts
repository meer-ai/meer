/**
 * Provider error classification: retryable transient failures vs context
 * overflow vs hard failures.
 *
 * Pattern lists ported from the pi coding agent (MIT, © 2025 Mario Zechner,
 * https://github.com/badlogic/pi) and adapted for meer.
 */

/**
 * Transient provider/network failures worth retrying with backoff:
 * overload (Anthropic 529), rate limits, 5xx, connection drops, premature
 * stream endings, fetch/socket failures.
 */
const RETRYABLE_PATTERN =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|connection.?reset|connection.?closed|temporarily unavailable|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|econnreset|etimedout|enotfound|eai_again|enetunreach|ended without|stream ended before|premature(?:ly)? clos|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

/**
 * Context-overflow error messages across providers. See pi's overflow.ts for
 * the provider-by-provider catalogue these are derived from.
 */
const OVERFLOW_PATTERNS = [
  /prompt is too long/i, // Anthropic token overflow
  /request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI (Completions & Responses API)
  /exceeds (?:the )?(?:model'?s )?maximum context length of [\d,]+ tokens?/i, // OpenAI-compatible proxies (LiteLLM)
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter (most backends)
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi
  /too large for model with \d+ maximum context length/i, // Mistral
  /model_context_window_exceeded/i, // z.ai
  /prompt too long; exceeded (?:max )?context length/i, // Ollama
  /context[_ ]length[_ ]exceeded/i, // Generic fallback
  /too many tokens/i, // Generic fallback
  /token limit exceeded/i, // Generic fallback
];

/**
 * Messages matching these are never overflow, even if they also match an
 * overflow pattern (e.g. Bedrock throttling "Too many tokens, please wait").
 */
const NON_OVERFLOW_PATTERNS = [
  /^(Throttling error|Service unavailable):/i,
  /rate limit/i,
  /too many requests/i,
];

export function isRetryableProviderError(error: Error | string): boolean {
  const message = typeof error === "string" ? error : error.message;
  // Context overflow is recovered via compaction, not blind retry
  if (isContextOverflowError(message)) {
    return false;
  }
  return RETRYABLE_PATTERN.test(message);
}

export function isContextOverflowError(error: Error | string): boolean {
  const message = typeof error === "string" ? error : error.message;
  if (NON_OVERFLOW_PATTERNS.some((p) => p.test(message))) {
    return false;
  }
  return OVERFLOW_PATTERNS.some((p) => p.test(message));
}
