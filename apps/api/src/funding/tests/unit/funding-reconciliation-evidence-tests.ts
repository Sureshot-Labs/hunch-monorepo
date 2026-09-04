import assert from "node:assert/strict";

import {
  fundingReconciliationDisposition,
  fundingReconciliationErrorIsNonTransient,
  fundingReconciliationPollDelayMs,
  pollFundingReconciliationEvidence,
} from "../../reconciliation/funding-reducer.js";

const calls: string[] = [];
await pollFundingReconciliationEvidence({
  operationId: "00000000-0000-4000-8000-000000000001",
  state: { status: "in_progress", stage: "routing" },
  now: new Date("2026-07-29T13:24:00.000Z"),
  receiptPoll: async () => {
    calls.push("receipt");
    return { receiptsPolled: 1 };
  },
  postconditionPoll: async () => {
    calls.push("postcondition");
    return { postconditionsPolled: 1 };
  },
  destinationPoll: async () => {
    calls.push("destination");
    return { destinationsPolled: 1, destinationSatisfied: true };
  },
  providerPoll: async () => {
    calls.push("provider");
    throw new Error(
      "provider status must not gate authoritative destination evidence",
    );
  },
});

assert.equal(calls[0], "receipt");
assert.deepEqual(
  new Set(calls.slice(1)),
  new Set(["postcondition", "destination"]),
);
assert.equal(calls.includes("provider"), false);

let providerPolled = 0;
await pollFundingReconciliationEvidence({
  operationId: "00000000-0000-4000-8000-000000000002",
  state: { status: "in_progress", stage: "routing" },
  now: new Date("2026-07-29T13:24:01.000Z"),
  destinationPoll: async () => ({
    destinationsPolled: 1,
    destinationSatisfied: false,
  }),
  providerPoll: async () => {
    providerPolled += 1;
    return { requestsPolled: 1 };
  },
});
assert.equal(providerPolled, 1);

const terminalRefundCalls: string[] = [];
await pollFundingReconciliationEvidence({
  operationId: "00000000-0000-4000-8000-000000000008",
  state: { status: "refunded", stage: "terminal" },
  terminalReceiptWatch: true,
  terminalRelayRefundWatch: true,
  now: new Date("2026-07-29T13:24:01.250Z"),
  providerPoll: async () => {
    terminalRefundCalls.push("provider");
    return { requestsPolled: 1 };
  },
  destinationPoll: async () => {
    terminalRefundCalls.push("destination");
    return { destinationsPolled: 1, destinationSatisfied: true };
  },
});
assert.deepEqual(terminalRefundCalls, ["provider", "destination"]);

const terminalRefundProviderFailureCalls: string[] = [];
await pollFundingReconciliationEvidence({
  operationId: "00000000-0000-4000-8000-000000000009",
  state: { status: "refunded", stage: "terminal" },
  terminalReceiptWatch: true,
  terminalRelayRefundWatch: true,
  now: new Date("2026-07-29T13:24:01.375Z"),
  providerPoll: async () => {
    terminalRefundProviderFailureCalls.push("provider");
    throw new Error("relay status is temporarily unavailable");
  },
  destinationPoll: async () => {
    terminalRefundProviderFailureCalls.push("destination");
    return { destinationsPolled: 1, destinationSatisfied: true };
  },
});
assert.deepEqual(terminalRefundProviderFailureCalls, [
  "provider",
  "destination",
]);

const terminalRefundReceiptFailureCalls: string[] = [];
const terminalReceiptFailure = await pollFundingReconciliationEvidence({
  operationId: "00000000-0000-4000-8000-000000000010",
  state: { status: "refunded", stage: "terminal" },
  terminalReceiptWatch: true,
  terminalRelayRefundWatch: true,
  now: new Date("2026-07-29T13:24:01.437Z"),
  receiptPoll: async () => {
    terminalRefundReceiptFailureCalls.push("receipt");
    throw new Error("receipt RPC is temporarily unavailable");
  },
  providerPoll: async () => {
    terminalRefundReceiptFailureCalls.push("provider");
    return { requestsPolled: 1 };
  },
  destinationPoll: async () => {
    terminalRefundReceiptFailureCalls.push("destination");
    return { destinationsPolled: 1, destinationSatisfied: true };
  },
});
assert.deepEqual(terminalRefundReceiptFailureCalls, [
  "receipt",
  "provider",
  "destination",
]);
assert.equal(terminalReceiptFailure.terminalReceiptPollFailed, true);

