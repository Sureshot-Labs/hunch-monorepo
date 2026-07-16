#!/usr/bin/env tsx

import assert from "node:assert/strict";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { DbQuery } from "./db.js";
import { marketRoutes } from "./routes/markets.js";
import {
  AggMarketHttpError,
  type AggMarketClient,
  type AggMidpoint,
  type AggVenueMarket,
} from "./services/agg-market-client.js";
import { clearAggClustersCacheForTests } from "./services/agg-market-clusters.js";

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function market(args: {
  id: string;
  venue: string;
  externalIdentifier: string;
  question: string;
  matchedVenueMarkets?: AggVenueMarket[];
}): AggVenueMarket {
  return {
    id: args.id,
    externalIdentifier: args.externalIdentifier,
    venue: args.venue,
    question: args.question,
    status: "open",
    volume: 100,
    venueCount: 2,
    conditionId: null,
    venueEventId: null,
    venueMarketOutcomes: [
      {
        id: `${args.id}:yes`,
        externalIdentifier: null,
        label: "Yes",
        price: 0.5,
      },
      {
        id: `${args.id}:no`,
        externalIdentifier: null,
        label: "No",
        price: 0.5,
      },
    ],
    matchedVenueMarkets: args.matchedVenueMarkets ?? [],
  };
}

function midpoint(venueMarketId: string, yesMid: number): AggMidpoint {
  return {
    venueMarketId,
    venue: null,
    midpoint: null,
    price: null,
    spread: null,
    timestamp: null,
    markSource: null,
    outcomes: [
      {
        id: `${venueMarketId}:yes`,
        label: "Yes",
        midpoint: yesMid,
        price: null,
        markSource: null,
      },
      {
        id: `${venueMarketId}:no`,
        label: "No",
        midpoint: 1 - yesMid,
        price: null,
        markSource: null,
      },
    ],
  };
}

function dbRow(args: {
  id: string;
  eventId?: string;
  venue: string;
  venueMarketId: string;
  title: string;
  eventTitle: string;
  bestBid?: number;
  bestAsk?: number;
}) {
  return {
    id: args.id,
    event_id: args.eventId ?? `${args.id}:event`,
    venue: args.venue,
    venue_market_id: args.venueMarketId,
    title: args.title,
    description: null,
    slug: null,
    image: null,
    icon: null,
    market_category: null,
    market_type: "binary",
    best_bid: args.bestBid ?? 0.4,
    best_ask: args.bestAsk ?? 0.6,
    last_price: ((args.bestBid ?? 0.4) + (args.bestAsk ?? 0.6)) / 2,
    volume_24h: 10,
    activity_volume_last_24h: null,
    activity_volume_valid: false,
    volume_total: 100,
    liquidity: 20,
    open_interest: 5,
    close_time: "2099-06-01T00:00:00.000Z",
    expiration_time: "2099-06-01T00:00:00.000Z",
    condition_id: null,
    event_venue_event_id: null,
    event_title: args.eventTitle,
    event_description: null,
    event_slug: null,
    event_image: null,
    event_icon: null,
    event_category: "sports",
    canonical_active: true,
    canonical_orderable: true,
  };
}

function fakeDb(rows: Array<ReturnType<typeof dbRow>>): DbQuery {
  return {
    async query() {
      return { rows };
    },
  } as unknown as DbQuery;
}

function fakeClient(args: {
  markets: AggVenueMarket[];
  midpoints: AggMidpoint[];
  calls: { venueMarkets: number; midpoints: number };
}): AggMarketClient {
  return {
    async getVenueMarkets() {
      args.calls.venueMarkets += 1;
      return { items: args.markets, nextCursor: null };
    },
    async getMidpoints(ids) {
      args.calls.midpoints += 1;
      const wanted = new Set(ids);
      return args.midpoints.filter((row) => wanted.has(row.venueMarketId));
    },
  };
}

class FakeAlternativesCache {
  readonly store = new Map<string, string>();
  getCalls = 0;
  setCalls = 0;
  lastSet: { key: string; value: string; ex: number } | null = null;
  failGet = false;
  failSet = false;

  async get(key: string): Promise<string | null> {
    this.getCalls += 1;
    if (this.failGet) throw new Error("redis get failed");
    return this.store.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    options: { EX: number },
  ): Promise<"OK"> {
    this.setCalls += 1;
    if (this.failSet) throw new Error("redis set failed");
    this.lastSet = { key, value, ex: options.EX };
    this.store.set(key, value);
    return "OK";
  }
}

