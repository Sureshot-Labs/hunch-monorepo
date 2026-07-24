#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { buildApp } from "./app.js";
import { pool } from "./db.js";
import { env } from "./env.js";
import { getRedisStatus } from "./redis.js";

const INDEX_KEY = "ai:cluster:index";
const META_KEY = "ai:cluster:meta";
const CLUSTER_KEY_PREFIX = "ai:cluster:";

type ClusterListPayload = {
  items: Array<{
    id: string;
    score?: number;
    volume24h?: number | null;
    matchDiagnostics?: {
      exactMatchRatio?: number | null;
      matchTierCounts?: Record<string, number>;
    } | null;
    markets: Array<{
      marketImage?: string | null;
      eventImage?: string | null;
      image?: string | null;
    }>;
  }>;
};

type ClusterDetailPayload = {
  markets: Array<{
    marketId: string;
    marketSlug?: string | null;
    eventSlug?: string | null;
    marketImage?: string | null;
    eventImage?: string | null;
    marketIcon?: string | null;
    eventIcon?: string | null;
  }>;
};

function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function insertEvent(args: {
  id: string;
  venue: "polymarket" | "kalshi";
  venueEventId: string;
  title: string;
  slug: string;
  image: string;
  icon: string;
}) {
  await pool.query(
    `
      insert into unified_events (
        id,
        venue,
        venue_event_id,
        title,
        description,
        category,
        status,
        start_date,
        end_date,
        volume_total,
        volume_24h,
        liquidity,
        slug,
        image,
        icon,
        created_at,
        updated_at
      )
      values (
        $1, $2, $3, $4, null, 'politics', 'ACTIVE',
        now() - interval '1 hour',
        now() + interval '7 day',
        100, 25, 100, $5, $6, $7, now(), now()
      )
    `,
    [
      args.id,
      args.venue,
      args.venueEventId,
      args.title,
      args.slug,
      args.image,
      args.icon,
    ],
  );
}

async function insertMarket(args: {
  id: string;
  venue: "polymarket" | "kalshi";
  venueMarketId: string;
  eventId: string;
  title: string;
  slug: string;
  image: string;
  icon: string;
}) {
  await pool.query(
    `
      insert into unified_markets (
        id,
        venue,
        venue_market_id,
        event_id,
        title,
        description,
        category,
        status,
        market_type,
        open_time,
        close_time,
        expiration_time,
        best_bid,
        best_ask,
        last_price,
        volume_total,
        volume_24h,
        liquidity,
        open_interest,
        outcomes,
        slug,
        image,
        icon,
        created_at,
        updated_at
      )
      values (
        $1, $2, $3, $4, $5, null, 'politics', 'ACTIVE', 'binary',
        now() - interval '1 hour',
        now() + interval '7 day',
        now() + interval '7 day',
        0.45, 0.55, 0.5, 100, 25, 100, 50,
        '["Yes","No"]', $6, $7, $8, now(), now()
      )
    `,
    [
      args.id,
      args.venue,
      args.venueMarketId,
      args.eventId,
      args.title,
      args.slug,
      args.image,
      args.icon,
    ],
  );
}

