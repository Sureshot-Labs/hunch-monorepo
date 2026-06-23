import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import crypto from "node:crypto";
import { env } from "../env.js";
import { pool } from "../db.js";
import { getRedisStatus as getRedisStatusDefault } from "../redis.js";
import {
  computeAcceptingOrders,
  readDflowNativeAcceptingOrders,
} from "../lib/market-availability.js";
import {
  collectMarketRefreshMarketIdsFromPayload,
  requestMarketRefreshForMarketRefs,
} from "../lib/market-refresh.js";
import { fifaSpecialQuerySchema } from "../schemas/special.js";
import type { TokenPair } from "../server-types.js";
import {
  buildFifaMeta,
  fetchFifaSpecialPage as fetchFifaSpecialPageDefault,
  normalizeFifaSpecialSearchQuery,
  resolveTokenPair,
  type FifaMeta,
  type FifaSpecialInputs,
  type FifaSpecialRow,
  type FifaSpecialSort,
} from "../services/fifa-special.js";
import {
  fetchSportsFixturesByKeys as fetchSportsFixturesByKeysDefault,
  fillMissingSportsFixturesInBackground,
  formatSportsFixtureForApi,
  refreshSportsFixtures as refreshSportsFixturesDefault,
  type SportsFixtureApi,
  type SportsFixtureRow,
} from "../services/sports-fixtures.js";
import { slugifySportsKey } from "../services/sports-fixture-keys.js";
import {
  getFifa2026TeamsRankingPayload,
  getFifa2026TeamsRankingCacheControl,
} from "../services/fifa-world-rankings.js";

type FifaSpecialRouteTestHooks = {
  getRedisStatus?: typeof getRedisStatusDefault;
  fetchFifaSpecialPage?: typeof fetchFifaSpecialPageDefault;
  fetchSportsFixturesByKeys?: typeof fetchSportsFixturesByKeysDefault;
  refreshSportsFixtures?: typeof refreshSportsFixturesDefault;
  now?: () => Date;
};

let fifaSpecialRouteTestHooks: FifaSpecialRouteTestHooks = {};

export function setFifaSpecialRouteTestHooksForTest(
  hooks: FifaSpecialRouteTestHooks,
): () => void {
  const previous = fifaSpecialRouteTestHooks;
  fifaSpecialRouteTestHooks = hooks;
  return () => {
    fifaSpecialRouteTestHooks = previous;
  };
}

function applyCacheHeaders(input: {
  reply: FastifyReply;
  hit: boolean;
  cacheStatus: "disabled" | "ready" | "loading" | "error";
}) {
  input.reply.header("x-cache", input.hit ? "hit" : "miss");
  input.reply.header("x-cache-layer", input.hit ? "redis" : "none");
  input.reply.header("x-cache-status", input.cacheStatus);
}

