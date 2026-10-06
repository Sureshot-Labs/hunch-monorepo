import { POLYMARKET_PROTOCOL_CONTRACTS } from "@hunch/shared";

/** Historical orders without context stay in the existing CTF namespace.
 * An explicit different/invalid ledger never silently falls back to CTF.
 * Callers pass a fixed SQL alias, not a user-supplied identifier.
 */
export function polymarketOrderStorageContractSql(alias: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(alias))
    throw new Error("Invalid order SQL alias.");
  const legacy = POLYMARKET_PROTOCOL_CONTRACTS.conditionalTokens.toLowerCase();
  const ledger = `lower(coalesce(nullif(${alias}.order_payload->'assetContext'->>'positionContract', ''), '${legacy}'))`;
  return `(case when ${alias}.venue = 'polymarket' and ${ledger} <> '${legacy}' then ${ledger} else '' end)`;
}

export function polymarketOrderBindingJoinSql(alias: string): string {
  return `left join polymarket_asset_bindings order_binding
    on ${alias}.venue = 'polymarket' and order_binding.chain_id = 137
   and order_binding.asset_id = ${alias}.token_id
   and order_binding.position_contract = coalesce(nullif(${polymarketOrderStorageContractSql(alias)}, ''), '${POLYMARKET_PROTOCOL_CONTRACTS.conditionalTokens.toLowerCase()}')`;
}

/** Frozen order identity precedes durable bindings and current projections. */
export function polymarketOrderMarketIdSql(
  alias: string,
  projectedMarketSql: string,
): string {
  polymarketOrderStorageContractSql(alias);
  return `(case when ${alias}.venue = 'polymarket' then coalesce(nullif(${alias}.order_payload->'assetContext'->>'marketId', ''), order_binding.market_id, ${projectedMarketSql}) else ${projectedMarketSql} end)`;
}

export function polymarketOrderOutcomeSideSql(
  alias: string,
  projectedSideSql: string,
): string {
  polymarketOrderStorageContractSql(alias);
  return `(case when ${alias}.venue = 'polymarket' then coalesce(
    case ${alias}.order_payload->'assetContext'->>'outcomeIndex' when '0' then 'YES' when '1' then 'NO' end,
    case order_binding.outcome_index when 0 then 'YES' when 1 then 'NO' end,
    ${projectedSideSql}) else ${projectedSideSql} end)`;
}
