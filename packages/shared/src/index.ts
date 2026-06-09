import pino from "pino";

export { chunkArray } from "./array.js";
export { sleep } from "./async.js";
export {
  isAbortError,
  isRetryableHttpStatus,
  isRpcRateLimit,
  parseRetryAfterMs,
} from "./errors.js";
export {
  parseMarketTextDates,
  resolveMarketCategory,
  type CanonicalMarketCategory,
  type MarketCategory,
  type MarketCategoryConfidence,
  type MarketCategoryResolution,
  type MarketCategoryResolutionInput,
  type MarketCategorySource,
  type MarketTextDates,
  type MarketTextDateSource,
} from "./market-classification.js";

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
