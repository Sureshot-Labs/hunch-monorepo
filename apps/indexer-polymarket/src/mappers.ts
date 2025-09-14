import { v4 as uuid } from "uuid";
import type { TEvent, TMarket } from "./types";

const n = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const x = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(x as number) ? (x as number) : null;
};

export function mapEventRow(venueId: number, e: TEvent) {
  const id = uuid();
  return {
    id,
    venue_id: venueId,
    event_id: e.id,
    title: e.title,
    category: null, // Gamma has categories elsewhere; set later if you need
    slug: e.slug ?? null,
    active: e.active ?? true,
    closed: e.closed ?? false,
    start_time: e.startDate ? new Date(e.startDate) : null,
    end_time: e.endDate ? new Date(e.endDate) : null,
    liquidity: n(e.liquidity),
    volume_total: n(e.volume),
    volume24hr: n(e.volume24hr),
    raw: e,
  };
}

export function mapMarketRow(venueId: number, eventUuid: string, m: TMarket) {
  const id = uuid();
  // prefer numeric *_Num fields if present, else parse the string/number fields
  const liquidity = n(m.liquidityNum ?? m.liquidity);
  const volume_total = n(m.volumeNum ?? m.volume);
  const [yes, no] = m.clobTokenIds ?? [];

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
