// apps/indexer-kalshi/src/kalshi-repo.ts
import { pool } from "../../indexer-polymarket/src/db";
import type { z } from "zod";
import { KalshiEvent, KalshiMarket } from "./types";

const n = (v: unknown): number | null => {
  if (v == null) return null;
  const x = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(x) ? (x as number) : null;
};

const parseDate = (s?: string | null) => (s ? new Date(s) : null);

export async function upsertKalshiEvent(event: z.infer<typeof KalshiEvent>) {
  const extra = event as Record<string, unknown>;
  const eventData = {
    id: event.event_ticker,
    event_ticker: event.event_ticker,
    series_ticker: event.series_ticker || null,
    sub_title: event.sub_title || null,
    title: event.title,
    collateral_return_type:
      typeof extra.collateral_return_type === "string"
        ? extra.collateral_return_type
        : null,
    mutually_exclusive:
      typeof extra.mutually_exclusive === "boolean"
        ? extra.mutually_exclusive
        : false,
    category: event.category || null,
    price_level_structure:
      typeof extra.price_level_structure === "string"
        ? extra.price_level_structure
        : null,
    available_on_brokers:
      typeof extra.available_on_brokers === "boolean"
        ? extra.available_on_brokers
        : false,
    raw: event,
  };

  const result = await pool.query(
    `
    INSERT INTO kalshi_events (
      id, event_ticker, series_ticker, sub_title, title, collateral_return_type,
      mutually_exclusive, category, price_level_structure, available_on_brokers, raw
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (id) DO UPDATE SET
      series_ticker = EXCLUDED.series_ticker,
      sub_title = EXCLUDED.sub_title,
      title = EXCLUDED.title,
      collateral_return_type = EXCLUDED.collateral_return_type,
      mutually_exclusive = EXCLUDED.mutually_exclusive,
      category = EXCLUDED.category,
      price_level_structure = EXCLUDED.price_level_structure,
      available_on_brokers = EXCLUDED.available_on_brokers,
      raw = EXCLUDED.raw,
      updated_at_db = now()
    RETURNING id
  `,
    [
      eventData.id,
      eventData.event_ticker,
      eventData.series_ticker,
      eventData.sub_title,
      eventData.title,
      eventData.collateral_return_type,
      eventData.mutually_exclusive,
      eventData.category,
      eventData.price_level_structure,
      eventData.available_on_brokers,
      JSON.stringify(eventData.raw),
    ],
  );

  return result.rows[0].id;
}

