import * as GPTTokenizer from "gpt-tokenizer";

const tokenizer: any = GPTTokenizer;

const DEFAULT_MODEL = "gpt-4o";

const MODEL_MAPPINGS: Record<string, string> = {
  "gpt-3.5": "cl100k_base",
  "gpt-4": "cl100k_base",
  "gpt-4o": "o200k_base",
  "gpt-4o-mini": "o200k_base",
  "gpt-4.1": "o200k_base",
  "gpt-4.1-mini": "o200k_base",
  "claude-3": "anthropic",
  "claude-3.5": "anthropic",
  "gemini-1.5": "cl100k_base",
  "gemini-2.0": "cl100k_base",
};

const CONTEXT_LIMITS: Array<{ pattern: RegExp; limit: number }> = [
  { pattern: /gpt-4o-mini/i, limit: 128_000 },
  { pattern: /gpt-4o/i, limit: 192_000 },
  { pattern: /gpt-4.1-mini/i, limit: 128_000 },
  { pattern: /gpt-4.1/i, limit: 192_000 },
  { pattern: /gpt-4.0/i, limit: 8_192 },
  { pattern: /gpt-4/i, limit: 8_192 },
  { pattern: /gpt-3.5/i, limit: 4_096 },
  { pattern: /claude-3.5/i, limit: 200_000 },
  { pattern: /claude-3/i, limit: 200_000 },
  { pattern: /gemini-2.0/i, limit: 1_000_000 },
  { pattern: /gemini-1.5/i, limit: 1_000_000 },
];

function resolveEncoding(model: string): string {
  const lower = model.toLowerCase();
  for (const key of Object.keys(MODEL_MAPPINGS)) {
    if (lower.includes(key)) {
      return MODEL_MAPPINGS[key];
    }
  }
  return DEFAULT_MODEL;
}

export function countTokens(model: string, text: string): number {
  const encoding = resolveEncoding(model);
  try {
    return tokenizer.encode(text, encoding).length;
  } catch {
    return tokenizer.encode(text, DEFAULT_MODEL).length;
  }
}

export function countMessageTokens(
  model: string,
  messages: Array<{ role: string; content: string }>
): number {
  const encoding = resolveEncoding(model);
  try {
    return tokenizer.encodeChat(messages as any, encoding).length;
  } catch {
    return tokenizer.encodeChat(messages as any, DEFAULT_MODEL).length;
  }
}

export function getContextLimit(model: string): number | undefined {
  for (const entry of CONTEXT_LIMITS) {
    if (entry.pattern.test(model)) {
      return entry.limit;
    }
  }
  return undefined;
}
