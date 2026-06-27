export type PriceRefreshVenue = "polymarket" | "dflow" | "limitless";
export type PriceRefreshQueueClaimSide = "oldest" | "newest";
export type PriceRefreshPriority = "high" | "normal";

export type PriceRefreshRedis = {
  zAdd: (
    key: string,
    members: Array<{ score: number; value: string }>,
  ) => Promise<unknown>;
  zCard: (key: string) => Promise<number>;
  zRangeByScore: (
    key: string,
    min: number,
    max: number,
    options?: { LIMIT: { offset: number; count: number } },
  ) => Promise<string[]>;
  zRem: (key: string, members: string[]) => Promise<unknown>;
  zRemRangeByRank: (
    key: string,
    start: number,
    stop: number,
  ) => Promise<unknown>;
  eval: (
    script: string,
    options: { keys: string[]; arguments: string[] },
  ) => Promise<unknown>;
};

export type EnqueuePriceRefreshInputs = {
  tokenIds: Array<string | null | undefined>;
  venue?: PriceRefreshVenue;
  nowMs?: number;
  delayMs?: number;
  maxQueueSize?: number;
  maxTokens?: number;
  priority?: PriceRefreshPriority;
};

export type EnqueuePriceRefreshResult = {
  enqueued: number;
  ignored: number;
  byVenue: Record<PriceRefreshVenue, number>;
};

export type ClaimPriceRefreshInputs = {
  venue: PriceRefreshVenue;
  nowMs?: number;
  limit: number;
  side?: PriceRefreshQueueClaimSide;
};

export type RequeuePriceRefreshInputs = {
  venue: PriceRefreshVenue;
  tokenIds: string[];
  nowMs?: number;
  delayMs: number;
  maxQueueSize?: number;
};

export type PriceRefreshFreshnessDb = {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
};

export type FilterStalePriceRefreshTokensInputs = {
  maxAgeMs: number;
  now?: Date;
};

export type FilterStalePriceRefreshTokensResult = {
  freshTokenIds: string[];
  staleTokenIds: string[];
};

export const PRICE_REFRESH_QUEUE_KEYS: Record<PriceRefreshVenue, string> = {
  polymarket: "price-refresh:tokens:polymarket",
  dflow: "price-refresh:tokens:dflow",
  limitless: "price-refresh:tokens:limitless",
};

const CLAIM_DUE_PRICE_REFRESH_TOKENS_SCRIPT = `
local side = ARGV[3]
local tokens
if side == 'newest' then
  tokens = redis.call('ZREVRANGEBYSCORE', KEYS[1], ARGV[1], '-inf', 'LIMIT', 0, tonumber(ARGV[2]))
else
  tokens = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
end
if #tokens > 0 then
  redis.call('ZREM', KEYS[1], unpack(tokens))
end
return tokens
`;

const ENQUEUE_PRICE_REFRESH_TOKENS_SCRIPT = `
local score = tonumber(ARGV[1])
local added = 0
for i = 2, #ARGV do
  local token = ARGV[i]
  local existing = redis.call('ZSCORE', KEYS[1], token)
  if not existing then
    redis.call('ZADD', KEYS[1], score, token)
    added = added + 1
  elseif score < tonumber(existing) then
    redis.call('ZADD', KEYS[1], score, token)
  end
end
return added
`;

const HIGH_PRIORITY_SCORE_BIAS_MS = 31 * 24 * 60 * 60 * 1_000;

function normalizeTokenId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseTimestampMs(value: unknown): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "string" || typeof value === "number") {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
  }
  return null;
}

function hasFiniteTopPrice(value: unknown): boolean {
  if (value == null) return false;
  const n = Number(value);
  return Number.isFinite(n);
}

export function inferPriceRefreshVenue(
  tokenId: string,
): PriceRefreshVenue | null {
  if (/^\d+$/.test(tokenId)) return "polymarket";
  if (tokenId.startsWith("sol:")) return "dflow";
  if (tokenId.startsWith("limitless:")) return "limitless";
  return null;
}

export function getPriceRefreshQueueKey(venue: PriceRefreshVenue): string {
  return PRICE_REFRESH_QUEUE_KEYS[venue];
}

function emptyResult(): EnqueuePriceRefreshResult {
  return {
    enqueued: 0,
    ignored: 0,
    byVenue: { polymarket: 0, dflow: 0, limitless: 0 },
  };
}

async function trimQueue(
  redis: PriceRefreshRedis,
  key: string,
  maxQueueSize: number | undefined,
): Promise<void> {
  if (maxQueueSize == null || maxQueueSize <= 0) return;
  const size = await redis.zCard(key);
  if (size <= maxQueueSize) return;
  await redis.zRemRangeByRank(key, 0, size - maxQueueSize - 1);
}

async function enqueueTokensPreservingEarliestScore(
  redis: PriceRefreshRedis,
  key: string,
  tokenIds: string[],
  score: number,
): Promise<number> {
  const result = await redis.eval(ENQUEUE_PRICE_REFRESH_TOKENS_SCRIPT, {
    keys: [key],
    arguments: [String(score), ...tokenIds],
  });
  return typeof result === "number" && Number.isFinite(result) ? result : 0;
}

