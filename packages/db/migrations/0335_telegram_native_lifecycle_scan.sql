-- Derived card repair, not a financial queue or a publication cutoff. Keep
-- terminal funded intents in the rotation: later receipts can change facts.
create table telegram_native_lifecycle_scan (
  scan_name text primary key,
  last_intent_id uuid,
  updated_at timestamptz not null default clock_timestamp()
);
insert into telegram_native_lifecycle_scan(scan_name) values ('funded_v1');

-- The UUID is a traversal position, deliberately not an ownership/history FK.
-- Deleting that intent is safe. The next page resumes above it, then wraps.
