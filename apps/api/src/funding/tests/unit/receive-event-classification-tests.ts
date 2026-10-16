import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXACT_REFUND_CORRELATION_PENDING,
  classifyRecordedExactRefund,
  classifyRecordedRelayExactRefundEvents,
  readRecordedRelayRefundRoleEvidence,
  refundCanonicalEventKey,
  type RecordedRefundRow,
} from "../../reconciliation/relay-exact-refund-classification.js";
import {
  receiveInternalRolesConflict,
  resolveLegacyRecordedReceiveRoles,
  resolveReceiveEventClassification,
} from "../../receive/receive-event-classification.js";
import { EXACT_REFUND_RECEIPTS_CONTRACT } from "../../domain/refund-settlement.js";
import type { OwnedRouteCanonicalDestinationEvent } from "../../reconciliation/owned-route-destination-observer.js";
import { isFundingReceiveClassificationRetryReason } from "../../persistence/funding-receive-session-repository.js";
import { receiveRoleEventFingerprint } from "../../receive/receive-role-progress.js";

test("pending refund correlation remains eligible for bounded known-event repair", () => {
  assert.equal(
    isFundingReceiveClassificationRetryReason(EXACT_REFUND_CORRELATION_PENDING),
    true,
  );
  assert.equal(isFundingReceiveClassificationRetryReason(null), false);
  assert.equal(
    isFundingReceiveClassificationRetryReason(
      "internal_exact_refund_suppressed",
    ),
    false,
  );
});

const userId = "11111111-1111-4111-8111-111111111111";
const event: OwnedRouteCanonicalDestinationEvent = {
  networkId: "evm:8453",
  asset: {
    networkId: "evm:8453",
    assetId: `0x${"a1".repeat(20)}`,
    decimals: 6,
  },
  sourceAddress: `0x${"ab".repeat(20)}`,
  destinationAddress: `0x${"cd".repeat(20)}`,
  rawAmount: "9800000",
  transactionHash: `0x${"ab".repeat(32)}`,
  eventIndex: "7",
  ledgerHeight: "123",
  blockHash: `0x${"ef".repeat(32)}`,
  observedAt: new Date("2026-10-14T00:00:00Z"),
};
const receiptIdentity = {
  version: 1,
  requestFingerprint: "a".repeat(64),
  lookupKeyVersion: 1,
  protocolOrderId: `0x${"b".repeat(64)}`,
  refundLocationId: "source-location",
};
const row: RecordedRefundRow = {
  identity: refundCanonicalEventKey(event),
  observation_id: "22222222-2222-4222-8222-222222222222",
  operation_id: "operation",
  segment_id: "segment",
  user_id: userId,
  classification_revision: "0",
  network_id: event.networkId,
  asset_id: event.asset.assetId,
  asset_decimals: 6,
  raw_amount: event.rawAmount,
  from_address: event.sourceAddress,
  to_address: event.destinationAddress,
  ledger_height: event.ledgerHeight,
  block_hash: event.blockHash,
  canonical: true,
  finality_status: "finalized",
  metadata: {
    observerId: "relay_exact_refund_observation_v1",
    relayRefundReceipt: receiptIdentity,
  },
  refund_location_snapshot: {
    kind: "wallet",
    locationId: receiptIdentity.refundLocationId,
    accountId: userId,
    asset: event.asset,
    details: { address: event.destinationAddress },
    refundEvidenceContract: EXACT_REFUND_RECEIPTS_CONTRACT,
    relayProtocolOrderId: receiptIdentity.protocolOrderId,
  },
  provider_quote_ref_lookup_hmac: receiptIdentity.requestFingerprint,
  lookup_key_version: 1,
};
const internal = {
  kind: "internal",
  operationId: "operation",
  segmentId: "segment",
};

