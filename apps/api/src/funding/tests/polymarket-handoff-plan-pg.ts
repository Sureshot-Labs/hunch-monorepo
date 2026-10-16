import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  canonicalLocationKey,
  stableOpaqueId,
} from "../../account-value/canonical.js";
import { buildPolymarketPreRouteHandoffSteps } from "../../funding-providers/relay/operation-plan.js";
import { polymarketHandoffSourceIntent } from "../domain/polymarket-handoff-source.js";
import {
  readFrozenPolymarketHandoffBinding,
  readFinalizedPolymarketHandoffReceipt,
} from "../domain/polymarket-handoff-binding.js";
import type { AssetLocation, WalletExecutionProfile } from "../domain/types.js";
import type {
  FundingCommitPlan,
  FundingOperationRow,
} from "../persistence/funding-operation-repository.js";
import {
  startFundingStepAttemptInTransaction,
  finishFundingStepAttemptInTransaction,
  recordSafeFundingActionCancellationsInTransaction,
} from "../persistence/funding-evidence-repository.js";
import { reduceFundingOperationInTransaction } from "../reconciliation/funding-reducer.js";
import { polymarketNativeHandoffReservationPendingSql } from "../persistence/source-reservation-hold.js";
import {
  applyFundingStepReceiptEvidenceInTransaction,
  type FundingStepReceiptObservation,
} from "../persistence/funding-step-receipt-repository.js";
import type { CanonicalEventOwnershipRow } from "../persistence/canonical-event-lock-sql.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import {
  loadFrozenPolymarketHandoffBinding,
  POLYMARKET_HANDOFF_BINDING_SQL,
} from "../persistence/polymarket-handoff-binding-repository.js";
import { verifyHandoffBindingLookupPlans } from "./polymarket-handoff-binding-plans-pg.js";
import {
  loadFundingHandoffSnapshotFacts,
  FUNDING_HANDOFF_SNAPSHOT_TAIL_SQL,
} from "../../account-value/funding-handoff-snapshots.js";
import {
  applyFundingSourceDebitSuppression,
  fundingInvalidSourceComponentIds,
  loadFundingAccountValueFacts,
  loadFundingSnapshotDebits,
} from "../../account-value/funding-movement-feed.js";
import type { ValuedAssetComponent } from "../domain/types.js";

/** Existing normalized pUSD inbound wire/Relay actions, new economic source
 * topology. All effects roll back. No provider, signer or wallet is invoked. */
