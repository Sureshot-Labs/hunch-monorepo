import { isRecord } from "../lib/type-guards.js";
import { normalizeOpenOrder } from "./polymarket-clob-l2.js";
import { decimalRaw } from "./recommended-spend-math.js";

/** A successful HTTP response is not proof of a complete or valid order set. */
export function readRecommendedSpendOrderPage(
  payload: unknown,
  wallet: string,
  seen: Set<string>,
) {
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.data) ||
    typeof payload.next_cursor !== "string" ||
    !payload.next_cursor
  ) {
    throw new Error("invalid_open_orders_page");
  }
  let lockedRaw = 0n;
  for (const raw of payload.data) {
    const order = normalizeOpenOrder(raw);
    if (
      !order?.id ||
      seen.has(order.id) ||
      !order.side ||
      !["BUY", "SELL"].includes(order.side.toUpperCase())
    )
      throw new Error("invalid_open_order");
    seen.add(order.id);
    if (order.side.toUpperCase() !== "BUY") continue;
    if (!order.makerAddress || !/^0x[0-9a-f]{40}$/i.test(order.makerAddress))
      throw new Error("invalid_order_wallet");
    const price = decimalRaw(order.price, 18);
    const original = decimalRaw(order.originalSize, 6);
    const matched = decimalRaw(order.sizeMatched, 6);
    if (price <= 0n || price >= 10n ** 18n || matched > original)
      throw new Error("invalid_order_amount");
    if (order.makerAddress.toLowerCase() !== wallet.toLowerCase()) continue;
    // Include any returned BUY reservation, including a still-pending immediate order.
    const product = price * (original - matched);
    lockedRaw += (product + 10n ** 18n - 1n) / 10n ** 18n;
  }
  return { lockedRaw, nextCursor: payload.next_cursor };
}
