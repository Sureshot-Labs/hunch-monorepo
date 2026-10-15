import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  fetchUnifiedOrders,
  fetchUnifiedOrderById,
} from "./repos/unified-orders.js";

// Explicit disposable transaction only. Preserve production indexes/types, not
// a toy table with a special test index. Shadow tables disappear on rollback.
export async function checkHip4NativeOrderReadPlans(
  db: PoolClient,
  input: {
    actionId: string;
    userId: string;
    address: string;
  },
) {
  for (const table of [
    "orders",
    "hip4_order_actions",
    "hip4_order_submissions",
  ])
    await db.query(
      `create temp table ${table}(like public.${table} including indexes including defaults) on commit drop`,
    );
  const foreignUserId = randomUUID();
  await db.query(
    `insert into orders(id,user_id,venue,wallet_address,signer_address,status,
    venue_order_id,token_id,side,order_type,price,size,filled_size,posted_at)
    select md5('read-order-'||entry)::uuid,case when entry<=5000 then $1::uuid else $2::uuid end,
      'hyperliquid',source_row.wallet_address,source_row.signer_address,
      'submitted',entry::text,source_row.token_id,'BUY','IOC',0.4,5,0,
      statement_timestamp()-entry*interval '1 second'
    from public.orders source_row cross join generate_series(1,50000) entry
    where source_row.id=(select order_id from public.hip4_order_actions where id=$3)`,
    [input.userId, foreignUserId, input.actionId],
  );
  await db.query(
    `insert into hip4_order_actions
    select md5('read-action-'||entry)::uuid,md5('read-order-'||entry)::uuid,md5('read-request-'||entry)::uuid,
      source_row.request_fingerprint,'order','mainnet',source_row.signer_address,source_row.canonical_market_id,source_row.token_id,
      '0x'||md5('read-cloid-'||entry),entry,source_row.action_fingerprint,source_row.unsigned_envelope,source_row.preparation_snapshot,'prepared',now()
    from public.hip4_order_actions source_row cross join generate_series(1,50000) entry where source_row.id=$1`,
    [input.actionId],
  );
  await db.query(`insert into hip4_order_submissions(action_id,signature_fingerprint,admission_snapshot,signer_address,state,order_observation)
    select id,action_fingerprint,'{}',signer_address,'reconcile_required',
      case when nonce=42 then null else jsonb_build_object('status','canceled','terminal',true,
        'balanceBarrier',jsonb_build_object('state','terminal_observed','responseAt',floor(extract(epoch from now())*1000)-1000)) end
    from hip4_order_actions`);
  for (const table of [
    "orders",
    "hip4_order_actions",
    "hip4_order_submissions",
  ])
    await db.query(`analyze ${table}`);
  await db.query("set local plan_cache_mode=force_generic_plan");
  const statements: Array<{ sql: string; args: unknown[] }> = [];
  const recorder = {
    query: async (sql: string, args: unknown[]) => {
      statements.push({ sql, args });
      return db.query(sql, args);
    },
  } as unknown as Pool;
  const base = {
    userId: input.userId,
    walletAddresses: [input.address],
    venue: "hyperliquid",
    limit: 30,
    offset: 0,
  };
  let planOrdinal = 0;
  // Parameters are generated synthetic test values, never credentials/requests.
  const literal = (value: unknown): string =>
    Array.isArray(value)
      ? `array[${value.map(literal).join(",")}]::text[]`
      : typeof value === "number"
        ? String(value)
        : `'${String(value).replaceAll("'", "''")}'`;
  const explain = async (label: string) => {
    for (const statement of statements.splice(0)) {
      const name = `native_read_plan_${++planOrdinal}`;
      await db.query(`prepare ${name} as ${statement.sql}`);
      const plan = (
        await db.query(
          `explain(analyze,buffers,format json) execute ${name}(${statement.args.map(literal).join(",")})`,
        )
      ).rows[0]["QUERY PLAN"][0];
      await db.query(`deallocate ${name}`);
      console.log(
        "[hip4-native-read-plan]",
        JSON.stringify({
          label,
          count: statement.sql.includes("count(*) as total"),
          ms: plan["Execution Time"],
          sharedBuffers: plan.Plan["Shared Hit Blocks"],
          localBuffers: plan.Plan["Local Hit Blocks"],
          rows: plan.Plan["Actual Rows"],
        }),
      );
      // Detect catastrophic fanout, not flaky timing gates. Owner/exact indexed
      // lookups may inspect history to compute an honest count.
      assert.ok(plan.Plan["Local Hit Blocks"] < 250000);
    }
  };
  for (const offset of [0, 30, 5000]) {
    const result = await fetchUnifiedOrders(recorder, { ...base, offset });
    assert.equal(result.total, 5000);
    assert.equal(result.rows.length, offset === 5000 ? 0 : 30);
    await explain(`page-${offset}`);
  }
  for (const [label, extra] of [
    ["sparse-open", { openOnly: true }],
    ["sparse-market", { marketId: "missing" }],
    ["empty-owner", { userId: randomUUID() }],
  ] as const) {
    const result = await fetchUnifiedOrders(recorder, { ...base, ...extra });
    assert.equal(result.total, label === "sparse-open" ? 1 : 0);
    await explain(label);
  }
  const id = (await db.query("select id from orders where venue_order_id='42'"))
    .rows[0].id;
  assert.ok(await fetchUnifiedOrderById(recorder, { ...base, id }));
  await explain("exact-detail");
  assert.equal(
    await fetchUnifiedOrderById(recorder, { ...base, id: randomUUID() }),
    null,
  );
  await explain("empty-detail");
  // 5k observed snapshot items overlapping native records: all duplicates are
  // removed before count/page. Missing executions remain unknown, not zero fills.
  const snapshot = (
    await db.query(
      "select history from hip4_account_snapshots where environment='mainnet' and account_address=$1",
      [input.address],
    )
  ).rows[0].history;
  const template = snapshot.openOrders.items[0];
  snapshot.openOrders.items = Array.from({ length: 5000 }, (_, index) => ({
    ...template,
    orderId: String(index + 1),
  }));
  await db.query(
    "update hip4_account_snapshots set history=$2 where environment='mainnet' and account_address=$1",
    [input.address, snapshot],
  );
  const mixed = await fetchUnifiedOrders(recorder, {
    ...base,
    openOnly: true,
    includeObservedHip4: true,
    hip4OpenOrderMaxAgeMs: 3_600_000,
  });
  assert.equal(mixed.total, 1);
  await explain("5000-overlapping-open");
}
