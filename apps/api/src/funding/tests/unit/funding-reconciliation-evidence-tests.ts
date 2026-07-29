import assert from "node:assert/strict";

import { pollFundingReconciliationEvidence } from "../../reconciliation/funding-reducer.js";

const calls: string[] = [];
await pollFundingReconciliationEvidence({
  operationId: "00000000-0000-4000-8000-000000000001",
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

console.log(
  "[funding-reconciliation-evidence-tests] owned destination evidence bypasses slow provider status without weakening receipt checks",
);
