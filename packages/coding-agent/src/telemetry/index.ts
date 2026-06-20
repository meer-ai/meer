/**
 * Telemetry - Unified Observability Layer
 * Combines logging, metrics, and tracing for comprehensive observability
 */

import { log, PerformanceTimer, createRequestLogger } from '../utils/logger.js';
import { MetricsTracker, toolCallsTotal, toolLatency, toolErrors } from './metrics.js';
import { randomUUID } from 'crypto';

/**
 * Telemetry context for tracking operations
 */
export interface TelemetryContext {
  requestId: string;
  operation: string;
  startTime: number;
  metadata?: Record<string, any>;
}

/**
 * Tool execution telemetry wrapper
 */
export async function withToolTelemetry<T>(
  toolName: string,
  serverName: string,
  fn: () => Promise<T>,
  additionalMeta?: Record<string, any>
): Promise<T> {
  const requestId = randomUUID();
  const logger = createRequestLogger(requestId);
  const perfTimer = new PerformanceTimer(`tool:${toolName}`, { serverName });
  const metricsTracker = new MetricsTracker('tool_execution', {
    tool_name: toolName,
    server_name: serverName,
  });

  // Log start
  logger.info(`Tool execution started: ${toolName}`, {
    tool: toolName,
    server: serverName,
    ...additionalMeta,
  });

  try {
    // Execute the tool
    const result = await fn();

    // Log and record success
    const duration = perfTimer.end({ status: 'success' });
    metricsTracker.success();

    logger.info(`Tool execution completed: ${toolName}`, {
      tool: toolName,
      server: serverName,
      duration,
      status: 'success',
    });

    return result;
  } catch (error) {
    // Log and record failure
    const duration = perfTimer.end({ status: 'failure' });
    metricsTracker.failure(error as Error);

    logger.error(`Tool execution failed: ${toolName}`, error as Error, {
      tool: toolName,
      server: serverName,
      duration,
    });

    throw error;
  }
}

/**
 * LLM request telemetry wrapper
 */
export async function withLLMTelemetry<T>(
  provider: string,
  model: string,
  fn: () => Promise<T>,
  additionalMeta?: Record<string, any>
): Promise<T> {
  const requestId = randomUUID();
  const logger = createRequestLogger(requestId);
  const perfTimer = new PerformanceTimer(`llm:${provider}:${model}`);
  const metricsTracker = new MetricsTracker('llm_request', {
    provider,
    model,
  });

  logger.debug(`LLM request started: ${provider}/${model}`, {
    provider,
    model,
    ...additionalMeta,
  });

  try {
    const result = await fn();
    const duration = perfTimer.end({ status: 'success' });
    metricsTracker.success();

    logger.debug(`LLM request completed: ${provider}/${model}`, {
      provider,
      model,
      duration,
      status: 'success',
    });

    return result;
  } catch (error) {
    const duration = perfTimer.end({ status: 'failure' });
    metricsTracker.failure(error as Error);

    logger.error(`LLM request failed: ${provider}/${model}`, error as Error, {
      provider,
      model,
      duration,
    });

    throw error;
  }
}

/**
 * MCP connection telemetry wrapper
 */
export async function withMCPConnectionTelemetry<T>(
  serverName: string,
  fn: () => Promise<T>
): Promise<T> {
  const logger = createRequestLogger(randomUUID());
  const perfTimer = new PerformanceTimer(`mcp:connect:${serverName}`);

  logger.info(`MCP connection starting: ${serverName}`, { server: serverName });

  try {
    const result = await fn();
    const duration = perfTimer.end({ status: 'success' });

    log.mcp(serverName, 'connect', { duration, status: 'success' });

    return result;
  } catch (error) {
    const duration = perfTimer.end({ status: 'failure' });

    log.mcp(serverName, 'error', {
      duration,
      error: (error as Error).message,
    });

    throw error;
  }
}

/**
 * Generic operation telemetry wrapper
 */
export async function withTelemetry<T>(
  operation: string,
  fn: () => Promise<T>,
  meta?: Record<string, any>
): Promise<T> {
  const requestId = randomUUID();
  const logger = createRequestLogger(requestId);
  const perfTimer = new PerformanceTimer(operation, meta);

  logger.debug(`Operation started: ${operation}`, meta);

  try {
    const result = await fn();
    const duration = perfTimer.end({ status: 'success' });

    logger.debug(`Operation completed: ${operation}`, {
      ...meta,
      duration,
      status: 'success',
    });

    return result;
  } catch (error) {
    const duration = perfTimer.end({ status: 'failure' });

    logger.error(`Operation failed: ${operation}`, error as Error, {
      ...meta,
      duration,
    });

    throw error;
  }
}

/**
 * Batch operation telemetry
 */
export async function withBatchTelemetry<T>(
  operation: string,
  items: T[],
  fn: (item: T) => Promise<any>,
  concurrency: number = 5
): Promise<Array<{ item: T; result?: any; error?: Error }>> {
  const logger = createRequestLogger(randomUUID());
  const perfTimer = new PerformanceTimer(`batch:${operation}`, {
    totalItems: items.length,
    concurrency,
  });

  logger.info(`Batch operation started: ${operation}`, {
    operation,
    totalItems: items.length,
    concurrency,
  });

  const results: Array<{ item: T; result?: any; error?: Error }> = [];
  let successCount = 0;
  let failureCount = 0;

  // Process in batches
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, Math.min(i + concurrency, items.length));

    const batchResults = await Promise.allSettled(
      batch.map(item => fn(item))
    );

    batchResults.forEach((result, index) => {
      const item = batch[index];

      if (result.status === 'fulfilled') {
        results.push({ item, result: result.value });
        successCount++;
      } else {
        results.push({ item, error: result.reason });
        failureCount++;
      }
    });
  }

  const duration = perfTimer.end({
    successCount,
    failureCount,
  });

  logger.info(`Batch operation completed: ${operation}`, {
    operation,
    totalItems: items.length,
    successCount,
    failureCount,
    duration,
  });

  return results;
}

/**
 * Export all telemetry utilities
 */
export * from './metrics.js';
export { log, createRequestLogger, createComponentLogger, PerformanceTimer } from '../utils/logger.js';
export { CircuitState } from '../mcp/circuitBreaker.js';