async function buildTestApp(args: {
  db: DbQuery;
  client: AggMarketClient;
  appId?: string;
  redis?: FakeAlternativesCache | null;
  matchedTtlSec?: number;
  notFoundTtlSec?: number;
}) {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(marketRoutes, {
    aggMarketAppId: args.appId ?? "test-agg-app",
    aggMarketAlternativesCacheTtlSec: args.matchedTtlSec ?? 0,
    aggMarketAlternativesNotFoundCacheTtlSec: args.notFoundTtlSec ?? 60,
    aggMarketAlternativesDb: args.db,
    getAggMarketAlternativesRedis: async () => args.redis ?? null,
    createAggMarketClient: () => args.client,
  });
  return app;
}

await test("GET /markets/:marketId/alternatives returns midpoint alternatives", async () => {
  clearAggClustersCacheForTests();
  const limitless = market({
    id: "agg-limitless",
    venue: "limitless",
    externalIdentifier: "limitless-psg",
    question: "PSG",
  });
  const poly = market({
    id: "agg-poly",
    venue: "polymarket",
    externalIdentifier: "101",
    question: "PSG",
    matchedVenueMarkets: [limitless],
  });
  const calls = { venueMarkets: 0, midpoints: 0 };
  const app = await buildTestApp({
    db: fakeDb([
      dbRow({
        id: "polymarket:101",
        venue: "polymarket",
        venueMarketId: "101",
        title: "PSG",
        eventTitle: "Champions League Winner",
        bestBid: 0.56,
        bestAsk: 0.58,
      }),
      dbRow({
        id: "limitless:limitless-psg",
        venue: "limitless",
        venueMarketId: "limitless-psg",
        title: "PSG",
        eventTitle: "Champions League Winner",
        bestBid: 0.54,
        bestAsk: 0.56,
      }),
    ]),
    client: fakeClient({
      markets: [poly],
      midpoints: [midpoint("agg-poly", 0.57), midpoint("agg-limitless", 0.55)],
      calls,
    }),
  });

  const response = await app.inject({
    method: "GET",
    url: "/markets/polymarket%3A101/alternatives?limit=5",
  });
  await app.close();

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.status, "matched");
  assert.equal(body.marketId, "polymarket:101");
  assert.equal(body.lowestYesMid.marketId, "limitless:limitless-psg");
  assert.equal(body.lowestNoMid.marketId, "polymarket:101");
  assert.equal(body.bestYesBuy, undefined);
  assert.equal(body.bestNoBuy, undefined);
  assert.equal(body.alternatives.length, 1);
  assert.equal(calls.venueMarkets, 1);
  assert.equal(calls.midpoints, 1);
});

await test("GET /markets/:marketId/alternatives maps opposite participants", async () => {
  clearAggClustersCacheForTests();
  const polyFrance = market({
    id: "agg-poly-france",
    venue: "polymarket",
    externalIdentifier: "1897082",
    question: "France",
  });
  const limitlessSenegal = market({
    id: "agg-limitless-senegal",
    venue: "limitless",
    externalIdentifier: "84875",
    question: "Senegal",
    matchedVenueMarkets: [polyFrance],
  });
  const calls = { venueMarkets: 0, midpoints: 0 };
  const app = await buildTestApp({
    db: fakeDb([
      dbRow({
        id: "limitless:84875",
        venue: "limitless",
        venueMarketId: "84875",
        title: "Senegal",
        eventTitle: "World Cup, France vs Senegal, Jun 16, 2026",
        bestBid: 0.13,
        bestAsk: 0.14,
      }),
      dbRow({
        id: "polymarket:1897082",
        venue: "polymarket",
        venueMarketId: "1897082",
        title: "France",
        eventTitle: "France vs. Senegal",
        bestBid: 0.67,
        bestAsk: 0.69,
      }),
    ]),
    client: fakeClient({
      markets: [limitlessSenegal],
      midpoints: [
        midpoint("agg-limitless-senegal", 0.135),
        midpoint("agg-poly-france", 0.68),
      ],
      calls,
    }),
  });

  const response = await app.inject({
    method: "GET",
    url: "/markets/limitless%3A84875/alternatives?limit=5",
  });
  await app.close();

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.status, "matched");
  assert.equal(body.markets.length, 2);
  assert.equal(body.alternatives.length, 1);
  assert.equal(body.alternatives[0]?.marketId, "polymarket:1897082");
  assert.equal(body.alternatives[0]?.outcomeMapping?.sourceYesTo, "NO");
});

