type Side = "YES" | "NO";
type ResolutionStatus = "proposed" | "disputed" | "resolved";
type PriceSnapshot = { asOf: string; price: number; side: Side };

function sideValue(value: unknown): Side | null {
  if (typeof value !== "string") return null;
  const side = value.trim().toUpperCase();
  return side === "YES" || side === "NO" ? side : null;
}

function priceValue(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 && price <= 1 ? price : null;
}

function timestamp(value: unknown): number {
  return value instanceof Date
    ? value.getTime()
    : typeof value === "string"
      ? Date.parse(value)
      : NaN;
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Read-only display prices; never a trade quote or an inferred settlement. */
export function publicHunchPricePresentation(input: {
  kind: string;
  side: string | null;
  researchedSide: unknown;
  researchedPrice: unknown;
  researchedAt: unknown;
  acceptingOrders: boolean;
  venue: string | null;
  metadata: unknown;
  marketUpdatedAt: unknown;
  resolvedOutcome: string | null;
  quotePrice: unknown;
  quoteAsOf: unknown;
  now?: number;
}): {
  resolutionStatus: ResolutionStatus | null;
  selectedSideResult: "WIN" | "LOSS" | null;
  latestPriceSnapshot: PriceSnapshot | null;
} {
  const now = input.now ?? Date.now();
  const side = sideValue(input.side);
  const metadata =
    input.metadata &&
    typeof input.metadata === "object" &&
    !Array.isArray(input.metadata)
      ? (input.metadata as Record<string, unknown>)
      : {};
  const statuses =
    input.venue === "polymarket"
      ? [metadata.umaResolutionStatus, metadata.umaResolutionStatuses]
          .flatMap((value) => {
            const parsed = jsonValue(value);
            return Array.isArray(parsed) ? parsed : [parsed];
          })
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim().toLowerCase())
      : [];
  const resolvedSide = sideValue(input.resolvedOutcome);
  const sourceResolved = statuses.some(
    (value) => value === "resolved" || value === "finalized",
  );
  // The canonical winner takes precedence: Gamma's proposal history can still
  // say "proposed" after the venue has delivered a resolved market state.
  // Display-price endpoints alone are never promoted to a winner here.
  const resolutionStatus: ResolutionStatus | null =
    resolvedSide || sourceResolved
      ? "resolved"
      : statuses.some((value) => value.includes("disput"))
        ? "disputed"
        : statuses.includes("proposed")
          ? "proposed"
          : null;
  const selectedSideResult =
    input.kind === "signal" &&
    side &&
    resolvedSide &&
    resolutionStatus === "resolved"
      ? side === resolvedSide
        ? "WIN"
        : "LOSS"
      : null;
  const result = {
    resolutionStatus,
    selectedSideResult,
    latestPriceSnapshot: null,
  } as {
    resolutionStatus: ResolutionStatus | null;
    selectedSideResult: "WIN" | "LOSS" | null;
    latestPriceSnapshot: PriceSnapshot | null;
  };
  const researchedAt = timestamp(input.researchedAt);
  if (
    input.kind !== "signal" ||
    !side ||
    sideValue(input.researchedSide) !== side ||
    priceValue(input.researchedPrice) === null ||
    !Number.isFinite(researchedAt)
  )
    return result;

  // Once trading stops, the last observed price must not expire merely because
  // the order book stops ticking. Preserve its real timestamp, not Date.now().
  const retainLastPrice = !input.acceptingOrders || resolutionStatus !== null;
  const snapshot = (value: unknown, asOf: unknown): PriceSnapshot | null => {
    const price = priceValue(value);
    const at = timestamp(asOf);
    if (
      price === null ||
      !Number.isFinite(at) ||
      at < researchedAt ||
      at > now + 5 * 60_000 ||
      (!retainLastPrice && now - at > 2 * 60 * 60_000)
    )
      return null;
    return { price, side, asOf: new Date(at).toISOString() };
  };
  const quote = snapshot(input.quotePrice, input.quoteAsOf);
  const prices = jsonValue(metadata.outcomePrices);
  const venuePrice =
    input.venue === "polymarket" && Array.isArray(prices) && prices.length === 2
      ? snapshot(prices[side === "YES" ? 0 : 1], input.marketUpdatedAt)
      : null;
  // A newer venue snapshot can carry 0/1 while the stopped book still has its
  // pre-match price. 0/1 alone never becomes WIN/LOSS.
  result.latestPriceSnapshot =
    retainLastPrice &&
    venuePrice &&
    (!quote || Date.parse(venuePrice.asOf) >= Date.parse(quote.asOf))
      ? venuePrice
      : (quote ?? venuePrice);
  return result;
}
