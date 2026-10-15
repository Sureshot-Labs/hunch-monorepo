-- A compact, immutable index hint. Residual identity checks remain mandatory;
-- malformed legacy JSON and very long strings must not fail index creation.
create function funding_handoff_envelope_key(
  network_identity text, token_identity text, source_identity text,
  destination_identity text, transfer_raw text
) returns text language sql immutable parallel safe as $$
  select md5(jsonb_build_array(network_identity,lower(token_identity),
    lower(source_identity),lower(destination_identity),transfer_raw)::text)
$$;
