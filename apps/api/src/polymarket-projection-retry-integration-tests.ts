// @api-integration
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  fetchPolymarketAssetBindings,
  upsertUnifiedEvent,
  upsertUnifiedMarket,
  upsertUnifiedMarkets,
  type UnifiedMarketRow,
} from "@hunch/db";
import { resolvePolymarketMarketAssets } from "@hunch/shared";
import type { Pool } from "@hunch/infra";
import { createIntegrationTestPool } from "./test-database-target.js";

const db = await createIntegrationTestPool({
  max: 4,
  options: "-c statement_timeout=10000",
});
const suffix = randomUUID();
const eventId = `polymarket:projection-retry-event-${suffix}`;
const marketId = `polymarket:projection-retry-${suffix}`;
const base = (1n << 248n) | (BigInt(`0x${suffix.replaceAll("-", "")}`) << 120n);
const conditionId = `0x${base.toString(16).padStart(64, "0")}`;
const oldIds = [base.toString(), (base + 1n).toString()];
const nextBase = base ^ (1n << 120n);
const nextConditionId = `0x${nextBase.toString(16).padStart(64, "0")}`;
const nextIds = [nextBase.toString(), (nextBase | 1n).toString()];
const marketFor = (version: "v1" | "v2"): UnifiedMarketRow => {
  const ids = version === "v1" ? oldIds : nextIds;
  const selectedConditionId = version === "v1" ? conditionId : nextConditionId;
  return {
    id: marketId,
    venue: "polymarket",
    venue_market_id: marketId,
    event_id: eventId,
    title: "Projection retry fixture",
    status: "ACTIVE",
    market_type: "binary",
    condition_id: selectedConditionId,
    clob_token_ids: JSON.stringify(ids),
    outcomes: '["Yes","No"]',
    metadata: {
      polymarketProtocol: resolvePolymarketMarketAssets({
        version,
        conditionId: selectedConditionId,
        clobTokenIds: oldIds,
        positionIds: nextIds,
        outcomes: '["Yes","No"]',
      }),
    },
  };
};
const beforeMarket = marketFor("v1");
const nextMarket = marketFor("v2");
const mapping = async (table: "unified_tokens" | "unified_market_tokens") =>
  (
    await db.query(
      `select token_id from ${table} where market_id=$1 order by token_id`,
      [marketId],
    )
  ).rows
    .map((row) => row.token_id)
    .sort();
const assertMappings = async (ids: string[]) => {
  for (const table of ["unified_tokens", "unified_market_tokens"] as const)
    assert.deepEqual(await mapping(table), [...ids].sort(), table);
};
const failure = new Error("injected projection checkout failure");
// Real source queries commit through the real pool. Fail only the subsequent
// projection transaction's checkout, exactly at the previously untested gap.
const interruptedPool = {
  query: db.query.bind(db),
  connect: async () => {
    throw failure;
  },
} as unknown as Pool;

