import assert from "node:assert/strict";
import type { PoolClient } from "@hunch/infra";
import { hypercoreSpotAccountLocation } from "./account-value/canonical.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import type { WalletExecutionProfile } from "./funding/domain/types.js";
import { loadHypercorePreparationAvailability } from "./funding/preparation/hypercore-availability.js";
import { readHip4OrderHoldRaw } from "./repos/hip4-order-holds.js";
import {
  HIP4_CLAIM_EXACT_ORDER_OBSERVATION_SQL,
  recordHip4OrderObservationInTransaction,
} from "./repos/hip4-order-observation.js";
import { fetchUserFinancialLifecycleSummary } from "./services/user-financial-lifecycle.js";

/** Uses a real admitted BUY and observer; every case is rolled back. Provider
 * bodies are synthetic. No live signing, balances, transfers or transactions. */
export async function testHip4OpenOrderHolds(
  db: PoolClient,
  input: {
    actionId: string;
    userId: string;
    profile: WalletExecutionProfile;
    feeCapRaw: string;
    response: (
      status?: string,
      stamp?: number,
    ) => {
      status: string;
      order: {
        status: string;
        statusTimestamp: number;
        order: { sz: string; origSz: string; coin: string };
      };
    };
  },
) {
  await db.query("savepoint open_order_inclusion");
  try {
    const { location } = hypercoreSpotAccountLocation({
      accountId: input.userId,
      address: input.profile.address,
      controllerWalletId: input.profile.walletId,
    });
    const native = (snapshotAt?: number) =>
      readHip4OrderHoldRaw(
        db,
        input.userId,
        input.profile.address,
        HYPERCORE_MAINNET_USDC.assetId,
        snapshotAt === undefined
          ? undefined
          : new Date(snapshotAt).toISOString(),
      );
    const common = async (snapshotAt: number) =>
      (
        await loadHypercorePreparationAvailability(db, {
          accountId: input.userId,
          location,
          observedAt: new Date(snapshotAt).toISOString(),
        })
      ).reservedRaw;
    const observe = async (body: unknown, responseAt: number) =>
      recordHip4OrderObservationInTransaction(db, {
        claim: (
          await db.query(HIP4_CLAIM_EXACT_ORDER_OBSERVATION_SQL, [
            input.actionId,
            60000,
            60000,
          ])
        ).rows[0],
        userId: input.userId,
        body,
        responseAt,
        maxRows: 100,
        retryMs: 60000,
      });
    const full = await native();
    assert.ok(full > BigInt(input.feeCapRaw));
    const firstAt = Date.now() - 20;
    assert.equal(
      await native(firstAt),
      full,
      "submission ACK alone grants no inclusion",
    );
    const partial = input.response();
    partial.order.order.sz = "1";
    assert.notEqual(partial.order.order.sz, partial.order.order.origSz);
    assert.equal(
      (await observe(partial, firstAt)).error,
      "account_history_unavailable",
    );
    assert.equal(
      await native(),
      full,
      "without a subsequent balance keep the whole debit",
    );
    assert.equal(await native(firstAt - 1), full);
    assert.equal(await native(firstAt), full);
    assert.equal(
      await native(firstAt + 1),
      BigInt(input.feeCapRaw),
      "provider balance/hold accounts for spent plus resting principal; fee remains reserved",
    );
    assert.equal(await common(firstAt), String(full));
    assert.equal(
      await common(firstAt + 1),
      input.feeCapRaw,
      "common funded-consumer hold is replaced, never duplicated",
    );
    // Shadow ONLY the immutable preparation table in this rollback scope:
    // exercise legacy/corrupt JSON without disabling production binding guards.
    await db.query("savepoint legacy_open_hold_facts");
    await db.query(
      "create temp table hip4_order_actions(like public.hip4_order_actions including indexes including defaults) on commit drop",
    );
    await db.query(
      "insert into hip4_order_actions select * from public.hip4_order_actions where id=$1",
      [input.actionId],
    );
    const frozen = (
      await db.query(
        "select preparation_snapshot from hip4_order_actions where id=$1",
        [input.actionId],
      )
    ).rows[0].preparation_snapshot;
    for (const fee of [
      null,
      -1,
      0,
      "",
      "-1",
      "1.2",
      "NaN",
      "0.0",
      "01",
      {},
      [],
      String(full + 1n),
    ]) {
      await db.query(
        "update hip4_order_actions set preparation_snapshot=$2 where id=$1",
        [
          input.actionId,
          {
            ...frozen,
            amounts: { ...frozen.amounts, feeCapRaw: fee },
          },
        ],
      );
      assert.equal(
        await native(firstAt + 1),
        full,
        `unknown/invalid fee stays reserved: ${JSON.stringify(fee)}`,
      );
      assert.equal(await common(firstAt + 1), String(full));
    }
    for (const patch of [
      { side: "SELL" },
      { debitAsset: "outcome" },
      { debitCapRaw: "1" },
    ]) {
      await db.query(
        "update hip4_order_actions set preparation_snapshot=$2 where id=$1",
        [
          input.actionId,
          {
            ...frozen,
            amounts: { ...frozen.amounts, ...patch, feeCapRaw: "0" },
          },
        ],
      );
      assert.equal(
        await native(firstAt + 1),
        full,
        "wrong frozen instrument/debit binding provides no inclusion credit",
      );
    }
    await db.query(
      "update hip4_order_actions set preparation_snapshot=$2 where id=$1",
      [
        input.actionId,
        {
          ...frozen,
          amounts: { ...frozen.amounts, feeCapRaw: "0" },
        },
      ],
    );
    assert.equal(
      await native(firstAt + 1),
      0n,
      "current zero-fee BUY has no extra local hold",
    );
    assert.equal(await common(firstAt + 1), "0");
    for (const proof of [
      null,
      { state: "accepted_observed", responseAt: "1" },
      { state: "accepted_observed", responseAt: -1 },
      { state: "accepted_observed", responseAt: 1.1 },
      { state: "accepted_observed", responseAt: Number.MAX_SAFE_INTEGER + 1 },
      { state: "accepted_observed", responseAt: firstAt + 10000 },
      { state: "invalidated", responseAt: 1 },
      { state: "terminal_observed", responseAt: 1 },
    ]) {
      await db.query(
        "update hip4_order_submissions set order_observation=jsonb_set(order_observation,'{balanceBarrier}',$2::jsonb) where action_id=$1",
        [input.actionId, JSON.stringify(proof)],
      );
      assert.equal(
        await native(firstAt + 1),
        full,
        "malformed or mismatching open proof cannot free principal",
      );
    }
    await db.query("rollback to savepoint legacy_open_hold_facts");
    assert.ok(
      (
        await fetchUserFinancialLifecycleSummary(db, [input.userId])
      ).activeReasons.includes("active_hip4_submission"),
      "inclusion is not a terminal order or account-deletion permission",
    );
    await observe(partial, firstAt + 2);
    assert.equal(
      await native(firstAt + 1),
      BigInt(input.feeCapRaw),
      "repeated open status does not move the barrier forever",
    );
    await observe({ status: "unknownOid" }, firstAt + 3);
    assert.equal(
      await common(firstAt + 1),
      input.feeCapRaw,
      "absence does not retract valid historical acceptance",
    );
    const conflict = structuredClone(partial);
    conflict.order.order.coin = "#14731";
    assert.equal(
      (await observe(conflict, firstAt + 4)).error,
      "order_identity_conflict",
    );
    assert.equal(await native(firstAt + 5), full);
    assert.equal(await common(firstAt + 5), String(full));
    await observe({ status: "unknownOid" }, firstAt + 6);
    assert.equal(
      await native(firstAt + 7),
      full,
      "unknown status cannot repair a contradiction",
    );
    await observe(partial, firstAt + 8);
    assert.equal(await native(firstAt + 7), full);
    assert.equal(
      await common(firstAt + 9),
      input.feeCapRaw,
      "ordinary exact read repairs inclusion without manual clearing",
    );
    await observe(
      input.response("canceled", partial.order.statusTimestamp + 100),
      firstAt + 10,
    );
    assert.equal(
      await native(firstAt + 9),
      full,
      "terminal transition needs a new subsequent balance",
    );
    assert.equal(
      await native(firstAt + 11),
      0n,
      "confirmed completion removes the residual fee hold too",
    );
    assert.equal(await common(firstAt + 11), "0");
  } finally {
    await db.query("rollback to savepoint open_order_inclusion");
  }
}
