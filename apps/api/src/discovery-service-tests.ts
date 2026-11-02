import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
} from "fastify-type-provider-zod";
import { createDiscoveryRoutes } from "./routes/discovery.js";
import { DiscoveryService } from "./services/discovery-service.js";
import { DiscoveryError } from "./services/discovery-domain.js";
import {
  discoveryQuerySchema,
  discoverySmartQuerySchema,
  discoveryResponseSchema,
  type DiscoveryItem,
} from "./schemas/discovery.js";
import {
  discoveryTestComponents,
  discoveryTestItem,
  discoveryTestNow,
  discoveryTestRow,
  discoveryTestScope,
  discoveryTestSnapshot,
} from "./discovery-test-fixtures.js";

async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  console.log(`[discovery-service-tests] ok ${name}`);
}
async function setupSmart(
  asks: string[],
  eventIds?: string[],
  side: "YES" | "NO" = "YES",
) {
  const items: DiscoveryItem[] = asks.map((ask, i) => {
    const item = discoveryTestItem(`limitless:${i}`, {
      best_ask: ask,
      best_bid: "0.1",
      side,
      ...(eventIds ? { event_id: eventIds[i] } : {}),
    });
    return {
      ...item,
      id: `smart-money:${i}:${side}`,
      reason: {
        kind: "smart-money",
        evidenceBasis: "observed_snapshot_increase",
        ownerGroups: 12 - Math.min(i, 10),
        oppositeOwnerGroups: 1,
        observedIncreaseValueUsd: "1000",
        observedAt: new Date(discoveryTestNow).toISOString(),
        windowHours: 24,
        traders: [],
        opposingViews: true,
      },
    };
  });
  const parts = discoveryTestComponents(items),
    snapshot = {
      ...discoveryTestSnapshot(items),
      section: "smart-money" as const,
    };
  await parts.store.acquire("smart-money", "smart");
  await parts.store.publish("smart-money", "smart", snapshot);
  await parts.store.release("smart-money", "smart");
  // Quote rows are intentionally separate from the prepared snapshot.
  asks.forEach((ask, i) =>
    parts.repo.rows.set(
      `limitless:${i}`,
      discoveryTestRow(`limitless:${i}`, {
        best_ask: ask,
        best_bid: "0.1",
        side,
        ...(eventIds ? { event_id: eventIds[i] } : {}),
      }),
    ),
  );
  const service = new DiscoveryService(
    parts.builder,
    async () => parts.store,
    async () => discoveryTestScope,
    () => discoveryTestNow,
  );
  return { ...parts, snapshot, service };
}
await test("Smart Money caps live ask before event representatives and binds normalized price filters to cursors", async () => {
  const c = await setupSmart(
    ["0.999", "0.94", "0.95", "0.96", "0.4"],
    ["one", "one", "two", "three", "four"],
  );
  const page = await c.service.read(
    "smart-money",
    discoverySmartQuerySchema.parse({ limit: 1 }),
  );
  assert.equal(page.items[0].market.marketId, "limitless:1");
  assert.ok(page.nextCursor);
  const next = await c.service.read(
    "smart-money",
    discoverySmartQuerySchema.parse({
      cursor: page.nextCursor,
      maxAsk: "0.9500",
      limit: 50,
    }),
  );
  assert.deepEqual(
    next.items.map((i) => i.market.marketId),
    ["limitless:2", "limitless:4"],
  );
  assert.equal(next.nextCursor, null);
  await assert.rejects(
    () =>
      c.service.read(
        "smart-money",
        discoverySmartQuerySchema.parse({
          cursor: page.nextCursor,
          maxAsk: "1",
        }),
      ),
    (e: unknown) =>
      e instanceof DiscoveryError && e.code === "discovery_invalid_cursor",
  );
  const all = await c.service.read(
    "smart-money",
    discoverySmartQuerySchema.parse({ maxAsk: "1" }),
  );
  assert.deepEqual(
    all.items.map((i) => i.market.marketId),
    ["limitless:0", "limitless:2", "limitless:3", "limitless:4"],
  );
  // Crossing either direction uses the current price, never the cached ask.
  c.repo.rows.set(
    "limitless:0",
    discoveryTestRow("limitless:0", {
      best_ask: "0.9",
      best_bid: "0.89",
      event_id: "one",
    }),
  );
  c.repo.rows.set(
    "limitless:2",
    discoveryTestRow("limitless:2", { best_ask: "0.951", event_id: "two" }),
  );
  const changed = await c.service.read(
    "smart-money",
    discoverySmartQuerySchema.parse({}),
  );
  assert.deepEqual(
    changed.items.map((i) => i.market.marketId),
    ["limitless:0", "limitless:4"],
  );
  assert.equal(c.snapshot.items.length, 5, "the full pool is retained");
  assert.ok(
    (
      await c.service.read(
        "smart-money",
        discoverySmartQuerySchema.parse({ q: "absent" }),
      )
    ).items.length === 0,
  );
  await c.service.stop();
});
await test("Smart Money filtered work budget keeps a continuation inside a large event", async () => {
  const c = await setupSmart(
    [...Array<string>(205).fill("0.999"), "0.9"],
    Array<string>(206).fill("same-event"),
  );
  const page = await c.service.read(
    "smart-money",
    discoverySmartQuerySchema.parse({}),
  );
  assert.deepEqual(page.items, []);
  assert.equal(page.page.scannedCandidates, 200);
  assert.equal(page.page.scanBudgetReached, true);
  assert.ok(page.nextCursor);
  const next = await c.service.read(
    "smart-money",
    discoverySmartQuerySchema.parse({ cursor: page.nextCursor }),
  );
  assert.deepEqual(
    next.items.map((i) => i.market.marketId),
    ["limitless:205"],
  );
  assert.equal(next.nextCursor, null);
  await c.service.stop();
});
await test("Smart Money NO cap uses exact decimals; show-all cannot bypass live trading safeguards", async () => {
  const c = await setupSmart(
    ["0.950000000000000001", "0.95", "0.999", "0.5"],
    undefined,
    "NO",
  );
  const normal = await c.service.read(
    "smart-money",
    discoverySmartQuerySchema.parse({}),
  );
  assert.deepEqual(
    normal.items.map((i) => i.market.marketId),
    ["limitless:1", "limitless:3"],
  );
  assert.ok(normal.items.every((i) => i.selection.side === "NO"));
  const exact = await c.service.read(
    "smart-money",
    discoverySmartQuerySchema.parse({ maxAsk: "0.950000000000000001" }),
  );
  assert.deepEqual(
    exact.items.map((i) => i.market.marketId),
    ["limitless:0", "limitless:1", "limitless:3"],
  );
  const all = await c.service.read(
    "smart-money",
    discoverySmartQuerySchema.parse({ maxAsk: "1" }),
  );
  assert.equal(all.items.length, 4);
  for (const [i, changes] of [
    [0, { quote_at: new Date(discoveryTestNow - 300001).toISOString() }],
    [1, { status: "CLOSED" }],
    [2, { token_id: "new-generation" }],
    [3, { best_ask: null, best_bid: null }],
  ] as const)
    c.repo.rows.set(
      `limitless:${i}`,
      discoveryTestRow(`limitless:${i}`, {
        side: "NO",
        best_bid: "0.1",
        best_ask: "0.9",
        ...changes,
      }),
    );
  const unavailable = await c.service.read(
    "smart-money",
    discoverySmartQuerySchema.parse({ maxAsk: "1" }),
  );
  assert.deepEqual(unavailable.items, []);
  assert.equal(unavailable.nextCursor, null);
  await c.service.stop();
});

