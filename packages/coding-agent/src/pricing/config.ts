/**
 * Pricing configuration for different AI providers and models
 * Prices are in USD per 1M tokens (per million tokens)
 * Updated as of January 2025
 */

export interface ModelPricing {
  input: number;  // Cost per 1M input tokens
  output: number; // Cost per 1M output tokens
}

export interface ProviderPricing {
  [model: string]: ModelPricing;
}

export const PRICING_CONFIG: Record<string, ProviderPricing> = {
  openai: {
    // GPT-4o models
    "gpt-4o": {
      input: 2.50,
      output: 10.00
    },
    "gpt-4o-mini": {
      input: 0.15,
      output: 0.60
    },

    // GPT-4 Turbo models
    "gpt-4-turbo": {
      input: 10.00,
      output: 30.00
    },
    "gpt-4-turbo-preview": {
      input: 10.00,
      output: 30.00
    },

    // GPT-4 models
    "gpt-4": {
      input: 30.00,
      output: 60.00
    },
    "gpt-4-32k": {
      input: 60.00,
      output: 120.00
    },

    // GPT-3.5 Turbo
    "gpt-3.5-turbo": {
      input: 0.50,
      output: 1.50
    },
    "gpt-3.5-turbo-16k": {
      input: 3.00,
      output: 4.00
    }
  },

  anthropic: {
    // Claude 3.5 Sonnet
    "claude-3-5-sonnet-20241022": {
      input: 3.00,
      output: 15.00
    },
    "claude-3-5-sonnet-20240620": {
      input: 3.00,
      output: 15.00
    },

    // Claude 3 Opus
    "claude-3-opus-20240229": {
      input: 15.00,
      output: 75.00
    },

    // Claude 3 Sonnet
    "claude-3-sonnet-20240229": {
      input: 3.00,
      output: 15.00
    },

    // Claude 3 Haiku
    "claude-3-haiku-20240307": {
      input: 0.25,
      output: 1.25
    },

    // Claude 2
    "claude-2.1": {
      input: 8.00,
      output: 24.00
    },
    "claude-2.0": {
      input: 8.00,
      output: 24.00
    }
  },

  gemini: {
    // Gemini 2.0
    "gemini-2.0-flash-exp": {
      input: 0.00,  // Free during preview
      output: 0.00
    },
    "gemini-2.0-flash-thinking-exp": {
      input: 0.00,  // Free during preview
      output: 0.00
    },

    // Gemini 1.5
    "gemini-1.5-pro": {
      input: 1.25,
      output: 5.00
    },
    "gemini-1.5-pro-latest": {
      input: 1.25,
      output: 5.00
    },
    "gemini-1.5-flash": {
      input: 0.075,
      output: 0.30
    },
    "gemini-1.5-flash-latest": {
      input: 0.075,
      output: 0.30
    },
    "gemini-1.5-flash-8b": {
      input: 0.0375,
      output: 0.15
    },

    // Gemini 1.0
    "gemini-1.0-pro": {
      input: 0.50,
      output: 1.50
    }
  },

  // Ollama is free (local)
  ollama: {
    "*": {
      input: 0.00,
      output: 0.00
    }
  },

  // OpenRouter uses various models - common ones
  openrouter: {
    "anthropic/claude-3.5-sonnet": {
      input: 3.00,
      output: 15.00
    },
    "anthropic/claude-3-opus": {
      input: 15.00,
      output: 75.00
    },
    "anthropic/claude-3-sonnet": {
      input: 3.00,
      output: 15.00
    },
    "anthropic/claude-3-haiku": {
      input: 0.25,
      output: 1.25
    },
    "openai/gpt-4o": {
      input: 2.50,
      output: 10.00
    },
    "openai/gpt-4o-mini": {
      input: 0.15,
      output: 0.60
    },
    "openai/gpt-4-turbo": {
      input: 10.00,
      output: 30.00
    },
    "google/gemini-pro-1.5": {
      input: 1.25,
      output: 5.00
    },
    "google/gemini-flash-1.5": {
      input: 0.075,
      output: 0.30
    },
    // Default for unknown OpenRouter models (use reasonable average)
    "*": {
      input: 3.00,
      output: 15.00
    }
  },

  // Meer managed provider - pricing varies
  meer: {
    "auto": {
      input: 0.00,  // Calculated by backend
      output: 0.00
    },
    "*": {
      input: 0.00,
      output: 0.00
    }
  }
};

/**
 * Get pricing for a specific provider and model
 * Returns null if pricing is not available
 */
export function getModelPricing(provider: string, model: string): ModelPricing | null {
  const providerPricing = PRICING_CONFIG[provider.toLowerCase()];
  if (!providerPricing) {
    return null;
  }

  // Try exact model match first
  if (providerPricing[model]) {
    return providerPricing[model];
  }

  // Try wildcard match
  if (providerPricing["*"]) {
    return providerPricing["*"];
  }

  // For partial matches (e.g., "gpt-4-0613" matches "gpt-4")
  const modelKeys = Object.keys(providerPricing);
  for (const key of modelKeys) {
    if (key !== "*" && (model.startsWith(key) || key.startsWith(model))) {
      return providerPricing[key];
    }
  }

  return null;
}

/**
 * Calculate cost based on token usage
 * @param provider Provider name
 * @param model Model name
 * @param inputTokens Number of input/prompt tokens
 * @param outputTokens Number of output/completion tokens
 * @returns Cost in USD, or null if pricing not available
 */
export function calculateCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): number | null {
  const pricing = getModelPricing(provider, model);
  if (!pricing) {
    return null;
  }

  // Calculate cost (pricing is per 1M tokens)
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;

  return inputCost + outputCost;
}

/**
 * Format cost for display
 * @param cost Cost in USD
 * @returns Formatted cost string (e.g., "$0.0123" or "$0.00")
 */
export function formatCost(cost: number | null): string {
  if (cost === null || cost === 0) {
    return "$0.00";
  }

  // For very small costs (< $0.01), show more decimal places
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  }

  // For regular costs, show 2 decimal places
  return `$${cost.toFixed(2)}`;
}
