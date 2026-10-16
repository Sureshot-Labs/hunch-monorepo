import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { recordRelayExactRefundReceiptsInTransaction } from "../reconciliation/relay-exact-refund-receipts.js";
import { FUNDING_CURRENT_REFUND_FIRST_PAGE_SQL } from "../persistence/funding-operation-repository.js";
import { REFUND_OBSERVATION_FIRST_PAGE_SQL } from "../reconciliation/relay-refund-observation-scan.js";
import {
  REFUND_CANONICAL_PAGE_SQL,
  type RefundWatchRow,
} from "../reconciliation/relay-refund-canonical-watch.js";
import { persistRefundCanonicalProofsFixture as persistRefundCanonicalProofs } from "./refund-canonical-effects-fixture.js";
import { Interface } from "ethers";
import { RELAY_DEPOSITORY_V2 } from "../../funding-providers/relay/rehearsal.js";
import type { NormalizedAction } from "../domain/types.js";
import { withRelayClientSourceDebitPostcondition } from "../execution/relay-client-source-debit.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import { readRefundSourceActionPage } from "../reconciliation/relay-refund-source-action-scan.js";
import type { relayExactRefundTestFixture } from "./relay-exact-refund-writer-pg.js";
import { recordOwnedRouteCanonicalDestinationCredit } from "../reconciliation/owned-route-destination-observer.js";
import { hypercoreDestinationEvent } from "../../funding-providers/relay/hypercore-transfer-evidence.js";
import { HYPERCORE_MAINNET_USDC } from "../domain/hypercore-identity.js";
import { relayDestinationReferenceIdentity } from "../../funding-providers/relay/destination-reference.js";
import { recordRefundSourceDebitForTest } from "./refund-source-debit-fixture.js";

/** Real committed rows and out-of-transaction revision checks. Only invoked by
 * the explicit disposable PG16 suite; no network, keys or submitted actions. */
