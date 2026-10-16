import type { PoolClient } from "@hunch/infra";

/** Exactly the valid EVM namespace folded by migration 0327. Native ledger
 * identifiers and unsupported/malformed references retain their exact identity.
 */
export function canonicalFundingPhysicalTransactionHash(input: {
  networkId: string;
  transactionHash: string;
}): string | null {
  return ["evm:137", "evm:8453"].includes(input.networkId) &&
    /^0x[\da-f]{64}$/iu.test(input.transactionHash)
    ? input.transactionHash.toLowerCase()
    : null;
}

/** Exact physical-row contention, mapped to the SAME short ordinary evidence
 * retry as its advisory gate. Never use for unrelated SQL/transport failures.
 */
export class FundingPhysicalEventBusyError extends Error {
  readonly code = "55P03";
  readonly constraint = "funding_physical_event_busy";
  constructor() {
    super("Funding physical event evidence is busy");
    this.name = "FundingPhysicalEventBusyError";
  }
}

/** SAME namespace as the original handoff lock, now uniformly nonwaiting.
 * This gate serializes physical-key insertion only; it is not E/O/F authority.
 * Contention rolls back this evidence pass rather than waiting after O. */
export async function tryLockFundingPhysicalEvent(
  db: Pick<PoolClient, "query">,
  input: { networkId: string; transactionHash: string; eventIndex: string },
): Promise<void> {
  await db.query("select funding_try_lock_physical_event($1,$2,$3)", [
    input.networkId,
    input.transactionHash,
    input.eventIndex,
  ]);
}

export function fundingPhysicalEventIsBusy(error: unknown): boolean {
  // Receipt inspection deliberately collects independent failures. Only pure
  // contention may use the short retry; do not hide an RPC/integrity failure
  // merely because another receipt in the same batch was busy.
  if (error instanceof AggregateError)
    return (
      error.errors.length > 0 && error.errors.every(fundingPhysicalEventIsBusy)
    );
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "55P03" &&
    "constraint" in error &&
    error.constraint === "funding_physical_event_busy"
  );
}
