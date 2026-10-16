import assert from "node:assert/strict";
import { test } from "node:test";
import { relayExactRefundRoleEvidence } from "../../reconciliation/relay-exact-refund-proposal.js";
import type { PreparedRelayExactRefundReceipts } from "../../reconciliation/relay-exact-refund-receipts.js";
import {
  refundCanonicalEventKey,
  type RecordedRefundRoleEvidence,
} from "../../reconciliation/relay-exact-refund-classification.js";
import { receiveRoleEventFingerprint } from "../../receive/receive-role-progress.js";

const event = {
  networkId: "evm:8453",
  asset: {
    networkId: "evm:8453",
    assetId: `0x${"12".repeat(20)}`,
    decimals: 6,
  },
  sourceAddress: `0x${"34".repeat(20)}`,
  destinationAddress: `0x${"56".repeat(20)}`,
  rawAmount: "1000000",
  transactionHash: `0x${"78".repeat(32)}`,
  eventIndex: "7",
  ledgerHeight: "10",
  blockHash: `0x${"90".repeat(32)}`,
  observedAt: new Date(0),
};
const key = refundCanonicalEventKey(event);
const facts = { operationId: "operation", userId: "owner", revision: "7" };
// The pure merge consumes only the exact verifier's events and frozen facts.
const prepared = {
  input: { operationId: facts.operationId, segmentId: "segment" },
  facts,
  verification: { verified: { events: [event] } },
} as unknown as PreparedRelayExactRefundReceipts;
const absent: RecordedRefundRoleEvidence = {
  kind: "recorded",
  eventFingerprint: receiveRoleEventFingerprint(event),
  classification: { kind: "unmatched" },
  dependencies: [],
};

test("first exact refund proposal fills a checked physical absence with the original facts", () => {
  const original = new Map([[key, absent]]);
  assert.deepEqual(relayExactRefundRoleEvidence(prepared, original).get(key), {
    kind: "verified_proposal",
    eventFingerprint: absent.eventFingerprint,
    classification: {
      kind: "internal",
      operationId: "operation",
      segmentId: "segment",
    },
    dependencies: [facts],
  });
  assert.equal(original.get(key), absent);
});

test("missing, stale, legacy negative, current/foreign positive and recovery evidence cannot be overwritten", () => {
  assert.equal(
    relayExactRefundRoleEvidence(prepared, new Map()).has(key),
    false,
  );
  const witnesses: RecordedRefundRoleEvidence[] = [
    { ...absent, eventFingerprint: "old-envelope" },
    { ...absent, dependencies: [facts] },
    {
      ...absent,
      classification: {
        kind: "internal",
        operationId: "operation",
        segmentId: "segment",
      },
      dependencies: [facts],
    },
    {
      ...absent,
      classification: {
        kind: "internal",
        operationId: "other",
        segmentId: "other-segment",
      },
      dependencies: [{ ...facts, operationId: "other" }],
    },
    {
      ...absent,
      classification: {
        kind: "recovery_required",
        reason: "exact_refund_receipt_not_final",
      },
      dependencies: [facts],
    },
    {
      ...absent,
      classification: {
        kind: "recovery_required",
        reason: "exact_refund_receipt_conflict",
      },
      dependencies: [facts],
    },
  ];
  for (const witness of witnesses)
    assert.equal(
      relayExactRefundRoleEvidence(prepared, new Map([[key, witness]])).get(
        key,
      ),
      witness,
    );
});
