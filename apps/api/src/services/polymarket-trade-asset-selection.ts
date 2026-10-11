import {
  parsePolymarketAssetContext,
  type PolymarketAssetContext,
} from "@hunch/shared";
import { PolymarketAssetContextError } from "./polymarket-asset-context.js";

/** Historical SELL keeps its ledger. A token-only target cannot authorize
 * substituting a different current outcome asset or guessing a new ledger. */
export function selectPolymarketTradeAsset(input: {
  action: "BUY" | "SELL";
  assetContext?: unknown;
  currentTokenId: string;
  marketId: string;
  outcomeIndex: 0 | 1;
  targetTokenId?: string | null;
}): { tokenId: string; assetContext?: PolymarketAssetContext } {
  const context = parsePolymarketAssetContext(input.assetContext);
  const tokenId =
    context?.assetId ?? input.targetTokenId ?? input.currentTokenId;
  if (
    (input.assetContext != null && !context) ||
    (context &&
      (context.marketId !== input.marketId ||
        context.outcomeIndex !== input.outcomeIndex)) ||
    (input.targetTokenId != null && input.targetTokenId !== tokenId) ||
    (tokenId !== input.currentTokenId && (input.action !== "SELL" || !context))
  )
    throw new PolymarketAssetContextError(
      "The selected Polymarket asset changed. Refresh the position before signing.",
    );
  return { tokenId, ...(context ? { assetContext: context } : {}) };
}
