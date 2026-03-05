-- Hedge-aware wallet intel exposure metrics.

ALTER TABLE wallet_position_exposure
  ADD COLUMN IF NOT EXISTS hedged_notional_usd numeric,
  ADD COLUMN IF NOT EXISTS net_imbalance_usd numeric,
  ADD COLUMN IF NOT EXISTS hedge_ratio numeric,
  ADD COLUMN IF NOT EXISTS two_sided_markets integer;
