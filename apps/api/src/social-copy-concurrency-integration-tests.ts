// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  copyPayloadHash,
  retainCopyBeforeSubmission,
} from "./services/social-copy.js";
import type { PreparedTrade } from "./services/trading-types.js";

const pool = await createIntegrationTestPool({
  max: 4,
  options: "-c statement_timeout=5000",
});
const owner = randomUUID();
const note = randomUUID();
const deletion = await pool.connect();
let retry: Promise<unknown> | undefined;
try {
  await pool.query("insert into users(id) values($1)", [owner]);
  await pool.query(
    `insert into ai_notes(id,note_key,note_type,title,description,source_kind,source_id,producer_type,producer_run_id)
    values($1,$2,'signal','Copy race fixture','Fixture','market',$2,'holder_research',$2)`,
    [note, `copy-race:${note}`],
  );
  const blocker = (await deletion.query("select pg_backend_pid() as pid"))
    .rows[0].pid as number;
  for (const existingFailed of [false, true]) {
    await pool.query("update users set is_active=true where id=$1", [owner]);
    const key = randomUUID();
    const prepared: PreparedTrade = {
      preparedId: key,
      venue: "limitless",
      quote: null,
      authorizationMode: "client_signed_order",
      authorizationRequests: [],
      reconcileKeys: {},
      expiresAt: null,
      venuePayload: {},
      intent: {
        actor: { kind: "web_app", userId: owner },
        venue: "limitless",
        sourceRef: { kind: "hunch", id: note },
        walletAddress: `0x${"1".repeat(40)}`,
        action: "BUY",
        outcome: "YES",
        amount: { type: "usd", value: "10" },
        idempotencyKey: key,
        target: {
          venue: "limitless",
          marketId: "copy-race",
          tokenId: "limitless:123",
          outcome: "YES",
          eventId: null,
          venueMarketId: null,
          title: null,
        },
      },
    };
    const input = {
      prepared,
      providerReference: `limitless:clob:8453:${key}`,
      preparedFingerprint: key,
      limitlessPositionContract: `0x${"2".repeat(40)}`,
    };
    if (existingFailed)
      await pool.query(
        `insert into copy_attributions
      (copier_user_id,source_ai_note_id,source_snapshot,instrument,idempotency_key,payload_hash,prepared_fingerprint,provider_reference,state)
      values($1,$2,'{}','{}',$3,$4,$3,$5,'failed')`,
        [owner, note, key, copyPayloadHash(prepared), input.providerReference],
      );
    await deletion.query("begin");
    // Same user-row critical section as deleteUser. Retain must wait and then
    // recheck activity, including an already-authenticated exact retry.
    await deletion.query("select id from users where id=$1 for update", [
      owner,
    ]);
    await deletion.query("update users set is_active=false where id=$1", [
      owner,
    ]);
    let settled = false;
    retry = retainCopyBeforeSubmission(pool, input).then(
      () => {
        settled = true;
        return "unexpected success";
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    let blocked = false;
    for (let attempt = 0; attempt < 200 && !settled; attempt++) {
      const observed = await pool.query(
        `select exists(select 1 from pg_stat_activity activity
        where activity.datname=current_database() and $1::int=any(pg_blocking_pids(activity.pid))) as blocked`,
        [blocker],
      );
      if (observed.rows[0].blocked) {
        blocked = true;
        break;
      }
      await delay(10);
    }
    assert.equal(
      blocked,
      true,
      "retention must serialize behind account deletion",
    );
    assert.equal(settled, false);
    await deletion.query("commit");
    const result = await retry;
    retry = undefined;
    assert.ok(result instanceof Error);
    assert.match(result.message, /social_account_unavailable/);
    const rows = await pool.query(
      "select state from copy_attributions where copier_user_id=$1 and idempotency_key=$2",
      [owner, key],
    );
    assert.deepEqual(
      rows.rows.map((row) => row.state),
      existingFailed ? ["failed"] : [],
    );
  }
  console.log(
    "Copy/delete PG16 concurrency: new authorization and exact failed retry cannot revive a deleted account",
  );
} finally {
  await deletion.query("rollback");
  await retry;
  deletion.release();
  await pool.query("delete from copy_attributions where copier_user_id=$1", [
    owner,
  ]);
  await pool.query("delete from ai_notes where id=$1", [note]);
  await pool.query("delete from users where id=$1", [owner]);
  await pool.end();
}