try {
  assert.equal(
    (
      await db.query(
        "select current_setting('server_version_num')::int as version",
      )
    ).rows[0].version >= 160000,
    true,
  );
  await upsertUnifiedEvent(db, {
    id: eventId,
    venue: "polymarket",
    venue_event_id: eventId,
    title: "Retry fixture",
    status: "ACTIVE",
  });
  await upsertUnifiedMarket(db, beforeMarket);
  await assertMappings(oldIds);
  await assert.rejects(
    upsertUnifiedMarkets(interruptedPool, [nextMarket], {
      filterUnchanged: true,
    }),
    (error) => error === failure,
  );
  assert.equal(
    (
      await db.query(
        "select metadata->'polymarketProtocol'->>'protocolVersion' as version from unified_markets where id=$1",
        [marketId],
      )
    ).rows[0].version,
    "v2",
  );
  await assertMappings(oldIds);
  const retried = await upsertUnifiedMarkets(db, [nextMarket], {
    filterUnchanged: true,
  });
  assert.equal(retried.changedRows, 0);
  assert.equal(retried.skippedRows, 1);
  assert.equal(retried.upsertedRows, 0);
  assert.equal(
    retried.tokenSyncMarketCount,
    1,
    "identical payload repairs both projections without source rewrite",
  );
  await assertMappings(nextIds);
  assert.equal(
    (await fetchPolymarketAssetBindings(db, oldIds[0]))[0]?.protocol_version,
    "v1",
  );
  assert.equal(
    (await fetchPolymarketAssetBindings(db, nextIds[0]))[0]?.protocol_version,
    "v2",
  );
  const healthy = await upsertUnifiedMarkets(interruptedPool, [nextMarket], {
    filterUnchanged: true,
  });
  assert.equal(
    healthy.tokenSyncMarketCount,
    0,
    "healthy no-op never starts a projection transaction",
  );

  await upsertUnifiedMarket(db, beforeMarket);
  await assert.rejects(
    upsertUnifiedMarkets(interruptedPool, [nextMarket], {
      filterUnchanged: true,
    }),
    (error) => error === failure,
  );
  const pricedMarket = { ...nextMarket, best_bid: 0.4, best_ask: 0.6 };
  const priced = await upsertUnifiedMarkets(db, [pricedMarket], {
    filterUnchanged: true,
  });
  assert.equal(priced.changeReasons?.primary.metrics, 1);
  assert.equal(
    priced.tokenSyncMarketCount,
    1,
    "metrics-only refresh also repairs the interrupted generation",
  );
  await assertMappings(nextIds);
  const healthyPrices = await upsertUnifiedMarkets(
    interruptedPool,
    [{ ...pricedMarket, best_bid: 0.41 }],
    { filterUnchanged: true },
  );
  assert.equal(
    healthyPrices.tokenSyncMarketCount,
    0,
    "healthy metrics-only update does not replace projections",
  );

  // The single-market writer has the same failure/retry boundary.
  await upsertUnifiedMarket(db, beforeMarket);
  await assert.rejects(
    upsertUnifiedMarket(interruptedPool, nextMarket),
    (error) => error === failure,
  );
  await assertMappings(oldIds);
  await upsertUnifiedMarket(db, nextMarket);
  await assertMappings(nextIds);
  await upsertUnifiedMarket(interruptedPool, nextMarket);
  // Either projection can independently be missing or have the wrong side.
  await db.query(
    "delete from unified_tokens where market_id=$1 and side='NO'",
    [marketId],
  );
  assert.equal(
    (await upsertUnifiedMarkets(db, [nextMarket], { filterUnchanged: true }))
      .tokenSyncMarketCount,
    1,
  );
  await db.query(
    "update unified_market_tokens set outcome_side=null where market_id=$1 and outcome_side='NO'",
    [marketId],
  );
  assert.equal(
    (await upsertUnifiedMarkets(db, [nextMarket], { filterUnchanged: true }))
      .tokenSyncMarketCount,
    1,
  );
  assert.equal(
    (
      await db.query(
        "select outcome_side from unified_market_tokens where market_id=$1 and token_id=$2",
        [marketId, nextIds[1]],
      )
    ).rows[0].outcome_side,
    "NO",
  );

  // Execute the actual diagnostic query with large unrelated projections. The
  // planner must use market-first indexed probes, not re-scan the full maps.
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type)
      select $1 || fixture_row.ordinality,'polymarket',$1 || fixture_row.ordinality,$2,'Noise','ACTIVE','binary'
      from generate_series(1,20000) as fixture_row(ordinality)`,
      [`projection-noise-${suffix}-`, eventId],
    );
    await client.query(
      `insert into unified_market_tokens(market_id,token_id,venue,outcome_side)
      select $1 || fixture_row.ordinality, $1 || fixture_row.ordinality || ':yes','polymarket','YES'
      from generate_series(1,20000) as fixture_row(ordinality)`,
      [`projection-noise-${suffix}-`],
    );
    await client.query(
      `insert into unified_tokens(market_id,token_id,venue,side)
      select $1 || fixture_row.ordinality, $1 || fixture_row.ordinality || ':yes','polymarket','YES'
      from generate_series(1,20000) as fixture_row(ordinality)`,
      [`projection-noise-${suffix}-`],
    );
    await client.query(
      "analyze unified_markets; analyze unified_market_tokens; analyze unified_tokens",
    );
    let probeSql: string | undefined;
    const pinnedPool = {
      query: (sql: string, values?: unknown[]) => {
        if (sql.includes("market_projection.market_tokens")) probeSql = sql;
        return client.query(sql, values);
      },
      connect: async () => {
        throw new Error("healthy refresh must not replace projections");
      },
    } as unknown as Pool;
    const noOp = await upsertUnifiedMarkets(pinnedPool, [nextMarket], {
      filterUnchanged: true,
    });
    assert.equal(noOp.changedRows, 0);
    assert.equal(noOp.tokenSyncMarketCount, 0);
    assert.ok(probeSql, "execute actual production projection diagnostic");
    const plan = (
      await client.query(`explain (analyze,buffers,format json) ${probeSql}`, [
        [marketId],
      ])
    ).rows[0]["QUERY PLAN"][0];
    const inspectPlan = (node: Record<string, unknown>): void => {
      if (
        ["unified_markets", "unified_tokens", "unified_market_tokens"].includes(
          String(node["Relation Name"]),
        )
      ) {
        assert.notEqual(node["Node Type"], "Seq Scan", JSON.stringify(node));
        assert.ok(
          Number(node["Actual Rows"] ?? 0) +
            Number(node["Rows Removed by Filter"] ?? 0) <=
            2,
          JSON.stringify(node),
        );
      }
      for (const child of (node.Plans ?? []) as Record<string, unknown>[])
        inspectPlan(child);
    };
    inspectPlan(plan.Plan);
    console.log(
      `[polymarket-projection-retry] indexed projection probe: ${plan["Execution Time"]} ms with 20,000 unrelated markets/tokens`,
    );
  } finally {
    await client.query("rollback");
    client.release();
  }
  console.log(
    "[polymarket-projection-retry] interrupted batch/single, identical/metrics retries, independent projection loss and no-op scale passed",
  );
} finally {
  await db.query("delete from unified_tokens where market_id=$1", [marketId]);
  await db.query("delete from polymarket_asset_bindings where market_id=$1", [
    marketId,
  ]);
  await db.query("delete from unified_markets where id=$1", [marketId]);
  await db.query("delete from unified_events where id=$1", [eventId]);
  await db.end();
}
