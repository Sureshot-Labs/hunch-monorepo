import assert from "node:assert/strict";
import {
  DiscoveryBuilder,
  type DiscoveryBuildProgress,
  type DiscoveryQuoteDemand,
} from "./services/discovery-builder.js";
import { DiscoveryService } from "./services/discovery-service.js";
import { discoveryQuerySchema } from "./schemas/discovery.js";
import {
  discoveryTestComponents,
  discoveryTestItem,
  discoveryTestRow,
  discoveryTestNow as now,
  discoveryTestScope as scope,
  discoveryTestSnapshot,
} from "./discovery-test-fixtures.js";

async function test(name: string, run: () => Promise<void>) {
  await run();
  console.log(`[discovery-quote-refresh-tests] ok ${name}`);
}
function progress(): DiscoveryBuildProgress {
  return {
    version: 1,
    section: "quick-wins",
    startedAt: new Date(now).toISOString(),
    lifecycleRevision: scope.revision,
    phase: "quotes",
    after: null,
    afterId: null,
    position: 0,
    pool: [
      { marketId: "limitless:1", volumeUsd: "2000", liquidityUsd: "10000" },
    ],
    eligibleIds: [],
    research: [],
    wallets: [],
    positions: [],
    changes: [],
    smart: [],
    items: [],
    projectionRefreshedAt: new Date(now).toISOString(),
  };
}
await test("Background requests missing/stale canonical sides, not fresh, closed or disabled-venue rows", async () => {
  const c = discoveryTestComponents([]);
  const calls: Parameters<DiscoveryQuoteDemand>[] = [];
  const builder = new DiscoveryBuilder(
    c.repo,
    "0xctf",
    () => now,
    (...args) => {
      calls.push(args);
    },
  );
  const stale = discoveryTestRow("limitless:1", {
    side: "NO",
    token_id: "canonical-no",
    quote_at: new Date(now - 300001).toISOString(),
  });
  c.repo.marketCards = async () => [
    stale,
    stale,
    discoveryTestRow("limitless:1", {
      token_id: "canonical-yes",
      best_ask: null,
    }),
    discoveryTestRow("limitless:2", { token_id: "already-fresh" }),
    discoveryTestRow("limitless:3", { token_id: "closed", status: "CLOSED" }),
    discoveryTestRow("limitless:4", { token_id: null }),
    discoveryTestRow("polymarket:1", {
      venue: "polymarket",
      token_id: "excluded-venue",
      best_ask: null,
    }),
  ];
  await builder.marketCards(
    ["limitless:1"],
    { ...scope, venues: ["limitless"] },
    true,
  );
  assert.deepEqual(calls, [
    [
      [
        { tokenId: "canonical-no", venue: "limitless" },
        { tokenId: "canonical-yes", venue: "limitless" },
      ],
      "background",
    ],
  ]);
});
await test("A stale candidate outside the snapshot requests refresh and recovers on the next build, never by weakening freshness", async () => {
  const c = discoveryTestComponents([discoveryTestItem("limitless:1")]);
  const calls: Parameters<DiscoveryQuoteDemand>[] = [];
  const builder = new DiscoveryBuilder(
    c.repo,
    "0xctf",
    () => now,
    (...args) => {
      calls.push(args);
    },
  );
  c.repo.rows.set(
    "limitless:1",
    discoveryTestRow("limitless:1", {
      quote_at: new Date(now - 300001).toISOString(),
    }),
  );
  const stale = await builder.step(progress(), scope);
  assert.equal(stale.progress.eligibleIds.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "background");
  const empty = await builder.step(stale.progress, scope);
  assert.equal(empty.snapshot?.items.length, 0);
  // Only the indexer's later fresh observation makes the candidate eligible.
  c.repo.rows.set(
    "limitless:1",
    discoveryTestRow("limitless:1", { best_bid: "0.87", best_ask: "0.89" }),
  );
  const fresh = await builder.step(progress(), scope);
  const complete = await builder.step(fresh.progress, scope);
  assert.equal(complete.snapshot?.items.length, 1);
  assert.equal(complete.snapshot?.items[0].quote.ask, "0.89");
  assert.equal(calls.length, 1);
});
await test("Live hydration warms both sides before filtering stale cards; a pending enqueue cannot hold the response", async () => {
  const c = discoveryTestComponents([discoveryTestItem("limitless:1")]);
  const calls: Parameters<DiscoveryQuoteDemand>[] = [];
  const builder = new DiscoveryBuilder(
    c.repo,
    "0xctf",
    () => now,
    (...args) => {
      calls.push(args);
      return new Promise<void>(() => {});
    },
  );
  c.repo.marketCards = async () => [
    discoveryTestRow("limitless:1", {
      token_id: "current-yes",
      quote_at: new Date(now - 300001).toISOString(),
    }),
    discoveryTestRow("limitless:1", { side: "NO", token_id: "current-no" }),
  ];
  await c.store.acquire("quick-wins", "test");
  await c.store.publish(
    "quick-wins",
    "test",
    discoveryTestSnapshot([discoveryTestItem("limitless:1")]),
  );
  await c.store.release("quick-wins", "test");
  const service = new DiscoveryService(
    builder,
    async () => c.store,
    async () => scope,
    () => now,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      service.read("quick-wins", discoveryQuerySchema.parse({})),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Error("enqueue blocked HTTP")), 1000);
      }),
    ]);
    assert.equal(result.items.length, 0);
    assert.deepEqual(calls, [
      [
        [
          { tokenId: "current-yes", venue: "limitless" },
          { tokenId: "current-no", venue: "limitless" },
        ],
        "read",
      ],
    ]);
  } finally {
    clearTimeout(timer);
    await service.stop();
  }
});
await test("Refresh demand is bounded and sync/async queue errors do not fail DB reads", async () => {
  const c = discoveryTestComponents([]);
  c.repo.marketCards = async () =>
    Array.from({ length: 250 }, (_, i) => discoveryTestRow(`limitless:${i}`));
  let size = 0;
  const builder = new DiscoveryBuilder(
    c.repo,
    "0xctf",
    () => now,
    (tokens) => {
      size = tokens.length;
    },
  );
  await builder.marketCards([], scope, false, "read");
  assert.equal(size, 200);
  for (const failure of [
    () => {
      throw Error("queue offline");
    },
    async () => {
      throw Error("queue offline");
    },
  ]) {
    const failing = new DiscoveryBuilder(c.repo, "0xctf", () => now, failure);
    assert.equal(
      (await failing.marketCards([], scope, false, "read")).length,
      250,
    );
  }
});
