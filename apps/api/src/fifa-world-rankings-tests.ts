#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { buildApp } from "./app.js";
import { env } from "./env.js";
import {
  buildBundledFifa2026TeamsRankingPayload,
  buildFifa2026TeamsRankingPayload,
  FIFA_2026_RANKING_FALLBACK_ROWS,
  FIFA_2026_TEAMS_RANKING_CACHE_KEY,
  FIFA_2026_TEAMS_RANKING_REFRESH_AHEAD_SEC,
  FIFA_2026_TEAMS_RANKING_REFRESH_LOCK_KEY,
  FIFA_2026_TEAMS_RANKING_STALE_CACHE_KEY,
  fifa2026CountryKey,
  fifaRankingRowsForTestFromFallback,
  getFifa2026TeamsRankingPayload,
  getFifa2026TeamsRankingCacheControl,
  parseOfficialFifaPageMetadata,
  parseOfficialFifaRankingRowsPayload,
  type FifaRankingRedis,
  type Fifa2026TeamsRankingPayload,
} from "./services/fifa-world-rankings.js";
import { canonicalSportsTeamKey } from "./services/sports-fixture-keys.js";

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

class FakeRedis implements FifaRankingRedis {
  readonly values = new Map<string, string>();
  readonly ttlValues = new Map<string, number>();
  readonly setCalls: Array<{
    key: string;
    value: string;
    options: { EX: number; NX?: boolean };
  }> = [];
  ttlError: Error | null = null;

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async ttl(key: string): Promise<number> {
    if (this.ttlError) throw this.ttlError;
    if (!this.values.has(key)) return -2;
    return this.ttlValues.get(key) ?? -1;
  }

  async set(
    key: string,
    value: string,
    options: { EX: number; NX?: boolean },
  ): Promise<"OK" | null> {
    this.setCalls.push({ key, value, options });
    if (options.NX && this.values.has(key)) return null;
    this.values.set(key, value);
    this.ttlValues.set(key, options.EX);
    return "OK";
  }

  async del(key: string): Promise<number> {
    this.ttlValues.delete(key);
    return this.values.delete(key) ? 1 : 0;
  }
}

