-- Legacy/non-Polymarket rows retain the empty namespace; no historical JSON
-- inference or rewrite is needed. New PositionManager holdings use its exact
-- lowercase contract address. Preserve the existing constraint name so old
-- CTF/non-Polymarket insert paths remain compatible with their default value.
-- Keep NULL-wallet identity semantics from migration 0026 as well.
alter table positions add column position_contract text not null default '';
alter table positions add column asset_context jsonb;
alter table positions drop constraint positions_user_id_wallet_address_venue_token_id_key;
alter table positions add constraint positions_user_id_wallet_address_venue_token_id_key
  unique nulls not distinct (user_id, wallet_address, venue, token_id, position_contract);
