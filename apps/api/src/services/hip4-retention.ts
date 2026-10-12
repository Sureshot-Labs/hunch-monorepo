// Only derived public data: finance/history protection stays on unified parents.
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