test("legacy recorded-role adapter preserves all combinations and recovery precedence", () => {
  type Input = Parameters<typeof resolveLegacyRecordedReceiveRoles>[0];
  const handoffs: Input["handoff"][] = [
    undefined,
    { kind: "external", reason: null },
    {
      kind: "internal",
      reason: null,
      reference: "exact",
      operationId: "handoff-operation",
      attemptId: "handoff-attempt",
    },
    { kind: "recovery_required", reason: "handoff_reference_unavailable" },
  ];
  const destinations: Input["destination"][] = [
    undefined,
    { kind: "external" },
    {
      kind: "internal",
      operationId: "destination-operation",
      segmentId: "destination-segment",
      transactionReferenceFingerprint: "destination-reference",
    },
    {
      kind: "recovery_required",
      reason: "owned_route_destination_correlation_pending",
    },
    { kind: "recovery_required", reason: "owned_route_destination_ambiguous" },
  ];
  const refunds: Input["refund"][] = [
    undefined,
    { kind: "unmatched" },
    {
      kind: "internal",
      operationId: "refund-operation",
      segmentId: "refund-segment",
    },
    { kind: "recovery_required", reason: "exact_refund_receipt_not_final" },
    { kind: "recovery_required", reason: "exact_refund_receipt_conflict" },
  ];
  for (const handoff of handoffs)
    for (const destination of destinations)
      for (const refund of refunds) {
        const roles = [handoff, destination, refund];
        const positives = roles.filter(
          (role) => role?.kind === "internal",
        ).length;
        const conflicting =
          positives > 1 ||
          (positives > 0 &&
            roles.some((role) => role?.kind === "recovery_required"));
        const result = resolveLegacyRecordedReceiveRoles({
          handoff,
          destination,
          refund,
        });
        if (conflicting) {
          assert.deepEqual(result, {
            kind: "recovery_required",
            reason: "internal_event_classification_conflict",
          });
          continue;
        }
        // The original receive publisher chose refund recovery before handoff
        // and destination recovery. This differs from the joint arbiter.
        const pending = [refund, handoff, destination].find(
          (role) => role?.kind === "recovery_required",
        );
        if (pending) assert.deepEqual(result, pending);
        else if (handoff?.kind === "internal")
          assert.deepEqual(result, {
            kind: "internal_handoff",
            match: handoff,
          });
        else if (refund?.kind === "internal")
          assert.deepEqual(result, { kind: "internal_refund", match: refund });
        else if (destination?.kind === "internal")
          assert.deepEqual(result, {
            kind: "internal_destination",
            match: destination,
          });
        else assert.deepEqual(result, { kind: "external" });
      }
});

test("current receive roles arbitrate symmetrically without assuming unexamined refund coverage", () => {
  const kinds = ["external", "internal", "recovery_required"];
  for (const first of kinds)
    for (const second of kinds) {
      const expected =
        (first === "internal" && second !== "external") ||
        (second === "internal" && first !== "external");
      assert.equal(
        receiveInternalRolesConflict([{ kind: first }, { kind: second }]),
        expected,
      );
    }
  assert.equal(receiveInternalRolesConflict([]), false);
  assert.equal(receiveInternalRolesConflict([{ kind: "internal" }]), false);
});