await test("GET /markets/:marketId/alternatives caches not_found responses in Redis", async () => {
  clearAggClustersCacheForTests();
  const redis = new FakeAlternativesCache();
  const calls = { venueMarkets: 0, midpoints: 0 };
  const app = await buildTestApp({
    db: fakeDb([
      dbRow({
        id: "limitless:84875",
        venue: "limitless",
        venueMarketId: "84875",
        title: "Senegal",
        eventTitle: "World Cup, France vs Senegal, Jun 16, 2026",
        bestBid: 0.13,
        bestAsk: 0.14,
      }),
    ]),
    client: fakeClient({
      markets: [],
      midpoints: [],
      calls,
    }),
    redis,
    notFoundTtlSec: 60,
  });

  const first = await app.inject({
    method: "GET",
    url: "/markets/limitless%3A84875/alternatives?limit=5",
  });
  const firstCalls = calls.venueMarkets;
  const second = await app.inject({
    method: "GET",
    url: "/markets/limitless%3A84875/alternatives?limit=5",
  });
  await app.close();

  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["x-alternatives-cache"], "miss");
  assert.equal(first.headers["x-alternatives-cache-kind"], "not_found");
  assert.equal(first.json().status, "not_found");
  assert.equal(second.statusCode, 200);
  assert.equal(second.headers["x-alternatives-cache"], "hit");
  assert.equal(second.headers["x-alternatives-cache-kind"], "not_found");
  assert.equal(second.json().status, "not_found");
  assert.equal(calls.venueMarkets, firstCalls);
  assert.equal(redis.setCalls, 1);
  assert.equal(redis.lastSet?.ex, 60);
});

await test("GET /markets/:marketId/alternatives can disable not_found Redis caching", async () => {
  clearAggClustersCacheForTests();
  const redis = new FakeAlternativesCache();
  const calls = { venueMarkets: 0, midpoints: 0 };
  const app = await buildTestApp({
    db: fakeDb([
      dbRow({
        id: "limitless:84875",
        venue: "limitless",
        venueMarketId: "84875",
        title: "Senegal",
        eventTitle: "World Cup, France vs Senegal, Jun 16, 2026",
        bestBid: 0.13,
        bestAsk: 0.14,
      }),
    ]),
    client: fakeClient({
      markets: [],
      midpoints: [],
      calls,
    }),
    redis,
    notFoundTtlSec: 0,
  });

  const first = await app.inject({
    method: "GET",
    url: "/markets/limitless%3A84875/alternatives?limit=5",
  });
  const firstCalls = calls.venueMarkets;
  const second = await app.inject({
    method: "GET",
    url: "/markets/limitless%3A84875/alternatives?limit=5",
  });
  await app.close();

  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["x-alternatives-cache"], "skip");
  assert.equal(second.statusCode, 200);
  assert.equal(second.headers["x-alternatives-cache"], "skip");
  assert.ok(calls.venueMarkets > firstCalls);
  assert.equal(redis.setCalls, 0);
});

await test("GET /markets/:marketId/alternatives caches matched responses in Redis", async () => {
  clearAggClustersCacheForTests();
  const limitless = market({
    id: "agg-limitless",
    venue: "limitless",
    externalIdentifier: "202",
    question: "PSG",
  });
  const poly = market({
    id: "agg-poly",
    venue: "polymarket",
    externalIdentifier: "101",
    question: "PSG",
    matchedVenueMarkets: [limitless],
  });
  const redis = new FakeAlternativesCache();
  const calls = { venueMarkets: 0, midpoints: 0 };
  const app = await buildTestApp({
    db: fakeDb([
      dbRow({
        id: "polymarket:101",
        venue: "polymarket",
        venueMarketId: "101",
        title: "PSG",
        eventTitle: "Champions League Winner",
        bestBid: 0.56,
        bestAsk: 0.58,
      }),
      dbRow({
        id: "limitless:202",
        venue: "limitless",
        venueMarketId: "202",
        title: "PSG",
        eventTitle: "Champions League Winner",
        bestBid: 0.54,
        bestAsk: 0.56,
      }),
    ]),
    client: fakeClient({
      markets: [poly],
      midpoints: [
        midpoint("agg-poly", 0.57),
        midpoint("agg-limitless", 0.55),
      ],
      calls,
    }),
    redis,
    matchedTtlSec: 30,
  });

  const first = await app.inject({
    method: "GET",
    url: "/markets/polymarket%3A101/alternatives?limit=5",
  });
  const firstCalls = calls.venueMarkets;
  const second = await app.inject({
    method: "GET",
    url: "/markets/polymarket%3A101/alternatives?limit=5",
  });
  await app.close();

  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["x-alternatives-cache"], "miss");
  assert.equal(first.headers["x-alternatives-cache-kind"], "matched");
  assert.equal(first.json().status, "matched");
  assert.equal(second.statusCode, 200);
  assert.equal(second.headers["x-alternatives-cache"], "hit");
  assert.equal(second.headers["x-alternatives-cache-kind"], "matched");
  assert.equal(second.json().status, "matched");
  assert.equal(calls.venueMarkets, firstCalls);
  assert.equal(redis.setCalls, 1);
  assert.equal(redis.lastSet?.ex, 30);
});

