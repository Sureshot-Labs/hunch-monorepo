// @requires-db
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createIntegrationTestPool } from "./test-database-target.js";
import { mapHip4Market } from "./services/hip4-mapping.js";
import {
  admitHip4Request,
  advanceHip4Cursor,
  persistHip4Market,
  readHip4Cursor,
  readHip4Markets,
  readHip4Policy,
  readHip4StoredMarket,
} from "./services/hip4-repository.js";
import { runHip4ReadCycle } from "./services/hip4-indexer.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../src/fixtures/hip4/public-reads.json", import.meta.url),
    "utf8",
  ),
);
const main = fixture.observations[0];
const pool = await createIntegrationTestPool({
  max: 4,
  options: "-c statement_timeout=15000",
});
try {
  const version = await pool.query("show server_version_num");
  assert.equal(
    Math.floor(Number(version.rows[0].server_version_num) / 10000),
    16,
  );
  assert.equal((await readHip4Policy(pool)).policy.enabled, false);
  const mapped = mapHip4Market({
    ...main,
    outcome: 8775,
    settlement: null,
    fetchedAt: fixture.collectedAt,
    generation: randomUUID(),
  });
  const tied = { ...main.trades[0], coin: "#87750" };
  const trade2 = { ...tied, tid: tied.tid + 1 };
  await persistHip4Market(pool, { ...mapped, trades: [tied, trade2] });
  await persistHip4Market(pool, { ...mapped, trades: [tied, trade2] });
  assert.equal(
    Number(
      (
        await pool.query(
          "select count(*) as n from hip4_public_trades where market_id=$1",
          [mapped.market.marketId],
        )
      ).rows[0].n,
    ),
    2,
  );
  assert.equal(
    Number(
      (
        await pool.query(
          "select count(*) as n from unified_tokens where market_id=$1",
          [mapped.market.marketId],
        )
      ).rows[0].n,
    ),
    2,
  );
  assert.equal(
    (await readHip4Markets(pool, "testnet", [8775], -1, 2)).length,
    0,
  );
  assert.equal(
    (await readHip4Markets(pool, "mainnet", [8775], -1, 2)).length,
    1,
  );
  assert.equal(
    (await readHip4Markets(pool, "mainnet", [8775], 8775, 2)).length,
    0,
  );
  assert.equal((await readHip4Markets(pool, "mainnet", [], -1, 2)).length, 0);
  await assert.rejects(
    persistHip4Market(pool, {
      ...mapped,
      trades: [{ ...tied, coin: "#9990" }],
    }),
  );
  assert.equal(
    (await readHip4StoredMarket(pool, "mainnet", 8775))?.market.generation,
    mapped.market.generation,
  );
  const older = {
    ...mapped,
    market: { ...mapped.market, fetchedAt: "2020-01-01T00:00:00.000Z" },
  };
  assert.equal(await persistHip4Market(pool, { ...older, trades: [] }), false);
  const settled = mapHip4Market({
    ...main,
    outcome: 95,
    fetchedAt: fixture.collectedAt,
    generation: randomUUID(),
    settlement: { ...main.settlement, settleFraction: "0.375" },
  });
  await persistHip4Market(pool, { ...settled, trades: [] });
  await persistHip4Market(pool, {
    ...settled,
    market: {
      ...settled.market,
      settlement: null,
      status: "expired",
      sides: settled.market.sides.map((s) => ({ ...s, payout: null })),
    },
    raw: { ...(settled.raw as object), settlement: null },
    trades: [],
  });
  assert.equal(
    (await readHip4StoredMarket(pool, "mainnet", 95))?.market.sides[1].payout,
    "0.625",
  );
  assert.equal(
    (
      await pool.query(
        "select resolved_outcome from unified_markets where id=$1",
        [settled.market.marketId],
      )
    ).rows[0].resolved_outcome,
    null,
  );
  const nearOne = mapHip4Market({
    ...main,
    outcome: 95,
    fetchedAt: fixture.collectedAt,
    generation: randomUUID(),
    settlement: {
      ...main.settlement,
      settleFraction: "0.99999999999999999999",
    },
  });
  await persistHip4Market(pool, { ...nearOne, trades: [] });
  assert.equal(
    (
      await pool.query(
        "select resolved_outcome from unified_markets where id=$1",
        [settled.market.marketId],
      )
    ).rows[0].resolved_outcome,
    null,
  );
  const admissions = await Promise.all(
    Array.from({ length: 10 }, () =>
      admitHip4Request(pool, "mainnet", 20, 100),
    ),
  );
  assert.equal(admissions.filter(Boolean).length, 5);
  assert.equal(await admitHip4Request(pool, "testnet", 1, 100), false);
  assert.equal(await admitHip4Request(pool, "testnet", 101, 100), false);
  // An elapsed rolling window recovers immediately, including another env.
  await pool.query(
    "update hip4_request_budget set admissions=jsonb_build_array(jsonb_build_object('at',extract(epoch from now())-61,'weight',100)) where scope='public-info'",
  );
  assert.equal(await admitHip4Request(pool, "testnet", 100, 100), true);
  assert.equal(await admitHip4Request(pool, "mainnet", 1, 100), false);
  await assert.rejects(
    persistHip4Market(pool, {
      ...mapped,
      market: { ...mapped.market, sides: [...mapped.market.sides].reverse() },
      trades: [],
    }),
    /market_identity_mismatch/,
  );
  await advanceHip4Cursor(pool, "mainnet", 99);
  assert.equal(await readHip4Cursor(pool, "mainnet"), 99);
  const policy = {
    enabled: true,
    outcomeAllowlist: [8775],
    requestWeightPerMinute: 120,
  };
  const policyId = randomUUID();
  await pool.query(
    "insert into runtime_policies(id,policy_key,effective_at,payload) values($1,'hip4_read',$3,$2::jsonb)",
    // Effective time is in the application clock domain, matching the reader.
    // Docker's PG clock can lead the host by milliseconds; no sleep is needed.
    [policyId, JSON.stringify(policy), new Date(Date.now() - 1000)],
  );
  let calls = 0;
  const futureMetadata = {
    ...main.metadata,
    outcomes: main.metadata.outcomes.map(
      (row: { outcome: number; description: string }) => ({
        ...row,
        description: row.description.replace(
          /resolutionDeadline:\d{8}-\d{4}/,
          "resolutionDeadline:20990101-0000",
        ),
      }),
    ),
  };
  const cycle = await runHip4ReadCycle(pool, async (request) => {
    calls++;
    if (request.type === "outcomeMeta") return futureMetadata;
    if (request.type === "spotMeta") return main.spotMetadata;
    if (request.type === "l2Book")
      return { coin: request.coin, time: Date.now(), levels: [[], []] };
    if (request.type === "recentTrades") return [];
    throw new Error("unexpected_request");
  });
  assert.equal(cycle.indexed, 1, JSON.stringify(cycle));
  assert.equal(calls, 5);
  const observed = await readHip4StoredMarket(pool, "mainnet", 8775);
  assert.equal(observed?.market.coverage.trades, "recent_window");
  assert.equal(observed?.market.coverage.tradeWindowStart, null);
  assert.ok(observed?.market.coverage.tradeObservedAt);
  const expiredMetadata = {
    ...futureMetadata,
    outcomes: futureMetadata.outcomes.map(
      (row: { outcome: number; description: string }) => ({
        ...row,
        description: row.description.replace("20990101-0000", "20200101-0000"),
      }),
    ),
  };
  const expiredRead = async (request: { type: string }) => {
    if (request.type === "outcomeMeta") return expiredMetadata;
    if (request.type === "spotMeta") return main.spotMetadata;
    if (request.type === "settledOutcome")
      return {
        spec: expiredMetadata.outcomes.find(
          (row: { outcome: number }) => row.outcome === 8775,
        ),
        settleFraction: "1.0",
        details: "synthetic official settlement while metadata remains listed",
      };
    throw new Error("settled market must not fetch books or trades");
  };
  assert.equal((await runHip4ReadCycle(pool, expiredRead)).indexed, 1);
  assert.equal(
    (await readHip4StoredMarket(pool, "mainnet", 8775))?.market.sides[0].payout,
    "1.0",
  );
  const beforeFailure = await readHip4StoredMarket(pool, "mainnet", 8775);
  await assert.rejects(
    runHip4ReadCycle(pool, async () => {
      throw new Error("provider unavailable");
    }),
  );
  assert.deepEqual(
    await readHip4StoredMarket(pool, "mainnet", 8775),
    beforeFailure,
  );
  await pool.query(
    "update runtime_policies set payload='{}'::jsonb where id=$1",
    [policyId],
  );
  assert.equal(
    (
      await runHip4ReadCycle(pool, async () => {
        throw new Error("must not fetch");
      })
    ).indexed,
    0,
  );
  await pool.query(
    'update runtime_policies set payload=\'{"enabled":"invalid"}\'::jsonb where id=$1',
    [policyId],
  );
  await assert.rejects(readHip4Policy(pool));
  await pool.query("delete from runtime_policies where id=$1", [policyId]);
  // Existing retention owns the parent deletion. Both raw snapshot and event
  // ledger are derived rows with real cascading FKs, never financial evidence.
  await pool.query("delete from unified_markets where id=$1", [
    mapped.market.marketId,
  ]);
  assert.equal(await readHip4StoredMarket(pool, "mainnet", 8775), null);
  assert.equal(
    Number(
      (
        await pool.query(
          "select count(*) as n from hip4_public_trades where market_id=$1",
          [mapped.market.marketId],
        )
      ).rows[0].n,
    ),
    0,
  );
  console.log(
    "HIP4 PostgreSQL 16: replay/ties, atomic rollback, frozen settlement, paging, budget concurrency, policy failure and cascading retention passed",
  );
} finally {
  await pool.end();
}
