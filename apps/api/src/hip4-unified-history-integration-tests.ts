// @requires-db
// Disposable PG16 only. All facts are synthetic and rolled back together.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createIntegrationTestPool } from "./test-database-target.js";
import { fetchUnifiedOrders, mapUnifiedOrder } from "./repos/unified-orders.js";
import { projectHip4Execution } from "./services/hip4-account-projection.js";
import { projectHip4OpenOrders } from "./services/hip4-open-orders.js";
import { hip4AccountProtectedRefsSql } from "./services/hip4-retention.js";

const pool = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=15000",
});
const db = await pool.connect();
const ownerId = randomUUID();
const address = `0x${randomUUID().replaceAll("-", "")}00000001`;
const foreignAddress = `0x${randomUUID().replaceAll("-", "")}00000002`;
const now = Date.now();
try {
  assert.equal(
    Math.floor(
      Number(
        (await db.query("show server_version_num")).rows[0].server_version_num,
      ) / 10000,
    ),
    16,
  );
  await db.query("begin");
  await db.query("insert into users(id,is_active) values($1,true)", [ownerId]);
  await db.query(
    "insert into user_wallets(user_id,wallet_address,wallet_type,is_verified) values($1,$2,'ethereum',true)",
    [ownerId, address],
  );
  await db.query(
    "insert into hip4_account_snapshots(environment,account_address) values('mainnet',$1),('mainnet',$2),('testnet',$1)",
    [address, foreignAddress],
  );
  const execution = projectHip4Execution("mainnet", address, {
    coin: "#87751",
    px: "0.12345678",
    sz: "12.34567",
    side: "B",
    time: now,
    startPosition: "0",
    dir: "Buy",
    closedPnl: "0",
    hash: `0x${"1".repeat(64)}`,
    oid: 1,
    crossed: true,
    fee: "-0.00000001",
    tid: 1,
    feeToken: "USDC",
  });
  await db.query(
    `insert into hip4_account_executions(environment,account_address,time_ms,coin,tid,oid,canonical_market_id,execution,fingerprint)
    select sample.environment,sample.address,$3::bigint-floor(series.ordinal_number/3)::bigint,'#87751',series.ordinal_number,1,'hyperliquid:mainnet:outcome:8775',
      $4::jsonb || jsonb_build_object('id',sample.address||'-'||lpad(series.ordinal_number::text,8,'0'), 'time',$3::bigint-floor(series.ordinal_number/3)::bigint,'tradeId',series.ordinal_number::text),
      'synthetic-'||series.ordinal_number::text
    from (values ('mainnet',$1::text,10000),('mainnet',$2::text,30000),('testnet',$1::text,100)) sample(environment,address,rows_count)
    cross join lateral generate_series(1,sample.rows_count) series(ordinal_number)`,
    [address, foreignAddress, now, JSON.stringify(execution)],
  );
  const legacyId = randomUUID();
  await db.query(
    `insert into orders(id,user_id,status,venue,venue_order_id,wallet_address,side,price,size,filled_size,average_fill_price,posted_at)
    values($1,$2,'filled','limitless','synthetic-legacy',$3,'BUY',0.5,2,2,0.5,to_timestamp($4::double precision/1000))`,
    [legacyId, ownerId, address, now + 1000],
  );
  await db.query("analyze hip4_account_executions");
  const inputs = {
    userId: ownerId,
    walletAddresses: [address, foreignAddress],
    includeObservedHip4: true,
    limit: 30,
    offset: 0,
  };
  const first = await fetchUnifiedOrders(db as unknown as Pool, inputs);
  assert.equal(first.total, 10001);
  assert.equal(first.rows[0].id, legacyId);
  const native = first.rows.find((row) => row.kind === "execution");
  assert.ok(native);
  const mapped = mapUnifiedOrder(native);
  assert.ok("execution" in mapped);
  assert.ok(mapped.execution);
  assert.equal(mapped.execution.fee, "-0.00000001");
  assert.equal(mapped.execution.grossNotional, execution.grossNotional);
  assert.equal(mapped.size, null);
  assert.equal(mapped.walletAddress, address);
  const next = await fetchUnifiedOrders(db as unknown as Pool, {
    ...inputs,
    offset: 30,
  });
  assert.ok(
    next.rows.every(
      (row) => !first.rows.some((earlier) => earlier.id === row.id),
    ),
  );
  assert.equal(
    (
      await fetchUnifiedOrders(db as unknown as Pool, {
        ...inputs,
        offset: 10001,
      })
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await fetchUnifiedOrders(db as unknown as Pool, {
        ...inputs,
        tokenId: "hyperliquid:mainnet:87750",
      })
    ).total,
    0,
  );
  assert.equal(
    (
      await fetchUnifiedOrders(db as unknown as Pool, {
        ...inputs,
        includeObservedHip4: false,
      })
    ).total,
    1,
  );
  assert.equal(
    (
      await fetchUnifiedOrders(db as unknown as Pool, {
        ...inputs,
        walletAddresses: [foreignAddress],
      })
    ).rows.length,
    0,
  );
  // Capture exact first/resumed/empty statements. Both custom and generic plans
  // run on PG, not string matching; report actual scan/buffer costs explicitly.
  let statement = "";
  let statementArgs: unknown[] = [];
  const recorder = {
    query: async (sql: string, args: unknown[]) => {
      if (sql.includes("limit $")) {
        statement = sql;
        statementArgs = args;
      }
      return db.query(sql, args);
    },
  } as unknown as Pool;
  for (const pageOffset of [0, 30, 10001]) {
    await fetchUnifiedOrders(recorder, {
      ...inputs,
      venue: "hyperliquid",
      offset: pageOffset,
    });
    const plan = (
      await db.query(
        `explain (analyze,buffers,format json) ${statement}`,
        statementArgs,
      )
    ).rows[0]["QUERY PLAN"][0];
    console.log(
      JSON.stringify({
        pageOffset,
        ms: plan["Execution Time"],
        buffers: plan.Plan["Shared Hit Blocks"],
        returned: plan.Plan["Actual Rows"],
      }),
    );
  }
  await db.query("set local plan_cache_mode=force_generic_plan");
  await db.query(
    `prepare hip4_history_page(uuid,text[],text,integer,integer) as ${statement}`,
  );
  const generic = await db.query(
    `explain (analyze,buffers,format json) execute hip4_history_page('${ownerId}',array['${address}'],'hyperliquid',30,0)`,
  );
  assert.equal(generic.rows[0]["QUERY PLAN"][0].Plan["Actual Rows"], 30);
  await db.query("deallocate hip4_history_page");
  const currentOrders = projectHip4OpenOrders(
    "mainnet",
    Array.from({ length: 5000 }, (_, index) => ({
      coin: "#87751",
      oid: index + 1,
      side: "B",
      limitPx: "0.4",
      sz: "3",
      origSz: "5",
      timestamp: now - Math.floor(index / 3),
      orderType: "Limit",
      isTrigger: false,
      reduceOnly: false,
    })),
    now,
  );
  await db.query(
    "update hip4_account_snapshots set history=$2 where account_address=any($1::text[])",
    [[address, foreignAddress], { openOrders: currentOrders }],
  );
  const orderInput = {
    ...inputs,
    venue: "hyperliquid",
    type: "order" as const,
    openOnly: true,
    hip4OpenOrderMaxAgeMs: 3_600_000,
  };
  const ordersFirst = await fetchUnifiedOrders(recorder, orderInput);
  assert.equal(ordersFirst.total, 5000);
  assert.equal(ordersFirst.rows.length, 30);
  assert.ok(ordersFirst.rows.every((row) => row.wallet_address === address));
  const ordersNext = await fetchUnifiedOrders(recorder, {
    ...orderInput,
    offset: 30,
  });
  assert.ok(
    ordersNext.rows.every(
      (row) => !ordersFirst.rows.some((first) => first.id === row.id),
    ),
  );
  assert.equal(
    (await fetchUnifiedOrders(recorder, { ...orderInput, offset: 5000 })).rows
      .length,
    0,
  );
  const openPlan = (
    await db.query(
      `explain (analyze,buffers,format json) ${statement}`,
      statementArgs,
    )
  ).rows[0]["QUERY PLAN"][0];
  console.log(
    JSON.stringify({
      openOrders: 5000,
      emptyPageMs: openPlan["Execution Time"],
      buffers: openPlan.Plan["Shared Hit Blocks"],
    }),
  );
  await db.query(
    `prepare hip4_open_page(uuid,text[],text,integer,integer,integer) as ${statement}`,
  );
  const openGeneric = await db.query(
    `explain (analyze,buffers,format json) execute hip4_open_page('${ownerId}',array['${address}'],'hyperliquid',3600000,30,0)`,
  );
  assert.equal(openGeneric.rows[0]["QUERY PLAN"][0].Plan["Actual Rows"], 30);
  await db.query("deallocate hip4_open_page");
  assert.equal(
    (
      await fetchUnifiedOrders(recorder, {
        ...orderInput,
        tokenId: "hyperliquid:mainnet:87750",
      })
    ).total,
    0,
  );
  await db.query(
    "create temporary table hip4_open_retention_candidates(market_id text) on commit drop",
  );
  await db.query(
    "insert into hip4_open_retention_candidates values('hyperliquid:mainnet:outcome:8775')",
  );
  const protectedRefs = await db.query(
    hip4AccountProtectedRefsSql("hip4_open_retention_candidates"),
  );
  assert.ok(
    protectedRefs.rows.some((row) => row.reason === "hip4_account_open_orders"),
  );
  await db.query("update user_wallets set is_verified=false where user_id=$1", [
    ownerId,
  ]);
  assert.equal(
    (
      await fetchUnifiedOrders(db as unknown as Pool, {
        ...inputs,
        venue: "hyperliquid",
      })
    ).total,
    0,
  );
  assert.equal(
    (await fetchUnifiedOrders(db as unknown as Pool, orderInput)).total,
    0,
  );
  console.log(
    "HIP shared History PG16 mixed legacy/native, exact decimals, tied times, ownership, testnet, custom/generic plans PASS",
  );
} finally {
  await db.query("rollback");
  db.release();
  await pool.end();
}
