import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { pool } from "../db.js";
import { getRedis } from "../redis.js";

type CategoryRow = {
  venue: string;
  category: string;
  events: number;
};

type VenueCoverageRow = {
  venue: string;
  active_markets: number;
  markets_with_volume: number;
  markets_with_liquidity: number;
  markets_with_price: number;
};

export const metaRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  z.get("/meta/categories", async (_req, reply) => {
    const cacheKey = "meta:categories:v1";
    const r = await getRedis();

    if (r) {
      const cached = await r.get(cacheKey);
      if (cached) {
        reply.header("x-cache", "hit");
        reply.header("Content-Type", "application/json; charset=utf-8");
        reply.header(
          "Cache-Control",
          "public, max-age=600, stale-while-revalidate=1200",
        );
        return reply.send(cached);
      }
    }

    const { rows } = await pool.query<CategoryRow>(`
      select
        venue,
        lower(category) as category,
        count(*)::int as events
      from unified_events
      where status = 'ACTIVE'
        and category is not null
        and btrim(category) <> ''
      group by venue, lower(category)
      order by events desc, venue asc, category asc
    `);

    const byCategory = new Map<
      string,
      { category: string; events: number; venues: Record<string, number> }
    >();

    for (const row of rows) {
      const category = row.category;
      const entry =
        byCategory.get(category) ??
        (() => {
          const init = {
            category,
            events: 0,
            venues: {} as Record<string, number>,
          };
          byCategory.set(category, init);
          return init;
        })();

      entry.events += Number(row.events) || 0;
      entry.venues[row.venue] =
        (entry.venues[row.venue] ?? 0) + (row.events || 0);
    }

    const categories = Array.from(byCategory.values()).sort((a, b) => {
      if (b.events !== a.events) return b.events - a.events;
      return a.category.localeCompare(b.category);
    });

    const payload = {
      total: categories.length,
      generatedAt: new Date().toISOString(),
      categories,
    };
    const body = JSON.stringify(payload);

    if (r) {
      await r.set(cacheKey, body, { EX: 600 });
      reply.header("x-cache", "miss");
    }

    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header(
      "Cache-Control",
      "public, max-age=600, stale-while-revalidate=1200",
    );
    return reply.send(body);
  });

  z.get("/meta/venues", async (_req, reply) => {
    const cacheKey = "meta:venues:v1";
    const r = await getRedis();

    if (r) {
      const cached = await r.get(cacheKey);
      if (cached) {
        reply.header("x-cache", "hit");
        reply.header("Content-Type", "application/json; charset=utf-8");
        reply.header(
          "Cache-Control",
          "public, max-age=600, stale-while-revalidate=1200",
        );
        return reply.send(cached);
      }
    }

    const { rows } = await pool.query<VenueCoverageRow>(`
      select
        venue,
        count(*) filter (where status = 'ACTIVE')::int as active_markets,
        count(*) filter (
          where status = 'ACTIVE'
            and (coalesce(volume_24h, 0) > 0 or coalesce(volume_total, 0) > 0)
        )::int as markets_with_volume,
        count(*) filter (
          where status = 'ACTIVE'
            and (
              (liquidity is not null and liquidity > 0)
              or (open_interest is not null and open_interest > 0)
            )
        )::int as markets_with_liquidity,
        count(*) filter (
          where status = 'ACTIVE'
            and (best_bid is not null or best_ask is not null or last_price is not null)
        )::int as markets_with_price
      from unified_markets
      group by venue
      order by venue asc
    `);

    const venues = rows.map((row) => {
      const activeMarkets = Number(row.active_markets) || 0;
      const withVolume = Number(row.markets_with_volume) || 0;
      const withLiquidity = Number(row.markets_with_liquidity) || 0;
      const withPrice = Number(row.markets_with_price) || 0;
      const volumeCoverage =
        activeMarkets > 0 ? withVolume / activeMarkets : 0;
      const liquidityCoverage =
        activeMarkets > 0 ? withLiquidity / activeMarkets : 0;
      const priceCoverage =
        activeMarkets > 0 ? withPrice / activeMarkets : 0;
      const score =
        (volumeCoverage + liquidityCoverage + priceCoverage) / 3;

      return {
        venue: row.venue,
        activeMarkets,
        counts: {
          withVolume,
          withLiquidity,
          withPrice,
        },
        coverage: {
          volume: volumeCoverage,
          liquidity: liquidityCoverage,
          price: priceCoverage,
          score,
        },
      };
    });

    const payload = {
      total: venues.length,
      generatedAt: new Date().toISOString(),
      venues,
    };
    const body = JSON.stringify(payload);

    if (r) {
      await r.set(cacheKey, body, { EX: 600 });
      reply.header("x-cache", "miss");
    }

    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header(
      "Cache-Control",
      "public, max-age=600, stale-while-revalidate=1200",
    );
    return reply.send(body);
  });
};
