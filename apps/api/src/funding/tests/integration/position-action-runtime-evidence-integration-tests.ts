// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ethers } from "ethers";
import { createIntegrationTestPool } from "../../../test-database-target.js";
import { PositionActionRuntimeService } from "../../position-actions/runtime-service.js";
import {
  claimPositionActionSubmission,
  createOrReplayPositionAction,
  fetchPositionActionForUser,
  recordPositionActionSubmission,
  type StoredPositionAction,
} from "../../position-actions/position-action-repository.js";
import { CANONICAL_CTF_ABI } from "../../position-actions/canonical-redemption-evidence.js";
import {
  createEvmPositionActionReceiptObserver,
  type PositionActionVenueDriver,
} from "../../position-actions/venue-driver.js";
import { buildReadyRedemptionPlan } from "../../../services/redemption-plan.js";

const pool = await createIntegrationTestPool({
  max: 2,
  options: "-c statement_timeout=15000",
});
const userId = randomUUID();
const owner = "0x0000000000000000000000000000000000000017";
const ctf = "0x00000000000000000000000000000000000000c7";
const collateral = "0x00000000000000000000000000000000000000c1";
const hash = `0x${"e".repeat(64)}`;
const raw = 1_000_000n;
const actions: StoredPositionAction[] = [];
const originalReceipt = ethers.JsonRpcProvider.prototype.getTransactionReceipt;
const originalFetch = globalThis.fetch;
const event = (name: string, values: unknown[]) => ({
  address: ctf,
  ...CANONICAL_CTF_ABI.encodeEventLog(name, values),
});
const transferAbi = new ethers.Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const credit = (value: bigint) => ({
  address: collateral,
  ...transferAbi.encodeEventLog("Transfer", [ctf, owner, value]),
});
const burn = (token: string, amount = raw) =>
  event("TransferSingle", [
    owner,
    owner,
    ethers.ZeroAddress,
    BigInt(token),
    amount,
  ]);
const payout = (token: string, value: bigint) =>
  event("PayoutRedemption", [
    owner,
    collateral,
    ethers.ZeroHash,
    ethers.id(`runtime-condition-${token}`),
    [1],
    value,
  ]);
