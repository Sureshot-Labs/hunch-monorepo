-- Backfill positions.position_scope for existing rows.
-- Requires migration 0070_positions_scope.sql to be applied first.
--
-- Classification rules:
-- 1) own      -> wallet_address belongs to user_wallets.user_id
-- 2) own      -> wallet_address matches active polymarket funder_address for user
-- 3) followed -> everything else with non-null wallet_address
--
-- Notes:
-- - EVM addresses are matched case-insensitively.
-- - Solana / non-EVM addresses are matched exact-case.
-- - Rows with null wallet_address are left unchanged (default own / legacy behavior).

-- ------------------------------------------------------------
-- Preview: current distribution
select position_scope, count(*) as rows
from positions
group by position_scope
order by position_scope;

-- ------------------------------------------------------------
-- Preview: how many rows would become own/followed
with classified as (
  select
    p.id,
    case
      when exists (
        select 1
        from user_wallets uw
        where uw.user_id = p.user_id
          and (
            (
              p.wallet_address ~* '^0x[0-9a-f]{40}$'
              and lower(uw.wallet_address) = lower(p.wallet_address)
            )
            or (
              not (p.wallet_address ~* '^0x[0-9a-f]{40}$')
              and uw.wallet_address = p.wallet_address
            )
          )
      ) then 'own'
      when exists (
        select 1
        from user_venue_credentials uvc
        where uvc.user_id = p.user_id
          and uvc.venue = 'polymarket'
          and uvc.is_active = true
          and uvc.funder_address is not null
          and lower(uvc.funder_address) = lower(p.wallet_address)
      ) then 'own'
      else 'followed'
    end as new_scope
  from positions p
  where p.wallet_address is not null
)
select new_scope, count(*) as rows
from classified
group by new_scope
order by new_scope;

-- ------------------------------------------------------------
-- Apply backfill
with classified as (
  select
    p.id,
    case
      when exists (
        select 1
        from user_wallets uw
        where uw.user_id = p.user_id
          and (
            (
              p.wallet_address ~* '^0x[0-9a-f]{40}$'
              and lower(uw.wallet_address) = lower(p.wallet_address)
            )
            or (
              not (p.wallet_address ~* '^0x[0-9a-f]{40}$')
              and uw.wallet_address = p.wallet_address
            )
          )
      ) then 'own'
      when exists (
        select 1
        from user_venue_credentials uvc
        where uvc.user_id = p.user_id
          and uvc.venue = 'polymarket'
          and uvc.is_active = true
          and uvc.funder_address is not null
          and lower(uvc.funder_address) = lower(p.wallet_address)
      ) then 'own'
      else 'followed'
    end as new_scope
  from positions p
  where p.wallet_address is not null
)
update positions p
set position_scope = c.new_scope
from classified c
where p.id = c.id
  and p.position_scope is distinct from c.new_scope;

-- ------------------------------------------------------------
-- Verify distribution after update
select position_scope, count(*) as rows
from positions
group by position_scope
order by position_scope;
