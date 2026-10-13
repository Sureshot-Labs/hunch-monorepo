import { hip4Identity, type Hip4ReadMarket } from "@hunch/shared";

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
    volume24h: validVolume ? volume.usd : null,
    // Do not invent a USD conversion for another quote token.
    bestBid: primary?.coin === identity.sides[0].coin ? primary.bid : null,
    bestAsk: primary?.coin === identity.sides[0].coin ? primary.ask : null,
    // This is the provider observation time, never the REST/WS write time.
    priceObservedAt:
      primary?.coin === identity.sides[0].coin ? primary.bookAt : null,
  };
}
