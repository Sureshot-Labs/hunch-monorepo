import type { TLimitlessMarket } from "./types.js";

export function resolveLimitlessGroupId(market: unknown): string | undefined {
  if (!market || typeof market !== "object") return undefined;
  const value = (market as { groupId?: unknown }).groupId;
  if (value == null) return undefined;
  const groupId = String(value).trim();
  return groupId || undefined;
}

export function orderLimitlessMarketsForGrouping(
  markets: TLimitlessMarket[],
): TLimitlessMarket[] {
  return markets
    .map((market, index) => ({ market, index }))
    .sort((a, b) => {
      const aGroup = a.market.marketType === "group" ? 0 : 1;
      const bGroup = b.market.marketType === "group" ? 0 : 1;
      return aGroup - bGroup || a.index - b.index;
    })
    .map(({ market }) => market);
}

export function resolveLimitlessEventContext(
  market: TLimitlessMarket,
  groupParent?: TLimitlessMarket | null,
): {
  eventSource: TLimitlessMarket;
  eventId: string;
  groupId: string | undefined;
  groupedSingle: boolean;
  missingGroupParent: boolean;
} {
  const groupId = resolveLimitlessGroupId(market);
  const isGroupedSingle =
    market.marketType === "single" &&
    groupId != null &&
    groupId !== String(market.id);
  const hasMatchingParent =
    isGroupedSingle && groupParent != null && String(groupParent.id) === groupId;

  if (hasMatchingParent) {
    return {
      eventSource: groupParent,
      eventId: String(groupParent.id),
      groupId,
      groupedSingle: true,
      missingGroupParent: false,
    };
  }

  return {
    eventSource: market,
    eventId: String(market.id),
    groupId,
    groupedSingle: false,
    missingGroupParent: isGroupedSingle,
  };
}