test("known refund requires the full physical envelope and frozen binding, not operation status", () => {
  assert.ok(event.blockHash);
  assert.ok(event.sourceAddress);
  assert.deepEqual(classifyRecordedExactRefund(userId, event, [row]), internal);
  assert.deepEqual(
    classifyRecordedExactRefund(
      userId,
      {
        ...event,
        destinationAddress: `0x${event.destinationAddress.slice(2).toUpperCase()}`,
        asset: {
          ...event.asset,
          assetId: `0x${event.asset.assetId.slice(2).toUpperCase()}`,
        },
        blockHash: event.blockHash.toUpperCase(),
      },
      [row],
    ),
    internal,
  );
  assert.deepEqual(classifyRecordedExactRefund(userId, event, []), {
    kind: "unmatched",
  });
  assert.equal(
    classifyRecordedExactRefund(userId, event, [row, row]).kind,
    "recovery_required",
  );
  for (const bad of [
    { user_id: "foreign" },
    { segment_id: null },
    { network_id: "evm:137" },
    { asset_id: `0x${"ee".repeat(20)}` },
    { asset_decimals: 8 },
    { raw_amount: "1" },
    { from_address: null },
    { to_address: event.sourceAddress },
    { ledger_height: "124" },
    { block_hash: null },
    { block_hash: `0x${"ff".repeat(32)}` },
    { provider_quote_ref_lookup_hmac: "c".repeat(64) },
    { lookup_key_version: 2 },
    {
      refund_location_snapshot: {
        ...(row.refund_location_snapshot as object),
        accountId: "foreign",
      },
    },
    {
      refund_location_snapshot: {
        ...(row.refund_location_snapshot as object),
        refundEvidenceContract: "future",
      },
    },
    {
      refund_location_snapshot: {
        ...(row.refund_location_snapshot as object),
        alternativeRefundLocations: {
          version: 1,
          locations: [{ accountId: "foreign" }],
        },
      },
    },
    {
      metadata: { observerId: "another", relayRefundReceipt: receiptIdentity },
    },
    {
      metadata: {
        observerId: "relay_exact_refund_observation_v1",
        relayRefundReceipt: { ...receiptIdentity, refundLocationId: "wrong" },
      },
    },
    { metadata: { ...(row.metadata as object), nativeDestinationDex: "spot" } },
  ])
    assert.deepEqual(
      classifyRecordedExactRefund(userId, event, [{ ...row, ...bad }]),
      { kind: "recovery_required", reason: "exact_refund_receipt_conflict" },
    );
});

test("reorg/confirmed evidence is never recycled as a new external receive", () => {
  for (const state of [
    { canonical: false, finality_status: "reorged" },
    { canonical: true, finality_status: "confirmed" },
  ])
    assert.deepEqual(
      classifyRecordedExactRefund(userId, event, [{ ...row, ...state }]),
      { kind: "recovery_required", reason: "exact_refund_receipt_not_final" },
    );
  assert.deepEqual(classifyRecordedExactRefund(userId, event, [row]), internal);
});

test("legacy refunds keep their existing path but partial new identities stay unresolved", () => {
  const legacy = { ...row, refund_location_snapshot: {}, metadata: {} };
  assert.deepEqual(classifyRecordedExactRefund(userId, event, [legacy]), {
    kind: "unmatched",
  });
  for (const partial of [
    { ...legacy, metadata: row.metadata },
    { ...legacy, refund_location_snapshot: row.refund_location_snapshot },
    { ...legacy, metadata: { relayRefundReceipt: null } },
    { ...legacy, refund_location_snapshot: { refundEvidenceContract: null } },
  ])
    assert.equal(
      classifyRecordedExactRefund(userId, event, [partial]).kind,
      "recovery_required",
    );
});

test("batched lookup normalizes the physical key, deduplicates and rejects conflicting duplicates even before writer", async () => {
  let calls = 0;
  const db = {
    query: async (_sql: string, values: readonly unknown[]) => {
      calls++;
      const keys = JSON.parse(String(values[0]));
      assert.equal(keys.length, 1);
      assert.equal(keys[0].tx_hash, event.transactionHash);
      return { rows: [row] };
    },
  };
  const classified = await classifyRecordedRelayExactRefundEvents(db as never, {
    userId,
    events: [
      event,
      { ...event, transactionHash: event.transactionHash.toUpperCase() },
    ],
  });
  assert.deepEqual(classified.get(row.identity), internal);
  assert.equal(calls, 1);
  const empty = { query: async () => ({ rows: [] }) };
  const mismatched = await classifyRecordedRelayExactRefundEvents(
    empty as never,
    { userId, events: [event, { ...event, rawAmount: "1" }] },
  );
  assert.equal(mismatched.get(row.identity)?.kind, "recovery_required");
  await classifyRecordedRelayExactRefundEvents(db as never, {
    userId,
    events: [],
  });
  assert.equal(calls, 1);
});

