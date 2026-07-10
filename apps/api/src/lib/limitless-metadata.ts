import { parseMetadata, pickString } from "./metadata-description.js";
import { isRecord } from "./type-guards.js";

export type LimitlessMetadata = {
  marketAddress?: string;
  negRiskMarketId?: string;
  negRiskRequestId?: string;
  tradeType?: string;
  venueAdapter?: string;
  venueExchange?: string;
};

function pickFirstString(
  obj: Record<string, unknown> | null,
  keys: readonly string[],
): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = pickString(obj, key);
    if (value) return value;
  }
  return undefined;
}

function pickVenueField(
  obj: Record<string, unknown> | null,
  key: string,
): string | undefined {
  if (!obj || !isRecord(obj.venue)) return undefined;
  const value = obj.venue[key];
  return typeof value === "string" && value.trim().length ? value : undefined;
}

function pickExchange(
  metadata: Record<string, unknown> | null,
): string | undefined {
  return (
    pickFirstString(metadata, [
      "venueExchange",
      "exchangeAddress",
      "exchange",
      "negRiskExchange",
    ]) ??
    pickVenueField(metadata, "exchange") ??
    pickVenueField(metadata, "exchangeAddress")
  );
}

export function extractLimitlessMetadata(
  marketMetadata: unknown,
  eventMetadata: unknown,
): LimitlessMetadata {
  const market = parseMetadata(marketMetadata);
  const event = parseMetadata(eventMetadata);

  return {
    marketAddress: pickString(market, "address"),
    negRiskMarketId:
      pickString(market, "negRiskMarketId") ??
      pickString(event, "negRiskMarketId"),
    negRiskRequestId: pickString(market, "negRiskRequestId"),
    tradeType: pickString(market, "tradeType"),
    venueAdapter:
      pickString(market, "venueAdapter") ?? pickString(event, "venueAdapter"),
    venueExchange: pickExchange(market) ?? pickExchange(event),
  };
}
