#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { buildApp } from "./app.js";
import { pool } from "./db.js";
import { env } from "./env.js";
import { getRedisStatus } from "./redis.js";
import { insertRuntimePolicy } from "./repos/runtime-policies.js";
import {
  marketMapActiveKey,
  marketMapRunNodeEventsKey,
  marketMapRunNodeKey,
  marketMapRunNodesGlobalKey,
  type MarketMapEventSummary,
  type MarketMapNode,
  type MarketMapNodeVenueMetrics,
  type MarketMapVenue,
} from "./services/market-map.js";

type NodeEventsPayload = {
  total: number;
  offset: number;
  limit: number;
  venues?: string[];
  items: Array<{
    eventId: string;
    venue: string;
    volume24h: number;
    liquidity: number;
    openInterest: number;
    score: number;
    topSignal?: {
      title: string;
      targetMarketId?: string | null;
      targetMarketTitle?: string | null;
      targetEventId?: string | null;
    } | null;
  }>;
};

type MarketMapPayload = {
  items: Array<{
    id: string;
    childrenPreview?: Array<{
      id: string;
      topSignal?: {
        title: string;
        targetMarketId?: string | null;
        targetMarketTitle?: string | null;
        targetEventId?: string | null;
      } | null;
    }>;
  }>;
};

type SeedEventInput = {
  eventId: string;
  venue: MarketMapVenue;
  title: string;
  volume24h: number;
  liquidity: number;
  openInterest: number;
  score: number;
};

function makeToken(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}

function buildEvent(input: SeedEventInput): MarketMapEventSummary {
  return {
    eventId: input.eventId,
    title: input.title,
    venue: input.venue,
    startTime: null,
    endTime: null,
    closeTime: null,
    representativeMarketId: null,
    representativeMarketTitle: null,
    oddsSource: null,
    tokenYes: makeToken(`yes-${input.eventId}`),
    tokenNo: makeToken(`no-${input.eventId}`),
    yesBid: 0.49,
    yesAsk: 0.51,
    noBid: 0.49,
    noAsk: 0.51,
    marketBestBid: 0.49,
    marketBestAsk: 0.51,
    lastPrice: 0.5,
    change24h: 0,
    tradeType: "binary",
    marketAddress: null,
    marketStatus: "ACTIVE",
    acceptingOrders: true,
    resolvedOutcome: null,
    resolvedOutcomePct: null,
    image: null,
    icon: null,
    volume24h: input.volume24h,
    liquidity: input.liquidity,
    openInterest: input.openInterest,
    score: input.score,
    x: 0,
    y: 0,
  };
}

function buildNode(nodeId: string, events: MarketMapEventSummary[]): MarketMapNode {
  const venueBreakdown: Record<MarketMapVenue, MarketMapNodeVenueMetrics> = {};
  for (const event of events) {
    const metrics = venueBreakdown[event.venue] ?? {
      eventCount: 0,
      sumVolume24h: 0,
      sumLiquidity: 0,
      sumOpenInterest: 0,
    };
    metrics.eventCount += 1;
    metrics.sumVolume24h += event.volume24h;
    metrics.sumLiquidity += event.liquidity;
    metrics.sumOpenInterest += event.openInterest;
    venueBreakdown[event.venue] = metrics;
  }

  const eventCount = events.length;
  const sumVolume24h = events.reduce((sum, event) => sum + event.volume24h, 0);
  const sumLiquidity = events.reduce((sum, event) => sum + event.liquidity, 0);
  const sumOpenInterest = events.reduce(
    (sum, event) => sum + event.openInterest,
    0,
  );
  const dominantVenue =
    Object.entries(venueBreakdown).sort(
      (left, right) =>
        right[1].sumVolume24h - left[1].sumVolume24h ||
        right[1].eventCount - left[1].eventCount ||
        left[0].localeCompare(right[0]),
    )[0]?.[0] ?? "polymarket";

  return {
    id: nodeId,
    venue: dominantVenue,
    dominantVenue,
    venueCount: Object.keys(venueBreakdown).length,
    venueBreakdown,
    level: 3,
    parentId: null,
    childIds: [],
    label: "Test node",
    labelRepresentative: "Test node",
    labelAi: null,
    labelSource: "representative",
    x: 0,
    y: 0,
    eventCount,
    sumVolume24h,
    sumLiquidity,
    sumOpenInterest,
    score: events.reduce((sum, event) => sum + event.score, 0) / eventCount,
    sampleEventIds: events.map((event) => event.eventId).slice(0, 6),
    heroEventId: events[0]?.eventId ?? null,
    heroMarketId: events[0]?.representativeMarketId ?? null,
    heroImage: null,
    heroIcon: null,
    updatedAt: new Date().toISOString(),
  };
}

