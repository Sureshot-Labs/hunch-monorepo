import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { pool } from "../db.js";
import { env } from "../env.js";
import { isSearchStatementTimeout } from "../lib/postgres-errors.js";
import { fetchFeedCategoryFacetRows } from "../repos/unified-read.js";
import { getRedis } from "../redis.js";
import {
  feedFacetQuerySchema,
  resolveMinTotalVolumeFilter,
} from "../schemas/feed.js";

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

  z.get(
    "/meta/categories/facets",
    {
      schema: {
        querystring: feedFacetQuerySchema,
      },
    },
    async (req, reply) => {
      const q = req.query;
      const minVol = resolveMinTotalVolumeFilter(q);
      const minLiquidity = q.min_liquidity;
      const search = q.q;
      const view: "events" | "markets" =
        q.view === "markets" ? "markets" : "events";
      const eventScope: "grouped" | "single" | undefined =
        q.event_scope === "grouped"
          ? "grouped"
          : q.event_scope === "single"
            ? "single"
            : undefined;
      const venues = q.venue;
      const filter = q.filter;
      const minProb = q.min_prob;
      const maxProb = q.max_prob;
      const maxSpread = q.max_spread;
      const endWithinHours = q.end_within_hours;
      const ageWithinHours = q.age_within_hours;

      const venueKey = venues?.length ? venues.join(",") : "";
      const cacheKey = `meta:categories:facets:v2:${view}:${eventScope ?? ""}:${minVol}:${minLiquidity}:${search ?? ""}:${venueKey}:${minProb ?? ""}:${maxProb ?? ""}:${maxSpread ?? ""}:${endWithinHours ?? ""}:${ageWithinHours ?? ""}:${filter ?? ""}`;
      const r = await getRedis();
      const cacheTtl = Math.max(1, env.feedTtlSec);
      const cacheEnabled = env.feedTtlSec > 0;

      if (cacheEnabled && r) {
        const cached = await r.get(cacheKey);
        if (cached) {
          reply.header("x-cache", "hit");
          reply.header("Content-Type", "application/json; charset=utf-8");
          reply.header(
            "Cache-Control",
            `private, max-age=${cacheTtl}, stale-while-revalidate=${cacheTtl * 2}`,
          );
          return reply.send(cached);
        }
      }

      const nowTs = new Date();
      const nowParam = nowTs.toISOString();
      const sevenDaysAgo = new Date(
        nowTs.getTime() - 7 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const sevenDaysFromNow = new Date(
        nowTs.getTime() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString();

      const endWithin =
        endWithinHours != null
          ? new Date(
              nowTs.getTime() + endWithinHours * 60 * 60 * 1000,
            ).toISOString()
          : undefined;
      const ageSince =
        ageWithinHours != null
          ? new Date(
              nowTs.getTime() - ageWithinHours * 60 * 60 * 1000,
            ).toISOString()
          : undefined;

      let facetRowsResult: Awaited<
        ReturnType<typeof fetchFeedCategoryFacetRows>
      >;
      let universeRowsResult: { rows: Array<{ category: string }> };
      try {
        [facetRowsResult, universeRowsResult] = await Promise.all([
          fetchFeedCategoryFacetRows(pool, {
            minVol,
            minLiquidity,
            q: search,
            view,
            eventScope,
            venues,
            filter,
            minProb,
            maxProb,
            maxSpread,
            endWithin,
            ageSince,
            nowParam,
            sevenDaysAgo,
            sevenDaysFromNow,
          }),
          pool.query<{ category: string }>(`
            select distinct lower(category) as category
            from unified_events
            where status = 'ACTIVE'
              and category is not null
              and btrim(category) <> ''
            order by lower(category) asc
          `),
        ]);
      } catch (error) {
        if (isSearchStatementTimeout(error, search)) {
          req.log.warn(
            { error, q: search, view },
            "Category facet search timed out",
          );
          return reply.code(504).send({ error: "Search timed out" });
        }
        throw error;
      }

      const categoriesMap = new Map<
        string,
        { category: string; events: number; venues: Record<string, number> }
      >();

      for (const row of universeRowsResult.rows) {
        const category = row.category;
        categoriesMap.set(category, {
          category,
          events: 0,
          venues: {},
        });
      }

      for (const row of facetRowsResult) {
        const entry = categoriesMap.get(row.category) ?? {
          category: row.category,
          events: 0,
          venues: {},
        };
        entry.events += Number(row.events) || 0;
        entry.venues[row.venue] =
          (entry.venues[row.venue] ?? 0) + (row.events || 0);
        categoriesMap.set(row.category, entry);
      }

      const categories = Array.from(categoriesMap.values()).sort((a, b) => {
        if (b.events !== a.events) return b.events - a.events;
        return a.category.localeCompare(b.category);
      });

      const payload = {
        total: categories.length,
        generatedAt: nowTs.toISOString(),
        categories,
      };
      const body = JSON.stringify(payload);

      if (cacheEnabled && r) {
        await r.set(cacheKey, body, { EX: cacheTtl });
        reply.header("x-cache", "miss");
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      reply.header(
        "Cache-Control",
        `private, max-age=${cacheTtl}, stale-while-revalidate=${cacheTtl * 2}`,
      );
      return reply.send(body);
    },
  );

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
      const volumeCoverage = activeMarkets > 0 ? withVolume / activeMarkets : 0;
      const liquidityCoverage =
        activeMarkets > 0 ? withLiquidity / activeMarkets : 0;
      const priceCoverage = activeMarkets > 0 ? withPrice / activeMarkets : 0;
      const score = (volumeCoverage + liquidityCoverage + priceCoverage) / 3;

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
