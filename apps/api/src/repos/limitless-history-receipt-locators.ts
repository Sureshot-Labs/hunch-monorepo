import type { Pool } from "@hunch/infra";
import { normalizeLimitlessScopedTokenId } from "../lib/limitless-token.js";

type HistoryReceiptLocator = {
  tx_hash: string;
  provider_order_id: string | null;
};
export function limitlessHistoryProviderIdSql(
  payload = "order_payload",
): string {
  return `coalesce(${payload}->>'orderId',${payload}->>'order_id',
    ${payload}->>'venueOrderId',${payload}->>'venue_order_id',
    ${payload}->'order'->>'id',${payload}->'order'->>'orderId',${payload}->'order'->>'order_id')`;
}

export function limitlessHistoryClientIdSql(payload = "order_payload"): string {
  return `coalesce(${payload}->>'clientOrderId',${payload}->'submitted'->>'clientOrderId',${payload}->'_hunchSubmitted'->>'clientOrderId')`;
}
export function limitlessFrozenCollateralSql(
  payload = "order_payload",
): string {
  return `coalesce(coalesce(
    ${payload}->'_hunchLimitlessClob',
    ${payload}->'_hunchSubmitted'->'_hunchLimitlessClob',
    ${payload}->'submitted'->'_hunchLimitlessClob',
    ${payload}->'payload'->'_hunchLimitlessClob',
    ${payload}->'submitted'->'payload'->'_hunchLimitlessClob'
  ) ? 'collateralFeeModule',false)`;
}

/** History identifies candidate transactions, not signed fills. Client ID
 * uses the existing Copy expression index; provider ID uses a bounded wallet
 * page for older history with no client ID. */
export async function fetchLimitlessHistoryReceiptCandidates(
  db: Pick<Pool, "query">,
  input: {
    userId: string;
    walletAddress: string | null;
    tokenId: string | null;
    side: "BUY" | "SELL" | null;
    clientOrderId?: string | null;
    providerOrderId?: string | null;
  },
): Promise<HistoryReceiptLocator[]> {
  const tokenId = normalizeLimitlessScopedTokenId(input.tokenId);
  if (!input.walletAddress || !tokenId || !input.side) return [];
  const identity = [
    input.userId,
    input.walletAddress.toLowerCase(),
    tokenId,
    input.side,
  ];
  const found: HistoryReceiptLocator[] = [];
  if (input.clientOrderId) {
    const { rows } = await db.query<HistoryReceiptLocator>(
      `select distinct lower(order_hash) as tx_hash,
          ${limitlessHistoryProviderIdSql()} as provider_order_id from orders
        where user_id=$1 and venue='limitless' and lower(wallet_address)=$2
          and token_id=$3 and side=$4 and venue_order_id like 'history:%'
          and ${limitlessHistoryClientIdSql()}=$5
          and order_hash ~* '^0x[0-9a-f]{64}$' limit 5`,
      [...identity, input.clientOrderId],
    );
    found.push(...rows);
  }
  if (
    !input.providerOrderId ||
    found.some(
      (candidate) => candidate.provider_order_id === input.providerOrderId,
    )
  )
    return found;
  const { rows } = await db.query<HistoryReceiptLocator>(
    `with recent_wallet_orders as materialized (
      select order_hash, token_id, side, venue_order_id, order_payload from orders
      where user_id=$1 and venue='limitless' and lower(wallet_address)=$2
      order by coalesce(filled_at,last_update,posted_at) desc limit 128
    )
    select distinct lower(order_hash) as tx_hash,
      ${limitlessHistoryProviderIdSql()} as provider_order_id from recent_wallet_orders
    where token_id=$3 and side=$4 and venue_order_id like 'history:%'
      and order_hash ~* '^0x[0-9a-f]{64}$'
      and ${limitlessHistoryProviderIdSql()}=$5
    limit 5`,
    [...identity, input.providerOrderId],
  );
  return [...found, ...rows];
}

export async function fetchLimitlessHistoryReceiptLocators(
  db: Pick<Pool, "query">,
  input: Parameters<typeof fetchLimitlessHistoryReceiptCandidates>[1],
): Promise<string[]> {
  const candidates = await fetchLimitlessHistoryReceiptCandidates(db, input);
  return [...new Set(candidates.map(({ tx_hash }) => tx_hash))].slice(0, 4);
}