export async function enqueuePriceRefreshTokens(
  redis: PriceRefreshRedis,
  inputs: EnqueuePriceRefreshInputs,
): Promise<EnqueuePriceRefreshResult> {
  const result = emptyResult();
  const maxTokens =
    inputs.maxTokens != null && inputs.maxTokens > 0
      ? Math.trunc(inputs.maxTokens)
      : Number.POSITIVE_INFINITY;
  if (maxTokens <= 0) return result;

  const byVenue = new Map<PriceRefreshVenue, Set<string>>();
  let accepted = 0;
  for (const rawTokenId of inputs.tokenIds) {
    const tokenId = normalizeTokenId(rawTokenId);
    if (!tokenId) {
      result.ignored += 1;
      continue;
    }
    const venue = inputs.venue ?? inferPriceRefreshVenue(tokenId);
    if (!venue) {
      result.ignored += 1;
      continue;
    }
    if (accepted >= maxTokens) {
      result.ignored += 1;
      continue;
    }
    const set = byVenue.get(venue) ?? new Set<string>();
    const before = set.size;
    set.add(tokenId);
    byVenue.set(venue, set);
    if (set.size > before) accepted += 1;
  }

  const priorityBiasMs =
    inputs.priority === "high" ? HIGH_PRIORITY_SCORE_BIAS_MS : 0;
  const dueAtMs = (inputs.nowMs ?? Date.now()) + (inputs.delayMs ?? 0);
  const queueScore = dueAtMs - priorityBiasMs;
  for (const [venue, tokenSet] of byVenue.entries()) {
    const tokens = Array.from(tokenSet);
    if (!tokens.length) continue;
    const key = getPriceRefreshQueueKey(venue);
    await enqueueTokensPreservingEarliestScore(redis, key, tokens, queueScore);
    await trimQueue(redis, key, inputs.maxQueueSize);
    result.byVenue[venue] += tokens.length;
    result.enqueued += tokens.length;
  }

  return result;
}

export async function claimDuePriceRefreshTokens(
  redis: PriceRefreshRedis,
  inputs: ClaimPriceRefreshInputs,
): Promise<string[]> {
  const limit = Math.max(0, Math.trunc(inputs.limit));
  if (limit <= 0) return [];

  const key = getPriceRefreshQueueKey(inputs.venue);
  const side = inputs.side === "newest" ? "newest" : "oldest";
  const result = await redis.eval(CLAIM_DUE_PRICE_REFRESH_TOKENS_SCRIPT, {
    keys: [key],
    arguments: [String(inputs.nowMs ?? Date.now()), String(limit), side],
  });
  if (!Array.isArray(result)) return [];
  return result.filter((value): value is string => typeof value === "string");
}

export async function requeuePriceRefreshTokens(
  redis: PriceRefreshRedis,
  inputs: RequeuePriceRefreshInputs,
): Promise<EnqueuePriceRefreshResult> {
  return enqueuePriceRefreshTokens(redis, {
    tokenIds: inputs.tokenIds,
    venue: inputs.venue,
    nowMs: inputs.nowMs,
    delayMs: inputs.delayMs,
    maxQueueSize: inputs.maxQueueSize,
  });
}

export async function getPriceRefreshQueueBacklog(
  redis: PriceRefreshRedis,
  venue: PriceRefreshVenue,
): Promise<number> {
  return redis.zCard(getPriceRefreshQueueKey(venue));
}

export async function filterStalePriceRefreshTokens(
  db: PriceRefreshFreshnessDb,
  tokenIds: Array<string | null | undefined>,
  inputs: FilterStalePriceRefreshTokensInputs,
): Promise<FilterStalePriceRefreshTokensResult> {
  const orderedTokenIds: string[] = [];
  const seen = new Set<string>();
  for (const rawTokenId of tokenIds) {
    const tokenId = normalizeTokenId(rawTokenId);
    if (!tokenId || seen.has(tokenId)) continue;
    seen.add(tokenId);
    orderedTokenIds.push(tokenId);
  }

  if (!orderedTokenIds.length) {
    return { freshTokenIds: [], staleTokenIds: [] };
  }

  const maxAgeMs = Math.max(0, Math.trunc(inputs.maxAgeMs));
  const nowMs = (inputs.now ?? new Date()).getTime();
  const cutoffMs = nowMs - maxAgeMs;

  const { rows } = await db.query<{
    token_id: string;
    ts: Date | string | number | null;
    best_bid: number | string | null;
    best_ask: number | string | null;
  }>(
    `
      select token_id, ts, best_bid, best_ask
      from unified_token_top_latest
      where token_id = any($1::text[])
    `,
    [orderedTokenIds],
  );

  const byTokenId = new Map(rows.map((row) => [row.token_id, row]));
  const freshTokenIds: string[] = [];
  const staleTokenIds: string[] = [];
  for (const tokenId of orderedTokenIds) {
    const row = byTokenId.get(tokenId);
    const tsMs = parseTimestampMs(row?.ts ?? null);
    const hasTop =
      hasFiniteTopPrice(row?.best_bid) || hasFiniteTopPrice(row?.best_ask);
    if (tsMs != null && tsMs >= cutoffMs && hasTop) {
      freshTokenIds.push(tokenId);
    } else {
      staleTokenIds.push(tokenId);
    }
  }

  return { freshTokenIds, staleTokenIds };
}
