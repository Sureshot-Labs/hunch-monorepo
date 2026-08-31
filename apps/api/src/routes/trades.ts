import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { pool } from "../db.js";
import { env } from "../env.js";
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

export const RECENT_TRADES_BY_TOKEN_SQL = `
  with requested_tokens as (
    select distinct requested_token.token_id
    from unnest($1::text[]) as requested_token(token_id)
  )
  select
    recent_trade.token_id,
    recent_trade.venue,
    recent_trade.ts,
    recent_trade.price,
    recent_trade.size,
    recent_trade.side,
    recent_trade.tx_hash
  from requested_tokens
  cross join lateral (
    select token_trade.token_id,
           token_trade.venue,
           token_trade.ts,
           token_trade.price,
           token_trade.size,
           token_trade.side,
           token_trade.tx_hash
    from unified_last_trade token_trade
    where token_trade.token_id = requested_tokens.token_id
    order by token_trade.ts desc
    limit $4
  ) recent_trade
  order by recent_trade.ts desc
  limit $2 offset $3
`;

export const COUNT_TRADES_BY_TOKEN_SQL = `
  with requested_tokens as (
    select distinct requested_token.token_id
    from unnest($1::text[]) as requested_token(token_id)
  )
  select coalesce(sum(token_total.trade_count), 0)::text as total
  from requested_tokens
  cross join lateral (
    select count(*)::bigint as trade_count
    from unified_last_trade token_trade
    where token_trade.token_id = requested_tokens.token_id
  ) token_total
`;

export const MAX_TRADES_TOKEN_IDS = 200;
export const MAX_TRADES_QUERY_WORK = 25_000;
export const RESOLVE_TRADES_TOKEN_IDS_LIMIT = MAX_TRADES_TOKEN_IDS + 1;
export const TRADES_DB_STATEMENT_TIMEOUT_MS = 1_500;

export function tradesQueryWork(input: {
  tokenCount: number;
  limit: number;
  offset: number;
}): number {
  return input.tokenCount * (input.limit + input.offset);
}

function isPostgresStatementTimeout(error: unknown): boolean {
  return (
    error != null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "57014"
  );
}

export const tradesRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();
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
          limit $2
        `,
        [marketId, RESOLVE_TRADES_TOKEN_IDS_LIMIT],
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
          limit $2
        `,
        [eventId, RESOLVE_TRADES_TOKEN_IDS_LIMIT],
      );
      return rows.map((row) => row.token_id);
    }

    return null;
  };

  const filterKnownTokenIds = async (tokenIds: string[]): Promise<string[]> => {
    if (!tokenIds.length) return [];

    const { rows } = await pool.query<{ token_id: string }>(
      `
        select token_id
        from unified_tokens
        where token_id = any($1::text[])
        union
        select token_id
        from unified_market_tokens
        where token_id = any($1::text[])
      `,
      [tokenIds],
    );
    const known = new Set(rows.map((row) => row.token_id));
    return tokenIds.filter((tokenId) => known.has(tokenId));
  };

  z.get(
    "/trades",
    {
      schema: { querystring: tradesQuerySchema },
    },
    async (request, reply) => {
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

      if (query.tokenIds && query.tokenIds.length > MAX_TRADES_TOKEN_IDS) {
        return {
          error: "tokenIds length exceeded",
          message: `Max ${MAX_TRADES_TOKEN_IDS} tokenIds allowed per request.`,
        };
      }

      const tokenIds = Array.from(
        new Set(
          query.tokenIds
            ? await filterKnownTokenIds(query.tokenIds)
            : ((await resolveTokenIdsForFilter(
                query.marketId,
                query.eventId,
              )) ?? []),
        ),
      );

      if (tokenIds.length === 0) {
        return {
          trades: [],
          pagination: { total: 0, limit: query.limit, offset: query.offset },
        };
      }

      if (tokenIds.length > MAX_TRADES_TOKEN_IDS) {
        return reply.code(422).send({
          error: "resolved tokenIds length exceeded",
          message: `The requested market scope resolves to more than ${MAX_TRADES_TOKEN_IDS} tokenIds.`,
        });
      }

      const queryWork = tradesQueryWork({
        tokenCount: tokenIds.length,
        limit: query.limit,
        offset: query.offset,
      });
      if (queryWork > MAX_TRADES_QUERY_WORK) {
        return reply.code(422).send({
          error: "trades query work exceeded",
          message:
            "This token and pagination combination is too broad. Request a smaller offset or narrower market scope.",
        });
      }

      // Bound every index walk before the global merge. The previous
      // token_id = any(...) + global ts DESC plan could scan the entire
      // hypertable when the requested tokens had few recent trades.
      const perTokenLimit = query.limit + query.offset;
      let rows: TradeRow[];
      let countRows: Array<{ total: string }>;
      const client = await pool.connect();
      try {
        // Keep the established exact `pagination.total` contract, but never
        // allow either Timescale read to become another hidden two-minute
        // request. Both statements use token-local index plans; PostgreSQL
        // cancels an unexpectedly expensive plan with a typed retryable 503.
        await client.query("begin read only");
        await client.query("select set_config('statement_timeout', $1, true)", [
          `${TRADES_DB_STATEMENT_TIMEOUT_MS}ms`,
        ]);
        const recentResult = await client.query<TradeRow>(
          RECENT_TRADES_BY_TOKEN_SQL,
          [tokenIds, query.limit, query.offset, perTokenLimit],
        );
        const countResult = await client.query<{ total: string }>(
          COUNT_TRADES_BY_TOKEN_SQL,
          [tokenIds],
        );
        await client.query("commit");
        rows = recentResult.rows;
        countRows = countResult.rows;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        if (isPostgresStatementTimeout(error)) {
          return reply.code(503).send({
            error: "trades_query_timeout",
            message: "Recent trades are temporarily unavailable. Try again.",
          });
        }
        throw error;
      } finally {
        client.release();
      }

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
