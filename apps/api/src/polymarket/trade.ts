// apps/api/src/polymarket/trade.ts
import { getClobClient } from "./client.js";
import { getMarketInfoBySlug } from "./markets.js";
import { Side, OrderType } from "@polymarket/clob-client";

/**
 * Place a GTC limit order by market slug + outcome.
 * price: 0.00..1.00 (dollars as probability)
 * size: number of shares
 * side: "BUY" | "SELL"
 * outcome: "YES" | "NO"
 */
export async function placeLimitBySlug(params: {
  slug: string;
  outcome: "YES" | "NO";
  side: "BUY" | "SELL";
  price: number;
  size: number;
}) {
  const client = await getClobClient();
  const m = await getMarketInfoBySlug(params.slug);

  const tokenID = params.outcome === "YES" ? m.yesToken : m.noToken;

  // createAndPostOrder wraps create + sign + POST
  // You MUST pass correct tickSize and negRisk from market metadata. :contentReference[oaicite:4]{index=4}
  const res = await client.createAndPostOrder(
    {
      tokenID,
      price: params.price,
      side: params.side === "BUY" ? Side.BUY : Side.SELL,
      size: params.size,
    },
    { tickSize: m.tickSize, negRisk: m.negRisk },
    OrderType.GTC
  );

  return res;
}

/** Cancel a single order by id/hash. Requires auth. */
export async function cancelOrder(id: string) {
  const client = await getClobClient();
  return client.cancel(id); // GET/POST under the hood with L2 header. :contentReference[oaicite:5]{index=5}
}

/** Cancel all open orders for the authenticated user. */
export async function cancelAll() {
  const client = await getClobClient();
  return client.cancelAll();
}
