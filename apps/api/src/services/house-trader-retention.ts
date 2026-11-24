// The selector supplies only its own SQL table identifiers, never user input.
export function houseTraderProtectedMarketReferencesSql(
  candidatePoolTable: string,
) {
  return `select distinct candidate.market_id, 'house_trader_actions' as reason
    from ${candidatePoolTable} candidate
    join house_trader_actions action_row on action_row.protected_market_id=candidate.market_id`;
}
