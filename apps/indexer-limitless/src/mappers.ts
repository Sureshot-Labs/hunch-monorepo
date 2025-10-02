import { v4 as uuid } from "uuid";
import type { TLimitlessMarket } from "./types";

// helper: parse volume (prefer formatted; else scale by decimals if looks integery)
function parseVolume(m: TLimitlessMarket): number | null {
  if (m.volumeFormatted && !Number.isNaN(Number(m.volumeFormatted)))
    return Number(m.volumeFormatted);
  if (m.volume != null && Number.isFinite(Number(m.volume))) {
    const d = m.collateralToken?.decimals ?? 6;
    return Number(m.volume) / Math.pow(10, d);
  }
  return null;
}

const n = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const x = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(x as number) ? (x as number) : null;
};

export function mapEventRow(venueId: number, lm: TLimitlessMarket) {
  // Limitless market -> our event
  const id = uuid();
  const endTs =
    lm.expirationTimestamp != null ? Number(lm.expirationTimestamp) : NaN;

  // pick a single category string; you can get ambitious later
  const category = lm.categories?.[0] ?? null;

  return {
    id,
    venue_id: venueId,
    event_id: String(lm.id),
    title: lm.title,
    category,
    slug: null,
    active: !(lm.expired ?? false) && (lm.status ?? "ACTIVE") !== "RESOLVED",
    closed: (lm.expired ?? false) || (lm.status ?? "") === "RESOLVED",
    start_time: null,
    end_time: Number.isFinite(endTs) ? new Date(endTs) : null,
    liquidity: null, // not exposed in the sample; set later if API adds it
    volume_total: parseVolume(lm),
    volume24hr: null, // API not exposing it (yet)
    raw: lm,
  };
}

export function mapMarketRow(
  venueId: number,
  eventUuid: string,
  lm: TLimitlessMarket
) {
  // One binary market per event. We synthesize token IDs from address/conditionId.
  const id = uuid();
  const addr = (lm.address ?? lm.conditionId ?? String(lm.id)).toLowerCase();
  const yesToken = `${addr}:YES`;
  const noToken = `${addr}:NO`;

  // prices array is [yes%, no%], convert to 0..1 decimals
  const yesP = lm.prices?.[0] != null ? Number(lm.prices[0]) / 100 : null;
  const noP = lm.prices?.[1] != null ? Number(lm.prices[1]) / 100 : null;

  return {
    id,
    event_id: eventUuid,
    venue_id: venueId,
    market_id: String(lm.id), // unique per venue
    title: lm.title,
    enable_orderbook: false, // no CLOB; don’t pretend
    accepting_orders:
      (lm.status ?? "ACTIVE") === "FUNDED" ||
      (lm.status ?? "ACTIVE") === "ACTIVE",
    condition_id: lm.conditionId ?? null,
    order_price_min_tick_size: null,
    order_min_size: null,
    neg_risk: null,
    neg_risk_market_id: null,
    liquidity: null,
    volume_total: parseVolume(lm),
    volume24hr: null,
    clob_token_yes: yesToken,
    clob_token_no: noToken,
    raw: {
      ...lm,
      normalizedPrices: { yes: yesP, no: noP },
    },
  };
}

export function mapTokens(marketUuid: string, yes: string, no: string) {
  return [
    { token_id: yes, market_id: marketUuid, side: "YES" as const },
    { token_id: no, market_id: marketUuid, side: "NO" as const },
  ];
}
