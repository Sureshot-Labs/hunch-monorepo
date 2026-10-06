import { POLYMARKET_PROTOCOL_CONTRACTS } from "@hunch/shared";

/** Requires a bounded scoped_markets(id,event_id,venue) CTE. Historical asset
 * discovery starts from those markets, never from the global positions/orders
 * tables. Both CTF and PM survive replacement of the current projection.
 */
export const SCOPED_MARKET_HOLDING_ASSETS_SQL = `scoped_tokens as materialized (
  select t.token_id, t.venue, m.event_id, m.id as market_id,
         ''::text as position_contract, t.side as outcome_side
  from scoped_markets m
  join unified_tokens t on t.market_id = m.id and t.venue = m.venue
  where m.venue <> 'polymarket' or not exists (
    select 1 from polymarket_asset_bindings binding
    where binding.chain_id = 137 and binding.asset_id = t.token_id
  )
  union all
  select binding.asset_id, m.venue, m.event_id, m.id,
         case when binding.position_contract = '${POLYMARKET_PROTOCOL_CONTRACTS.conditionalTokens.toLowerCase()}' then '' else binding.position_contract end,
         case binding.outcome_index when 0 then 'YES' when 1 then 'NO' end
  from scoped_markets m
  join polymarket_asset_bindings binding
    on m.venue = 'polymarket' and binding.market_id = m.id
   and binding.chain_id = 137
)`;
