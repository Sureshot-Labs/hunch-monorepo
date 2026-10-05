import type { Pool } from "@hunch/infra";
import {
  parsePolymarketAssetContext,
  POLYMARKET_PROTOCOL_CONTRACTS,
} from "@hunch/shared";
import { positionStorageContract } from "../lib/position-asset-context.js";
import { fetchPolymarketMarketInfo } from "../repos/polymarket-markets.js";
import { resolvePolymarketAssetContext } from "./polymarket-asset-context.js";

/** Read only; the caller still verifies the live canonical funder/balance and
 * policy before signing. The UI's position UUID is not authority for an asset. */
export async function loadOwnedPolymarketPositionSelection(
  db: Pick<Pool, "query">,
  input: {
    userId: string;
    positionRef: string;
    marketId: string;
    expectedWallet?: string | null;
  },
) {
  const { rows } = await db.query<{
    token_id: string;
    position_contract: string;
    asset_context: unknown;
    wallet_address: string | null;
  }>(
    `select token_id, position_contract, asset_context, wallet_address
       from positions where user_id = $1::uuid and id = $2::uuid and venue = 'polymarket'`,
    [input.userId, input.positionRef],
  );
  const row = rows[0];
  if (
    !row?.wallet_address ||
    (input.expectedWallet &&
      row.wallet_address.toLowerCase() !== input.expectedWallet.toLowerCase())
  )
    return null;
  const stored = parsePolymarketAssetContext(row.asset_context);
  if (row.asset_context != null && !stored)
    throw new Error(
      "Position asset context is malformed. Refresh the position.",
    );
  const context = await resolvePolymarketAssetContext(
    db as Pool,
    row.token_id,
    await fetchPolymarketMarketInfo(db as Pool, { tokenId: row.token_id }),
    stored,
    row.position_contract || POLYMARKET_PROTOCOL_CONTRACTS.conditionalTokens,
  );
  if (
    !context ||
    context.marketId !== input.marketId ||
    positionStorageContract({
      venue: "polymarket",
      tokenId: row.token_id,
      assetContext: context,
    }) !== row.position_contract
  )
    return null;
  return {
    tokenId: row.token_id,
    assetContext: context,
    positionRef: input.positionRef,
  };
}
