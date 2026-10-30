// @isolated-process
import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";
import { env } from "./env.js";
import { createTradingBookCache } from "./services/trading-book-cache.js";
import { loadPolymarketBook } from "./services/polymarket-book.js";
import { polymarketClient } from "./services/polymarket-client.js";
import {
  loadPolymarketQuoteContext,
  calculatePolymarketQuote,
  PolymarketQuoteError,
} from "./services/polymarket-quote.js";
import { findMaxPolymarketMarketBuyUsdForFunds } from "./services/polymarket-trading-service.js";

const realNow = Date.now;
const originalBook = polymarketClient.getOrderBook;
const originalMarketInfo = polymarketClient.getClobMarketInfo;
const originalFetch = globalThis.fetch;
const builderCode = env.polymarketBuilderCode;
let clock = realNow();
const initialTime = clock;
const sourceTime = initialTime - 60_000;
const calls = new Map<string, number>();
let slowMetadata = false;
let slowBook = false;
let failBook = false;
let currentAsk = "0.50";
let replaceAsk = false;
const book = () => ({
  timestamp: String(sourceTime),
  bids: [{ price: "0.49", size: "100" }],
  asks: [
    { price: currentAsk, size: "100" },
    { price: "0.60", size: "1000" },
  ],
  tick_size: "0.01",
  min_order_size: "5",
});
const pool = {
  query: async (sql: string) => {
    assert.match(sql.trim(), /^select/i, "context lookup cannot write");
    if (sql.includes("from fee_policy")) {
      if (slowMetadata) clock += 5_001;
      return { rows: [] };
    }
    if (sql.includes("join polymarket_markets"))
      return {
        rows: [
          {
            polymarket_id: "fixture",
            unified_market_id: "polymarket:fixture",
            condition_id: `0x${"1".repeat(64)}`,
            clob_token_ids: null,
            neg_risk: false,
            order_price_min_tick_size: "0.01",
            order_min_size: "5",
            accepting_orders: true,
            market_status: "ACTIVE",
            closed: false,
            taker_fee_bps: "0",
            maker_fee_bps: "0",
          },
        ],
      };
    if (sql.includes("polymarket_asset_bindings")) return { rows: [] };
    throw Error("unexpected context query");
  },
} as unknown as Pool;
try {
  Date.now = () => clock;
  env.polymarketBuilderCode = "";
  globalThis.fetch = async () => {
    throw Error("unexpected external call");
  };
  polymarketClient.getClobMarketInfo = async () => ({ mbf: 0, tbf: 0 });
  polymarketClient.getOrderBook = async (token) => {
    calls.set(token, (calls.get(token) ?? 0) + 1);
    if (failBook) throw Error("fixture provider unavailable");
    if (slowBook) clock += 5_001;
    if (replaceAsk && (calls.get(token) ?? 0) > 1) currentAsk = "0.55";
    return book();
  };
  const [first, coalesced] = await Promise.all([
    loadPolymarketBook("101"),
    loadPolymarketBook("101"),
  ]);
  assert.strictEqual(first, coalesced);
  assert.equal(calls.get("101"), 1);
  assert.equal(first.sourceAsOf, new Date(sourceTime).toISOString());
  assert.equal(first.expiresAt, new Date(initialTime + 5_000).toISOString());
  clock += 1_999;
  assert.strictEqual(await loadPolymarketBook("101"), first);
  clock += 2;
  const refreshed = await loadPolymarketBook("101");
  assert.equal(calls.get("101"), 2);
  assert.equal(refreshed.sourceAsOf, first.sourceAsOf);
  assert.equal(refreshed.expiresAt, new Date(clock + 5_000).toISOString());

  // Other venues retain their stricter source clock policy.
  const otherVenue = await createTradingBookCache(() => clock).load(
    "other",
    async () => book(),
  );
  assert.ok(Date.parse(otherVenue.expiresAt) < clock);
  for (const timestamp of ["bad", String(clock + 60_000)]) {
    const snapshot = await createTradingBookCache(() => clock, 2, {
      sourceTimestampBoundsLifetime: false,
    }).load(timestamp, async () => ({ ...book(), timestamp }));
    assert.equal(snapshot.sourceAsOf, null);
    assert.equal(snapshot.expiresAt, new Date(clock + 5_000).toISOString());
  }

  const context = await loadPolymarketQuoteContext(pool, { tokenId: "102" });
  for (const side of ["BUY", "SELL"] as const) {
    const result = calculatePolymarketQuote({
      tokenId: "102",
      side,
      orderType: "FOK",
      amountType: "shares",
      amountSharesInput: 10,
      slippageBps: 30,
      strictSlippage: true,
      context,
    });
    assert.equal(result.ok, true);
    assert.ok(
      side === "BUY" ? result.price <= 0.5015 : result.price >= 0.48853,
    );
  }
  const beyondDepth = calculatePolymarketQuote({
    tokenId: "102",
    side: "BUY",
    orderType: "FOK",
    amountType: "usd",
    amountUsdInput: 51,
    slippageBps: 100,
    strictSlippage: true,
    context,
  });
  assert.equal(
    beyondDepth.price,
    0.5,
    "strict tick rounding must not widen 0.505 to 0.51",
  );
  const maximum = await findMaxPolymarketMarketBuyUsdForFunds(pool, {
    tokenId: "102",
    executableFundsRaw: 51_000_000n,
    slippageBps: 100,
    context,
  });
  assert.ok(maximum.ok);
  assert.equal(
    maximum.maxAmountUsdRaw,
    "50000000",
    "51 dollars cannot fit 50 dollars of allowed depth",
  );
  clock += 5_000;
  assert.throws(
    () =>
      calculatePolymarketQuote({
        tokenId: "102",
        side: "SELL",
        orderType: "FOK",
        amountType: "shares",
        amountSharesInput: 10,
        context,
      }),
    (e: unknown) =>
      e instanceof PolymarketQuoteError && e.reason === "stale_orderbook",
  );

  slowMetadata = true;
  replaceAsk = true;
  const recovered = await loadPolymarketQuoteContext(pool, { tokenId: "103" });
  assert.equal(calls.get("103"), 2, "one bounded recovery after slow metadata");
  assert.equal(
    recovered.orderbook.asks[0]?.price,
    0.55,
    "use replacement levels, not initial prices",
  );
  assert.ok(recovered.bookSnapshot);
  assert.ok(Date.parse(recovered.bookSnapshot.expiresAt) > clock);

  slowMetadata = false;
  replaceAsk = false;
  slowBook = true;
  await assert.rejects(
    loadPolymarketQuoteContext(pool, { tokenId: "104" }),
    (e: unknown) =>
      e instanceof PolymarketQuoteError && e.reason === "stale_orderbook",
  );
  assert.equal(
    calls.get("104"),
    2,
    "slow source cannot trigger unbounded retries",
  );
  slowBook = false;
  assert.ok(
    await loadPolymarketQuoteContext(pool, { tokenId: "104" }),
    "next request recovers",
  );
  failBook = true;
  await assert.rejects(loadPolymarketBook("105"), /fixture provider/);
  failBook = false;
  assert.ok(await loadPolymarketBook("105"));
  console.log(
    "ok - quiet books, cache/coalescing, bounded refresh, expiry recovery and strict BUY/SELL price checks",
  );
} finally {
  Date.now = realNow;
  polymarketClient.getOrderBook = originalBook;
  polymarketClient.getClobMarketInfo = originalMarketInfo;
  globalThis.fetch = originalFetch;
  env.polymarketBuilderCode = builderCode;
}
