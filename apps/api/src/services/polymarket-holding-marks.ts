import type { Pool } from "@hunch/infra";
import type { PolymarketAssetContext } from "@hunch/shared";

import {
  positionAssetKey,
  positionStorageContract,
} from "../lib/position-asset-context.js";

export type PolymarketHoldingMarkRow = {
  token_id: string;
  position_contract: string;
  market_id: string;
  outcome_side: "YES" | "NO";
  current_token_id: string | null;
  top_ts: Date | string | null;
  best_bid: string | null;
  best_ask: string | null;
  mid: string | null;
  last_price: string | null;
  resolved_outcome: string | null;
  resolved_outcome_pct: string | null;
  status: string | null;
};

/** Marks are for the frozen underlying market/outcome, not the current owner
 * of a numeric ID. Current canonical assets supply prices after a migration.
 * The caller supplies only contexts already resolved from durable provenance.
 */
export async function loadPolymarketHoldingMarkRows(
  db: Pick<Pool, "query">,
  holdings: readonly {
    tokenId: string;
    positionContract?: string;
    assetContext?: PolymarketAssetContext | null;
  }[],
): Promise<Map<string, PolymarketHoldingMarkRow>> {
  const unique = new Map(
    holdings.map((holding) => {
      const positionContract = holding.assetContext
        ? positionStorageContract({ venue: "polymarket", ...holding })
        : (holding.positionContract ?? "");
      if (
        holding.positionContract != null &&
        holding.positionContract !== positionContract
      )
        throw new Error(
          "Holding mark context does not match its storage ledger.",
        );
      return [
        positionAssetKey(holding.tokenId, positionContract),
        { ...holding, positionContract },
      ] as const;
    }),
  );
  const wanted = [...unique.values()];
  if (!wanted.length) return new Map();
  const { rows } = await db.query<PolymarketHoldingMarkRow>(
    `with wanted as (
       select * from unnest($1::text[], $2::text[], $3::text[], $4::text[])
         as holding_row(token_id, position_contract, market_id, outcome_side)
     ), resolved_assets as (
       select holding_row.token_id, holding_row.position_contract,
         coalesce(binding_row.market_id, holding_row.market_id, legacy_token.market_id) as market_id,
         coalesce(case binding_row.outcome_index when 0 then 'YES' when 1 then 'NO' end,
           holding_row.outcome_side, legacy_token.side) as outcome_side
       from wanted holding_row
       left join polymarket_asset_bindings binding_row
         on binding_row.chain_id = 137 and binding_row.asset_id = holding_row.token_id
        and binding_row.position_contract = coalesce(nullif(holding_row.position_contract, ''), '0x4d97dcd97ec945f40cf65f87097ace5ea0476045')
       left join unified_tokens legacy_token
         on binding_row.market_id is null and holding_row.market_id is null
        and holding_row.position_contract = '' and legacy_token.venue = 'polymarket'
        and legacy_token.token_id = holding_row.token_id
     )
     select resolved_asset.token_id, resolved_asset.position_contract, resolved_asset.market_id,
       resolved_asset.outcome_side, coalesce(canonical_token.token_id,
         market_row.clob_token_ids::jsonb->>(case resolved_asset.outcome_side when 'YES' then 0 else 1 end),
         case resolved_asset.outcome_side when 'YES' then market_row.token_yes else market_row.token_no end) as current_token_id,
       top_row.ts as top_ts, top_row.best_bid, top_row.best_ask, top_row.mid,
       case when resolved_asset.outcome_side = 'NO' then 1 - market_row.last_price else market_row.last_price end as last_price,
       market_row.resolved_outcome,
       market_row.resolved_outcome_pct::text as resolved_outcome_pct, market_row.status::text as status
     from resolved_assets resolved_asset
     join unified_markets market_row on market_row.id = resolved_asset.market_id
     left join unified_market_tokens canonical_token
       on canonical_token.market_id = resolved_asset.market_id
      and canonical_token.outcome_side = resolved_asset.outcome_side
     left join unified_token_top_latest top_row on top_row.token_id = coalesce(canonical_token.token_id,
       market_row.clob_token_ids::jsonb->>(case resolved_asset.outcome_side when 'YES' then 0 else 1 end),
       case resolved_asset.outcome_side when 'YES' then market_row.token_yes else market_row.token_no end)
     where resolved_asset.outcome_side in ('YES', 'NO')`,
    [
      wanted.map((row) => row.tokenId),
      wanted.map((row) => row.positionContract),
      wanted.map((row) => row.assetContext?.marketId ?? null),
      wanted.map((row) =>
        row.assetContext
          ? row.assetContext.outcomeIndex === 0
            ? "YES"
            : "NO"
          : null,
      ),
    ],
  );
  return new Map(
    rows.map((row) => [
      positionAssetKey(row.token_id, row.position_contract),
      row,
    ]),
  );
}
