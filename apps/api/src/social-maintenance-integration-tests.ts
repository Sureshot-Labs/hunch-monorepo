// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "@hunch/infra";
import { createIntegrationTestPool } from "./test-database-target.js";
import { backfillLegacySocialHandles } from "./services/social-handle-backfill.js";
import { resolveSocialPolicy } from "./services/social-policy.js";
import { protectedRefsSql } from "./market-retention-selector.js";
import { deleteHistoryOrder } from "./repos/orders-repo.js";
import { AuthService } from "./auth.js";

const pool = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=15000",
});
const client = await pool.connect();
let transactionDepth = 0;
const session = {
  query: async (text: string, values: unknown[] = []) => {
    if (text.toLowerCase() === "begin")
      return client.query(`savepoint maintenance_${++transactionDepth}`);
    if (text.toLowerCase() === "commit")
      return client.query(
        `release savepoint maintenance_${transactionDepth--}`,
      );
    if (text.toLowerCase() === "rollback")
      return client.query(
        `rollback to savepoint maintenance_${transactionDepth--}`,
      );
    return client.query(text, values);
  },
  release: () => {},
};
const db = {
  query: session.query,
  connect: async () => session,
} as unknown as Pool;
try {
  await client.query("begin");
  assert.equal(
    Math.floor(
      Number(
        (await client.query("show server_version_num")).rows[0]
          .server_version_num,
      ) / 10000,
    ),
    16,
  );
  // Temp policy/users isolate backfill from unrelated fixtures and prove future revisions are ignored.
  await client.query(
    "create temp table runtime_policies (policy_key text,payload jsonb,effective_at timestamptz,created_at timestamptz default now()) on commit drop",
  );
  await client.query(
    "insert into runtime_policies(policy_key,payload,effective_at) values('social','{\"repairBatchSize\":2}',now()-interval '1 minute'),('social','{\"minimumNotionalUsd\":\"99\"}',now()+interval '1 day')",
  );
  assert.equal(
    (await resolveSocialPolicy(db)).policy.minimumNotionalUsd,
    "10.00",
  );
  await client.query(
    "create temp table users (like public.users including defaults) on commit drop",
  );
  await client.query(
    "create unique index maintenance_handle_unique on users(lower(handle)) where handle is not null",
  );
  const userIds = Array.from({ length: 5 }, () => randomUUID()).sort();
  await client.query(
    "insert into users(id,username) values($1,'ValidName'),($2,'bad-name'),($3,'Duplicate'),($4,'duplicate'),($5,'secondvalid')",
    userIds,
  );
  const dry = await backfillLegacySocialHandles(db, {});
  assert.equal(dry.scanned, 2);
  assert.equal(dry.eligible, 1);
  assert.equal(dry.updated, 0);
  let afterId: string | undefined;
  let total = 0;
  do {
    const result = await backfillLegacySocialHandles(db, {
      afterId,
      execute: true,
    });
    total += result.updated;
    afterId = result.nextAfterId ?? undefined;
  } while (afterId);
  assert.equal(total, 2);
  assert.deepEqual(
    (
      await client.query("select username,handle from users order by id")
    ).rows.map((row) => row.handle),
    ["validname", null, null, null, "secondvalid"],
  );
  await client.query("drop table users");
  const owner = randomUUID(),
    source = randomUUID(),
    target = randomUUID(),
    thesis = randomUUID();
  const market = `maintenance:${randomUUID()}`,
    event = `maintenance-event:${randomUUID()}`,
    token = `maintenance-token:${randomUUID()}`;
  await client.query("insert into users(id) values($1)", [owner]);
  await client.query(
    "insert into unified_events(id,venue,venue_event_id,title,status) values($1,'limitless',$1,'Fixture','ACTIVE')",
    [event],
  );
  await client.query(
    "insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type,outcomes) values($1,'limitless',$1,$2,'Fixture','ACTIVE','binary','[\"Yes\",\"No\"]')",
    [market, event],
  );
  await client.query(
    "insert into orders(id,user_id,venue,venue_order_id,status,verified_buy_state,verified_buy_facts) values($1,$3,'limitless','history:maintenance','filled','verified','{\"canonicalPurchaseKey\":\"maintenance\"}'),($2,$3,'limitless','real:maintenance','filled','pending','{\"canonicalPurchaseKey\":\"maintenance\"}')",
    [source, target, owner],
  );
  await client.query(
    `insert into user_theses(id,author_id,canonical_purchase_key,order_id,market_id,event_id,token_id,outcome,instrument_generation,body,buy_snapshot,policy_revision,qualifying_notional,idempotency_key,payload_hash)
    values($1,$2,'maintenance',$3,$4,$5,$6,'YES','generation','fixture','{}','r1',10,'k1','h1')`,
    [thesis, owner, source, market, event, token],
  );
  await deleteHistoryOrder(db, {
    userId: owner,
    venue: "limitless",
    venueOrderId: "history:maintenance",
    replacementOrderId: target,
  });
  assert.equal(
    (
      await client.query("select order_id from user_theses where id=$1", [
        thesis,
      ])
    ).rows[0].order_id,
    source,
  );
  await client.query(
    "update orders set verified_buy_state='verified' where id=$1",
    [target],
  );
  await deleteHistoryOrder(db, {
    userId: owner,
    venue: "limitless",
    venueOrderId: "history:maintenance",
    replacementOrderId: target,
  });
  assert.equal(
    (
      await client.query("select order_id from user_theses where id=$1", [
        thesis,
      ])
    ).rows[0].order_id,
    target,
  );
  assert.equal(
    (await client.query("select id from orders where id=$1", [source])).rows
      .length,
    0,
  );
  await client.query(
    "create temp table maintenance_candidates(market_id text,event_id text,venue text) on commit drop",
  );
  await client.query(
    "create temp table maintenance_tokens(market_id text,token_id text) on commit drop",
  );
  await client.query(
    "insert into maintenance_candidates values($1,$2,'limitless')",
    [market, event],
  );
  await client.query("insert into maintenance_tokens values($1,$2)", [
    market,
    token,
  ]);
  const sql = protectedRefsSql("maintenance_candidates", "maintenance_tokens");
  const refs = await client.query(sql);
  for (const reason of [
    "user_theses_market",
    "user_theses_event",
    "user_theses_token",
  ])
    assert.ok(refs.rows.some((row) => row.reason === reason));
  await client.query(`explain (analyze,buffers,format json) ${sql}`);
  // Submission can exist only as a retained reference after a local persistence
  // failure. Account deletion must preserve that owner for observation repair.
  for (const state of ["pending", "confirmed"] as const) {
    const copier = randomUUID();
    await client.query(
      "insert into users(id,handle,bio) values($1,$2,'Private profile')",
      [copier, `copy_${copier.slice(0, 8)}`],
    );
    await client.query(
      `insert into copy_attributions(copier_user_id,source_thesis_id,source_snapshot,instrument,idempotency_key,payload_hash,prepared_fingerprint,provider_reference,state)
      values($1,$2,'{}','{}','copy-only','hash','fingerprint',$3,$4)`,
      [copier, thesis, `copy-only:${copier}`, state],
    );
    const deletion = await AuthService.deleteUser(copier, client);
    assert.equal(deletion.disposition, "deactivated");
    assert.equal(deletion.activeMovement, state === "pending");
    assert.ok(deletion.protectedReasons.includes("trading_evidence"));
    assert.equal(
      (
        await client.query(
          "select copier_user_id from copy_attributions where provider_reference=$1",
          [`copy-only:${copier}`],
        )
      ).rows[0].copier_user_id,
      copier,
    );
    const retained = (
      await client.query("select is_active,handle,bio from users where id=$1", [
        copier,
      ])
    ).rows[0];
    assert.deepEqual(retained, { is_active: false, handle: null, bio: null });
  }
  const emptyUser = randomUUID();
  await client.query("insert into users(id) values($1)", [emptyUser]);
  assert.equal(
    (await AuthService.deleteUser(emptyUser, client)).disposition,
    "hard_deleted",
  );
  await client.query("truncate maintenance_candidates,maintenance_tokens");
  assert.equal((await client.query(sql)).rows.length, 0);
  console.log(
    "Social maintenance PG16: policy time, paginated collision-safe handles, exact history aliases, retention full SQL and empty tail passed",
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
