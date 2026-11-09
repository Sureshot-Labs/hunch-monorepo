import assert from "node:assert/strict";
import {
  FUNDING_EVIDENCE_REPAIR_REVISION,
  fundingReceiptSourceKey,
  initialFundingEvidenceRepairState,
  intrinsicFundingReceiptSourceKeys,
  parseFundingEvidenceRepairState,
  sanitizeFundingEvidenceRepairProbe,
} from "../../reconciliation/funding-evidence-repair-state.js";

const source = {
  action: {
    kind: "evm_transaction",
    to: "private-target",
    data: "private-data",
  },
  receiptRefLookupHmac: "internal-hmac",
  lookupKeyVersion: 1,
  payerRequirement: "user",
  actionValidationResult: { signerAddress: "private-signer" },
};
const key = fundingReceiptSourceKey(source);
assert.match(key, /^[a-f0-9]{64}$/);
assert.notEqual(
  key,
  fundingReceiptSourceKey({ ...source, receiptRefLookupHmac: "replacement" }),
);
assert.notEqual(
  key,
  fundingReceiptSourceKey({ ...source, payerRequirement: "privy_sponsor" }),
);
assert.notEqual(
  key,
  fundingReceiptSourceKey({ ...source, lookupKeyVersion: 2 }),
);
const mask = {
  chain: true,
  from: false,
  to: false,
  calldata: false,
  value: true,
};
const safe = sanitizeFundingEvidenceRepairProbe({
  outcome: "intrinsic_mismatch",
  status: "mismatch",
  matchingMask: mask,
  transactionHash: "secret-reference",
  address: "secret-address",
  message: "https://private-rpc/key",
});
assert.deepEqual(safe, {
  outcome: "intrinsic_mismatch",
  status: "mismatch",
  matchingMask: mask,
});
assert.ok(safe);
assert.ok(!JSON.stringify(safe).includes("secret"));
assert.equal(
  sanitizeFundingEvidenceRepairProbe({ status: "provider-private-message" }),
  null,
);
assert.equal(
  sanitizeFundingEvidenceRepairProbe({
    outcome: "intrinsic_mismatch",
    status: "pending",
    matchingMask: mask,
  })?.outcome,
  "observed",
);
const initial = initialFundingEvidenceRepairState();
const waiting = {
  ...initial,
  state: "waiting_evidence" as const,
  sourceProbes: { [key]: safe },
  lastProbe: safe,
};
assert.deepEqual(intrinsicFundingReceiptSourceKeys(waiting), [key]);
assert.deepEqual(
  intrinsicFundingReceiptSourceKeys({
    ...waiting,
    evaluatorRevision: "future-parser",
  }),
  [],
);
assert.deepEqual(
  intrinsicFundingReceiptSourceKeys({ ...waiting, generation: 1 }),
  [],
);
assert.equal(
  parseFundingEvidenceRepairState({ ...waiting, formatVersion: 2 }),
  null,
);
assert.equal(
  parseFundingEvidenceRepairState({ ...waiting, generation: -1 }),
  null,
);
assert.equal(
  parseFundingEvidenceRepairState({ ...waiting, processedGeneration: 1 }),
  null,
);
assert.deepEqual(parseFundingEvidenceRepairState(waiting), waiting);
assert.equal(initial.evaluatorRevision, FUNDING_EVIDENCE_REPAIR_REVISION);
console.log(
  "[funding-evidence-repair-state-tests] sanitized intrinsic evidence, reference/revision invalidation, and explicit-generation bypass passed",
);
