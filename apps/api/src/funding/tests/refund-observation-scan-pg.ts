import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { canonicalJsonHash } from "../persistence/canonical.js";
import { HYPERCORE_MAINNET_USDC } from "../domain/hypercore-identity.js";
import { relayDestinationReferenceIdentity } from "../../funding-providers/relay/destination-reference.js";
import {
  readRefundNativeDestination,
  REFUND_DESTINATION_REFERENCES_SQL,
} from "../reconciliation/relay-refund-destination-settlement.js";
import { allocateFundingObservationInTransaction } from "../persistence/funding-operation-repository.js";
import {
  readRefundObservationPage,
  refundObservationProgressSchema,
  type RefundObservationProgress,
} from "../reconciliation/relay-refund-observation-scan.js";

/** Session-local table only. Real writer/revision integration is covered by
 * refund-source-action-scan-pg; here exercise all-state keyset coverage. */
export async function verifyRefundObservationScanPg(
  db: Pick<PoolClient, "query">,
) {
  await db.query("savepoint refund_observation_scan");
  try {
    const operationId = randomUUID(),
      segmentId = randomUUID(),
      otherSegment = randomUUID();
    const base = {
      operationId,
      segmentId,
      kind: "source_debit" as const,
      networkId: "evm:8453",
      assetId: `0x${"ab".repeat(20)}`,
      assetDecimals: 6,
      eventIndex: "2",
      fromAddress: `0x${"cd".repeat(20)}`,
      toAddress: `0x${"ef".repeat(20)}`,
      rawAmount: "10000000",
      observedAt: new Date(),
      finalizedAt: new Date(),
      ledgerHeight: "123",
      blockHash: `0x${"12".repeat(32)}`,
      finalityStatus: "finalized" as const,
      metadata: {},
    };
    const insert = (
      patch: Partial<
        Parameters<typeof allocateFundingObservationInTransaction>[1]
      > = {},
    ) =>
      allocateFundingObservationInTransaction(db, {
        ...base,
        txHash: `0x${canonicalJsonHash(randomUUID())}`,
        ...patch,
      });
    // Other legs and operation-level preparations must advance, not veto or be
    // filtered ahead of LIMIT; no lifetime cap on their total history.
    for (let i = 0; i < 53; i++)
      await insert({ segmentId: i % 2 ? otherSegment : null });
    const walk = async (
      input: Omit<Parameters<typeof readRefundObservationPage>[1], "progress">,
    ) => {
      let progress: RefundObservationProgress = { kind: "unchecked" },
        pages = 0;
      do {
        assert.ok(pages++ < 100);
        progress = await readRefundObservationPage(db, {
          ...input,
          progress: refundObservationProgressSchema.parse(
            JSON.parse(JSON.stringify(progress)),
          ),
        });
      } while (progress.kind === "reading");
      return { progress, pages };
    };
    const empty = {
      operationId,
      segmentId,
      limit: 7,
      accounting: { kind: "none" as const },
      refundSet: { kind: "unchecked" as const },
    };
    const emptyResult = await walk(empty);
    assert.deepEqual(emptyResult.progress, { kind: "empty" });
    assert.equal(emptyResult.pages, 8);
    assert.deepEqual(
      (await walk({ ...empty, operationId: randomUUID() })).progress,
      { kind: "empty" },
    );
    const debit = (await insert()).observation;
    assert.deepEqual((await walk(empty)).progress, {
      kind: "pending",
      reason: "unexpected_observation",
    });
    const refund = (await insert({ kind: "refund_credit" })).observation;
    const refunded = {
      ...empty,
      accounting: {
        kind: "single_debit" as const,
        debit: {
          observationId: debit.id,
          networkId: "evm:8453" as const,
          transactionHash: debit.txHash,
          eventIndex: debit.eventIndex,
        },
      },
      refundSet: {
        kind: "complete_refund_set" as const,
        anchorObservationId: refund.id,
        fingerprint: "a".repeat(64),
        receiptCount: 1,
      },
    };
    assert.deepEqual((await walk(refunded)).progress, { kind: "refunded" });
    for (const kind of [
      "source_debit",
      "source_credit",
      "intermediate_transfer",
      "destination_credit",
      "refund_credit",
      "venue_readiness",
    ] as const) {
      await db.query("savepoint unexpected_leg_row");
      await insert({ kind });
      assert.deepEqual(
        (await walk(refunded)).progress,
        { kind: "pending", reason: "unexpected_observation" },
        kind,
      );
      await db.query("rollback to savepoint unexpected_leg_row");
      await db.query("release savepoint unexpected_leg_row");
    }
    for (const row of [debit, refund]) {
      for (const state of ["observed", "confirmed", "reorged"]) {
        await db.query("savepoint nonfinal_leg_row");
        await db.query(
          `update funding_observations set finality_status=$2,canonical=($2<>'reorged'),
          reorged_at=case when $2='reorged' then now() else null end where id=$1`,
          [row.id, state],
        );
        assert.deepEqual((await walk(refunded)).progress, {
          kind: "pending",
          reason: "nonfinal_observation",
        });
        await db.query("rollback to savepoint nonfinal_leg_row");
        await db.query("release savepoint nonfinal_leg_row");
      }
    }
    assert.deepEqual((await walk(refunded)).progress, { kind: "refunded" });
    assert.deepEqual(
      (
        await walk({
          ...refunded,
          refundSet: { ...refunded.refundSet, receiptCount: 2 },
        })
      ).progress,
      { kind: "pending", reason: "incomplete_settlement" },
    );
    assert.deepEqual(
      (
        await walk({
          ...refunded,
          accounting: {
            ...refunded.accounting,
            debit: {
              ...refunded.accounting.debit,
              observationId: randomUUID(),
            },
          },
        })
      ).progress,
      { kind: "pending", reason: "unexpected_observation" },
    );
    // Real SQL against session-local relations; no mutation of immutable live
    // financial rows. The PK matches the production segment lookup.
    await db.query(`create temporary table funding_operation_segments
      (id uuid primary key,operation_id uuid not null,support_metadata jsonb not null) on commit drop`);
    const destination = readRefundNativeDestination({
      userId: "owner-fixture",
      destination: {
        kind: "owned_location",
        location: {
          kind: "venue_account",
          locationId: "native-spot",
          accountId: "owner-fixture",
          asset: HYPERCORE_MAINNET_USDC,
          details: {
            address: base.fromAddress,
            venueId: "hyperliquid",
            environment: "mainnet",
            nativeSourceDex: "spot",
          },
        },
      },
      minimum: { asset: HYPERCORE_MAINNET_USDC, raw: "980000000" },
    });
    assert.ok(destination);
    await db.query("delete from funding_observations where id=$1", [refund.id]);
    const delivered = {
      ...refunded,
      destination,
      refundSet: {
        kind: "pending" as const,
        reason: "no_current_receipts" as const,
      },
    };
    const destinationRows = [];
    await db.query(
      `insert into funding_operation_segments values($1,$2,'{}')`,
      [segmentId, operationId],
    );
    for (const rawAmount of ["400000000", "580000000"]) {
      const row = (
        await insert({
          kind: "destination_credit",
          ...{
            networkId: HYPERCORE_MAINNET_USDC.networkId,
            assetId: HYPERCORE_MAINNET_USDC.assetId,
            assetDecimals: 8,
            eventIndex: "hypercore:send:destination_credit",
            ledgerHeight: null,
            blockHash: null,
            fromAddress: base.toAddress,
            toAddress: base.fromAddress,
            rawAmount,
            metadata: {
              observerId: "relay_owned_destination_observation_v1",
              nativeDestinationDex: "spot",
            },
          },
        })
      ).observation;
      destinationRows.push(row);
      // Canonical credit alone is insufficient: the exact request must retain
      // the successful destination transaction identity, not a status string.
      assert.deepEqual((await walk(delivered)).progress, {
        kind: "pending",
        reason: "unexpected_observation",
      });
      await db.query(
        `update funding_operation_segments set support_metadata=jsonb_build_object(
        'relaySuccessfulDestinationReferenceHashesV1',$2::jsonb) where id=$1`,
        [
          segmentId,
          JSON.stringify(
            destinationRows.map((item) =>
              relayDestinationReferenceIdentity(item.txHash),
            ),
          ),
        ],
      );
      assert.deepEqual(
        (await walk(delivered)).progress,
        destinationRows.length === 1
          ? { kind: "pending", reason: "incomplete_settlement" }
          : { kind: "delivered" },
      );
    }
    for (const mutation of [
      `metadata=metadata || '{"nativeDestinationDex":""}'::jsonb`,
      `metadata=metadata || '{"observerId":"other"}'::jsonb`,
      `event_index='owned-route:synthetic'`,
      `to_address='0x${"00".repeat(20)}'`,
      `raw_amount='579999999'`,
      `canonical=false,finality_status='reorged',reorged_at=now()`,
    ]) {
      await db.query("savepoint invalid_destination_credit");
      await db.query(
        `update funding_observations set ${mutation} where id=$1`,
        [destinationRows[1].id],
      );
      assert.equal((await walk(delivered)).progress.kind, "pending");
      await db.query("rollback to savepoint invalid_destination_credit");
      await db.query("release savepoint invalid_destination_credit");
    }
    assert.deepEqual((await walk(delivered)).progress, { kind: "delivered" });
    await db.query("savepoint mixed_refund_destination");
    await insert({ kind: "refund_credit" });
    assert.deepEqual((await walk(delivered)).progress, {
      kind: "pending",
      reason: "unexpected_observation",
    });
    await db.query("rollback to savepoint mixed_refund_destination");
    await db.query("release savepoint mixed_refund_destination");
    // Representative point lookup, including append-only reference history.
    await db.query(`insert into funding_operation_segments
      select gen_random_uuid(),gen_random_uuid(),'{}'::jsonb from generate_series(1,50000)`);
    await db.query(
      `update funding_operation_segments set support_metadata=jsonb_set(support_metadata,
      '{relaySuccessfulDestinationReferenceHashesV1}',support_metadata->'relaySuccessfulDestinationReferenceHashesV1' ||
        (select jsonb_agg(md5(sample::text)||md5(sample::text)) from generate_series(1,1000) sample)) where id=$1`,
      [segmentId],
    );
    await db.query("analyze funding_operation_segments");
    await db.query(
      `prepare refund_destination_refs(uuid,uuid,jsonb) as ${REFUND_DESTINATION_REFERENCES_SQL}`,
    );
    const keys = JSON.stringify(
      destinationRows.map((row) => ({
        id: row.id,
        fingerprint: relayDestinationReferenceIdentity(row.txHash),
      })),
    );
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await db.query(`set local plan_cache_mode=${mode}`);
      for (const [name, selectedOperation, selectedSegment, expected] of [
        ["hit", operationId, segmentId, 2],
        ["wrong-owner-operation", randomUUID(), segmentId, 0],
        ["missing", operationId, randomUUID(), 0],
      ] as const) {
        const explanation = (
          await db.query(`explain(analyze,buffers,format json)
          execute refund_destination_refs('${selectedOperation}','${selectedSegment}','${keys}')`)
        ).rows[0]["QUERY PLAN"][0];
        assert.equal(explanation.Plan["Actual Rows"], expected);
        const visit = (node: Record<string, unknown>) => {
          assert.notEqual(node["Node Type"], "Seq Scan");
          if (node["Relation Name"] === "funding_operation_segments")
            assert.ok(
              Number(node["Actual Rows"]) * Number(node["Actual Loops"]) <= 1,
            );
          for (const child of (node.Plans ?? []) as Record<string, unknown>[])
            visit(child);
        };
        visit(explanation.Plan);
        console.log(
          "[refund-destination-reference]",
          JSON.stringify({
            mode,
            name,
            ms: explanation["Execution Time"],
            buffers: explanation.Plan["Local Hit Blocks"],
            rows: explanation.Plan["Actual Rows"],
          }),
        );
      }
    }
    await db.query("deallocate refund_destination_refs");
    console.log(
      "PASS bounded exact-leg observation coverage: empty/refunded/delivered, sparse pages, mixed/extra/nonfinal evidence, exact successful references and recovery",
    );
  } finally {
    await db.query("rollback to savepoint refund_observation_scan");
    await db.query("release savepoint refund_observation_scan");
  }
}
