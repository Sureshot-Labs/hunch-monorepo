import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  allocateFundingObservationInTransaction,
  type FundingCommitPlan,
} from "../persistence/funding-operation-repository.js";
import {
  loadRefundSourceCandidate,
  matchRefundSourceEnvelope,
  REFUND_SOURCE_FIRST_PAGE_SQL,
  REFUND_SOURCE_NEXT_PAGE_SQL,
  REFUND_SOURCE_EXACT_SQL,
} from "../reconciliation/relay-refund-source-candidates.js";
import { readRefundSourceActionPage } from "../reconciliation/relay-refund-source-action-scan.js";
import { readReceiveHandoffActionPage } from "../receive/receive-handoff-action-scan.js";
import { arbitrateReceiveRoleCandidates } from "../receive/receive-role-arbitration.js";
import { receiveRoleEventFingerprint } from "../receive/receive-role-progress.js";
import { relayDestinationReferenceIdentity } from "../../funding-providers/relay/destination-reference.js";
import { canonicalJsonHash } from "../persistence/canonical.js";

/** Runs inside the rollback-only PG16 handoff fixture after real H/D receipt
 * writers released both holds. No provider/signer/executor is called. */
export async function verifyHandoffRefundSourcePg(
  db: PoolClient,
  input: {
    userId: string;
    operationId: string;
    segmentId: string;
    sourceReservationId: string;
    controllerFenceId: string;
    plan: FundingCommitPlan;
    now: Date;
  },
) {
  await db.query("savepoint handoff_refund_source");
  try {
    const identity = {
      userId: input.userId,
      operationId: input.operationId,
      segmentId: input.segmentId,
      reservationId: input.sourceReservationId,
    };
    const row = await loadRefundSourceCandidate(db, identity);
    assert.ok(row?.polymarket_handoff_binding);
    const source = input.plan.segments[0].sourceSnapshot.location as {
      details: { address: string };
      asset: { networkId: string; assetId: string; decimals: number };
    };
    const event = {
      networkId: source.asset.networkId,
      asset: source.asset,
      sourceAddress: `0x${"ef".repeat(20)}`,
      destinationAddress: source.details.address,
      rawAmount: "1000000",
      transactionHash: `0x${canonicalJsonHash([input.operationId, "later-unrelated-deposit"])}`,
      eventIndex: "7",
      ledgerHeight: "2000",
      blockHash: `0x${"ee".repeat(32)}`,
      observedAt: new Date(input.now.getTime() + 20000),
    };
    assert.equal(
      matchRefundSourceEnvelope(input.userId, event, row).kind,
      "candidate",
    );
    assert.notEqual(
      row.location_id,
      (row.source_snapshot as { location: { locationId: string } }).location
        .locationId,
    );
    const foreignUserId = (
      await db.query(
        "insert into users(email,is_active,is_verified) values($1,true,true) returning id",
        [`handoff-source-negative-${randomUUID()}@example.com`],
      )
    ).rows[0].id as string;
    for (const changes of [
      { raw_amount: "1" },
      { user_id: foreignUserId },
      { location_id: "different-controller" },
    ]) {
      await db.query("savepoint damaged_handoff_fence");
      try {
        // Committed capacity facts are immutable. Exercise the real guard,
        // rather than disabling it to manufacture an impossible persisted row.
        // Malformed frozen tuples are separately rejected by the pure reader
        // regression; here a failed mutation must leave the valid tuple intact.
        await assert.rejects(
          db.query(
            `update balance_reservations reservation_row
          set raw_amount=coalesce($2::text,reservation_row.raw_amount),
            user_id=coalesce($3::uuid,reservation_row.user_id),
            location_id=coalesce($4::text,reservation_row.location_id)
          where reservation_row.id=$1::uuid`,
            [
              input.controllerFenceId,
              "raw_amount" in changes ? changes.raw_amount : null,
              "user_id" in changes ? changes.user_id : null,
              "location_id" in changes ? changes.location_id : null,
            ],
          ),
          { code: "23514" },
        );
      } finally {
        await db.query("rollback to savepoint damaged_handoff_fence");
        await db.query("release savepoint damaged_handoff_fence");
      }
      const retained = await loadRefundSourceCandidate(db, identity);
      assert.ok(retained);
      assert.equal(
        matchRefundSourceEnvelope(input.userId, event, retained).kind,
        "candidate",
      );
    }
    const repaired = await loadRefundSourceCandidate(db, identity);
    assert.ok(repaired);
    assert.equal(
      matchRefundSourceEnvelope(input.userId, event, repaired).kind,
      "candidate",
    );
    const target = input.plan.segments[0].destinationTargetSnapshot
      .location as {
      details: { address: string };
      asset: { networkId: string; assetId: string; decimals: number };
    };
    const destinationHash = `0x${canonicalJsonHash([input.operationId, "delivered"])}`;
    await allocateFundingObservationInTransaction(db, {
      operationId: input.operationId,
      segmentId: input.segmentId,
      kind: "destination_credit",
      networkId: target.asset.networkId,
      assetId: target.asset.assetId,
      assetDecimals: target.asset.decimals,
      txHash: destinationHash,
      eventIndex: "hypercore:send:destination_credit",
      fromAddress: `0x${"ab".repeat(20)}`,
      toAddress: target.details.address,
      rawAmount: String(input.plan.segments[0].quotedMinOutput.raw),
      observedAt: input.now,
      ledgerHeight: null,
      blockHash: null,
      finalityStatus: "finalized",
      finalizedAt: input.now,
      metadata: {
        observerId: "relay_owned_destination_observation_v1",
        nativeDestinationDex: "spot",
      },
    });
    await db.query(
      `update funding_operation_segments set support_metadata=support_metadata ||
      jsonb_build_object('relaySuccessfulDestinationReferenceHashesV1',jsonb_build_array($2::text)) where id=$1::uuid`,
      [input.segmentId, relayDestinationReferenceIdentity(destinationHash)],
    );
    const read = (completed?: unknown) =>
      readRefundSourceActionPage(db, {
        identity,
        event,
        continuation: null,
        completed,
        limit: 25,
      });
    const initial = await read();
    assert.equal(
      initial.kind === "complete" && initial.accounting.kind,
      "single_debit",
    );
    const refundChecked = await read(initial);
    const complete = await read(refundChecked);
    assert.equal(complete.kind, "complete");
    if (complete.kind !== "complete")
      assert.fail("expected complete source facts");
    assert.deepEqual(complete.observations, { kind: "delivered" });
    const transactionReferenceCodec = {
      keyVersion: 1,
      fingerprint: canonicalJsonHash,
      decrypt: () =>
        assert.fail(
          "finalized unrelated handoff must not decrypt transport hints",
        ),
    };
    const handoff = await readReceiveHandoffActionPage(db, {
      userId: input.userId,
      operationId: input.operationId,
      event,
      progress: null,
      limit: 25,
      transactionReferenceCodec,
    });
    assert.equal(handoff.kind, "complete");
    assert.deepEqual(
      await arbitrateReceiveRoleCandidates({
        userId: input.userId,
        event,
        enumerationComplete: true,
        transactionReferenceCodec,
        candidates: [
          {
            reservation_id: input.sourceReservationId,
            operation_id: input.operationId,
            segment_id: input.segmentId,
            envelope_kind: "candidate",
            handoff_possible: true,
            destination_possible: false,
            action_result: complete,
            handoff_progress: handoff,
            destination_progress: null,
          },
        ],
        refundEvidence: {
          kind: "recorded",
          eventFingerprint: receiveRoleEventFingerprint(event),
          classification: { kind: "unmatched" },
          dependencies: [],
        },
      }),
      {
        kind: "ready_for_fence",
        classification: { kind: "external" },
        dependencies: [complete.facts],
      },
    );
    await db.query(
      `prepare handoff_refund_source_first(uuid,timestamptz,integer) as ${REFUND_SOURCE_FIRST_PAGE_SQL}`,
    );
    await db.query(
      `prepare handoff_refund_source_next(uuid,timestamptz,integer,timestamptz,uuid) as ${REFUND_SOURCE_NEXT_PAGE_SQL}`,
    );
    await db.query(
      `prepare handoff_refund_source_exact(uuid,uuid) as ${REFUND_SOURCE_EXACT_SQL}`,
    );
    const cases = [
      [
        "exact",
        "handoff_refund_source_exact",
        `'${input.userId}','${input.sourceReservationId}'`,
      ],
      [
        "first",
        "handoff_refund_source_first",
        `'${input.userId}','2100-01-01',51`,
      ],
      [
        "next",
        "handoff_refund_source_next",
        `'${input.userId}','2100-01-01',51,'${row.reservation_created_at}','${row.reservation_id}'`,
      ],
      [
        "foreign",
        "handoff_refund_source_exact",
        `'${randomUUID()}','${input.sourceReservationId}'`,
      ],
    ];
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await db.query(`set local plan_cache_mode=${mode}`);
      for (const [name, prepared, args] of cases) {
        const explanation = (
          await db.query(
            `explain(analyze,buffers,format json) execute ${prepared}(${args})`,
          )
        ).rows[0]["QUERY PLAN"][0];
        const scans: unknown[] = [];
        const visit = (node: Record<string, unknown>) => {
          if (node["Relation Name"])
            scans.push({
              relation: node["Relation Name"],
              type: node["Node Type"],
              rows: node["Actual Rows"],
              loops: node["Actual Loops"],
              removed: node["Rows Removed by Filter"] ?? 0,
              index: node["Index Name"],
            });
          for (const child of (node.Plans ?? []) as Record<string, unknown>[])
            visit(child);
        };
        visit(explanation.Plan);
        console.log(
          "[handoff-refund-source-plan]",
          JSON.stringify({
            mode,
            name,
            ms: explanation["Execution Time"],
            sharedHits: explanation.Plan["Shared Hit Blocks"],
            sharedReads: explanation.Plan["Shared Read Blocks"],
            scans,
          }),
        );
      }
    }
    await db.query("deallocate handoff_refund_source_first");
    await db.query("deallocate handoff_refund_source_next");
    await db.query("deallocate handoff_refund_source_exact");
    console.log(
      "[handoff-refund-source-pg] PASS exact planner binding, immutable fence rejection/retention, released historical H/D, actual action/settlement scan and external arbitration",
    );
  } finally {
    await db.query("rollback to savepoint handoff_refund_source");
    await db.query("release savepoint handoff_refund_source");
  }
}