async function setup(count = 60) {
  let now = discoveryTestNow;
  const items = Array.from({ length: count }, (_, i) =>
    discoveryTestItem(`limitless:${i}`),
  );
  const parts = discoveryTestComponents(items, () => now),
    snapshot = discoveryTestSnapshot(items);
  const owner = "test-owner";
  await parts.store.acquire("quick-wins", owner);
  await parts.store.publish("quick-wins", owner, snapshot);
  await parts.store.release("quick-wins", owner);
  const service = new DiscoveryService(
    parts.builder,
    async () => parts.store,
    async () => discoveryTestScope,
    () => now,
  );
  return {
    ...parts,
    items,
    snapshot,
    service,
    setNow: (value: number) => {
      now = value;
    },
  };
}
await test("Pages hydrate in bounded batches, bind stable versions and return empty filtered results", async () => {
  const c = await setup();
  const first = await c.service.read(
    "quick-wins",
    discoveryQuerySchema.parse({}),
  );
  assert.equal(first.items.length, 20);
  assert.equal(first.page.scannedCandidates, 40);
  assert.ok(first.nextCursor);
  assert.ok(discoveryResponseSchema.safeParse(first).success);
  const second = await c.service.read(
    "quick-wins",
    discoveryQuerySchema.parse({ cursor: first.nextCursor }),
  );
  assert.equal(second.items.length, 20);
  assert.equal(second.items[0].market.marketId, "limitless:20");
  assert.equal(second.snapshotId, first.snapshotId);
  const empty = await c.service.read(
    "quick-wins",
    discoveryQuerySchema.parse({ categories: "crypto" }),
  );
  assert.deepEqual(empty.items, []);
  assert.equal(empty.nextCursor, null);
  assert.ok(c.repo.batches.every((b) => b.length <= 100));
});
await test("200-candidate work budget returns continuation, not a false empty end", async () => {
  const c = await setup(250);
  for (let i = 0; i < 220; i++) c.repo.rows.delete(`limitless:${i}`);
  const page = await c.service.read(
    "quick-wins",
    discoveryQuerySchema.parse({}),
  );
  assert.equal(page.items.length, 0);
  assert.equal(page.page.scannedCandidates, 200);
  assert.equal(page.page.scanBudgetReached, true);
  assert.ok(page.nextCursor);
  const next = await c.service.read(
    "quick-wins",
    discoveryQuerySchema.parse({ cursor: page.nextCursor }),
  );
  assert.equal(next.items.length, 20);
  assert.equal(next.items[0].market.marketId, "limitless:220");
});
await test("Event grouping happens after filters and falls back to a live representative", async () => {
  const c = await setup(3);
  for (const item of c.snapshot.items) item.market.eventId = "same-event";
  await c.store.acquire("quick-wins", "edit");
  await c.store.publish("quick-wins", "edit", c.snapshot);
  await c.store.release("quick-wins", "edit");
  c.repo.rows.delete("limitless:0");
  const page = await c.service.read(
    "quick-wins",
    discoveryQuerySchema.parse({}),
  );
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].market.marketId, "limitless:1");
  assert.equal(page.nextCursor, null);
});
await test("Live token changes and stale quotes cannot be offered as executable Quick Wins", async () => {
  const c = await setup(3);
  c.repo.rows.set(
    "limitless:0",
    discoveryTestRow("limitless:0", { token_id: "replacement" }),
  );
  c.repo.rows.set(
    "limitless:1",
    discoveryTestRow("limitless:1", {
      quote_at: new Date(discoveryTestNow - 300001).toISOString(),
    }),
  );
  const page = await c.service.read(
    "quick-wins",
    discoveryQuerySchema.parse({}),
  );
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].market.marketId, "limitless:2");
});
await test("Expired cursor is explicit; cold cache and Redis failures return 503", async () => {
  const c = await setup();
  const first = await c.service.read(
    "quick-wins",
    discoveryQuerySchema.parse({}),
  );
  await c.service.stop();
  c.setNow(discoveryTestNow + 901000);
  await assert.rejects(
    () =>
      c.service.read(
        "quick-wins",
        discoveryQuerySchema.parse({ cursor: first.nextCursor }),
      ),
    (e: unknown) => e instanceof DiscoveryError && e.statusCode === 409,
  );
  const missing = new DiscoveryService(
    c.builder,
    async () => {
      throw Error("Redis offline");
    },
    async () => discoveryTestScope,
  );
  await assert.rejects(
    () => missing.read("quick-wins", discoveryQuerySchema.parse({})),
    (e: unknown) => e instanceof DiscoveryError && e.statusCode === 503,
  );
  await missing.stop();
});
await test("Ownership-fenced publication retains old complete snapshot when lease is lost", async () => {
  const c = await setup();
  await c.store.acquire("quick-wins", "first");
  assert.equal(await c.store.acquire("quick-wins", "second"), false);
  c.setNow(discoveryTestNow + 60001);
  assert.equal(await c.store.acquire("quick-wins", "second"), true);
  const replacement = { ...c.snapshot, id: randomUUID() };
  await assert.rejects(
    () => c.store.publish("quick-wins", "first", replacement),
    /lease_lost/,
  );
  await c.store.release("quick-wins", "first");
  assert.equal(await c.store.renew("quick-wins", "second"), true);
  assert.equal((await c.store.current("quick-wins"))?.id, c.snapshot.id);
  await c.store.publish("quick-wins", "second", replacement);
  assert.equal((await c.store.snapshot(c.snapshot.id))?.id, c.snapshot.id);
});
await test("Old versions remain traversable for 15 minutes while refreshed source state is healthy", async () => {
  const c = await setup();
  const first = await c.service.read(
    "quick-wins",
    discoveryQuerySchema.parse({}),
  );
  c.setNow(discoveryTestNow + 360000);
  for (const [id, row] of c.repo.rows)
    c.repo.rows.set(id, {
      ...row,
      quote_at: new Date(discoveryTestNow + 360000).toISOString(),
    });
  const current = {
    ...c.snapshot,
    id: randomUUID(),
    generatedAt: new Date(discoveryTestNow + 360000).toISOString(),
    sourceAsOf: new Date(discoveryTestNow + 360000).toISOString(),
  };
  await c.store.acquire("quick-wins", "new");
  await c.store.publish("quick-wins", "new", current);
  await c.store.release("quick-wins", "new");
  const next = await c.service.read(
    "quick-wins",
    discoveryQuerySchema.parse({ cursor: first.nextCursor }),
  );
  assert.equal(next.snapshotId, first.snapshotId);
  assert.equal(next.items[0].market.marketId, "limitless:20");
  assert.equal(next.freshness.status, "stale");
  await c.service.stop();
});
await test("Live venue removal does not move frozen cursor indices", async () => {
  const c = await setup(3);
  c.snapshot.items[0].market.venue = "polymarket";
  await c.store.acquire("quick-wins", "edit");
  await c.store.publish("quick-wins", "edit", c.snapshot);
  await c.store.release("quick-wins", "edit");
  let venues = ["polymarket", "limitless"];
  const service = new DiscoveryService(
    c.builder,
    async () => c.store,
    async () => ({ ...discoveryTestScope, venues }),
    () => discoveryTestNow,
  );
  const first = await service.read(
    "quick-wins",
    discoveryQuerySchema.parse({ limit: 1 }),
  );
  venues = ["limitless"];
  const next = await service.read(
    "quick-wins",
    discoveryQuerySchema.parse({ limit: 1, cursor: first.nextCursor }),
  );
  assert.equal(next.items[0].market.marketId, "limitless:1");
  await service.stop();
});
await test("Background singleflight, partial checkpoint and restart recovery do not rebuild in a read", async () => {
  const c = await setup(1);
  const progress = await c.builder.start(
    "hidden-gems",
    discoveryTestScope,
    null,
  );
  progress.phase = "cards";
  progress.eligibleIds = [];
  await c.store.acquire("hidden-gems", "previous");
  await c.store.checkpoint("hidden-gems", "previous", progress);
  await c.store.release("hidden-gems", "previous");
  await Promise.all([
    c.service.refresh("hidden-gems"),
    c.service.refresh("hidden-gems"),
  ]);
  const result = await c.store.current("hidden-gems");
  assert.ok(result);
  assert.equal(result.items.length, 0);
  assert.equal(await c.store.progress("hidden-gems"), null);
});
await test("Fastify routes validate filters, expose typed OpenAPI and error recovery semantics", async () => {
  const c = await setup(2),
    app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(swagger, {
    openapi: { info: { title: "Discovery", version: "1" } },
    transform: jsonSchemaTransform,
  });
  await app.register(createDiscoveryRoutes(c.service));
  await app.ready();
  try {
    const response = await app.inject("/discovery/quick-wins?limit=1");
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().items.length, 1);
    assert.equal(
      (await app.inject("/discovery/quick-wins?limit=100")).statusCode,
      400,
    );
    assert.equal(
      (await app.inject("/discovery/quick-wins?horizonHours=48")).statusCode,
      400,
    );
    assert.equal(
      (await app.inject("/discovery/quick-wins?cursor=bad")).statusCode,
      400,
    );
    const unavailable = await app.inject("/discovery/smart-money");
    assert.equal(unavailable.statusCode, 503);
    assert.equal(unavailable.headers["retry-after"], "15");
    for (const value of [
      "0",
      "0.0",
      "-0.1",
      "1.01",
      "NaN",
      "1e-2",
      "",
      "0.9500000000000000001",
    ])
      assert.equal(
        (await app.inject(`/discovery/smart-money?maxAsk=${value}`)).statusCode,
        400,
        value,
      );
    for (const section of ["quick-wins", "hidden-gems"])
      assert.equal(
        (await app.inject(`/discovery/${section}?maxAsk=1`)).statusCode,
        400,
      );
    const spec = app.swagger();
    for (const name of ["quick-wins", "smart-money", "hidden-gems"])
      assert.ok(spec.paths?.[`/discovery/${name}`]);
    assert.match(JSON.stringify(spec), /observed_snapshot_increase/);
    assert.match(JSON.stringify(spec), /grossReturnIfWin/);
  } finally {
    await c.service.stop();
    await app.close();
  }
});

