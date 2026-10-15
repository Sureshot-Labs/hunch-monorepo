import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pool } from "./db.js";
import { PolymarketEvent, PolymarketMarket } from "./types.js";
import {
  mapPolymarketEventRow,
  mapPolymarketMarketRow,
  mapToUnifiedEvent,
  mapToUnifiedMarket,
} from "./mappers.js";
import {
  upsertEventsConsistently,
  upsertMarketsConsistently,
} from "./consistentUpserts.js";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../fixtures/polymarket/v2-public-20261015.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
try {
  assert.ok(
    process.env.HUNCH_TEST_EXPECT_DATABASE?.startsWith("hunch_poly_v2_"),
  );
  const target = (
    await pool.query(
      "select current_database() as database_name, current_setting('server_version_num')::int as major",
    )
  ).rows[0];
  assert.equal(target.database_name, process.env.HUNCH_TEST_EXPECT_DATABASE);
  assert.ok(target.major >= 160000 && target.major < 170000);
  const event = PolymarketEvent.parse({
    id: "gamma-v2-integration",
    title: "Captured public V2 markets",
    active: true,
    closed: false,
    markets: fixture.markets,
  });
  // These fixed public IDs are test-owned inside this explicitly named
  // disposable DB. Reset only their terminal outcome for a repeatable test;
  // production upserts intentionally preserve an already canonical outcome.
  const fixtureIds = event.markets.map((market) => `polymarket:${market.id}`);
  const previous = (
    await pool.query(
      "select id,event_id from unified_markets where id=any($1::text[])",
      [fixtureIds],
    )
  ).rows;
  assert.ok(previous.every((row) => row.event_id === `polymarket:${event.id}`));
  await pool.query(
    "update unified_markets set resolved_outcome=null,resolved_outcome_pct=null where id=any($1::text[]) and event_id=$2",
    [fixtureIds, `polymarket:${event.id}`],
  );
  await upsertEventsConsistently(pool, {
    unified: [mapToUnifiedEvent(event)],
    polymarket: [mapPolymarketEventRow(event)],
  });
  const upsert = async (raw: unknown) => {
    const market = PolymarketMarket.parse(raw);
    return upsertMarketsConsistently(pool, {
      unified: [mapToUnifiedMarket(market, event.id, event)],
      polymarket: [mapPolymarketMarketRow(event.id, market)],
    });
  };
  for (const raw of fixture.markets) {
    await upsert(raw);
    const again = await upsert(raw);
    assert.equal(again.unified.changedRows, 0);
    assert.equal(again.polymarket.changedRows, 0);
    const marketId = `polymarket:${raw.id}`;
    for (const table of ["unified_tokens", "unified_market_tokens"] as const) {
      const sideColumn = table === "unified_tokens" ? "side" : "outcome_side";
      const rows = (
        await pool.query(
          `select token_id, ${sideColumn} as outcome_side from ${table} where market_id=$1 order by ${sideColumn} desc`,
          [marketId],
        )
      ).rows;
      assert.deepEqual(
        rows.map((row) => row.token_id).sort(),
        [...raw.positionIds].sort(),
      );
      assert.equal(
        rows.find((row) => row.outcome_side === "YES")?.token_id,
        raw.positionIds[0],
      );
      assert.equal(
        rows.find((row) => row.outcome_side === "NO")?.token_id,
        raw.positionIds[1],
      );
    }
    const bindings = (
      await pool.query(
        "select asset_id, protocol_version, position_contract from polymarket_asset_bindings where market_id=$1 order by asset_id",
        [marketId],
      )
    ).rows;
    assert.equal(bindings.length, 2);
    assert.ok(
      bindings.every(
        (row) =>
          row.protocol_version === "v2" &&
          row.position_contract.toLowerCase() ===
            "0x006f54f7f9a22e0000cc2ab60031000000ae9fef",
      ),
    );
    assert.deepEqual(
      bindings.map((row) => row.asset_id),
      [...raw.positionIds].sort(),
    );
    const source = (
      await pool.query(
        "select raw->>'version' as version, clob_token_ids from polymarket_markets where id=$1",
        [raw.id],
      )
    ).rows[0];
    assert.equal(source.version, "v2");
    assert.deepEqual(JSON.parse(source.clob_token_ids), raw.positionIds);
  }
  const binary = fixture.markets[0];
  await upsert({
    ...binary,
    resolutionStatus: "inactive",
    acceptingOrders: false,
    outcomePrices: '["1","0"]',
  });
  let stored = (
    await pool.query(
      "select status, resolved_outcome from unified_markets where id=$1",
      [`polymarket:${binary.id}`],
    )
  ).rows[0];
  assert.deepEqual(stored, { status: "CLOSED", resolved_outcome: null });
  await upsert({
    ...binary,
    closed: true,
    resolutionStatus: "resolved",
    acceptingOrders: false,
    outcomePrices: '["1","0"]',
  });
  stored = (
    await pool.query(
      "select status, resolved_outcome from unified_markets where id=$1",
      [`polymarket:${binary.id}`],
    )
  ).rows[0];
  assert.deepEqual(stored, { status: "SETTLED", resolved_outcome: "YES" });

  // Changing the current projection must retain the old CTF ledger binding.
  const rotating = { ...binary, id: "gamma-v2-rotating" };
  await upsert({
    ...rotating,
    version: "v1",
    positionIds: undefined,
    clobTokenIds: '["111","112"]',
  });
  // Use a separate captured condition/IDs to avoid assigning one asset to two markets.
  const condition = (1n << 248n) | (0x1234n << 120n);
  const ids = [condition.toString(), (condition | 1n).toString()];
  await upsert({
    ...rotating,
    conditionId: `0x${condition.toString(16).padStart(64, "0")}`,
    positionIds: ids,
    clobTokenIds: JSON.stringify(ids),
  });
  const retained = (
    await pool.query(
      "select asset_id, protocol_version from polymarket_asset_bindings where market_id='polymarket:gamma-v2-rotating' order by protocol_version, asset_id",
    )
  ).rows;
  assert.equal(retained.length, 4);
  assert.deepEqual(
    retained
      .filter((row) => row.protocol_version === "v1")
      .map((row) => row.asset_id),
    ["111", "112"],
  );
  console.log(
    "ok - PG16 Gamma -> source/unified -> two token projections/bindings -> repeat -> resolution + historical V1 bindings",
  );
} finally {
  await pool.end();
}
