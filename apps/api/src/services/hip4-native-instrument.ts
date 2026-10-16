import { hip4Identity, hip4ReadMarketSchema } from "@hunch/shared";
import { HYPERCORE_MAINNET_USDC } from "../funding/domain/hypercore-identity.js";
import { canonicalJsonHash } from "../funding/persistence/canonical.js";
import { isRecord } from "../lib/type-guards.js";
import type { VerifiedBuyFacts } from "../schemas/social-trade.js";

/** Frozen economic identity, not the replaceable read-snapshot generation UUID.
 * This carries no publication, Copy, lifecycle or financial permission. */
export function buildHip4NativeInstrument(input: {
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
  const expiry = input.expiry !== null ? new Date(input.expiry) : null;
  const nativeExpiry = market.expiry !== null ? new Date(market.expiry) : null;
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

/** Current indexed provenance and factual open state, without social policy. */
export function hip4NativeMarketOpen(metadata: unknown, now = Date.now()) {
  const parsed = hip4ReadMarketSchema.safeParse(
    isRecord(metadata) ? metadata.hip4 : null,
  );
  if (!parsed.success) return false;
  const market = parsed.data;
  return (
    market.environment === "mainnet" &&
    market.status === "observed" &&
    market.settlement === null &&
    market.coverage.metadata === "fresh" &&
    Number.isFinite(Date.parse(market.metadataValidUntil ?? "")) &&
    Date.parse(market.metadataValidUntil ?? "") > now &&
    Number.isFinite(Date.parse(market.fetchedAt)) &&
    Date.parse(market.fetchedAt) <= now &&
    (market.expiry === null ||
      (Number.isFinite(Date.parse(market.expiry)) &&
        Date.parse(market.expiry) > now))
  );
}

/** The same native first-admission contract for ordinary BUY/SELL and Copy.
 * Known-null expiry is supported; malformed or mismatched expiry is not. */
export function currentHip4NativeInstrument(input: {
  marketId: string;
  tokenId: string;
  outcome: "YES" | "NO";
  expiry: string | null;
  metadata: unknown;
  status: string;
  now: number;
}) {
  if (
    input.status !== "ACTIVE" ||
    !hip4NativeMarketOpen(input.metadata, input.now)
  )
    return null;
  return buildHip4NativeInstrument({
    ...input,
    snapshot: isRecord(input.metadata) ? input.metadata.hip4 : null,
  });
}