await test("Hidden Gems keeps stale research readable, suppresses current price and rejects a superseded revision", async () => {
  const c = await setup(1),
    id = randomUUID(),
    item = c.items[0];
  c.repo.research = [
    {
      id,
      source_id: item.market.marketId,
      source_kind: "market",
      producer_type: "holder_research",
      note_type: "signal",
      status: "active",
      created_at: new Date(discoveryTestNow).toISOString(),
      title: "Public thesis",
      description: "Opinion",
      lineage: { side: "YES" },
      metrics: {
        publicationDecisionV1: {
          status: "PUBLISH",
          authority: "holder_research_quality_gate",
        },
        socialInstrumentV1: item.selection.instrument,
      },
      model_meta: {},
    },
  ];
  const research = {
    noteId: id,
    createdAt: new Date(discoveryTestNow).toISOString(),
    headline: "Public thesis",
    summary: "Opinion",
    side: "YES" as const,
    strength: "good" as const,
    researchedPrice: "0.90",
    researchedAt: new Date(discoveryTestNow).toISOString(),
    sources: [],
    caveats: [],
    instrument: item.selection.instrument,
  };
  const snapshot = {
    ...c.snapshot,
    section: "hidden-gems" as const,
    items: [
      {
        ...item,
        id: `hidden-gems:${item.market.marketId}:YES`,
        research,
        reason: {
          kind: "hidden-gems" as const,
          strength: "good" as const,
          basis: "public_approved_research_not_proven_mispricing" as const,
        },
      },
    ],
  };
  await c.store.acquire("hidden-gems", "fixture");
  await c.store.publish("hidden-gems", "fixture", snapshot);
  await c.store.release("hidden-gems", "fixture");
  c.repo.rows.set(
    item.market.marketId,
    discoveryTestRow(item.market.marketId, {
      quote_at: new Date(discoveryTestNow - 301000).toISOString(),
    }),
  );
  const result = await c.service.read(
    "hidden-gems",
    discoveryQuerySchema.parse({}),
  );
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].copyAvailable, false);
  assert.equal(result.items[0].quote.status, "stale");
  assert.equal(result.items[0].quote.ask, null);
  assert.equal(result.items[0].research?.noteId, id);
  c.repo.research[0].id = randomUUID();
  assert.equal(
    (await c.service.read("hidden-gems", discoveryQuerySchema.parse({}))).items
      .length,
    0,
  );
  await c.service.stop();
});

