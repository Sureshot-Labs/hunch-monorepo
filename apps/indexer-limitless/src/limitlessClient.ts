import { env } from "./env";
import { LimitlessActiveResponse, TLimitlessMarket } from "./types";
import { getRedis } from "../indexer-polymarket/src/redis"; // Assuming shared redis
import { createExchangeRateLimiters, RateLimitError, parseRetryAfter } from "@hunch/shared/rate-limiter/distributed-rate-limiter";

let rateLimiters: ReturnType<typeof createExchangeRateLimiters> | null = null;

async function getRateLimiters() {
  if (!rateLimiters) {
    const redis = await getRedis();
    rateLimiters = createExchangeRateLimiters(redis);
  }
  return rateLimiters;
}

async function getJson(url: string) {
  const limiters = await getRateLimiters();
  
  // Wait for rate limit token
  await limiters.limitless.waitForTokens(1, 'api');
  
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    
    // Handle rate limiting
    if (r.status === 429) {
      const retryAfterMs = parseRetryAfter(r.headers.get('Retry-After'));
      throw new RateLimitError(retryAfterMs || 60000, 'limitless');
    }
    
    if (!r.ok) throw new Error(`Limitless ${r.status} ${url}`);
    return r.json();
  } catch (error) {
    if (error instanceof RateLimitError) {
      console.warn(`Rate limited by Limitless. Waiting ${error.retryAfterMs}ms`);
      await new Promise(resolve => setTimeout(resolve, error.retryAfterMs));
      // Retry once
      return getJson(url);
    }
    throw error;
  }
}

export async function fetchActivePage(
  page: number,
  limit: number,
  sortBy = "newest"
) {
  const base = env.limitlessBase.replace(/\/+$/, "");
  const url = `${base}/markets/active?page=${page}&limit=${limit}&sortBy=${encodeURIComponent(
    sortBy
  )}`;
  console.log("Fetching Limitless active page", page, limit, sortBy, url);
  const j = await getJson(url);
  const parsed = LimitlessActiveResponse.parse(j);
  return parsed;
}

export async function fetchAllActive(maxPages: number, pageSize: number) {
  const out: TLimitlessMarket[] = [];
  for (let p = 1; p <= maxPages; p++) {
    const res = await fetchActivePage(p, pageSize, "newest");
    if (!res.data.length) break;
    out.push(...res.data);
    // Rate limiter handles delays automatically
    if (res.totalPages && p >= res.totalPages) break;
  }
  return out;
}