let logs = [burn("17"), payout("17", raw), payout("70", 0n), credit(raw)];
const unused = (): never => {
  throw new Error("Unexpected preparation in receipt-only fixture");
};
const driver: PositionActionVenueDriver = {
  adapterId: "fixture-ctf",
  venueId: "limitless",
  buildMarketContext: unused,
  buildPlan: async () => unused(),
  inspectOperatorApproval: async () => unused(),
  resolveExecutionProfile: unused,
  conditionalTokensAddress: () => ctf,
  observeReceipt: createEvmPositionActionReceiptObserver(8453),
  refreshPositions: async () => {}, // Canonical refresh already flattened both positions.
};
const runtime = new PositionActionRuntimeService(
  pool,
  () => new Date(),
  [driver],
  null,
);
try {
  await pool.query(
    "insert into users (id, email, is_active, is_verified) values ($1, $2, true, true)",
    [userId, `redemption-runtime-${userId}@example.com`],
  );
  for (const token of ["17", "70"]) {
    const position = (
      await pool.query<{ id: string }>(
        `insert into positions (user_id, venue, token_id, wallet_address, side, size)
       values ($1, 'limitless', $2, $3, 'FLAT', 0) returning id`,
        [userId, `limitless:${token}`, owner],
      )
    ).rows[0];
    assert.ok(position);
    const plan = buildReadyRedemptionPlan({
      venue: "limitless",
      chainId: 8453,
      targetAddress: ctf,
      data: CANONICAL_CTF_ABI.encodeFunctionData("redeemPositions", [
        collateral,
        ethers.ZeroHash,
        ethers.id(`runtime-condition-${token}`),
        [1],
      ]),
      payoutTokenAddress: collateral,
      expectedPayoutRaw: raw.toString(),
      yesBalanceRaw: raw.toString(),
      noBalanceRaw: "0",
    });
    const created = await createOrReplayPositionAction(pool, {
      userId,
      marketId: null,
      venueId: "limitless",
      action: "redeem",
      positionRef: position.id,
      ownerBindingId: `owner-binding-${token}-12345678`,
      ownerAddress: owner,
      executionWalletId: "owned-runtime-wallet",
      executionAddress: owner,
      executionMode: "privy_authorization",
      inspectionRevision: `inspection-runtime-${token}-12345678`,
      actionDigest: ethers.id(`runtime-${token}`).slice(2),
      idempotencyKey: randomUUID(),
      status: "awaiting_user",
      planSnapshot: {
        tokenId: `limitless:${token}`,
        outcome: "YES",
        plan: JSON.parse(JSON.stringify(plan)),
      },
      evidenceSnapshot: {},
      normalizedActions: [],
      postconditions: [],
    });
    actions.push(created.operation);
    await claimPositionActionSubmission(pool, {
      userId,
      operationId: created.operation.id,
      canonicalActionFingerprint: "a".repeat(64),
      executorId: "privy-authorization-evm-v1",
      embeddedDispatchProtocol: "privy_position_v1",
    });
    await recordPositionActionSubmission(pool, {
      userId,
      operationId: created.operation.id,
      attemptNumber: 1,
      outcome: "submitted",
      submissionFingerprint: hash,
    });
  }
  globalThis.fetch = async () => {
    throw new Error("Network forbidden in runtime fixture");
  };
  ethers.JsonRpcProvider.prototype.getTransactionReceipt = async () =>
    ({
      status: 1,
      blockNumber: 100,
      hash,
      logs,
    }) as unknown as ethers.TransactionReceipt;
  const [first, second] = actions;
  assert.ok(first && second);
  assert.equal((await runtime.reconcile(userId, first.id)).status, "completed");
  assert.equal(
    (await runtime.reconcile(userId, second.id)).status,
    "reconcile_required",
    "a flat position plus another action's credit cannot prove this redemption",
  );
  const effects = await pool.query<{
    action_operation_id: string;
    evidence: { actualPayoutRaw?: string };
  }>(
    `select action_operation_id, evidence from position_action_effects
     where action_operation_id = any($1::uuid[]) and effect_kind = 'collateral_refresh'
       and status = 'completed'`,
    [actions.map((action) => action.id)],
  );
  assert.equal(effects.rows.length, 1);
  assert.equal(effects.rows[0]?.action_operation_id, first.id);
  assert.equal(effects.rows[0]?.evidence.actualPayoutRaw, "1000000");
  assert.equal(
    (
      await pool.query("select id from notifications where user_id = $1", [
        userId,
      ])
    ).rows.length,
    1,
  );
  // Old deployment inserted its legacy row, then crashed before completing
  // the effect. Concurrent rollout recovery must reuse that exact row.
  await pool.query(
    "update notifications set dedupe_key = $2 where user_id = $1",
    [userId, `redemption:${hash}`],
  );
  await pool.query(
    `update position_action_effects set status = 'pending', completed_at = null
    where action_operation_id = $1 and effect_kind = 'notification'`,
    [first.id],
  );
  await Promise.all([
    runtime.reconcile(userId, first.id),
    runtime.reconcile(userId, first.id),
  ]);
  assert.equal(
    (
      await pool.query("select id from notifications where user_id = $1", [
        userId,
      ])
    ).rows.length,
    1,
    "legacy crash-window recovery cannot insert a second notification",
  );
  assert.equal(
    (
      await pool.query<{ status: string }>(
        `select status from position_action_effects
    where action_operation_id = $1 and effect_kind = 'notification'`,
        [first.id],
      )
    ).rows[0]?.status,
    "completed",
  );
  logs = [
    burn("17"),
    payout("17", raw),
    burn("70", raw * 2n),
    payout("70", raw * 2n),
    credit(raw * 3n),
  ];
  assert.equal(
    (await runtime.reconcile(userId, second.id)).status,
    "completed",
  );
  assert.equal((await runtime.reconcile(userId, first.id)).status, "completed");
  assert.equal(
    (
      await pool.query("select id from notifications where user_id = $1", [
        userId,
      ])
    ).rows.length,
    2,
    "valid distinct bundled payouts notify once per action, even after a replay",
  );
  assert.equal(
    (
      await fetchPositionActionForUser(pool, {
        userId,
        operationId: second.id,
      })
    )?.status,
    "completed",
  );
  const secondPayout = await pool.query<{ actual: string; amount: string }>(
    `select collateral_effect.evidence->>'actualPayoutRaw' as actual, notification_row.data->>'amountUsd' as amount
      from position_action_effects collateral_effect join notifications notification_row on notification_row.user_id = $2
      and notification_row.dedupe_key = $3 where collateral_effect.action_operation_id = $1 and collateral_effect.effect_kind = 'collateral_refresh'`,
    [second.id, userId, `redemption:position-action:${second.id}`],
  );
  assert.equal(secondPayout.rows[0]?.actual, "2000000");
  assert.equal(
    Number(secondPayout.rows[0]?.amount),
    2,
    "accounting and notification use actual verified payout for additional shares",
  );
  console.log(
    "[position-action-runtime-evidence-integration-tests] PostgreSQL + real observer + runtime: exact bundle attribution, flat-position negative, valid payouts and notification replay passed",
  );
} finally {
  ethers.JsonRpcProvider.prototype.getTransactionReceipt = originalReceipt;
  globalThis.fetch = originalFetch;
  const ids = actions.map((action) => action.id);
  await pool.query(
    "delete from position_action_effects where action_operation_id = any($1::uuid[])",
    [ids],
  );
  await pool.query(
    "delete from position_action_attempts where action_operation_id = any($1::uuid[])",
    [ids],
  );
  await pool.query(
    "delete from position_action_operations where id = any($1::uuid[])",
    [ids],
  );
  await pool.query("delete from positions where user_id = $1", [userId]);
  await pool.query("delete from notifications where user_id = $1", [userId]);
  await pool.query("delete from users where id = $1", [userId]);
  await pool.end();
}
