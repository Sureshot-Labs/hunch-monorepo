-- Native oid is an integer, including valid short values. Keep the existing
-- opaque-reference rule for every other execution path. No legacy validation
-- or data-dependent migration failure; exact account/order binding is retained
-- by the admitted native action and common consumer foreign keys.
alter table funding_trade_attempts drop constraint funding_trade_attempts_external_reference_check;
alter table funding_trade_attempts add constraint funding_trade_attempts_external_reference_check
  check (external_reference is null
    or length(trim(external_reference)) between 8 and 512
    or (execution_path='hyperliquid_outcome'
      and external_reference ~ '^(0|[1-9][0-9]{0,15})$')) not valid;
