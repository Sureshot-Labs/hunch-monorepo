#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { MarketByTokenRow } from "./repos/unified-read.js";
import { mapMarketsByTokenRows } from "./services/markets-by-token-response.js";

function row(
  overrides: Partial<MarketByTokenRow> = {},
): MarketByTokenRow {
  return {
    token_id: "yes-token",
    side: "YES",
    market_id: "market-1",
    venue: "limitless",
    venue_market_id: "venue-market-1",
    market_title: "Presentation market",
    market_description: null,
    market_type: "binary",
    market_duration_minutes: null,
    market_status: "CLOSED",
    pm_accepting_orders: false,
    pm_neg_risk: null,
    pm_neg_risk_market_id: null,
    pm_neg_risk_parent_condition_id: null,
    pm_neg_risk_request_id: null,
    pm_question_id: null,
    open_time: "2026-07-01T00:00:00.000Z",
    close_time: "2026-07-02T00:00:00.000Z",
    expiration_time: "2026-07-02T00:00:00.000Z",
    volume_24h: 0,
    volume_total: 0,
    open_interest: 0,
    liquidity: 0,
    best_bid: 0.11,
    best_ask: 0.89,
    best_bid_yes: 0.7,
    best_ask_yes: 0.72,
    top_ts_yes: "2026-07-01T12:00:00.000Z",
    best_bid_no: 0.28,
    best_ask_no: 0.3,
    top_ts_no: "2026-07-01T12:00:01.000Z",
    last_price: 0.71,
    outcomes: '["Yes","No"]',
    token_yes: "yes-token",
    token_no: "no-token",
    clob_token_ids: null,
    condition_id: null,
    market_ledger: null,
    settlement_mint: null,
    is_initialized: null,
    redemption_status: null,
    resolved_outcome: null,
    resolved_outcome_pct: null,
    slug: "presentation-market",
    market_category: null,
    market_image: null,
    market_icon: null,
    market_metadata: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T12:00:01.000Z",
    event_id: "event-1",
    event_venue: "limitless",
    venue_event_id: "venue-event-1",
    event_title: "Presentation event",
    event_description: null,
    event_category: null,
    event_status: "CLOSED",
    event_duration_minutes: null,
    start_date: "2026-07-01T00:00:00.000Z",
    end_date: "2026-07-02T00:00:00.000Z",
    event_volume_total: 0,
    event_volume_24h: 0,
    event_liquidity: 0,
    event_open_interest: 0,
    event_slug: "presentation-event",
    event_image: null,
    event_icon: null,
    event_metadata: null,
    ...overrides,
  };
}

function marketFor(input: MarketByTokenRow) {
  const mapped = mapMarketsByTokenRows([input], {
    now: new Date("2026-07-18T00:00:00.000Z"),
  });
  assert.equal(mapped.length, 1);
  return mapped[0].market;
}

{
  const market = marketFor(row());
  assert.equal(market.acceptingOrders, false);
  assert.equal(market.bestBid, 0.7);
  assert.equal(market.bestAsk, 0.72);
  assert.equal(market.bestBidNo, 0.28);
  assert.equal(market.bestAskNo, 0.3);
  assert.deepEqual(market.topAsOf, {
    YES: "2026-07-01T12:00:00.000Z",
    NO: "2026-07-01T12:00:01.000Z",
  });
  assert.equal(market.lastPrice, 0.71);
  console.log(
    "ok - presentation retains old observed tops independently of availability",
  );
}

{
  const market = marketFor(
    row({
      best_bid_yes: 0.8,
      best_ask_yes: 0.2,
    }),
  );
  assert.equal(market.bestBid, null);
  assert.equal(market.bestAsk, null);
  assert.equal(market.bestBidYes, null);
  assert.equal(market.bestAskYes, null);
  assert.equal(market.bestBidNo, 0.28);
  assert.equal(market.bestAskNo, 0.3);
  console.log("ok - presentation rejects crossed canonical sides");
}

{
  const market = marketFor(
    row({
      best_bid_yes: null,
      best_ask_yes: null,
      best_bid_no: null,
      best_ask_no: null,
      top_ts_yes: null,
      top_ts_no: null,
    }),
  );
  assert.equal(market.bestBid, null);
  assert.equal(market.bestAsk, null);
  assert.equal(market.bestBidYes, null);
  assert.equal(market.bestAskYes, null);
  assert.deepEqual(market.topAsOf, { YES: null, NO: null });
  console.log("ok - presentation never falls back to legacy market prices");
}
