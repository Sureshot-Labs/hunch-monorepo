-- Hyperliquid is a known Hunch venue but remains unreleased. Allow its rows to
-- coexist in shared storage while portfolio reads continue to expose only the
-- explicitly supported venue set.
ALTER TABLE positions
  ADD CONSTRAINT positions_venue_storage_v2_check
  CHECK (venue IN ('polymarket', 'kalshi', 'limitless', 'hyperliquid'))
  NOT VALID;

ALTER TABLE positions
  VALIDATE CONSTRAINT positions_venue_storage_v2_check;

ALTER TABLE positions
  DROP CONSTRAINT positions_venue_check;

ALTER TABLE positions
  RENAME CONSTRAINT positions_venue_storage_v2_check
  TO positions_venue_check;
