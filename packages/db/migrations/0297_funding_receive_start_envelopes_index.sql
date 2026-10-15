/* no-transaction */
create index concurrently if not exists funding_receive_sessions_start_envelopes_idx
  on funding_receive_sessions using gin
    (funding_receive_start_envelope_keys(observation_start_variants));
