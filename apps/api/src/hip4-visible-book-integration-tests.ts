// @requires-db
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DEFAULT_HIP4_READ_POLICY, hip4Identity } from "@hunch/shared";
import { createIntegrationTestPool } from "./test-database-target.js";
import { installHip4TestLifecycle } from "./hip4-test-lifecycle.js";
import { applyHip4Book, mapHip4Market } from "./services/hip4-mapping.js";
import {
  admitHip4Request,
  persistHip4Market,
  readHip4Policy,
  readHip4StoredMarket,
} from "./services/hip4-repository.js";
import {
  createHip4VisibleBookDependencies,
  readHip4HotMarkets,
  refreshHip4VisibleBooks,
} from "./services/hip4-visible-books.js";

const pool = await createIntegrationTestPool({
  max: 3,
  options: "-c statement_timeout=15000",
});
const lifecycle = await installHip4TestLifecycle(pool);
const policyId = randomUUID();
const outcomes = [810001, 810002, 810003];
const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/hip4/public-reads.json", import.meta.url),
    "utf8",
  ),
).observations[0];
try {
  assert.equal(
    Math.floor(
      Number(
        (await pool.query("show server_version_num")).rows[0]
          .server_version_num,
      ) / 10000,
    ),
    16,
  );
  await pool.query(
    "insert into runtime_policies(id,policy_key,effective_at,payload) values($1,'hip4_read',now(),$2)",
    [
      policyId,
      JSON.stringify({ ...DEFAULT_HIP4_READ_POLICY, maxLiveOutcomes: 3 }),
    ],
  );
  const { policy, revision } = await readHip4Policy(pool, "indexer");
  for (const outcome of outcomes) {
    const mapped = mapHip4Market({
      environment: "mainnet",
      outcome,
      fetchedAt: new Date().toISOString(),
      generation: randomUUID(),
      metadata: {
        ...fixture.metadata,
        questions: [],
        outcomes: [
          {
            ...fixture.metadata.outcomes[0],
            outcome,
            description:
              "participant:Visible books|resolutionDeadline:20990101-0000",
          },
        ],
      },
      spotMetadata: fixture.spotMetadata,
    });
    assert.equal(mapped.market.status, "observed");
    await persistHip4Market(pool, {
      ...mapped,
      trades: [],
      advanceCursor: false,
      policy,
    });
  }
  const tokens = outcomes.flatMap((outcome) =>
    hip4Identity("mainnet", outcome).sides.map((side) => side.tokenId),
  );
  const candidates = await readHip4HotMarkets(pool, policy, tokens);
  assert.deepEqual(
    candidates.map((entry) => entry.outcome),
    outcomes,
  );
  assert.deepEqual(await readHip4HotMarkets(pool, policy, []), []);
  await pool.query("delete from hip4_request_budget where scope='public-info'");
  assert.equal(
    await admitHip4Request(
      pool,
      policy.environment,
      policy.requestWeightPerMinute,
      policy.requestWeightPerMinute,
    ),
    true,
  );
  let http = 0;
  let racePublished = false;
  const fetcher: typeof fetch = async (_url, init) => {
    http++;
    const request = JSON.parse(String(init?.body));
    assert.equal(request.type, "l2Book");
    if (!racePublished) {
      racePublished = true;
      const stored = await readHip4StoredMarket(
        pool,
        policy.environment,
        outcomes[0],
      );
      assert.ok(stored);
      let market = stored.market;
      const at = Date.now();
      for (const side of market.sides)
        market = applyHip4Book(
          market,
          side.sideIndex,
          {
            coin: side.coin,
            time: at,
            levels: [
              [{ px: "0.8", sz: "1", n: 1 }],
              [{ px: "0.9", sz: "1", n: 1 }],
            ],
          },
          at,
          policy.bookMaxAgeMs,
        );
      await persistHip4Market(pool, {
        market,
        raw: stored.raw,
        trades: [],
        advanceCursor: false,
        policy,
      });
    }
    return Response.json({
      coin: request.coin,
      time: Date.now() - 1000,
      levels: [[{ px: "0.4", sz: "1", n: 1 }], [{ px: "0.5", sz: "1", n: 1 }]],
    });
  };
  const attempted = new Map<number, number>();
  const published: string[] = [];
  const denied = await refreshHip4VisibleBooks(
    policy,
    revision,
    candidates,
    attempted,
    async (market) => {
      published.push(market.sides[0].bid ?? "missing");
    },
    createHip4VisibleBookDependencies(pool, policy, undefined, fetcher),
  );
  assert.equal(denied.budgetDenied, 1);
  assert.equal(http, 0);
  assert.equal(
    (await readHip4StoredMarket(pool, policy.environment, outcomes[0]))?.market
      .sides[0].bookAttempt?.result,
    "budget_exhausted",
  );
  // Simulate ordinary rolling-window expiry, not a budget bypass in the worker.
  await pool.query(
    "update hip4_request_budget set admissions=jsonb_build_array(jsonb_build_object('at',extract(epoch from now())-61,'weight',600)) where scope='public-info'",
  );
  const recovered = await refreshHip4VisibleBooks(
    policy,
    revision,
    [candidates[0]],
    attempted,
    async (market) => {
      published.push(market.sides[0].bid ?? "missing");
    },
    createHip4VisibleBookDependencies(pool, policy, undefined, fetcher),
  );
  assert.equal(recovered.budgetDenied, 0);
  assert.equal(http, 2);
  assert.equal(
    (await readHip4StoredMarket(pool, policy.environment, outcomes[0]))?.market
      .sides[0].bid,
    "0.8",
    "a slow REST completion cannot overwrite newer canonical WS/provider time",
  );
  assert.equal(
    published.at(-1),
    "0.8",
    "Redis publication uses the merged committed snapshot",
  );
  const staleCandidate = candidates[2];
  const beforeSettlement = await readHip4StoredMarket(
    pool,
    policy.environment,
    outcomes[2],
  );
  assert.ok(beforeSettlement);
  const settledAt = new Date().toISOString();
  await persistHip4Market(pool, {
    market: {
      ...beforeSettlement.market,
      status: "settled",
      settlement: {
        source: "settledOutcome",
        observedAt: settledAt,
        checkedAt: settledAt,
        details: "Official fixture settlement",
      },
    },
    raw: {
      ...beforeSettlement.raw,
      settlement: {
        spec: beforeSettlement.raw.outcome,
        settleFraction: "1",
        details: "Official fixture settlement",
      },
    },
    trades: [],
    advanceCursor: false,
    policy,
  });
  const afterSettlement = await refreshHip4VisibleBooks(
    policy,
    revision,
    [staleCandidate],
    attempted,
    async () => {},
    createHip4VisibleBookDependencies(pool, policy, undefined, fetcher),
  );
  assert.equal(
    afterSettlement.attempts,
    0,
    "canonical settlement after cached selection prevents all provider IO",
  );
  assert.equal(http, 2);
  console.log(
    "HIP4 visible books PG16: indexed hot points, real shared admission denial/recovery, bounded book-only reads and newer-provider merge passed",
  );
} finally {
  await lifecycle.close();
  await pool.query("delete from runtime_policies where id=$1", [policyId]);
  await pool.query("delete from unified_markets where id=any($1::text[])", [
    outcomes.map((outcome) => hip4Identity("mainnet", outcome).marketId),
  ]);
  await pool.query("delete from unified_events where id=any($1::text[])", [
    outcomes.map((outcome) => hip4Identity("mainnet", outcome).marketId),
  ]);
  await pool.query("delete from hip4_request_budget where scope='public-info'");
  await pool.end();
}
