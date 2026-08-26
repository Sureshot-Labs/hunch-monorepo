import type { NormalizedAction } from "./types.js";

const RECEIPT_BEARING_ACTION_KINDS = new Set<NormalizedAction["kind"]>([
  "evm_transaction",
  "evm_transaction_batch",
  "svm_transaction",
  "external_handoff",
]);

export function isReceiptBearingFundingActionKind(
  kind: string,
): kind is Exclude<NormalizedAction["kind"], "signature"> {
  return RECEIPT_BEARING_ACTION_KINDS.has(kind as NormalizedAction["kind"]);
}
