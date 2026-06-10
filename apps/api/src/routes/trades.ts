import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { pool } from "../db.js";
import { env } from "../env.js";
import { getRedis } from "../redis.js";
import { tradesQuerySchema } from "../schemas/trades.js";

type TradeRow = {
  token_id: string;
  venue: string;
  ts: Date;
  price: string;
  size: string;
  side: "BUY" | "SELL";
  tx_hash: string | null;
};

type PolymarketDataTrade = {
  asset?: string;
  side?: "BUY" | "SELL";
  price?: number;
  size?: number;
  timestamp?: number;
  transactionHash?: string;
};

type HyperliquidRecentTrade = {
  coin?: string;
  side?: string;
  px?: string | number;
  sz?: string | number;
  time?: string | number;
  hash?: string | null;
};

type HyperliquidTokenRef = {
  tokenId: string;
  coin: string;
};

type TradesResponse = {
  trades: Array<{
    tokenId: string;
    venue: string;
    ts: Date | string;
    price: number;
    size: number;
    side: "BUY" | "SELL";
    txHash: string | null;
  }>;
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
};

type HyperliquidFetchResult = {
  trades: TradeRow[];
  attempted: number;
  failed: number;
};

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  json: () => Promise<unknown>;
}>;

const HYPERLIQUID_TOKEN_PREFIX = "hyperliquid:";
const HYPERLIQUID_OFFICIAL_OUTCOME_ASSET_OFFSET = 100_000_000;

function isHyperliquidTokenId(value: string | undefined): boolean {
  return (
    typeof value === "string" && value.startsWith(HYPERLIQUID_TOKEN_PREFIX)
  );
}

function hyperliquidCoinFromHunchTokenId(tokenId: string): string | null {
  if (!tokenId.startsWith(HYPERLIQUID_TOKEN_PREFIX)) return null;
  const assetId = Number(tokenId.slice(HYPERLIQUID_TOKEN_PREFIX.length));
  if (!Number.isSafeInteger(assetId)) return null;
  const coinId = assetId - HYPERLIQUID_OFFICIAL_OUTCOME_ASSET_OFFSET;
  if (!Number.isSafeInteger(coinId) || coinId < 0) return null;
  return `#${coinId}`;
}

function selectHyperliquidTokenRefs(
  tokenIds: string[],
  maxCoins: number,
): HyperliquidTokenRef[] {
  const refs: HyperliquidTokenRef[] = [];
  const seenCoins = new Set<string>();
  const limit = Math.max(0, Math.trunc(maxCoins));
  if (limit <= 0) return refs;

  for (const tokenId of tokenIds) {
    const coin = hyperliquidCoinFromHunchTokenId(tokenId);
    if (!coin || seenCoins.has(coin)) continue;
    refs.push({ tokenId, coin });
    seenCoins.add(coin);
    if (refs.length >= limit) break;
  }

  return refs;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function mapHyperliquidTradeRow(
  tokenIdByCoin: Map<string, string>,
  row: HyperliquidRecentTrade,
): TradeRow | null {
  const coin = typeof row.coin === "string" ? row.coin.trim() : "";
  const tokenId = tokenIdByCoin.get(coin);
  if (!tokenId) return null;

  const price = toFiniteNumber(row.px);
  const size = toFiniteNumber(row.sz);
  const time = toFiniteNumber(row.time);
  if (price == null || price < 0 || price > 1) return null;
  if (size == null || size <= 0) return null;
  if (time == null || time <= 0) return null;

  const side = row.side === "B" ? "BUY" : row.side === "A" ? "SELL" : null;
  if (!side) return null;

  const ts = new Date(time);
  if (Number.isNaN(ts.getTime())) return null;

  return {
    token_id: tokenId,
    venue: "hyperliquid",
    ts,
    price: price.toString(),
    size: size.toString(),
    side,
    tx_hash: typeof row.hash === "string" ? row.hash : null,
  };
}

function sortTradesDesc(left: TradeRow, right: TradeRow): number {
  const timeDelta = right.ts.getTime() - left.ts.getTime();
  if (timeDelta !== 0) return timeDelta;
  const tokenDelta = left.token_id.localeCompare(right.token_id);
  if (tokenDelta !== 0) return tokenDelta;
  return (left.tx_hash ?? "").localeCompare(right.tx_hash ?? "");
}

function toTradesResponse(
  trades: TradeRow[],
  limit: number,
  offset: number,
): TradesResponse {
  const sorted = [...trades].sort(sortTradesDesc);
  const page = sorted.slice(offset, offset + limit);

  return {
    trades: page.map((row) => ({
      tokenId: row.token_id,
      venue: row.venue,
      ts: row.ts,
      price: Number(row.price),
      size: Number(row.size),
      side: row.side,
      txHash: row.tx_hash,
    })),
    pagination: {
      total: sorted.length,
      limit,
      offset,
      hasMore: offset + page.length < sorted.length,
    },
  };
}

function hyperliquidTradesCacheKey(
  refs: HyperliquidTokenRef[],
  limit: number,
  offset: number,
): string {
  const coins = refs
    .map((ref) => ref.coin)
    .sort((left, right) => left.localeCompare(right))
    .join(",");
  return `trades:hyperliquid:v1:${coins}:limit:${limit}:offset:${offset}`;
}

async function fetchHyperliquidRecentTradesForTokenRefs(inputs: {
  refs: HyperliquidTokenRef[];
  infoUrl: string;
  timeoutMs: number;
  fetchFn?: FetchLike;
}): Promise<HyperliquidFetchResult> {
  const fetchFn = inputs.fetchFn ?? fetch;
  const tokenIdByCoin = new Map(
    inputs.refs.map((ref) => [ref.coin, ref.tokenId] as const),
  );

  const results = await Promise.all(
    inputs.refs.map(async (ref) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), inputs.timeoutMs);

      try {
        const response = await fetchFn(inputs.infoUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "recentTrades", coin: ref.coin }),
          signal: controller.signal,
        });
        if (!response.ok) return { trades: [] as TradeRow[], failed: true };

        const payload = await response.json();
        if (!Array.isArray(payload)) {
          return { trades: [] as TradeRow[], failed: true };
        }

        const trades = payload
          .map((entry) =>
            entry && typeof entry === "object"
              ? mapHyperliquidTradeRow(
                  tokenIdByCoin,
                  entry as HyperliquidRecentTrade,
                )
              : null,
          )
          .filter((entry): entry is TradeRow => entry != null);

        return { trades, failed: false };
      } catch {
        return { trades: [] as TradeRow[], failed: true };
      } finally {
        clearTimeout(timeout);
      }
    }),
  );

  return {
    trades: results.flatMap((result) => result.trades),
    attempted: inputs.refs.length,
    failed: results.filter((result) => result.failed).length,
  };
}

