-- Immutable, tolerant lookup projection. This is an index hint, never an
-- ownership decision: the allocator still validates exact variants/cursors.
-- Malformed optional legacy JSON yields no keys rather than blocking rollout.
create function funding_receive_start_envelope_keys(variants_json jsonb)
returns text[] language sql immutable parallel safe as $$
  select coalesce(array_agg(distinct jsonb_build_array(
    variant_entry->>'networkId',
    case when variant_entry->>'networkId' ~ '^evm:[1-9][0-9]*$'
      and variant_entry->'asset'->>'assetId' ~ '^0x[0-9a-fA-F]{40}$'
      then lower(variant_entry->'asset'->>'assetId')
      else variant_entry->'asset'->>'assetId' end,
    variant_entry->'asset'->>'decimals',
    case when variant_entry->>'networkId' ~ '^evm:[1-9][0-9]*$'
      and variant_entry->>'destinationAddress' ~ '^0x[0-9a-fA-F]{40}$'
      then lower(variant_entry->>'destinationAddress')
      else variant_entry->>'destinationAddress' end
  )::text),array[]::text[])
  from jsonb_array_elements(case when jsonb_typeof(variants_json)='array'
    then variants_json else '[]'::jsonb end) variant_entry
  where jsonb_typeof(variant_entry->'networkId')='string'
    and jsonb_typeof(variant_entry->'asset'->'assetId')='string'
    and variant_entry->'asset'->>'decimals' ~ '^[0-9]+$'
    and jsonb_typeof(variant_entry->'destinationAddress')='string'
$$;
