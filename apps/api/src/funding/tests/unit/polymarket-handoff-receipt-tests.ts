import assert from "node:assert/strict";
import { test } from "node:test";
import { readFinalizedPolymarketHandoffReceipt } from "../../domain/polymarket-handoff-binding.js";
import { RELAY_PINNED_ASSETS } from "../../../funding-providers/relay/mappings.js";

type Proof = Parameters<typeof readFinalizedPolymarketHandoffReceipt>[0];
const now = new Date("2026-10-16T09:00:00Z");
function fixture(): Proof {
  const asset = {
    networkId: "evm:137",
    assetId: RELAY_PINNED_ASSETS.polygonPusd,
    decimals: 6,
  };
  const funder = `0x${"ab".repeat(20)}`,
    controller = `0x${"cd".repeat(20)}`;
  const rawAmount = "10000000",
    tx = `0x${"ef".repeat(32)}`,
    blockHash = `0x${"bc".repeat(32)}`;
  const reservation = {
    segmentOrdinal: 0,
    componentId: "venue-component",
    locationId: "venue-location",
    networkId: asset.networkId,
    assetId: asset.assetId,
    assetDecimals: 6,
    rawAmount,
    mode: "subtract_available" as const,
    expiresAt: now.toISOString(),
  };
  return {
    operationId: "expected-operation",
    binding: {
      economicSource: {
        kind: "venue_account",
        accountId: "original-owner",
        locationId: "venue-location",
        asset,
        details: { address: funder },
      },
      executionSource: {
        kind: "wallet",
        accountId: "original-owner",
        locationId: "controller-location",
        asset,
        details: { address: controller },
      },
      sourceReservation: reservation,
      controllerFence: {
        ...reservation,
        segmentOrdinal: null,
        componentId: "controller-component",
        locationId: "controller-location",
        economicRole: "future_credit_fence",
      },
      handoffOrdinal: 2,
      handoffFingerprint: "same-exact-transfer",
      handoffExecutorId: "polymarket_deposit_wallet_relayer_v1",
      rawAmount,
    },
    attempt: {
      operationId: "expected-operation",
      id: "expected-attempt",
      stepId: "expected-step",
      stepOrdinal: 2,
      actionFingerprint: "same-exact-transfer",
      executorId: "polymarket_deposit_wallet_relayer_v1",
      broadcastMayHaveOccurred: true,
    },
    receipt: {
      operationId: "expected-operation",
      stepId: "expected-step",
      attemptId: "expected-attempt",
      networkId: asset.networkId,
      status: "finalized",
      actionMatch: true,
      ledgerHeight: "123",
      blockHash,
      canonical: true,
      failureCode: null,
      evidence: {
        transactionHash: tx,
        handoffEventIndex: "4",
        handoffOwnedPhysicalEventV1: {
          transactionHash: tx,
          handoffEventIndex: "4",
          ledgerHeight: "123",
          blockHash,
        },
      },
      firstSeenAt: now,
      observedAt: now,
      finalizedAt: now,
      reorgedAt: null,
    },
    event: {
      network_id: asset.networkId,
      tx_hash: tx,
      event_index: "4",
      asset_id: asset.assetId,
      asset_decimals: 6,
      source_address: funder,
      destination_address: controller,
      raw_amount: rawAmount,
      ledger_height: "123",
      block_hash: blockHash,
      allocation_status: "recovery_required",
      allocation_error_code: "internal_handoff_suppressed",
      allocated_receipt_id: null,
      allocated_receive_session_id: null,
    },
  };
}

test("finalized handoff proof retains first finality observation, not Transfer time or subsequent poll time", () => {
  const proof = fixture();
  const expected = {
    transactionHash: proof.event.tx_hash,
    eventIndex: "4",
    rawAmount: "10000000",
    finalityObservedAt: now.toISOString(),
  };
  assert.deepEqual(readFinalizedPolymarketHandoffReceipt(proof), expected);
  assert.deepEqual(
    readFinalizedPolymarketHandoffReceipt({
      ...proof,
      receipt: {
        ...proof.receipt,
        observedAt: new Date(now.getTime() + 60000),
      },
    }),
    expected,
  );
});

test("identical transfer fingerprints cannot borrow another operation/step/attempt proof", () => {
  const proof = fixture();
  for (const invalid of [
    { ...proof, operationId: "another-operation" },
    {
      ...proof,
      receipt: { ...proof.receipt, operationId: "another-operation" },
    },
    {
      ...proof,
      attempt: { ...proof.attempt, operationId: "another-operation" },
    },
    {
      ...proof,
      receipt: { ...proof.receipt, operationId: "another-operation" },
      attempt: { ...proof.attempt, operationId: "another-operation" },
    },
    { ...proof, receipt: { ...proof.receipt, stepId: "another-step" } },
    { ...proof, receipt: { ...proof.receipt, attemptId: "another-attempt" } },
    { ...proof, attempt: { ...proof.attempt, stepOrdinal: 0 } },
    {
      ...proof,
      attempt: { ...proof.attempt, actionFingerprint: "another-action" },
    },
    { ...proof, attempt: { ...proof.attempt, executorId: "another-executor" } },
    {
      ...proof,
      attempt: { ...proof.attempt, broadcastMayHaveOccurred: false },
    },
  ])
    assert.equal(readFinalizedPolymarketHandoffReceipt(invalid), null);
});

test("nonfinal/reorged/unowned/conflicting physical evidence is unknown, not a handoff debit", () => {
  const proof = fixture();
  const invalid: Proof[] = [
    { ...proof, receipt: { ...proof.receipt, status: "confirmed" } },
    { ...proof, receipt: { ...proof.receipt, status: "pending" } },
    {
      ...proof,
      receipt: { ...proof.receipt, status: "reorged", canonical: false },
    },
    { ...proof, receipt: { ...proof.receipt, reorgedAt: now } },
    { ...proof, receipt: { ...proof.receipt, actionMatch: false } },
    { ...proof, receipt: { ...proof.receipt, failureCode: "wrong-envelope" } },
    {
      ...proof,
      receipt: {
        ...proof.receipt,
        evidence: {
          transactionHash: proof.event.tx_hash,
          handoffEventIndex: "4",
        },
      },
    },
    { ...proof, receipt: { ...proof.receipt, finalizedAt: null } },
    {
      ...proof,
      event: {
        ...proof.event,
        allocation_error_code: "internal_event_classification_conflict",
      },
    },
    {
      ...proof,
      event: { ...proof.event, allocated_receipt_id: "another-receipt" },
    },
    {
      ...proof,
      event: {
        ...proof.event,
        allocated_receive_session_id: "another-session",
      },
    },
    { ...proof, event: { ...proof.event, raw_amount: "9999999" } },
    { ...proof, event: { ...proof.event, asset_decimals: 8 } },
    {
      ...proof,
      event: { ...proof.event, asset_id: RELAY_PINNED_ASSETS.polygonUsdc },
    },
    {
      ...proof,
      event: {
        ...proof.event,
        source_address: proof.event.destination_address,
      },
    },
    {
      ...proof,
      event: {
        ...proof.event,
        destination_address: proof.event.source_address ?? "",
      },
    },
    { ...proof, event: { ...proof.event, event_index: "5" } },
    { ...proof, event: { ...proof.event, ledger_height: "124" } },
    { ...proof, event: { ...proof.event, block_hash: `0x${"12".repeat(32)}` } },
  ];
  for (const row of invalid)
    assert.equal(readFinalizedPolymarketHandoffReceipt(row), null);
});
