/**
 * Retry Logic with Exponential Backoff
 * Automatically retries failed operations with increasing delays
 */

import chalk from 'chalk';

export interface RetryOptions {
  /** Maximum number of retry attempts */
  maxRetries?: number;
  /** Base delay in ms (will be multiplied exponentially) */
  baseDelay?: number;
  /** Maximum delay in ms (cap for exponential backoff) */
  maxDelay?: number;
  /** Jitter factor (0-1) to randomize delay */
  jitter?: number;
  /** Function to determine if error is retryable */
  shouldRetry?: (error: Error) => boolean;
  /** Callback before each retry */
  onRetry?: (error: Error, attempt: number, delay: number) => void;
  /** Optional name for logging */
  name?: string;
}

export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: Error;
  attempts: number;
  totalTime: number;
}

/**
 * Retry a function with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 30000,
    jitter = 0.1,
    shouldRetry = () => true,
    onRetry,
    name = 'Operation',
  } = options;

  let lastError: Error;
  const startTime = Date.now();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();

      if (attempt > 0) {
        const totalTime = Date.now() - startTime;
        console.log(
          chalk.green(
            `  ✅ ${name} succeeded after ${attempt} ${attempt === 1 ? 'retry' : 'retries'} (${totalTime}ms)`
          )
        );
      }

      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry this error
      if (!shouldRetry(lastError)) {
        throw lastError;
      }

      // Don't retry after last attempt
      if (attempt === maxRetries) {
        const totalTime = Date.now() - startTime;
        console.log(
          chalk.red(
            `  ❌ ${name} failed after ${maxRetries} ${maxRetries === 1 ? 'retry' : 'retries'} (${totalTime}ms)`
          )
        );
        throw lastError;
      }

      // Calculate delay with exponential backoff and jitter
      const exponentialDelay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      const jitterAmount = exponentialDelay * jitter * (Math.random() - 0.5) * 2;
      const delay = Math.max(0, exponentialDelay + jitterAmount);

      console.log(
        chalk.yellow(
          `  ⚠️  ${name} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}`
        )
      );
      console.log(
        chalk.gray(`     Retrying in ${Math.round(delay)}ms...`)
      );

      // Call onRetry callback if provided
      if (onRetry) {
        onRetry(lastError, attempt + 1, delay);
      }

      // Wait before retrying
      await sleep(delay);
    }
  }

  // This should never be reached due to throw in loop, but TypeScript needs it
  throw lastError!;
}

/**
 * Retry a function with exponential backoff and return detailed result
 */
export async function retryWithBackoffDetailed<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<RetryResult<T>> {
  const startTime = Date.now();
  let attempts = 0;

  try {
    const result = await retryWithBackoff(fn, {
      ...options,
      onRetry: (error, attempt, delay) => {
        attempts = attempt;
        if (options.onRetry) {
          options.onRetry(error, attempt, delay);
        }
      },
    });

    return {
      success: true,
      result,
      attempts: attempts + 1,
      totalTime: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
      attempts: (options.maxRetries || 3) + 1,
      totalTime: Date.now() - startTime,
    };
  }
}

/**
 * Helper function to sleep for a given duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Common retry predicates for different error types
 */
export const RetryPredicates = {
  /**
   * Retry on network errors
   */
  networkErrors: (error: Error): boolean => {
    const networkErrors = [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'ENETUNREACH',
      'EAI_AGAIN',
    ];

    return networkErrors.some(code =>
      error.message.includes(code) || (error as any).code === code
    );
  },

  /**
   * Retry on timeout errors
   */
  timeoutErrors: (error: Error): boolean => {
    return error.message.toLowerCase().includes('timeout') ||
           error.message.toLowerCase().includes('timed out');
  },

  /**
   * Retry on rate limit errors (HTTP 429)
   */
  rateLimitErrors: (error: Error): boolean => {
    return error.message.includes('429') ||
           error.message.toLowerCase().includes('rate limit') ||
           error.message.toLowerCase().includes('too many requests');
  },

  /**
   * Retry on temporary server errors (HTTP 5xx)
   */
  serverErrors: (error: Error): boolean => {
    const serverErrorCodes = ['500', '502', '503', '504'];
    return serverErrorCodes.some(code => error.message.includes(code));
  },

  /**
   * Combine multiple retry predicates (retry if any matches)
   */
  any: (...predicates: Array<(error: Error) => boolean>): (error: Error) => boolean => {
    return (error: Error) => predicates.some(predicate => predicate(error));
  },

  /**
   * Default retry strategy (network + timeout + server errors)
   */
  default: (error: Error): boolean => {
    return RetryPredicates.any(
      RetryPredicates.networkErrors,
      RetryPredicates.timeoutErrors,
      RetryPredicates.serverErrors
    )(error);
  },
};
