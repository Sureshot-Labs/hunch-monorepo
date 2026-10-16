import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { RelayReferenceCodec } from "../../funding-providers/relay/reference-codec.js";
import { createFundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import { createOrReuseFundingReceiveSession } from "../persistence/funding-receive-session-repository.js";
import { FundingReceiveSessionObserver } from "../receive/receive-session-observer.js";
import { syntheticCanonicalAnchor } from "./recorded-role-observer-fixture.js";
import type { OwnedRouteCanonicalDestinationEvent } from "../reconciliation/owned-route-destination-observer.js";
import {
  REFUND_CANONICAL_PAGE_SQL,
  type RefundWatchRow,
} from "../reconciliation/relay-refund-canonical-watch.js";
import { persistRefundCanonicalProofsFixture as persistRefundCanonicalProofs } from "./refund-canonical-effects-fixture.js";

/** Real recorded reader -> receive persistence -> canonical watcher -> expired
 * session retry, inside the caller's disposable fixture/savepoint transaction. */
export async function verifyReceiveRecordedRefundPg(
  db: Pick<PoolClient, "query">,
  pool: Pool,
  input: {
    userId: string;
    operationId: string;
    segmentId: string;
    event: OwnedRouteCanonicalDestinationEvent;
    now: Date;
    referenceCodec: RelayReferenceCodec;
  },
) {
  await db.query("savepoint recorded_refund_receive");
  try {
    const event = input.event;
    assert.ok(event.ledgerHeight);
    assert.ok(event.blockHash);
    assert.ok(event.sourceAddress);
    const blockNumber = event.ledgerHeight;
    const blockHash = event.blockHash;
    const sourceAddress = event.sourceAddress;
    const variantId = `refund-variant-${randomUUID()}`;
    const destinationOptionId = `refund-destination-${randomUUID()}`;
    const now = new Date(
      Math.min(input.now.getTime(), event.observedAt.getTime()) - 1000,
    );
    const late = new Date(now.getTime() + 180_000);
    const target = {
      receiveTargetId: destinationOptionId,
      networkId: event.networkId,
      destinationAddress: event.destinationAddress,
      acceptedAssets: [
        { asset: event.asset, handling: "automatic_conversion" as const },
      ],
      safeInstructions: ["Test only"],
    };
    const session = await createOrReuseFundingReceiveSession(pool, {
      userId: input.userId,
      venueId: "limitless",
      destinationOptionId,
      venueBindingOptionId: destinationOptionId,
      destinationAsset: event.asset,
      destinationTargetSnapshot: {},
      venueBindingSnapshot: {},
      methods: [
        {
          methodId: destinationOptionId,
          kind: "manual",
          safeLabel: "Test receive",
          ingress: {
            ingressKind: "manual",
            sourceNetworkId: null,
            sourceAsset: null,
            receiveTargets: [target],
            recommendedReceiveTargetId: target.receiveTargetId,
            destinationOptionId,
            destinationAddress: event.destinationAddress,
            requestedAmount: null,
            amountSemantics: "minimum",
            expiresAt: new Date(now.getTime() + 120_000).toISOString(),
            safeInstructions: ["Test only"],
          },
        },
      ],
      receiveTargets: [target],
      selectedReceiveTargetId: target.receiveTargetId,
      observationVariants: [
        {
          variantId,
          networkId: event.networkId,
          asset: event.asset,
          destinationAddress: event.destinationAddress,
          destinationLocationId: destinationOptionId,
          baselineRaw: "0",
          baselineRevision: "refund-test-baseline",
          observation: {
            adapterId: "owned_wallet_liquid_balances_v1",
            payload: {
              eventCursorBlock: (BigInt(event.ledgerHeight) - 1n).toString(),
              eventConfirmations: 2,
              eventIdentity: "evm_erc20_transfer_v1",
            },
          },
          completion: { kind: "child_funding_operation" },
        },
      ],
      automationPolicy: {
        stableConversion: "automatic_within_caps",
        volatileConversion: "review_required",
        maximumFeeUsd: "1",
        maximumFeeBps: 500,
        maximumSlippageBps: 100,
      },
      policyVersion: 1,
      policyRevision: "refund-test",
      ownershipRevision: "refund-test",
      now,
      expiresAt: new Date(now.getTime() + 120_000),
      observeUntil: new Date(now.getTime() + 150_000),
    });
    let scans = 0;
    const observer = new FundingReceiveSessionObserver({
      inspectCanonicalAnchor: syntheticCanonicalAnchor,
      // No recorded-refund injection: reads the actual receipt written by the
      // common writer. Only chain scanning is replaced by exact fixture facts.
      relayReferenceCodec: input.referenceCodec,
      transactionReferenceCodec: createFundingTransactionReferenceCodec({
        encryptionKey: Buffer.alloc(32, 7),
        lookupHmacKey: "offline-recorded-refund-receive-key-32chars",
        keyVersion: 1,
      }),
      scanCanonicalEvents: async (variants) => {
        const variant = variants.find((entry) => entry.variantId === variantId);
        if (!variant) return null;
        scans++;
        return {
          events: [
            {
              variant,
              transactionHash: event.transactionHash,
              eventIndex: event.eventIndex,
              blockNumber,
              blockHash,
              sourceAddress,
              destinationAddress: event.destinationAddress,
              rawAmount: event.rawAmount,
              observedAt: event.observedAt.toISOString(),
            },
          ],
          variants,
          cursorAdvanced: true,
        };
      },
    });
    const physical = async () =>
      (
        await db.query(
          `select allocation_status,allocation_error_code,classification_receive_session_id,
        classification_retry_at,classification_lease_token,ledger_height::text,block_hash
       from funding_receive_canonical_events where network_id=$1 and tx_hash=$2 and event_index=$3`,
          [event.networkId, event.transactionHash, event.eventIndex],
        )
      ).rows[0];
    const getWatch = async () => {
      const rows = (
        await db.query<RefundWatchRow>(REFUND_CANONICAL_PAGE_SQL, [
          input.operationId,
          "00000000-0000-0000-0000-000000000000",
          25,
        ])
      ).rows;
      const row = rows.find(
        (entry) =>
          JSON.parse(entry.receipt_snapshot).tx_hash === event.transactionHash,
      );
      assert.ok(row);
      return row;
    };
    const scan = async (offset: number) => {
      const result = await observer.pollBatch(pool, {
        limit: 100,
        minimumPollIntervalMs: 0,
        now: new Date(now.getTime() + offset),
      });
      assert.equal(result.retryableErrors, 0);
      assert.equal(result.receiptsRecorded, 0);
    };
    let offset = 1000;
    const drain = async (expected: string, initialOffset: number) => {
      for (let tick = 1; tick <= 60; tick++) {
        if ((await physical()).allocation_error_code === expected) return;
        offset = initialOffset + tick * 1000;
        const result = await observer.pollKnownCanonicalRetryBatch(pool, {
          limit: 100,
          retryDelayMs: 1000,
          now: new Date(now.getTime() + offset),
        });
        assert.equal(result.retryableErrors, 0);
        assert.equal(result.receiptsRecorded, 0);
      }
      assert.fail(
        `real bounded role enumeration did not converge: ${JSON.stringify(await physical())}`,
      );
    };
    await scan(offset);
    assert.equal(scans, 1);
    await drain("internal_exact_refund_suppressed", offset);
    assert.equal(
      (await physical()).allocation_error_code,
      "internal_exact_refund_suppressed",
    );
    const stored = await getWatch();
    assert.equal(
      (
        await persistRefundCanonicalProofs(db, {
          operationId: input.operationId,
          now: new Date(now.getTime() + offset + 1000),
          rows: [{ row: stored, proof: { kind: "reorged" } }],
        })
      ).changed,
      1,
    );
    await scan(offset + 2000);
    const pending = await physical();
    assert.equal(
      pending.allocation_error_code,
      "exact_refund_receipt_not_final",
    );
    assert.equal(
      pending.classification_receive_session_id,
      session.snapshot.session.receiveSessionId,
    );
    const retry = await observer.pollKnownCanonicalRetryBatch(pool, {
      limit: 100,
      retryDelayMs: 1000,
      now: late,
    });
    assert.equal(retry.retryableErrors, 0);
    assert.equal(retry.receiptsRecorded, 0);
    assert.ok((await physical()).classification_retry_at > late);
    // Re-observation can leave this earlier role state just before A reorgs.
    // It must not trap both the receive and recorded-refund repair paths.
    await db.query(
      `update funding_receive_canonical_events set allocation_error_code='exact_refund_correlation_pending'
      where network_id=$1 and tx_hash=$2 and event_index=$3`,
      [event.networkId, event.transactionHash, event.eventIndex],
    );
    // Real remine changes the anchor while the receive event is pending. The
    // narrow DB trigger permits this and preserves the independent receive
    // retry reason/token so its own worker can acknowledge/clear that lease.
    const remine = {
      ledgerHeight: (BigInt(event.ledgerHeight) + 10n).toString(),
      blockHash: `0x${"45".repeat(32)}`,
    };
    assert.equal(
      (
        await persistRefundCanonicalProofs(db, {
          operationId: input.operationId,
          now: late,
          rows: [
            { row: await getWatch(), proof: { kind: "canonical", ...remine } },
          ],
        })
      ).changed,
      1,
    );
    const moved = await physical();
    assert.equal(moved.allocation_error_code, "exact_refund_receipt_not_final");
    assert.equal(moved.ledger_height, remine.ledgerHeight);
    const repaired = await observer.pollKnownCanonicalRetryBatch(pool, {
      limit: 100,
      retryDelayMs: 1000,
      now: new Date(late.getTime() + 1000),
    });
    assert.equal(repaired.retryableErrors, 0);
    assert.equal(repaired.receiptsRecorded, 0);
    await drain(
      "internal_exact_refund_suppressed",
      late.getTime() - now.getTime() + 1000,
    );
    assert.equal(scans, 2, "expired repair never scans new transfers");
    const final = await physical();
    assert.equal(
      final.allocation_error_code,
      "internal_exact_refund_suppressed",
    );
    assert.equal(final.classification_retry_at, null);
    assert.equal(final.classification_lease_token, null);
    assert.equal(
      (
        await db.query(
          "select count(*)::int as total from funding_receive_receipts where receive_session_id=$1",
          [session.snapshot.session.receiveSessionId],
        )
      ).rows[0].total,
      0,
    );
  } finally {
    await db.query("rollback to savepoint recorded_refund_receive");
    await db.query("release savepoint recorded_refund_receive");
  }
}
