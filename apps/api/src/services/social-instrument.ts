import {
  buildPolymarketAssetContext,
  parsePolymarketMarketAssets,
} from "@hunch/shared";
import type { VerifiedBuyFacts } from "../schemas/social-trade.js";
import { isRecord } from "../lib/type-guards.js";

/** Snapshot only an explicitly indexed instrument; never invent old generations. */
export function buildSocialInstrument(input: {
  marketId: string;
  venue: string;
  outcome: "YES" | "NO";
  tokenId: string | null;
  expiry: string | null;
  metadata: unknown;
  limitlessPositionContract?: string;
}): VerifiedBuyFacts["instrument"] | null {
  if (!input.tokenId) return null;
  let generation: string;
  if (input.venue === "polymarket") {
    const protocol = parsePolymarketMarketAssets(
      isRecord(input.metadata) ? input.metadata.polymarketProtocol : null,
    );
    if (
      !protocol ||
      protocol.assets[input.outcome === "YES" ? 0 : 1] !== input.tokenId
    )
      return null;
    const context = buildPolymarketAssetContext(
      input.marketId,
      protocol,
      input.tokenId,
    );
    generation = `${context.chainId}:${context.positionContract.toLowerCase()}:${context.protocolVersion}`;
  } else if (input.venue === "kalshi") {
    generation = `solana:mainnet:${input.tokenId}`;
  } else if (input.venue === "limitless" && input.limitlessPositionContract) {
    generation = `8453:${input.limitlessPositionContract.toLowerCase()}:${input.tokenId}`;
  } else return null;
  const expiry = input.expiry ? new Date(input.expiry) : null;
  if (expiry && !Number.isFinite(expiry.getTime())) return null;
  return {
    marketId: input.marketId,
    venue: input.venue as VerifiedBuyFacts["instrument"]["venue"],
    tokenId: input.tokenId,
    outcome: input.outcome,
    generation,
    expiry: expiry?.toISOString() ?? null,
  };
}