await test("GET /markets/:marketId/alternatives falls back when Redis get fails", async () => {
  clearAggClustersCacheForTests();
  const redis = new FakeAlternativesCache();
  redis.failGet = true;
  const calls = { venueMarkets: 0, midpoints: 0 };
  const app = await buildTestApp({
    db: fakeDb([
      dbRow({
        id: "limitless:84875",
        venue: "limitless",
        venueMarketId: "84875",
        title: "Senegal",
        eventTitle: "World Cup, France vs Senegal, Jun 16, 2026",
        bestBid: 0.13,
        bestAsk: 0.14,
      }),
    ]),
    client: fakeClient({
      markets: [],
      midpoints: [],
      calls,
    }),
    redis,
  });

  const response = await app.inject({
    method: "GET",
    url: "/markets/limitless%3A84875/alternatives?limit=5",
  });
  await app.close();

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["x-alternatives-cache"], "skip");
  assert.equal(response.json().status, "not_found");
  assert.ok(calls.venueMarkets > 0);
});

await test("GET /markets/:marketId/alternatives does not cache AGG failures", async () => {
  clearAggClustersCacheForTests();
  const redis = new FakeAlternativesCache();
  const calls = { venueMarkets: 0, midpoints: 0 };
  const app = await buildTestApp({
    db: fakeDb([
      dbRow({
        id: "limitless:84875",
        venue: "limitless",
        venueMarketId: "84875",
        title: "Senegal",
        eventTitle: "World Cup, France vs Senegal, Jun 16, 2026",
        bestBid: 0.13,
        bestAsk: 0.14,
      }),
    ]),
    client: {
      async getVenueMarkets() {
        calls.venueMarkets += 1;
        throw new AggMarketHttpError("AGG unavailable", 503, null);
      },
      async getMidpoints() {
        calls.midpoints += 1;
        return [];
      },
    },
    redis,
  });

  const first = await app.inject({
    method: "GET",
    url: "/markets/limitless%3A84875/alternatives?limit=5",
  });
  const second = await app.inject({
    method: "GET",
    url: "/markets/limitless%3A84875/alternatives?limit=5",
  });
  await app.close();

  assert.equal(first.statusCode, 502);
  assert.equal(second.statusCode, 502);
  assert.equal(calls.venueMarkets, 2);
  assert.equal(redis.setCalls, 0);
});

await test("GET /markets/:marketId/alternatives rejects unsupported venues", async () => {
  clearAggClustersCacheForTests();
  const calls = { venueMarkets: 0, midpoints: 0 };
  const app = await buildTestApp({
    db: fakeDb([]),
    client: fakeClient({ markets: [], midpoints: [], calls }),
  });

  const response = await app.inject({
    method: "GET",
    url: "/markets/polymarket%3A101/alternatives?venues=badvenue",
  });
  await app.close();

  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /Unsupported AGG venues: badvenue/);
  assert.equal(calls.venueMarkets, 0);
  assert.equal(calls.midpoints, 0);
});

await test("GET /markets/:marketId/alternatives returns 404 for missing market", async () => {
  clearAggClustersCacheForTests();
  const calls = { venueMarkets: 0, midpoints: 0 };
  const app = await buildTestApp({
    db: fakeDb([]),
    client: fakeClient({ markets: [], midpoints: [], calls }),
  });

  const response = await app.inject({
    method: "GET",
    url: "/markets/missing%3Amarket/alternatives",
  });
  await app.close();

  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error, "Market not found");
  assert.equal(calls.venueMarkets, 0);
  assert.equal(calls.midpoints, 0);
});
