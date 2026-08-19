-- A claimed Telegram Mini App handoff becomes execution-capable only after
-- commit has written the sealed handoff marker onto the bound trade intent.
-- Before that marker exists, app-handoff intents retain the no-submit guard
-- introduced by 0221_telegram_app_handoff_intents.sql.

alter table telegram_trade_intents
  drop constraint if exists telegram_trade_intents_delivery_authority_check;

alter table telegram_trade_intents
  add constraint telegram_trade_intents_delivery_authority_check
  check (
    delivery_mode = 'bot_submit'
    or (
      action = 'buy'
      and (
        (
          jsonb_typeof(result -> 'appHandoffExecution') = 'object'
          and result -> 'appHandoffExecution' ->> 'version' = '1'
          and nullif(
            result -> 'appHandoffExecution' ->> 'committedAt',
            ''
          ) is not null
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
          status not in (
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
      )
    )
  );
