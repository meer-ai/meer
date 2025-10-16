/**
 * Metrics Collection with Prometheus
 * Tracks performance and usage metrics for observability
 */

import { Registry, Counter, Histogram, Gauge } from 'prom-client';

// Create a custom registry
export const metricsRegistry = new Registry();

// Add default metrics (process CPU, memory, etc.)
// collectDefaultMetrics({ register: metricsRegistry });

/**
 * Tool execution metrics
 */
export const toolCallsTotal = new Counter({
  name: 'meer_tool_calls_total',
  help: 'Total number of tool calls',
  labelNames: ['tool_name', 'status', 'server_name'],
  registers: [metricsRegistry],
});

export const toolLatency = new Histogram({
  name: 'meer_tool_latency_seconds',
  help: 'Tool execution latency in seconds',
  labelNames: ['tool_name', 'server_name'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [metricsRegistry],
});

export const toolErrors = new Counter({
  name: 'meer_tool_errors_total',
  help: 'Total number of tool execution errors',
  labelNames: ['tool_name', 'error_type', 'server_name'],
  registers: [metricsRegistry],
});

/**
 * MCP server metrics
 */
export const mcpConnectionsTotal = new Counter({
  name: 'meer_mcp_connections_total',
  help: 'Total number of MCP server connection attempts',
  labelNames: ['server_name', 'status'],
  registers: [metricsRegistry],
});

export const mcpActiveConnections = new Gauge({
  name: 'meer_mcp_active_connections',
  help: 'Number of currently active MCP connections',
  labelNames: ['server_name'],
  registers: [metricsRegistry],
});

export const mcpReconnections = new Counter({
  name: 'meer_mcp_reconnections_total',
  help: 'Total number of MCP server reconnection attempts',
  labelNames: ['server_name', 'success'],
  registers: [metricsRegistry],
});

/**
 * Circuit breaker metrics
 */
export const circuitBreakerState = new Gauge({
  name: 'meer_circuit_breaker_state',
  help: 'Circuit breaker state (0=CLOSED, 1=HALF_OPEN, 2=OPEN)',
  labelNames: ['server_name'],
  registers: [metricsRegistry],
});

export const circuitBreakerTrips = new Counter({
  name: 'meer_circuit_breaker_trips_total',
  help: 'Total number of circuit breaker trips',
  labelNames: ['server_name'],
  registers: [metricsRegistry],
});

/**
 * LLM/Agent metrics
 */
export const llmRequestsTotal = new Counter({
  name: 'meer_llm_requests_total',
  help: 'Total number of LLM requests',
  labelNames: ['provider', 'model', 'status'],
  registers: [metricsRegistry],
});

export const llmLatency = new Histogram({
  name: 'meer_llm_latency_seconds',
  help: 'LLM request latency in seconds',
  labelNames: ['provider', 'model'],
  buckets: [0.5, 1, 2, 5, 10, 20, 30, 60],
  registers: [metricsRegistry],
});

export const llmTokensTotal = new Counter({
  name: 'meer_llm_tokens_total',
  help: 'Total number of tokens processed',
  labelNames: ['provider', 'model', 'type'],
  registers: [metricsRegistry],
});

export const llmCostTotal = new Counter({
  name: 'meer_llm_cost_usd_total',
  help: 'Total LLM cost in USD',
  labelNames: ['provider', 'model'],
  registers: [metricsRegistry],
});

/**
 * Context window metrics
 */
export const contextWindowUsage = new Histogram({
  name: 'meer_context_window_usage_ratio',
  help: 'Context window usage ratio (0-1)',
  labelNames: ['model'],
  buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  registers: [metricsRegistry],
});

export const contextPruningEvents = new Counter({
  name: 'meer_context_pruning_total',
  help: 'Total number of context pruning events',
  labelNames: ['model'],
  registers: [metricsRegistry],
});

/**
 * Retry metrics
 */
export const retryAttempts = new Counter({
  name: 'meer_retry_attempts_total',
  help: 'Total number of retry attempts',
  labelNames: ['operation', 'attempt_number'],
  registers: [metricsRegistry],
});

export const retrySuccesses = new Counter({
  name: 'meer_retry_successes_total',
  help: 'Total number of successful retries',
  labelNames: ['operation', 'attempts_needed'],
  registers: [metricsRegistry],
});

/**
 * Get all metrics as Prometheus text format
 */
export async function getMetrics(): Promise<string> {
  return metricsRegistry.metrics();
}

/**
 * Get metrics as JSON
 */
export async function getMetricsJSON(): Promise<any> {
  const metrics = await metricsRegistry.getMetricsAsJSON();
  return metrics;
}

/**
 * Reset all metrics (useful for testing)
 */
export function resetMetrics(): void {
  metricsRegistry.resetMetrics();
}

/**
 * Helper class for tracking operation metrics
 */
export class MetricsTracker {
  private startTime: number;
  private operation: string;
  private labels: Record<string, string>;

  constructor(operation: string, labels: Record<string, string> = {}) {
    this.operation = operation;
    this.labels = labels;
    this.startTime = Date.now();
  }

  /**
   * Record successful completion
   */
  success(additionalLabels: Record<string, string> = {}): number {
    const duration = (Date.now() - this.startTime) / 1000;
    const allLabels: Record<string, string> = { ...this.labels, ...additionalLabels, status: 'success' };

    // Record in appropriate metric based on operation type
    if (this.operation.includes('tool')) {
      toolCallsTotal.inc(allLabels);
      if ('tool_name' in allLabels && 'server_name' in allLabels) {
        toolLatency.observe(
          {
            tool_name: allLabels['tool_name'],
            server_name: allLabels['server_name'],
          },
          duration
        );
      }
    } else if (this.operation.includes('llm')) {
      llmRequestsTotal.inc(allLabels);
      if ('provider' in allLabels && 'model' in allLabels) {
        llmLatency.observe(
          {
            provider: allLabels['provider'],
            model: allLabels['model'],
          },
          duration
        );
      }
    }

    return duration;
  }

  /**
   * Record failure
   */
  failure(error: Error, additionalLabels: Record<string, string> = {}): number {
    const duration = (Date.now() - this.startTime) / 1000;
    const allLabels: Record<string, string> = { ...this.labels, ...additionalLabels, status: 'failure' };

    if (this.operation.includes('tool')) {
      toolCallsTotal.inc(allLabels);
      if ('tool_name' in allLabels && 'server_name' in allLabels) {
        toolErrors.inc({
          tool_name: allLabels['tool_name'],
          error_type: error.name || 'Error',
          server_name: allLabels['server_name'],
        });
      }
    } else if (this.operation.includes('llm')) {
      llmRequestsTotal.inc(allLabels);
    }

    return duration;
  }

  /**
   * Get elapsed time without recording
   */
  elapsed(): number {
    return (Date.now() - this.startTime) / 1000;
  }
}