export async function verifyRefundSourceActionScanPg(
  pool: Pool,
  fixture: () => Promise<ReturnType<typeof relayExactRefundTestFixture>>,
) {
  const data = await fixture();
  const source = data.base.source;
  const abi = new Interface([
    "function depositErc20(address depositor,address token,uint256 amount,bytes32 id)",
    "function approve(address spender,uint256 amount)",
  ]);
  const actions: NormalizedAction[] = [
    {
      kind: "evm_transaction",
      actionId: "pg-source:approve",
      networkId: source.asset.networkId,
      senderWalletId: "offline-controller",
      to: source.asset.assetId,
      data: abi.encodeFunctionData("approve", [RELAY_DEPOSITORY_V2, 10000000n]),
      valueRaw: "0",
      gasLimitRaw: null,
    },
    {
      kind: "evm_transaction",
      actionId: "pg-source:deposit",
      networkId: source.asset.networkId,
      senderWalletId: "offline-controller",
      to: RELAY_DEPOSITORY_V2,
      data: abi.encodeFunctionData("depositErc20", [
        source.details.address,
        source.asset.assetId,
        10000000n,
        data.base.protocolOrderId,
      ]),
      valueRaw: "0",
      gasLimitRaw: null,
    },
  ];
  const stepIds = actions.map(() => randomUUID());
  for (const [ordinal, action] of actions.entries()) {
    const validation = withRelayClientSourceDebitPostcondition({
      action,
      routeId: "base-usdc-to-hypercore-spot-usdc",
      sourceAmount: { asset: source.asset, raw: "10000000" },
      actionValidationResult: {
        signerAddress: source.details.address,
        relayStepKind: ordinal === 0 ? "approve" : "deposit",
        relayProtocolOrderId: data.base.protocolOrderId,
      },
    });
    await pool.query(
      `insert into funding_operation_steps
      (id,operation_id,segment_id,ordinal,step_kind,action_fingerprint,executor_id,payer_requirement,
       normalized_action,action_validation_result)
      values($1,$2,$3,$4,'transaction',$5,'wallet_profile_evm_v1','user',$6,$7)`,
      [
        stepIds[ordinal],
        data.base.operationId,
        data.base.segmentId,
        ordinal,
        canonicalJsonHash(action),
        action,
        validation,
      ],
    );
  }
  const identity = {
    userId: source.accountId,
    operationId: data.base.operationId,
    segmentId: data.base.segmentId,
    reservationId: (
      await pool.query(
        "select id from balance_reservations where operation_id=$1 and economic_role='source_input'",
        [data.base.operationId],
      )
    ).rows[0].id as string,
  };
  const input = { identity, limit: 1 };
  const first = await readRefundSourceActionPage(pool, {
    ...input,
    continuation: null,
  });
  assert.equal(first.kind, "continuation");
  if (first.kind !== "continuation") assert.fail("expected approval page");
  assert.deepEqual(first.continuation.cursor, {
    stepOrdinal: 0,
    attemptNumber: 0,
  });
  // Round-trip represents crash/restart, without trusting earlier raw rows.
  const saved = JSON.parse(JSON.stringify(first.continuation));
  await pool.query(
    `update funding_operation_segments set support_metadata=support_metadata ||
    '{"exactRefundReceipts":{"checkedAt":"poll-only"}}' where id=$1`,
    [identity.segmentId],
  );
  const unstarted = await readRefundSourceActionPage(pool, {
    ...input,
    continuation: saved,
  });
  assert.equal(unstarted.kind, "complete");
  if (unstarted.kind !== "complete")
    assert.fail("expected unstarted complete scan");
  assert.deepEqual(unstarted.exposure, { kind: "no_live_attempt" });
  assert.equal(unstarted.facts.revision, first.continuation.facts.revision);
  const unstartedCovered = await readRefundSourceActionPage(pool, {
    ...input,
    continuation: null,
    completed: unstarted,
  });
  assert.equal(unstartedCovered.kind, "complete");
  if (unstartedCovered.kind !== "complete")
    assert.fail("expected empty leg coverage");
  assert.deepEqual(unstartedCovered.observations, { kind: "empty" });

  // Issuance between pages must invalidate the earlier approval page. Fifty
  // one attempts require multiple bounded passes; none may be hidden by latest.
  await pool.query(
    `insert into funding_operation_step_attempts
    (step_id,attempt_number,canonical_action_fingerprint,executor_id)
    select $1,attempt_number,$2,'wallet_profile_evm_v1' from generate_series(1,51) attempt_number`,
    [stepIds[1], canonicalJsonHash(actions[1])],
  );
  assert.deepEqual(
    await readRefundSourceActionPage(pool, { ...input, continuation: saved }),
    { kind: "restart" },
  );
  let result = await readRefundSourceActionPage(pool, {
    ...input,
    limit: 7,
    continuation: null,
  });
  let pages = 1;
  let checkpointBytes: number | null = null;
  while (result.kind === "continuation") {
    assert.ok(pages < 10, "bounded fixture must make forward progress");
    const checkpoint = JSON.parse(JSON.stringify(result.continuation));
    const bytes = JSON.stringify(checkpoint).length;
    if (checkpointBytes !== null)
      assert.ok(Math.abs(bytes - checkpointBytes) <= 1);
    checkpointBytes = bytes;
    result = await readRefundSourceActionPage(pool, {
      ...input,
      limit: 7,
      continuation: checkpoint,
    });
    pages++;
  }
  assert.equal(pages, 8);
  assert.equal(result.kind, "complete");
  if (result.kind !== "complete") assert.fail("expected issued scan complete");
  assert.deepEqual(result.exposure, {
    kind: "possible",
    stepIds: [stepIds[1]],
  });
  assert.equal(
    (
      await readRefundSourceActionPage(pool, {
        ...input,
        identity: { ...identity, userId: randomUUID() },
        continuation: null,
      })
    ).kind,
    "unavailable",
  );
  console.log(
    "PASS committed source-action continuation, polling, revision restart, dense attempts and owner scope",
  );
  // A separate committed leg exercises the same-revision action -> refund
  // continuation without mutating the dense fixture used by receive retries.
  const recordSource = (settled: Awaited<ReturnType<typeof fixture>>) =>
    recordRefundSourceDebitForTest(pool, settled);
  const settled = await fixture();
  const { settledIdentity, transaction } = await recordSource(settled);
  const scan = (completed?: unknown) =>
    readRefundSourceActionPage(pool, {
      identity: settledIdentity,
      continuation: null,
      completed,
      limit: 1,
    });
  const actionComplete = await scan();
  assert.equal(actionComplete.kind, "complete");
  if (actionComplete.kind !== "complete") assert.fail("expected exact debit");
  assert.equal(actionComplete.accounting.kind, "single_debit");
  assert.deepEqual(actionComplete.refundSet, { kind: "unchecked" });
  const absent = await scan(actionComplete);
  assert.equal(absent.kind, "complete");
  if (absent.kind !== "complete")
    assert.fail("expected no-refund pending state");
  assert.deepEqual(absent.refundSet, {
    kind: "pending",
    reason: "no_current_receipts",
  });
  const unsettled = await scan(absent);
  assert.equal(unsettled.kind, "complete");
  if (unsettled.kind !== "complete") assert.fail("expected unsettled leg");
  assert.deepEqual(unsettled.observations, {
    kind: "pending",
    reason: "incomplete_settlement",
  });
  assert.deepEqual(
    await scan(unsettled),
    unsettled,
    "unchanged pending state is cheap and reusable only at same revision",
  );
  await transaction(async (db) => {
    const result = await recordRelayExactRefundReceiptsInTransaction(db, {
      ...settled.base,
      evmEvents: [settled.evm[0]],
    });
    assert.equal(result.kind, "partial");
  });
  assert.deepEqual(
    await scan(absent),
    { kind: "restart" },
    "first refund invalidates no-receipt cache",
  );
  const partial = await scan(await scan());
  assert.equal(partial.kind, "complete");
  if (partial.kind !== "complete") assert.fail("expected partial receipt set");
  assert.deepEqual(partial.refundSet, {
    kind: "pending",
    reason: "proof_missing",
  });
  await transaction(async (db) => {
    const result = await recordRelayExactRefundReceiptsInTransaction(db, {
      ...settled.base,
      evmEvents: [settled.evm[1]],
    });
    assert.equal(result.kind, "complete");
  });
  assert.deepEqual(await scan(partial), { kind: "restart" });
  const currentActions = await scan();
  const firstRefund = await scan(currentActions);
  assert.equal(firstRefund.kind, "complete");
  if (firstRefund.kind !== "complete")
    assert.fail("expected first refund page");
  assert.equal(firstRefund.refundSet.kind, "reading");
  const persisted = JSON.parse(JSON.stringify(firstRefund));
  const completeSet = await scan(persisted);
  assert.equal(completeSet.kind, "complete");
  if (completeSet.kind !== "complete")
    assert.fail("expected complete current set");
  assert.equal(completeSet.refundSet.kind, "complete_refund_set");
  const cover = async (result: Awaited<ReturnType<typeof scan>>) => {
    let pages = 0;
    while (
      result.kind === "complete" &&
      ["unchecked", "reading"].includes(result.observations.kind)
    ) {
      assert.ok(pages++ < 10);
      result = await scan(JSON.parse(JSON.stringify(result)));
    }
    return result;
  };
  const covered = await cover(completeSet);
  assert.equal(covered.kind, "complete");
  if (covered.kind !== "complete") assert.fail("expected covered leg");
  assert.deepEqual(covered.observations, { kind: "refunded" });
  assert.deepEqual(await scan(covered), covered);
  const reorg = async () => {
    await pool.query(
      `update funding_observations set canonical=false,finality_status='reorged',reorged_at=now()
      where operation_id=$1 and segment_id=$2 and tx_hash=$3 and kind='refund_credit'`,
      [
        settledIdentity.operationId,
        settledIdentity.segmentId,
        settled.evm[0].transactionHash,
      ],
    );
  };
  // Real commit from another session after the page SELECT, before its closing
  // facts read. No uncommitted-writer or fixed-sleep race simulation.
  let changed = false;
  const raced = await readRefundSourceActionPage(
    {
      query: async (sql: string, args: unknown[]) => {
        const result = await pool.query(sql, args);
        if (sql === FUNDING_CURRENT_REFUND_FIRST_PAGE_SQL && !changed) {
          changed = true;
          await reorg();
        }
        return result;
      },
    } as never,
    {
      identity: settledIdentity,
      continuation: null,
      completed: currentActions,
      limit: 1,
    },
  );
  assert.equal(changed, true);
  assert.deepEqual(raced, { kind: "restart" });
  assert.deepEqual(await scan(persisted), { kind: "restart" });
  assert.deepEqual(await scan(completeSet), { kind: "restart" });
  assert.deepEqual(await scan(covered), { kind: "restart" });
  const afterReorg = await scan(await scan());
  assert.equal(afterReorg.kind, "complete");
  if (afterReorg.kind !== "complete") assert.fail("expected current remainder");
  assert.deepEqual(afterReorg.refundSet, {
    kind: "pending",
    reason: "proof_missing",
  });
  // Recover through the real watch writer, including its exact prior-anchor
  // audit required by the production observation immutability guard.
  await transaction(async (db) => {
    const { rows } = await db.query<RefundWatchRow>(REFUND_CANONICAL_PAGE_SQL, [
      settledIdentity.operationId,
      "00000000-0000-0000-0000-000000000000",
      2,
    ]);
    const row = rows.find(
      (item) =>
        JSON.parse(item.receipt_snapshot).tx_hash ===
        settled.evm[0].transactionHash,
    );
    assert.ok(row);
    const restored = await persistRefundCanonicalProofs(db, {
      operationId: settledIdentity.operationId,
      now: new Date(),
      rows: [
        {
          row,
          proof: {
            kind: "canonical",
            ledgerHeight: settled.evm[0].ledgerHeight,
            blockHash: settled.evm[0].blockHash,
          },
        },
      ],
    });
    assert.equal(restored.changed, 1);
  });
  assert.deepEqual(await scan(afterReorg), { kind: "restart" });
  const recovered = await scan(await scan(await scan()));
  assert.equal(recovered.kind, "complete");
  if (recovered.kind !== "complete")
    assert.fail("expected recovered current set");
  assert.equal(recovered.refundSet.kind, "complete_refund_set");
  const recoveredCoverage = await cover(recovered);
  assert.equal(recoveredCoverage.kind, "complete");
  if (recoveredCoverage.kind !== "complete")
    assert.fail("expected recovered leg coverage");
  assert.deepEqual(recoveredCoverage.observations, { kind: "refunded" });
  // Same committed race specifically inside the all-state observation page.
  let coverageChanged = false;
  const coverageRace = await readRefundSourceActionPage(
    {
      query: async (sql: string, args: unknown[]) => {
        const result = await pool.query(sql, args);
        if (sql === REFUND_OBSERVATION_FIRST_PAGE_SQL && !coverageChanged) {
          coverageChanged = true;
          await reorg();
        }
        return result;
      },
    } as never,
    {
      identity: settledIdentity,
      continuation: null,
      completed: recovered,
      limit: 1,
    },
  );
  assert.equal(coverageChanged, true);
  assert.deepEqual(coverageRace, { kind: "restart" });
  assert.deepEqual(await scan(recoveredCoverage), { kind: "restart" });
  console.log(
    "PASS committed debit/refund continuation, partial -> complete, concurrent revision restart, reorg and ordinary recovery",
  );
  const deliveredFixture = await fixture();
  const { settledIdentity: deliveredIdentity } =
    await recordSource(deliveredFixture);
  const scanDelivered = (completed?: unknown) =>
    readRefundSourceActionPage(pool, {
      identity: deliveredIdentity,
      continuation: null,
      completed,
      limit: 1,
    });
  const deliver = async (ordinal: number, rawAmount: string) => {
    const hash = `0x${canonicalJsonHash([deliveredIdentity, ordinal])}`;
    const event = hypercoreDestinationEvent(
      {
        networkId: HYPERCORE_MAINNET_USDC.networkId,
        asset: HYPERCORE_MAINNET_USDC,
        owner: String(deliveredFixture.base.source.details.address),
        direction: "credit",
        transactionHash: hash,
        nonce: ordinal,
        sourceAddress: `0x${"ab".repeat(20)}`,
        destinationAddress: String(
          deliveredFixture.base.source.details.address,
        ),
        sourceDex: "",
        destinationDex: "spot",
        rawAmount,
        ledgerTime: Date.now(),
        providerBlock: 123,
        evidenceFingerprint: canonicalJsonHash([hash, rawAmount]),
      },
      new Date(),
    );
    await transaction(async (db) => {
      await db.query(
        "select id from funding_operations where id=$1 for update",
        [deliveredIdentity.operationId],
      );
      await db.query(
        `update funding_operation_segments set support_metadata=jsonb_set(support_metadata,
        '{relaySuccessfulDestinationReferenceHashesV1}',
        coalesce(support_metadata->'relaySuccessfulDestinationReferenceHashesV1','[]'::jsonb) || $2::jsonb)
        where id=$1`,
        [
          deliveredIdentity.segmentId,
          JSON.stringify([relayDestinationReferenceIdentity(hash)]),
        ],
      );
      await recordOwnedRouteCanonicalDestinationCredit(db, {
        event,
        now: new Date(),
        match: {
          kind: "internal",
          operationId: deliveredIdentity.operationId,
          segmentId: deliveredIdentity.segmentId,
          transactionReferenceFingerprint: canonicalJsonHash(hash),
        },
      });
    });
    return hash;
  };
  const finishDelivery = async () => {
    let result = await scanDelivered();
    for (let pages = 0; pages < 10; pages++) {
      assert.equal(result.kind, "complete");
      if (result.kind !== "complete")
        assert.fail("expected delivered source scan");
      if (
        result.observations.kind !== "unchecked" &&
        result.observations.kind !== "reading"
      )
        return result;
      result = await scanDelivered(JSON.parse(JSON.stringify(result)));
    }
    assert.fail("delivery fixture must finish bounded pages");
  };
  await deliver(1, "400000000");
  const short = await finishDelivery();
  assert.deepEqual(short.observations, {
    kind: "pending",
    reason: "incomplete_settlement",
  });
  const finalHash = await deliver(2, "580000000");
  assert.deepEqual(await scanDelivered(short), { kind: "restart" });
  const delivered = await finishDelivery();
  assert.deepEqual(delivered.observations, { kind: "delivered" });
  assert.deepEqual(await scanDelivered(delivered), delivered);
  const legacyCompleted: Record<string, unknown> = {
    ...delivered,
    observations: { kind: "pending", reason: "incomplete_settlement" },
  };
  delete legacyCompleted.observationVersion;
  let upgraded = await scanDelivered(legacyCompleted);
  for (let pages = 0; pages < 5; pages++) {
    assert.equal(upgraded.kind, "complete");
    if (upgraded.kind !== "complete")
      assert.fail("expected component-only upgrade");
    assert.equal(upgraded.facts.revision, delivered.facts.revision);
    assert.deepEqual(upgraded.accounting, delivered.accounting);
    if (upgraded.observations.kind !== "reading") break;
    upgraded = await scanDelivered(upgraded);
  }
  assert.equal(upgraded.kind, "complete");
  if (upgraded.kind !== "complete") assert.fail("expected upgraded delivery");
  assert.deepEqual(upgraded.observations, { kind: "delivered" });
  await pool.query(
    `update funding_observations set canonical=false,finality_status='reorged',reorged_at=now()
    where operation_id=$1 and tx_hash=$2 and kind='destination_credit'`,
    [deliveredIdentity.operationId, finalHash],
  );
  assert.deepEqual(await scanDelivered(delivered), { kind: "restart" });
  assert.deepEqual((await finishDelivery()).observations, {
    kind: "pending",
    reason: "nonfinal_observation",
  });
  console.log(
    "PASS committed standard source/destination writers: split native delivery, minimum, revision restart and reorg invalidation",
  );
  return { data, identity, stepIds, actions };
}
