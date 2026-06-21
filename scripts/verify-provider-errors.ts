import assert from "node:assert/strict";
import {
  isContextOverflowError,
  isRetryableProviderError,
} from "@meer-ai/core/provider-errors.js";

// --- Retryable transient failures ---
const retryable = [
  "overloaded_error: Anthropic servers are overloaded",
  "529 overloaded",
  "rate limit exceeded, please slow down",
  "Too Many Requests (429)",
  "502 Bad Gateway",
  "503 Service Unavailable",
  "Internal error encountered (500)",
  "fetch failed",
  "socket hang up",
  "ECONNRESET",
  "ETIMEDOUT while connecting",
  "request timed out after 120000ms",
  "other side closed",
  "stream ended before message_stop",
  "terminated",
  "Connection lost during streaming",
  "network error: ENOTFOUND api.anthropic.com",
];
for (const message of retryable) {
  assert.equal(
    isRetryableProviderError(message),
    true,
    `should be retryable: ${message}`
  );
}

// --- Non-retryable hard failures ---
const nonRetryable = [
  "401 Unauthorized: invalid API key",
  "Invalid request: model not found",
  "permission denied",
];
for (const message of nonRetryable) {
  assert.equal(
    isRetryableProviderError(message),
    false,
    `should NOT be retryable: ${message}`
  );
}

// --- Context overflow detection across providers ---
const overflow = [
  "prompt is too long: 213462 tokens > 200000 maximum", // Anthropic
  '413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}', // Anthropic
  "Your input exceeds the context window of this model", // OpenAI
  "Requested token count exceeds the model's maximum context length of 131072 tokens", // LiteLLM
  "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)", // Google
  "This model's maximum prompt length is 131072 but the request contains 537812 tokens", // xAI
  "Please reduce the length of the messages or completion", // Groq
  "This endpoint's maximum context length is 128000 tokens. However, you requested about 250000 tokens", // OpenRouter
  "the request exceeds the available context size, try increasing it", // llama.cpp
  "prompt too long; exceeded max context length by 5000 tokens", // Ollama
  "context_length_exceeded", // generic
];
for (const message of overflow) {
  assert.equal(
    isContextOverflowError(message),
    true,
    `should be overflow: ${message}`
  );
  assert.equal(
    isRetryableProviderError(message),
    false,
    `overflow must not be blind-retried: ${message}`
  );
}

// --- Overflow exclusions (throttling that mentions tokens) ---
const notOverflow = [
  "Throttling error: Too many tokens, please wait before trying again.",
  "rate limit: too many tokens per minute",
  "too many requests",
];
for (const message of notOverflow) {
  assert.equal(
    isContextOverflowError(message),
    false,
    `should NOT be overflow: ${message}`
  );
}

console.log("✅ Provider error classification (retryable vs overflow) works.");
