-- Align retained-source receipt identity with the receive-only asset allowlist.
-- Replace the predicate only: no historical row rewrites or data-dependent DDL.
create or replace function funding_receive_receipt_matches_frozen_variant(
  candidate funding_receive_receipts
)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from funding_receive_sessions receive_session
    cross join lateral jsonb_array_elements(
      receive_session.observation_variants
    ) frozen_variant
    where receive_session.id = candidate.receive_session_id
      and receive_session.user_id = candidate.user_id
      and frozen_variant ->> 'variantId' = candidate.variant_id
      and frozen_variant ->> 'networkId' = candidate.network_id
      and frozen_variant -> 'asset' ->> 'networkId' = candidate.network_id
      and (frozen_variant -> 'asset' ->> 'decimals')::integer =
        candidate.asset_decimals
      and funding_account_identifier_equal(
        candidate.network_id,
        frozen_variant -> 'asset' ->> 'assetId',
        candidate.asset_id
      )
      and funding_account_identifier_equal(
        candidate.network_id,
        frozen_variant ->> 'destinationAddress',
        candidate.destination_address
      )
      and (
        candidate.handling <> 'direct'
        or frozen_variant -> 'completion' ->> 'kind' =
          'direct_destination_credit'
        or (
          frozen_variant -> 'completion' ->> 'kind' =
            'retained_owned_source_credit'
          and (
            (candidate.network_id = 'solana:mainnet'
              and candidate.asset_id = '11111111111111111111111111111111'
              and candidate.asset_decimals = 9)
            or (candidate.network_id = 'solana:mainnet'
              and candidate.asset_id = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
              and candidate.asset_decimals = 6)
            or (candidate.network_id = 'evm:137'
              and funding_account_identifier_equal(
                candidate.network_id, candidate.asset_id,
                '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'
              )
              and candidate.asset_decimals = 6)
          )
        )
      )
  )
$$;
