// Distributed Redis-based token bucket rate limiter
// This ensures rate limiting works across multiple worker instances

import { Redis } from 'ioredis';

export interface RateLimiterConfig {
  maxTokens: number; // Maximum tokens in bucket
  refillRate: number; // Tokens per second
  keyPrefix: string; // Redis key prefix (e.g., 'rate:polymarket:')
}

export class DistributedRateLimiter {
  private redis: Redis;
  private config: RateLimiterConfig;

  constructor(redis: Redis, config: RateLimiterConfig) {
    this.redis = redis;
    this.config = config;
  }

  /**
   * Try to acquire tokens. Returns true if successful, false if rate limit exceeded.
   */
  async tryAcquire(tokens: number = 1, identifier: string = 'default'): Promise<boolean> {
    const key = `${this.config.keyPrefix}${identifier}`;
    const now = Date.now();

    // Lua script for atomic token bucket algorithm
    const script = `
      local key = KEYS[1]
      local max_tokens = tonumber(ARGV[1])
      local refill_rate = tonumber(ARGV[2])
      local tokens_requested = tonumber(ARGV[3])
      local now = tonumber(ARGV[4])

      -- Get current bucket state
      local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
      local current_tokens = tonumber(bucket[1]) or max_tokens
      local last_refill = tonumber(bucket[2]) or now

      -- Calculate refill
      local elapsed_seconds = (now - last_refill) / 1000
      local refill_amount = elapsed_seconds * refill_rate
      current_tokens = math.min(max_tokens, current_tokens + refill_amount)

      -- Check if we have enough tokens
      if current_tokens >= tokens_requested then
        current_tokens = current_tokens - tokens_requested
        redis.call('HMSET', key, 'tokens', current_tokens, 'last_refill', now)
        redis.call('EXPIRE', key, 300) -- 5 minute TTL
        return 1
      else
        return 0
      end
    `;

    const result = await this.redis.eval(
      script,
      1,
      key,
      this.config.maxTokens.toString(),
      this.config.refillRate.toString(),
      tokens.toString(),
      now.toString()
    ) as number;

    return result === 1;
  }

  /**
   * Wait until tokens are available. Uses exponential backoff.
   */
  async waitForTokens(tokens: number = 1, identifier: string = 'default', maxWaitMs: number = 60000): Promise<void> {
    const startTime = Date.now();
    let attempt = 0;

    while (Date.now() - startTime < maxWaitMs) {
      if (await this.tryAcquire(tokens, identifier)) {
        return;
      }

      // Exponential backoff: 100ms, 200ms, 400ms, 800ms, 1600ms (max)
      const backoffMs = Math.min(100 * Math.pow(2, attempt), 1600);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      attempt++;
    }

    throw new Error(`Rate limiter timeout after ${maxWaitMs}ms waiting for ${tokens} tokens`);
  }

  /**
   * Get current token count (for monitoring/debugging)
   */
  async getCurrentTokens(identifier: string = 'default'): Promise<number> {
    const key = `${this.config.keyPrefix}${identifier}`;
    const result = await this.redis.hget(key, 'tokens');
    return result ? parseFloat(result) : this.config.maxTokens;
  }

  /**
   * Reset the rate limiter (useful for testing or emergency reset)
   */
  async reset(identifier: string = 'default'): Promise<void> {
    const key = `${this.config.keyPrefix}${identifier}`;
    await this.redis.del(key);
  }
}

/**
 * Create rate limiter instances for each exchange
 */
export function createExchangeRateLimiters(redis: Redis) {
  return {
    polymarket: new DistributedRateLimiter(redis, {
      keyPrefix: 'rate:polymarket:',
      maxTokens: 100, // Conservative: 100 requests
      refillRate: 6.67, // ~6.67/sec = 400/min
    }),

    kalshiRead: new DistributedRateLimiter(redis, {
      keyPrefix: 'rate:kalshi:read:',
      maxTokens: 18,
      refillRate: 18, // 18/sec as documented
    }),

    kalshiWrite: new DistributedRateLimiter(redis, {
      keyPrefix: 'rate:kalshi:write:',
      maxTokens: 9,
      refillRate: 9, // 9/sec as documented
    }),

    limitless: new DistributedRateLimiter(redis, {
      keyPrefix: 'rate:limitless:',
      maxTokens: 60, // Conservative estimate
      refillRate: 4, // ~4/sec = 240/min
    }),
  };
}

/**
 * Retry-After header parsing utility
 */
export function parseRetryAfter(retryAfterHeader: string | null): number {
  if (!retryAfterHeader) return 0;

  // If it's a number of seconds
  if (/^\d+$/.test(retryAfterHeader)) {
    return parseInt(retryAfterHeader, 10) * 1000; // Convert to ms
  }

  // If it's an HTTP date
  try {
    const retryDate = new Date(retryAfterHeader);
    const delayMs = retryDate.getTime() - Date.now();
    return Math.max(0, delayMs);
  } catch {
    return 0;
  }
}

/**
 * Rate limit error with retry information
 */
export class RateLimitError extends Error {
  constructor(
    public retryAfterMs: number,
    public source: string
  ) {
    super(`Rate limit exceeded for ${source}. Retry after ${retryAfterMs}ms`);
    this.name = 'RateLimitError';
  }
}