export async function upsertKalshiMarket(market: z.infer<typeof KalshiMarket>) {
  const extra = market as Record<string, unknown>;
  const marketData = {
    id: market.ticker,
    event_ticker: market.event_ticker,
    market_type:
      typeof extra.market_type === "string" ? extra.market_type : "binary",
    title: market.title || null,
    subtitle: typeof extra.subtitle === "string" ? extra.subtitle : null,
    yes_sub_title:
      typeof extra.yes_sub_title === "string" ? extra.yes_sub_title : null,
    no_sub_title:
      typeof extra.no_sub_title === "string" ? extra.no_sub_title : null,
    open_time: parseDate(market.open_time),
    close_time: parseDate(market.close_time),
    expected_expiration_time: parseDate(
      typeof extra.expected_expiration_time === "string"
        ? extra.expected_expiration_time
        : null,
    ),
    expiration_time: parseDate(market.expiration_time),
    latest_expiration_time: parseDate(
      typeof extra.latest_expiration_time === "string"
        ? extra.latest_expiration_time
        : null,
    ),
    settlement_timer_seconds: n(extra.settlement_timer_seconds),
    status: market.status || "open",
    response_price_units:
      typeof extra.response_price_units === "string"
        ? extra.response_price_units
        : null,
    notional_value: n(extra.notional_value),
    notional_value_dollars: n(extra.notional_value_dollars),
    yes_bid: n(extra.yes_bid),
    yes_bid_dollars: n(extra.yes_bid_dollars),
    yes_ask: n(extra.yes_ask),
    yes_ask_dollars: n(extra.yes_ask_dollars),
    no_bid: n(extra.no_bid),
    no_bid_dollars: n(extra.no_bid_dollars),
    no_ask: n(extra.no_ask),
    no_ask_dollars: n(extra.no_ask_dollars),
    last_price: n(extra.last_price),
    last_price_dollars: n(extra.last_price_dollars),
    previous_yes_bid: n(extra.previous_yes_bid),
    previous_yes_bid_dollars: n(extra.previous_yes_bid_dollars),
    previous_yes_ask: n(extra.previous_yes_ask),
    previous_yes_ask_dollars: n(extra.previous_yes_ask_dollars),
    previous_price: n(extra.previous_price),
    previous_price_dollars: n(extra.previous_price_dollars),
    volume: n(extra.volume),
    volume_24h: n(market.volume_24h),
    liquidity: n(market.liquidity),
    liquidity_dollars: n(extra.liquidity_dollars),
    open_interest: n(extra.open_interest),
    result: typeof extra.result === "string" ? extra.result : null,
    can_close_early:
      typeof extra.can_close_early === "boolean"
        ? extra.can_close_early
        : false,
    expiration_value:
      typeof extra.expiration_value === "string"
        ? extra.expiration_value
        : null,
    category: typeof extra.category === "string" ? extra.category : null,
    risk_limit_cents: n(extra.risk_limit_cents),
    rules_primary:
      typeof extra.rules_primary === "string" ? extra.rules_primary : null,
    rules_secondary:
      typeof extra.rules_secondary === "string" ? extra.rules_secondary : null,
    early_close_condition:
      typeof extra.early_close_condition === "string"
        ? extra.early_close_condition
        : null,
    tick_size: n(extra.tick_size),
    raw: market,
  };

  const result = await pool.query(
    `
    INSERT INTO kalshi_markets (
      id, event_ticker, market_type, title, subtitle, yes_sub_title, no_sub_title,
      open_time, close_time, expected_expiration_time, expiration_time, latest_expiration_time,
      settlement_timer_seconds, status, response_price_units, notional_value, notional_value_dollars,
      yes_bid, yes_bid_dollars, yes_ask, yes_ask_dollars, no_bid, no_bid_dollars,
      no_ask, no_ask_dollars, last_price, last_price_dollars, previous_yes_bid,
      previous_yes_bid_dollars, previous_yes_ask, previous_yes_ask_dollars, previous_price,
      previous_price_dollars, volume, volume_24h, liquidity, liquidity_dollars,
      open_interest, result, can_close_early, expiration_value, category, risk_limit_cents,
      rules_primary, rules_secondary, early_close_condition, tick_size, raw
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
      $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32,
      $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47, $48
    )
    ON CONFLICT (id) DO UPDATE SET
      event_ticker = EXCLUDED.event_ticker,
      market_type = EXCLUDED.market_type,
      title = EXCLUDED.title,
      subtitle = EXCLUDED.subtitle,
      yes_sub_title = EXCLUDED.yes_sub_title,
      no_sub_title = EXCLUDED.no_sub_title,
      open_time = EXCLUDED.open_time,
      close_time = EXCLUDED.close_time,
      expected_expiration_time = EXCLUDED.expected_expiration_time,
      expiration_time = EXCLUDED.expiration_time,
      latest_expiration_time = EXCLUDED.latest_expiration_time,
      settlement_timer_seconds = EXCLUDED.settlement_timer_seconds,
      status = EXCLUDED.status,
      response_price_units = EXCLUDED.response_price_units,
      notional_value = EXCLUDED.notional_value,
      notional_value_dollars = EXCLUDED.notional_value_dollars,
      yes_bid = EXCLUDED.yes_bid,
      yes_bid_dollars = EXCLUDED.yes_bid_dollars,
      yes_ask = EXCLUDED.yes_ask,
      yes_ask_dollars = EXCLUDED.yes_ask_dollars,
      no_bid = EXCLUDED.no_bid,
      no_bid_dollars = EXCLUDED.no_bid_dollars,
      no_ask = EXCLUDED.no_ask,
      no_ask_dollars = EXCLUDED.no_ask_dollars,
      last_price = EXCLUDED.last_price,
      last_price_dollars = EXCLUDED.last_price_dollars,
      previous_yes_bid = EXCLUDED.previous_yes_bid,
      previous_yes_bid_dollars = EXCLUDED.previous_yes_bid_dollars,
      previous_yes_ask = EXCLUDED.previous_yes_ask,
      previous_yes_ask_dollars = EXCLUDED.previous_yes_ask_dollars,
      previous_price = EXCLUDED.previous_price,
      previous_price_dollars = EXCLUDED.previous_price_dollars,
      volume = EXCLUDED.volume,
      volume_24h = EXCLUDED.volume_24h,
      liquidity = EXCLUDED.liquidity,
      liquidity_dollars = EXCLUDED.liquidity_dollars,
      open_interest = EXCLUDED.open_interest,
      result = EXCLUDED.result,
      can_close_early = EXCLUDED.can_close_early,
      expiration_value = EXCLUDED.expiration_value,
      category = EXCLUDED.category,
      risk_limit_cents = EXCLUDED.risk_limit_cents,
      rules_primary = EXCLUDED.rules_primary,
      rules_secondary = EXCLUDED.rules_secondary,
      early_close_condition = EXCLUDED.early_close_condition,
      tick_size = EXCLUDED.tick_size,
      raw = EXCLUDED.raw,
      updated_at_db = now()
    RETURNING id
  `,
    [
      marketData.id,
      marketData.event_ticker,
      marketData.market_type,
      marketData.title,
      marketData.subtitle,
      marketData.yes_sub_title,
      marketData.no_sub_title,
      marketData.open_time,
      marketData.close_time,
      marketData.expected_expiration_time,
      marketData.expiration_time,
      marketData.latest_expiration_time,
      marketData.settlement_timer_seconds,
      marketData.status,
      marketData.response_price_units,
      marketData.notional_value,
      marketData.notional_value_dollars,
      marketData.yes_bid,
      marketData.yes_bid_dollars,
      marketData.yes_ask,
      marketData.yes_ask_dollars,
      marketData.no_bid,
      marketData.no_bid_dollars,
      marketData.no_ask,
      marketData.no_ask_dollars,
      marketData.last_price,
      marketData.last_price_dollars,
      marketData.previous_yes_bid,
      marketData.previous_yes_bid_dollars,
      marketData.previous_yes_ask,
      marketData.previous_yes_ask_dollars,
      marketData.previous_price,
      marketData.previous_price_dollars,
      marketData.volume,
      marketData.volume_24h,
      marketData.liquidity,
      marketData.liquidity_dollars,
      marketData.open_interest,
      marketData.result,
      marketData.can_close_early,
      marketData.expiration_value,
      marketData.category,
      marketData.risk_limit_cents,
      marketData.rules_primary,
      marketData.rules_secondary,
      marketData.early_close_condition,
      marketData.tick_size,
      JSON.stringify(marketData.raw),
    ],
  );

  return result.rows[0].id;
}