type FixtureRefreshLog = {
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

type FixtureRefreshRedis = {
  set: (
    key: string,
    value: string,
    options: { NX: true; EX: number },
  ) => Promise<string | null>;
};

const FIFA_FIXTURE_REFRESH_BEFORE_MS = 2 * 60 * 60 * 1000;
const FIFA_FIXTURE_REFRESH_AFTER_MS = 4 * 60 * 60 * 1000;
const FIFA_LIVE_CACHE_TTL_SEC = 10;
const FIFA_LIVE_STALE_TTL_SEC = 60;

function routeNow(): Date {
  return fifaSpecialRouteTestHooks.now?.() ?? new Date();
}

function weakEtag(body: string): string {
  return `W/"${crypto.createHash("sha1").update(body).digest("hex")}"`;
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

function requestFifaSpecialMarketRefresh(payload: unknown): void {
  const marketIds = collectMarketRefreshMarketIdsFromPayload(payload, {
    fields: ["internalMarketId"],
    maxMarkets: 100,
  });
  requestMarketRefreshForMarketRefs({
    db: pool,
    marketIds,
    logLabel: "special:fifa-2026",
  });
}

function requestFifaSpecialMarketRefreshForBody(body: string): void {
  try {
    requestFifaSpecialMarketRefresh(JSON.parse(body) as unknown);
  } catch {
    // Cache body is controlled by this route. If it is invalid, skip warming.
  }
}

function parseTimeMs(value: unknown): number | null {
  if (value == null) return null;
  const parsed =
    value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedFixtureStatus(status: unknown): string {
  return typeof status === "string" ? status.trim().toLowerCase() : "";
}

function isTerminalFixtureStatus(status: unknown): boolean {
  const normalized = normalizedFixtureStatus(status);
  return (
    normalized === "ft" ||
    normalized === "aet" ||
    normalized === "pen" ||
    normalized === "finished" ||
    normalized === "match finished" ||
    normalized === "fulltime" ||
    normalized === "postponed" ||
    normalized === "cancelled" ||
    normalized === "canceled" ||
    normalized === "abandoned" ||
    normalized.includes("full time")
  );
}

function isLiveFixtureStatus(status: unknown): boolean {
  const normalized = normalizedFixtureStatus(status);
  return (
    normalized === "1h" ||
    normalized === "1st half" ||
    normalized === "first half" ||
    normalized === "2h" ||
    normalized === "2nd half" ||
    normalized === "second half" ||
    normalized === "ht" ||
    normalized === "live" ||
    normalized === "inplay" ||
    normalized === "in_play" ||
    normalized === "in play" ||
    normalized === "in-progress" ||
    normalized === "in progress" ||
    normalized.includes("half time") ||
    normalized.includes("halftime")
  );
}

function fixtureKickoffMs(
  fixture: SportsFixtureRow | SportsFixtureApi,
): number | null {
  const kickoff =
    "kickoff_utc" in fixture ? fixture.kickoff_utc : fixture.kickoffUtc;
  return parseTimeMs(kickoff);
}

function fixtureFetchedMs(
  fixture: SportsFixtureRow | SportsFixtureApi,
): number | null {
  const fetched =
    "fetched_at" in fixture ? fixture.fetched_at : fixture.fetchedAt;
  return parseTimeMs(fetched);
}

function isFixtureInRefreshWindow(
  fixture: SportsFixtureRow | SportsFixtureApi,
  now: Date,
): boolean {
  const kickoffMs = fixtureKickoffMs(fixture);
  if (kickoffMs == null) return false;
  const nowMs = now.getTime();
  return (
    kickoffMs - nowMs <= FIFA_FIXTURE_REFRESH_BEFORE_MS &&
    nowMs - kickoffMs <= FIFA_FIXTURE_REFRESH_AFTER_MS
  );
}

function isFixtureRefreshDue(
  fixture: SportsFixtureRow | SportsFixtureApi,
  now: Date,
): boolean {
  if (isTerminalFixtureStatus(fixture.status)) return false;
  if (!isFixtureInRefreshWindow(fixture, now)) return false;
  const fetchedMs = fixtureFetchedMs(fixture);
  if (fetchedMs == null) return true;
  return now.getTime() - fetchedMs >= env.sportsFixturesRefreshTtlSec * 1000;
}

function isFixtureLiveNow(
  fixture: SportsFixtureApi | null | undefined,
): boolean {
  if (!fixture || isTerminalFixtureStatus(fixture.status)) return false;
  return isLiveFixtureStatus(fixture.status);
}

function fixtureKeyForRow(row: FifaSpecialRow): string | null {
  const fifa = buildFifaMeta(row, { scope: "event" });
  return (
    fifa.matchFixtureKey ??
    (fifa.groupKey.startsWith("match:") ? fifa.groupKey : null)
  );
}

function collectFixtureKeys(rows: FifaSpecialRow[]): string[] {
  return Array.from(
    new Set(rows.map((row) => fixtureKeyForRow(row)).filter(Boolean)),
  ) as string[];
}

function toFixtureApiMap(
  rows: Map<string, SportsFixtureRow>,
): Map<string, SportsFixtureApi> {
  return new Map(
    Array.from(rows.entries()).map(([key, row]) => [
      key,
      formatSportsFixtureForApi(row),
    ]),
  );
}

async function refreshFixtureKeys(input: {
  fixtureKeys: string[];
  redis: FixtureRefreshRedis | null;
  log: FixtureRefreshLog;
}): Promise<string[]> {
  if (!input.fixtureKeys.length || !input.redis) return [];

  const refreshSportsFixtures =
    fifaSpecialRouteTestHooks.refreshSportsFixtures ??
    refreshSportsFixturesDefault;
  const refreshed: string[] = [];

  for (const fixtureKey of input.fixtureKeys) {
    const lockKey = `sports-fixtures:refresh:v2:soccer:fifa_world_cup:2026:${slugifySportsKey(fixtureKey)}`;
    const locked = await input.redis.set(lockKey, "1", {
      NX: true,
      EX: env.sportsFixturesRefreshTtlSec,
    });
    if (locked !== "OK") continue;

    try {
      await refreshSportsFixtures(pool, {
        sport: "soccer",
        competitionKey: "fifa_world_cup",
        season: "2026",
        fixtureKey,
      });
      refreshed.push(fixtureKey);
    } catch (error) {
      input.log.warn(
        {
          fixtureKey,
          error: error instanceof Error ? error.message : String(error),
        },
        "FIFA near-live fixture refresh failed",
      );
    }
  }

  return refreshed;
}

async function refreshDueNearLiveFixtures(input: {
  fixtureRows: Map<string, SportsFixtureRow>;
  redis: FixtureRefreshRedis | null;
  now: Date;
  log: FixtureRefreshLog;
}): Promise<string[]> {
  const dueKeys = Array.from(input.fixtureRows.entries())
    .filter(([, fixture]) => isFixtureRefreshDue(fixture, input.now))
    .map(([fixtureKey]) => fixtureKey);
  return refreshFixtureKeys({
    fixtureKeys: dueKeys,
    redis: input.redis,
    log: input.log,
  });
}

async function loadFifaFixturesForRows(input: {
  rows: FifaSpecialRow[];
  redis: FixtureRefreshRedis | null;
  now: Date;
  log: FixtureRefreshLog;
}): Promise<{
  fixtureKeys: string[];
  fixturesByFixtureKey: Map<string, SportsFixtureApi>;
  missingFixtureKeys: string[];
}> {
  const fixtureKeys = collectFixtureKeys(input.rows);
  const fetchSportsFixturesByKeys =
    fifaSpecialRouteTestHooks.fetchSportsFixturesByKeys ??
    fetchSportsFixturesByKeysDefault;
  let fixtureRows = await fetchSportsFixturesByKeys(pool, {
    sport: "soccer",
    competitionKey: "fifa_world_cup",
    season: "2026",
    fixtureKeys,
  });
  const refreshedKeys = await refreshDueNearLiveFixtures({
    fixtureRows,
    redis: input.redis,
    now: input.now,
    log: input.log,
  });
  if (refreshedKeys.length > 0) {
    fixtureRows = await fetchSportsFixturesByKeys(pool, {
      sport: "soccer",
      competitionKey: "fifa_world_cup",
      season: "2026",
      fixtureKeys,
    });
  }
  const fixturesByFixtureKey = toFixtureApiMap(fixtureRows);
  const missingFixtureKeys = fixtureKeys.filter(
    (fixtureKey) => !fixturesByFixtureKey.has(fixtureKey),
  );
  return { fixtureKeys, fixturesByFixtureKey, missingFixtureKeys };
}

function cachedBodyStaleLiveFixtureKeys(body: string, now: Date): string[] {
  try {
    const parsed = JSON.parse(body) as {
      data?: Array<{
        fifa?: {
          matchFixtureKey?: string | null;
          groupKey?: string | null;
          fixture?: SportsFixtureApi | null;
        };
      }>;
    };
    return Array.from(
      new Set(
        (parsed.data ?? []).flatMap((event) => {
          const fixtureKey =
            event.fifa?.matchFixtureKey ??
            (event.fifa?.groupKey?.startsWith("match:")
              ? event.fifa.groupKey
              : null);
          if (!fixtureKey) return [];
          const fixture = event.fifa?.fixture;
          return fixture && isFixtureRefreshDue(fixture, now)
            ? [fixtureKey]
            : [];
        }),
      ),
    );
  } catch {
    return [];
  }
}

async function refreshCachedFixturesIfDue(input: {
  cachedBody: string;
  redis: FixtureRefreshRedis | null;
  now: Date;
  log: FixtureRefreshLog;
}): Promise<boolean> {
  const staleFixtureKeys = cachedBodyStaleLiveFixtureKeys(
    input.cachedBody,
    input.now,
  );
  if (!staleFixtureKeys.length) return false;
  const refreshed = await refreshFixtureKeys({
    fixtureKeys: staleFixtureKeys,
    redis: input.redis,
    log: input.log,
  });
  return refreshed.length > 0;
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
    eventEndTime: row.end_date,
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

type FifaSpecialFacets = {
  sections: Array<{ section: string; events: number; markets: number }>;
  venues: Array<{ venue: string; events: number; markets: number }>;
};

function buildFacetsForRows(rows: FifaSpecialRow[]): FifaSpecialFacets {
  const sectionEvents = new Map<string, Set<string>>();
  const sectionMarkets = new Map<string, number>();
  const venueEvents = new Map<string, Set<string>>();
  const venueMarkets = new Map<string, number>();

  for (const row of rows) {
    const section = row.fifa_section;
    if (!sectionEvents.has(section)) sectionEvents.set(section, new Set());
    sectionEvents.get(section)?.add(row.event_id);
    sectionMarkets.set(section, (sectionMarkets.get(section) ?? 0) + 1);

    const venue = row.venue;
    if (!venueEvents.has(venue)) venueEvents.set(venue, new Set());
    venueEvents.get(venue)?.add(row.event_id);
    venueMarkets.set(venue, (venueMarkets.get(venue) ?? 0) + 1);
  }

  return {
    sections: Array.from(sectionEvents.entries())
      .map(([section, events]) => ({
        section,
        events: events.size,
        markets: sectionMarkets.get(section) ?? 0,
      }))
      .sort((a, b) => a.section.localeCompare(b.section)),
    venues: Array.from(venueEvents.entries())
      .map(([venue, events]) => ({
        venue,
        events: events.size,
        markets: venueMarkets.get(venue) ?? 0,
      }))
      .sort((a, b) => a.venue.localeCompare(b.venue)),
  };
}

function filterRowsToLiveFixtures(input: {
  rows: FifaSpecialRow[];
  fixturesByFixtureKey: Map<string, SportsFixtureApi>;
}): FifaSpecialRow[] {
  const liveEventIds = new Set<string>();
  for (const row of input.rows) {
    const fixtureKey = fixtureKeyForRow(row);
    const fixture = fixtureKey
      ? input.fixturesByFixtureKey.get(fixtureKey)
      : null;
    if (isFixtureLiveNow(fixture)) {
      liveEventIds.add(row.event_id);
    }
  }
  return input.rows.filter((row) => liveEventIds.has(row.event_id));
}

export const specialRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  z.get("/special/fifa-2026/teams", async (req, reply) => {
    const redisContext = await (
      fifaSpecialRouteTestHooks.getRedisStatus ?? getRedisStatusDefault
    )();
    const r = redisContext.redis;
    const payload = await getFifa2026TeamsRankingPayload({
      redis: r
        ? {
            get: (key) => r.get(key),
            ttl: (key) => r.ttl(key),
            set: (key, value, options) => r.set(key, value, options),
            del: (key) => r.del(key),
          }
        : null,
      redisStatus: redisContext.status,
      log: req.log,
    });
    const body = JSON.stringify(payload);
    const etag = weakEtag(body);
    reply.header("x-cache", payload.source.cacheStatus);
    reply.header("x-cache-layer", r ? "redis" : "none");
    reply.header("x-cache-status", redisContext.status);
    reply.header("ETag", etag);
    reply.header(
      "Cache-Control",
      getFifa2026TeamsRankingCacheControl(payload.source.cacheStatus),
    );
    reply.header("Content-Type", "application/json; charset=utf-8");
    if (req.headers["if-none-match"] === etag) {
      reply.code(304);
      return reply.send();
    }
    return reply.send(body);
  });

  z.get("/special/fifa-2026/live", async (req, reply) => {
    const now = routeNow();
    const redisContext = await (
      fifaSpecialRouteTestHooks.getRedisStatus ?? getRedisStatusDefault
    )();
    const r = redisContext.redis;
    const redisStatus = redisContext.status;
    const cacheTtl =
      env.feedTtlSec > 0
        ? Math.min(env.feedTtlSec, FIFA_LIVE_CACHE_TTL_SEC)
        : 0;
    const cacheEnabled = cacheTtl > 0;
    const cacheKey = "special:fifa-2026:live:v1";
    const staleCacheKey = `${cacheKey}:stale`;

    if (cacheEnabled && r) {
      const cachedBody = await r.get(cacheKey);
      if (cachedBody) {
        const refreshedFixtures = await refreshCachedFixturesIfDue({
          cachedBody,
          redis: {
            set: (key, value, options) => r.set(key, value, options),
          },
          now,
          log: req.log,
        });
        if (!refreshedFixtures) {
          const etag = weakEtag(cachedBody);
          requestFifaSpecialMarketRefreshForBody(cachedBody);
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
    }

    const inputs: FifaSpecialInputs = {
      limit: env.maxLimit,
      offset: 0,
      view: "events",
      sections: ["match_prop", "match_result"],
      sort: "time",
      sortDir: "asc",
      nowParam: now.toISOString(),
    };

    let fixtureLoad: Awaited<ReturnType<typeof loadFifaFixturesForRows>>;
    let payload: ReturnType<typeof buildPayload>;
    try {
      const page = await (
        fifaSpecialRouteTestHooks.fetchFifaSpecialPage ??
        fetchFifaSpecialPageDefault
      )(pool, inputs);
      fixtureLoad = await loadFifaFixturesForRows({
        rows: page.rows,
        redis: r
          ? { set: (key, value, options) => r.set(key, value, options) }
          : null,
        now,
        log: req.log,
      });
      const liveRows = filterRowsToLiveFixtures({
        rows: page.rows,
        fixturesByFixtureKey: fixtureLoad.fixturesByFixtureKey,
      });
      const facets = buildFacetsForRows(liveRows);
      const liveEventCount = new Set(liveRows.map((row) => row.event_id)).size;
      payload = buildPayload({
        rows: liveRows,
        total: liveEventCount,
        limit: env.maxLimit,
        offset: 0,
        view: "events",
        sectionFacets: facets.sections,
        venueFacets: facets.venues,
        fixturesByFixtureKey: fixtureLoad.fixturesByFixtureKey,
      });
    } catch (error) {
      req.log.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          cacheKey,
        },
        "FIFA live page DB load failed",
      );
      if (cacheEnabled && r) {
        const staleBody = await r.get(staleCacheKey);
        if (staleBody) {
          const etag = weakEtag(staleBody);
          requestFifaSpecialMarketRefreshForBody(staleBody);
          reply.header("x-cache", "stale");
          reply.header("x-cache-layer", "redis");
          reply.header("x-cache-status", redisStatus);
          reply.header("ETag", etag);
          reply.header(
            "Cache-Control",
            `public, max-age=0, stale-while-revalidate=${FIFA_LIVE_STALE_TTL_SEC}`,
          );
          reply.header("Content-Type", "application/json; charset=utf-8");
          if (req.headers["if-none-match"] === etag) {
            reply.code(304);
            return reply.send();
          }
          return reply.send(staleBody);
        }
      }
      reply.code(503);
      reply.header("Cache-Control", "no-store");
      return reply.send({
        error: "Special page temporarily unavailable",
      });
    }

    if (
      env.sportsFixturesBackgroundFillEnabled &&
      r &&
      fixtureLoad.missingFixtureKeys.length > 0
    ) {
      void fillMissingSportsFixturesInBackground({
        pool,
        redis: {
          set: (key, value, options) => r.set(key, value, options),
        },
        sport: "soccer",
        competitionKey: "fifa_world_cup",
        season: "2026",
        fixtureKeys: fixtureLoad.missingFixtureKeys,
      }).catch((error) => {
        req.log.warn(
          {
            error: error instanceof Error ? error.message : String(error),
          },
          "FIFA live fixture background fill failed",
        );
      });
    }

    const body = JSON.stringify(payload);
    const etag = weakEtag(body);
    requestFifaSpecialMarketRefresh(payload);
    if (cacheEnabled && r) {
      await Promise.all([
        r.set(cacheKey, body, { EX: cacheTtl }),
        r.set(staleCacheKey, body, { EX: FIFA_LIVE_STALE_TTL_SEC }),
      ]);
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
    if (req.headers["if-none-match"] === etag) {
      reply.code(304);
      return reply.send();
    }
    return reply.send(body);
  });

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
      const now = routeNow();
      const sectionsKey = q.section?.join(",") ?? "";
      const venuesKey = q.venue?.join(",") ?? "";
      const groupCodesKey = q.group_code?.join(",") ?? "";
      const teamGroupCodesKey = q.team_group_code?.join(",") ?? "";
      const cacheTtl = env.feedTtlSec;
      const cacheEnabled = cacheTtl > 0;
      const cacheKey = `special:fifa-2026:v6:${view}:${q.limit}:${q.offset}:${searchQuery ?? ""}:${venuesKey}:${sectionsKey}:${groupCodesKey}:${teamGroupCodesKey}:${sort}:${sortDir}`;
      const staleCacheKey = `${cacheKey}:stale`;
      const staleTtl = Math.max(cacheTtl * 60, 6 * 60 * 60);
      const redisContext = await (
        fifaSpecialRouteTestHooks.getRedisStatus ?? getRedisStatusDefault
      )();
      const r = redisContext.redis;
      const redisStatus = redisContext.status;

      if (cacheEnabled && r) {
        const cachedBody = await r.get(cacheKey);
        if (cachedBody) {
          const refreshedFixtures = await refreshCachedFixturesIfDue({
            cachedBody,
            redis: {
              set: (key, value, options) => r.set(key, value, options),
            },
            now,
            log: req.log,
          });
          if (!refreshedFixtures) {
            const etag = weakEtag(cachedBody);
            requestFifaSpecialMarketRefreshForBody(cachedBody);
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
      }

      const sendStaleFallback = async (error: unknown) => {
        req.log.warn(
          {
            error: error instanceof Error ? error.message : String(error),
            cacheKey,
          },
          "FIFA special page DB load failed",
        );

        if (cacheEnabled && r) {
          const staleBody = await r.get(staleCacheKey);
          if (staleBody) {
            const etag = weakEtag(staleBody);
            requestFifaSpecialMarketRefreshForBody(staleBody);
            reply.header("x-cache", "stale");
            reply.header("x-cache-layer", "redis");
            reply.header("x-cache-status", redisStatus);
            reply.header("ETag", etag);
            reply.header(
              "Cache-Control",
              `public, max-age=0, stale-while-revalidate=${staleTtl}`,
            );
            reply.header("Content-Type", "application/json; charset=utf-8");
            if (req.headers["if-none-match"] === etag) {
              reply.code(304);
              return reply.send();
            }
            return reply.send(staleBody);
          }
        }

        reply.code(503);
        reply.header("Cache-Control", "no-store");
        return reply.send({
          error: "Special page temporarily unavailable",
        });
      };

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
        nowParam: now.toISOString(),
      };
      let fixtureKeys: string[];
      let fixturesByFixtureKey: Map<string, SportsFixtureApi>;
      let payload: ReturnType<typeof buildPayload>;
      try {
        const page = await (
          fifaSpecialRouteTestHooks.fetchFifaSpecialPage ??
          fetchFifaSpecialPageDefault
        )(pool, inputs);
        const fixtureLoad = await loadFifaFixturesForRows({
          rows: page.rows,
          redis: r
            ? { set: (key, value, options) => r.set(key, value, options) }
            : null,
          now,
          log: req.log,
        });
        fixtureKeys = fixtureLoad.fixtureKeys;
        fixturesByFixtureKey = fixtureLoad.fixturesByFixtureKey;
        payload = buildPayload({
          ...page,
          limit: q.limit,
          offset: q.offset,
          view,
          fixturesByFixtureKey,
        });
      } catch (error) {
        return sendStaleFallback(error);
      }
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
      const etag = weakEtag(body);
      requestFifaSpecialMarketRefresh(payload);
      if (cacheEnabled && r) {
        await Promise.all([
          r.set(cacheKey, body, { EX: cacheTtl }),
          r.set(staleCacheKey, body, { EX: staleTtl }),
        ]);
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
