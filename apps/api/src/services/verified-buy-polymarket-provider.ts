import { isRecord } from "../lib/type-guards.js";
import {
  extractSingleOrder,
  type fetchPolymarketOrderByHash,
  type fetchPolymarketTrades,
} from "./polymarket-clob-l2.js";
import { EvidenceBudgetExhausted } from "./verified-buy.js";
import {
  terminalZeroFill,
  type PolymarketFillCandidate,
  type PolymarketFillObservation,
} from "./verified-buy-observer.js";

/** Transport absence and malformed/foreign evidence never mean zero execution. */
export async function readPolymarketFillCandidates(input: {
  owner: string;
  orderHash: string;
  tokenId: string;
  consume: () => void;
  assertBudget: (needed: number) => void;
  readOrder: () => ReturnType<typeof fetchPolymarketOrderByHash>;
  readTrades: (id: string) => ReturnType<typeof fetchPolymarketTrades>;
}): Promise<PolymarketFillObservation> {
  try {
    input.consume();
    const response = await input.readOrder();
    if (!response.ok)
      return { state: response.status === 404 ? "not_found" : "unavailable" };
    const order = response.order;
    const raw = extractSingleOrder(response.payload);
    const tradeIds = isRecord(raw)
      ? (raw.associate_trades ?? raw.associateTrades)
      : null;
    if (
      !order?.id ||
      !order.makerAddress ||
      !order.assetId ||
      !order.side ||
      !Array.isArray(tradeIds) ||
      tradeIds.some((id) => typeof id !== "string" || !id.trim())
    )
      return { state: "malformed" };
    if (
      order.id.toLowerCase() !== input.orderHash.toLowerCase() ||
      order.makerAddress.toLowerCase() !== input.owner.toLowerCase() ||
      order.assetId !== input.tokenId ||
      order.side.toUpperCase() !== "BUY"
    )
      return { state: "identity_conflict" };
    if (
      terminalZeroFill({
        status: order.status,
        filledQuantity: order.sizeMatched,
        evidenceCount: tradeIds.length,
      })
    )
      return { state: "terminal_zero_fill" };
    const uniqueIds = [...new Set(order.associateTrades)];
    // This budget counts actual trade requests, not economic fill rows or logs.
    input.assertBudget(uniqueIds.length);
    const fills: PolymarketFillCandidate[] = [];
    for (const id of uniqueIds) {
      input.consume();
      const trades = await input.readTrades(id);
      if (!trades.ok) return { state: "unavailable" };
      const trade = trades.trades.find((item) => item.id === id);
      if (!trade) return { state: "malformed" };
      if (
        trade.takerOrderId?.toLowerCase() !== input.orderHash.toLowerCase() &&
        !trade.makerOrders.some(
          (maker) =>
            maker.orderId?.toLowerCase() === input.orderHash.toLowerCase(),
        )
      )
        return { state: "identity_conflict" };
      fills.push({
        venue_trade_id: id,
        provider_tx_hash: trade.transactionHash,
        provider_status: trade.status,
      });
    }
    return { state: "fills", fills };
  } catch (error) {
    if (error instanceof EvidenceBudgetExhausted) throw error;
    // Provider exceptions can contain authenticated URLs. Never expose them.
    return { state: "unavailable" };
  }
}
