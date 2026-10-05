import {
  parsePolymarketMarketAssets,
  readPolymarketIndexedAssets,
  POLYMARKET_PROTOCOL_CONTRACTS,
  type PolymarketMarketAssets,
} from "@hunch/shared";
import type { Pool } from "pg";

export type PolymarketBindingMarketSource = {
  id: string;
  venue: string;
  condition_id?: string | null;
  clob_token_ids?: string | null;
  outcomes?: string | null;
  metadata?: unknown;
};

export type PolymarketAssetBinding = {
  chain_id: number;
  position_contract: string;
  asset_id: string;
  market_id: string;
  protocol_version: PolymarketMarketAssets["protocolVersion"];
  asset_kind: PolymarketMarketAssets["assetKind"];
  condition_id: string;
  outcome_index: 0 | 1;
  neg_risk: boolean;
  exchange_address: string;
  order_domain_version: PolymarketMarketAssets["orderDomainVersion"];
  conditional_asset_type: PolymarketMarketAssets["conditionalAssetType"];
};

export function buildPolymarketAssetBindings(
  source: PolymarketBindingMarketSource,
): PolymarketAssetBinding[] {
  if (source.venue !== "polymarket") return [];
  const metadata =
    source.metadata && typeof source.metadata === "object"
      ? (source.metadata as Record<string, unknown>)
      : {};
  let protocol = parsePolymarketMarketAssets(metadata.polymarketProtocol);
  if (!protocol && metadata.polymarketProtocol == null) {
    // Existing stored CTF schema is historical provenance, not a fallback for
    // a new/unknown Gamma generation. Preserve it before replacing its IDs.
    protocol = readPolymarketIndexedAssets({
      version: metadata.version,
      positionIds: metadata.positionIds,
      conditionId: source.condition_id,
      clobTokenIds: source.clob_token_ids,
      outcomes: source.outcomes ?? metadata.outcomes,
      negRisk: metadata.negRisk,
    }).protocol;
  }
  if (!protocol) return [];
  return protocol.assets.map((assetId, outcomeIndex) => ({
    chain_id: POLYMARKET_PROTOCOL_CONTRACTS.chainId,
    position_contract: protocol.positionContract.toLowerCase(),
    asset_id: assetId,
    market_id: source.id,
    protocol_version: protocol.protocolVersion,
    asset_kind: protocol.assetKind,
    condition_id: protocol.conditionId,
    outcome_index: outcomeIndex as 0 | 1,
    neg_risk: protocol.negRisk,
    exchange_address: protocol.exchangeAddress.toLowerCase(),
    order_domain_version: protocol.orderDomainVersion,
    conditional_asset_type: protocol.conditionalAssetType,
  }));
}

/** Append-only identity. Retries cannot rewrite existing condition/ledger
 * attribution. Execution callers must compare the returned binding to their
 * resolved context; a conflicting upstream claim must not authorize a trade.
 */
export async function preservePolymarketAssetBindings(
  queryable: Pick<Pool, "query">,
  sources: readonly PolymarketBindingMarketSource[],
): Promise<void> {
  const unique = new Map<string, PolymarketAssetBinding>();
  for (const source of sources) {
    for (const row of buildPolymarketAssetBindings(source)) {
      const key = `${row.chain_id}:${row.position_contract}:${row.asset_id}`;
      if (!unique.has(key)) unique.set(key, row);
    }
  }
  const rows = [...unique.values()].sort((a, b) =>
    `${a.position_contract}:${a.asset_id}`.localeCompare(
      `${b.position_contract}:${b.asset_id}`,
    ),
  );
  if (!rows.length) return;
  await queryable.query(
    `insert into polymarket_asset_bindings (
      chain_id, position_contract, asset_id, market_id, protocol_version,
      asset_kind, condition_id, outcome_index, neg_risk, exchange_address,
      order_domain_version, conditional_asset_type
    ) select binding_row.*
    from jsonb_to_recordset($1::jsonb) as binding_row(
      chain_id integer, position_contract text, asset_id text, market_id text,
      protocol_version text, asset_kind text, condition_id text,
      outcome_index smallint, neg_risk boolean, exchange_address text,
      order_domain_version text, conditional_asset_type text
    )
    on conflict (chain_id, position_contract, asset_id) do nothing`,
    [JSON.stringify(rows)],
  );
}

export async function fetchPolymarketAssetBindings(
  queryable: Pick<Pool, "query">,
  assetId: string,
  positionContract?: string,
): Promise<PolymarketAssetBinding[]> {
  const { rows } = await queryable.query<PolymarketAssetBinding>(
    `select chain_id, position_contract, asset_id, market_id, protocol_version,
      asset_kind, condition_id, outcome_index, neg_risk, exchange_address,
      order_domain_version, conditional_asset_type
     from polymarket_asset_bindings
     where chain_id = $1 and asset_id = $2
       and ($3::text is null or position_contract = $3)
     order by position_contract`,
    [137, assetId, positionContract?.toLowerCase() ?? null],
  );
  return rows;
}
