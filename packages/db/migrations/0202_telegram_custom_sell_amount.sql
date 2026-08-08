alter table telegram_trade_intents
  drop constraint if exists telegram_trade_intents_action_payload_check;

alter table telegram_trade_intents
  add constraint telegram_trade_intents_action_payload_check
  check (
    (
      action = 'buy'
      and amount_usd is not null
      and amount_usd > 0
      and sell_percent is null
      and shares_raw is null
    )
    or (
      action = 'sell'
      and amount_usd is null
      and (sell_percent is null or (sell_percent > 0 and sell_percent <= 100))
      and shares_raw is not null
      and shares_raw ~ '^[0-9]+$'
      and shares_raw::numeric > 0
    )
    or (
      action = 'redeem'
      and amount_usd is null
      and sell_percent is null
      and shares_raw is null
      and side is null
    )
  );
