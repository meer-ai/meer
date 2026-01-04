/**
 * Debounce utility for performance optimization
 * Prevents excessive re-renders during high-frequency updates
 */

export interface DebounceOptions {
  delay?: number;
  maxWait?: number;
  leading?: boolean;
  trailing?: boolean;
}

export interface DebouncedFunction<T extends (...args: any[]) => any> {
  (...args: Parameters<T>): ReturnType<T> | undefined;
  cancel: () => void;
  flush: () => ReturnType<T> | undefined;
}

/**
 * Creates a debounced function that delays invoking func until after wait milliseconds
 * have elapsed since the last time the debounced function was invoked.
 * 
 * @param func - Function to debounce
 * @param options - Configuration options
 * @returns Debounced function with cancel and flush methods
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  options: DebounceOptions = {}
): DebouncedFunction<T> {
  const {
    delay = 50,
    maxWait = 200,
    leading = false,
    trailing = true,
  } = options;

  let timeoutId: NodeJS.Timeout | null = null;
  let lastCallTime = 0;
  let lastArgs: Parameters<T> | null = null;
  let maxTimeoutId: NodeJS.Timeout | null = null;

  const debounced = (...args: Parameters<T>): ReturnType<T> | undefined => {
    const now = Date.now();
    const timeSinceLastCall = now - lastCallTime;

    // Clear existing timeout
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }

    // Store args for potential leading call
    lastArgs = args;

    // Leading edge: call immediately on first invocation
    if (leading && timeSinceLastCall >= delay) {
      lastCallTime = now;
      return func(...args);
    }

    // Set up trailing edge call
    timeoutId = setTimeout(() => {
      timeoutId = null;
      if (trailing) {
        lastCallTime = Date.now();
        if (lastArgs !== null) {
          return func(...lastArgs);
        }
      }
    }, delay);

    // Set up max wait timeout to prevent starvation
    if (maxTimeoutId !== null) {
      clearTimeout(maxTimeoutId);
    }
    maxTimeoutId = setTimeout(() => {
      if (timeoutId !== null) {
        // Force execution if we've waited too long
        clearTimeout(timeoutId);
        timeoutId = null;
        if (lastArgs !== null) {
          lastCallTime = Date.now();
          return func(...lastArgs);
        }
      }
    }, maxWait);

    return undefined;
  };

  const cancel = (): void => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (maxTimeoutId !== null) {
      clearTimeout(maxTimeoutId);
      maxTimeoutId = null;
    }
  };

  const flush = (): ReturnType<T> | undefined => {
    if (timeoutId !== null && lastArgs !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
      lastCallTime = Date.now();
      return func(...lastArgs);
    }
    return undefined;
  };

  debounced.cancel = cancel;
  debounced.flush = flush;

  return debounced;
}

/**
 * Creates a throttled function that only invokes func at most once per every wait milliseconds
 * 
 * @param func - Function to throttle
 * @param wait - Minimum time between invocations in milliseconds
 * @returns Throttled function
 */
export function throttle<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeoutId: NodeJS.Timeout | null = null;
  let lastCallTime = 0;

  return (...args: Parameters<T>): void => {
    const now = Date.now();
    const timeSinceLastCall = now - lastCallTime;

    if (timeSinceLastCall >= wait) {
      // Enough time has passed, call immediately
      lastCallTime = now;
      func(...args);
    } else if (timeoutId === null) {
      // Schedule call for later
      timeoutId = setTimeout(() => {
        timeoutId = null;
        lastCallTime = Date.now();
        func(...args);
      }, wait - timeSinceLastCall);
    }
  };
}

/**
 * Creates a function that will only be called once per animation frame
 * Useful for smooth UI updates
 * 
 * @param callback - Function to call on next animation frame
 * @returns Function to cancel the request
 */
export function requestAnimationFrame(callback: () => void): () => void {
  let cancelled = false;
  
  const id = setTimeout(() => {
    if (!cancelled) {
      callback();
    }
  }, 16); // ~60fps

  return () => {
    cancelled = true;
    clearTimeout(id);
  };
}

/**
 * Batches multiple synchronous updates into a single re-render
 * 
 * @param updates - Array of update functions
 * @param callback - Function to call after all updates
 */
export function batchUpdates<T>(
  updates: Array<() => T>,
  callback: (results: T[]) => void
): void {
  const results = updates.map(update => update());
  callback(results);
}
