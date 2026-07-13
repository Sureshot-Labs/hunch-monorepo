import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  getVenueLifecycleCapabilities,
  HUNCH_VENUES,
  normalizeHunchVenue,
  venueHasLifecycleCapability,
} from "@hunch/shared";

import { pool } from "../db.js";
import { env } from "../env.js";
import { isSearchStatementTimeout } from "../lib/postgres-errors.js";
import { fetchFeedCategoryFacetRows } from "../repos/unified-read.js";
import { getRedis } from "../redis.js";
import {
  feedFacetQuerySchema,
  resolveMinTotalVolumeFilter,
} from "../schemas/feed.js";
import { resolveVenueLifecyclePolicy } from "../services/runtime-policies.js";

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
    const lifecycle = await resolveVenueLifecyclePolicy(pool);
    const discoverableVenues = HUNCH_VENUES.filter((venue) =>
      venueHasLifecycleCapability(lifecycle.effective, venue, "discovery"),
    );
    const cacheKey = `meta:categories:v2:${lifecycle.revision}`;
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

    const { rows } = await pool.query<CategoryRow>(
      `
      select
        venue,
        lower(category) as category,
        count(*)::int as events
      from unified_events
      where status = 'ACTIVE'
        and venue = any($1::text[])
        and category is not null
        and btrim(category) <> ''
      group by venue, lower(category)
      order by events desc, venue asc, category asc
    `,
      [discoverableVenues],
    );

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
      const lifecycle = await resolveVenueLifecyclePolicy(pool);
      const requestedVenues = q.venue ?? HUNCH_VENUES;
      const venues = requestedVenues.filter((venue) =>
        venueHasLifecycleCapability(lifecycle.effective, venue, "discovery"),
      );
      const filter = q.filter;
      const minProb = q.min_prob;
      const maxProb = q.max_prob;
      const maxSpread = q.max_spread;
      const durationMinutes = q.duration_minutes;
      const durationKey = durationMinutes?.join(",") ?? "";
      const endWithinHours = q.end_within_hours;
      const ageWithinHours = q.age_within_hours;

      const venueKey = venues?.length ? venues.join(",") : "";
      const cacheKey = `meta:categories:facets:v5:${lifecycle.revision}:${view}:${eventScope ?? ""}:${minVol}:${minLiquidity}:${search ?? ""}:${venueKey}:${minProb ?? ""}:${maxProb ?? ""}:${maxSpread ?? ""}:${durationKey}:${endWithinHours ?? ""}:${ageWithinHours ?? ""}:${filter ?? ""}`;
      const staleCacheKey = `${cacheKey}:stale`;
      const refreshLockKey = `${cacheKey}:refresh`;
      const r = await getRedis();
      const cacheTtl = Math.max(1, env.feedTtlSec);
      const staleTtl = Math.max(cacheTtl * 10, 300);
      const cacheEnabled = env.feedTtlSec > 0;

      const computeBody = async (): Promise<string> => {
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

        const [facetRowsResult, universeRowsResult] = await Promise.all([
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
            durationMinutes,
            endWithin,
            ageSince,
            nowParam,
            sevenDaysAgo,
            sevenDaysFromNow,
          }),
          pool.query<{ category: string }>(
            `
              select distinct lower(category) as category
              from unified_events
              where status = 'ACTIVE'
                and venue = any($1::text[])
                and category is not null
                and btrim(category) <> ''
              order by category asc
            `,
            [venues],
          ),
        ]);

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
        return JSON.stringify(payload);
      };

      const storeBody = async (body: string): Promise<void> => {
        if (!cacheEnabled || !r) return;
        await Promise.all([
          r.set(cacheKey, body, { EX: cacheTtl }),
          r.set(staleCacheKey, body, { EX: staleTtl }),
        ]);
      };

      if (cacheEnabled && r) {
        const cached = await r.get(cacheKey);
        if (cached) {
          reply.header("x-cache", "hit");
          reply.header("Content-Type", "application/json; charset=utf-8");
          reply.header(
            "Cache-Control",
            `private, max-age=${cacheTtl}, stale-while-revalidate=${staleTtl}`,
          );
          return reply.send(cached);
        }

        const stale = await r.get(staleCacheKey);
        if (stale) {
          const lockAcquired = await r.set(refreshLockKey, "1", {
            NX: true,
            EX: Math.min(Math.max(cacheTtl, 30), 120),
          });
          if (lockAcquired) {
            void computeBody()
              .then(storeBody)
              .catch((error) => {
                req.log.warn(
                  { error, q: search, view },
                  "Category facet stale refresh failed",
                );
              })
              .finally(() => {
                void r.del(refreshLockKey).catch(() => undefined);
              });
          }
          reply.header("x-cache", lockAcquired ? "stale" : "refreshing");
          reply.header("Content-Type", "application/json; charset=utf-8");
          reply.header(
            "Cache-Control",
            `private, max-age=${cacheTtl}, stale-while-revalidate=${staleTtl}`,
          );
          return reply.send(stale);
        }
      }

      let body: string;
      try {
        body = await computeBody();
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
      if (cacheEnabled && r) {
        await storeBody(body);
        reply.header("x-cache", "miss");
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      reply.header(
        "Cache-Control",
        `private, max-age=${cacheTtl}, stale-while-revalidate=${staleTtl}`,
      );
      return reply.send(body);
    },
  );

  z.get("/meta/venues", async (_req, reply) => {
    const lifecycle = await resolveVenueLifecyclePolicy(pool);
    const cacheKey = `meta:venues:v2:${lifecycle.revision}`;
    const r = await getRedis();

    if (r) {
      const cached = await r.get(cacheKey);
      if (cached) {
        reply.header("x-cache", "hit");
        reply.header("Content-Type", "application/json; charset=utf-8");
        reply.header(
          "Cache-Control",
          "public, max-age=30, stale-while-revalidate=60",
        );
        return reply.send(cached);
      }
    }

    const discoverableVenues = HUNCH_VENUES.filter((venue) =>
      venueHasLifecycleCapability(lifecycle.effective, venue, "discovery"),
    );
    const { rows } = await pool.query<VenueCoverageRow>(
      `
        with requested_venues as (
          select unnest($1::text[]) as venue
        ),
        active_coverage as (
          select
            venue,
            count(*)::int as active_markets,
            count(*) filter (
              where coalesce(volume_24h, 0) > 0 or coalesce(volume_total, 0) > 0
            )::int as markets_with_volume,
            count(*) filter (
              where
                (liquidity is not null and liquidity > 0)
                or (open_interest is not null and open_interest > 0)
            )::int as markets_with_liquidity,
            count(*) filter (
              where best_bid is not null or best_ask is not null or last_price is not null
            )::int as markets_with_price
          from unified_markets
          where status = 'ACTIVE'
            and venue = any($1::text[])
          group by venue
        )
        select
          requested.venue,
          coalesce(coverage.active_markets, 0)::int as active_markets,
          coalesce(coverage.markets_with_volume, 0)::int as markets_with_volume,
          coalesce(coverage.markets_with_liquidity, 0)::int as markets_with_liquidity,
          coalesce(coverage.markets_with_price, 0)::int as markets_with_price
        from requested_venues requested
        left join active_coverage coverage on coverage.venue = requested.venue
        order by requested.venue asc
      `,
      [discoverableVenues],
    );

    const venues = rows.flatMap((row) => {
      const venue = normalizeHunchVenue(row.venue);
      if (
        !venue ||
        !venueHasLifecycleCapability(lifecycle.effective, venue, "discovery")
      ) {
        return [];
      }
      const activeMarkets = Number(row.active_markets) || 0;
      const withVolume = Number(row.markets_with_volume) || 0;
      const withLiquidity = Number(row.markets_with_liquidity) || 0;
      const withPrice = Number(row.markets_with_price) || 0;
      const volumeCoverage = activeMarkets > 0 ? withVolume / activeMarkets : 0;
      const liquidityCoverage =
        activeMarkets > 0 ? withLiquidity / activeMarkets : 0;
      const priceCoverage = activeMarkets > 0 ? withPrice / activeMarkets : 0;
      const score = (volumeCoverage + liquidityCoverage + priceCoverage) / 3;

      return [
        {
          venue,
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
        },
      ];
    });

    const policyVenues = Object.fromEntries(
      HUNCH_VENUES.map((venue) => [
        venue,
        {
          ...lifecycle.effective.venues[venue],
          capabilities: getVenueLifecycleCapabilities(
            lifecycle.effective,
            venue,
          ),
        },
      ]),
    );

    const payload = {
      total: venues.length,
      generatedAt: new Date().toISOString(),
      venues,
      policy: {
        source: lifecycle.source,
        effectiveAt: lifecycle.effectiveAt?.toISOString() ?? null,
        invalidOverride: lifecycle.invalidOverride,
        revision: lifecycle.revision,
        venues: policyVenues,
      },
    };
    const body = JSON.stringify(payload);

    if (r) {
      await r.set(cacheKey, body, { EX: 60 });
      reply.header("x-cache", "miss");
    }

    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header(
      "Cache-Control",
      "public, max-age=30, stale-while-revalidate=60",
    );
    return reply.send(body);
  });
};
