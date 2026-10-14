// Only derived public data: finance/history protection stays on unified parents.
export function hip4AccountProtectedRefsSql(candidateTable: string) {
  return `select distinct candidate_row.market_id,'hip4_account_executions' as reason
    from ${candidateTable} candidate_row join hip4_account_executions execution_row
      on execution_row.canonical_market_id=candidate_row.market_id
    union
    select distinct candidate_row.market_id,'hip4_account_positions' as reason
    from ${candidateTable} candidate_row join hip4_account_positions position_row
      on position_row.canonical_market_id=candidate_row.market_id
    union
    select distinct candidate_row.market_id,'hip4_account_open_orders' as reason
    from ${candidateTable} candidate_row join hip4_account_snapshots snapshot_row
      on exists (select 1 from jsonb_array_elements(case
        when jsonb_typeof(snapshot_row.history->'openOrders'->'items')='array'
          then snapshot_row.history->'openOrders'->'items' else '[]'::jsonb end) order_item
        where order_item->>'marketId'=candidate_row.market_id)`;
}
export function hip4DerivedReferencesSql(
  candidateTable: "candidate_pool",
  history = true,
) {
  return `select 'hip4_read_markets' as label, count(distinct h.market_id)::text as markets, count(*)::text as "rows"
    from hip4_read_markets h join ${candidateTable} c on c.market_id=h.market_id
    union all
    select 'hip4_public_trades' as label, count(distinct h.market_id)::text as markets, count(*)::text as "rows"
    from hip4_public_trades h join ${candidateTable} c on c.market_id=h.market_id${
      history
        ? `
    union all select 'hip4_candles' as label,count(distinct h.market_id)::text as markets,count(*)::text as "rows"
    from hip4_candles h join ${candidateTable} c on c.market_id=h.market_id
    union all select 'hip4_observation_intervals' as label,count(distinct h.market_id)::text as markets,count(*)::text as "rows"
    from hip4_observation_intervals h join ${candidateTable} c on c.market_id=h.market_id`
        : ""
    }`;
}

export function hip4DerivedDeleteSql(
  table:
    | "hip4_public_trades"
    | "hip4_read_markets"
    | "hip4_candles"
    | "hip4_observation_intervals",
) {
  return `delete from ${table} h using tmp_market_retention_removable_markets c where c.market_id=h.market_id`;
}
