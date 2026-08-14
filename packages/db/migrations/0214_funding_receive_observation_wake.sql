-- Keep the immutable opened_at allocation boundary separate from interactive
-- user activity. A target selection or explicit Refresh can request an
-- immediate observation and keep an older receive session temporarily hot.

alter table funding_receive_sessions
  add column observation_requested_at timestamptz;

