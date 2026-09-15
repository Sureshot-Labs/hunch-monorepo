import assert from "node:assert/strict";
import type { PolymarketMarketInfoRow } from "./repos/polymarket-markets.js";
import { PolymarketHttpError } from "./services/polymarket-client.js";
import {
  polymarketOrderbookFailure,
  PolymarketQuoteError,
} from "./services/polymarket-quote.js";

const market: PolymarketMarketInfoRow = {
  polymarket_id: "fixture",
  unified_market_id: "fixture",
  condition_id: null,
  clob_token_ids: null,
  neg_risk: false,
  order_price_min_tick_size: "0.01",
  order_min_size: "5",
  accepting_orders: false,
  taker_fee_bps: null,
  maker_fee_bps: null,
};
for (const [metadata, reason] of [
  [null, "market_orderbook_unavailable"],
  [market, "market_orderbook_unavailable"],
  [{ ...market, closed: true }, "market_trading_closed"],
  [{ ...market, market_status: "CLOSED" }, "market_trading_closed"],
  [{ ...market, market_status: "RESOLVED" }, "market_resolved"],
  [
    {
      ...market,
      accepting_orders: true,
      closed: false,
      market_status: "ACTIVE",
    },
    "market_orderbook_unavailable",
  ],
  [
    { ...market, accepting_orders: true, market_status: "CLOSED" },
    "market_orderbook_unavailable",
  ],
] as const) {
  const failure = polymarketOrderbookFailure(
    new PolymarketHttpError(404, "/book"),
    metadata,
  );
  assert.ok(failure instanceof PolymarketQuoteError);
  assert.equal(failure.reason, reason);
  assert.equal(
    failure.statusCode,
    reason === "market_orderbook_unavailable" ? 503 : 409,
  );
}
for (const failure of [
  new PolymarketHttpError(500, "/book"),
  new PolymarketHttpError(404, "/markets"),
  new Error("timeout"),
]) {
  assert.equal(
    polymarketOrderbookFailure(failure, { ...market, closed: true }),
    failure,
  );
}
console.log(
  "ok - book 404 requires explicit closed/non-accepting facts; other failures retain their identity",
);
