import type { PoolClient } from "@hunch/infra";
import { isRecord } from "../../lib/type-guards.js";
import {
  fundingRefundReceiptMatchesContract,
  readFundingRefundContract,
  readFundingRefundReceiptIdentity,
} from "../domain/refund-settlement.js";
import {
  readCommittedFundingIdentity,
  refundSnapshotAccountIds,
} from "../domain/committed-economic-identity.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import type { FundingClassificationRevision } from "../persistence/funding-classification-revisions.js";
import { EXACT_REFUND_OBSERVER_ID } from "./relay-exact-refund-receipts.js";
import type { RefundCanonicalTarget } from "./relay-refund-canonical-proof.js";

export type RefundWatchRow = Readonly<{
  receipt_snapshot: string;
  user_id: string;
  classification_revision: string;
  operation_source_snapshot?: unknown;
  refund_location_snapshot: unknown;
  provider_quote_ref_lookup_hmac: string | null;
  lookup_key_version: number | null;
}>;

export const REFUND_CANONICAL_OPERATION_SQL = `select operation_row.user_id,
  coalesce(revision_row.revision,0)::text as classification_revision,
  operation_row.support_metadata->'exactRefundCanonicalWatch' as watch,
  exists(select 1 from funding_operation_segments segment_row where segment_row.operation_id=operation_row.id
    and segment_row.refund_location_snapshot ? 'refundEvidenceContract') as has_exact_contract
 from funding_operations operation_row
 left join funding_classification_revisions revision_row on revision_row.operation_id=operation_row.id
 where operation_row.id=$1::uuid`;

// The SAME statement captures receipt, current relational owner, frozen source,
// refund binding and revision. No newer revision is attached to an old proof.
const projection = `select to_jsonb(receipt_page)::text as receipt_snapshot,
  operation_row.user_id,operation_row.source_snapshot as operation_source_snapshot,
  coalesce(revision_row.revision,0)::text as classification_revision,
  segment_row.refund_location_snapshot,
  segment_row.provider_quote_ref_lookup_hmac,segment_row.lookup_key_version
 from receipt_page
 join lateral(select user_id,source_snapshot from funding_operations
   where id=receipt_page.operation_id offset 0) operation_row on true
 left join funding_classification_revisions revision_row on revision_row.operation_id=receipt_page.operation_id
 left join lateral(select refund_location_snapshot,provider_quote_ref_lookup_hmac,lookup_key_version
   from funding_operation_segments where id=receipt_page.segment_id
     and operation_id=receipt_page.operation_id and provider_id='relay' offset 0) segment_row on true
 order by receipt_page.id`;
export const REFUND_CANONICAL_PAGE_SQL = `with receipt_page as materialized(
 select * from funding_observations where operation_id=$1::uuid and kind='refund_credit'
   and id>$2::uuid order by id limit $3
) ${projection}`;
const receiptById = `select * from funding_observations observation_row
 where id=$1::uuid and operation_id=$2::uuid and kind='refund_credit'
   and ($3::jsonb is null or to_jsonb(observation_row)=$3::jsonb)`;
export const REFUND_CANONICAL_RECEIPT_SQL = `with receipt_page as materialized(${receiptById}) ${projection}`;
export const LOCK_REFUND_CANONICAL_RECEIPT_SQL = `with receipt_page as materialized(${receiptById} for update) ${projection}`;

export async function readRefundWatchReceipt(
  db: Pick<PoolClient, "query">,
  input: {
    receiptId: string;
    operationId: string;
    snapshot?: string;
    lock?: true;
  },
): Promise<RefundWatchRow | null> {
  return (
    (
      await db.query<RefundWatchRow>(
        input.lock
          ? LOCK_REFUND_CANONICAL_RECEIPT_SQL
          : REFUND_CANONICAL_RECEIPT_SQL,
        [input.receiptId, input.operationId, input.snapshot ?? null],
      )
    ).rows[0] ?? null
  );
}

/** Binding identity only: diagnostics and this transaction's own finality
 * changes do not prevent a fresh committed positive preparation. */
export function refundWatchBindingFingerprint(row: RefundWatchRow): string {
  return canonicalJsonHash([
    row.user_id,
    row.operation_source_snapshot ?? null,
    row.refund_location_snapshot ?? null,
    row.provider_quote_ref_lookup_hmac,
    row.lookup_key_version,
  ]);
}
export function refundWatchFacts(
  row: RefundWatchRow,
  operationId: string,
): FundingClassificationRevision {
  if (!/^\d+$/u.test(row.classification_revision))
    throw Error("refund watch facts missing");
  return {
    operationId,
    userId: row.user_id,
    revision: row.classification_revision,
  };
}

export function readRefundCanonicalTarget(
  row: RefundWatchRow,
): RefundCanonicalTarget | null {
  const receipt: unknown = JSON.parse(row.receipt_snapshot);
  if (
    !isRecord(receipt) ||
    !isRecord(receipt.metadata) ||
    receipt.metadata.observerId !== EXACT_REFUND_OBSERVER_ID
  )
    return null;
  const snapshot = row.refund_location_snapshot;
  const contract = readFundingRefundContract(snapshot, {
    requestFingerprint: row.provider_quote_ref_lookup_hmac,
    lookupKeyVersion: row.lookup_key_version,
  });
  const accountIds = refundSnapshotAccountIds(snapshot);
  if (
    !isRecord(snapshot) ||
    accountIds === null ||
    !readCommittedFundingIdentity({
      currentOwnerUserId: row.user_id,
      operationSourceSnapshot: row.operation_source_snapshot,
      accountIds,
    }) ||
    !contract?.supported ||
    typeof receipt.id !== "string" ||
    typeof receipt.network_id !== "string" ||
    typeof receipt.asset_id !== "string" ||
    typeof receipt.asset_decimals !== "number" ||
    typeof receipt.raw_amount !== "string" ||
    typeof receipt.tx_hash !== "string" ||
    typeof receipt.event_index !== "string" ||
    typeof receipt.to_address !== "string" ||
    typeof receipt.from_address !== "string"
  )
    return null;
  const target: RefundCanonicalTarget = {
    asset: {
      networkId: receipt.network_id,
      assetId: receipt.asset_id,
      decimals: receipt.asset_decimals,
    },
    txHash: receipt.tx_hash,
    eventIndex: receipt.event_index,
    rawAmount: receipt.raw_amount,
    fromAddress: receipt.from_address,
    toAddress: receipt.to_address,
    ledgerHeight:
      typeof receipt.ledger_height === "string" ? receipt.ledger_height : null,
    blockHash:
      typeof receipt.block_hash === "string" ? receipt.block_hash : null,
    nativeDex:
      receipt.metadata.nativeDestinationDex === "spot" ||
      receipt.metadata.nativeDestinationDex === ""
        ? receipt.metadata.nativeDestinationDex
        : null,
    nativeLedgerTime:
      typeof receipt.metadata.nativeLedgerTime === "number"
        ? receipt.metadata.nativeLedgerTime
        : null,
    nativeTransaction: receipt.metadata.relayRefundNativeTransaction,
  };
  return fundingRefundReceiptMatchesContract(contract, {
    observationId: receipt.id,
    money: { asset: target.asset, raw: target.rawAmount },
    destinationAddress: target.toAddress,
    nativeDestinationDex: target.nativeDex,
    identity: readFundingRefundReceiptIdentity(
      receipt.metadata.relayRefundReceipt,
    ),
    completionProofs: [],
  })
    ? target
    : null;
}
