-- Referral full-funnel backend attribution + server analytics collector.

create table if not exists referral_first_trade_conversions (
  id uuid primary key default gen_random_uuid(),
  referrer_user_id uuid not null references users(id) on delete cascade,
  referred_user_id uuid not null references users(id) on delete cascade,
  code text not null,
  venue text not null,
  status text not null,
  source_type text not null check (source_type in ('order', 'execution', 'amm')),
  source_id text not null,
  tx_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (referred_user_id)
);

create index if not exists idx_referral_first_trade_conversions_referrer
  on referral_first_trade_conversions(referrer_user_id, created_at desc);

create index if not exists idx_referral_first_trade_conversions_code_venue
  on referral_first_trade_conversions(code, venue, created_at desc);

create table if not exists analytics_server_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  event_name text not null,
  event_slug text,
  source text,
  status text,
  venue text,
  referred_user_key text,
  attempt_id text,
  analytics_schema_version text not null,
  dedupe_key text,
  origin text not null check (origin in ('browser', 'backend')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_analytics_server_events_event_dedupe
  on analytics_server_events(event_name, dedupe_key)
  where dedupe_key is not null;

create index if not exists idx_analytics_server_events_created_at
  on analytics_server_events(created_at desc);

create index if not exists idx_analytics_server_events_event_name
  on analytics_server_events(event_name, created_at desc);

create index if not exists idx_analytics_server_events_event_slug
  on analytics_server_events(event_slug, created_at desc)
  where event_slug is not null;

create index if not exists idx_analytics_server_events_schema_version
  on analytics_server_events(analytics_schema_version, created_at desc);

create index if not exists idx_analytics_server_events_origin
  on analytics_server_events(origin, created_at desc);

do $$
begin
  if not exists (
    select 1
    from information_schema.triggers
    where trigger_name = 'update_referral_first_trade_conversions_updated_at'
  ) then
    create trigger update_referral_first_trade_conversions_updated_at
    before update on referral_first_trade_conversions
    for each row
    execute function update_updated_at_column();
  end if;

end $$;

create or replace view analytics_referral_full_funnel as
with referral_codes as (
  select distinct r.code as referral_code
  from referrals r
  where r.code is not null

  union

  select distinct e.event_slug as referral_code
  from analytics_server_events e
  where e.event_slug is not null
    and e.event_name in (
      'hf_portfolio_share_action',
      'hf_rewards_referral_action',
      'hf_referral_link_landing'
    )

  union

  select distinct c.code as referral_code
  from referral_first_trade_conversions c
  where c.code is not null
),
share_counts as (
  select e.event_slug as referral_code, count(*)::bigint as share_count
  from analytics_server_events e
  where e.event_slug is not null
    and e.event_name in ('hf_portfolio_share_action', 'hf_rewards_referral_action')
  group by e.event_slug
),
landing_counts as (
  select e.event_slug as referral_code, count(*)::bigint as landing_count
  from analytics_server_events e
  where e.event_slug is not null
    and e.event_name = 'hf_referral_link_landing'
  group by e.event_slug
),
signup_counts as (
  select r.code as referral_code, count(*)::bigint as signup_count
  from referrals r
  where r.code is not null
  group by r.code
),
first_trade_counts as (
  select c.code as referral_code, count(*)::bigint as first_trade_count
  from referral_first_trade_conversions c
  group by c.code
)
select
  rc.referral_code,
  coalesce(sc.share_count, 0::bigint) as share_count,
  coalesce(lc.landing_count, 0::bigint) as landing_count,
  coalesce(suc.signup_count, 0::bigint) as signup_count,
  coalesce(ftc.first_trade_count, 0::bigint) as first_trade_count
from referral_codes rc
left join share_counts sc on sc.referral_code = rc.referral_code
left join landing_counts lc on lc.referral_code = rc.referral_code
left join signup_counts suc on suc.referral_code = rc.referral_code
left join first_trade_counts ftc on ftc.referral_code = rc.referral_code;

create or replace view analytics_referral_event_rollup as
select
  rollup.referral_code,
  rollup.event_name,
  rollup.source,
  rollup.status,
  rollup.venue,
  rollup.event_count
from (
  select
    e.event_slug as referral_code,
    e.event_name,
    e.source,
    e.status,
    e.venue,
    count(*)::bigint as event_count
  from analytics_server_events e
  where e.event_slug is not null
    and e.event_name in (
      'hf_portfolio_share_action',
      'hf_rewards_referral_action',
      'hf_referral_link_landing'
    )
  group by e.event_slug, e.event_name, e.source, e.status, e.venue

  union all

  select
    r.code as referral_code,
    'hf_referral_signup_attributed'::text as event_name,
    'auth_privy'::text as source,
    'attached'::text as status,
    null::text as venue,
    count(*)::bigint as event_count
  from referrals r
  where r.code is not null
  group by r.code

  union all

  select
    c.code as referral_code,
    'hf_referral_first_trade'::text as event_name,
    'backend_trade'::text as source,
    c.status,
    c.venue,
    count(*)::bigint as event_count
  from referral_first_trade_conversions c
  where c.code is not null
  group by c.code, c.status, c.venue
) as rollup;
