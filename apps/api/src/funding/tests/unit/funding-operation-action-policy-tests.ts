#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  assertWithdrawalActionPolicy,
  fundingActionPolicyIsCurrent,
  isReportableFundingActionKind,
} from "../../execution/operation-action-runtime.js";
import {
  FUNDING_OPERATION_RECONCILIATION_TTL_MS,
  fundingOperationExpiresAt,
  FundingPersistenceError,
  type FundingCommitPlan,
} from "../../persistence/funding-operation-repository.js";

assert.equal(
  assertWithdrawalActionPolicy({
    purpose: "add_funds",
    externalRecipientId: null,
  }),
  null,
);
assert.equal(
  assertWithdrawalActionPolicy({
    purpose: "withdrawal",
    externalRecipientId: "recipient_withdrawal_12345678",
  }),
  "recipient_withdrawal_12345678",
);
assert.throws(
  () =>
    assertWithdrawalActionPolicy({
      purpose: "add_funds",
      externalRecipientId: "recipient_withdrawal_12345678",
    }),
  (error) =>
    error instanceof FundingPersistenceError && error.code === "quote_mismatch",
);

const committedPolicy = {
  policyRevision: "compact-policy-revision",
  policyVersion: 1,
};
assert.equal(
  fundingActionPolicyIsCurrent(committedPolicy, {
    revision: "compact-policy-revision",
    runtime: { contractVersion: 1 },
  }),
  true,
);
assert.equal(
  fundingActionPolicyIsCurrent(committedPolicy, {
    revision: "compact-policy-revision",
    runtime: { contractVersion: 2 },
  }),
  false,
);
assert.equal(
  fundingActionPolicyIsCurrent(committedPolicy, {
    revision: "new-compact-policy-revision",
    runtime: { contractVersion: 1 },
  }),
  false,
);

assert.equal(isReportableFundingActionKind("evm_transaction"), true);
assert.equal(isReportableFundingActionKind("evm_transaction_batch"), true);
assert.equal(isReportableFundingActionKind("svm_transaction"), true);
assert.equal(isReportableFundingActionKind("external_handoff"), true);
assert.equal(isReportableFundingActionKind("signature"), false);

const now = new Date("2026-08-12T12:00:00.000Z");
const providerDeadline = new Date(now.getTime() + 20_000);
const operationExpiry = fundingOperationExpiresAt(now, providerDeadline, {
  segments: [{ quoteExpiresAt: providerDeadline.toISOString() }],
  reservations: [],
  steps: [],
} as unknown as FundingCommitPlan);
assert.equal(
  operationExpiry.toISOString(),
  new Date(
    now.getTime() + FUNDING_OPERATION_RECONCILIATION_TTL_MS,
  ).toISOString(),
);
const reservationDeadline = new Date(now.getTime() + 10_000);
assert.equal(
  fundingOperationExpiresAt(now, providerDeadline, {
    segments: [{ quoteExpiresAt: providerDeadline.toISOString() }],
    reservations: [{ expiresAt: reservationDeadline.toISOString() }],
    steps: [],
  } as unknown as FundingCommitPlan).toISOString(),
  operationExpiry.toISOString(),
);
assert.throws(
  () =>
    fundingOperationExpiresAt(now, providerDeadline, {
      segments: [{ quoteExpiresAt: now.toISOString() }],
      reservations: [],
      steps: [],
    } as unknown as FundingCommitPlan),
  (error) =>
    error instanceof FundingPersistenceError && error.code === "quote_expired",
);

console.log(
  "[funding-operation-action-policy-tests] withdrawal binding and reportable action policies passed",
);
