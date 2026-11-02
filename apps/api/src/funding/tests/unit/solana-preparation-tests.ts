import assert from "node:assert/strict";
import {
  isExpiredSolanaPreparation,
  isClosedUnbroadcastSolanaPreparation,
} from "../../execution/solana-preparation.js";
import {
  fundingOperationActionPrepareRequestSchema,
  fundingOperationActionReportRequestSchema,
} from "../../../schemas/funding.js";

const now = new Date("2026-09-22T14:00:00Z");
const closure = {
  executorId: "wallet_profile_svm_v1",
  actionKind: "svm_transaction",
  outcome: "cancelled",
  broadcastMayHaveOccurred: false,
  referenceKind: null,
  actualCosts: {
    reasonCode: "solana_pre_submit_lease_expired",
    solanaPreparation: { version: 1, expiresAt: now.toISOString() },
  },
  now,
};
assert.equal(isClosedUnbroadcastSolanaPreparation(closure), true);
for (const override of [
  { executorId: "wallet_profile_evm_v1" },
  { actionKind: "evm_transaction" },
  { outcome: "started" },
  { broadcastMayHaveOccurred: true },
  { broadcastMayHaveOccurred: null },
  { referenceKind: "signature" },
  { actualCosts: null },
  {
    actualCosts: {
      ...closure.actualCosts,
      reasonCode: "client_execution_failed",
    },
  },
  { actualCosts: { ...closure.actualCosts, verifiedSolanaSubmission: null } },
  ...[
    null,
    {},
    { version: 2, expiresAt: now.toISOString() },
    { version: 1, expiresAt: "invalid" },
    { version: 1, expiresAt: "2026-09-22T14:00:01Z" },
  ].map((solanaPreparation) => ({
    actualCosts: { ...closure.actualCosts, solanaPreparation },
  })),
])
  assert.equal(
    isClosedUnbroadcastSolanaPreparation({ ...closure, ...override }),
    false,
  );
assert.equal(
  fundingOperationActionReportRequestSchema.safeParse({
    attemptId: "00000000-0000-4000-8000-000000000001",
    outcome: "cancelled",
    transactionReference: null,
    actualCosts: { networkFeeRaw: null, ...closure.actualCosts },
  }).success,
  false,
  "clients cannot forge server lease-closure metadata",
);
assert.equal(
  isExpiredSolanaPreparation({ version: 1, expiresAt: now.toISOString() }, now),
  true,
);
assert.equal(
  isExpiredSolanaPreparation(
    { version: 1, expiresAt: "2026-09-22T14:00:01Z" },
    now,
  ),
  false,
);
for (const value of [
  null,
  {},
  { version: 2, expiresAt: now.toISOString() },
  { version: 1, expiresAt: "invalid" },
  { version: 1, expiresAt: 0 },
]) {
  assert.equal(isExpiredSolanaPreparation(value, now), false);
}
assert.deepEqual(
  fundingOperationActionPrepareRequestSchema.parse({
    submissionProtocols: { solana: 1 },
  }),
  { submissionProtocols: { solana: 1 } },
);
assert.equal(
  fundingOperationActionPrepareRequestSchema.safeParse({
    submissionProtocols: { solana: 2 },
  }).success,
  false,
);
console.log("solana preparation tests passed");
