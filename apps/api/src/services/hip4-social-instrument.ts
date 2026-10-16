import { hip4Identity, hip4ReadMarketSchema } from "@hunch/shared";
import { HYPERCORE_MAINNET_USDC } from "../funding/domain/hypercore-identity.js";
import { canonicalJsonHash } from "../funding/persistence/canonical.js";
import type { VerifiedBuyFacts } from "../schemas/social-trade.js";

/** Frozen economic identity, not the replaceable read-snapshot generation UUID.
 * Publication's current-open and Copy's executable checks remain separate. */
export function buildHip4SocialInstrument(input: {
  marketId: string;
  tokenId: string;
  outcome: "YES" | "NO";
  expiry: string | null;
  snapshot: unknown;
}): VerifiedBuyFacts["instrument"] | null {
  const parsed = hip4ReadMarketSchema.safeParse(input.snapshot);
  if (!parsed.success) return null;
  const market = parsed.data;
  if (
    market.environment !== "mainnet" ||
    market.marketId !== input.marketId ||
    market.quoteToken !== "USDC" ||
    market.quoteTokenId?.toLowerCase() !== HYPERCORE_MAINNET_USDC.assetId ||
    market.quoteWeiDecimals !== HYPERCORE_MAINNET_USDC.decimals ||
    market.sides.length !== 2
  )
    return null;
  const identity = hip4Identity(market.environment, market.outcome);
  if (market.marketId !== identity.marketId) return null;
  const sides = identity.sides.map((expected) => {
    const actual = market.sides.find(
      (side) => side.sideIndex === expected.sideIndex,
    );
    return actual &&
      actual.tokenId === expected.tokenId &&
      actual.coin === expected.coin &&
      actual.tokenName === expected.tokenName &&
      actual.assetId === expected.assetId
      ? { ...expected, label: actual.label }
      : null;
  });
  const selected = sides[input.outcome === "YES" ? 0 : 1];
  if (sides.some((side) => !side) || selected?.tokenId !== input.tokenId)
    return null;
  const expiry = input.expiry ? new Date(input.expiry) : null;
  const nativeExpiry = market.expiry ? new Date(market.expiry) : null;
  if (
    (expiry && !Number.isFinite(expiry.getTime())) ||
    (nativeExpiry && !Number.isFinite(nativeExpiry.getTime())) ||
    (expiry?.toISOString() ?? null) !== (nativeExpiry?.toISOString() ?? null)
  )
    return null;
  const terms = {
    version: 1,
    environment: market.environment,
    outcome: market.outcome,
    questionId: market.questionId,
    title: market.title,
    condition: market.description,
    expiry: expiry?.toISOString() ?? null,
    quoteAsset: HYPERCORE_MAINNET_USDC,
    sides,
  };
  return {
    venue: "hyperliquid",
    marketId: market.marketId,
    tokenId: selected.tokenId,
    outcome: input.outcome,
    generation: `hyperliquid:instrument:v1:${canonicalJsonHash(terms)}`,
    expiry: terms.expiry,
  };
}
