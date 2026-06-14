import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import crypto from "node:crypto";
import { env } from "../env.js";
import { pool } from "../db.js";
import { getRedisStatus } from "../redis.js";
import {
  computeAcceptingOrders,
  readDflowNativeAcceptingOrders,
} from "../lib/market-availability.js";
import { fifaSpecialQuerySchema } from "../schemas/special.js";
import type { TokenPair } from "../server-types.js";
import {
  buildFifaMeta,
  fetchFifaSpecialPage,
  normalizeFifaSpecialSearchQuery,
  resolveTokenPair,
  type FifaMeta,
  type FifaSpecialInputs,
  type FifaSpecialRow,
  type FifaSpecialSort,
} from "../services/fifa-special.js";
import {
  fetchSportsFixturesByKeys,
  fillMissingSportsFixturesInBackground,
  formatSportsFixtureForApi,
  type SportsFixtureApi,
} from "../services/sports-fixtures.js";

function applyCacheHeaders(input: {
  reply: FastifyReply;
  hit: boolean;
  cacheStatus: "disabled" | "ready" | "loading" | "error";
}) {
  input.reply.header("x-cache", input.hit ? "hit" : "miss");
  input.reply.header("x-cache-layer", input.hit ? "redis" : "none");
  input.reply.header("x-cache-status", input.cacheStatus);
}