await test("Refresh failure preserves last complete data and recovers from checkpoint after backoff", async () => {
  const c = await setup(1);
  c.setNow(discoveryTestNow + 61000);
  const progress = await c.builder.start(
    "hidden-gems",
    discoveryTestScope,
    null,
  );
  progress.section = "quick-wins";
  progress.phase = "cards";
  progress.eligibleIds = [c.items[0].market.marketId];
  await c.store.acquire("quick-wins", "checkpoint");
  await c.store.checkpoint("quick-wins", "checkpoint", progress);
  await c.store.release("quick-wins", "checkpoint");
  const load = c.repo.marketCards.bind(c.repo);
  let attempts = 0;
  c.repo.marketCards = async () => {
    attempts++;
    throw Error("timeout");
  };
  await c.service.refresh("quick-wins");
  assert.equal((await c.store.current("quick-wins"))?.id, c.snapshot.id);
  await c.service.refresh("quick-wins");
  assert.equal(attempts, 1);
  c.repo.marketCards = load;
  c.setNow(discoveryTestNow + 77000);
  await c.service.refresh("quick-wins");
  assert.notEqual((await c.store.current("quick-wins"))?.id, c.snapshot.id);
  assert.equal(await c.store.progress("quick-wins"), null);
  await c.service.stop();
});
