// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DEFAULT_HIP4_READ_POLICY } from "@hunch/shared";
import { createIntegrationTestPool } from "./test-database-target.js";
import { mapHip4Market, applyHip4Book } from "./services/hip4-mapping.js";
import {
  persistHip4Market,
  readHip4StoredMarket,
  recordHip4MetadataFailure,
  advanceHip4Cursor,
  readHip4Cursor,
} from "./services/hip4-repository.js";
import { readHip4Trades, readHip4Candles } from "./services/hip4-history.js";
import { runHip4ReadCycle } from "./services/hip4-indexer.js";
import { createHip4ReadClient } from "./services/hip4-client.js";
import { createHip4LiveBuffer, flushHip4Live } from "./services/hip4-live.js";

const pool = await createIntegrationTestPool({
  max: 4,
  options: "-c statement_timeout=15000",
});
const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/hip4/public-reads.json", import.meta.url),
    "utf8",
  ),
);
const main = fixture.observations[0];
const policyId = randomUUID();
const now = Date.now();
const rotationOutcomes = [500001, 500002, 500003, 500004, 500005, 500006];
const futureMeta = {
  ...main.metadata,
  outcomes: main.metadata.outcomes.map((row: { description: string }) => ({
    ...row,
    description: row.description.replace(
      /resolutionDeadline:\d{8}-\d{4}/,
      "resolutionDeadline:20990101-0000",
    ),
  })),
};
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
  const priorFixture = await pool.query(
    "select title from unified_markets where id='hyperliquid:mainnet:outcome:8775'",
  );
  if (priorFixture.rows.length)
    assert.equal(
      priorFixture.rows[0].title,
      "Detroit Lions vs Arizona Cardinals",
    );
  await pool.query(
    "delete from unified_markets where id='hyperliquid:mainnet:outcome:8775'",
  );
  const mapped = mapHip4Market({
    ...main,
    metadata: futureMeta,
    outcome: 8775,
    settlement: null,
    fetchedAt: new Date(now - 200).toISOString(),
    generation: randomUUID(),
  });
  const book = (time: number, px: string) => ({
    coin: "#87750",
    time,
    levels: [[{ px, sz: "1", n: 1 }], []],
  });
  mapped.market = applyHip4Book(
    mapped.market,
    0,
    book(now - 1000, "0.6"),
    now,
    60000,
  );
  const bucket = Math.floor((now - 10000) / 60000) * 60000;
  const trade = {
    coin: "#87750",
    time: bucket + 1000,
    tid: 2,
    px: "0.6",
    sz: "2.5",
    side: "B" as const,
    hash: "fixture",
  };
  await persistHip4Market(pool, { ...mapped, trades: [trade] });
  const older = mapHip4Market({
    ...main,
    metadata: futureMeta,
    outcome: 8775,
    settlement: null,
    fetchedAt: new Date(now - 100).toISOString(),
    generation: randomUUID(),
  });
  older.market = applyHip4Book(
    older.market,
    0,
    book(now - 5000, "0.4"),
    now,
    60000,
  );
  await persistHip4Market(pool, { ...older, trades: [trade] });
  assert.equal(
    (await readHip4StoredMarket(pool, "mainnet", 8775))?.market.sides[0].bid,
    "0.6",
  );
  // Old metadata must not discard a newer book or new trades during a REST/WS race.
  mapped.market = applyHip4Book(mapped.market, 0, book(now, "0.7"), now, 60000);
  mapped.market.coverage = {
    ...mapped.market.coverage,
    trades: "recent_window",
    tradeObservedAt: new Date(now).toISOString(),
    tradeAttempt: { at: new Date(now).toISOString(), result: "ok" },
  };
  await persistHip4Market(pool, {
    ...mapped,
    trades: [
      { ...trade, tid: 1, px: "0.3", sz: "1" },
      { ...trade, time: bucket + 500, tid: 4, px: "0.2", sz: "3" },
      { ...trade, time: bucket + 2000, tid: 3, px: "0.8", sz: "4" },
    ],
    intervals: [
      {
        start: bucket,
        end: bucket + 3000,
        kind: "observed",
        reason: "ws_partial",
      },
      {
        start: bucket + 3000,
        end: bucket + 5000,
        kind: "gap",
        reason: "disconnect",
      },
    ],
  });
  assert.equal(
    (await readHip4StoredMarket(pool, "mainnet", 8775))?.market.coverage
      .tradeObservedAt,
    new Date(now).toISOString(),
  );
  assert.equal(
    (await readHip4StoredMarket(pool, "mainnet", 8775))?.market.sides[0].bid,
    "0.7",
  );
  const candles = await readHip4Candles(
    pool,
    mapped.market.marketId,
    bucket,
    bucket + 60000,
    20,
  );
  assert.deepEqual(candles.candles[0], {
    time: bucket,
    open: "0.2",
    high: "0.8",
    low: "0.2",
    close: "0.8",
    volume: "10.5",
    trades: 4,
    complete: false,
  });
  assert.equal(candles.coverage.complete, false);
  assert.ok(candles.coverage.intervals.some((row) => row.kind === "gap"));
  const emptyRecent = await readHip4Candles(
    pool,
    mapped.market.marketId,
    bucket + 86400000,
    bucket + 172800000,
    20,
  );
  assert.equal(emptyRecent.candles.length, 0);
  assert.equal(emptyRecent.nextBefore, bucket + 60000);
  assert.ok(emptyRecent.nextBefore !== null);
  const olderPage = await readHip4Candles(
    pool,
    mapped.market.marketId,
    emptyRecent.nextBefore - 86400000,
    emptyRecent.nextBefore,
    20,
  );
  assert.equal(olderPage.candles[0].time, bucket);
  assert.equal(olderPage.nextBefore, null);
  const first = await readHip4Trades(
    pool,
    mapped.market.marketId,
    undefined,
    2,
  );
  const second = await readHip4Trades(
    pool,
    mapped.market.marketId,
    first.nextCursor ?? undefined,
    2,
  );
  assert.deepEqual(
    [...first.trades, ...second.trades].map((row) => row.tid),
    [3, 2, 1, 4],
  );
  assert.equal(second.nextCursor, null);
  await persistHip4Market(pool, {
    ...mapped,
    trades: [
      { ...trade, time: bucket + 4000, tid: 9 },
      { ...trade, time: bucket + 4000, tid: 10 },
    ],
  });
  const numericFirst = await readHip4Trades(
    pool,
    mapped.market.marketId,
    undefined,
    1,
  );
  assert.equal(numericFirst.trades[0].tid, 10);
  assert.ok(numericFirst.nextCursor);
  const numericSecond = await readHip4Trades(
    pool,
    mapped.market.marketId,
    numericFirst.nextCursor,
    1,
  );
  assert.equal(numericSecond.trades[0].tid, 9);
  assert.equal(
    (
      await readHip4Candles(
        pool,
        mapped.market.marketId,
        bucket + 60000,
        bucket + 120000,
        20,
      )
    ).candles.length,
    0,
  );
  await pool.query(
    "insert into runtime_policies(id,policy_key,effective_at,payload) values($1,'hip4_read',$2,$3)",
    [
      policyId,
      new Date(now - 1000),
      JSON.stringify({
        enabled: true,
        outcomeAllowlist: [8775],
        requestWeightPerMinute: 40,
      }),
    ],
  );
  for (const budget of [40, 42, 600]) {
    await pool.query("update runtime_policies set payload=$2 where id=$1", [
      policyId,
      JSON.stringify({
        enabled: true,
        outcomeAllowlist: [8775],
        requestWeightPerMinute: budget,
        maxTradesPerResponse: 1,
      }),
    ]);
    let spent = 0;
    const reader = createHip4ReadClient(
      {
        ...DEFAULT_HIP4_READ_POLICY,
        enabled: true,
        requestWeightPerMinute: budget,
        maxTradesPerResponse: 1,
      },
      async (weight) => {
        if (spent + weight > budget) return false;
        spent += weight;
        return true;
      },
      async (_url, options) => {
        const request = JSON.parse(String(options?.body));
        return Response.json(
          request.type === "outcomeMeta"
            ? futureMeta
            : request.type === "spotMeta"
              ? main.spotMetadata
              : request.type === "l2Book"
                ? { ...book(Date.now(), "0.5"), coin: request.coin }
                : [trade, { ...trade, tid: 5 }],
        );
      },
    );
    const cycle = await runHip4ReadCycle(pool, reader);
    assert.equal(cycle.indexed, 1, JSON.stringify(cycle));
    assert.ok(spent <= budget);
    if (budget < 600)
      assert.ok(
        cycle.failures.some((row) => row.reason.includes("budget_exhausted")),
      );
    else
      assert.equal(
        (await readHip4StoredMarket(pool, "mainnet", 8775))?.market.coverage
          .tradeAttempt?.result,
        "processing_limit",
      );
  }
  // Snapshot and failed-refresh diagnostics use the same lock, so neither
  // writer can erase a newer component observation after an earlier SELECT.
  const held = await pool.connect();
  const attempt = {
    at: new Date(Date.now() + 100).toISOString(),
    result: "timeout" as const,
  };
  let recording: Promise<void> | undefined;
  try {
    await held.query("begin");
    await held.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      mapped.market.marketId,
    ]);
    const snapshot = await readHip4StoredMarket(held, "mainnet", 8775);
    assert.ok(snapshot);
    recording = recordHip4MetadataFailure(pool, "mainnet", [8775], attempt);
    let waiting = false;
    for (let probe = 0; probe < 100 && !waiting; probe++) {
      waiting =
        (
          await pool.query(
            "select 1 from pg_locks where locktype='advisory' and not granted limit 1",
          )
        ).rowCount === 1;
    }
    assert.equal(
      waiting,
      true,
      "failed-attempt writer waits for publication lock",
    );
    await held.query(
      "update hip4_read_markets set read_model=$2::jsonb where market_id=$1",
      [mapped.market.marketId, JSON.stringify(snapshot.market)],
    );
    await held.query("commit");
    await recording;
    await persistHip4Market(pool, {
      ...snapshot,
      trades: [],
      advanceCursor: false,
    });
    assert.deepEqual(
      (await readHip4StoredMarket(pool, "mainnet", 8775))?.market
        .metadataAttempt,
      attempt,
    );
  } finally {
    await held.query("rollback");
    held.release();
    await recording;
  }
  const rotationMetadata = {
    ...futureMeta,
    questions: [],
    outcomes: rotationOutcomes.map((outcome) => ({
      ...futureMeta.outcomes.find(
        (row: { outcome: number }) => row.outcome === 8775,
      ),
      outcome,
    })),
  };
  for (const budget of [600, 40]) {
    await pool.query("update runtime_policies set payload=$2 where id=$1", [
      policyId,
      JSON.stringify({
        enabled: true,
        outcomeAllowlist: rotationOutcomes,
        requestWeightPerMinute: budget,
      }),
    ]);
    await advanceHip4Cursor(pool, "mainnet", 500003);
    const serviced = new Set<number>();
    for (let cycleIndex = 0; cycleIndex < 2; cycleIndex++) {
      let spent = 0;
      const reader = createHip4ReadClient(
        { ...DEFAULT_HIP4_READ_POLICY, requestWeightPerMinute: budget },
        async (weight) => {
          if (spent + weight > budget) return false;
          spent += weight;
          return true;
        },
        async (_url, options) => {
          const request = JSON.parse(String(options?.body));
          if (request.type === "outcomeMeta")
            return Response.json(rotationMetadata);
          if (request.type === "spotMeta")
            return Response.json(main.spotMetadata);
          if (request.type === "l2Book")
            return Response.json({
              coin: request.coin,
              time: Date.now(),
              levels: [[], []],
            });
          serviced.add(Math.floor(Number(request.coin.slice(1)) / 10));
          return Response.json([]);
        },
      );
      const cursorBefore = await readHip4Cursor(pool, "mainnet");
      const result = await runHip4ReadCycle(pool, reader);
      assert.equal(result.indexed, 6);
      assert.ok(spent <= budget);
      assert.notEqual(await readHip4Cursor(pool, "mainnet"), cursorBefore);
    }
    assert.equal(serviced.size, budget === 600 ? 6 : 0);
  }
  await pool.query("update runtime_policies set payload=$2 where id=$1", [
    policyId,
    JSON.stringify({ enabled: true, outcomeAllowlist: [8775] }),
  ]);
  const policy = {
    ...DEFAULT_HIP4_READ_POLICY,
    enabled: true,
    outcomeAllowlist: [8775],
  };
  const buffer = createHip4LiveBuffer(policy, () => {});
  buffer.select([8775]);
  buffer.data("trades", [{ ...trade, tid: 90 }]);
  let published = 0;
  const publish = async () => {
    published++;
    assert.ok(
      (
        await readHip4Trades(pool, mapped.market.marketId, undefined, 100)
      ).trades.some((row) => row.tid === 90),
    );
  };
  await flushHip4Live(pool, policy, `db-${policyId}`, buffer.take(), publish);
  assert.equal(published, 1);
  await flushHip4Live(pool, policy, `db-${policyId}`, buffer.take(), publish);
  assert.equal(published, 2, "idle snapshot repairs failed Redis publication");
  await pool.query("update runtime_policies set payload='{}' where id=$1", [
    policyId,
  ]);
  buffer.data("trades", [{ ...trade, tid: 91 }]);
  await flushHip4Live(pool, policy, `db-${policyId}`, buffer.take(), publish);
  assert.equal(published, 2);
  assert.equal(
    (
      await readHip4Trades(pool, mapped.market.marketId, undefined, 100)
    ).trades.some((row) => row.tid === 91),
    false,
  );
  const previous = await readHip4StoredMarket(pool, "mainnet", 8775);
  assert.ok(previous);
  const official = mapHip4Market({
    ...main,
    outcome: 8775,
    previous,
    fetchedAt: new Date(now + 1000).toISOString(),
    generation: randomUUID(),
    settlementCheckedAt: new Date(now + 1000).toISOString(),
    settlement: {
      spec: previous.raw.outcome,
      settleFraction: "1",
      details: "official",
    },
  });
  const settlementQueue = createHip4LiveBuffer(policy, () => {});
  settlementQueue.select([8775]);
  settlementQueue.data("trades", [
    { ...trade, tid: 101, time: bucket + 3000, sz: "3" },
  ]);
  settlementQueue.data("l2Book", book(Date.now(), "0.1"));
  await persistHip4Market(pool, { ...official, trades: [] });
  // A live writer may have read active state just before this settlement commit.
  // The locked merge, not only the pre-flush check, must freeze terminal books.
  const lateBookTime = Date.now();
  const staleActive = {
    market: applyHip4Book(
      previous.market,
      0,
      book(lateBookTime, "0.15"),
      lateBookTime,
      60000,
    ),
    raw: previous.raw,
  };
  await persistHip4Market(pool, {
    ...staleActive,
    trades: [],
    advanceCursor: false,
  });
  assert.equal(
    (await readHip4StoredMarket(pool, "mainnet", 8775))?.market.sides[0].bid,
    official.market.sides[0].bid,
  );
  await pool.query("update runtime_policies set payload=$2 where id=$1", [
    policyId,
    JSON.stringify(policy),
  ]);
  const terminalBatch = settlementQueue.take();
  await flushHip4Live(
    pool,
    policy,
    `db-${policyId}`,
    terminalBatch,
    async () => {},
  );
  await flushHip4Live(
    pool,
    policy,
    `db-${policyId}`,
    terminalBatch,
    async () => {},
  );
  assert.equal(
    (await readHip4StoredMarket(pool, "mainnet", 8775))?.market.sides[0].bid,
    official.market.sides[0].bid,
  );
  assert.equal(
    (
      await readHip4Trades(pool, mapped.market.marketId, undefined, 100)
    ).trades.filter((row) => row.tid === 101).length,
    1,
  );
  const staleSettlement = mapHip4Market({
    ...main,
    outcome: 8775,
    previous: official,
    fetchedAt: new Date(now + 2000).toISOString(),
    generation: randomUUID(),
    settlementCheckedAt: new Date(now).toISOString(),
    settlement: {
      spec: previous.raw.outcome,
      settleFraction: "0",
      details: "older response",
    },
  });
  await persistHip4Market(pool, { ...staleSettlement, trades: [] });
  const settled = await readHip4StoredMarket(pool, "mainnet", 8775);
  assert.equal(settled?.market.sides[0].payout, "1");
  assert.equal(settled?.raw.settlement?.settleFraction, "1");
  console.log(
    "HIP4 P1 PG16: monotonic REST/WS publication, replay/late/tied candles, full tuple pages, gaps, low-budget progress and recovery, disable and publish-after-commit passed",
  );
} finally {
  await pool.query("delete from runtime_policies where id=$1", [policyId]);
  await pool.query(
    "delete from unified_markets where id='hyperliquid:mainnet:outcome:8775'",
  );
  await pool.query("delete from unified_markets where id=any($1::text[])", [
    rotationOutcomes.map((outcome) => `hyperliquid:mainnet:outcome:${outcome}`),
  ]);
  await pool.end();
}