for (const terminalStatus of ["completed", "failed", "cancelled"] as const) {
  const terminalReceiptFailureResult = await pollFundingReconciliationEvidence({
    operationId: "00000000-0000-4000-8000-000000000011",
    state: { status: terminalStatus, stage: "terminal" },
    terminalReceiptWatch: true,
    now: new Date("2026-07-29T13:24:01.500Z"),
    receiptPoll: async () => {
      throw new Error(`${terminalStatus} receipt RPC is unavailable`);
    },
    destinationPoll: async () => ({
      destinationsPolled: 1,
      destinationSatisfied: true,
    }),
  });
  assert.equal(
    terminalReceiptFailureResult.terminalReceiptPollFailed,
    true,
    `${terminalStatus} Relay receipt verification must use bounded handling`,
  );
}

const actionWaitCalls: string[] = [];
await pollFundingReconciliationEvidence({
  operationId: "00000000-0000-4000-8000-000000000007",
  state: { status: "in_progress", stage: "source_action" },
  awaitingUnbroadcastActionReport: true,
  now: new Date("2026-07-29T13:24:01.500Z"),
  receiptPoll: async () => {
    actionWaitCalls.push("receipt");
    return { receiptsPolled: 0 };
  },
  postconditionPoll: async () => {
    actionWaitCalls.push("postcondition");
    return { postconditionsPolled: 0 };
  },
  destinationPoll: async () => {
    actionWaitCalls.push("destination");
    return { destinationsPolled: 0, destinationSatisfied: false };
  },
  providerPoll: async () => {
    actionWaitCalls.push("provider");
    return { requestsPolled: 0 };
  },
});
assert.deepEqual(actionWaitCalls, []);

const failedReceiptWatchCalls: string[] = [];
await pollFundingReconciliationEvidence({
  operationId: "00000000-0000-4000-8000-000000000012",
  state: { status: "in_progress", stage: "source_action" },
  awaitingUnbroadcastActionReport: true,
  recentFailedReceiptWatch: true,
  now: new Date("2026-07-29T13:24:01.750Z"),
  receiptPoll: async () => {
    failedReceiptWatchCalls.push("receipt");
    return { receiptsPolled: 1 };
  },
  postconditionPoll: async () => {
    failedReceiptWatchCalls.push("postcondition");
    return { postconditionsPolled: 0 };
  },
  destinationPoll: async () => {
    failedReceiptWatchCalls.push("destination");
    return { destinationsPolled: 0, destinationSatisfied: false };
  },
  providerPoll: async () => {
    failedReceiptWatchCalls.push("provider");
    return { requestsPolled: 0 };
  },
});
assert.equal(
  failedReceiptWatchCalls[0],
  "receipt",
  "a recent canonical failure must remain under receipt polling even while the retry action is awaiting a report",
);
assert.deepEqual(
  new Set(failedReceiptWatchCalls.slice(1)),
  new Set(["postcondition", "destination", "provider"]),
);
assert.equal(
  fundingReconciliationPollDelayMs(
    { status: "in_progress", stage: "source_action" },
    {
      activePollDelayMs: 2_000,
      idlePollDelayMs: 15_000,
      awaitingUnbroadcastActionReport: true,
    },
  ),
  15_000,
);

const awaitingUserCalls: string[] = [];
await pollFundingReconciliationEvidence({
  operationId: "00000000-0000-4000-8000-000000000003",
  state: { status: "awaiting_user", stage: "source_action" },
  now: new Date("2026-07-29T13:24:02.000Z"),
  receiptPoll: async () => {
    awaitingUserCalls.push("receipt");
    return { receiptsPolled: 0 };
  },
  destinationPoll: async () => {
    awaitingUserCalls.push("destination");
    return { destinationsPolled: 0, destinationSatisfied: false };
  },
  providerPoll: async () => {
    awaitingUserCalls.push("provider");
    return { requestsPolled: 0 };
  },
});
assert.deepEqual(awaitingUserCalls, ["receipt"]);

const awaitingExternalCalls: string[] = [];
await pollFundingReconciliationEvidence({
  operationId: "00000000-0000-4000-8000-000000000004",
  state: { status: "awaiting_external_funds", stage: "source_action" },
  now: new Date("2026-07-29T13:24:03.000Z"),
  postconditionPoll: async () => {
    awaitingExternalCalls.push("postcondition");
    return { postconditionsPolled: 0 };
  },
  destinationPoll: async () => {
    awaitingExternalCalls.push("destination");
    return { destinationsPolled: 0, destinationSatisfied: false };
  },
  providerPoll: async () => {
    awaitingExternalCalls.push("provider");
    return { requestsPolled: 0 };
  },
});
assert.deepEqual(
  new Set(awaitingExternalCalls),
  new Set(["postcondition", "destination"]),
);