export async function verifyPolymarketHandoffPlanPg(
  db: PoolClient,
  input: {
    userId: string;
    basePlan: FundingCommitPlan;
    now: Date;
    commit: (
      userId: string,
      plan: FundingCommitPlan,
    ) => Promise<{ operation: FundingOperationRow }>;
  },
) {
  await db.query("savepoint polymarket_handoff_plan");
  try {
    const profile = input.basePlan.operation
      .walletExecutionSnapshot as unknown as WalletExecutionProfile;
    const source = input.basePlan.segments[0].sourceSnapshot
      .location as unknown as AssetLocation;
    const economicSource: AssetLocation = {
      kind: "venue_account",
      accountId: input.userId,
      locationId: randomUUID(),
      asset: source.asset,
      details: {
        address: `0x${"ad".repeat(20)}`,
        linkedAddress: profile.address,
        venueId: "polymarket",
        balanceClass: "polymarket",
        polymarketFunderKind: "deposit_wallet",
      },
    };
    const intent = polymarketHandoffSourceIntent({
      economicLocation: economicSource,
      controllerProfile: profile,
    });
    assert.ok(intent);
    const raw = String(input.basePlan.segments[0].quotedInput.raw);
    const sourceReservation = {
      ...input.basePlan.reservations[0],
      componentId: stableOpaqueId(
        "asset",
        canonicalLocationKey(economicSource),
      ),
      locationId: economicSource.locationId,
    };
    const plan: FundingCommitPlan = {
      ...input.basePlan,
      operation: {
        ...input.basePlan.operation,
        sourceSnapshot: {
          kind: "owned_location",
          location: economicSource as never,
        },
      },
      segments: input.basePlan.segments.map((segment) => ({
        ...segment,
        sourceSnapshot: intent.executionSource as never,
        refundLocationSnapshot: {
          ...segment.refundLocationSnapshot,
          ...intent.executionSource.location,
        } as never,
      })),
      steps: buildPolymarketPreRouteHandoffSteps({
        source: {
          preRouteHandoff: {
            kind: "polymarket_deposit_wallet_to_controller_v1",
            sourceLocation: economicSource,
            funderAddress: String(economicSource.details.address),
            controllerAddress: profile.address,
            tokenAddress: economicSource.asset.assetId,
          },
        },
        sourceAmount: { asset: economicSource.asset, raw },
        profile,
        steps: input.basePlan.steps,
      }),
      reservations: [
        sourceReservation,
        {
          ...sourceReservation,
          segmentOrdinal: null,
          componentId: intent.controllerComponentId,
          locationId: intent.executionSource.location.locationId,
          economicRole: "future_credit_fence",
        },
      ],
    };
    const binding = readFrozenPolymarketHandoffBinding({
      currentUserId: input.userId,
      plan,
      segmentOrdinal: 0,
    });
    assert.ok(binding);
    const committed = await input.commit(input.userId, plan);
    const operationId = committed.operation.id;
    await db.query(
      "select funding_validate_operation_segment_shape($1::uuid)",
      [operationId],
    );
    const stored = (
      await db.query(
        "select source_snapshot,wallet_execution_snapshot from funding_operations where id=$1",
        [operationId],
      )
    ).rows[0];
    assert.deepEqual(stored.source_snapshot, plan.operation.sourceSnapshot);
    assert.deepEqual(
      stored.wallet_execution_snapshot,
      plan.operation.walletExecutionSnapshot,
    );
    const reservations = (
      await db.query(
        "select id,segment_id,economic_role,location_id,raw_amount::text from balance_reservations where operation_id=$1 order by economic_role",
        [operationId],
      )
    ).rows;
    assert.equal(reservations.length, 2);
    assert.equal(
      reservations.find((row) => row.economic_role === "future_credit_fence")
        .segment_id,
      null,
    );
    assert.equal(
      reservations.find((row) => row.economic_role === "source_input")
        .location_id,
      economicSource.locationId,
    );
    const sourceRow = reservations.find(
      (row) => row.economic_role === "source_input",
    );
    assert.ok(sourceRow);
    const scope = {
      userId: input.userId,
      operationId,
      segmentId: String(sourceRow.segment_id),
      sourceReservationId: String(sourceRow.id),
    };
    const storedBinding = await loadFrozenPolymarketHandoffBinding(db, scope);
    assert.ok(storedBinding);
    assert.deepEqual(storedBinding.binding, binding);
    assert.equal(
      await loadFrozenPolymarketHandoffBinding(db, {
        ...scope,
        userId: randomUUID(),
      }),
      null,
    );
    assert.equal(
      await loadFrozenPolymarketHandoffBinding(db, {
        ...scope,
        segmentId: randomUUID(),
      }),
      null,
    );
    assert.equal(
      await loadFrozenPolymarketHandoffBinding(db, {
        ...scope,
        sourceReservationId: randomUUID(),
      }),
      null,
    );
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await db.query(`set local plan_cache_mode=${mode}`);
      for (const sourceReservationId of [
        scope.sourceReservationId,
        randomUUID(),
      ]) {
        const explained = (
          await db.query(
            `explain (analyze,buffers,format json) ${POLYMARKET_HANDOFF_BINDING_SQL}`,
            [
              scope.userId,
              scope.operationId,
              scope.segmentId,
              sourceReservationId,
            ],
          )
        ).rows[0]["QUERY PLAN"][0];
        console.log(
          "[handoff-binding-plan]",
          JSON.stringify({
            mode,
            hit: sourceReservationId === scope.sourceReservationId,
            ms: explained["Execution Time"],
            buffers: explained.Plan["Shared Hit Blocks"],
          }),
        );
      }
    }
    const step = (
      await db.query(
        "select id from funding_operation_steps where operation_id=$1 and ordinal=0",
        [operationId],
      )
    ).rows[0];
    const attempt = await startFundingStepAttemptInTransaction(db, {
      operationId,
      stepId: step.id,
      canonicalActionFingerprint: plan.steps[0].actionFingerprint,
      executorId: plan.steps[0].executorId,
      now: input.now,
    });
    const transactionHash = `0x${canonicalJsonHash([operationId, "handoff"])}`,
      blockHash = `0x${"bd".repeat(32)}`;
    await finishFundingStepAttemptInTransaction(db, {
      attemptId: attempt.id,
      outcome: "submitted",
      broadcastMayHaveOccurred: true,
      referenceKind: "transaction",
      receiptRefCiphertext: "cipher:offline-handoff-only",
      receiptRefLookupHmac: canonicalJsonHash(transactionHash),
      lookupKeyVersion: 1,
      actualCosts: {},
      now: input.now,
    });
    await db.query(
      "update funding_operation_steps set state='submitted' where id=$1",
      [step.id],
    );
    await applyFundingStepReceiptEvidenceInTransaction(db, {
      operationId,
      stepId: step.id,
      attemptId: attempt.id,
      networkId: "evm:137",
      receipt: {
        status: "confirmed",
        actionMatch: true,
        ledgerHeight: "1234",
        blockHash,
        canonical: true,
        failureCode: null,
        evidence: {
          transactionHash,
          handoffEventIndex: "3",
          polymarketHandoffReadV1: {
            sourceAddress: "untrusted-transport-hint",
          },
        },
      },
      now: input.now,
    });
    const pendingHolds = (
      await db.query(
        `select economic_role,state,${polymarketNativeHandoffReservationPendingSql("reservation")} as pending from balance_reservations reservation where operation_id=$1`,
        [operationId],
      )
    ).rows;
    assert.equal(pendingHolds.length, 2);
    assert.ok(
      pendingHolds.every(
        (entry) => entry.state === "active" && entry.pending === true,
      ),
      "confirmed/ACK handoff settles neither physical hold",
    );
    await db.query("savepoint early_controller_debit");
    await recordRelaySteps();
    assert.equal(
      (
        await db.query("select state from balance_reservations where id=$1", [
          sourceRow.id,
        ])
      ).rows[0].state,
      "active",
      "even a real controller debit cannot settle an uncertain venue handoff",
    );
    await db.query("savepoint pending_handoff_commit");
    await assert.rejects(
      input.commit(input.userId, plan),
      /source reservation requires exclusive capacity/,
    );
    await db.query("rollback to savepoint pending_handoff_commit");
    await db.query("release savepoint pending_handoff_commit");
    await db.query("rollback to savepoint early_controller_debit");
    await db.query("release savepoint early_controller_debit");
    const finalizedHandoff = {
      operationId,
      stepId: step.id,
      attemptId: attempt.id,
      networkId: "evm:137",
      receipt: {
        status: "finalized" as const,
        actionMatch: true,
        ledgerHeight: "1234",
        blockHash,
        canonical: true,
        failureCode: null,
        evidence: { transactionHash, handoffEventIndex: "3" },
      },
      now: new Date(input.now.getTime() + 1000),
    };
    await applyFundingStepReceiptEvidenceInTransaction(db, finalizedHandoff);
    await applyFundingStepReceiptEvidenceInTransaction(db, {
      ...finalizedHandoff,
      now: new Date(input.now.getTime() + 1500),
    });
    const finalizedHolds = (
      await db.query(
        "select economic_role,state from balance_reservations where operation_id=$1",
        [operationId],
      )
    ).rows;
    assert.equal(
      finalizedHolds.find((entry) => entry.economic_role === "source_input")
        .state,
      "released",
    );
    assert.equal(
      finalizedHolds.find(
        (entry) => entry.economic_role === "future_credit_fence",
      ).state,
      "active",
    );
    const receiptRow = (
      await db.query(
        "select * from funding_step_receipt_observations where attempt_id=$1",
        [attempt.id],
      )
    ).rows[0];
    assert.equal(
      receiptRow.evidence.polymarketHandoffReadV1.sourceAddress,
      String(economicSource.details.address).toLowerCase(),
    );
    assert.equal(
      receiptRow.evidence.polymarketHandoffReadV1.sourceReservationId,
      sourceRow.id,
    );
    const receipt: FundingStepReceiptObservation = {
      operationId,
      stepId: step.id,
      attemptId: attempt.id,
      networkId: receiptRow.network_id,
      status: receiptRow.status,
      actionMatch: receiptRow.action_match,
      ledgerHeight: receiptRow.ledger_height,
      blockHash: receiptRow.block_hash,
      canonical: receiptRow.canonical,
      failureCode: receiptRow.failure_code,
      evidence: receiptRow.evidence,
      firstSeenAt: receiptRow.first_seen_at,
      observedAt: receiptRow.observed_at,
      finalizedAt: receiptRow.finalized_at,
      reorgedAt: receiptRow.reorged_at,
    };
    const event = (
      await db.query<
        CanonicalEventOwnershipRow & {
          network_id: string;
          tx_hash: string;
          event_index: string;
        }
      >(
        "select network_id,tx_hash,event_index,asset_id,asset_decimals,source_address,destination_address,raw_amount::text,ledger_height::text,block_hash,allocation_status,allocation_error_code,allocated_receipt_id,allocated_receive_session_id from funding_receive_canonical_events where network_id=$1 and tx_hash=$2 and event_index=$3",
        ["evm:137", transactionHash, "3"],
      )
    ).rows[0];
    assert.ok(event);
    const proof = {
      operationId,
      binding,
      receipt,
      event,
      attempt: {
        operationId,
        id: attempt.id,
        stepId: step.id,
        stepOrdinal: 0,
        actionFingerprint: plan.steps[0].actionFingerprint,
        executorId: plan.steps[0].executorId,
        broadcastMayHaveOccurred: true,
      },
    };
    assert.deepEqual(readFinalizedPolymarketHandoffReceipt(proof), {
      transactionHash,
      eventIndex: "3",
      rawAmount: raw,
      finalityObservedAt: finalizedHandoff.now.toISOString(),
    });
    for (const invalid of [
      { ...proof, operationId: randomUUID() },
      { ...proof, receipt: { ...receipt, operationId: randomUUID() } },
      { ...proof, attempt: { ...proof.attempt, operationId: randomUUID() } },
      { ...proof, receipt: { ...receipt, status: "confirmed" as const } },
      {
        ...proof,
        receipt: { ...receipt, status: "reorged" as const, canonical: false },
      },
      { ...proof, receipt: { ...receipt, actionMatch: false } },
      {
        ...proof,
        receipt: {
          ...receipt,
          evidence: { transactionHash, handoffEventIndex: "3" },
        },
      },
      { ...proof, event: { ...event, block_hash: `0x${"ef".repeat(32)}` } },
      { ...proof, event: { ...event, raw_amount: "1" } },
      { ...proof, event: { ...event, source_address: profile.address } },
      {
        ...proof,
        event: {
          ...event,
          allocation_error_code: "internal_event_classification_conflict",
        },
      },
      {
        ...proof,
        attempt: { ...proof.attempt, actionFingerprint: "wrong-action" },
      },
      {
        ...proof,
        attempt: { ...proof.attempt, broadcastMayHaveOccurred: false },
      },
    ])
      assert.equal(readFinalizedPolymarketHandoffReceipt(invalid), null);
    assert.equal(
      (
        await db.query(
          "select count(*)::integer as total from funding_observations where operation_id=$1",
          [operationId],
        )
      ).rows[0].total,
      0,
      "handoff physical evidence is not another Relay debit/claim",
    );
    const physicalComponents = (
      sourceAt: number,
      controllerAt: number,
    ): ValuedAssetComponent[] =>
      [
        [
          binding.economicSource,
          binding.sourceReservation.componentId,
          sourceAt,
          "100000000",
        ],
        [
          binding.executionSource,
          binding.controllerFence.componentId,
          controllerAt,
          "10000000",
        ],
      ].map(
        ([location, componentId, at, balance]) =>
          ({
            location,
            componentId,
            amount: { asset: source.asset, raw: balance },
            observedAt: new Date(Number(at)).toISOString(),
            observationFreshness: "fresh",
            observationError: null,
            estimatedUsd: null,
          }) as ValuedAssetComponent,
      );
    const before = input.now.getTime() - 1000,
      after = input.now.getTime() + 2000;
    const components = physicalComponents(before, before);
    const handoffFacts = await loadFundingHandoffSnapshotFacts(
      db,
      input.userId,
      components,
    );
    assert.equal(handoffFacts.length, 2);
    assert.equal(
      handoffFacts.find(
        (fact) =>
          fact.sourceComponentId === binding.sourceReservation.componentId,
      )?.amount.raw,
      "0",
    );
    assert.equal(
      handoffFacts.find(
        (fact) =>
          fact.sourceComponentId === binding.controllerFence.componentId,
      )?.observationError,
      "funding_handoff_snapshot_pending",
    );
    assert.deepEqual(
      [
        ...fundingInvalidSourceComponentIds(
          input.userId,
          handoffFacts,
          components,
        ),
      ].sort(),
      [
        binding.sourceReservation.componentId,
        binding.controllerFence.componentId,
      ].sort(),
      "without balance ledger height, either latest-RPC snapshot may already include H before finality observation",
    );
    assert.equal(
      applyFundingSourceDebitSuppression(components, handoffFacts)[0].amount
        .raw,
      "100000000",
    );
    const straddling = physicalComponents(
      input.now.getTime() + 500,
      before,
    ).map((entry, index) =>
      index === 0
        ? { ...entry, amount: { ...entry.amount, raw: "90000000" } }
        : entry,
    );
    const straddlingFacts = await loadFundingHandoffSnapshotFacts(
      db,
      input.userId,
      straddling,
    );
    assert.equal(straddlingFacts.length, 2);
    assert.equal(
      applyFundingSourceDebitSuppression(straddling, straddlingFacts)[0].amount
        .raw,
      "90000000",
      "latest balance RPC can include H before the finality poll; never subtract H again",
    );
    assert.equal(
      fundingInvalidSourceComponentIds(
        input.userId,
        straddlingFacts,
        straddling,
      ).size,
      2,
      "ambiguous pre-finality balance ordering is unknown, not guessed from timestamps",
    );
    assert.equal(
      (
        await loadFundingHandoffSnapshotFacts(
          db,
          input.userId,
          physicalComponents(after, after),
        )
      ).length,
      0,
    );
    assert.equal(
      (await loadFundingHandoffSnapshotFacts(db, randomUUID(), components))
        .length,
      0,
    );
    await db.query("savepoint handoff_only_cancellation");
    const cancellation =
      await recordSafeFundingActionCancellationsInTransaction(db, {
        operationId,
        now: input.now,
      });
    assert.deepEqual(cancellation.unsafeStepIds, []);
    assert.ok(cancellation.cancelledStepIds.length > 0);
    assert.equal(
      (
        await reduceFundingOperationInTransaction(db, {
          operationId,
          now: input.now,
        })
      ).finalState.status,
      "cancelled",
    );
    assert.equal(
      (
        await db.query(
          "select count(*)::int as total from balance_reservations where operation_id=$1 and state='active'",
          [operationId],
        )
      ).rows[0].total,
      0,
      "H-only user cancellation releases the controller fence without inventing a Relay debit",
    );
    await db.query("rollback to savepoint handoff_only_cancellation");
    await db.query("release savepoint handoff_only_cancellation");
    async function recordRelaySteps() {
      for (const routeStep of plan.steps.filter((entry) =>
        ["approve", "deposit"].includes(
          String(entry.actionValidationResult.relayStepKind),
        ),
      )) {
        const row = (
          await db.query(
            "select id from funding_operation_steps where operation_id=$1 and ordinal=$2",
            [operationId, routeStep.ordinal],
          )
        ).rows[0];
        const actual = await startFundingStepAttemptInTransaction(db, {
          operationId,
          stepId: row.id,
          canonicalActionFingerprint: routeStep.actionFingerprint,
          executorId: routeStep.executorId,
          now: input.now,
        });
        const hash = `0x${canonicalJsonHash([operationId, routeStep.ordinal, "relay"])}`;
        await finishFundingStepAttemptInTransaction(db, {
          attemptId: actual.id,
          outcome: "submitted",
          broadcastMayHaveOccurred: true,
          referenceKind: "transaction",
          receiptRefCiphertext: "cipher:offline-relay-only",
          receiptRefLookupHmac: canonicalJsonHash(hash),
          lookupKeyVersion: 1,
          actualCosts: {},
          now: input.now,
        });
        await applyFundingStepReceiptEvidenceInTransaction(db, {
          operationId,
          stepId: row.id,
          attemptId: actual.id,
          networkId: "evm:137",
          receipt: {
            status: "finalized",
            actionMatch: true,
            canonical: true,
            failureCode: null,
            ledgerHeight: "1235",
            blockHash: `0x${"be".repeat(32)}`,
            evidence: {
              transactionHash: hash,
              ...(routeStep.actionValidationResult.relayStepKind === "deposit"
                ? { attributedSourceRaw: raw, sourceDebitEventIndex: "4" }
                : {}),
            },
          },
          now: new Date(input.now.getTime() + 10000),
        });
      }
    }
    await db.query("savepoint handoff_relay_timeline");
    await recordRelaySteps();
    assert.equal(
      (
        await db.query(
          "select count(*)::int as total from balance_reservations where operation_id=$1 and state='active'",
          [operationId],
        )
      ).rows[0].total,
      0,
      "exact H and exact bound D settle their own physical holds once",
    );
    assert.equal(
      (
        await db.query(
          "select count(*)::int as total from funding_observations where operation_id=$1 and kind='source_debit'",
          [operationId],
        )
      ).rows[0].total,
      1,
    );
    const currentFacts = await loadFundingAccountValueFacts(db, input.userId);
    const claim = currentFacts.inTransit.find(
      (fact) => fact.operationId === operationId,
    );
    assert.ok(claim);
    assert.equal(claim.observationError, null);
    assert.equal(claim.sourceComponentId, binding.controllerFence.componentId);
    assert.equal(claim.sourceLocationId, binding.executionSource.locationId);
    assert.equal(claim.amount.raw, raw);
    assert.equal(
      currentFacts.availability.find(
        (fact) => fact.componentId === binding.sourceReservation.componentId,
      )?.submittedDebitRaw ?? "0",
      "0",
      "common availability facts never label controller Relay debit as another physical venue debit",
    );
    const mixed = physicalComponents(after, before).map((entry, index) =>
      index === 0
        ? {
            ...entry,
            amount: {
              ...entry.amount,
              raw: (100000000n - BigInt(raw)).toString(),
            },
          }
        : entry,
    );
    const mixedDebits = await loadFundingSnapshotDebits(
      db,
      input.userId,
      mixed,
    );
    assert.equal(
      applyFundingSourceDebitSuppression(mixed, mixedDebits)[0].amount.raw,
      "90000000",
      "fresh venue90 is never reduced again by the controller Relay debit10",
    );
    assert.ok(
      fundingInvalidSourceComponentIds(input.userId, mixedDebits, mixed).has(
        binding.controllerFence.componentId,
      ),
      "preexisting controller10 plus unobserved H10/D10 is unknown, not known0",
    );
    const fullyFresh = physicalComponents(
      input.now.getTime() + 11000,
      input.now.getTime() + 11000,
    ).map((entry, index) =>
      index === 0
        ? { ...entry, amount: { ...entry.amount, raw: "90000000" } }
        : entry,
    );
    assert.equal(
      (await loadFundingSnapshotDebits(db, input.userId, fullyFresh)).length,
      0,
      "ordinary venue/controller refresh removes both physical tails without repair writes or a new Buy",
    );
    await db.query("rollback to savepoint handoff_relay_timeline");
    await db.query("release savepoint handoff_relay_timeline");
    await db.query("savepoint missing_handoff_fence");
    await db.query("delete from balance_reservations where id=$1", [
      storedBinding.controllerFenceId,
    ]);
    const damagedFacts = await loadFundingHandoffSnapshotFacts(
      db,
      input.userId,
      components,
    );
    assert.equal(damagedFacts.length, 2);
    assert.ok(
      damagedFacts.every(
        (fact) =>
          fact.amount.raw === "0" &&
          fact.observationError === "funding_source_evidence_invalid",
      ),
    );
    await db.query("rollback to savepoint missing_handoff_fence");
    await db.query("release savepoint missing_handoff_fence");
    const receiptEvidence = { transactionHash, handoffEventIndex: "3" };
    await applyFundingStepReceiptEvidenceInTransaction(db, {
      operationId,
      stepId: step.id,
      attemptId: attempt.id,
      networkId: "evm:137",
      receipt: {
        status: "reorged",
        actionMatch: null,
        canonical: false,
        failureCode: null,
        ledgerHeight: "1234",
        blockHash,
        evidence: receiptEvidence,
      },
      now: new Date(input.now.getTime() + 3000),
    });
    const reorgFacts = await loadFundingHandoffSnapshotFacts(
      db,
      input.userId,
      components,
    );
    assert.equal(reorgFacts.length, 2);
    assert.ok(
      reorgFacts.every(
        (fact) =>
          fact.amount.raw === "0" &&
          fact.observationError === "funding_source_evidence_invalid",
      ),
    );
    assert.equal(
      fundingInvalidSourceComponentIds(input.userId, reorgFacts, components)
        .size,
      2,
    );
    assert.equal(
      (
        await loadFundingHandoffSnapshotFacts(
          db,
          input.userId,
          physicalComponents(
            input.now.getTime() + 4000,
            input.now.getTime() + 4000,
          ),
        )
      ).length,
      0,
    );
    await applyFundingStepReceiptEvidenceInTransaction(db, {
      operationId,
      stepId: step.id,
      attemptId: attempt.id,
      networkId: "evm:137",
      receipt: {
        status: "finalized",
        actionMatch: true,
        canonical: true,
        failureCode: null,
        ledgerHeight: "1234",
        blockHash,
        evidence: receiptEvidence,
      },
      now: input.now,
    });
    assert.deepEqual(
      await loadFundingHandoffSnapshotFacts(db, input.userId, components),
      reorgFacts,
      "a stale finalized replay cannot revive an irreversibly reorged attempt; fresh physical snapshots recover reads",
    );
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await db.query(`set local plan_cache_mode=${mode}`);
      const snapshots = components.map((component) => ({
        component_id: component.componentId,
        location_id: component.location.locationId,
        address: String(component.location.details.address).toLowerCase(),
        network_id: source.asset.networkId,
        asset_id: source.asset.assetId.toLowerCase(),
        asset_decimals: source.asset.decimals,
        snapshot_at: component.observedAt,
      }));
      const explained = (
        await db.query(
          `explain (analyze,buffers,format json) ${FUNDING_HANDOFF_SNAPSHOT_TAIL_SQL}`,
          [input.userId, JSON.stringify(snapshots)],
        )
      ).rows[0]["QUERY PLAN"][0];
      console.log(
        "[handoff-physical-tail-plan]",
        JSON.stringify({
          mode,
          ms: explained["Execution Time"],
          buffers: explained.Plan["Shared Hit Blocks"],
        }),
      );
    }
    console.log(
      "[polymarket-handoff-plan-pg] PASS exact economic/controller freeze, real deferred shape, null fence/handoff, canonical finalized physical receipt and negative/reorg proofs; no second claim",
    );
    await verifyHandoffBindingLookupPlans(
      db,
      scope,
      plan,
      storedBinding,
      new Date(input.now.getTime() + 3000),
    );
  } finally {
    await db.query("rollback to savepoint polymarket_handoff_plan");
    await db.query("release savepoint polymarket_handoff_plan");
  }
}
