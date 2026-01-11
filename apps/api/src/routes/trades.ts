import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { pool } from "../db.js";
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

export const tradesRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();
  const MAX_TOKEN_IDS = 200;

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