function ids(payload: NodeEventsPayload): string[] {
  return payload.items.map((item) => item.eventId);
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    search.set(key, String(value));
  }
  return search.toString();
}

async function requestNodeEvents(args: {
  app: Awaited<ReturnType<typeof buildApp>>;
  nodeId: string;
  query: Record<string, string | number | undefined>;
}): Promise<NodeEventsPayload> {
  const { app, nodeId, query } = args;
  const response = await app.inject({
    method: "GET",
    url: `/market-map/node/${encodeURIComponent(nodeId)}/events?${buildQuery(query)}`,
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<NodeEventsPayload>();
}

async function requestMarketMap(args: {
  app: Awaited<ReturnType<typeof buildApp>>;
  query: Record<string, string | number | boolean | undefined>;
}): Promise<MarketMapPayload> {
  const { app, query } = args;
  const normalized = Object.fromEntries(
    Object.entries(query).map(([key, value]) => [
      key,
      typeof value === "boolean" ? String(value) : value,
    ]),
  ) as Record<string, string | number | undefined>;
  const response = await app.inject({
    method: "GET",
    url: `/market-map?${buildQuery(normalized)}`,
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<MarketMapPayload>();
}

async function insertUnifiedMarketForSignal(params: {
  marketId: string;
  venue: MarketMapVenue;
  venueMarketId: string;
  eventId: string;
  title: string;
}): Promise<void> {
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
        token_yes,
        token_no,
        slug,
        created_at,
        updated_at
      )
      values (
        $1, $2, $3, $4, $5, null, null, 'ACTIVE', 'binary',
        now() - interval '1 hour', now() + interval '1 day', now() + interval '1 day',
        0.45, 0.55, 0.5, 100, 10, 100, 50,
        '["Yes","No"]', $6, $7, $8, now(), now()
      )
    `,
    [
      params.marketId,
      params.venue,
      params.venueMarketId,
      params.eventId,
      params.title,
      makeToken(`yes-${params.marketId}`),
      makeToken(`no-${params.marketId}`),
      makeToken(`slug-${params.marketId}`),
    ],
  );
}

async function insertUnifiedEventForSignal(params: {
  eventId: string;
  venue: MarketMapVenue;
  venueEventId: string;
  title: string;
}): Promise<void> {
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
        created_at,
        updated_at
      )
      values (
        $1, $2, $3, $4, null, null, 'ACTIVE',
        now() - interval '1 hour', now() + interval '1 day', 100, 10, 100, $5, now(), now()
      )
    `,
    [
      params.eventId,
      params.venue,
      params.venueEventId,
      params.title,
      makeToken(`slug-${params.eventId}`),
    ],
  );
}

async function insertEventSignalNote(params: {
  noteId: string;
  noteKey: string;
  nodeId: string;
  runId: string;
  title: string;
  description: string;
  eventId: string;
  eventTitle: string;
  marketId: string;
  marketTitle: string;
  venue: MarketMapVenue;
}): Promise<void> {
  await pool.query(
    `
      insert into ai_notes (
        id,
        note_key,
        note_type,
        status,
        title,
        description,
        rationale,
        source_kind,
        source_id,
        producer_type,
        producer_run_id,
        lineage,
        signal_type,
        direction,
        confidence,
        reason_codes,
        metrics,
        model_meta
      ) values (
        $1, $2, 'signal', 'active', $3, $4, null, 'node', $5, 'map_signals', $6,
        $7::jsonb, 'update', 'up', 0.8, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb
      )
    `,
    [
      params.noteId,
      params.noteKey,
      params.title,
      params.description,
      params.nodeId,
      `runner-${params.runId}`,
      JSON.stringify({ map_run_id: params.runId }),
    ],
  );

  await pool.query(
    `
      insert into ai_note_targets (
        note_id,
        target_kind,
        target_id,
        is_primary,
        target_rank,
        affinity_score,
        target_meta
      ) values
        ($1, 'market', $2, true, 0, 0.72, $3::jsonb),
        ($1, 'event', $4, false, 5, null, $5::jsonb)
    `,
    [
      params.noteId,
      params.marketId,
      JSON.stringify({
        target_market_title: params.marketTitle,
        target_event_title: params.eventTitle,
        target_venue: params.venue,
      }),
      params.eventId,
      JSON.stringify({
        target_event_title: params.eventTitle,
        target_venue: params.venue,
      }),
    ],
  );
}

async function main() {
  if (!env.redisUrl) {
    console.log("[market-map-routes-tests] skipped (REDIS_URL missing)");
    return;
  }

  const app = await buildApp();
  const { redis, status } = await getRedisStatus({ force: true });
  assert.equal(status, "ready");
  assert.ok(redis, "expected redis client");

  const suiteId = crypto.randomUUID().slice(0, 8);
  const runId = `test-market-map-run-${suiteId}`;
  const nodeId = `test-market-map-node-${suiteId}`;
  const signalMarketId = `market-signal-${suiteId}`;
  const signalNoteId = crypto.randomUUID();
  const signalNoteKey = `note-signal-${suiteId}`;
  const previousActiveRunId = await redis.get(marketMapActiveKey());
  const policy = await insertRuntimePolicy(pool, {
    policyKey: "market_map",
    effectiveAt: new Date(),
    createdBy: null,
    payload: {
      enabled: true,
      venuesEnabled: ["polymarket", "kalshi", "limitless"],
    },
  });

  const events = [
    buildEvent({
      eventId: `event-a-${suiteId}`,
      venue: "polymarket",
      title: "Alpha event",
      volume24h: 30,
      liquidity: 200,
      openInterest: 0,
      score: 0.7,
    }),
    buildEvent({
      eventId: `event-b-${suiteId}`,
      venue: "kalshi",
      title: "Beta event",
      volume24h: 30,
      liquidity: 50,
      openInterest: 80,
      score: 0.9,
    }),
    buildEvent({
      eventId: `event-c-${suiteId}`,
      venue: "polymarket",
      title: "Gamma event",
      volume24h: 30,
      liquidity: 50,
      openInterest: 80,
      score: 0.9,
    }),
    buildEvent({
      eventId: `event-d-${suiteId}`,
      venue: "limitless",
      title: "Delta event",
      volume24h: 5,
      liquidity: 400,
      openInterest: 0,
      score: 0.3,
    }),
    buildEvent({
      eventId: `event-e-${suiteId}`,
      venue: "polymarket",
      title: "Epsilon event",
      volume24h: 20,
      liquidity: 150,
      openInterest: 120,
      score: 0.4,
    }),
    buildEvent({
      eventId: `event-f-${suiteId}`,
      venue: "kalshi",
      title: "Zeta event",
      volume24h: 40,
      liquidity: 20,
      openInterest: 10,
      score: 0.2,
    }),
  ];

  const node = buildNode(nodeId, events);
  const rootNodeId = `test-market-map-root-${suiteId}`;
  const rootNode: MarketMapNode = {
    ...node,
    id: rootNodeId,
    level: 1,
    parentId: null,
    childIds: [nodeId],
    label: "Root node",
    labelRepresentative: "Root node",
    heroEventId: null,
    heroMarketId: null,
  };
  const previewChildNode: MarketMapNode = {
    ...node,
    id: nodeId,
    level: 2,
    parentId: rootNodeId,
    childIds: [],
    label: "Child node",
    labelRepresentative: "Child node",
  };
  const nodeKey = marketMapRunNodeKey(runId, nodeId);
  const nodeEventsKey = marketMapRunNodeEventsKey(runId, nodeId);
  const nodesGlobalKey = marketMapRunNodesGlobalKey(runId);

  try {
    await redis.set(marketMapActiveKey(), runId);
    await redis.set(nodeKey, JSON.stringify(node));
    await redis.set(nodeEventsKey, JSON.stringify(events));
    await redis.set(nodesGlobalKey, JSON.stringify([rootNode, previewChildNode]));
    await insertUnifiedEventForSignal({
      eventId: `event-a-${suiteId}`,
      venue: "polymarket",
      venueEventId: `venue-event-a-${suiteId}`,
      title: "Alpha event",
    });
    await insertUnifiedMarketForSignal({
      marketId: signalMarketId,
      venue: "polymarket",
      venueMarketId: `venue-market-signal-${suiteId}`,
      eventId: `event-a-${suiteId}`,
      title: "Alpha alternate line",
    });
    await insertEventSignalNote({
      noteId: signalNoteId,
      noteKey: signalNoteKey,
      nodeId,
      runId,
      title: "Alpha signal",
      description: "Signal summary tied to a non-representative market.",
      eventId: `event-a-${suiteId}`,
      eventTitle: "Alpha event",
      marketId: signalMarketId,
      marketTitle: "Alpha alternate line",
      venue: "polymarket",
    });

    const volumeDesc = await requestNodeEvents({
      app,
      nodeId,
      query: { sort_by: "volume24h", sort_dir: "desc" },
    });
    assert.equal(volumeDesc.total, events.length);
    assert.deepEqual(ids(volumeDesc), [
      `event-f-${suiteId}`,
      `event-b-${suiteId}`,
      `event-c-${suiteId}`,
      `event-a-${suiteId}`,
      `event-e-${suiteId}`,
      `event-d-${suiteId}`,
    ]);

    const volumeAsc = await requestNodeEvents({
      app,
      nodeId,
      query: { sort_by: "volume24h", sort_dir: "asc" },
    });
    assert.deepEqual(ids(volumeAsc), [
      `event-d-${suiteId}`,
      `event-e-${suiteId}`,
      `event-b-${suiteId}`,
      `event-c-${suiteId}`,
      `event-a-${suiteId}`,
      `event-f-${suiteId}`,
    ]);

    const liquidityDesc = await requestNodeEvents({
      app,
      nodeId,
      query: { sort_by: "liquidity", sort_dir: "desc" },
    });
    assert.deepEqual(ids(liquidityDesc), [
      `event-d-${suiteId}`,
      `event-a-${suiteId}`,
      `event-e-${suiteId}`,
      `event-b-${suiteId}`,
      `event-c-${suiteId}`,
      `event-f-${suiteId}`,
    ]);

    const liquidityAsc = await requestNodeEvents({
      app,
      nodeId,
      query: { sort_by: "liquidity", sort_dir: "asc" },
    });
    assert.deepEqual(ids(liquidityAsc), [
      `event-f-${suiteId}`,
      `event-b-${suiteId}`,
      `event-c-${suiteId}`,
      `event-e-${suiteId}`,
      `event-a-${suiteId}`,
      `event-d-${suiteId}`,
    ]);

    const interestDesc = await requestNodeEvents({
      app,
      nodeId,
      query: { sort_by: "openInterest", sort_dir: "desc" },
    });
    assert.deepEqual(ids(interestDesc), [
      `event-d-${suiteId}`,
      `event-a-${suiteId}`,
      `event-e-${suiteId}`,
      `event-b-${suiteId}`,
      `event-c-${suiteId}`,
      `event-f-${suiteId}`,
    ]);

    const interestAsc = await requestNodeEvents({
      app,
      nodeId,
      query: { sort_by: "openInterest", sort_dir: "asc" },
    });
    assert.deepEqual(ids(interestAsc), [
      `event-f-${suiteId}`,
      `event-b-${suiteId}`,
      `event-c-${suiteId}`,
      `event-e-${suiteId}`,
      `event-a-${suiteId}`,
      `event-d-${suiteId}`,
    ]);

    const repeatedInterestAsc = await requestNodeEvents({
      app,
      nodeId,
      query: { sort_by: "openInterest", sort_dir: "asc" },
    });
    assert.deepEqual(ids(repeatedInterestAsc), ids(interestAsc));

    const firstPage = await requestNodeEvents({
      app,
      nodeId,
      query: { sort_by: "volume24h", sort_dir: "desc", limit: 2, offset: 0 },
    });
    const secondPage = await requestNodeEvents({
      app,
      nodeId,
      query: { sort_by: "volume24h", sort_dir: "desc", limit: 2, offset: 2 },
    });
    assert.deepEqual(ids(firstPage), [
      `event-f-${suiteId}`,
      `event-b-${suiteId}`,
    ]);
    assert.deepEqual(ids(secondPage), [
      `event-c-${suiteId}`,
      `event-a-${suiteId}`,
    ]);

    const venueFiltered = await requestNodeEvents({
      app,
      nodeId,
      query: {
        venues: "polymarket",
        sort_by: "liquidity",
        sort_dir: "desc",
      },
    });
    assert.equal(venueFiltered.total, 3);
    assert.deepEqual(ids(venueFiltered), [
      `event-a-${suiteId}`,
      `event-e-${suiteId}`,
      `event-c-${suiteId}`,
    ]);

    const withSignals = await requestNodeEvents({
      app,
      nodeId,
      query: { sort_by: "volume24h", sort_dir: "desc" },
    });
    const signaledEvent = withSignals.items.find(
      item => item.eventId === `event-a-${suiteId}`,
    );
    assert.ok(signaledEvent?.topSignal, "expected topSignal on event-a");
    assert.equal(signaledEvent?.topSignal?.title, "Alpha signal");
    assert.equal(signaledEvent?.topSignal?.targetMarketId, signalMarketId);
    assert.equal(
      signaledEvent?.topSignal?.targetMarketTitle,
      "Alpha alternate line",
    );
    assert.equal(
      signaledEvent?.topSignal?.targetEventId,
      `event-a-${suiteId}`,
    );

    const marketMap = await requestMarketMap({
      app,
      query: {
        level: 1,
        includeChildrenPreview: true,
        childrenPreviewLimit: 8,
      },
    });
    const previewSignal = marketMap.items
      .find((item) => item.id === rootNodeId)
      ?.childrenPreview?.find((item) => item.id === nodeId)?.topSignal;
    assert.ok(previewSignal, "expected topSignal on child preview");
    assert.equal(previewSignal?.title, "Alpha signal");
    assert.equal(previewSignal?.targetMarketId, signalMarketId);
    assert.equal(previewSignal?.targetMarketTitle, "Alpha alternate line");
    assert.equal(previewSignal?.targetEventId, `event-a-${suiteId}`);

    console.log("[market-map-routes-tests] ok node event sorting");
  } finally {
    await pool.query("delete from ai_note_targets where note_id = $1", [
      signalNoteId,
    ]);
    await pool.query("delete from ai_notes where id = $1", [signalNoteId]);
    await pool.query("delete from unified_markets where id = $1", [signalMarketId]);
    await pool.query("delete from unified_events where id = $1", [
      `event-a-${suiteId}`,
    ]);
    await pool.query("delete from runtime_policies where id = $1", [policy.id]);
    if (previousActiveRunId) {
      await redis.set(marketMapActiveKey(), previousActiveRunId);
    } else {
      await redis.del(marketMapActiveKey());
    }
    await redis.del([nodeKey, nodeEventsKey, nodesGlobalKey]);
    await app.close();
  }
}

await main();
