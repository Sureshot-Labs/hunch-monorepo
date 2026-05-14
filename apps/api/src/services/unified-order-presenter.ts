import type { UnifiedOrderRow } from "../repos/unified-orders.js";

const toNumber = (value: string | null): number | null => {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const OPEN_ORDER_STATUSES: string[] = [
  "pending",
  "submitted",
  "live",
  "partially_filled",
  "delayed",
  "unmatched",
  "open",
];

function normalizeUnifiedMarketIdForApi(
  venue: string,
  marketId: string | null,
): string | null {
  if (!marketId) return null;
  if (venue === "kalshi" && !marketId.includes(":") && /^KX/i.test(marketId)) {
    return `kalshi:${marketId}`;
  }
  return marketId;
}

export function mapUnifiedOrder(row: UnifiedOrderRow) {
  return {
    id: row.id,
    kind: row.kind,
    venue: row.venue,
    walletAddress: row.wallet_address,
    venueOrderId: row.venue_order_id,
    tokenId: row.token_id,
    side: row.side,
    outcome: row.outcome,
    orderType: row.order_type,
    price: toNumber(row.price),
    size: toNumber(row.size),
    status: row.status,
    filledSize: toNumber(row.filled_size),
    averageFillPrice: toNumber(row.average_fill_price),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    filledAt: row.filled_at,
    cancelledAt: row.cancelled_at,
    unifiedMarketId: normalizeUnifiedMarketIdForApi(
      row.venue,
      row.unified_market_id,
    ),
    inputMint: row.input_mint,
    outputMint: row.output_mint,
    amountIn: toNumber(row.amount_in),
    amountOut: toNumber(row.amount_out),
    inputDecimals: toNumber(row.input_decimals),
    outputDecimals: toNumber(row.output_decimals),
    txSignature: row.tx_signature,
  };
}