function parseOutcomes(raw: unknown): unknown {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function numberOrZero(value: unknown): number {
  return value != null ? Number(value) || 0 : 0;
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildTop(row: FifaSpecialRow) {
  const yesBid =
    row.best_bid_yes != null
      ? Number(row.best_bid_yes)
      : row.best_bid != null
        ? Number(row.best_bid)
        : null;
  const yesAsk =
    row.best_ask_yes != null
      ? Number(row.best_ask_yes)
      : row.best_ask != null
        ? Number(row.best_ask)
        : null;
  return {
    yesBid,
    yesAsk,
    noBid:
      row.best_bid_no != null
        ? Number(row.best_bid_no)
        : yesBid != null
          ? Number(1 - yesBid)
          : null,
    noAsk:
      row.best_ask_no != null
        ? Number(row.best_ask_no)
        : yesAsk != null
          ? Number(1 - yesAsk)
          : null,
  };
}

function buildMarket(row: FifaSpecialRow) {
  const tokens: TokenPair = resolveTokenPair(row);
  const acceptingOrders = computeAcceptingOrders({
    venue: row.venue,
    status: row.market_status,
    closeTime: row.market_close_time,
    expirationTime: row.market_expiration_time,
    pmAcceptingOrders: row.pm_accepting_orders ?? null,
    dflowNativeAcceptingOrders: readDflowNativeAcceptingOrders(
      row.market_metadata,
    ),
  });
  const fifa = buildFifaMeta(row, { scope: "market" });
  return {
    venue: String(row.venue),
    marketId: String(row.venue_market_id),
    internalMarketId: String(row.market_uuid),
    venueMarketId: String(row.venue_market_id),
    marketTitle: row.market_title ?? "",
    marketSlug: row.market_slug ?? null,
    marketType: row.market_type ?? null,
    durationMinutes: row.market_duration_minutes ?? null,
    status: row.market_status ?? null,
    volume24h: numberOrZero(row.volume_24h),
    volumeTotal: numberOrZero(row.volume_total),
    volumeDisplay: numberOrZero(row.volume_display),
    openInterest: numberOrZero(row.open_interest),
    liquidity: numberOrZero(row.liquidity),
    liquidityDisplay: numberOrZero(row.liquidity_display),
    acceptingOrders,
    tokens,
    outcomes: parseOutcomes(row.outcomes),
    negRiskExchange: row.venue === "limitless" ? row.venue_exchange : null,
    negRiskAdapter: row.venue === "limitless" ? row.venue_adapter : null,
    tradeType: row.venue === "limitless" ? row.trade_type : null,
    marketAddress: row.venue === "limitless" ? row.market_address : null,
    conditionId: row.condition_id != null ? String(row.condition_id) : null,
    category: row.market_category ?? null,
    image: row.market_image ?? null,
    icon: row.market_icon ?? null,
    lastPrice: numberOrNull(row.last_price),
    resolvedOutcome: row.resolved_outcome ?? null,
    resolvedOutcomePct: numberOrNull(row.resolved_outcome_pct),
    top: buildTop(row),
    change24h: numberOrNull(row.change_24h),
    createdAt: row.market_created_at ?? null,
    startAt: row.market_open_time ?? null,
    lastUpdate: row.last_update,
    fifa: {
      section: fifa.section,
      subtype: fifa.subtype,
      groupType: fifa.groupType,
      groupKey: fifa.groupKey,
      groupLabel: fifa.groupLabel,
      groupCode: fifa.groupCode,
      groupTeams: fifa.groupTeams,
      groupMarketType: fifa.groupMarketType,
      entity: fifa.entity,
      line: fifa.line,
      matchKey: fifa.matchKey,
      matchFixtureKey: fifa.matchFixtureKey,
      teamName: fifa.teamName,
      teamGroupCode: fifa.teamGroupCode,
      sourceRule: fifa.sourceRule,
      confidence: fifa.confidence,
    },
  };
}

function buildEvent(
  row: FifaSpecialRow,
  fifa: FifaMeta,
  fixture: SportsFixtureApi | null,
) {
  return {
    eventId: String(row.event_id),
    eventTitle: row.event_title ?? null,
    durationMinutes: row.event_duration_minutes ?? null,
    category: row.category ?? null,
    startTime: row.start_date,
    endTime: row.end_date,
    eventLiquidity: numberOrZero(row.event_liquidity),
    eventLiquidityDisplay: numberOrZero(row.event_liquidity_display),
    eventVolume: numberOrZero(row.event_volume),
    eventVolume24h: numberOrZero(row.event_volume_24h),
    eventVolumeDisplay: numberOrZero(row.event_volume_display),
    eventOpenInterest: numberOrZero(row.event_open_interest),
    eventSlug: row.event_slug ?? null,
    image: row.event_image ?? null,
    icon: row.event_icon ?? null,
    fifa: {
      section: fifa.section,
      groupType: fifa.groupType,
      groupKey: fifa.groupKey,
      groupLabel: fifa.groupLabel,
      groupCode: fifa.groupCode,
      groupTeams: fifa.groupTeams,
      groupMarketType: fifa.groupMarketType,
      matchKey: fifa.matchKey,
      matchFixtureKey: fifa.matchFixtureKey,
      matchDate: fifa.matchDate,
      homeTeam: fifa.homeTeam,
      awayTeam: fifa.awayTeam,
      teamName: fifa.teamName,
      teamGroupCode: fifa.teamGroupCode,
      sourceRule: fifa.sourceRule,
      confidence: fifa.confidence,
      fixture,
    },
    markets: [] as ReturnType<typeof buildMarket>[],
  };
}

function buildPayload(input: {
  rows: FifaSpecialRow[];
  total: number;
  limit: number;
  offset: number;
  view: "events" | "markets";
  sectionFacets: Array<{ section: string; events: number; markets: number }>;
  venueFacets: Array<{ venue: string; events: number; markets: number }>;
  fixturesByFixtureKey: Map<string, SportsFixtureApi>;
}) {
  const resolveFixture = (fifa: FifaMeta) =>
    fifa.matchFixtureKey
      ? (input.fixturesByFixtureKey.get(fifa.matchFixtureKey) ?? null)
      : fifa.groupKey.startsWith("match:")
        ? (input.fixturesByFixtureKey.get(fifa.groupKey) ?? null)
        : null;
  const data =
    input.view === "markets"
      ? input.rows.map((row) => {
          const fifa = buildFifaMeta(row, { scope: "event" });
          const fixture = resolveFixture(fifa);
          return {
            ...buildEvent(row, fifa, fixture),
            markets: [buildMarket(row)],
          };
        })
      : (() => {
          const events = new Map<string, ReturnType<typeof buildEvent>>();
          for (const row of input.rows) {
            const fifa = buildFifaMeta(row, { scope: "event" });
            let event = events.get(row.event_id);
            if (!event) {
              const fixture = resolveFixture(fifa);
              event = buildEvent(row, fifa, fixture);
              events.set(row.event_id, event);
            }
            event.markets.push(buildMarket(row));
          }
          return Array.from(events.values());
        })();

  return {
    ok: true,
    special: "fifa_2026",
    count: data.length,
    total: input.total,
    limit: input.limit,
    offset: input.offset,
    hasMore: input.offset + data.length < input.total,
    facets: {
      sections: input.sectionFacets,
      venues: input.venueFacets,
    },
    data,
  };
}

export const specialRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  z.get(
    "/special/fifa-2026",
    {
      schema: {
        querystring: fifaSpecialQuerySchema,
      },
    },
    async (req, reply) => {
      const q = req.query;
      const view = q.view === "markets" ? "markets" : "events";
      const searchQuery = normalizeFifaSpecialSearchQuery(q.q);
      const sort = (q.sort ?? "featured") as FifaSpecialSort;
      const sortDir: "asc" | "desc" =
        q.sort_dir === "asc" ? "asc" : sort === "time" ? "asc" : "desc";
      const sectionsKey = q.section?.join(",") ?? "";
      const venuesKey = q.venue?.join(",") ?? "";
      const groupCodesKey = q.group_code?.join(",") ?? "";
      const teamGroupCodesKey = q.team_group_code?.join(",") ?? "";
      const cacheTtl = env.feedTtlSec;
      const cacheEnabled = cacheTtl > 0;
      const cacheKey = `special:fifa-2026:v6:${view}:${q.limit}:${q.offset}:${searchQuery ?? ""}:${venuesKey}:${sectionsKey}:${groupCodesKey}:${teamGroupCodesKey}:${sort}:${sortDir}`;
      const redisContext = await getRedisStatus();
      const r = redisContext.redis;
      const redisStatus = redisContext.status;

      if (cacheEnabled && r) {
        const cachedBody = await r.get(cacheKey);
        if (cachedBody) {
          const etag = `W/"${crypto.createHash("sha1").update(cachedBody).digest("hex")}"`;
          applyCacheHeaders({ reply, hit: true, cacheStatus: redisStatus });
          reply.header("ETag", etag);
          reply.header(
            "Cache-Control",
            `public, max-age=${cacheTtl}, stale-while-revalidate=${cacheTtl * 2}`,
          );
          reply.header("Content-Type", "application/json; charset=utf-8");
          if (req.headers["if-none-match"] === etag) {
            reply.code(304);
            return reply.send();
          }
          return reply.send(cachedBody);
        }
      }

      const inputs: FifaSpecialInputs = {
        limit: q.limit,
        offset: q.offset,
        view,
        q: searchQuery,
        venues: q.venue,
        sections: q.section,
        groupCodes: q.group_code,
        teamGroupCodes: q.team_group_code,
        sort,
        sortDir,
        nowParam: new Date().toISOString(),
      };
      const page = await fetchFifaSpecialPage(pool, inputs);
      const fixtureKeys = Array.from(
        new Set(
          page.rows
            .map((row) => {
              const fifa = buildFifaMeta(row, { scope: "event" });
              return (
                fifa.matchFixtureKey ??
                (fifa.groupKey.startsWith("match:") ? fifa.groupKey : null)
              );
            })
            .filter((key): key is string => Boolean(key)),
        ),
      );
      const fixtureRows = await fetchSportsFixturesByKeys(pool, {
        sport: "soccer",
        competitionKey: "fifa_world_cup",
        season: "2026",
        fixtureKeys,
      });
      const fixturesByFixtureKey = new Map(
        Array.from(fixtureRows.entries()).map(([key, row]) => [
          key,
          formatSportsFixtureForApi(row),
        ]),
      );
      const payload = buildPayload({
        ...page,
        limit: q.limit,
        offset: q.offset,
        view,
        fixturesByFixtureKey,
      });
      const missingFixtureKeys = fixtureKeys.filter(
        (fixtureKey) => !fixturesByFixtureKey.has(fixtureKey),
      );
      if (
        env.sportsFixturesBackgroundFillEnabled &&
        r &&
        missingFixtureKeys.length > 0
      ) {
        void fillMissingSportsFixturesInBackground({
          pool,
          redis: {
            set: (key, value, options) => r.set(key, value, options),
          },
          sport: "soccer",
          competitionKey: "fifa_world_cup",
          season: "2026",
          fixtureKeys: missingFixtureKeys,
        }).catch((error) => {
          req.log.warn(
            {
              error: error instanceof Error ? error.message : String(error),
            },
            "FIFA fixture background fill failed",
          );
        });
      }
      const body = JSON.stringify(payload);
      const etag = `W/"${crypto.createHash("sha1").update(body).digest("hex")}"`;
      if (cacheEnabled && r) {
        await r.set(cacheKey, body, { EX: cacheTtl });
      }
      applyCacheHeaders({ reply, hit: false, cacheStatus: redisStatus });
      reply.header("ETag", etag);
      reply.header(
        "Cache-Control",
        cacheEnabled
          ? `public, max-age=${cacheTtl}, stale-while-revalidate=${cacheTtl * 2}`
          : "no-store",
      );
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(body);
    },
  );
};
