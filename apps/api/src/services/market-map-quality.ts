const CLOSED_LIKE_MARKET_STATUSES = new Set([
  "CLOSED",
  "SETTLED",
  "RESOLVED",
  "EXPIRED",
  "FINALIZED",
  "CANCELLED",
  "ARCHIVED",
]);

export type MarketMapUsabilityInput = {
  tokenYes?: string | null;
  tokenNo?: string | null;
  acceptingOrders?: boolean | null;
  marketStatus?: string | null;
  yesBid?: number | null;
  yesAsk?: number | null;
  noBid?: number | null;
  noAsk?: number | null;
  marketBestBid?: number | null;
  marketBestAsk?: number | null;
  lastPrice?: number | null;
  closeTime?: unknown;
  expirationTime?: unknown;
  resolvedOutcome?: string | null;
  resolvedOutcomePct?: number | null;
  yesProbability?: number | null;
};

export type MarketMapDropReason =
  | "missing_token_pair"
  | "untradeable"
  | "missing_odds";

function hasNonEmptyToken(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasResolvedOutcomeSignal(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toUpperCase();
  return normalized === "YES" || normalized === "NO";
}

function parseTimestampMs(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

export function hasMarketMapTokenPair(input: MarketMapUsabilityInput): boolean {
  return hasNonEmptyToken(input.tokenYes) && hasNonEmptyToken(input.tokenNo);
}

export function isMarketMapActionable(input: MarketMapUsabilityInput): boolean {
  if (
    hasResolvedOutcomeSignal(input.resolvedOutcome) ||
    isFiniteNumber(input.resolvedOutcomePct)
  ) {
    return false;
  }
  const terminalMs =
    parseTimestampMs(input.closeTime) ?? parseTimestampMs(input.expirationTime);
  if (terminalMs != null && terminalMs <= Date.now()) return false;
  if (input.acceptingOrders === false) return false;
  const normalizedStatus = input.marketStatus?.trim().toUpperCase() ?? "";
  if (!normalizedStatus) return true;
  return !CLOSED_LIKE_MARKET_STATUSES.has(normalizedStatus);
}

export function hasMarketMapOddsSignal(
  input: MarketMapUsabilityInput,
): boolean {
  return (
    isFiniteNumber(input.yesProbability) ||
    isFiniteNumber(input.yesBid) ||
    isFiniteNumber(input.yesAsk) ||
    isFiniteNumber(input.noBid) ||
    isFiniteNumber(input.noAsk) ||
    isFiniteNumber(input.marketBestBid) ||
    isFiniteNumber(input.marketBestAsk) ||
    isFiniteNumber(input.lastPrice) ||
    hasResolvedOutcomeSignal(input.resolvedOutcome) ||
    isFiniteNumber(input.resolvedOutcomePct)
  );
}

export function isMarketMapUsable(input: MarketMapUsabilityInput): boolean {
  return (
    hasMarketMapTokenPair(input) &&
    isMarketMapActionable(input) &&
    hasMarketMapOddsSignal(input)
  );
}

export function getMarketMapDropReason(
  input: MarketMapUsabilityInput,
): MarketMapDropReason | null {
  if (!hasMarketMapTokenPair(input)) return "missing_token_pair";
  if (!isMarketMapActionable(input)) return "untradeable";
  if (!hasMarketMapOddsSignal(input)) return "missing_odds";
  return null;
}
