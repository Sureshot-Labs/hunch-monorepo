// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createIntegrationTestPool } from "../../../test-database-target.js";
import { syncPendingDebridgeOrderStatus } from "../../../repos/bridge-orders.js";
import {
  claimLegacyDebridgeEvidence,
  recordLegacyDebridgeDestination,
} from "../../legacy/debridge-evidence-reconciler.js";

const db = await createIntegrationTestPool({
  max: 3,
  options: "-c statement_timeout=15000",
});
const created = await db.query<{ id: string }>(
  "insert into users (email, is_active, is_verified) values ($1, true, true) returning id",
  [`legacy-evidence-${randomUUID()}@example.com`],
);
const userId = created.rows[0]?.id;
assert.ok(userId);
try {
  // Historical shape: old quote ID and amount, metadata without owner fields.
  for (let index = 0; index < 6; index++)
    await db.query(
      `insert into bridge_orders (user_id, provider, swap_type, src_chain_id, dst_chain_id, src_token, dst_token, amount_in, order_id, tx_hash_src, status, adapter_version, metadata)
      values ($1, 'debridge', 'cross_chain', '137', '8453', $2, $3, '2000000', $4, $5, $7, 'debridge_dln_create_tx_v1', $6::jsonb)`,
      [
        userId,
        `0x${"1".repeat(40)}`,
        `0x${"2".repeat(40)}`,
        `0x${"d".repeat(64)}`,
        `0x${index.toString().repeat(64)}`,
        JSON.stringify({
          tx: {},
          tokenIn: { amount: "2000000", symbol: "USDC.e" },
          tokenOut: { amount: "2000000", symbol: "USDC" },
          estimation: {},
          ...(index === 0
            ? { legacyEvidenceRecovery: { nextAttemptAt: "malformed" } }
            : {}),
        }),
        index === 5 ? "fulfilled" : "submitted",
      ],
    );
  const now = new Date();
  const [left, right] = await Promise.all([
    claimLegacyDebridgeEvidence(db, now),
    claimLegacyDebridgeEvidence(db, now),
  ]);
  assert.equal(
    left.rows.length + right.rows.length,
    6,
    "bounded concurrent workers lease each legacy row once",
  );
  assert.ok(left.rows.length <= 4 && right.rows.length <= 4);
  assert.equal(
    new Set([...left.rows, ...right.rows].map((row) => row.id)).size,
    6,
  );
  assert.equal(
    (await claimLegacyDebridgeEvidence(db, now)).rows.length,
    0,
    "unknown evidence waits until the next bounded read",
  );
  const lease = left.rows.length ? left : right;
  const row = lease.rows[0];
  assert.ok(row);
  const proof = {
    orderId: `0x${"a".repeat(64)}`,
    txHash: `0x${"b".repeat(64)}`,
    chainId: "8453",
    token: row.dst_token,
    recipient: `0x${"3".repeat(40)}`,
    amountRaw: "1994268",
  };
  const input = {
    row,
    proof,
    leaseToken: lease.leaseToken,
    sourceAmount: "2278340",
    sender: `0x${"4".repeat(40)}`,
  };
  for (const corrupted of [
    { ...input, leaseToken: randomUUID() },
    { ...input, row: { ...row, user_id: randomUUID() } },
    { ...input, row: { ...row, tx_hash_src: `0x${"f".repeat(64)}` } },
    { ...input, row: { ...row, order_id: `0x${"e".repeat(64)}` } },
  ])
    assert.equal(await recordLegacyDebridgeDestination(db, corrupted), false);
  assert.equal(await recordLegacyDebridgeDestination(db, input), true);
  for (const status of ["submitted", "failed"] as const) {
    assert.equal(
      await syncPendingDebridgeOrderStatus(db, {
        operationId: row.id,
        userId,
        status,
        payload: { state: "Created" },
      }),
      false,
      "a stale UI response cannot downgrade a canonical completion",
    );
  }
  const pending = [...left.rows, ...right.rows].find(
    (candidate) => candidate.id !== row.id && candidate.status !== "fulfilled",
  );
  assert.ok(pending);
  assert.equal(
    await syncPendingDebridgeOrderStatus(db, {
      operationId: pending.id,
      userId: randomUUID(),
      status: "submitted",
    }),
    false,
    "provider sync retains the user ownership fence",
  );
  assert.equal(
    await syncPendingDebridgeOrderStatus(db, {
      operationId: pending.id,
      userId,
      status: "submitted",
      payload: { state: "Created" },
    }),
    true,
    "ordinary pending provider sync still works",
  );
  assert.equal(
    await recordLegacyDebridgeDestination(db, input),
    false,
    "terminal result is not rewritten by a stale worker",
  );
  const stored = await db.query<{
    status: string;
    order_id: string;
    metadata: {
      tokenIn: { amount: string; symbol: string };
      tokenOut: { amount: string; symbol: string };
      legacyEvidenceRecovery: {
        actualAmountRaw: string;
        actualSourceAmountRaw: string;
      };
    };
  }>("select status, order_id, metadata from bridge_orders where id = $1", [
    row.id,
  ]);
  assert.equal(stored.rows[0]?.status, "fulfilled");
  assert.equal(stored.rows[0]?.order_id, proof.orderId);
  assert.equal(
    stored.rows[0]?.metadata.legacyEvidenceRecovery.actualAmountRaw,
    "1994268",
  );
  assert.equal(
    stored.rows[0]?.metadata.legacyEvidenceRecovery.actualSourceAmountRaw,
    "2278340",
  );
  assert.equal(stored.rows[0]?.metadata.tokenIn.amount, "2278340");
  assert.equal(stored.rows[0]?.metadata.tokenOut.amount, "1994268");
  assert.equal(stored.rows[0]?.metadata.tokenOut.symbol, "USDC");
  assert.equal(
    (await claimLegacyDebridgeEvidence(db, new Date(now.getTime() + 300001)))
      .rows.length,
    4,
  );
  console.log(
    "[legacy-debridge-reconciliation-integration-tests] PostgreSQL leases, stale-result fencing, source identity and actual-amount persistence passed",
  );
} finally {
  await db.query("delete from bridge_orders where user_id = $1", [userId]);
  await db.query("delete from users where id = $1", [userId]);
  await db.end();
}
