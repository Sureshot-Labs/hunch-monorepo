-- Add native HyperCore identifiers to the existing funding identity contract.
-- No row rewrite, new financial authority, or data-dependent rollout failure.
create or replace function funding_account_identifier_equal(
  identity_scope text,
  left_identifier text,
  right_identifier text
)
returns boolean
language sql
immutable
parallel safe
as $$
  select case
    when (
      identity_scope = 'ethereum'
      or identity_scope ~ '^evm:[1-9][0-9]*$'
    )
      and left_identifier ~ '^0x[0-9a-fA-F]{40}$'
      and right_identifier ~ '^0x[0-9a-fA-F]{40}$'
      then lower(left_identifier) = lower(right_identifier)
    when identity_scope in ('hyperliquid:mainnet', 'hyperliquid:testnet')
      and (
        (left_identifier ~ '^0x[0-9a-fA-F]{40}$'
          and right_identifier ~ '^0x[0-9a-fA-F]{40}$')
        or (left_identifier ~ '^0x[0-9a-fA-F]{32}$'
          and right_identifier ~ '^0x[0-9a-fA-F]{32}$')
      )
      then lower(left_identifier) = lower(right_identifier)
    else left_identifier = right_identifier
  end
$$;
