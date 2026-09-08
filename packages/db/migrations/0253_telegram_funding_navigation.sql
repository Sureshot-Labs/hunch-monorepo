-- Navigation only, deliberately separate from Buy consent/continuation.
-- Nullable additions: no historical backfill or data-dependent rollout guard.
alter table telegram_funding_sessions
  add column navigation_market_id text references unified_markets(id) on delete set null,
  add column navigation_side text;
