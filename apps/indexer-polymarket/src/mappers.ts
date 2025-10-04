import { v4 as uuid } from "uuid";
import type { TEvent, TMarket } from "./types";
import { generateEventIdempotencyKey, generateMarketIdempotencyKey, generateTokenIdempotencyKey } from "@hunch/shared";
import { parseUTCDate, parseDateRange } from "@hunch/shared";

const n = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const x = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(x as number) ? (x as number) : null;
};

export function mapEventRow(venueId: number, e: TEvent) {
  const id = uuid();
  
  // Parse dates with UTC normalization
  const { start, end } = parseDateRange(e.startDate, e.endDate);
  
  // Generate idempotency key for this event
  // Using event ID + startDate as the deterministic identifier
  const idempotencyKey = generateEventIdempotencyKey(
    'polymarket',
    e.id,
    e.startDate || Date.now()
  );
  
  return {
    id,
    venue_id: venueId,
    event_id: e.id,
    title: e.title,
    category: null, // Gamma has categories elsewhere; set later if you need
    slug: e.slug ?? null,
    active: e.active ?? true,
    closed: e.closed ?? false,
    start_time: start,
    end_time: end,
    liquidity: n(e.liquidity),
    volume_total: n(e.volume),
    volume24hr: n(e.volume24hr),
    raw: e,
    idempotency_key: idempotencyKey,
  };
}

export function mapMarketRow(venueId: number, eventUuid: string, m: TMarket) {
  const id = uuid();
  // prefer numeric *_Num fields if present, else parse the string/number fields
  const liquidity = n(m.liquidityNum ?? m.liquidity);
  const volume_total = n(m.volumeNum ?? m.volume);
  const [yes, no] = m.clobTokenIds ?? [];

  // Generate idempotency key for this market
  const idempotencyKey = generateMarketIdempotencyKey(
    'polymarket',
    m.id,
    (m as any).startDate || Date.now()
  );

  return {
    id,
    event_id: eventUuid,
    venue_id: venueId,
    market_id: m.id,
    title: m.question,
    enable_orderbook: m.enableOrderBook ?? true,
    accepting_orders: m.acceptingOrders ?? true,
    condition_id: m.conditionId ?? null,
    order_price_min_tick_size: n(m.orderPriceMinTickSize),
    order_min_size: n(m.orderMinSize),
    neg_risk: m.negRisk ?? null,
    neg_risk_market_id: (m as any).negRiskMarketID ?? null,
    liquidity,
    volume_total,
    volume24hr: n(m.volume24hr),
    clob_token_yes: yes ?? null,
    clob_token_no: no ?? null,
    raw: m,
    idempotency_key: idempotencyKey,
  };
}

export function mapTokens(
  marketUuid: string,
  yes?: string | null,
  no?: string | null
) {
  const rows: any[] = [];
  if (yes)
    rows.push({ token_id: yes, market_id: marketUuid, side: "YES" as const });
  if (no)
    rows.push({ token_id: no, market_id: marketUuid, side: "NO" as const });
  return rows;
}
