ALTER TABLE telegram_trade_intents
  DROP CONSTRAINT IF EXISTS telegram_trade_intents_action_check,
  DROP CONSTRAINT IF EXISTS telegram_trade_intents_buy_amount_check,
  DROP CONSTRAINT IF EXISTS telegram_trade_intents_action_payload_check;

ALTER TABLE telegram_trade_intents
  ADD CONSTRAINT telegram_trade_intents_action_check
    CHECK (action IN ('buy', 'sell', 'redeem')),
  ADD CONSTRAINT telegram_trade_intents_action_payload_check
    CHECK (
      (
        action = 'buy'
        AND amount_usd IS NOT NULL
        AND amount_usd > 0
        AND sell_percent IS NULL
        AND shares_raw IS NULL
      )
      OR (
        action = 'sell'
        AND amount_usd IS NULL
        AND sell_percent IN (50, 100)
        AND shares_raw IS NOT NULL
        AND shares_raw ~ '^[0-9]+$'
        AND shares_raw::numeric > 0
      )
      OR (
        action = 'redeem'
        AND amount_usd IS NULL
        AND sell_percent IS NULL
        AND shares_raw IS NULL
        AND side IS NULL
      )
    );
