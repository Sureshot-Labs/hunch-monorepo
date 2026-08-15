-- app_handoff may enter confirming only to obtain user consent for one
-- internal funding route. It still cannot enter any trade-submission state or
-- carry provider execution identifiers.

alter table telegram_trade_intents
  drop constraint if exists telegram_trade_intents_delivery_authority_check;

alter table telegram_trade_intents
  add constraint telegram_trade_intents_delivery_authority_check
  check (
    delivery_mode = 'bot_submit'
    or (
      action = 'buy'
      and venue = 'limitless'
      and status not in (
        'executing',
        'submitted',
        'filled',
        'reconcile_required'
      )
      and (
        status <> 'confirming'
        or (
          result ->> 'fundingState' = 'internal_route'
          and jsonb_typeof(result -> 'fundingProposal') = 'object'
        )
      )
      and (
        status <> 'funding'
        or funding_operation_id is not null
      )
      and submit_started_at is null
      and submitted_at is null
      and order_id is null
      and execution_id is null
      and venue_order_id is null
      and tx_signature is null
    )
  );
