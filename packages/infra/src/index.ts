export { createPgPool, tx } from "./pg.js";
export {
  formatPgError,
  getPgErrorCode,
  isPgSchemaError,
  isPgSetupIssue,
  isPgUnavailableError,
} from "./pg-errors.js";
export {
  checkRedisReady,
  createRedisClient,
  ensureRedis,
  isRedisLoadingError,
  isRedisRetryableError,
  waitForRedisReady,
} from "./redis.js";
export {
  buildTopMarketsText,
  enqueueEmbedItems,
  getEmbedStreamKey,
} from "./ai-embed.js";
export type { EmbedQueueItem, TopMarketCandidate } from "./ai-embed.js";
export type { Pool, PoolClient, PoolConfig } from "pg";
export type { RedisClientType } from "redis";
export type { RedisReadyOptions } from "./redis.js";
