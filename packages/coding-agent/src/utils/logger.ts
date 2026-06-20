/**
 * Structured Logging with Winston
 * Provides consistent, structured logging across the application
 */

import winston from 'winston';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Log directory
const LOG_DIR = path.join(os.homedir(), '.meer', 'logs');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Custom format for console output
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ level, message, timestamp, requestId, ...meta }) => {
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    const reqId = requestId && typeof requestId === 'string' ? ` [${requestId.substring(0, 8)}]` : '';
    return `${timestamp}${reqId} ${level}: ${message}${metaStr}`;
  })
);

// JSON format for file output
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Determine log level from environment
const logLevel = process.env.LOG_LEVEL || process.env.MEER_LOG_LEVEL || 'info';
const isVerbose = process.env.MEER_VERBOSE === 'true' || process.env.DEBUG === 'true';

/**
 * Main application logger
 */
export const logger = winston.createLogger({
  level: isVerbose ? 'debug' : logLevel,
  defaultMeta: {
    service: 'meer-cli',
    version: process.env.npm_package_version || '0.0.0',
    pid: process.pid,
  },
  transports: [
    // Console output (only warnings and errors by default)
    new winston.transports.Console({
      level: isVerbose ? 'debug' : 'warn',
      format: consoleFormat,
      silent: process.env.MEER_SILENT === 'true',
    }),

    // Combined log file (all levels)
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'combined.log'),
      format: fileFormat,
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      tailable: true,
    }),

    // Error log file (errors only)
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
      format: fileFormat,
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      tailable: true,
    }),
  ],

  // Handle exceptions and rejections
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'exceptions.log'),
      format: fileFormat,
    }),
  ],
  rejectionHandlers: [
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'rejections.log'),
      format: fileFormat,
    }),
  ],
});

/**
 * Create a child logger with additional context
 */
export function createLogger(context: Record<string, any>): winston.Logger {
  return logger.child(context);
}

/**
 * Create a request-scoped logger with correlation ID
 */
export function createRequestLogger(requestId: string): winston.Logger {
  return logger.child({ requestId });
}

/**
 * Create a component-specific logger
 */
export function createComponentLogger(component: string): winston.Logger {
  return logger.child({ component });
}

/**
 * Log levels for convenience
 */
export const LogLevel = {
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
  HTTP: 'http',
  VERBOSE: 'verbose',
  DEBUG: 'debug',
  SILLY: 'silly',
} as const;

/**
 * Structured log helpers
 */
export const log = {
  /**
   * Log an error with stack trace
   */
  error: (message: string, error?: Error, meta?: Record<string, any>) => {
    if (error) {
      logger.error(message, {
        error: {
          message: error.message,
          stack: error.stack,
          name: error.name,
        },
        ...meta,
      });
    } else {
      logger.error(message, meta);
    }
  },

  /**
   * Log a warning
   */
  warn: (message: string, meta?: Record<string, any>) => {
    logger.warn(message, meta);
  },

  /**
   * Log an info message
   */
  info: (message: string, meta?: Record<string, any>) => {
    logger.info(message, meta);
  },

  /**
   * Log a debug message (only in verbose mode)
   */
  debug: (message: string, meta?: Record<string, any>) => {
    logger.debug(message, meta);
  },

  /**
   * Log an HTTP request/response
   */
  http: (method: string, url: string, statusCode?: number, duration?: number) => {
    logger.http('HTTP Request', {
      method,
      url,
      statusCode,
      duration,
    });
  },

  /**
   * Log tool execution
   */
  tool: (
    toolName: string,
    status: 'start' | 'success' | 'failure',
    meta?: Record<string, any>
  ) => {
    const level = status === 'failure' ? 'error' : 'info';
    logger.log(level, `Tool ${status}: ${toolName}`, {
      tool: toolName,
      status,
      ...meta,
    });
  },

  /**
   * Log MCP server event
   */
  mcp: (
    serverName: string,
    event: 'connect' | 'disconnect' | 'error' | 'reconnect',
    meta?: Record<string, any>
  ) => {
    const level = event === 'error' ? 'error' : 'info';
    logger.log(level, `MCP ${event}: ${serverName}`, {
      server: serverName,
      event,
      ...meta,
    });
  },

  /**
   * Log performance metric
   */
  perf: (operation: string, duration: number, meta?: Record<string, any>) => {
    logger.info(`Performance: ${operation}`, {
      operation,
      duration,
      unit: 'ms',
      ...meta,
    });
  },

  /**
   * Log security event
   */
  security: (event: string, meta?: Record<string, any>) => {
    logger.warn(`Security: ${event}`, {
      security: true,
      event,
      ...meta,
    });
  },
};

/**
 * Performance measurement utility
 */
export class PerformanceTimer {
  private startTime: number;
  private name: string;
  private meta?: Record<string, any>;

  constructor(name: string, meta?: Record<string, any>) {
    this.name = name;
    this.meta = meta;
    this.startTime = Date.now();
    log.debug(`Starting: ${name}`, meta);
  }

  /**
   * End timing and log result
   */
  end(additionalMeta?: Record<string, any>): number {
    const duration = Date.now() - this.startTime;
    log.perf(this.name, duration, { ...this.meta, ...additionalMeta });
    return duration;
  }

  /**
   * Mark a checkpoint without ending the timer
   */
  checkpoint(label: string): number {
    const elapsed = Date.now() - this.startTime;
    log.debug(`Checkpoint ${label} for ${this.name}: ${elapsed}ms`);
    return elapsed;
  }
}

/**
 * Get log file paths
 */
export function getLogPaths() {
  return {
    combined: path.join(LOG_DIR, 'combined.log'),
    error: path.join(LOG_DIR, 'error.log'),
    exceptions: path.join(LOG_DIR, 'exceptions.log'),
    rejections: path.join(LOG_DIR, 'rejections.log'),
  };
}

/**
 * Tail logs (for CLI commands)
 */
export function tailLogs(lines: number = 50): string[] {
  const logFile = path.join(LOG_DIR, 'combined.log');

  if (!fs.existsSync(logFile)) {
    return [];
  }

  const content = fs.readFileSync(logFile, 'utf-8');
  const allLines = content.split('\n').filter(Boolean);

  return allLines.slice(-lines);
}

// Log startup
logger.info('Logger initialized', {
  logLevel,
  logDir: LOG_DIR,
  isVerbose,
});
