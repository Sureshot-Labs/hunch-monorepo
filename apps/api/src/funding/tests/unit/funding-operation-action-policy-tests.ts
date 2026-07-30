#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  assertWithdrawalActionPolicy,
  isReportableFundingActionKind,
} from "../../execution/operation-action-runtime.js";
import { FundingPersistenceError } from "../../persistence/funding-operation-repository.js";
import { DEFAULT_FUNDING_RUNTIME_POLICY } from "../../policies/funding-policy.js";

const enabledPolicy = {
  ...DEFAULT_FUNDING_RUNTIME_POLICY,
  gates: {
    ...DEFAULT_FUNDING_RUNTIME_POLICY.gates,
    withdrawalExecution: true,
  },
};

assert.equal(
  assertWithdrawalActionPolicy(
    { purpose: "add_funds", externalRecipientId: null },
    enabledPolicy,
  ),
  null,
);
assert.equal(
  assertWithdrawalActionPolicy(
    {
      purpose: "withdrawal",
      externalRecipientId: "recipient_withdrawal_12345678",
    },
    enabledPolicy,
  ),
  "recipient_withdrawal_12345678",
);
assert.throws(
  () =>
    assertWithdrawalActionPolicy(
      {
        purpose: "withdrawal",
        externalRecipientId: "recipient_withdrawal_12345678",
      },
      DEFAULT_FUNDING_RUNTIME_POLICY,
    ),
  (error) =>
    error instanceof FundingPersistenceError &&
    error.code === "quote_invalidated",
);
assert.throws(
  () =>
    assertWithdrawalActionPolicy(
      {
        purpose: "add_funds",
        externalRecipientId: "recipient_withdrawal_12345678",
      },
      enabledPolicy,
    ),
  (error) =>
    error instanceof FundingPersistenceError && error.code === "quote_mismatch",
);

assert.equal(isReportableFundingActionKind("evm_transaction"), true);
assert.equal(isReportableFundingActionKind("evm_transaction_batch"), true);
assert.equal(isReportableFundingActionKind("svm_transaction"), true);
assert.equal(isReportableFundingActionKind("external_handoff"), true);
assert.equal(isReportableFundingActionKind("signature"), false);

console.log(
  "[funding-operation-action-policy-tests] withdrawal and reportable action policies passed",
);