async function main() {
  if (!env.redisUrl) {
    console.log("[clusters-routes-tests] skipped (REDIS_URL missing)");
    return;
  }

  const app = await buildApp();
  const { redis, status } = await getRedisStatus({ force: true });
  assert.equal(status, "ready");
  assert.ok(redis, "expected redis client");

  const suiteId = crypto.randomUUID().slice(0, 8);
  const clusterId = `test-cluster-${suiteId}`;
  const clusterHighScore = `test-cluster-high-${suiteId}`;
  const clusterAlphaTie = `test-cluster-alpha-${suiteId}`;
  const clusterLowVolume = `test-cluster-low-${suiteId}`;
  const eventA = makeId("cluster:event");
  const eventB = makeId("cluster:event");
  const marketA = makeId("cluster:market");
  const marketB = makeId("cluster:market");

  const previousIndex = await redis.get(INDEX_KEY);
  const previousMeta = await redis.hGetAll(META_KEY);

  await insertEvent({
    id: eventA,
    venue: "polymarket",
    venueEventId: makeId("venue-event"),
    title: `Cluster route alpha ${suiteId}`,
    slug: `cluster-route-alpha-${suiteId}`,
    image: `https://example.com/event-alpha-${suiteId}.png`,
    icon: `https://example.com/event-alpha-${suiteId}.ico`,
  });
  await insertEvent({
    id: eventB,
    venue: "kalshi",
    venueEventId: makeId("venue-event"),
    title: `Cluster route beta ${suiteId}`,
    slug: `cluster-route-beta-${suiteId}`,
    image: `https://example.com/event-beta-${suiteId}.png`,
    icon: `https://example.com/event-beta-${suiteId}.ico`,
  });
  await insertMarket({
    id: marketA,
    venue: "polymarket",
    venueMarketId: makeId("venue-market"),
    eventId: eventA,
    title: `Alpha market ${suiteId}`,
    slug: `alpha-market-${suiteId}`,
    image: `https://example.com/market-alpha-${suiteId}.png`,
    icon: `https://example.com/market-alpha-${suiteId}.ico`,
  });
  await insertMarket({
    id: marketB,
    venue: "kalshi",
    venueMarketId: makeId("venue-market"),
    eventId: eventB,
    title: `Beta market ${suiteId}`,
    slug: `beta-market-${suiteId}`,
    image: `https://example.com/market-beta-${suiteId}.png`,
    icon: `https://example.com/market-beta-${suiteId}.ico`,
  });

  const preview = [
    {
      marketId: marketA,
      eventId: eventA,
      venue: "polymarket",
      marketSlug: `alpha-market-${suiteId}`,
      eventSlug: `cluster-route-alpha-${suiteId}`,
      marketImage: `https://example.com/market-alpha-${suiteId}.png`,
      eventImage: `https://example.com/event-alpha-${suiteId}.png`,
      image: `https://example.com/market-alpha-${suiteId}.png`,
      icon: `https://example.com/market-alpha-${suiteId}.ico`,
      marketTitle: `Alpha market ${suiteId}`,
      eventTitle: `Cluster route alpha ${suiteId}`,
      marketType: "binary",
      yesBid: 0.45,
      yesAsk: 0.55,
      yesMid: 0.5,
      noMid: 0.5,
      liquidity: 100,
      volume24h: 25,
      volumeTotal: 100,
      openInterest: 50,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    },
  ];

  await redis.set(
    INDEX_KEY,
    JSON.stringify([
      clusterLowVolume,
      clusterAlphaTie,
      clusterHighScore,
      clusterId,
    ]),
  );
  await redis.hSet(META_KEY, {
    generated_at: new Date().toISOString(),
    count: "4",
    version: "v2",
  });
  await redis.hSet(`${CLUSTER_KEY_PREFIX}${clusterId}`, {
    label: `Cluster route label ${suiteId}`,
    score: "123",
    seed_market_id: marketA,
    market_count: "2",
    venue_count: "2",
    venue_counts: JSON.stringify({ polymarket: 1, kalshi: 1 }),
    price_spread: "0.12",
    min_liquidity: "100",
    total_liquidity: "200",
    volume_24h: "50",
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    analysis: JSON.stringify({
      label: `Cluster route label ${suiteId}`,
      summary:
        "- Shared Theme: test\n- Key Difference: test\n- Why It May Be Mispriced: test\n- What to Watch: test",
      category: "politics",
      outliers: [marketB],
      confidence: 0.9,
    }),
    analysis_status: "ready",
    analysis_updated_at: new Date().toISOString(),
    analysis_confidence: "0.9",
    analysis_model: "test-model",
    quality_score: "0.88",
    match_details: JSON.stringify([
      { marketId: marketA, score: 1, tier: "seed" },
      { marketId: marketB, score: 0.93, tier: "structuredExact" },
    ]),
    match_diagnostics: JSON.stringify({
      family: "other",
      category: "politics",
      matchTierCounts: {
        seed: 1,
        structuredExact: 1,
        lexicalExact: 0,
        marketEmbedding: 0,
      },
      weakestMatchScore: 0.93,
      medianMatchScore: 0.93,
      meanMatchScore: 0.93,
      exactMatchRatio: 1,
      prePruneOutlierRatio: 0.5,
    }),
    market_ids: JSON.stringify([marketA, marketB]),
    markets_preview: JSON.stringify(preview),
    updated_at: new Date().toISOString(),
    version: "v2",
  });
  await redis.hSet(`${CLUSTER_KEY_PREFIX}${clusterHighScore}`, {
    label: `Cluster route volume high ${suiteId}`,
    score: "200",
    seed_market_id: marketA,
    market_count: "2",
    venue_count: "2",
    venue_counts: JSON.stringify({ polymarket: 1, kalshi: 1 }),
    price_spread: "0.10",
    min_liquidity: "100",
    total_liquidity: "250",
    volume_24h: "120",
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    analysis: "",
    analysis_status: "",
    analysis_updated_at: "",
    analysis_confidence: "",
    analysis_model: "",
    quality_score: "0.70",
    match_details: JSON.stringify([]),
    match_diagnostics: JSON.stringify(null),
    market_ids: JSON.stringify([marketA, marketB]),
    markets_preview: JSON.stringify(preview),
    updated_at: new Date().toISOString(),
    version: "v2",
  });
  await redis.hSet(`${CLUSTER_KEY_PREFIX}${clusterAlphaTie}`, {
    label: `Cluster route volume alpha ${suiteId}`,
    score: "200",
    seed_market_id: marketA,
    market_count: "2",
    venue_count: "2",
    venue_counts: JSON.stringify({ polymarket: 1, kalshi: 1 }),
    price_spread: "0.10",
    min_liquidity: "100",
    total_liquidity: "250",
    volume_24h: "120",
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    analysis: "",
    analysis_status: "",
    analysis_updated_at: "",
    analysis_confidence: "",
    analysis_model: "",
    quality_score: "0.70",
    match_details: JSON.stringify([]),
    match_diagnostics: JSON.stringify(null),
    market_ids: JSON.stringify([marketA, marketB]),
    markets_preview: JSON.stringify(preview),
    updated_at: new Date().toISOString(),
    version: "v2",
  });
  await redis.hSet(`${CLUSTER_KEY_PREFIX}${clusterLowVolume}`, {
    label: `Cluster route volume low ${suiteId}`,
    score: "999",
    seed_market_id: marketA,
    market_count: "2",
    venue_count: "2",
    venue_counts: JSON.stringify({ polymarket: 1, kalshi: 1 }),
    price_spread: "0.10",
    min_liquidity: "100",
    total_liquidity: "250",
    volume_24h: "5",
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    analysis: "",
    analysis_status: "",
    analysis_updated_at: "",
    analysis_confidence: "",
    analysis_model: "",
    quality_score: "0.70",
    match_details: JSON.stringify([]),
    match_diagnostics: JSON.stringify(null),
    market_ids: JSON.stringify([marketA, marketB]),
    markets_preview: JSON.stringify(preview),
    updated_at: new Date().toISOString(),
    version: "v2",
  });

  try {
    const listResponse = await app.inject({
      method: "GET",
      url: "/clusters?minQualityScore=0&minAnalysisConfidence=0&maxOutlierRatio=1&minSpread=0&minVenueCount=1&limit=10",
    });
    assert.equal(listResponse.statusCode, 200, listResponse.body);
    const listPayload = listResponse.json<ClusterListPayload>();
    const summary = listPayload.items.find((item) => item.id === clusterId);
    assert.ok(summary, "expected seeded cluster in list response");
    assert.equal(summary.matchDiagnostics?.exactMatchRatio, 1);
    assert.equal(
      summary.markets[0]?.marketImage,
      `https://example.com/market-alpha-${suiteId}.png`,
    );

    const sortedDescResponse = await app.inject({
      method: "GET",
      url: "/clusters?minQualityScore=0&minAnalysisConfidence=0&maxOutlierRatio=1&minSpread=0&minVenueCount=1&limit=2&sort_by=volume24h&sort_dir=desc",
    });
    assert.equal(sortedDescResponse.statusCode, 200, sortedDescResponse.body);
    const sortedDescPayload = sortedDescResponse.json<ClusterListPayload>();
    assert.deepEqual(
      sortedDescPayload.items.map((item) => item.id),
      [clusterAlphaTie, clusterHighScore],
      "expected clusters to be sorted by volume desc, then score desc, then id asc before limit",
    );

    const sortedAscResponse = await app.inject({
      method: "GET",
      url: "/clusters?minQualityScore=0&minAnalysisConfidence=0&maxOutlierRatio=1&minSpread=0&minVenueCount=1&limit=4&sort_by=volume24h&sort_dir=asc",
    });
    assert.equal(sortedAscResponse.statusCode, 200, sortedAscResponse.body);
    const sortedAscPayload = sortedAscResponse.json<ClusterListPayload>();
    assert.deepEqual(
      sortedAscPayload.items.map((item) => item.id),
      [clusterLowVolume, clusterId, clusterAlphaTie, clusterHighScore],
      "expected asc ordering with score and id tie-breakers",
    );

    const detailResponse = await app.inject({
      method: "GET",
      url: `/clusters/${encodeURIComponent(clusterId)}`,
    });
    assert.equal(detailResponse.statusCode, 200, detailResponse.body);
    const detailPayload = detailResponse.json<ClusterDetailPayload>();
    assert.equal(
      detailPayload.markets.length,
      1,
      "expected outlier market to be hidden",
    );
    assert.equal(detailPayload.markets[0]?.marketId, marketA);
    assert.equal(
      detailPayload.markets[0]?.marketSlug,
      `alpha-market-${suiteId}`,
    );
    assert.equal(
      detailPayload.markets[0]?.eventSlug,
      `cluster-route-alpha-${suiteId}`,
    );
    assert.equal(
      detailPayload.markets[0]?.marketImage,
      `https://example.com/market-alpha-${suiteId}.png`,
    );
    assert.equal(
      detailPayload.markets[0]?.eventImage,
      `https://example.com/event-alpha-${suiteId}.png`,
    );

    console.log("[clusters-routes-tests] ok");
  } finally {
    await pool.query("delete from unified_markets where id = any($1::text[])", [
      [marketA, marketB],
    ]);
    await pool.query("delete from unified_events where id = any($1::text[])", [
      [eventA, eventB],
    ]);

    const cleanup = redis.multi();
    cleanup.del(`${CLUSTER_KEY_PREFIX}${clusterId}`);
    cleanup.del(`${CLUSTER_KEY_PREFIX}${clusterHighScore}`);
    cleanup.del(`${CLUSTER_KEY_PREFIX}${clusterAlphaTie}`);
    cleanup.del(`${CLUSTER_KEY_PREFIX}${clusterLowVolume}`);
    cleanup.del(INDEX_KEY);
    cleanup.del(META_KEY);
    if (previousIndex) cleanup.set(INDEX_KEY, previousIndex);
    if (previousMeta && Object.keys(previousMeta).length > 0) {
      cleanup.hSet(META_KEY, previousMeta);
    }
    await cleanup.exec();
    await app.close();
  }
}

await main();
