#!/usr/bin/env tsx

import assert from "node:assert/strict";
import type { DbQuery } from "./db.js";
import {
  chunkAggVenueMarketIds,
  type AggMarketClient,
  type AggMidpoint,
  type AggVenueMarket,
} from "./services/agg-market-client.js";
import {
  buildAggClusterListResponse,
  clearAggClustersCacheForTests,
  getAggClusterListResponseCached,
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
    spread: null,
    timestamp: null,
    outcomes: [
      {
        id: `${venueMarketId}:no`,
        label: "No",
        midpoint: 1 - yesMid,
        price: null,
      },
      {
        id: `${venueMarketId}:yes`,
        label: "Yes",
        midpoint: yesMid,
        price: null,
      },
    ],
  };
}

function dbRow(args: {
  id: string;
  eventId?: string;
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
    best_bid: 0.4,
    best_ask: 0.6,
    last_price: 0.5,
    volume_24h: args.volume24h ?? 10,
    activity_volume_last_24h: args.activityVolume24h ?? null,
    activity_volume_valid: args.activityVolumeValid ?? false,
    volume_total: 100,
    liquidity: args.liquidity ?? 20,
    open_interest: 5,
    close_time: "2026-06-01T00:00:00.000Z",
    expiration_time: "2026-06-01T00:00:00.000Z",
    condition_id: args.conditionId ?? null,
    event_title: args.eventTitle ?? "Event title",
    event_description: null,
    event_slug: null,
    event_image: null,
    event_icon: null,
    event_category: args.eventCategory ?? "sports",
  };
}

function fakeClient(args: {
  markets: AggVenueMarket[];
  midpoints: AggMidpoint[];
  calls?: { venueMarkets: number; midpoints: number };
}): AggMarketClient {
  return {
    async getVenueMarkets() {
      if (args.calls) args.calls.venueMarkets += 1;
      return args.markets;
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
    async query() {
      return { rows };
    },
  } as unknown as DbQuery;
}

await test("chunks midpoint ids at the AGG limit", () => {
  const ids = Array.from({ length: 401 }, (_, index) => `m-${index}`);
  const chunks = chunkAggVenueMarketIds(ids, 200);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]?.length, 200);
  assert.equal(chunks[1]?.length, 200);
  assert.equal(chunks[2]?.length, 1);
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
      }),
      dbRow({
        id: "limitless:26242",
        venue: "limitless",
        venueMarketId: "26242",
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
      }),
      dbRow({
        id: "kalshi:KXTEST",
        venue: "kalshi",
        venueMarketId: "KXTEST",
      }),
      dbRow({
        id: "limitless:26242",
        venue: "limitless",
        venueMarketId: "26242",
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
