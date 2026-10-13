-- Additive observed account facts. No trade, signing, external calls or backfill.
CREATE TABLE IF NOT EXISTS hip4_account_snapshots (
  environment text NOT NULL CHECK (environment IN ('mainnet', 'testnet')),
  account_address text NOT NULL CHECK (account_address ~ '^0x[0-9a-f]{40}$'),
  observation jsonb,
  observed_at timestamptz,
  attempt_at timestamptz,
  attempt_error text,
  lease_token uuid,
  lease_until timestamptz,
  history jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY(environment, account_address)
);
CREATE TABLE IF NOT EXISTS hip4_account_executions (
  environment text NOT NULL CHECK (environment IN ('mainnet', 'testnet')),
  account_address text NOT NULL,
  time_ms bigint NOT NULL,
  coin text NOT NULL,
  tid bigint NOT NULL,
  oid bigint NOT NULL,
  canonical_market_id text NOT NULL,
  market_id text REFERENCES unified_markets(id) ON DELETE RESTRICT,
  execution jsonb NOT NULL,
  fingerprint text NOT NULL,
  PRIMARY KEY(environment, account_address, time_ms, coin, tid, oid),
  FOREIGN KEY(environment, account_address) REFERENCES hip4_account_snapshots(environment, account_address) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS hip4_account_executions_page_idx
  ON hip4_account_executions(environment, account_address, time_ms DESC, coin DESC, tid DESC, oid DESC);
CREATE INDEX IF NOT EXISTS hip4_account_executions_market_page_idx
  ON hip4_account_executions(environment, account_address, canonical_market_id, time_ms DESC, coin DESC, tid DESC, oid DESC);
CREATE INDEX IF NOT EXISTS hip4_account_executions_protected_market_idx
  ON hip4_account_executions(canonical_market_id);
-- Complete spot snapshots replace these current facts; executions never seed a
-- missing balance or resurrect an extinguished position.
CREATE TABLE IF NOT EXISTS hip4_account_positions (
  environment text NOT NULL,
  account_address text NOT NULL,
  coin text NOT NULL,
  canonical_market_id text NOT NULL,
  market_id text REFERENCES unified_markets(id) ON DELETE RESTRICT,
  "position" jsonb NOT NULL,
  PRIMARY KEY(environment, account_address, coin),
  FOREIGN KEY(environment, account_address) REFERENCES hip4_account_snapshots(environment, account_address) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS hip4_account_positions_protected_market_idx
  ON hip4_account_positions(canonical_market_id);
CREATE TABLE IF NOT EXISTS hip4_account_ledger (
  environment text NOT NULL,
  account_address text NOT NULL,
  event_key text NOT NULL,
  time_ms bigint NOT NULL,
  ledger_entry jsonb NOT NULL,
  PRIMARY KEY(environment, account_address, event_key),
  FOREIGN KEY(environment, account_address) REFERENCES hip4_account_snapshots(environment, account_address) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS hip4_account_ledger_page_idx
  ON hip4_account_ledger(environment, account_address, time_ms DESC, event_key);
