alter table telegram_funding_sessions
  add column minimum_funding_usd numeric(18, 6),
  add constraint telegram_funding_sessions_minimum_funding_check
    check (
      minimum_funding_usd is null
      or (
        origin = 'buy_return_context'
        and minimum_funding_usd > 0
      )
    );

create or replace function guard_telegram_funding_session_identity()
returns trigger
language plpgsql
as $$
begin
  if (
    new.id,
    new.user_id,
    new.telegram_user_id,
    new.chat_id,
    new.receive_session_id,
    new.receive_owner_channel,
    new.origin,
    new.market_id,
    new.event_id,
    new.side,
    new.requested_spend_usd,
    new.minimum_funding_usd,
    new.idempotency_key,
    new.expires_at,
    new.created_at
  ) is distinct from (
    old.id,
    old.user_id,
    old.telegram_user_id,
    old.chat_id,
    old.receive_session_id,
    old.receive_owner_channel,
    old.origin,
    old.market_id,
    old.event_id,
    old.side,
    old.requested_spend_usd,
    old.minimum_funding_usd,
    old.idempotency_key,
    old.expires_at,
    old.created_at
  ) then
    raise exception 'telegram funding session identity is immutable';
  end if;
  return new;
end;
$$;
