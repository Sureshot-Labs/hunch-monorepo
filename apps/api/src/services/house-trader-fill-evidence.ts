import type { Pool } from "@hunch/infra";
import {
  parsePolymarketAssetContext,
  type PolymarketAssetContext,
} from "@hunch/shared";
import type {
  PolymarketFillCandidate,
  PolymarketFillObservation,
} from "./verified-buy-observer.js";

export const HOUSE_MAX_FILL_EVIDENCE = 32;
const transactionHash = (value: string | null) =>
  value && /^0x[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;

export const houseStoredOrderSql = `select id,venue_order_id,wallet_address,signer_address,token_id,side,
    order_payload->'assetContext' as asset_context,
    (coalesce(filled_size,0)>0 or lower(coalesce(status,'')) in
      ('matched','filled','partially_filled')) as has_execution
   from orders where order_hash=$1 and user_id=$2 and venue='polymarket' limit 2`;
export const houseStoredFillLocatorsSql = `select venue_trade_id,provider_tx_hash,provider_status from order_fills
   where order_id=$1 limit $2`;

type StoredHouseOrder =
  | {
      state: "ok";
      venueOrderId: string | null;
      fills: PolymarketFillCandidate[];
      hasExecution: boolean;
    }
  | { state: "conflict" | "limit" };

export async function readHouseStoredOrder(
  db: Pick<Pool, "query">,
  input: {
    userId: string;
    hash: string;
    owner: string;
    signer: string;
    asset: PolymarketAssetContext;
    side: "BUY" | "SELL";
  },
): Promise<StoredHouseOrder> {
  const { rows } = await db.query<{
    id: string;
    venue_order_id: string;
    wallet_address: string | null;
    signer_address: string | null;
    token_id: string | null;
    side: string | null;
    asset_context: unknown;
    has_execution: boolean;
  }>(houseStoredOrderSql, [input.hash, input.userId]);
  if (!rows.length)
    return { state: "ok", venueOrderId: null, fills: [], hasExecution: false };
  const [stored] = rows;
  const context = parsePolymarketAssetContext(stored.asset_context);
  const expected = parsePolymarketAssetContext(input.asset);
  if (
    rows.length !== 1 ||
    !stored.venue_order_id ||
    stored.wallet_address?.toLowerCase() !== input.owner.toLowerCase() ||
    stored.signer_address?.toLowerCase() !== input.signer.toLowerCase() ||
    stored.token_id !== input.asset.assetId ||
    stored.side?.toUpperCase() !== input.side ||
    !context ||
    !expected ||
    JSON.stringify(context) !== JSON.stringify(expected)
  )
    return { state: "conflict" };
  const { rows: fills } = await db.query<PolymarketFillCandidate>(
    houseStoredFillLocatorsSql,
    [stored.id, HOUSE_MAX_FILL_EVIDENCE + 1],
  );
  return fills.length > HOUSE_MAX_FILL_EVIDENCE
    ? { state: "limit" }
    : {
        state: "ok",
        venueOrderId: stored.venue_order_id,
        fills,
        hasExecution: stored.has_execution,
      };
}

// Acknowledgement hashes are only locations to read. They never authorize
// settlement without the exact finalized exchange and transfer evidence.
export function houseAcknowledgedTransactionHashes(
  payload: unknown,
  orderId: string,
  orderHash: string,
): string[] {
  if (
    orderId.toLowerCase() !== orderHash.toLowerCase() ||
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  )
    return [];
  const hashes = (payload as Record<string, unknown>).transactionsHashes;
  return readHouseTransactionHashes(hashes);
}

export function readHouseTransactionHashes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > HOUSE_MAX_FILL_EVIDENCE)
    return [];
  const hashes = value.map((hash) =>
    typeof hash === "string" ? transactionHash(hash) : null,
  );
  if (hashes.some((hash) => hash === null)) return [];
  return [...new Set(hashes.filter((hash): hash is string => hash !== null))];
}

export function resolveHouseFillLocators(
  local: readonly PolymarketFillCandidate[],
  remote: PolymarketFillObservation,
  hasSavedExecution = false,
): { hashes: string[] } | { pending: string } | { noFill: true } {
  if (remote.state === "identity_conflict")
    return { pending: "clob_evidence_identity_conflict" };
  const candidates = [
    ...local,
    ...(remote.state === "fills" ? remote.fills : []),
  ].filter((fill) => fill.provider_status?.toUpperCase() !== "FAILED");
  if (!candidates.length) {
    if (remote.state === "terminal_zero_fill")
      return hasSavedExecution
        ? { pending: "clob_zero_fill_conflicts_with_saved_execution" }
        : { noFill: true };
    return {
      pending:
        remote.state === "fills"
          ? "clob_fill_pending"
          : `clob_evidence_${remote.state}`,
    };
  }
  const byTrade = new Map<string, string>();
  const hashes = new Set<string>();
  for (const fill of candidates) {
    const hash = transactionHash(fill.provider_tx_hash);
    if (!hash) continue;
    hashes.add(hash);
    if (fill.venue_trade_id) {
      const previous = byTrade.get(fill.venue_trade_id);
      if (previous && previous !== hash)
        return { pending: "fill_transaction_identity_conflict" };
      byTrade.set(fill.venue_trade_id, hash);
    }
  }
  if (hashes.size > HOUSE_MAX_FILL_EVIDENCE)
    return { pending: "fill_evidence_limit_review" };
  if (
    candidates.some(
      (fill) =>
        !transactionHash(fill.provider_tx_hash) &&
        (!fill.venue_trade_id || !byTrade.has(fill.venue_trade_id)),
    )
  )
    return { pending: "fill_transaction_reference_pending" };
  return { hashes: [...hashes] };
}
