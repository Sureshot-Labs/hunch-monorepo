#!/usr/bin/env tsx

import assert from "node:assert/strict";
import type { DbQuery } from "./db.js";
import {
  chunkAggVenueMarketIds,
  createAggMarketClient,
  type AggMarketClient,
  type AggMidpoint,
  type AggVenueMarket,
} from "./services/agg-market-client.js";
import {
  type AggClusterListCacheClient,
  buildAggMarketAlternativesResponse,
  buildAggClusterListResponse,
  clearAggClustersCacheForTests,
  getAggMarketAlternativesResponseCached,
  getAggMarketAlternativesResponseCachedWithMetadata,
  getAggClusterListResponseCached,
  getAggClusterListResponseCachedWithMetadata,
} from "./services/agg-market-clusters.js";

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function market(
  overrides: Partial<AggVenueMarket> & {
    id: string;
    venue: string;
    externalIdentifier: string | null;
  },
): AggVenueMarket {
  return {
    id: overrides.id,
    externalIdentifier: overrides.externalIdentifier,
    venue: overrides.venue,
    question: overrides.question ?? overrides.externalIdentifier,
    status: overrides.status ?? "open",
    volume: overrides.volume ?? 100,
    venueCount: overrides.venueCount ?? 2,
    conditionId: overrides.conditionId ?? null,
    venueEventId: overrides.venueEventId ?? null,
    venueMarketOutcomes: overrides.venueMarketOutcomes ?? [
      {
        id: `${overrides.id}:yes`,
        externalIdentifier: null,
        label: "Yes",
        price: 0.5,
      },
      {
        id: `${overrides.id}:no`,
        externalIdentifier: null,
        label: "No",
        price: 0.5,
      },
    ],
    matchedVenueMarkets: overrides.matchedVenueMarkets ?? [],
  };
}

function midpoint(
  venueMarketId: string,
  yesMid: number,
  topLevelMidpoint = 1 - yesMid,
): AggMidpoint {
  return {
    venueMarketId,
    venue: null,
    midpoint: topLevelMidpoint,
    price: null,
    spread: null,
    timestamp: null,
    markSource: null,
    outcomes: [
      {
        id: `${venueMarketId}:no`,
        label: "No",
        midpoint: 1 - yesMid,
        price: null,
        markSource: null,
      },
      {
        id: `${venueMarketId}:yes`,
        label: "Yes",
        midpoint: yesMid,
        price: null,
        markSource: null,
      },
    ],
  };
}

function topLevelMidpoint(
  venueMarketId: string,
  value: number,
  markSource: string | null = null,
): AggMidpoint {
  return {
    venueMarketId,
    venue: null,
    midpoint: value,
    price: null,
    spread: null,
    timestamp: null,
    markSource,
    outcomes: [],
  };
}

function dbRow(args: {
  id: string;
  eventId?: string;
  venueEventId?: string | null;
  venue: string;
  venueMarketId: string;
  conditionId?: string | null;
  title?: string;
  eventTitle?: string;
  marketCategory?: string | null;
  eventCategory?: string | null;
  volume24h?: number;
  activityVolume24h?: number | null;
  activityVolumeValid?: boolean;
  liquidity?: number;
  bestBid?: number | null;
  bestAsk?: number | null;
  lastPrice?: number | null;
  closeTime?: string | null;
  expirationTime?: string | null;
  canonicalActive?: boolean;
  canonicalOrderable?: boolean;
}) {
  return {
    id: args.id,
    event_id: args.eventId ?? `${args.id}:event`,
    venue: args.venue,
    venue_market_id: args.venueMarketId,
    title: args.title ?? args.venueMarketId,
    description: null,
    slug: null,
    image: null,
    icon: null,
    market_category: args.marketCategory ?? null,
    market_type: "binary",
    best_bid: "bestBid" in args ? args.bestBid : 0.4,
    best_ask: "bestAsk" in args ? args.bestAsk : 0.6,
    last_price: "lastPrice" in args ? args.lastPrice : 0.5,
    volume_24h: args.volume24h ?? 10,
    activity_volume_last_24h: args.activityVolume24h ?? null,
    activity_volume_valid: args.activityVolumeValid ?? false,
    volume_total: 100,
    liquidity: args.liquidity ?? 20,
    open_interest: 5,
    close_time:
      "closeTime" in args ? args.closeTime : "2099-01-01T00:00:00.000Z",
    expiration_time:
      "expirationTime" in args
        ? args.expirationTime
        : "2099-01-01T00:00:00.000Z",
    condition_id: args.conditionId ?? null,
    event_venue_event_id: args.venueEventId ?? null,
    event_title: args.eventTitle ?? "Event title",
    event_description: null,
    event_slug: null,
    event_image: null,
    event_icon: null,
    event_category: args.eventCategory ?? "sports",
    canonical_active: args.canonicalActive ?? true,
    canonical_orderable: args.canonicalOrderable ?? true,
  };
}

function fakeClient(args: {
  markets: AggVenueMarket[];
  midpoints: AggMidpoint[];
  nextCursor?: string | null;
  calls?: { venueMarkets: number; midpoints: number };
  venueMarketParams?: unknown[];
}): AggMarketClient {
  return {
    async getVenueMarkets(params) {
      if (args.calls) args.calls.venueMarkets += 1;
      args.venueMarketParams?.push(params);
      return { items: args.markets, nextCursor: args.nextCursor ?? null };
    },
    async getMidpoints(ids) {
      if (args.calls) args.calls.midpoints += 1;
      const wanted = new Set(ids);
      return args.midpoints.filter((row) => wanted.has(row.venueMarketId));
    },
  };
}

function fakeDb(rows: Array<ReturnType<typeof dbRow>>): DbQuery {
  return {
    async query(sql?: unknown, values?: unknown[]) {
      const text = typeof sql === "string" ? sql : "";
      const seedId = Array.isArray(values) ? values[0] : null;
      if (
        typeof seedId === "string" &&
        text.includes("order by case when m.id = $1")
      ) {
        return {
          rows: rows.filter(
            (row) => row.id === seedId || row.venue_market_id === seedId,
          ),
        };
      }
      return { rows };
    },
  } as unknown as DbQuery;
}

class FakeAggClusterCache implements AggClusterListCacheClient {
  readonly store = new Map<string, string>();
  getCalls = 0;
  setCalls = 0;
  lastSet: { key: string; value: string; ttl: number } | null = null;
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
  ): Promise<unknown> {
    this.setCalls += 1;
    if (this.failSet) throw new Error("redis set failed");
    this.lastSet = { key, value, ttl: options.EX };
    this.store.set(key, value);
    return "OK";
  }
}

await test("chunks midpoint ids at the AGG limit", () => {
  const ids = Array.from({ length: 401 }, (_, index) => `m-${index}`);
  const chunks = chunkAggVenueMarketIds(ids, 200);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]?.length, 200);
  assert.equal(chunks[1]?.length, 200);
  assert.equal(chunks[2]?.length, 1);
});

