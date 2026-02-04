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
    const timeout = setTimeout(
      () => controller.abort(),
      POLY_TRADE_TIMEOUT_MS,
    );

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
