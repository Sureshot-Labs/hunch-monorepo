#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  assertWithdrawalActionPolicy,
  fundingActionPolicyIsCurrent,
  isReportableFundingActionKind,
} from "../../execution/operation-action-runtime.js";
import { FundingPersistenceError } from "../../persistence/funding-operation-repository.js";

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

console.log(
  "[funding-operation-action-policy-tests] withdrawal binding and reportable action policies passed",
);
