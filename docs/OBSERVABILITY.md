# Observability & Reliability Features

This document provides a comprehensive overview of the observability and reliability features integrated into Meer CLI.

## Table of Contents

1. [Overview](#overview)
2. [Structured Logging](#structured-logging)
3. [Metrics Collection](#metrics-collection)
4. [Circuit Breaker Pattern](#circuit-breaker-pattern)
5. [Retry Logic](#retry-logic)
6. [Context Window Management](#context-window-management)
7. [Telemetry Integration](#telemetry-integration)
8. [Monitoring & Alerting](#monitoring--alerting)

---

## Overview

Meer CLI now includes production-grade observability and reliability features:

- **Structured Logging** with Winston for consistent, queryable logs
- **Metrics Collection** with Prometheus client for monitoring
- **Circuit Breaker** pattern to prevent cascading failures
- **Retry Logic** with exponential backoff for transient errors
- **Context Window Management** to prevent token limit errors
- **Telemetry Wrappers** for automatic instrumentation

These features make Meer CLI suitable for production use with full observability into system behavior, performance, and reliability.

---

## Structured Logging

### Implementation

Location: `src/utils/logger.ts`

Winston-based logging system with multiple transports and structured metadata.

### Features

- **Multiple Log Levels**: error, warn, info, http, verbose, debug, silly
- **Multiple Transports**:
  - Console output (warnings and errors)
  - Combined log file (~/.meer/logs/combined.log)
  - Error-only log file (~/.meer/logs/error.log)
  - Exception handler (~/.meer/logs/exceptions.log)
  - Rejection handler (~/.meer/logs/rejections.log)
- **Structured Metadata**: Request IDs, component names, PIDs
- **Log Rotation**: 10MB max file size, 5 files retained
- **Request Correlation**: Correlation IDs for tracing requests

### Usage Examples

```typescript
import { log, createRequestLogger, PerformanceTimer } from '../telemetry/index.js';

// Basic logging
log.info('Operation completed', { userId: '123' });
log.error('Operation failed', error, { context: 'payment' });

// Request-scoped logging
const logger = createRequestLogger('req-123');
logger.info('Processing request');

// Performance tracking
const timer = new PerformanceTimer('database-query', { query: 'SELECT *' });
// ... do work ...
const duration = timer.end(); // Logs performance metric
```

### Log Helpers

- `log.tool()` - Log tool execution events
- `log.mcp()` - Log MCP server events
- `log.perf()` - Log performance metrics
- `log.security()` - Log security events

### Log Locations

- **Development**: `~/.meer/logs/`
- **Production**: Same location (configurable via environment)

---

## Metrics Collection

### Implementation

Location: `src/telemetry/metrics.ts`

Prometheus client integration with custom metrics registry.

### Metrics Categories

#### 1. Tool Execution Metrics

```
meer_tool_calls_total{tool_name, status, server_name}
meer_tool_latency_seconds{tool_name, server_name}
meer_tool_errors_total{tool_name, error_type, server_name}
```

#### 2. MCP Server Metrics

```
meer_mcp_connections_total{server_name, status}
meer_mcp_active_connections{server_name}
meer_mcp_reconnections_total{server_name, success}
```

#### 3. Circuit Breaker Metrics

```
meer_circuit_breaker_state{server_name}  # 0=CLOSED, 1=HALF_OPEN, 2=OPEN
meer_circuit_breaker_trips_total{server_name}
```

#### 4. LLM/Agent Metrics

```
meer_llm_requests_total{provider, model, status}
meer_llm_latency_seconds{provider, model}
meer_llm_tokens_total{provider, model, type}  # type: prompt|completion
meer_llm_cost_usd_total{provider, model}
```

#### 5. Context Window Metrics

```
meer_context_window_usage_ratio{model}  # 0-1
meer_context_pruning_total{model}
```

#### 6. Retry Metrics

```
meer_retry_attempts_total{operation, attempt_number}
meer_retry_successes_total{operation, attempts_needed}
```

### Usage Examples

```typescript
import { toolCallsTotal, toolLatency, MetricsTracker } from '../telemetry/metrics.js';

// Manual metric recording
toolCallsTotal.inc({ tool_name: 'read_file', status: 'success', server_name: 'filesystem' });
toolLatency.observe({ tool_name: 'read_file', server_name: 'filesystem' }, 0.023);

// Using MetricsTracker
const tracker = new MetricsTracker('tool_execution', {
  tool_name: 'read_file',
  server_name: 'filesystem'
});

try {
  // ... do work ...
  const duration = tracker.success(); // Records success + latency
} catch (error) {
  const duration = tracker.failure(error); // Records failure + error type
}
```

### Exporting Metrics

```typescript
import { getMetrics, getMetricsJSON } from '../telemetry/metrics.js';

// Prometheus text format
const prometheusText = await getMetrics();

// JSON format
const metricsJson = await getMetricsJSON();
```

### Visualization

Metrics can be scraped by Prometheus and visualized in Grafana. Example PromQL queries:

```promql
# Tool success rate
rate(meer_tool_calls_total{status="success"}[5m]) / rate(meer_tool_calls_total[5m])

# P95 tool latency
histogram_quantile(0.95, rate(meer_tool_latency_seconds_bucket[5m]))

# Circuit breaker status
meer_circuit_breaker_state

# Context window usage
meer_context_window_usage_ratio
```

---

## Circuit Breaker Pattern

### Implementation

Location: `src/mcp/circuitBreaker.ts`

Prevents cascading failures when MCP servers become unhealthy.

### States

1. **CLOSED** (0): Normal operation, requests flow through
2. **HALF_OPEN** (1): Testing recovery, limited requests allowed
3. **OPEN** (2): Service unavailable, failing fast

### Configuration

```typescript
const circuitBreaker = new CircuitBreaker({
  name: 'MCP:filesystem',
  failureThreshold: 5,      // Open after 5 failures
  resetTimeout: 60000,      // Wait 60s before testing recovery
  failureWindow: 10000,     // Count failures in 10s window
});
```

### Behavior

- **CLOSED → OPEN**: After `failureThreshold` failures within `failureWindow`
- **OPEN → HALF_OPEN**: After `resetTimeout` has elapsed
- **HALF_OPEN → CLOSED**: On successful request (recovery confirmed)
- **HALF_OPEN → OPEN**: On failed request (recovery failed)

### Usage

```typescript
// Automatic in MCP client
const result = await mcpClient.executeTool('read_file', { path: '/tmp/file.txt' });

// Manual usage
try {
  const result = await circuitBreaker.execute(async () => {
    return await riskyOperation();
  });
} catch (error) {
  if (error.message.includes('Circuit breaker is OPEN')) {
    // Service is down, handle gracefully
  }
}
```

### Monitoring

```typescript
// Get circuit breaker status
const status = circuitBreaker.getStatus();
console.log(status); // "State: CLOSED | Failures: 2 | Successes: 150 | ..."

// Check if accepting requests
const isAvailable = circuitBreaker.isAvailable(); // false if OPEN

// Manual reset (admin intervention)
circuitBreaker.reset();
```

### Metrics Integration

Circuit breaker automatically emits:
- State changes to `meer_circuit_breaker_state` gauge
- Trip events to `meer_circuit_breaker_trips_total` counter

---

## Retry Logic

### Implementation

Location: `src/utils/retry.ts`

Exponential backoff with jitter for handling transient failures.

### Configuration

```typescript
await retryWithBackoff(
  async () => {
    return await unreliableOperation();
  },
  {
    maxRetries: 3,           // 4 total attempts (1 initial + 3 retries)
    baseDelay: 1000,         // Start with 1s delay
    maxDelay: 30000,         // Cap at 30s
    jitter: 0.1,             // ±10% randomization
    shouldRetry: RetryPredicates.networkErrors,
    name: 'database-query',  // For logging
  }
);
```

### Retry Predicates

Pre-built predicates for common scenarios:

- `RetryPredicates.networkErrors` - ECONNREFUSED, ECONNRESET, ETIMEDOUT, etc.
- `RetryPredicates.timeoutErrors` - Timeout messages
- `RetryPredicates.serverErrors` - 5xx HTTP status codes
- `RetryPredicates.rateLimit` - 429 status codes
- `RetryPredicates.default` - Combination of network + timeout + server errors
- `RetryPredicates.any(...predicates)` - Combine multiple predicates
- `RetryPredicates.all(...predicates)` - All predicates must match

### Backoff Schedule

```
Attempt 0: Immediate
Attempt 1: ~1s   (1000ms ± jitter)
Attempt 2: ~2s   (2000ms ± jitter)
Attempt 3: ~4s   (4000ms ± jitter)
Attempt 4: ~8s   (8000ms ± jitter)
```

### Usage in MCP Client

```typescript
// Automatic retry for tool execution
const result = await mcpClient.executeTool('flaky_tool', params);
// Will retry up to 2 times with exponential backoff for network/timeout errors
```

### Metrics Integration

Retries automatically emit:
- `meer_retry_attempts_total{operation, attempt_number}` for each attempt
- `meer_retry_successes_total{operation, attempts_needed}` on eventual success

---

## Context Window Management

### Implementation

Location: `src/agent/langchainWorkflow.ts`

Automatic context window pruning to prevent token limit errors.

### Features

- **Automatic Detection**: Monitors token usage per message
- **Smart Pruning**: Keeps system message + most recent conversation
- **Configurable Threshold**: Triggers at 70% of context limit
- **Graceful Degradation**: Removes oldest messages first

### Behavior

1. Before each LLM request, check total token count
2. If > 70% of context limit:
   - Keep system message (index 0)
   - Remove oldest user/assistant message pairs
   - Keep as many recent messages as fit in 70% limit
3. Log pruning event with details
4. Continue with pruned context

### Example

```
Context limit: 100,000 tokens
Current usage: 75,000 tokens (75%)
Trigger threshold: 70,000 tokens

Action: Prune 3 oldest message pairs
Result: 55,000 tokens (55%)
```

### Logging

```
⚠️  Context window is full (75,000 / 100,000 tokens). Pruning old messages...
✅ Pruned 6 messages. Context: 55,000 / 100,000 tokens (55%)
```

### Metrics

- `meer_context_window_usage_ratio{model}` - Histogram of usage ratios
- `meer_context_pruning_total{model}` - Counter of pruning events

### Configuration

```typescript
// Context limit is auto-detected per model
const contextLimit = getContextLimit(model);

// Can be overridden via sessionTracker
sessionTracker.setContextLimit(customLimit);
```

---

## Telemetry Integration

### Telemetry Wrappers

Location: `src/telemetry/index.ts`

High-level wrappers that combine logging + metrics for common operations.

#### Tool Execution Telemetry

```typescript
import { withToolTelemetry } from '../telemetry/index.js';

const result = await withToolTelemetry(
  'read_file',           // Tool name
  'filesystem',          // Server name
  async () => {
    return await mcpClient.callTool(...);
  },
  { userId: '123' }      // Additional metadata
);
```

Automatically tracks:
- Start/end logging with request ID
- Success/failure status
- Execution latency
- Tool call counter
- Error details

#### LLM Request Telemetry

```typescript
import { withLLMTelemetry } from '../telemetry/index.js';

const result = await withLLMTelemetry(
  'anthropic',           // Provider
  'claude-3-opus',       // Model
  async () => {
    return await provider.chat(messages);
  },
  { userId: '123' }      // Additional metadata
);
```

Automatically tracks:
- Request start/end logging
- Request latency
- Success/failure status
- Token usage (if available)

#### MCP Connection Telemetry

```typescript
import { withMCPConnectionTelemetry } from '../telemetry/index.js';

await withMCPConnectionTelemetry(
  'filesystem',          // Server name
  async () => {
    const client = new MCPClient(name, config);
    await client.connect();
    return client;
  }
);
```

Automatically tracks:
- Connection start/end logging
- Connection latency
- Success/failure status

#### Batch Operation Telemetry

```typescript
import { withBatchTelemetry } from '../telemetry/index.js';

const results = await withBatchTelemetry(
  'file-processing',     // Operation name
  files,                 // Array of items
  async (file) => {
    return await processFile(file);
  },
  5                      // Concurrency limit
);

// Returns: Array<{ item, result?, error? }>
```

Automatically tracks:
- Batch start/end logging
- Success/failure counts per item
- Overall batch latency
- Individual item errors

### Integration Points

All telemetry is automatically integrated at:

1. **MCP Manager** (`src/mcp/manager.ts`)
   - Server connection/disconnection
   - Tool execution validation
   - Connection failure tracking

2. **MCP Client** (`src/mcp/client.ts`)
   - Tool execution with circuit breaker + retry
   - Reconnection attempts
   - Process lifecycle events

3. **Circuit Breaker** (`src/mcp/circuitBreaker.ts`)
   - State transitions (CLOSED ↔ HALF_OPEN ↔ OPEN)
   - Trip events
   - Recovery events

4. **Langchain Workflow** (`src/agent/langchainWorkflow.ts`)
   - LLM request success/failure
   - Token usage tracking
   - Context window usage
   - Context pruning events

---

## Monitoring & Alerting

### Recommended Prometheus Alerts

```yaml
groups:
  - name: meer_alerts
    rules:
      # High error rate
      - alert: HighToolErrorRate
        expr: |
          rate(meer_tool_errors_total[5m]) > 0.1
        for: 5m
        annotations:
          summary: "High tool error rate: {{ $value }}"

      # Circuit breaker open
      - alert: CircuitBreakerOpen
        expr: |
          meer_circuit_breaker_state == 2
        for: 2m
        annotations:
          summary: "Circuit breaker OPEN for {{ $labels.server_name }}"

      # High context usage
      - alert: HighContextUsage
        expr: |
          meer_context_window_usage_ratio > 0.9
        for: 5m
        annotations:
          summary: "Context usage > 90% for {{ $labels.model }}"

      # MCP server disconnected
      - alert: MCPServerDisconnected
        expr: |
          meer_mcp_active_connections == 0
        for: 5m
        annotations:
          summary: "MCP server {{ $labels.server_name }} disconnected"

      # High LLM latency
      - alert: HighLLMLatency
        expr: |
          histogram_quantile(0.95, rate(meer_llm_latency_seconds_bucket[5m])) > 30
        for: 5m
        annotations:
          summary: "P95 LLM latency > 30s for {{ $labels.provider }}/{{ $labels.model }}"
```

### Grafana Dashboard

Example panels:

1. **Tool Execution Rate** (graph)
   ```promql
   rate(meer_tool_calls_total[5m])
   ```

2. **Tool Success Rate** (gauge)
   ```promql
   rate(meer_tool_calls_total{status="success"}[5m]) / rate(meer_tool_calls_total[5m]) * 100
   ```

3. **Circuit Breaker Status** (state timeline)
   ```promql
   meer_circuit_breaker_state
   ```

4. **Active MCP Connections** (graph)
   ```promql
   meer_mcp_active_connections
   ```

5. **LLM Request Latency** (heatmap)
   ```promql
   rate(meer_llm_latency_seconds_bucket[5m])
   ```

6. **Context Window Usage** (histogram)
   ```promql
   meer_context_window_usage_ratio
   ```

7. **Token Usage** (stacked graph)
   ```promql
   rate(meer_llm_tokens_total{type="prompt"}[5m])
   rate(meer_llm_tokens_total{type="completion"}[5m])
   ```

### Log Queries (Loki/CloudWatch)

```
# All errors in last hour
{service="meer-cli"} |= "error" | json | timestamp > now() - 1h

# Tool execution failures
{service="meer-cli"} |= "Tool execution failed" | json

# Circuit breaker events
{service="meer-cli"} |= "Circuit breaker" | json

# Context pruning events
{service="meer-cli"} |= "Context window pruned" | json

# MCP reconnection attempts
{service="meer-cli"} |= "reconnect" | json
```

---

## Best Practices

### 1. Monitor Key Metrics

Essential metrics to track:
- Tool success rate (should be > 95%)
- Circuit breaker state (should be CLOSED)
- MCP connection count (should match config)
- LLM latency P95 (< 30s for good UX)
- Context usage (< 70% to avoid frequent pruning)

### 2. Set Up Alerts

Critical alerts:
- Circuit breaker OPEN for > 2min
- MCP server disconnected for > 5min
- Tool error rate > 10%
- Context usage > 90%

### 3. Log Analysis

Regular log reviews:
- Check error.log daily
- Investigate repeated failures
- Monitor retry patterns
- Track context pruning frequency

### 4. Performance Optimization

Use metrics to identify:
- Slow tools (high latency)
- Frequently failing tools
- Circuit breaker trips
- Excessive retries
- Frequent context pruning

### 5. Capacity Planning

Monitor trends:
- Total tool calls per day
- Token usage per model
- Context pruning frequency
- MCP server load

---

## Troubleshooting

### Circuit Breaker Stuck OPEN

**Symptoms**: Tools fail with "Circuit breaker is OPEN"

**Diagnosis**:
```typescript
const status = mcpClient.getCircuitBreakerStatus();
console.log(status);
```

**Resolution**:
1. Check MCP server health
2. Review error logs for root cause
3. Fix underlying issue
4. Reset circuit breaker:
   ```typescript
   mcpClient.resetCircuitBreaker();
   ```

### High Context Pruning Frequency

**Symptoms**: Frequent "Context window pruned" messages

**Diagnosis**: Check `meer_context_pruning_total` metric

**Resolution**:
1. Use smaller system prompts
2. Reduce tool output verbosity
3. Implement summarization for long conversations
4. Consider model with larger context window

### Tool Execution Timeouts

**Symptoms**: Tools fail with timeout errors

**Diagnosis**: Check `meer_tool_latency_seconds` histogram

**Resolution**:
1. Increase timeout in MCP server config
2. Optimize slow tools
3. Consider async execution for long operations

### Memory Leaks

**Symptoms**: Increasing memory usage over time

**Diagnosis**: Check Node.js memory usage

**Resolution**:
1. Review logs for unbounded arrays
2. Check for retained event listeners
3. Monitor message array size
4. Ensure proper cleanup in finally blocks

---

## Future Enhancements

Planned improvements:

1. **Distributed Tracing**: OpenTelemetry integration for end-to-end traces
2. **Custom Dashboards**: Pre-built Grafana dashboards
3. **Health Checks**: HTTP endpoint exposing health status
4. **Metrics Export**: Background process to export metrics
5. **Log Shipping**: Automatic shipping to Loki/CloudWatch
6. **Rate Limiting**: Per-tool and per-server rate limits
7. **Cost Tracking**: More detailed LLM cost attribution
8. **Anomaly Detection**: ML-based anomaly detection on metrics

---

## Summary

Meer CLI now includes comprehensive observability:

✅ **Structured Logging** - Winston with multiple transports
✅ **Metrics Collection** - Prometheus client with 20+ metrics
✅ **Circuit Breaker** - Prevent cascading failures
✅ **Retry Logic** - Exponential backoff for transient errors
✅ **Context Management** - Automatic pruning to prevent errors
✅ **Telemetry Wrappers** - Easy instrumentation for all operations
✅ **Integration** - Automatic tracking in all key components

These features provide production-grade reliability and observability, making Meer CLI suitable for enterprise deployment.

For questions or issues, please file a GitHub issue or consult the source code documentation.
