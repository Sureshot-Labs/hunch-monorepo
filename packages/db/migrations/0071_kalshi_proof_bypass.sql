-- Per-user bypass for Kalshi Proof KYC gate.

ALTER TABLE users
ADD COLUMN IF NOT EXISTS kalshi_proof_bypass boolean NOT NULL DEFAULT false;
