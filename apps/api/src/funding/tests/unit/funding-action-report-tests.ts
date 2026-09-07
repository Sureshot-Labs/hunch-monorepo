import assert from "node:assert/strict";
import {
  isFundingActionFailureReportConsistent,
  isUnreferencedFundingActionAmbiguity,
  normalizeFundingActionReport,
} from "../../execution/action-report.js";

const genericFailure = {
  outcome: "failed",
  failureCode: "client_execution_failed",
  transactionReference: null,
} as const;
const ambiguous = normalizeFundingActionReport(genericFailure);
assert.equal(isFundingActionFailureReportConsistent(genericFailure), true);
assert.equal(ambiguous.outcome, "ambiguous");
assert.equal(isUnreferencedFundingActionAmbiguity(ambiguous), true);
assert.deepEqual(normalizeFundingActionReport(ambiguous), ambiguous);
assert.equal(genericFailure.outcome, "failed", "normalization is immutable");

for (const failureCode of [
  "embedded_evm_submission_unknown",
  "external_handoff_submission_unknown",
  "external_handoff_provider_response_invalid",
] as const) {
  assert.equal(
    isFundingActionFailureReportConsistent({ ...genericFailure, failureCode }),
    false,
    "explicit submission uncertainty cannot claim a definitive failure",
  );
  const report = { ...ambiguous, failureCode };
  assert.equal(isFundingActionFailureReportConsistent(report), true);
  assert.equal(isUnreferencedFundingActionAmbiguity(report), true);
}
for (const report of [
  { ...genericFailure, failureCode: "external_handoff_provider_rejected" },
  { ...genericFailure, outcome: "cancelled", failureCode: null },
  {
    ...genericFailure,
    outcome: "submitted",
    failureCode: null,
    transactionReference: `0x${"a".repeat(64)}`,
  },
] as const) {
  assert.equal(normalizeFundingActionReport(report), report);
  assert.equal(isFundingActionFailureReportConsistent(report), true);
  assert.equal(isUnreferencedFundingActionAmbiguity(report), false);
}
assert.equal(
  isFundingActionFailureReportConsistent({
    ...genericFailure,
    transactionReference: `0x${"a".repeat(64)}`,
  }),
  false,
  "a generic error must not override an independently supplied receipt",
);
console.log("Funding action report safety tests passed");
