-- Relink Limitless grouped child markets that were ingested as standalone
-- events. Limitless can return group children as top-level "single" rows with
-- raw.groupId; the parent group remains the canonical unified event.

with grouped_children as (
  select
    lm.id as child_id,
    nullif(btrim(lm.raw->>'groupId'), '') as group_id
  from limitless_markets lm
  join limitless_events le
    on le.id = nullif(btrim(lm.raw->>'groupId'), '')
   and le.market_type = 'group'
  join unified_events ue
    on ue.id = 'limitless:' || nullif(btrim(lm.raw->>'groupId'), '')
  where lm.market_type = 'single'
    and nullif(btrim(lm.raw->>'groupId'), '') is not null
)
update limitless_markets lm
set
  event_id = gc.group_id,
  raw = jsonb_set(lm.raw, '{groupId}', to_jsonb(gc.group_id), true),
  updated_at_db = now()
from grouped_children gc
where lm.id = gc.child_id
  and lm.event_id is distinct from gc.group_id;

with grouped_children as (
  select
    lm.id as child_id,
    nullif(btrim(lm.raw->>'groupId'), '') as group_id
  from limitless_markets lm
  join limitless_events le
    on le.id = nullif(btrim(lm.raw->>'groupId'), '')
   and le.market_type = 'group'
  join unified_events ue
    on ue.id = 'limitless:' || nullif(btrim(lm.raw->>'groupId'), '')
  where lm.market_type = 'single'
    and nullif(btrim(lm.raw->>'groupId'), '') is not null
)
update unified_markets um
set
  event_id = 'limitless:' || gc.group_id,
  metadata = coalesce(um.metadata, '{}'::jsonb)
    || jsonb_build_object('groupId', gc.group_id),
  updated_at_db = now()
from grouped_children gc
where um.venue = 'limitless'
  and um.venue_market_id = gc.child_id
  and um.event_id is distinct from 'limitless:' || gc.group_id;
