ALTER TABLE wallet_position_exposure
  ADD COLUMN IF NOT EXISTS open_positions_count integer,
  ADD COLUMN IF NOT EXISTS open_markets_count integer,
  ADD COLUMN IF NOT EXISTS avg_open_position_size_usd numeric,
  ADD COLUMN IF NOT EXISTS avg_open_entry_price numeric,
  ADD COLUMN IF NOT EXISTS avg_open_entry_approx boolean;
