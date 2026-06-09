CREATE TABLE IF NOT EXISTS venue_fee_backfill_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue text NOT NULL,
  fee_program text NOT NULL,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  venue_order_id text,
  status text NOT NULL CHECK (status IN ('retry', 'skipped', 'failed')),
  reason text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  first_attempted_at timestamptz NOT NULL DEFAULT now(),
  last_attempted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue, fee_program, order_id)
);

CREATE INDEX IF NOT EXISTS idx_venue_fee_backfill_attempts_candidate
  ON venue_fee_backfill_attempts(
    venue,
    fee_program,
    status,
    next_attempt_at,
    last_attempted_at
  );

CREATE INDEX IF NOT EXISTS idx_venue_fee_backfill_attempts_order
  ON venue_fee_backfill_attempts(order_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'update_venue_fee_backfill_attempts_updated_at'
      AND tgrelid = 'venue_fee_backfill_attempts'::regclass
  ) THEN
    CREATE TRIGGER update_venue_fee_backfill_attempts_updated_at
    BEFORE UPDATE ON venue_fee_backfill_attempts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
