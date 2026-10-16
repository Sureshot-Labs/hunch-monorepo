import {
  hip4Identity,
  hip4ProbabilitySchema,
  hip4RawUnits,
  type Hip4ReadMarket,
} from "@hunch/shared";

/** Exact YES payout in the existing scalar basis-point column. Fractional
 * payouts are not binary wins and must not round-trip through JS Number. */
export function hip4OfficialPayoutBasisPoints(
  market: Hip4ReadMarket,
): string | null {
  if (
    market.status !== "settled" ||
    market.settlement?.source !== "settledOutcome"
  )
    return null;
  const identity = hip4Identity(market.environment, market.outcome);
  if (market.marketId !== identity.marketId) return null;
  const yes = market.sides.find((side) => side.sideIndex === 0);
  const no = market.sides.find((side) => side.sideIndex === 1);
  if (
    !yes ||
    !no ||
    yes.tokenId !== identity.sides[0].tokenId ||
    no.tokenId !== identity.sides[1].tokenId ||
    !hip4ProbabilitySchema.safeParse(yes.payout).success ||
    !hip4ProbabilitySchema.safeParse(no.payout).success
  )
    return null;
  const payout = yes.payout as string;
  const negative = no.payout as string;
  const decimals = Math.max(
    payout.split(".")[1]?.length ?? 0,
    negative.split(".")[1]?.length ?? 0,
  );
  if (
    decimals > 38 ||
    hip4RawUnits(payout, decimals) + hip4RawUnits(negative, decimals) !==
      10n ** BigInt(decimals)
  )
    return null;
  const units = hip4RawUnits(payout, decimals) * 10_000n;
  if (!decimals) return units.toString();
  const digits = units.toString().padStart(decimals + 1, "0");
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`.replace(
    /\.?0+$/u,
    "",
  );
}

/** The provider snapshot projects into the same catalog columns as other
 * venues. Preserve the metric's meaning: a rolling primary-side notional is
 * not lifetime volume; an indicative midpoint is not an executed last trade. */
export function hip4CatalogProjection(market: Hip4ReadMarket) {
  const identity = hip4Identity(market.environment, market.outcome);
  const primary = market.sides.find((side) => side.sideIndex === 0);
  const volume = market.volume24h;
  const validVolume =
    market.quoteToken === "USDC" &&
    volume?.basis === "primary_outcome" &&
    volume.coin === identity.sides[0].coin &&
    Number.isFinite(Date.parse(volume.observedAt));
  return {
    resolvedOutcomePct: hip4OfficialPayoutBasisPoints(market),
    volume24h: validVolume ? volume.usd : null,
    // Do not invent a USD conversion for another quote token.
    bestBid: primary?.coin === identity.sides[0].coin ? primary.bid : null,
    bestAsk: primary?.coin === identity.sides[0].coin ? primary.ask : null,
    // This is the provider observation time, never the REST/WS write time.
    priceObservedAt:
      primary?.coin === identity.sides[0].coin ? primary.bookAt : null,
  };
}
