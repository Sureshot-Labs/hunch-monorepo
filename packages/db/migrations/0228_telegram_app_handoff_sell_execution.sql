-- A v2 direct Telegram → Mini App handoff may seal a Buy or Sell.  Funding
-- remains Buy-only: Sell has no FundingOperation or consumer reservation.
-- NOT VALID keeps deployment available even if an unrelated historical row no
-- longer satisfies the old, narrower semantic constraint; new writes are
-- checked immediately and historical validation can be scheduled separately.

alter table telegram_trade_intents
  drop constraint if exists telegram_trade_intents_delivery_authority_check;

alter table telegram_trade_intents
  add constraint telegram_trade_intents_delivery_authority_check
  check (
    delivery_mode = 'bot_submit'
    or (
      action = 'buy'
      and jsonb_typeof(result -> 'appHandoffExecution') = 'object'
      and result -> 'appHandoffExecution' ->> 'version' = '1'
      and nullif(result -> 'appHandoffExecution' ->> 'committedAt', '') is not null
      and status in (
        'confirming',
        'executing',
        'submitted',
        'filled',
        'reconcile_required',
        'failed',
        'cancelled',
        'expired'
      )
    )
    or (
      action in ('buy', 'sell')
      and jsonb_typeof(result -> 'appHandoffExecution') = 'object'
      and result -> 'appHandoffExecution' ->> 'version' = '2'
      and nullif(result -> 'appHandoffExecution' ->> 'committedAt', '') is not null
      and status in (
        'confirming',
        'external_handoff',
        'funding',
        'executing',
        'submitted',
        'filled',
        'reconcile_required',
        'failed',
        'cancelled',
        'expired'
      )
      and (
        (action = 'buy' and (status <> 'funding' or funding_operation_id is not null))
        or (
          action = 'sell'
          and result -> 'appHandoffExecution' ->> 'kind' = 'direct_trade'
          and status <> 'funding'
          and funding_operation_id is null
          and funding_reservation_id is null
        )
      )
    )
    or (
      action in ('buy', 'sell')
      and status not in (
        'executing',
        'submitted',
        'filled',
        'reconcile_required'
      )
          and (
            status <> 'confirming'
            or (
              action = 'buy'
              and (
                (
                  result ->> 'fundingState' = 'internal_route'
                  and jsonb_typeof(result -> 'fundingProposal') = 'object'
                )
                or (
                  result ->> 'fundingState' = 'web_funding_plan'
                  and jsonb_typeof(result -> 'appHandoffV2') = 'object'
                  and result -> 'appHandoffV2' ->> 'version' = '2'
                  and jsonb_typeof(result -> 'appHandoffV2' -> 'plan') = 'object'
                )
              )
            )
          )
          and (status <> 'funding' or (action = 'buy' and funding_operation_id is not null))
          and (
            action = 'buy'
            or (
              funding_operation_id is null
              and funding_reservation_id is null
            )
          )
          and submit_started_at is null
      and submitted_at is null
      and order_id is null
      and execution_id is null
      and venue_order_id is null
      and tx_signature is null
    )
  ) not valid;

-- A committed v2 handoff remains immutable, except that a user may cancel its
-- still-unsubmitted Buy/Sell.  `committed_at` is retained as durable evidence
-- that the exact plan had been materialized before that cancellation.
alter table telegram_app_handoffs
  drop constraint if exists telegram_app_handoffs_check3;

alter table telegram_app_handoffs
  add constraint telegram_app_handoffs_check3
  check (
    (state = 'issued'
      and claimed_at is null
      and committed_at is null
      and cancelled_at is null
      and expired_at is null)
    or (state = 'claimed'
      and claimed_at is not null
      and committed_at is null
      and cancelled_at is null
      and expired_at is null)
    or (state = 'committed'
      and claimed_at is not null
      and committed_at is not null
      and cancelled_at is null
      and expired_at is null)
    or (state = 'cancelled'
      and cancelled_at is not null
      and expired_at is null)
    or (state = 'expired'
      and committed_at is null
      and cancelled_at is null
      and expired_at is not null)
  ) not valid;

create or replace function guard_telegram_app_handoff_update()
returns trigger
language plpgsql
as $$
begin
  if new.id <> old.id
    or new.trade_intent_id <> old.trade_intent_id
    or new.user_id <> old.user_id
    or new.telegram_user_id <> old.telegram_user_id
    or new.token_hash <> old.token_hash
    or new.plan_fingerprint <> old.plan_fingerprint
    or new.policy_revision <> old.policy_revision
    or new.authority_fingerprint <> old.authority_fingerprint
    or new.quote_snapshot <> old.quote_snapshot
    or new.plan_snapshot <> old.plan_snapshot
    or new.issued_at <> old.issued_at
    or new.expires_at <> old.expires_at
  then
    raise exception 'telegram app handoff identity is immutable'
      using errcode = '23514';
  end if;

  if old.state = 'issued' and new.state = 'claimed'
    and new.claimed_at is not null
    and new.claimed_by_user_id = new.user_id
    and new.committed_at is null
    and new.cancelled_at is null
    and new.expired_at is null
  then
    return new;
  end if;
  if old.state = 'issued' and new.state = 'cancelled'
    and new.claimed_at is null
    and new.claimed_by_user_id is null
    and new.committed_at is null
    and new.cancelled_at is not null
    and new.expired_at is null
  then
    return new;
  end if;
  if old.state = 'issued' and new.state = 'expired'
    and new.claimed_at is null
    and new.claimed_by_user_id is null
    and new.committed_at is null
    and new.cancelled_at is null
    and new.expired_at is not null
  then
    return new;
  end if;
  if old.state = 'claimed' and new.state = 'committed'
    and new.claimed_at is not distinct from old.claimed_at
    and new.claimed_by_user_id is not distinct from old.claimed_by_user_id
    and new.committed_at is not null
    and new.cancelled_at is null
    and new.expired_at is null
  then
    return new;
  end if;
  if old.state = 'claimed' and new.state = 'cancelled'
    and new.claimed_at is not distinct from old.claimed_at
    and new.claimed_by_user_id is not distinct from old.claimed_by_user_id
    and new.committed_at is null
    and new.cancelled_at is not null
    and new.expired_at is null
  then
    return new;
  end if;
  if old.state = 'claimed' and new.state = 'expired'
    and new.claimed_at is not distinct from old.claimed_at
    and new.claimed_by_user_id is not distinct from old.claimed_by_user_id
    and new.committed_at is null
    and new.cancelled_at is null
    and new.expired_at is not null
  then
    return new;
  end if;
  if old.state = 'committed' and new.state = 'cancelled'
    and old.plan_snapshot ->> 'version' = '2'
    and new.claimed_at is not distinct from old.claimed_at
    and new.claimed_by_user_id is not distinct from old.claimed_by_user_id
    and new.committed_at is not distinct from old.committed_at
    and new.cancelled_at is not null
    and new.expired_at is null
  then
    return new;
  end if;
  if new.state = old.state
    and new.claimed_at is not distinct from old.claimed_at
    and new.claimed_by_user_id is not distinct from old.claimed_by_user_id
    and new.committed_at is not distinct from old.committed_at
    and new.cancelled_at is not distinct from old.cancelled_at
    and new.expired_at is not distinct from old.expired_at
  then
    return new;
  end if;

  raise exception 'illegal telegram app handoff state transition: % -> %', old.state, new.state
    using errcode = '23514';
end;
$$;
