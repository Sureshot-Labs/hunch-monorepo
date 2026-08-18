-- Shortfall funding is a durable operation, not a callback-driven screen.
-- Keep a revisioned edit outbox so finance-worker state changes can update the
-- originating private Telegram card without asking the user to press Refresh.
alter table telegram_bot_action_outbox
  add column if not exists trade_intent_id uuid
    references telegram_trade_intents(id) on delete cascade;

alter table telegram_bot_action_outbox
  drop constraint if exists telegram_bot_action_outbox_action_check,
  drop constraint if exists telegram_bot_action_outbox_shape_check,
  drop constraint if exists telegram_bot_action_outbox_delivery_attempt_check;

alter table telegram_bot_action_outbox
  add constraint telegram_bot_action_outbox_action_check
    check (
      action in (
        'welcome_menu',
        'funding_send',
        'funding_edit',
        'funding_replacement',
        'funding_qr',
        'trade_funding_edit'
      )
    ),
  add constraint telegram_bot_action_outbox_shape_check
    check (
      (
        action = 'welcome_menu'
        and telegram_account_id is not null
        and funding_session_id is null
        and trade_intent_id is null
        and state_revision is null
        and payload is null
        and delivery_attempt_id is null
        and delivery_started_at is null
      )
      or (
        action in (
          'funding_send',
          'funding_edit',
          'funding_replacement',
          'funding_qr'
        )
        and funding_session_id is not null
        and trade_intent_id is null
        and state_revision > 0
        and jsonb_typeof(payload) = 'object'
      )
      or (
        action = 'trade_funding_edit'
        and funding_session_id is null
        and trade_intent_id is not null
        and state_revision > 0
        and jsonb_typeof(payload) = 'object'
      )
    ),
  add constraint telegram_bot_action_outbox_delivery_attempt_check
    check (
      (
        delivery_attempt_id is null
        and delivery_started_at is null
      )
      or (
        delivery_attempt_id is not null
        and delivery_started_at is not null
        and action in (
          'funding_send',
          'funding_edit',
          'funding_replacement',
          'funding_qr',
          'trade_funding_edit'
        )
      )
    );

create unique index if not exists telegram_bot_action_outbox_trade_funding_unique
  on telegram_bot_action_outbox (trade_intent_id, state_revision, action)
  where action = 'trade_funding_edit';

create index if not exists idx_telegram_bot_action_outbox_trade_funding_pending
  on telegram_bot_action_outbox (next_attempt_at, created_at)
  where action = 'trade_funding_edit' and status in ('pending', 'retry');