await test("AGG client sends app id and optional api key headers separately", async () => {
  const capturedHeaders: Headers[] = [];
  const client = createAggMarketClient({
    apiKey: "test-key",
    appId: "test-app",
    baseUrl: "https://agg.example",
    fetchImpl: async (_input, init) => {
      capturedHeaders.push(new Headers(init?.headers));
      return new Response(JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  await client.getMidpoints(["agg-poly"]);

  const headers = capturedHeaders[0];
  assert.ok(headers);
  assert.equal(headers?.get("x-app-id"), "test-app");
  assert.equal(headers?.get("x-api-key"), "test-key");
});

await test("parses top-level AGG midpoint fields when outcomes are empty", async () => {
  const requested: string[] = [];
  const client = createAggMarketClient({
    appId: "test-app",
    baseUrl: "https://agg.example",
    fetchImpl: async (input) => {
      requested.push(String(input));
      return new Response(
        JSON.stringify({
          data: [
            {
              venueMarketId: "agg-poly",
              venue: "polymarket",
              midpoint: "0.61",
              price: "0.62",
              spread: "0.03",
              timestamp: "2026-05-12T00:00:00.000Z",
              markSource: "local",
              outcomes: [],
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });

  const rows = await client.getMidpoints(["agg-poly"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.venueMarketId, "agg-poly");
  assert.equal(rows[0]?.midpoint, 0.61);
  assert.equal(rows[0]?.price, 0.62);
  assert.equal(rows[0]?.spread, 0.03);
  assert.equal(rows[0]?.markSource, "local");
  assert.equal(rows[0]?.outcomes.length, 0);
  assert.match(requested[0] ?? "", /venueMarketIds=agg-poly/);
});

await test("passes venue and venueEventId filters to AGG venue markets", async () => {
  const requested: string[] = [];
  const client = createAggMarketClient({
    appId: "test-app",
    baseUrl: "https://agg.example",
    fetchImpl: async (input) => {
      requested.push(String(input));
      return new Response(
        JSON.stringify({ data: [], pagination: { nextCursor: "next-100" } }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  const page = await client.getVenueMarkets({
    cursor: "current-100",
    venue: "polymarket",
    venueEventId: "90177",
    status: "open",
    matchStatus: ["matched", "verified"],
    limit: 10,
  });

  const url = requested[0] ?? "";
  assert.match(url, /venue=polymarket/);
  assert.match(url, /venueEventId=90177/);
  assert.match(url, /matchStatus=matched/);
  assert.match(url, /matchStatus=verified/);
  assert.match(url, /cursor=current-100/);
  assert.equal(page.nextCursor, "next-100");
});

await test("builds AGG clusters from labeled Yes midpoints and DB rows", async () => {
  const poly = market({
    id: "agg-poly",
    venue: "polymarket",
    externalIdentifier: "101",
    question: "PSG",
  });
  const kalshi = market({
    id: "agg-kalshi",
    venue: "kalshi",
    externalIdentifier: "KXUCL-26-PSG",
    question: "PSG",
  });
  const limitless = market({
    id: "agg-limitless",
    venue: "limitless",
    externalIdentifier: "26242",
    question: "PSG",
  });
  poly.matchedVenueMarkets = [kalshi, limitless];

  const response = await buildAggClusterListResponse({
    query: { minSpread: 0, sort_by: "spread" },
    client: fakeClient({
      markets: [poly],
      midpoints: [
        midpoint("agg-poly", 0.57),
        midpoint("agg-kalshi", 0.55),
        midpoint("agg-limitless", 0.56),
      ],
    }),
    db: fakeDb([
      dbRow({
        id: "polymarket:101",
        venue: "polymarket",
        venueMarketId: "101",
        title: "PSG",
        eventTitle: "Champions League Winner",
        volume24h: 10,
      }),
      dbRow({
        id: "kalshi:KXUCL-26-PSG",
        venue: "kalshi",
        venueMarketId: "KXUCL-26-PSG",
        title: "PSG",
        eventTitle: "Champions League Winner",
        volume24h: 20,
      }),
      dbRow({
        id: "limitless:26242",
        venue: "limitless",
        venueMarketId: "26242",
        title: "PSG",
        eventTitle: "Champions League Winner",
        volume24h: 30,
      }),
    ]),
    now: new Date("2026-05-11T12:00:00.000Z"),
  });

  assert.equal(response.items.length, 1);
  const cluster = response.items[0];
  assert.ok(cluster);
  assert.equal(cluster.source, "agg");
  assert.equal(cluster.venueCount, 3);
  assert.equal(cluster.volume24h, 60);
  assert.equal(cluster.label, "PSG - Champions League Winner");
  assert.equal(cluster.category, "sports");
  assert.ok(cluster.priceSpread != null);
  assert.ok(Math.abs(cluster.priceSpread - 0.02) < 1e-9);
  assert.deepEqual(
    cluster.markets.map((row) => row.yesMid),
    [0.57, 0.55, 0.56],
  );
  assert.deepEqual(
    cluster.markets.map((row) => row.pricingSource),
    ["agg_midpoint", "agg_midpoint", "agg_midpoint"],
  );
  assert.deepEqual(
    cluster.markets.map((row) => row.eventCategory),
    ["sports", "sports", "sports"],
  );
});

await test("forwards cursor and returns one-block deduplicated coverage", async () => {
  const venueMarketParams: unknown[] = [];
  const source = market({
    externalIdentifier: "101",
    id: "agg-poly",
    venue: "polymarket",
  });
  const response = await buildAggClusterListResponse({
    client: fakeClient({
      markets: [source, source],
      midpoints: [],
      nextCursor: "cursor-200",
      venueMarketParams,
    }),
    db: fakeDb([]),
    query: { cursor: "cursor-100", sourceLimit: 100 },
  });

  assert.equal(
    (venueMarketParams[0] as { cursor?: string } | undefined)?.cursor,
    "cursor-100",
  );
  assert.deepEqual(response.coverage, {
    complete: false,
    nextCursor: "cursor-200",
    pagesFetched: 1,
    sourceMarkets: 1,
  });
});

await test("keeps opposite participants with explicit side inversion", async () => {
  const limitlessSenegal = market({
    id: "agg-limitless-senegal",
    venue: "limitless",
    externalIdentifier: "84875",
    question: "Senegal",
  });
  const polyFrance = market({
    id: "agg-poly-france",
    venue: "polymarket",
    externalIdentifier: "1897082",
    question: "France",
  });
  limitlessSenegal.matchedVenueMarkets = [polyFrance];

  const response = await buildAggClusterListResponse({
    query: { minSpread: 0, sort_by: "spread" },
    client: fakeClient({
      markets: [limitlessSenegal],
      midpoints: [
        midpoint("agg-limitless-senegal", 0.135),
        midpoint("agg-poly-france", 0.68),
      ],
    }),
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
    now: new Date("2026-05-11T12:00:00.000Z"),
  });

  assert.equal(response.items.length, 1);
  assert.equal(response.items[0]?.markets.length, 2);
});

await test("builds market alternatives from an AGG matched group", async () => {
  const poly = market({
    id: "agg-poly",
    venue: "polymarket",
    externalIdentifier: "101",
    question: "PSG",
  });
  const kalshi = market({
    id: "agg-kalshi",
    venue: "kalshi",
    externalIdentifier: "KXUCL-26-PSG",
    question: "PSG",
  });
  const limitless = market({
    id: "agg-limitless",
    venue: "limitless",
    externalIdentifier: "26242",
    question: "PSG",
  });
  poly.matchedVenueMarkets = [kalshi, limitless];
  const venueMarketParams: unknown[] = [];

  const response = await buildAggMarketAlternativesResponse({
    marketId: "polymarket:101",
    query: { limit: 5 },
    client: fakeClient({
      markets: [poly],
      midpoints: [
        midpoint("agg-poly", 0.57),
        midpoint("agg-kalshi", 0.55),
        midpoint("agg-limitless", 0.56),
      ],
      venueMarketParams,
    }),
    db: fakeDb([
      dbRow({
        id: "polymarket:101",
        venue: "polymarket",
        venueMarketId: "101",
        title: "PSG",
        eventTitle: "Champions League Winner",
        volume24h: 10,
      }),
      dbRow({
        id: "kalshi:KXUCL-26-PSG",
        venue: "kalshi",
        venueMarketId: "KXUCL-26-PSG",
        title: "PSG",
        eventTitle: "Champions League Winner",
        volume24h: 20,
      }),
      dbRow({
        id: "limitless:26242",
        venue: "limitless",
        venueMarketId: "26242",
        title: "PSG",
        eventTitle: "Champions League Winner",
        volume24h: 30,
      }),
    ]),
    now: new Date("2026-05-11T12:00:00.000Z"),
  });

  assert.ok(response);
  assert.equal(response.status, "matched");
  assert.equal(response.marketId, "polymarket:101");
  assert.equal(response.eventId, "polymarket:101:event");
  assert.equal(response.markets.length, 3);
  assert.equal(response.markets[0]?.marketId, "polymarket:101");
  assert.equal(response.alternatives.length, 2);
  assert.ok(response.priceSpread != null);
  assert.ok(Math.abs(response.priceSpread - 0.02) < 1e-9);
  assert.equal(response.lowestYesMid?.marketId, "kalshi:KXUCL-26-PSG");
  assert.equal(response.lowestNoMid?.marketId, "polymarket:101");
  assert.deepEqual(
    response.markets.map((row) => row.pricingSource),
    ["agg_midpoint", "agg_midpoint", "agg_midpoint"],
  );
  assert.equal(
    (venueMarketParams[0] as { search?: string } | undefined)?.search,
    "Champions League Winner",
  );
});

await test("drops expired market alternatives from AGG matched groups", async () => {
  const poly = market({
    id: "agg-poly",
    venue: "polymarket",
    externalIdentifier: "101",
    question: "PSG",
  });
  const kalshi = market({
    id: "agg-kalshi",
    venue: "kalshi",
    externalIdentifier: "KXUCL-26-PSG",
    question: "PSG",
  });
  const limitless = market({
    id: "agg-limitless",
    venue: "limitless",
    externalIdentifier: "26242",
    question: "PSG",
  });
  poly.matchedVenueMarkets = [kalshi, limitless];

  const response = await buildAggMarketAlternativesResponse({
    marketId: "polymarket:101",
    query: { limit: 5 },
    client: fakeClient({
      markets: [poly],
      midpoints: [
        midpoint("agg-poly", 0.57),
        midpoint("agg-kalshi", 0.55),
        midpoint("agg-limitless", 0.56),
      ],
    }),
    db: fakeDb([
      dbRow({
        id: "polymarket:101",
        venue: "polymarket",
        venueMarketId: "101",
        title: "PSG",
        eventTitle: "Champions League Winner",
      }),
      dbRow({
        id: "kalshi:KXUCL-26-PSG",
        venue: "kalshi",
        venueMarketId: "KXUCL-26-PSG",
        title: "PSG",
        eventTitle: "Champions League Winner",
        closeTime: "2026-05-01T00:00:00.000Z",
        expirationTime: "2026-05-01T00:00:00.000Z",
      }),
      dbRow({
        id: "limitless:26242",
        venue: "limitless",
        venueMarketId: "26242",
        title: "PSG",
        eventTitle: "Champions League Winner",
      }),
    ]),
    now: new Date("2026-05-11T12:00:00.000Z"),
  });

  assert.ok(response);
  assert.equal(response.status, "matched");
  assert.deepEqual(
    response.alternatives.map((market) => market.marketId),
    ["limitless:26242"],
  );
});

await test("returns not_found for expired seed market alternatives", async () => {
  const poly = market({
    id: "agg-poly",
    venue: "polymarket",
    externalIdentifier: "101",
    question: "PSG",
  });
  const limitless = market({
    id: "agg-limitless",
    venue: "limitless",
    externalIdentifier: "26242",
    question: "PSG",
  });
  poly.matchedVenueMarkets = [limitless];

  const response = await buildAggMarketAlternativesResponse({
    marketId: "polymarket:101",
    query: { limit: 5 },
    client: fakeClient({
      markets: [poly],
      midpoints: [midpoint("agg-poly", 0.57), midpoint("agg-kalshi", 0.55)],
    }),
    db: fakeDb([
      dbRow({
        id: "polymarket:101",
        venue: "polymarket",
        venueMarketId: "101",
        title: "PSG",
        eventTitle: "Champions League Winner",
        closeTime: "2026-05-01T00:00:00.000Z",
        expirationTime: "2026-05-01T00:00:00.000Z",
      }),
      dbRow({
        id: "kalshi:KXUCL-26-PSG",
        venue: "kalshi",
        venueMarketId: "KXUCL-26-PSG",
        title: "PSG",
        eventTitle: "Champions League Winner",
      }),
    ]),
    now: new Date("2026-05-11T12:00:00.000Z"),
  });

  assert.ok(response);
  assert.equal(response.status, "not_found");
  assert.equal(response.alternatives.length, 0);
});

await test("returns alternatives symmetrically for each seed in a three-venue group", async () => {
  const poly = market({
    id: "agg-poly-avs",
    venue: "polymarket",
    externalIdentifier: "553828",
    question: "Colorado Avalanche",
  });
  const limitless = market({
    id: "agg-limitless-avs",
    venue: "limitless",
    externalIdentifier: "29749",
    question: "Colorado Avalanche",
  });
  const kalshi = market({
    id: "agg-kalshi-avs",
    venue: "kalshi",
    externalIdentifier: "KXNHL-26-COL",
    question: "Colorado Avalanche",
  });
  poly.matchedVenueMarkets = [limitless, kalshi];

  const db = fakeDb([
    dbRow({
      id: "polymarket:553828",
      venue: "polymarket",
      venueMarketId: "553828",
      title: "Colorado Avalanche",
      eventTitle: "2026 NHL Stanley Cup Champion",
      bestBid: 0.35,
      bestAsk: 0.37,
    }),
    dbRow({
      id: "limitless:29749",
      venue: "limitless",
      venueMarketId: "29749",
      title: "Colorado Avalanche",
      eventTitle: "Colorado Avalanche",
      bestBid: 0.4,
      bestAsk: 0.42,
    }),
    dbRow({
      id: "kalshi:KXNHL-26-COL",
      venue: "kalshi",
      venueMarketId: "KXNHL-26-COL",
      title: "Colorado Avalanche",
      eventTitle: "Stanley Cup Champion?",
      bestBid: 0.31,
      bestAsk: 0.33,
    }),
  ]);
  const client = fakeClient({
    markets: [poly],
    midpoints: [
      midpoint("agg-poly-avs", 0.36),
      midpoint("agg-limitless-avs", 0.41),
      midpoint("agg-kalshi-avs", 0.32),
    ],
  });

  for (const seed of [
    "polymarket:553828",
    "limitless:29749",
    "kalshi:KXNHL-26-COL",
  ]) {
    const response = await buildAggMarketAlternativesResponse({
      marketId: seed,
      query: { limit: 5 },
      client,
      db,
      now: new Date("2026-05-11T12:00:00.000Z"),
    });

    assert.ok(response);
    assert.equal(response.status, "matched");
    assert.equal(response.markets[0]?.marketId, seed);
    assert.equal(response.alternatives.length, 2);
    assert.deepEqual(
      new Set(response.markets.map((row) => row.marketId)),
      new Set(["polymarket:553828", "limitless:29749", "kalshi:KXNHL-26-COL"]),
    );
  }
});

await test("maps opposite participant market alternatives to the inverse side", async () => {
  const limitlessSenegal = market({
    id: "agg-limitless-senegal",
    venue: "limitless",
    externalIdentifier: "84875",
    question: "Senegal",
  });
  const polyFrance = market({
    id: "agg-poly-france",
    venue: "polymarket",
    externalIdentifier: "1897082",
    question: "France",
  });
  limitlessSenegal.matchedVenueMarkets = [polyFrance];

  const response = await buildAggMarketAlternativesResponse({
    marketId: "limitless:84875",
    query: { limit: 5 },
    client: fakeClient({
      markets: [limitlessSenegal],
      midpoints: [
        midpoint("agg-limitless-senegal", 0.135),
        midpoint("agg-poly-france", 0.68),
      ],
    }),
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
    now: new Date("2026-05-11T12:00:00.000Z"),
  });

  assert.ok(response);
  assert.equal(response.status, "matched");
  assert.equal(response.markets.length, 2);
  assert.equal(response.alternatives.length, 1);
  assert.equal(response.alternatives[0]?.outcomeMapping?.sourceYesTo, "NO");
  assert.equal(response.alternatives[0]?.outcomeMapping?.confidence, 0.98);
});

await test("keeps same participant market alternatives", async () => {
  const polyFrance = market({
    id: "agg-poly-france",
    venue: "polymarket",
    externalIdentifier: "1897082",
    question: "France",
  });
  const limitlessFrance = market({
    id: "agg-limitless-france",
    venue: "limitless",
    externalIdentifier: "84874",
    question: "France",
  });
  polyFrance.matchedVenueMarkets = [limitlessFrance];

  const response = await buildAggMarketAlternativesResponse({
    marketId: "polymarket:1897082",
    query: { limit: 5 },
    client: fakeClient({
      markets: [polyFrance],
      midpoints: [
        midpoint("agg-poly-france", 0.68),
        midpoint("agg-limitless-france", 0.66),
      ],
    }),
    db: fakeDb([
      dbRow({
        id: "polymarket:1897082",
        venue: "polymarket",
        venueMarketId: "1897082",
        title: "France",
        eventTitle: "France vs. Senegal",
        bestBid: 0.67,
        bestAsk: 0.69,
      }),
      dbRow({
        id: "limitless:84874",
        venue: "limitless",
        venueMarketId: "84874",
        title: "France",
        eventTitle: "World Cup, France vs Senegal, Jun 16, 2026",
        bestBid: 0.65,
        bestAsk: 0.67,
      }),
    ]),
    now: new Date("2026-05-11T12:00:00.000Z"),
  });

  assert.ok(response);
  assert.equal(response.status, "matched");
  assert.deepEqual(
    response.markets.map((row) => row.marketId),
    ["polymarket:1897082", "limitless:84874"],
  );
  assert.equal(response.matchDiagnostics?.matchedMarketIds.length, 2);
});

await test("bounds the market alternatives cache", async () => {
  clearAggClustersCacheForTests();
  const poly = market({
    id: "agg-poly",
    venue: "polymarket",
    externalIdentifier: "101",
    question: "PSG",
  });
  const kalshi = market({
    id: "agg-kalshi",
    venue: "kalshi",
    externalIdentifier: "KXUCL-26-PSG",
    question: "PSG",
  });
  poly.matchedVenueMarkets = [kalshi];
  const calls = { venueMarkets: 0, midpoints: 0 };
  const client = fakeClient({
    markets: [poly],
    midpoints: [midpoint("agg-poly", 0.57), midpoint("agg-kalshi", 0.55)],
    calls,
  });
  const db = fakeDb([
    dbRow({
      id: "polymarket:101",
      venue: "polymarket",
      venueMarketId: "101",
      title: "PSG",
      eventTitle: "Champions League Winner",
    }),
    dbRow({
      id: "kalshi:KXUCL-26-PSG",
      venue: "kalshi",
      venueMarketId: "KXUCL-26-PSG",
      title: "PSG",
      eventTitle: "Champions League Winner",
    }),
  ]);

  for (let index = 0; index < 501; index += 1) {
    await getAggMarketAlternativesResponseCached({
      marketId: "polymarket:101",
      query: {
        limit: (index % 50) + 1,
        sourceLimit: Math.floor(index / 50) + 1,
      },
      client,
      db,
      ttlSec: 60,
    });
  }
  const callsAfterFill = calls.venueMarkets;

  await getAggMarketAlternativesResponseCached({
    marketId: "polymarket:101",
    query: { limit: 1, sourceLimit: 1 },
    client,
    db,
    ttlSec: 60,
  });

  assert.equal(calls.venueMarkets, callsAfterFill + 1);
});

await test("does not cache not_found market alternatives", async () => {
  clearAggClustersCacheForTests();
  const calls = { venueMarkets: 0, midpoints: 0 };
  const client = fakeClient({
    markets: [],
    midpoints: [],
    calls,
  });
  const db = fakeDb([
    dbRow({
      id: "polymarket:101",
      venue: "polymarket",
      venueMarketId: "101",
      title: "PSG",
      eventTitle: "Champions League Winner",
    }),
  ]);

  const first = await getAggMarketAlternativesResponseCached({
    marketId: "polymarket:101",
    query: { limit: 5 },
    client,
    db,
    ttlSec: 60,
  });
  const callsAfterFirst = calls.venueMarkets;

  const second = await getAggMarketAlternativesResponseCached({
    marketId: "polymarket:101",
    query: { limit: 5 },
    client,
    db,
    ttlSec: 60,
  });

  assert.equal(first?.status, "not_found");
  assert.equal(second?.status, "not_found");
  assert.ok(calls.venueMarkets > callsAfterFirst);
});

await test("caches not_found market alternatives in Redis helper", async () => {
  clearAggClustersCacheForTests();
  const calls = { venueMarkets: 0, midpoints: 0 };
  const cacheClient = new FakeAggClusterCache();
  const client = fakeClient({
    markets: [],
    midpoints: [],
    calls,
  });
  const db = fakeDb([
    dbRow({
      id: "polymarket:101",
      venue: "polymarket",
      venueMarketId: "101",
      title: "PSG",
      eventTitle: "Champions League Winner",
    }),
  ]);

  const first = await getAggMarketAlternativesResponseCachedWithMetadata({
    cacheClient,
    client,
    db,
    marketId: "polymarket:101",
    matchedTtlSec: 60,
    notFoundTtlSec: 30,
    query: { limit: 5 },
  });
  const callsAfterFirst = calls.venueMarkets;

  const second = await getAggMarketAlternativesResponseCachedWithMetadata({
    cacheClient,
    client,
    db,
    marketId: "polymarket:101",
    matchedTtlSec: 60,
    notFoundTtlSec: 30,
    query: { limit: 5 },
  });

  assert.equal(first.response?.status, "not_found");
  assert.equal(first.cache.status, "miss");
  assert.equal(cacheClient.lastSet?.ttl, 30);
  assert.equal(second.response?.status, "not_found");
  assert.equal(second.cache.status, "hit");
  assert.equal(second.cache.kind, "not_found");
  assert.equal(calls.venueMarkets, callsAfterFirst);
});

await test("rejects unsupported market alternatives venues before AGG calls", async () => {
  const calls = { venueMarkets: 0, midpoints: 0 };
  await assert.rejects(
    () =>
      buildAggMarketAlternativesResponse({
        marketId: "polymarket:101",
        query: { venues: "polymarket,badvenue" },
        client: fakeClient({
          markets: [],
          midpoints: [],
          calls,
        }),
        db: fakeDb([]),
      }),
    /Unsupported AGG venues: badvenue/,
  );
  assert.equal(calls.venueMarkets, 0);
  assert.equal(calls.midpoints, 0);
});

await test("bounded broad fallback still fails closed without outcome mapping", async () => {
  clearAggClustersCacheForTests();
  const poly = market({
    id: "agg-poly-aliens",
    venue: "polymarket",
    externalIdentifier: "703257",
    question: "December 31",
  });
  const kalshi = market({
    id: "agg-kalshi-aliens",
    venue: "kalshi",
    externalIdentifier: "KXALIENS-27",
    question: "Before 2027",
  });
  poly.matchedVenueMarkets = [kalshi];

  const venueMarketParams: unknown[] = [];
  const response = await buildAggMarketAlternativesResponse({
    marketId: "polymarket:703257",
    query: {
      limit: 5,
      sourceLimit: 50,
      venues: "polymarket,limitless,kalshi",
    },
    client: {
      async getVenueMarkets(params) {
        venueMarketParams.push(params);
        return {
          items:
            !params.venue && !params.venueEventId && !params.search
              ? [poly]
              : [],
          nextCursor: null,
        };
      },
      async getMidpoints(ids) {
        const wanted = new Set(ids);
        return [
          midpoint("agg-poly-aliens", 0.145),
          midpoint("agg-kalshi-aliens", 0.184),
        ].filter((row) => wanted.has(row.venueMarketId));
      },
    },
    db: fakeDb([
      dbRow({
        id: "polymarket:703257",
        venue: "polymarket",
        venueMarketId: "703257",
        title: "December 31",
        eventTitle: "Will the US confirm that aliens exist by...?",
        venueEventId: "aliens-event",
        bestBid: 0.14,
        bestAsk: 0.15,
      }),
      dbRow({
        id: "kalshi:KXALIENS-27",
        venue: "kalshi",
        venueMarketId: "KXALIENS-27",
        title: "Before 2027",
        eventTitle: "Will the U.S. confirm that aliens exist?",
        bestBid: 0.18,
        bestAsk: 0.188,
      }),
    ]),
  });

  assert.ok(response);
  assert.equal(response.status, "not_found");
  assert.equal(response.diagnostics.outcomeMappingMissing > 0, true);
  assert.ok(venueMarketParams.length > 0);
  assert.equal(venueMarketParams.length, 6);
  assert.equal(
    venueMarketParams.some((params) => {
      const query = params as {
        search?: string;
        venue?: string;
        venueEventId?: string;
      };
      return !query.venue && !query.search && !query.venueEventId;
    }),
    true,
  );
});

await test("uses cached AGG cluster list as alternatives fallback", async () => {
  clearAggClustersCacheForTests();
  const poly = market({
    id: "agg-poly",
    venue: "polymarket",
    externalIdentifier: "101",
    question: "PSG",
  });
  const limitless = market({
    id: "agg-limitless",
    venue: "limitless",
    externalIdentifier: "26242",
    question: "PSG",
  });
  poly.matchedVenueMarkets = [limitless];

  let warmCache = true;
  const venueMarketParams: unknown[] = [];
  const client: AggMarketClient = {
    async getVenueMarkets(params) {
      venueMarketParams.push(params);
      return { items: warmCache ? [poly] : [], nextCursor: null };
    },
    async getMidpoints(ids) {
      const wanted = new Set(ids);
      return [
        midpoint("agg-poly", 0.57),
        midpoint("agg-limitless", 0.55),
      ].filter((row) => wanted.has(row.venueMarketId));
    },
  };
  const db = fakeDb([
    dbRow({
      id: "polymarket:101",
      venue: "polymarket",
      venueMarketId: "101",
      title: "PSG",
      eventTitle: "Champions League Winner",
    }),
    dbRow({
      id: "limitless:26242",
      venue: "limitless",
      venueMarketId: "26242",
      title: "PSG",
      eventTitle: "Champions League Winner",
    }),
  ]);

  await getAggClusterListResponseCached({
    query: { minSpread: 0 },
    client,
    db,
    ttlSec: 60,
  });
  warmCache = false;
  venueMarketParams.length = 0;

  const response = await buildAggMarketAlternativesResponse({
    marketId: "polymarket:101",
    query: { limit: 5 },
    client,
    db,
  });

  assert.ok(response);
  assert.equal(response.status, "matched");
  assert.deepEqual(
    response.markets.map((row) => row.marketId),
    ["polymarket:101", "limitless:26242"],
  );
  assert.equal(
    venueMarketParams.some((params) => {
      const query = params as {
        search?: string;
        venueEventId?: string;
      };
      return !query.search && !query.venueEventId;
    }),
    false,
  );
});

await test("orients top-level AGG midpoints against DB yes and no prices", async () => {
  const poly = market({
    id: "agg-poly",
    venue: "polymarket",
    externalIdentifier: "101",
    question: "Candidate A",
  });
  const kalshi = market({
    id: "agg-kalshi",
    venue: "kalshi",
    externalIdentifier: "KXCANDIDATE-A",
    question: "Candidate A",
  });
  poly.matchedVenueMarkets = [kalshi];

  const response = await buildAggClusterListResponse({
    query: { minSpread: 0, sort_by: "spread" },
    client: fakeClient({
      markets: [poly],
      midpoints: [
        topLevelMidpoint("agg-poly", 0.58),
        topLevelMidpoint("agg-kalshi", 0.58),
      ],
    }),
    db: fakeDb([
      dbRow({
        id: "polymarket:101",
        venue: "polymarket",
        venueMarketId: "101",
        title: "Candidate A",
        bestBid: 0.57,
        bestAsk: 0.59,
      }),
      dbRow({
        id: "kalshi:KXCANDIDATE-A",
        venue: "kalshi",
        venueMarketId: "KXCANDIDATE-A",
        title: "Candidate A",
        bestBid: 0.41,
        bestAsk: 0.43,
      }),
    ]),
  });

  assert.equal(response.items.length, 1);
  const cluster = response.items[0];
  assert.ok(cluster);
  assert.equal(cluster.markets[0]?.yesMid, 0.58);
  const orientedYesMid = cluster.markets[1]?.yesMid;
  assert.ok(orientedYesMid != null);
  assert.ok(Math.abs(orientedYesMid - 0.42) < 1e-9);
  assert.ok(cluster.priceSpread != null);
  assert.ok(Math.abs(cluster.priceSpread - 0.16) < 1e-9);
});

await test("drops one-sided AGG midpoints instead of treating ask-only quotes as fair prices", async () => {
  const poly = market({
    id: "agg-poly-knicks",
    venue: "polymarket",
    externalIdentifier: "553858",
    question: "New York Knicks",
  });
  const limitless = market({
    id: "agg-limitless-knicks",
    venue: "limitless",
    externalIdentifier: "29729",
    question: "New York Knicks",
    venueMarketOutcomes: [
      {
        id: "limitless-knicks:yes",
        externalIdentifier: null,
        label: "Yes",
        price: 0.495,
      },
      {
        id: "limitless-knicks:no",
        externalIdentifier: null,
        label: "No",
        price: 0.505,
      },
    ],
  });
  poly.matchedVenueMarkets = [limitless];

  const response = await buildAggClusterListResponse({
    query: { minSpread: 0 },
    client: fakeClient({
      markets: [poly],
      midpoints: [
        midpoint("agg-poly-knicks", 0.1375),
        topLevelMidpoint("agg-limitless-knicks", 0.99, "local_one_sided"),
      ],
    }),
    db: fakeDb([
      dbRow({
        id: "polymarket:553858",
        venue: "polymarket",
        venueMarketId: "553858",
        title: "New York Knicks",
        eventTitle: "2026 NBA Champion",
        bestBid: 0.137,
        bestAsk: 0.138,
      }),
      dbRow({
        id: "limitless:29729",
        venue: "limitless",
        venueMarketId: "29729",
        title: "New York Knicks",
        eventTitle: "2026 NBA Champion",
        bestBid: null,
        bestAsk: 0.99,
        lastPrice: 0.155439,
      }),
    ]),
  });

  assert.equal(response.items.length, 0);
});

await test("drops labeled AGG midpoints that conflict with reliable DB last price", async () => {
  const poly = market({
    id: "agg-poly-knicks",
    venue: "polymarket",
    externalIdentifier: "553858",
    question: "New York Knicks",
  });
  const limitless = market({
    id: "agg-limitless-knicks",
    venue: "limitless",
    externalIdentifier: "29729",
    question: "New York Knicks",
  });
  poly.matchedVenueMarkets = [limitless];

  const response = await buildAggClusterListResponse({
    query: { minSpread: 0 },
    client: fakeClient({
      markets: [poly],
      midpoints: [
        midpoint("agg-poly-knicks", 0.1375),
        midpoint("agg-limitless-knicks", 0.86),
      ],
    }),
    db: fakeDb([
      dbRow({
        id: "polymarket:553858",
        venue: "polymarket",
        venueMarketId: "553858",
        title: "New York Knicks",
        eventTitle: "2026 NBA Champion",
        bestBid: 0.137,
        bestAsk: 0.138,
      }),
      dbRow({
        id: "limitless:29729",
        venue: "limitless",
        venueMarketId: "29729",
        title: "New York Knicks",
        eventTitle: "2026 NBA Champion",
        bestBid: null,
        bestAsk: 0.99,
        lastPrice: 0.155439,
      }),
    ]),
  });

  assert.equal(response.items.length, 0);
});

await test("sorts AGG clusters by 24h volume desc by default", async () => {
  const lowVolumePoly = market({
    id: "agg-poly-low",
    venue: "polymarket",
    externalIdentifier: "poly-low",
    question: "Wide spread low volume",
  });
  const lowVolumeKalshi = market({
    id: "agg-kalshi-low",
    venue: "kalshi",
    externalIdentifier: "kalshi-low",
    question: "Wide spread low volume",
  });
  lowVolumePoly.matchedVenueMarkets = [lowVolumeKalshi];

  const highVolumePoly = market({
    id: "agg-poly-high",
    venue: "polymarket",
    externalIdentifier: "poly-high",
    question: "Narrow spread high volume",
  });
  const highVolumeKalshi = market({
    id: "agg-kalshi-high",
    venue: "kalshi",
    externalIdentifier: "kalshi-high",
    question: "Narrow spread high volume",
  });
  highVolumePoly.matchedVenueMarkets = [highVolumeKalshi];

  const response = await buildAggClusterListResponse({
    query: {},
    client: fakeClient({
      markets: [lowVolumePoly, highVolumePoly],
      midpoints: [
        midpoint("agg-poly-low", 0.7),
        midpoint("agg-kalshi-low", 0.5),
        midpoint("agg-poly-high", 0.52),
        midpoint("agg-kalshi-high", 0.54),
      ],
    }),
    db: fakeDb([
      dbRow({
        id: "polymarket:low",
        venue: "polymarket",
        venueMarketId: "poly-low",
        title: "Wide spread low volume",
        volume24h: 1,
      }),
      dbRow({
        id: "kalshi:low",
        venue: "kalshi",
        venueMarketId: "kalshi-low",
        title: "Wide spread low volume",
        volume24h: 1,
      }),
      dbRow({
        id: "polymarket:high",
        venue: "polymarket",
        venueMarketId: "poly-high",
        title: "Narrow spread high volume",
        volume24h: 0,
        activityVolume24h: 100,
        activityVolumeValid: true,
      }),
      dbRow({
        id: "kalshi:high",
        venue: "kalshi",
        venueMarketId: "kalshi-high",
        title: "Narrow spread high volume",
        volume24h: 0,
        activityVolume24h: 150,
        activityVolumeValid: true,
      }),
    ]),
  });

  assert.equal(response.items.length, 2);
  assert.equal(response.items[0]?.volume24h, 250);
  assert.equal(response.items[1]?.volume24h, 2);
});

await test("drops groups with duplicate venues until side alignment is explicit", async () => {
  const poly = market({
    id: "agg-poly",
    venue: "polymarket",
    externalIdentifier: "2133860",
    question: "Spurs vs. Timberwolves",
  });
  const kalshiLeft = market({
    id: "agg-kalshi-left",
    venue: "kalshi",
    externalIdentifier: "KXNBASERIES-LEFT",
    question: "San Antonio",
  });
  const kalshiRight = market({
    id: "agg-kalshi-right",
    venue: "kalshi",
    externalIdentifier: "KXNBASERIES-RIGHT",
    question: "Minnesota",
  });
  poly.matchedVenueMarkets = [kalshiLeft, kalshiRight];

  const response = await buildAggClusterListResponse({
    query: { minSpread: 0 },
    client: fakeClient({
      markets: [poly],
      midpoints: [
        midpoint("agg-poly", 0.79),
        midpoint("agg-kalshi-left", 0.77),
        midpoint("agg-kalshi-right", 0.23),
      ],
    }),
    db: fakeDb([
      dbRow({
        id: "polymarket:2133860",
        venue: "polymarket",
        venueMarketId: "2133860",
      }),
      dbRow({
        id: "kalshi:KXNBASERIES-LEFT",
        venue: "kalshi",
        venueMarketId: "KXNBASERIES-LEFT",
      }),
      dbRow({
        id: "kalshi:KXNBASERIES-RIGHT",
        venue: "kalshi",
        venueMarketId: "KXNBASERIES-RIGHT",
      }),
    ]),
  });

  assert.equal(response.items.length, 0);
});

await test("matches by condition id when external id does not match", async () => {
  const poly = market({
    id: "agg-poly",
    venue: "polymarket",
    externalIdentifier: "agg-internal-id",
    conditionId: "condition-1",
  });
  const limitless = market({
    id: "agg-limitless",
    venue: "limitless",
    externalIdentifier: "26242",
  });
  poly.matchedVenueMarkets = [limitless];

  const response = await buildAggClusterListResponse({
    query: { minSpread: 0 },
    client: fakeClient({
      markets: [poly],
      midpoints: [midpoint("agg-poly", 0.51), midpoint("agg-limitless", 0.49)],
    }),
    db: fakeDb([
      dbRow({
        id: "polymarket:real-market",
        venue: "polymarket",
        venueMarketId: "real-market",
        conditionId: "condition-1",
        title: "Candidate",
      }),
      dbRow({
        id: "limitless:26242",
        venue: "limitless",
        venueMarketId: "26242",
        title: "Candidate",
      }),
    ]),
  });

  assert.equal(response.items.length, 1);
  const cluster = response.items[0];
  assert.ok(cluster);
  const methods = cluster.markets.map((row) => row.matchMethod);
  assert.deepEqual(methods, ["conditionId", "externalIdentifier"]);
});

await test("drops AGG markets whose selected-side midpoint conflicts with DB midpoint", async () => {
  const poly = market({
    id: "agg-poly",
    venue: "polymarket",
    externalIdentifier: "101",
  });
  const kalshi = market({
    id: "agg-kalshi",
    venue: "kalshi",
    externalIdentifier: "KXTEST",
  });
  const limitless = market({
    id: "agg-limitless",
    venue: "limitless",
    externalIdentifier: "26242",
  });
  poly.matchedVenueMarkets = [kalshi, limitless];

  const response = await buildAggClusterListResponse({
    query: { minSpread: 0 },
    client: fakeClient({
      markets: [poly],
      midpoints: [
        midpoint("agg-poly", 0.51),
        midpoint("agg-kalshi", 0.52),
        midpoint("agg-limitless", 0.82),
      ],
    }),
    db: fakeDb([
      dbRow({
        id: "polymarket:101",
        venue: "polymarket",
        venueMarketId: "101",
        title: "Candidate",
      }),
      dbRow({
        id: "kalshi:KXTEST",
        venue: "kalshi",
        venueMarketId: "KXTEST",
        title: "Candidate",
      }),
      dbRow({
        id: "limitless:26242",
        venue: "limitless",
        venueMarketId: "26242",
        title: "Candidate",
      }),
    ]),
  });

  assert.equal(response.items.length, 1);
  const cluster = response.items[0];
  assert.ok(cluster);
  assert.deepEqual(
    cluster.markets.map((row) => row.venue),
    ["polymarket", "kalshi"],
  );
});

await test("rejects unsupported venues before calling AGG", async () => {
  const calls = { venueMarkets: 0, midpoints: 0 };
  await assert.rejects(
    () =>
      buildAggClusterListResponse({
        query: { venues: "polymarket,opinion" },
        client: fakeClient({ markets: [], midpoints: [], calls }),
        db: fakeDb([]),
      }),
    /Unsupported AGG venues: opinion/,
  );
  assert.equal(calls.venueMarkets, 0);
  assert.equal(calls.midpoints, 0);
});

await test("uses the in-memory cache for matching query params", async () => {
  clearAggClustersCacheForTests();
  const calls = { venueMarkets: 0, midpoints: 0 };
  const client = fakeClient({ markets: [], midpoints: [], calls });
  const db = fakeDb([]);

  await getAggClusterListResponseCached({
    query: { limit: 5 },
    client,
    db,
    ttlSec: 30,
  });
  await getAggClusterListResponseCached({
    query: { limit: 5 },
    client,
    db,
    ttlSec: 30,
  });

  assert.equal(calls.venueMarkets, 1);
  assert.equal(calls.midpoints, 1);
  clearAggClustersCacheForTests();
});

await test("isolates AGG cluster cache entries by cursor", async () => {
  clearAggClustersCacheForTests();
  const calls = { venueMarkets: 0, midpoints: 0 };
  const client = fakeClient({ markets: [], midpoints: [], calls });
  const db = fakeDb([]);

  await getAggClusterListResponseCached({
    query: { cursor: "page-a", limit: 5 },
    client,
    db,
    ttlSec: 30,
  });
  await getAggClusterListResponseCached({
    query: { cursor: "page-b", limit: 5 },
    client,
    db,
    ttlSec: 30,
  });

  assert.equal(calls.venueMarkets, 2);
  clearAggClustersCacheForTests();
});

await test("uses Redis cache when local AGG cluster cache is cold", async () => {
  clearAggClustersCacheForTests();
  const calls = { venueMarkets: 0, midpoints: 0 };
  const cacheClient = new FakeAggClusterCache();
  const client = fakeClient({ markets: [], midpoints: [], calls });
  const db = fakeDb([]);

  const first = await getAggClusterListResponseCachedWithMetadata({
    query: { limit: 5 },
    client,
    db,
    ttlSec: 30,
    cacheClient,
  });
  assert.deepEqual(first.cache, { status: "miss", layer: "none" });
  assert.equal(cacheClient.getCalls, 1);
  assert.equal(cacheClient.setCalls, 1);
  assert.equal(cacheClient.lastSet?.ttl, 30);
  assert.equal(calls.venueMarkets, 1);

  clearAggClustersCacheForTests();
  const second = await getAggClusterListResponseCachedWithMetadata({
    query: { limit: 5 },
    client,
    db,
    ttlSec: 30,
    cacheClient,
  });

  assert.deepEqual(second.cache, { status: "hit", layer: "redis" });
  assert.deepEqual(second.response, first.response);
  assert.equal(cacheClient.getCalls, 2);
  assert.equal(cacheClient.setCalls, 1);
  assert.equal(calls.venueMarkets, 1);
  clearAggClustersCacheForTests();
});

await test("uses local AGG cluster cache before Redis", async () => {
  clearAggClustersCacheForTests();
  const calls = { venueMarkets: 0, midpoints: 0 };
  const cacheClient = new FakeAggClusterCache();
  const client = fakeClient({ markets: [], midpoints: [], calls });
  const db = fakeDb([]);

  await getAggClusterListResponseCachedWithMetadata({
    query: { limit: 5 },
    client,
    db,
    ttlSec: 30,
    cacheClient,
  });
  const second = await getAggClusterListResponseCachedWithMetadata({
    query: { limit: 5 },
    client,
    db,
    ttlSec: 30,
    cacheClient,
  });

  assert.deepEqual(second.cache, { status: "hit", layer: "local" });
  assert.equal(cacheClient.getCalls, 1);
  assert.equal(cacheClient.setCalls, 1);
  assert.equal(calls.venueMarkets, 1);
  clearAggClustersCacheForTests();
});

await test("caches empty successful AGG cluster responses", async () => {
  clearAggClustersCacheForTests();
  const calls = { venueMarkets: 0, midpoints: 0 };
  const cacheClient = new FakeAggClusterCache();
  const client = fakeClient({ markets: [], midpoints: [], calls });
  const db = fakeDb([]);

  const first = await getAggClusterListResponseCachedWithMetadata({
    query: { limit: 5 },
    client,
    db,
    ttlSec: 30,
    cacheClient,
  });
  assert.equal(first.response.items.length, 0);
  assert.equal(cacheClient.setCalls, 1);

  clearAggClustersCacheForTests();
  const second = await getAggClusterListResponseCachedWithMetadata({
    query: { limit: 5 },
    client,
    db,
    ttlSec: 30,
    cacheClient,
  });
  assert.deepEqual(second.cache, { status: "hit", layer: "redis" });
  assert.equal(second.response.items.length, 0);
  assert.equal(calls.venueMarkets, 1);
  clearAggClustersCacheForTests();
});

await test("does not cache failed AGG cluster builds", async () => {
  clearAggClustersCacheForTests();
  const cacheClient = new FakeAggClusterCache();
  let calls = 0;
  const client: AggMarketClient = {
    async getVenueMarkets() {
      calls += 1;
      throw new Error("AGG failed");
    },
    async getMidpoints() {
      return [];
    },
  };
  const db = fakeDb([]);

  await assert.rejects(
    () =>
      getAggClusterListResponseCachedWithMetadata({
        query: { limit: 5 },
        client,
        db,
        ttlSec: 30,
        cacheClient,
      }),
    /AGG failed/,
  );
  await assert.rejects(
    () =>
      getAggClusterListResponseCachedWithMetadata({
        query: { limit: 5 },
        client,
        db,
        ttlSec: 30,
        cacheClient,
      }),
    /AGG failed/,
  );

  assert.equal(calls, 2);
  assert.equal(cacheClient.setCalls, 0);
  clearAggClustersCacheForTests();
});

await test("falls back when AGG cluster Redis cache fails", async () => {
  clearAggClustersCacheForTests();
  const calls = { venueMarkets: 0, midpoints: 0 };
  const cacheClient = new FakeAggClusterCache();
  cacheClient.failGet = true;
  const errors: string[] = [];

  const result = await getAggClusterListResponseCachedWithMetadata({
    query: { limit: 5 },
    client: fakeClient({ markets: [], midpoints: [], calls }),
    db: fakeDb([]),
    ttlSec: 30,
    cacheClient,
    onCacheError: (operation) => errors.push(operation),
  });

  assert.deepEqual(result.cache, { status: "skip", layer: "none" });
  assert.deepEqual(errors, ["read"]);
  assert.equal(result.response.items.length, 0);
  assert.equal(calls.venueMarkets, 1);
  clearAggClustersCacheForTests();
});

await test("disables AGG cluster caches when ttl is zero", async () => {
  clearAggClustersCacheForTests();
  const calls = { venueMarkets: 0, midpoints: 0 };
  const cacheClient = new FakeAggClusterCache();
  const client = fakeClient({ markets: [], midpoints: [], calls });
  const db = fakeDb([]);

  const first = await getAggClusterListResponseCachedWithMetadata({
    query: { limit: 5 },
    client,
    db,
    ttlSec: 0,
    cacheClient,
  });
  const second = await getAggClusterListResponseCachedWithMetadata({
    query: { limit: 5 },
    client,
    db,
    ttlSec: 0,
    cacheClient,
  });

  assert.deepEqual(first.cache, { status: "skip", layer: "none" });
  assert.deepEqual(second.cache, { status: "skip", layer: "none" });
  assert.equal(cacheClient.getCalls, 0);
  assert.equal(cacheClient.setCalls, 0);
  assert.equal(calls.venueMarkets, 2);
  clearAggClustersCacheForTests();
});
