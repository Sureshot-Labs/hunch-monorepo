/** Matching evidence is retained in v1. The normal selector and its fresh
 * pre-delete recheck both exclude every referenced market and event child. */
export function matchingProtectedReferences(candidateTable: string): string {
  if (!/^[a-z_]+$/.test(candidateTable))
    throw new Error("Invalid internal candidate table");
  return `select distinct c.market_id, 'market_matching_history' as reason
    from ${candidateTable} c
    where exists(select 1 from market_contract_versions v where v.market_id=c.market_id)
       or exists(select 1 from market_contract_versions v where v.event_id=c.event_id)
       or exists(select 1 from event_match_versions v where v.event_id=c.event_id)
       or exists(select 1 from market_matching_interest i where i.market_id=c.market_id)
       or exists(select 1 from market_matching_demand_limits d where d.market_id=c.market_id)`;
}
export function matchingDerivedReferences(candidateTable: string): string {
  if (!/^[a-z_]+$/.test(candidateTable))
    throw new Error("Invalid internal candidate table");
  return `select 'market_contract_versions_retained' as "label",count(distinct c.market_id)::text as markets,count(*)::text as "rows"
    from market_contract_versions v join ${candidateTable} c on c.market_id=v.market_id
    union all
    select 'market_contract_event_versions_retained' as "label",count(distinct c.market_id)::text as markets,count(distinct v.id)::text as "rows"
    from market_contract_versions v join ${candidateTable} c on c.event_id=v.event_id
    union all
    select 'event_match_versions_retained' as "label",count(distinct c.market_id)::text as markets,count(distinct v.id)::text as "rows"
    from event_match_versions v join ${candidateTable} c on c.event_id=v.event_id
    union all select 'market_matching_interest_retained',count(distinct c.market_id)::text,count(*)::text from market_matching_interest i join ${candidateTable} c on c.market_id=i.market_id
    union all select 'market_matching_demand_limits_retained',count(distinct c.market_id)::text,count(*)::text from market_matching_demand_limits d join ${candidateTable} c on c.market_id=d.market_id`;
}
