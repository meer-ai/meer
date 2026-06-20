/**
 * Circuit Breaker Pattern
 * Prevents cascading failures by failing fast when a service is experiencing issues
 */

import chalk from 'chalk';
import { circuitBreakerState as circuitBreakerStateMetric, circuitBreakerTrips } from '../telemetry/metrics.js';

export enum CircuitState {
  CLOSED = 'CLOSED',     // Normal operation
  OPEN = 'OPEN',         // Circuit is open, failing fast
  HALF_OPEN = 'HALF_OPEN' // Testing if service recovered
}

export interface CircuitBreakerOptions {
  /** Number of failures before opening the circuit */
  failureThreshold?: number;
  /** Time in ms to wait before attempting recovery */
  resetTimeout?: number;
  /** Time window in ms for counting failures */
  failureWindow?: number;
  /** Optional name for logging */
  name?: string;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime?: number;
  lastSuccessTime?: number;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures = 0;
  private successes = 0;
  private lastFailureTime = 0;
  private lastSuccessTime = 0;
  private failureTimes: number[] = [];

  private readonly failureThreshold: number;
  private readonly resetTimeout: number;
  private readonly failureWindow: number;
  private readonly name: string;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 60000; // 1 minute default
    this.failureWindow = options.failureWindow || 10000; // 10 seconds default
    this.name = options.name || 'CircuitBreaker';

    // Initialize metric state
    this.updateMetricState();
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if circuit is open
    if (this.state === CircuitState.OPEN) {
      // Check if enough time has passed to attempt recovery
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        console.log(
          chalk.yellow(
            `  🔄 ${this.name}: Circuit entering HALF_OPEN state for recovery test`
          )
        );
        this.state = CircuitState.HALF_OPEN;
        this.updateMetricState();
      } else {
        throw new Error(
          `Circuit breaker is OPEN for ${this.name}. Service is unavailable. ` +
          `Retry after ${Math.ceil((this.resetTimeout - (Date.now() - this.lastFailureTime)) / 1000)}s`
        );
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Handle successful execution
   */
  private onSuccess(): void {
    this.successes++;
    this.lastSuccessTime = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      console.log(
        chalk.green(
          `  ✅ ${this.name}: Circuit recovered, transitioning to CLOSED state`
        )
      );
      this.reset();
      this.updateMetricState();
    }
  }

  /**
   * Handle failed execution
   */
  private onFailure(): void {
    this.failures++;
    const now = Date.now();
    this.lastFailureTime = now;
    this.failureTimes.push(now);

    // Remove old failures outside the failure window
    this.failureTimes = this.failureTimes.filter(
      time => now - time < this.failureWindow
    );

    // Check if we should open the circuit
    if (this.state === CircuitState.HALF_OPEN) {
      // Any failure in HALF_OPEN immediately reopens the circuit
      console.log(
        chalk.red(
          `  ❌ ${this.name}: Recovery test failed, circuit reopening`
        )
      );
      this.state = CircuitState.OPEN;
      this.updateMetricState();
      this.recordTrip();
    } else if (this.failureTimes.length >= this.failureThreshold) {
      console.log(
        chalk.red(
          `  ⚠️  ${this.name}: Failure threshold (${this.failureThreshold}) reached, opening circuit`
        )
      );
      this.state = CircuitState.OPEN;
      this.updateMetricState();
      this.recordTrip();
    }
  }

  /**
   * Reset the circuit breaker to CLOSED state
   */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.failureTimes = [];
  }

  /**
   * Force the circuit to a specific state (for testing/manual intervention)
   */
  forceState(state: CircuitState): void {
    console.log(
      chalk.yellow(
        `  🔧 ${this.name}: Circuit manually set to ${state} state`
      )
    );
    this.state = state;
  }

  /**
   * Get current circuit breaker stats
   */
  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime || undefined,
      lastSuccessTime: this.lastSuccessTime || undefined,
    };
  }

  /**
   * Check if circuit is accepting requests
   */
  isAvailable(): boolean {
    return this.state !== CircuitState.OPEN;
  }

  /**
   * Get human-readable status
   */
  getStatus(): string {
    const stats = this.getStats();
    return [
      `State: ${stats.state}`,
      `Failures: ${stats.failures}`,
      `Successes: ${stats.successes}`,
      stats.lastFailureTime
        ? `Last Failure: ${new Date(stats.lastFailureTime).toISOString()}`
        : '',
      stats.lastSuccessTime
        ? `Last Success: ${new Date(stats.lastSuccessTime).toISOString()}`
        : '',
    ].filter(Boolean).join(' | ');
  }

  /**
   * Update Prometheus metric for circuit breaker state
   */
  private updateMetricState(): void {
    // Extract server name from circuit breaker name (format: "MCP:serverName")
    const serverName = this.name.replace(/^MCP:/, '');

    const stateValue = this.state === CircuitState.CLOSED ? 0 :
                       this.state === CircuitState.HALF_OPEN ? 1 : 2;

    circuitBreakerStateMetric.set({ server_name: serverName }, stateValue);
  }

  /**
   * Record a circuit breaker trip event
   */
  private recordTrip(): void {
    const serverName = this.name.replace(/^MCP:/, '');
    circuitBreakerTrips.inc({ server_name: serverName });
  }
}