const automaticRecoveryCalls: string[] = [];
await pollFundingReconciliationEvidence({
  operationId: "00000000-0000-4000-8000-000000000005",
  state: { status: "recovery_required", stage: "routing" },
  recoveryMode: "automatic_evidence",
  now: new Date("2026-07-29T13:24:04.000Z"),
  receiptPoll: async () => {
    automaticRecoveryCalls.push("receipt");
    return { receiptsPolled: 0 };
  },
  providerPoll: async () => {
    automaticRecoveryCalls.push("provider");
    return { requestsPolled: 0 };
  },
});
assert.deepEqual(automaticRecoveryCalls, ["receipt", "provider"]);
assert.equal(
  fundingReconciliationPollDelayMs(
    { status: "recovery_required", stage: "routing" },
    {
      activePollDelayMs: 1_000,
      idlePollDelayMs: 5_000,
      recoveryPollDelayMs: 60_000,
    },
  ),
  60_000,
);
const broadcastAttemptStartedAt = new Date("2026-07-29T13:24:00.000Z");
const broadcastEvidenceActiveUntil = new Date(
  broadcastAttemptStartedAt.getTime() + 90_000,
);
assert.equal(
  fundingReconciliationPollDelayMs(
    { status: "recovery_required", stage: "source_action" },
    {
      activePollDelayMs: 2_000,
      broadcastEvidenceActiveUntil,
      idlePollDelayMs: 15_000,
      now: new Date("2026-07-29T13:24:30.000Z"),
      recoveryMode: "automatic_evidence",
      recoveryPollDelayMs: 60_000,
    },
  ),
  2_000,
  "a recent Base, Polygon, or Solana broadcast must keep using active RPC polling while automatic evidence can still arrive",
);
assert.equal(
  fundingReconciliationPollDelayMs(
    { status: "recovery_required", stage: "source_action" },
    {
      activePollDelayMs: 2_000,
      broadcastEvidenceActiveUntil,
      idlePollDelayMs: 15_000,
      now: broadcastEvidenceActiveUntil,
      recoveryMode: "automatic_evidence",
      recoveryPollDelayMs: 60_000,
    },
  ),
  60_000,
  "the bounded active receipt window must fall back to the recovery cadence at its deadline",
);
assert.equal(
  fundingReconciliationPollDelayMs(
    { status: "recovery_required", stage: "source_action" },
    {
      activePollDelayMs: 2_000,
      broadcastEvidenceActiveUntil,
      idlePollDelayMs: 15_000,
      now: new Date("2026-07-29T13:24:30.000Z"),
      recoveryMode: "manual_review",
      recoveryPollDelayMs: 60_000,
    },
  ),
  60_000,
  "manual recovery must never be converted into an automatic hot poll",
);

assert.equal(
  fundingReconciliationErrorIsNonTransient({
    code: "invalid_state_transition",
  }),
  true,
);
assert.equal(
  fundingReconciliationErrorIsNonTransient({
    code: "provider_unavailable",
    retryable: true,
  }),
  false,
);
assert.equal(
  fundingReconciliationDisposition({
    state: { status: "recovery_required", stage: "routing" },
    recoveryMode: "automatic_evidence",
    reductionCompleted: false,
    reconciliationStartedAt: new Date("2026-07-29T13:20:00.000Z"),
    now: new Date("2026-07-29T13:24:04.000Z"),
    terminalTimeoutMs: 90_000,
  }),
  "requeue",
);

const manualRecoveryCalls: string[] = [];
await pollFundingReconciliationEvidence({
  operationId: "00000000-0000-4000-8000-000000000006",
  state: { status: "recovery_required", stage: "routing" },
  recoveryMode: "manual_review",
  now: new Date("2026-07-29T13:24:05.000Z"),
  receiptPoll: async () => {
    manualRecoveryCalls.push("receipt");
    return { receiptsPolled: 0 };
  },
  providerPoll: async () => {
    manualRecoveryCalls.push("provider");
    return { requestsPolled: 0 };
  },
});
assert.deepEqual(manualRecoveryCalls, []);
assert.equal(
  fundingReconciliationDisposition({
    state: { status: "recovery_required", stage: "routing" },
    recoveryMode: "manual_review",
    reductionCompleted: false,
    reconciliationStartedAt: new Date("2026-07-29T13:20:00.000Z"),
    now: new Date("2026-07-29T13:24:05.000Z"),
    terminalTimeoutMs: 90_000,
  }),
  "complete",
);

console.log(
  "[funding-reconciliation-evidence-tests] action waits skip external polling, terminal refunds keep receipt and provider refreshes best-effort so their failures cannot block replacement scans, owned destination evidence bypasses slow provider status, recent automatic-recovery broadcasts keep a bounded active RPC cadence, and manual recovery has no hot loop",
);
