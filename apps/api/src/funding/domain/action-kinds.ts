import type { NormalizedAction } from "./types.js";

const RECEIPT_BEARING_ACTION_KINDS = new Set<NormalizedAction["kind"]>([
  "evm_transaction",
  "evm_transaction_batch",
  "svm_transaction",
  "external_handoff",
]);

export function isReceiptBearingFundingActionKind(
  kind: NormalizedAction["kind"],
): boolean {
  return RECEIPT_BEARING_ACTION_KINDS.has(kind);
}
