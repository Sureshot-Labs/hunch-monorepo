// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DEFAULT_VENUE_LIFECYCLE_POLICY } from "@hunch/shared";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import { createIntegrationTestPool } from "./test-database-target.js";
import { collectHip4AccountValue } from "./account-value/hip4-account-value.js";
import { installHip4TestLifecycle } from "./hip4-test-lifecycle.js";
import { projectHip4Account } from "./services/hip4-account-projection.js";
import { mapHip4Market } from "./services/hip4-mapping.js";
import {
  readHip4PortfolioPositions,
  HIP4_PORTFOLIO_ACCOUNTS_SQL,
  HIP4_PORTFOLIO_MARKETS_SQL,
} from "./services/hip4-portfolio-positions.js";

const target = await createIntegrationTestPool({
  max: 2,
  options: "-c statement_timeout=20000",
});
const pool = await target.connect();
await pool.query("begin");
const ownerId = randomUUID(),
  otherId = randomUUID();
const policyIds = [randomUUID(), randomUUID()];
const address = `0x${"a".repeat(40)}`,
  otherAddress = `0x${"b".repeat(40)}`,
  missingAddress = `0x${"c".repeat(40)}`;
const now = Date.now();
const lifecycle = await installHip4TestLifecycle(pool);
const input = {
  userId: ownerId,
  walletAddresses: [address, otherAddress, missingAddress],
  now,
};
const observation = projectHip4Account({
  environment: "mainnet",
  observedAt: new Date(now).toISOString(),
  role: "user",
  mode: "disabled",
  quote: { tokenId: HYPERCORE_MAINNET_USDC.assetId, index: 0, weiDecimals: 8 },
  state: {
    balances: [
      { coin: "USDC", token: 0, total: "21", hold: "3", entryNtl: "0" },
      { coin: "+87750", total: "20.00001", hold: "1", entryNtl: "999" },
      { coin: "+87751", total: "10", hold: "0", entryNtl: "123" },
    ],
  },
});
const source = JSON.parse(
  readFileSync(
    new URL("./fixtures/hip4/public-reads.json", import.meta.url),
    "utf8",
  ),
).observations[0];
const mapped = mapHip4Market({
  ...source,
  outcome: 8775,
  settlement: null,
  fetchedAt: new Date(now).toISOString(),
  generation: randomUUID(),
});
// All fixture writes, including the plan sample, are rolled back together.
const saveMarket = async () => {
  await pool.query(
    "insert into unified_events(id,venue,venue_event_id,title,status) values($1,'hyperliquid',$1,'Portfolio test','ACTIVE') on conflict(id) do nothing",
    [mapped.market.eventId],
  );
  await pool.query(
    "insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type) values($1,'hyperliquid',$1,$2,'Portfolio test','ACTIVE','binary') on conflict(id) do nothing",
    [mapped.market.marketId, mapped.market.eventId],
  );
  await pool.query(
    "insert into hip4_read_markets(market_id,environment,outcome,fetched_at,generation,read_model,raw) values($1,'mainnet',8775,now(),$2,$3,$4) on conflict(market_id) do update set read_model=excluded.read_model,raw=excluded.raw",
    [mapped.market.marketId, randomUUID(), mapped.market, mapped.raw],
  );
};
mapped.market.status = "observed";
mapped.market.expiry = new Date(now + 86400000).toISOString();
mapped.market.quoteToken = "USDC";
mapped.market.metadataValidUntil = new Date(now + 60000).toISOString();
mapped.market.coverage.metadata = "fresh";
mapped.market.sides.forEach((side) =>
  Object.assign(side, {
    bookState: "fresh",
    bookAt: new Date(now).toISOString(),
    bookValidUntil: new Date(now + 30000).toISOString(),
    bid: "0.5",
    ask: "0.6",
  }),
);
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
    "insert into users(id,is_active) values($1,true),($2,true)",
    [ownerId, otherId],
  );
  await pool.query(
    "insert into user_wallets(user_id,wallet_address,wallet_type,is_verified) values($1,$3,'ethereum',true),($2,$4,'ethereum',true),($1,$5,'ethereum',true)",
    [
      ownerId,
      otherId,
      address.toUpperCase().replace("0X", "0x"),
      otherAddress,
      missingAddress,
    ],
  );
  await pool.query(
    "insert into runtime_policies(id,policy_key,payload,effective_at) values($1,'hip4_read',$3,now()),($2,'hip4_account',$4,now())",
    [...policyIds, { enabled: true, catalogMode: "all" }, { enabled: true }],
  );
  await pool.query(
    "insert into hip4_account_snapshots(environment,account_address,observation,observed_at) values('mainnet',$1,$3,$4),('mainnet',$2,$3,$4),('testnet',$1,$3,$4)",
    [address, otherAddress, observation, new Date(now)],
  );
  await saveMarket();

  const first = await readHip4PortfolioPositions(pool, input);
  assert.equal("accounts" in first, false);
  const valueInput = { pool, ...input, now: new Date(now) };
  const sharedValue = await collectHip4AccountValue(valueInput);
  assert.equal(sharedValue.assets.length, 1);
  assert.equal(sharedValue.assets[0].estimatedUsd?.value, "21");
  assert.equal(sharedValue.positions[0].estimatedUsd?.value, "10.000005");
  assert.ok(
    sharedValue.errors.some((row) => row.code === "account_snapshot_missing"),
  );
  assert.equal(
    (
      await collectHip4AccountValue({
        ...valueInput,
        walletAddresses: [address, address.toUpperCase().replace("0X", "0x")],
      })
    ).assets.length,
    1,
  );
  assert.equal(
    (
      await collectHip4AccountValue({
        ...valueInput,
        walletAddresses: [otherAddress],
      })
    ).assets.length,
    0,
  );
  assert.equal(first.positions.length, 2);
  assert.ok(
    first.positions.every((position) => position.capabilities.sell),
    "future-expiry holdings retain ordinary SELL review on both sides",
  );
  mapped.market.expiry = null;
  await saveMarket();
  const noExpiry = await readHip4PortfolioPositions(pool, input);
  assert.equal(noExpiry.positions.length, 2);
  assert.ok(
    noExpiry.positions.every(
      (position) =>
        position.capabilities.sell && position.marketSummary?.expiry === null,
    ),
    "explicit null expiry retains both holdings and ordinary SELL review without a fabricated deadline",
  );
  const staleNoExpiry = await readHip4PortfolioPositions(pool, {
    ...input,
    now: now + 60001,
  });
  assert.ok(
    staleNoExpiry.positions.every(
      (position) =>
        position.observation.state === "stale" && position.capabilities.sell,
    ),
    "review permits an ordinary stale-position refresh rather than granting spendability",
  );
  for (const expiry of [
    "",
    "invalid",
    new Date(now).toISOString(),
    new Date(now - 1).toISOString(),
  ]) {
    mapped.market.expiry = expiry;
    await saveMarket();
    const unavailable = await readHip4PortfolioPositions(pool, input);
    assert.equal(unavailable.positions.length, 2);
    assert.ok(
      unavailable.positions.every((position) => !position.capabilities.sell),
    );
  }
  Reflect.deleteProperty(mapped.market, "expiry");
  await saveMarket();
  const missingExpiry = await readHip4PortfolioPositions(pool, input);
  assert.equal(missingExpiry.positions.length, 2);
  assert.ok(
    missingExpiry.positions.every((position) => !position.capabilities.sell),
    "missing expiry cannot become the supported explicit-null contract",
  );
  mapped.market.expiry = new Date(now + 86400000).toISOString();
  await saveMarket();
  assert.equal(first.coverage.accounts, 2);
  assert.equal(first.coverage.missingAccounts, 1);
  assert.equal(first.coverage.state, "partial");
  assert.ok(
    first.positions.every((position) => position.walletAddress === address),
  );
  assert.equal(first.positions[0].valuation.marketValue, "10.000005");
  assert.equal(first.coverage.missingCostBasis, 2);
  assert.equal(
    (await readHip4PortfolioPositions(pool, { ...input, userId: otherId }))
      .positions.length,
    2,
  );
  assert.equal(
    (
      await readHip4PortfolioPositions(pool, {
        ...input,
        walletAddresses: [otherAddress],
      })
    ).positions.length,
    0,
  );
  assert.equal(
    (
      await readHip4PortfolioPositions(pool, {
        ...input,
        tokenIds: [observation.positions[1].tokenId],
      })
    ).positions.length,
    1,
  );
  assert.equal(
    (await readHip4PortfolioPositions(pool, { ...input, minSize: 20.00001 }))
      .positions.length,
    1,
  );
  assert.equal(
    (await readHip4PortfolioPositions(pool, { ...input, minSize: 20.00002 }))
      .positions.length,
    0,
  );
  assert.equal(
    (
      await readHip4PortfolioPositions(pool, {
        ...input,
        eventId: mapped.market.eventId,
      })
    ).positions.length,
    2,
  );
  assert.equal(
    (await readHip4PortfolioPositions(pool, { ...input, eventId: "missing" }))
      .positions.length,
    0,
  );
  assert.equal(
    (
      await readHip4PortfolioPositions(pool, {
        ...input,
        search: mapped.market.title,
      })
    ).positions.length,
    2,
  );
  const stale = await readHip4PortfolioPositions(pool, {
    ...input,
    now: now + 60001,
  });
  assert.equal(stale.positions.length, 2);
  assert.equal(stale.coverage.staleAccounts, 1);
  assert.equal(stale.coverage.unpricedPositions, 2);

  await pool.query(
    "update user_wallets set is_verified=false where user_id=$1",
    [ownerId],
  );
  assert.equal(
    (await readHip4PortfolioPositions(pool, input)).positions.length,
    0,
  );
  await pool.query(
    "update user_wallets set is_verified=true where user_id=$1",
    [ownerId],
  );
  await pool.query("update users set is_active=false where id=$1", [ownerId]);
  assert.equal(
    (await readHip4PortfolioPositions(pool, input)).positions.length,
    0,
  );
  await pool.query("update users set is_active=true where id=$1", [ownerId]);
  const setLifecycle = (mode: "active" | "exit-only" | "unreleased") =>
    pool.query("update runtime_policies set payload=$2 where id=$1", [
      lifecycle.id,
      {
        ...DEFAULT_VENUE_LIFECYCLE_POLICY,
        venues: {
          ...DEFAULT_VENUE_LIFECYCLE_POLICY.venues,
          hyperliquid: { lifecycle: mode, indexerMode: "off" },
        },
      },
    ]);
  await setLifecycle("unreleased");
  assert.deepEqual(await collectHip4AccountValue(valueInput), {
    assets: [],
    positions: [],
    errors: [],
    availability: [],
  });
  assert.equal(
    (await readHip4PortfolioPositions(pool, input)).coverage.state,
    "disabled",
  );
  await setLifecycle("exit-only");
  assert.equal(
    (await collectHip4AccountValue(valueInput)).assets[0].estimatedUsd?.value,
    "21",
  );
  assert.equal(
    (await readHip4PortfolioPositions(pool, input)).positions.length,
    2,
  );
  await setLifecycle("active");
  await pool.query("update runtime_policies set payload=$2 where id=$1", [
    policyIds[1],
    { enabled: false },
  ]);
  // The old HIP-specific switch is compatibility data, not a second product
  // policy. Common venue_lifecycle above is the authoritative off/recovery gate.
  assert.equal(
    (await readHip4PortfolioPositions(pool, input)).positions.length,
    2,
  );
  await pool.query("update runtime_policies set payload=$2 where id=$1", [
    policyIds[1],
    { enabled: true },
  ]);
  // A complete fresh zero observation flattens. A missing derived market does not.
  await pool.query(
    "update hip4_account_snapshots set observation=$2 where environment='mainnet' and account_address=$1",
    [address, { ...observation, positions: [] }],
  );
  assert.equal(
    (await readHip4PortfolioPositions(pool, input)).positions.length,
    0,
  );
  await pool.query(
    "update hip4_account_snapshots set observation=$2 where environment='mainnet' and account_address=$1",
    [address, observation],
  );
  await pool.query("delete from hip4_read_markets where market_id=$1", [
    mapped.market.marketId,
  ]);
  assert.equal(
    (await readHip4PortfolioPositions(pool, input)).positions.length,
    2,
  );
  await saveMarket();

  // Representative irrelevant volume must not turn an owned-wallet lookup
  // into a full account/market scan. Fixture writes occur only in this verified
  // disposable DB; no production selector, refresh or mutation is imported.
  await pool.query(
    `insert into users(id) select md5('hip4-portfolio-owner-' || sample_no)::uuid from generate_series(1,10000) sample_no`,
  );
  await pool.query(`insert into user_wallets(user_id,wallet_address,wallet_type,is_verified)
    select md5('hip4-portfolio-owner-' || sample_no)::uuid, '0x' || lpad(to_hex(sample_no),40,'0'), 'ethereum', true from generate_series(1,10000) sample_no`);
  await pool.query(`insert into hip4_account_snapshots(environment,account_address)
    select 'mainnet','0x' || lpad(to_hex(sample_no),40,'0') from generate_series(1,10000) sample_no`);
  await pool.query(
    `insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type)
    select 'hip4-portfolio-plan:' || sample_no, 'hyperliquid','hip4-portfolio-plan:' || sample_no,$1,'Portfolio plan','ACTIVE','binary' from generate_series(1,10000) sample_no`,
    [mapped.market.eventId],
  );
  await pool.query(
    `insert into hip4_read_markets(market_id,environment,outcome,fetched_at,generation,read_model,raw)
    select 'hip4-portfolio-plan:' || sample_no,'mainnet',900000+sample_no,now(),$1,'{}'::jsonb,'{}'::jsonb from generate_series(1,10000) sample_no`,
    [randomUUID()],
  );
  await pool.query(
    "analyze users; analyze user_wallets; analyze hip4_account_snapshots; analyze hip4_read_markets",
  );
  const plans = [];
  for (const [name, sql, args] of [
    [
      "owned",
      HIP4_PORTFOLIO_ACCOUNTS_SQL,
      [ownerId, "mainnet", [address, missingAddress]],
    ],
    [
      "empty",
      HIP4_PORTFOLIO_ACCOUNTS_SQL,
      [randomUUID(), "mainnet", [otherAddress]],
    ],
    [
      "markets",
      HIP4_PORTFOLIO_MARKETS_SQL,
      ["mainnet", [mapped.market.marketId]],
    ],
  ] as const) {
    const plan = (
      await pool.query(`explain (analyze,buffers,format json) ${sql}`, [
        ...args,
      ])
    ).rows[0]["QUERY PLAN"][0];
    const serialized = JSON.stringify(plan);
    assert.match(serialized, /Index Scan|Index Only Scan|Bitmap Index Scan/);
    assert.ok(!serialized.includes('"Node Type":"Seq Scan"'), serialized);
    plans.push({
      name,
      ms: plan["Execution Time"],
      rows: plan.Plan["Actual Rows"],
      hitBlocks: plan.Plan["Shared Hit Blocks"],
    });
  }
  const client = pool;
  try {
    await client.query("set plan_cache_mode=force_generic_plan");
    await client.query(
      `prepare hip4_portfolio_lookup(uuid,text,text[]) as ${HIP4_PORTFOLIO_ACCOUNTS_SQL}`,
    );
    const plan = (
      await client.query(
        `explain (analyze,buffers,format json) execute hip4_portfolio_lookup('${ownerId}','mainnet',array['${address}'])`,
      )
    ).rows[0]["QUERY PLAN"][0];
    assert.ok(!JSON.stringify(plan).includes('"Node Type":"Seq Scan"'));
    plans.push({
      name: "generic",
      ms: plan["Execution Time"],
      rows: plan.Plan["Actual Rows"],
      hitBlocks: plan.Plan["Shared Hit Blocks"],
    });
  } finally {
    await client.query("deallocate hip4_portfolio_lookup");
  }
  console.log(
    "HIP Portfolio ownership, lifecycle, identities, freshness, zero snapshots and bounded lookup PASS",
    plans,
  );
} finally {
  await pool.query("rollback");
  pool.release();
  await target.end();
}
