import type { Pool } from "@hunch/infra";
import type { PolymarketAssetBinding } from "@hunch/db";
import {
  parsePolymarketAssetContext,
  POLYMARKET_PROTOCOL_CONTRACTS,
} from "@hunch/shared";
import type { Position } from "../order-types.js";
import {
  positionAssetKey,
  positionStorageContract,
} from "../lib/position-asset-context.js";
import {
  fetchMarketsByTokenIds,
  type MarketByTokenRow,
} from "../repos/unified-read.js";
import { polymarketContextFromBinding } from "./polymarket-asset-context.js";

/** At most three queries, independent of portfolio size. Frozen contexts never
 * pass through the replaceable token-only projection or merge with its ledger. */
export async function fetchPositionMarketRows(
  db: Pool,
  positions: readonly Position[],
  options: { venue?: string; includeTop?: boolean } = {},
): Promise<MarketByTokenRow[]> {
  const contexts = new Map<string, NonNullable<Position["assetContext"]>>();
  const ordinaryTokens = new Set<string>();
  const legacyTokens = [
    ...new Set(
      positions
        .filter(
          (position) =>
            position.venue === "polymarket" &&
            position.assetContext == null &&
            !position.positionContract,
        )
        .map((position) => position.tokenId),
    ),
  ];
  const legacyContexts = new Map<
    string,
    NonNullable<Position["assetContext"]>
  >();
  if (legacyTokens.length) {
    const { rows } = await db.query<PolymarketAssetBinding>(
      `select binding_row.* from polymarket_asset_bindings binding_row
       where binding_row.chain_id = 137
         and binding_row.position_contract = $1
         and binding_row.asset_id = any($2::text[])`,
      [
        POLYMARKET_PROTOCOL_CONTRACTS.conditionalTokens.toLowerCase(),
        legacyTokens,
      ],
    );
    for (const binding of rows) {
      const context = polymarketContextFromBinding(binding);
      if (!context) throw new Error("Legacy position binding is invalid.");
      legacyContexts.set(binding.asset_id, context);
    }
  }
  for (const position of positions) {
    const contextInput =
      position.assetContext ??
      (position.venue === "polymarket" && !position.positionContract
        ? legacyContexts.get(position.tokenId)
        : undefined);
    if (position.venue !== "polymarket" || contextInput == null) {
      ordinaryTokens.add(position.tokenId);
      continue;
    }
    const context = parsePolymarketAssetContext(contextInput);
    if (!context || context.assetId !== position.tokenId)
      throw new Error(
        "Position metadata requires its canonical asset context.",
      );
    contexts.set(
      positionAssetKey(
        position.tokenId,
        positionStorageContract({ ...position, assetContext: context }),
      ),
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
