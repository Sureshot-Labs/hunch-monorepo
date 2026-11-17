-- A direct SPL withdrawal reserves token principal and native SOL execution
-- costs separately. Both continue to subtract available balance; only the
-- principal is an economic input to the route. Keep the segment validator's
-- existing exactly-one-source-input invariant.
--
-- The new check is a strict superset of the previous validated check. Do not
-- rescan or transform historical reservations during the availability-sensitive
-- deployment. NOT VALID still enforces the check on all new/changed rows.
alter table balance_reservations
  drop constraint balance_reservations_economic_role_check,
  add constraint balance_reservations_economic_role_check
    check (
      economic_role = 'source_input'
      or (
        economic_role = 'future_credit_fence'
        and mode = 'subtract_available'
        and segment_id is null
      )
      or (
        economic_role = 'execution_cost'
        and mode = 'subtract_available'
        and segment_id is not null
        and network_id = 'solana:mainnet'
        and asset_id = '11111111111111111111111111111111'
        and asset_decimals = 9
      )
    ) not valid;
