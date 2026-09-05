import { parsePrivyFundingTransactionReference } from "../execution/privy-transaction-reference.js";
import type { PrivyFundingReferenceResolver } from "../execution/privy-delegated-funding-driver.js";

export function positionActionPrivyReference(
  reference: string | null,
  executionMode: string,
) {
  return executionMode === "privy_authorization" && reference
    ? parsePrivyFundingTransactionReference(reference)
    : null;
}

/** Resolve acceptance to a hash only; receipt and payout checks still decide completion. */
export async function resolvePositionActionPrivyHash(input: {
  reference: string;
  executionMode: string;
  chainId: unknown;
  resolve: PrivyFundingReferenceResolver | null;
}): Promise<string | null> {
  const reference = positionActionPrivyReference(
    input.reference,
    input.executionMode,
  );
  if (
    !reference ||
    !Number.isSafeInteger(input.chainId) ||
    Number(input.chainId) <= 0 ||
    !input.resolve
  )
    return null;
  const result = await input.resolve(reference, `evm:${input.chainId}`);
  return result.kind === "submitted" &&
    /^0x[a-fA-F0-9]{64}$/.test(result.transactionReference)
    ? result.transactionReference.toLowerCase()
    : null;
}
