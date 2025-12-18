import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { pool } from "../db.js";
import { getRedis } from "../redis.js";

type CategoryRow = {
  venue: string;
  category: string;
  events: number;
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
};
