import type { PoolClient } from "@hunch/infra";
import { canonicalFundingPhysicalTransactionHash } from "./funding-physical-event-gate.js";

/** All states and owners, after the common physical gate. A retained external
 * receive remains a financial claim even if a historical E/hash used another
 * casing. md5 is only an index hint; exact normalized equality is authority. */
export const FUNDING_EVM_RECEIVE_CLAIM_SQL = `select id from funding_receive_receipts
 where network_id=$1 and tx_hash is not null
   and md5(lower(tx_hash))=md5($2::text) and lower(tx_hash)=$2::text and event_index=$3
 limit 1`;

export async function hasFundingEvmReceiveClaim(
  db: Pick<PoolClient, "query">,
  event: { networkId: string; transactionHash: string; eventIndex: string },
): Promise<boolean> {
  const transactionHash = canonicalFundingPhysicalTransactionHash(event);
  if (transactionHash === null) return false; // native/unsupported identity unchanged
  return Boolean(
    (
      await db.query(FUNDING_EVM_RECEIVE_CLAIM_SQL, [
        event.networkId,
        transactionHash,
        event.eventIndex,
      ])
    ).rowCount,
  );
}
