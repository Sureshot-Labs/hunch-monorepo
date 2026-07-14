ALTER TABLE wallet_position_exposure
  ADD COLUMN IF NOT EXISTS open_positions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS open_positions_version smallint NOT NULL DEFAULT 0;

ALTER TABLE wallet_position_exposure
  DROP CONSTRAINT IF EXISTS wallet_position_exposure_open_positions_array;

ALTER TABLE wallet_position_exposure
  ADD CONSTRAINT wallet_position_exposure_open_positions_array
  CHECK (jsonb_typeof(open_positions) = 'array');

ALTER TABLE wallet_position_exposure
  DROP CONSTRAINT IF EXISTS wallet_position_exposure_open_positions_version;

ALTER TABLE wallet_position_exposure
  ADD CONSTRAINT wallet_position_exposure_open_positions_version
  CHECK (open_positions_version >= 0);