test("recorded evidence retains same-statement facts including negative legacy witnesses", async () => {
  let queries = 0;
  const db = {
    query: async () => {
      queries++;
      return { rows: [row] };
    },
  };
  const evidence = (
    await readRecordedRelayRefundRoleEvidence(db as never, {
      userId,
      events: [event],
    })
  ).get(row.identity);
  assert.deepEqual(evidence, {
    kind: "recorded",
    eventFingerprint: receiveRoleEventFingerprint(event),
    classification: internal,
    dependencies: [{ userId, operationId: row.operation_id, revision: "0" }],
  });
  assert.equal(
    queries,
    1,
    "no newer facts query may be attached to older receipt data",
  );
  const negative = (
    await readRecordedRelayRefundRoleEvidence(
      {
        query: async () => ({
          rows: [
            {
              ...row,
              metadata: {},
              refund_location_snapshot: {},
              classification_revision: "19",
            },
          ],
        }),
      } as never,
      { userId, events: [event] },
    )
  ).get(row.identity);
  assert.equal(negative?.classification.kind, "unmatched");
  assert.equal(
    negative?.dependencies[0].revision,
    "19",
    "legacy negative is still a dependency",
  );
});

test("joint classification has no first-match winner and never allocates pending evidence", () => {
  const external = { kind: "external" as const };
  const handoffExternal = { ...external, reason: null };
  const refund = {
    kind: "internal" as const,
    operationId: "operation",
    segmentId: "segment",
  };
  const destination = {
    ...refund,
    transactionReferenceFingerprint: "fingerprint",
  };
  const handoff = {
    kind: "internal" as const,
    reference: "exact" as const,
    operationId: "handoff-operation",
    attemptId: "handoff-attempt",
  };
  assert.deepEqual(
    resolveReceiveEventClassification({
      handoff: handoffExternal,
      destination: external,
      refund: external,
    }),
    external,
  );
  assert.equal(
    resolveReceiveEventClassification({
      handoff,
      destination: external,
      refund: external,
    }).kind,
    "internal_handoff",
  );
  assert.equal(
    resolveReceiveEventClassification({
      handoff: handoffExternal,
      destination,
      refund: external,
    }).kind,
    "internal_destination",
  );
  assert.equal(
    resolveReceiveEventClassification({
      handoff: handoffExternal,
      destination: external,
      refund,
    }).kind,
    "internal_refund",
  );
  for (const input of [
    { handoff, destination, refund: external },
    { handoff, destination: external, refund },
    { handoff: handoffExternal, destination, refund },
    { handoff, destination, refund },
    {
      handoff: {
        kind: "recovery_required" as const,
        reason: "handoff_reference_unavailable",
      },
      destination: external,
      refund,
    },
    {
      handoff: handoffExternal,
      destination: {
        kind: "recovery_required" as const,
        reason: "owned_route_destination_correlation_pending" as const,
      },
      refund,
    },
  ])
    assert.deepEqual(resolveReceiveEventClassification(input), {
      kind: "recovery_required",
      reason: "internal_event_classification_conflict",
    });
  assert.deepEqual(
    resolveReceiveEventClassification({
      handoff: handoffExternal,
      destination: external,
      refund: {
        kind: "recovery_required",
        reason: "exact_refund_correlation_pending",
      },
    }),
    { kind: "recovery_required", reason: "exact_refund_correlation_pending" },
  );
  assert.equal(
    resolveReceiveEventClassification({
      handoff: { kind: "internal" } as never,
      destination: external,
      refund: external,
    }).kind,
    "recovery_required",
  );
  assert.equal(
    resolveReceiveEventClassification({
      handoff: handoffExternal,
      destination: external,
      refund: { kind: "unmatched" } as never,
    }).kind,
    "recovery_required",
  );
});

test("recorded EVM refund lookup does not query unsupported networks", async () => {
  const db = {
    query: async () => assert.fail("unsupported network must not query"),
  };
  for (const networkId of [
    "hyperliquid:mainnet",
    "hyperliquid:testnet",
    "solana:mainnet",
    "evm:1",
  ]) {
    const classified = await classifyRecordedRelayExactRefundEvents(
      db as never,
      {
        userId,
        events: [{ ...event, networkId, asset: { ...event.asset, networkId } }],
      },
    );
    assert.equal(classified.size, 0);
  }
});
