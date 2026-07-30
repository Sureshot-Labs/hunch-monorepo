import assert from "node:assert/strict";

import { pollFundingReconciliationEvidence } from "../../reconciliation/funding-reducer.js";

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

console.log(
  "[funding-reconciliation-evidence-tests] owned destination evidence bypasses slow provider status, inactive waits use only relevant observers, and receipt checks remain authoritative",
);
