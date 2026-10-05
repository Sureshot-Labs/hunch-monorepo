import type { Pool } from "@hunch/infra";
import { parsePolymarketAssetContext } from "@hunch/shared";
import type { Position } from "../order-types.js";
import {
  positionAssetKey,
  positionStorageContract,
} from "../lib/position-asset-context.js";
import {
  fetchMarketsByTokenIds,
  type MarketByTokenRow,
} from "../repos/unified-read.js";

/** At most two queries, independent of portfolio size. Frozen contexts never
 * pass through the replaceable token-only projection or merge with its ledger. */
export async function fetchPositionMarketRows(
  db: Pool,
  positions: readonly Position[],
  options: { venue?: string; includeTop?: boolean } = {},
): Promise<MarketByTokenRow[]> {
  const contexts = new Map<string, NonNullable<Position["assetContext"]>>();
  const ordinaryTokens = new Set<string>();
  for (const position of positions) {
    if (position.venue !== "polymarket" || position.assetContext == null) {
      ordinaryTokens.add(position.tokenId);
      continue;
    }
    const context = parsePolymarketAssetContext(position.assetContext);
    if (!context || context.assetId !== position.tokenId)
      throw new Error(
        "Position metadata requires its canonical asset context.",
      );
    contexts.set(
      positionAssetKey(position.tokenId, positionStorageContract(position)),
      context,
    );
  }
  const frozen = [...contexts.values()];
  const [ordinaryRows, frozenRows] = await Promise.all([
    ordinaryTokens.size
      ? fetchMarketsByTokenIds(db, {
          ...options,
          tokenIds: [...ordinaryTokens],
        })
      : [],
    frozen.length
      ? fetchMarketsByTokenIds(db, {
          ...options,
          venue: "polymarket",
          tokenIds: frozen.map((context) => context.assetId),
          marketAssetContexts: frozen,
        })
      : [],
  ]);
  return [...ordinaryRows, ...frozenRows];
}
