import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tx, type Pool, type PoolClient } from "@hunch/infra";
import { Interface } from "ethers";
import { RELAY_DEPOSITORY_V2 } from "../../funding-providers/relay/rehearsal.js";
import { withRelayClientSourceDebitPostcondition } from "../execution/relay-client-source-debit.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import { applyFundingStepReceiptEvidenceInTransaction } from "../persistence/funding-step-receipt-repository.js";
import type { NormalizedAction } from "../domain/types.js";
import type { relayExactRefundTestFixture } from "./relay-exact-refund-writer-pg.js";

/** Disposable PG fixture: ordinary source receipt writer, no transport. Shared
 * by paging/reorg and merge recovery tests so debit provenance stays identical. */
export async function recordRefundSourceDebitForTest(
  pool: Pool,
  settled: ReturnType<typeof relayExactRefundTestFixture>,
) {
  return recordRefundSourceActionForTest(pool, settled, "finalized");
}

/** The same valid frozen deposit action with no attempt is useful for true
 * negative-witness races. Missing/malformed actions are uncertainty, not a
 * substitute for proving no current source movement. */
export async function recordRefundSourceActionForTest(
  pool: Pool,
  settled: ReturnType<typeof relayExactRefundTestFixture>,
  phase: "unsubmitted" | "finalized",
) {
  const source = settled.base.source;
  const action: NormalizedAction = {
    kind: "evm_transaction",
    actionId: "pg-source:deposit",
    networkId: source.asset.networkId,
    senderWalletId: "offline-controller",
    to: RELAY_DEPOSITORY_V2,
    data: new Interface([
      "function depositErc20(address depositor,address token,uint256 amount,bytes32 id)",
    ]).encodeFunctionData("depositErc20", [
      source.details.address,
      source.asset.assetId,
      10000000n,
      settled.base.protocolOrderId,
    ]),
    valueRaw: "0",
    gasLimitRaw: null,
  };
  const stepId = randomUUID(),
    attemptId = randomUUID();
  const reservation = (
    await pool.query(
      "select id from balance_reservations where operation_id=$1 and economic_role='source_input'",
      [settled.base.operationId],
    )
  ).rows;
  assert.equal(reservation.length, 1);
  const settledIdentity = {
    userId: source.accountId,
    operationId: settled.base.operationId,
    segmentId: settled.base.segmentId,
    reservationId: reservation[0].id as string,
  };
  const transaction = (run: (db: PoolClient) => Promise<void>) => tx(pool, run);
  await transaction(async (db) => {
    await db.query("select id from funding_operations where id=$1 for update", [
      settledIdentity.operationId,
    ]);
    await db.query(
      `insert into funding_operation_steps
      (id,operation_id,segment_id,ordinal,step_kind,action_fingerprint,executor_id,payer_requirement,normalized_action,action_validation_result)
      values($1,$2,$3,0,'transaction',$4,'wallet_profile_evm_v1','user',$5,$6)`,
      [
        stepId,
        settledIdentity.operationId,
        settledIdentity.segmentId,
        canonicalJsonHash(action),
        action,
        withRelayClientSourceDebitPostcondition({
          action,
          routeId: "base-usdc-to-hypercore-spot-usdc",
          sourceAmount: { asset: source.asset, raw: "10000000" },
          actionValidationResult: {
            signerAddress: source.details.address,
            relayStepKind: "deposit",
            relayProtocolOrderId: settled.base.protocolOrderId,
          },
        }),
      ],
    );
    if (phase === "unsubmitted") return;
    await db.query(
      `insert into funding_operation_step_attempts
      (id,step_id,attempt_number,canonical_action_fingerprint,executor_id,
       broadcast_may_have_occurred,outcome,reference_kind,receipt_ref_ciphertext,receipt_ref_lookup_hmac,lookup_key_version,finished_at)
      values($1,$2,1,$3,'wallet_profile_evm_v1',true,'submitted','transaction','offline-receipt',$4,1,now())`,
      [
        attemptId,
        stepId,
        canonicalJsonHash(action),
        canonicalJsonHash(attemptId),
      ],
    );
    await applyFundingStepReceiptEvidenceInTransaction(db, {
      operationId: settledIdentity.operationId,
      stepId,
      attemptId,
      networkId: source.asset.networkId,
      now: settled.base.now,
      receipt: {
        status: "finalized",
        actionMatch: true,
        ledgerHeight: "123",
        blockHash: `0x${"fa".repeat(32)}`,
        canonical: true,
        failureCode: null,
        evidence: {
          transactionHash: `0x${canonicalJsonHash(attemptId)}`,
          attributedSourceRaw: "10000000",
          sourceDebitEventIndex: "7",
        },
      },
    });
  });
  return { settledIdentity, transaction };
}