function officialPageHtmlFixture(): string {
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    {
      props: {
        pageProps: {
          pageData: {
            ranking: {
              lastUpdateDate: "2026-06-11T10:00:59.636Z",
              nextUpdateDate: "2026-07-20T00:00:00.000Z",
            },
          },
        },
      },
    },
  )}</script></body></html>`;
}

function officialRankingRowsPayload(
  rows: readonly (typeof FIFA_2026_RANKING_FALLBACK_ROWS)[number][] = FIFA_2026_RANKING_FALLBACK_ROWS,
): unknown {
  return {
    Results: rows.map((row) => ({
      TeamName: [{ Locale: "en-GB", Description: row.fifaTeamName }],
      Rank: row.rank,
      PrevRank: row.previousRank,
      DecimalTotalPoints: row.points,
    })),
  };
}

function makeOfficialFetch(
  rows: readonly (typeof FIFA_2026_RANKING_FALLBACK_ROWS)[number][] = FIFA_2026_RANKING_FALLBACK_ROWS,
): typeof fetch {
  return async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.includes("inside.fifa.com/fifa-world-ranking/men")) {
      return new Response(officialPageHtmlFixture(), {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    if (url.includes("api.fifa.com/api/v3/rankings")) {
      return new Response(JSON.stringify(officialRankingRowsPayload(rows)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  };
}

function cachedPayload(status: "hit" | "stale" | "fallback" = "hit") {
  return buildBundledFifa2026TeamsRankingPayload(status);
}

await test("FIFA team aliases normalize to existing internal keys", () => {
  assert.equal(canonicalSportsTeamKey("United States"), "united-states");
  assert.equal(canonicalSportsTeamKey("USA"), "united-states");
  assert.equal(canonicalSportsTeamKey("Turkey"), "turkiye");
  assert.equal(canonicalSportsTeamKey("Türkiye"), "turkiye");
  assert.equal(canonicalSportsTeamKey("Côte d'Ivoire"), "ivory-coast");
  assert.equal(canonicalSportsTeamKey("Korea Republic"), "south-korea");
  assert.equal(canonicalSportsTeamKey("IR Iran"), "iran");
  assert.equal(canonicalSportsTeamKey("DR Congo"), "congo-dr");
  assert.equal(canonicalSportsTeamKey("Cabo Verde"), "cape-verde");
  assert.equal(canonicalSportsTeamKey("Curaçao"), "curacao");
  assert.equal(
    canonicalSportsTeamKey("Bosnia-Herzegovina"),
    "bosnia-and-herzegovina",
  );
  assert.equal(canonicalSportsTeamKey("Czech Republic"), "czechia");
  assert.equal(fifa2026CountryKey("USA"), "usa");
  assert.equal(fifa2026CountryKey("South Korea"), "south korea");
  assert.equal(fifa2026CountryKey("Congo DR"), "congo dr");
});

await test("official page metadata parser extracts FIFA update dates", () => {
  assert.deepEqual(parseOfficialFifaPageMetadata(officialPageHtmlFixture()), {
    lastOfficialUpdate: "2026-06-11",
    nextOfficialUpdate: "2026-07-20",
  });
});

await test("official ranking row parser extracts rank points and movement inputs", () => {
  const rows = parseOfficialFifaRankingRowsPayload({
    Results: [
      {
        TeamName: [{ Locale: "en-GB", Description: "France" }],
        Rank: 3,
        PrevRank: 1,
        DecimalTotalPoints: 1870.7,
      },
    ],
  });
  assert.deepEqual(rows, [
    {
      fifaTeamName: "France",
      rank: 3,
      points: 1870.7,
      previousRank: 1,
    },
  ]);
});

await test("ranking payload includes all 48 teams with frontend country keys", () => {
  const payload = buildBundledFifa2026TeamsRankingPayload("fallback");
  assert.equal(payload.teams.length, 48);
  const usa = payload.teams.find((team) => team.teamName === "USA");
  assert.equal(usa?.countryKey, "usa");
  assert.equal(usa?.groupCode, "D");
  assert.equal(usa?.worldRanking?.rank, 17);
  const argentina = payload.teams.find((team) => team.teamName === "Argentina");
  assert.equal(argentina?.worldRanking?.rankChange, 2);
});

await test("complete matching rejects incomplete FIFA source rows", () => {
  const rows = fifaRankingRowsForTestFromFallback().filter(
    (row) => row.fifaTeamName !== "USA",
  );
  assert.throws(
    () =>
      buildFifa2026TeamsRankingPayload({
        rows,
        source: {
          lastOfficialUpdate: "2026-06-11",
          nextOfficialUpdate: "2026-07-20",
          fetchedAt: "2026-06-19T00:00:00.000Z",
        },
        cacheStatus: "hit",
      }),
    /did not match all 48 teams: USA/,
  );
});

await test("fresh Redis cache returns hit without background refresh", async () => {
  const redis = new FakeRedis();
  redis.values.set(
    FIFA_2026_TEAMS_RANKING_CACHE_KEY,
    JSON.stringify(cachedPayload("fallback")),
  );
  redis.ttlValues.set(
    FIFA_2026_TEAMS_RANKING_CACHE_KEY,
    FIFA_2026_TEAMS_RANKING_REFRESH_AHEAD_SEC + 1,
  );
  const backgroundTasks: Promise<void>[] = [];
  const payload = await getFifa2026TeamsRankingPayload({
    redis,
    redisStatus: "ready",
    fetchImpl: makeOfficialFetch(),
    background: (task) => backgroundTasks.push(task),
  });
  assert.equal(payload.source.cacheStatus, "hit");
  assert.equal(backgroundTasks.length, 0);
});

await test("fresh Redis cache near expiry returns hit and refreshes ahead", async () => {
  const redis = new FakeRedis();
  redis.values.set(
    FIFA_2026_TEAMS_RANKING_CACHE_KEY,
    JSON.stringify(cachedPayload("fallback")),
  );
  redis.ttlValues.set(
    FIFA_2026_TEAMS_RANKING_CACHE_KEY,
    FIFA_2026_TEAMS_RANKING_REFRESH_AHEAD_SEC,
  );
  const backgroundTasks: Promise<void>[] = [];
  const payload = await getFifa2026TeamsRankingPayload({
    redis,
    redisStatus: "ready",
    fetchImpl: makeOfficialFetch(),
    background: (task) => backgroundTasks.push(task),
  });
  assert.equal(payload.source.cacheStatus, "hit");
  assert.equal(redis.values.get(FIFA_2026_TEAMS_RANKING_REFRESH_LOCK_KEY), "1");
  assert.equal(backgroundTasks.length, 1);
  await Promise.all(backgroundTasks);
  const refreshed = JSON.parse(
    redis.values.get(FIFA_2026_TEAMS_RANKING_CACHE_KEY) ?? "null",
  ) as Fifa2026TeamsRankingPayload | null;
  assert.equal(refreshed?.teams.length, 48);
});

await test("fresh Redis cache near expiry respects existing refresh lock", async () => {
  const redis = new FakeRedis();
  redis.values.set(
    FIFA_2026_TEAMS_RANKING_CACHE_KEY,
    JSON.stringify(cachedPayload("fallback")),
  );
  redis.ttlValues.set(FIFA_2026_TEAMS_RANKING_CACHE_KEY, 10);
  redis.values.set(FIFA_2026_TEAMS_RANKING_REFRESH_LOCK_KEY, "1");
  const backgroundTasks: Promise<void>[] = [];
  const payload = await getFifa2026TeamsRankingPayload({
    redis,
    redisStatus: "ready",
    fetchImpl: makeOfficialFetch(),
    background: (task) => backgroundTasks.push(task),
  });
  assert.equal(payload.source.cacheStatus, "hit");
  assert.equal(backgroundTasks.length, 0);
});

await test("fresh Redis cache ttl failure returns hit without blocking", async () => {
  const redis = new FakeRedis();
  redis.values.set(
    FIFA_2026_TEAMS_RANKING_CACHE_KEY,
    JSON.stringify(cachedPayload("fallback")),
  );
  redis.ttlError = new Error("ttl failed");
  const warnings: Array<{ input: unknown; message?: string }> = [];
  const backgroundTasks: Promise<void>[] = [];
  const payload = await getFifa2026TeamsRankingPayload({
    redis,
    redisStatus: "ready",
    fetchImpl: makeOfficialFetch(),
    background: (task) => backgroundTasks.push(task),
    log: {
      warn: (input, message) => warnings.push({ input, message }),
    },
  });
  assert.equal(payload.source.cacheStatus, "hit");
  assert.equal(backgroundTasks.length, 0);
  assert.equal(warnings.length, 1);
  assert.equal(
    warnings[0]?.message,
    "FIFA 2026 team ranking fresh cache ttl read failed",
  );
});

await test("stale Redis cache returns stale and refreshes behind lock", async () => {
  const redis = new FakeRedis();
  redis.values.set(
    FIFA_2026_TEAMS_RANKING_STALE_CACHE_KEY,
    JSON.stringify(cachedPayload("fallback")),
  );
  const backgroundTasks: Promise<void>[] = [];
  const payload = await getFifa2026TeamsRankingPayload({
    redis,
    redisStatus: "ready",
    fetchImpl: makeOfficialFetch(),
    background: (task) => backgroundTasks.push(task),
  });
  assert.equal(payload.source.cacheStatus, "stale");
  assert.equal(redis.values.get(FIFA_2026_TEAMS_RANKING_REFRESH_LOCK_KEY), "1");
  assert.equal(backgroundTasks.length, 1);
  await Promise.all(backgroundTasks);
  const refreshed = JSON.parse(
    redis.values.get(FIFA_2026_TEAMS_RANKING_CACHE_KEY) ?? "null",
  ) as Fifa2026TeamsRankingPayload | null;
  assert.equal(refreshed?.teams.length, 48);
  assert.equal(
    redis.values.has(FIFA_2026_TEAMS_RANKING_REFRESH_LOCK_KEY),
    false,
  );
});

await test("existing refresh lock returns stale cache as refreshing", async () => {
  const redis = new FakeRedis();
  redis.values.set(
    FIFA_2026_TEAMS_RANKING_STALE_CACHE_KEY,
    JSON.stringify(cachedPayload("fallback")),
  );
  redis.values.set(FIFA_2026_TEAMS_RANKING_REFRESH_LOCK_KEY, "1");
  const payload = await getFifa2026TeamsRankingPayload({
    redis,
    redisStatus: "ready",
    fetchImpl: makeOfficialFetch(),
  });
  assert.equal(payload.source.cacheStatus, "refreshing");
});

await test("empty Redis returns bundled fallback and starts refresh", async () => {
  const redis = new FakeRedis();
  const backgroundTasks: Promise<void>[] = [];
  const payload = await getFifa2026TeamsRankingPayload({
    redis,
    redisStatus: "ready",
    fetchImpl: makeOfficialFetch(),
    background: (task) => backgroundTasks.push(task),
  });
  assert.equal(payload.source.cacheStatus, "fallback");
  assert.equal(payload.teams.length, 48);
  assert.equal(backgroundTasks.length, 1);
  await Promise.all(backgroundTasks);
  assert.ok(redis.values.get(FIFA_2026_TEAMS_RANKING_CACHE_KEY));
});

await test("Redis unavailable returns bundled fallback with disabled status", async () => {
  const payload = await getFifa2026TeamsRankingPayload({
    redis: null,
    redisStatus: "disabled",
    fetchImpl: makeOfficialFetch(),
  });
  assert.equal(payload.source.cacheStatus, "disabled");
  assert.equal(payload.teams.length, 48);
});

await test("FIFA team ranking cache-control policy is short for hits and fallbacks", () => {
  assert.equal(
    getFifa2026TeamsRankingCacheControl("hit"),
    "public, max-age=300, stale-while-revalidate=900",
  );
  assert.equal(
    getFifa2026TeamsRankingCacheControl("disabled"),
    "public, max-age=60, stale-while-revalidate=300",
  );
  assert.equal(
    getFifa2026TeamsRankingCacheControl("fallback"),
    "public, max-age=60, stale-while-revalidate=300",
  );
});

await test("GET /special/fifa-2026/teams returns fallback when Redis is disabled", async () => {
  const previousRedisUrl = env.redisUrl;
  env.redisUrl = "";
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/special/fifa-2026/teams",
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json() as Fifa2026TeamsRankingPayload;
    assert.equal(payload.ok, true);
    assert.equal(payload.source.cacheStatus, "disabled");
    assert.equal(
      response.headers["cache-control"],
      "public, max-age=60, stale-while-revalidate=300",
    );
    assert.equal(payload.teams.length, 48);
    assert.equal(
      payload.teams.every((team) => team.worldRanking?.rank != null),
      true,
    );
  } finally {
    await app.close();
    env.redisUrl = previousRedisUrl;
  }
});
