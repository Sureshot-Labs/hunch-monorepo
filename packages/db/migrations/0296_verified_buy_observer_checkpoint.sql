-- Only the fenced observer increments verified_buy_revision while releasing
-- its current, unexpired lease. Its checkpoint/order projection must not wake
-- itself or erase the next observation time. Ordinary producers and explicit
-- refresh do not increment this revision and retain the existing wake path.
-- Compatible with older writers; no legacy-data scan, rewrite or assertion.
CREATE OR REPLACE FUNCTION social_schedule_purchase_observation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.verified_buy_revision = OLD.verified_buy_revision + 1
     AND OLD.verified_buy_lease_token IS NOT NULL
     AND OLD.verified_buy_lease_until > statement_timestamp()
     AND NEW.verified_buy_lease_token IS NULL
     AND NEW.verified_buy_lease_until IS NULL THEN
    RETURN NEW;
  END IF;
  IF upper(coalesce(NEW.side,'')) = 'BUY' THEN
    NEW.verified_buy_due_at := now();
    NEW.verified_buy_lease_token := NULL;
    NEW.verified_buy_lease_until := NULL;
  END IF;
  RETURN NEW;
END;
$$;
