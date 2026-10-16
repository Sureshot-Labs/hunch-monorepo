-- Native intent storage is for the user-signed app handoff only. It does not
-- grant a server bot authorization or widen its enabled_venues constraints.
-- Keep legacy rows untouched: NOT VALID enforces the structural rule on new
-- writes without turning optional/historical data into a deploy-time scan.
alter table telegram_trade_intents
  drop constraint if exists telegram_trade_intents_venue_check;

alter table telegram_trade_intents
  add constraint telegram_trade_intents_venue_check
  check (
    venue in ('polymarket', 'limitless', 'kalshi')
    or (venue = 'hyperliquid' and delivery_mode = 'app_handoff')
  ) not valid;