export const tradesRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();
  const MAX_TOKEN_IDS = 200;
  const POLY_TRADE_TIMEOUT_MS = 12_000;

  const isPolymarketId = (value: string | undefined): boolean =>
    typeof value === "string" && value.startsWith("polymarket:");

  const resolvePolymarketEventId = async (
    eventId: string,
  ): Promise<number | null> => {
    const raw = eventId.split(":")[1];
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;

    const { rows } = await pool.query<{ venue_event_id: number | null }>(
      `
        select venue_event_id
        from unified_events
        where id = $1
      `,
      [eventId],
    );
    const fallback = rows[0]?.venue_event_id;
    return typeof fallback === "number" && Number.isFinite(fallback)
      ? fallback
      : null;
  };

  const resolvePolymarketConditionId = async (
    marketId: string,
  ): Promise<string | null> => {
    const { rows } = await pool.query<{ condition_id: string | null }>(
      `
        select condition_id
        from unified_markets
        where id = $1
      `,
      [marketId],
    );
    const conditionId = rows[0]?.condition_id ?? null;
    return conditionId && conditionId.trim().length ? conditionId.trim() : null;
  };

  const fetchPolymarketDataTrades = async (inputs: {
    eventId?: string;
    marketId?: string;
    limit: number;
    offset: number;
  }): Promise<TradeRow[] | null> => {
    const params = new URLSearchParams();
    if (inputs.eventId) params.set("eventId", inputs.eventId);
    if (inputs.marketId) params.set("market", inputs.marketId);
    params.set("limit", String(inputs.limit));
    params.set("offset", String(inputs.offset));

    const url = new URL("/trades", env.polymarketDataApiBase);
    url.search = params.toString();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), POLY_TRADE_TIMEOUT_MS);

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as unknown;
      if (!Array.isArray(payload)) return null;

      const trades: TradeRow[] = [];
      for (const entry of payload as PolymarketDataTrade[]) {
        if (!entry || typeof entry !== "object") continue;
        if (typeof entry.asset !== "string" || !entry.asset.trim()) continue;
        const price =
          typeof entry.price === "number" ? entry.price : Number(entry.price);
        const size =
          typeof entry.size === "number" ? entry.size : Number(entry.size);
        const timestamp =
          typeof entry.timestamp === "number"
            ? entry.timestamp
            : Number(entry.timestamp);
        if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
        if (!Number.isFinite(timestamp)) continue;

        trades.push({
          token_id: entry.asset.trim(),
          venue: "polymarket",
          ts: new Date(timestamp * 1000),
          price: price.toString(),
          size: size.toString(),
          side: entry.side === "SELL" ? "SELL" : "BUY",
          tx_hash:
            typeof entry.transactionHash === "string"
              ? entry.transactionHash
              : null,
        });
      }
      return trades;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };

  const resolveTokenIdsForFilter = async (
    marketId: string | undefined,
    eventId: string | undefined,
  ): Promise<string[] | null> => {
    if (marketId) {
      const { rows } = await pool.query<{ token_id: string }>(
        `
          select token_id
          from unified_tokens
          where market_id = $1
          order by case side when 'YES' then 0 when 'NO' then 1 else 2 end,
                   token_id
        `,
        [marketId],
      );
      return rows.map((row) => row.token_id);
    }

    if (eventId) {
      const { rows } = await pool.query<{ token_id: string }>(
        `
          select ut.token_id
          from unified_tokens ut
          join unified_markets m
            on m.id = ut.market_id
          where m.event_id = $1
          order by coalesce(m.volume_24h, m.volume_total, 0) desc nulls last,
                   m.id,
                   case ut.side when 'YES' then 0 when 'NO' then 1 else 2 end,
                   ut.token_id
        `,
        [eventId],
      );
      return rows.map((row) => row.token_id);
    }

    return null;
  };

  z.get(
    "/trades",
    {
      schema: { querystring: tradesQuerySchema },
    },
    async (request) => {
      const query = request.query;

      if (isPolymarketId(query.eventId) || isPolymarketId(query.marketId)) {
        const polyEventId = query.eventId
          ? await resolvePolymarketEventId(query.eventId)
          : null;
        const polyMarketId = query.marketId
          ? await resolvePolymarketConditionId(query.marketId)
          : null;
        if (polyEventId || polyMarketId) {
          const polyTrades = await fetchPolymarketDataTrades({
            eventId: polyEventId ? String(polyEventId) : undefined,
            marketId: polyMarketId ?? undefined,
            limit: query.limit,
            offset: query.offset,
          });
          if (polyTrades) {
            const trades = polyTrades.map((row) => ({
              tokenId: row.token_id,
              venue: row.venue,
              ts: row.ts,
              price: Number(row.price),
              size: Number(row.size),
              side: row.side,
              txHash: row.tx_hash,
            }));
            return {
              trades,
              pagination: {
                total: query.offset + trades.length,
                limit: query.limit,
                offset: query.offset,
                hasMore: trades.length === query.limit,
              },
            };
          }
        }
      }

      const tokenIds =
        query.tokenIds ??
        (await resolveTokenIdsForFilter(query.marketId, query.eventId)) ??
        [];

      if (tokenIds.length === 0) {
        return {
          trades: [],
          pagination: { total: 0, limit: query.limit, offset: query.offset },
        };
      }

      if (
        tokenIds.length > 0 &&
        tokenIds.every((tokenId) => isHyperliquidTokenId(tokenId))
      ) {
        const refs = selectHyperliquidTokenRefs(
          tokenIds,
          env.hyperliquidRecentTradesMaxCoins,
        );
        if (refs.length === 0) {
          return {
            trades: [],
            pagination: { total: 0, limit: query.limit, offset: query.offset },
          };
        }

        const cacheKey = hyperliquidTradesCacheKey(
          refs,
          query.limit,
          query.offset,
        );
        let redis: Awaited<ReturnType<typeof getRedis>> = null;
        try {
          redis = await getRedis();
        } catch {
          redis = null;
        }
        if (redis) {
          try {
            const cached = await redis.get(cacheKey);
            if (cached) {
              return JSON.parse(cached) as TradesResponse;
            }
          } catch {
            // Ignore cache failures and refresh from upstream.
          }
        }

        const result = await fetchHyperliquidRecentTradesForTokenRefs({
          refs,
          infoUrl: env.hyperliquidInfoUrl,
          timeoutMs: env.hyperliquidInfoTimeoutMs,
        });
        const response = toTradesResponse(
          result.trades,
          query.limit,
          query.offset,
        );

        if (
          redis &&
          env.hyperliquidRecentTradesCacheTtlSec > 0 &&
          result.failed < result.attempted
        ) {
          try {
            await redis.set(cacheKey, JSON.stringify(response), {
              EX: env.hyperliquidRecentTradesCacheTtlSec,
            });
          } catch {
            // Cache writes are best effort; trades display should still work.
          }
        }

        return response;
      }

      if (tokenIds.length > MAX_TOKEN_IDS) {
        return {
          error: "tokenIds length exceeded",
          message: `Max ${MAX_TOKEN_IDS} tokenIds allowed per request.`,
        };
      }

      const { rows } = await pool.query<TradeRow>(
        `
          select token_id, venue, ts, price, size, side, tx_hash
          from unified_last_trade
          where token_id = any($1::text[])
          order by ts desc
          limit $2 offset $3
        `,
        [tokenIds, query.limit, query.offset],
      );

      const { rows: countRows } = await pool.query<{ total: string }>(
        `
          select count(*)::text as total
          from unified_last_trade
          where token_id = any($1::text[])
        `,
        [tokenIds],
      );

      const total = Number(countRows[0]?.total ?? 0);
      const trades = rows.map((row) => ({
        tokenId: row.token_id,
        venue: row.venue,
        ts: row.ts,
        price: Number(row.price),
        size: Number(row.size),
        side: row.side,
        txHash: row.tx_hash,
      }));

      return {
        trades,
        pagination: {
          total,
          limit: query.limit,
          offset: query.offset,
          hasMore: query.offset + trades.length < total,
        },
      };
    },
  );
};

export const tradesRouteTestExports = {
  fetchHyperliquidRecentTradesForTokenRefs,
  hyperliquidCoinFromHunchTokenId,
  hyperliquidTradesCacheKey,
  mapHyperliquidTradeRow,
  selectHyperliquidTokenRefs,
  toTradesResponse,
};
