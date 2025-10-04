// Centralized structured logging with pino
import pino from 'pino';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LoggerOptions {
  service: string;
  level?: LogLevel;
  prettyPrint?: boolean;
}

/**
 * Create a logger instance for a service
 */
export function createLogger(options: LoggerOptions) {
  const { service, level = 'info', prettyPrint = process.env.NODE_ENV !== 'production' } = options;

  const logger = pino({
    level: level || (process.env.LOG_LEVEL as LogLevel) || 'info',
    
    // Pretty print in development, JSON in production
    transport: prettyPrint ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
      },
    } : undefined,

    // Base fields for all logs
    base: {
      service,
      env: process.env.NODE_ENV || 'development',
    },

    // Timestamp
    timestamp: pino.stdTimeFunctions.isoTime,

    // Serializers for common objects
    serializers: {
      err: pino.stdSerializers.err,
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
    },

    // Redact sensitive fields
    redact: {
      paths: [
        'password',
        'apiKey',
        'api_key',
        'privateKey',
        'private_key',
        'secret',
        'token',
        'authorization',
        '*.password',
        '*.apiKey',
        '*.privateKey',
      ],
      remove: true,
    },
  });

  return logger;
}

/**
 * Create child logger with additional context
 */
export function createChildLogger(logger: pino.Logger, context: Record<string, any>) {
  return logger.child(context);
}

/**
 * Add correlation ID to logger context
 */
export function withCorrelationId(logger: pino.Logger, correlationId: string) {
  return logger.child({ correlationId });
}

/**
 * Add user context to logger
 */
export function withUserContext(logger: pino.Logger, userId: string, username?: string) {
  return logger.child({ userId, username });
}

/**
 * Add request context to logger
 */
export function withRequestContext(
  logger: pino.Logger,
  requestId: string,
  method: string,
  url: string
) {
  return logger.child({ requestId, method, url });
}

/**
 * Generate correlation ID
 */
export function generateCorrelationId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Log error with context
 */
export function logError(
  logger: pino.Logger,
  error: Error,
  context?: Record<string, any>
) {
  logger.error(
    {
      err: error,
      ...context,
    },
    error.message
  );
}

/**
 * Log HTTP request
 */
export function logRequest(
  logger: pino.Logger,
  method: string,
  url: string,
  statusCode: number,
  duration: number,
  context?: Record<string, any>
) {
  logger.info(
    {
      http: {
        method,
        url,
        statusCode,
        duration,
      },
      ...context,
    },
    `${method} ${url} ${statusCode} ${duration}ms`
  );
}

/**
 * Log database query
 */
export function logQuery(
  logger: pino.Logger,
  query: string,
  duration: number,
  rowCount?: number
) {
  logger.debug(
    {
      db: {
        query: query.substring(0, 200), // Truncate long queries
        duration,
        rowCount,
      },
    },
    `Query executed in ${duration}ms`
  );
}

/**
 * Log rate limit event
 */
export function logRateLimit(
  logger: pino.Logger,
  source: string,
  tokensAvailable: number,
  tokensRequested: number,
  waited: boolean,
  waitTime?: number
) {
  logger[waited ? 'warn' : 'debug'](
    {
      rateLimit: {
        source,
        tokensAvailable,
        tokensRequested,
        waited,
        waitTime,
      },
    },
    waited 
      ? `Rate limited by ${source}, waited ${waitTime}ms` 
      : `Acquired ${tokensRequested} tokens from ${source}`
  );
}

/**
 * Log trading action
 */
export function logTradingAction(
  logger: pino.Logger,
  action: string,
  userId: string,
  orderId: string,
  details: Record<string, any>
) {
  logger.info(
    {
      trading: {
        action,
        userId,
        orderId,
        ...details,
      },
    },
    `Trading action: ${action} for order ${orderId}`
  );
}

/**
 * Log ingestion event
 */
export function logIngestion(
  logger: pino.Logger,
  source: string,
  resourceType: string,
  count: number,
  duration: number,
  success: boolean,
  error?: string
) {
  logger[success ? 'info' : 'error'](
    {
      ingestion: {
        source,
        resourceType,
        count,
        duration,
        success,
        error,
      },
    },
    `Ingested ${count} ${resourceType}(s) from ${source} in ${duration}ms`
  );
}

// Pre-configured loggers for common services
export const loggers = {
  api: createLogger({ service: 'api' }),
  trading: createLogger({ service: 'trading-engine' }),
  analytics: createLogger({ service: 'analytics-engine' }),
  webhooks: createLogger({ service: 'webhook-system' }),
  priceHistory: createLogger({ service: 'price-history' }),
  ingestion: createLogger({ service: 'data-ingestion' }),
  monitoring: createLogger({ service: 'monitoring' }),
  polymarket: createLogger({ service: 'indexer-polymarket' }),
  kalshi: createLogger({ service: 'indexer-kalshi' }),
  limitless: createLogger({ service: 'indexer-limitless' }),
};

