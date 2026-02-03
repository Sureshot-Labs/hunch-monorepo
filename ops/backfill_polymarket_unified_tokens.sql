-- Backfill Polymarket CLOB token IDs into unified_tokens.
-- Safe to re-run: uses upsert on (market_id, side).

insert into unified_tokens(token_id, venue, market_id, side)
select elem.token_id,
       'polymarket' as venue,
       m.id as market_id,
       case when elem.ordinality = 1 then 'YES' else 'NO' end as side
from unified_markets m
join lateral json_array_elements_text(m.clob_token_ids::json)
  with ordinality as elem(token_id, ordinality) on true
where m.venue = 'polymarket'
  and m.clob_token_ids is not null
  and m.clob_token_ids <> ''
  and m.clob_token_ids <> '[]'
on conflict (market_id, side) do update
  set token_id = excluded.token_id,
      venue = excluded.venue,
      updated_at = now();
