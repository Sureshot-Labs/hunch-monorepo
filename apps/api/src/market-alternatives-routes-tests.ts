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
import type {
  AggMarketClient,
  AggMidpoint,
  AggVenueMarket,
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
    last_price: 0.5,
    volume_24h: 10,
    activity_volume_last_24h: null,
    activity_volume_valid: false,
    volume_total: 100,
    liquidity: 20,
    open_interest: 5,
    close_time: "2026-06-01T00:00:00.000Z",
    expiration_time: "2026-06-01T00:00:00.000Z",
    condition_id: null,
    event_venue_event_id: null,
    event_title: args.eventTitle,
    event_description: null,
    event_slug: null,
    event_image: null,
    event_icon: null,
    event_category: "sports",
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
      return args.markets;
    },
    async getMidpoints(ids) {
      args.calls.midpoints += 1;
      const wanted = new Set(ids);
      return args.midpoints.filter((row) => wanted.has(row.venueMarketId));
    },
  };
}

async function buildTestApp(args: {
  db: DbQuery;
  client: AggMarketClient;
  appId?: string;
}) {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(marketRoutes, {
    aggMarketAppId: args.appId ?? "test-agg-app",
    aggMarketAlternativesCacheTtlSec: 0,
    aggMarketAlternativesDb: args.db,
    createAggMarketClient: () => args.client,
  });
  return app;
}

await test("GET /markets/:marketId/alternatives returns midpoint alternatives", async () => {
  clearAggClustersCacheForTests();
  const kalshi = market({
    id: "agg-kalshi",
    venue: "kalshi",
    externalIdentifier: "KXUCL-26-PSG",
    question: "PSG",
  });
  const poly = market({
    id: "agg-poly",
    venue: "polymarket",
    externalIdentifier: "101",
    question: "PSG",
    matchedVenueMarkets: [kalshi],
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
        id: "kalshi:KXUCL-26-PSG",
        venue: "kalshi",
        venueMarketId: "KXUCL-26-PSG",
        title: "PSG",
        eventTitle: "Champions League Winner",
        bestBid: 0.54,
        bestAsk: 0.56,
      }),
    ]),
    client: fakeClient({
      markets: [poly],
      midpoints: [midpoint("agg-poly", 0.57), midpoint("agg-kalshi", 0.55)],
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
  assert.equal(body.lowestYesMid.marketId, "kalshi:KXUCL-26-PSG");
  assert.equal(body.lowestNoMid.marketId, "polymarket:101");
  assert.equal(body.bestYesBuy, undefined);
  assert.equal(body.bestNoBuy, undefined);
  assert.equal(body.alternatives.length, 1);
  assert.equal(calls.venueMarkets, 1);
  assert.equal(calls.midpoints, 1);
});

await test("GET /markets/:marketId/alternatives hides opposite participant alternatives", async () => {
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
  assert.equal(body.status, "not_found");
  assert.equal(body.markets.length, 0);
  assert.equal(body.alternatives.length, 0);
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
