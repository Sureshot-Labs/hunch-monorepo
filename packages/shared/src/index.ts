import pino from "pino";

export type EventEnvelope<T> = {
  type: string;
  ts: number;
  key?: string;
  source: "polymarket" | "system";
  payload: T;
};

type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";
export const logger = pino({
  level: (process.env.LOG_LEVEL as LogLevel) ?? "info",
  timestamp: pino.stdTimeFunctions.isoTime,
});

// Export unified types and mappers
export * from './types/unified';
export * from './mappers/base';
export * from './mappers/polymarket';
export * from './mappers/kalshi';
export * from './mappers/limitless';
export * from './mappers/factory';
