/* no-transaction */
-- Compact hints only. Each reader also checks exact normalized hash equality.
-- No sender/asset/owner/finality filters: absence must cover legacy claims too.
-- md5 keeps optional malformed/oversized historical JSON/text out of index keys.
create index concurrently if not exists funding_observations_physical_hash_hint_idx
  on funding_observations (network_id,md5(lower(tx_hash))) where tx_hash is not null;

create index concurrently if not exists funding_receive_receipts_physical_hash_hint_idx
  on funding_receive_receipts (network_id,md5(lower(tx_hash))) where tx_hash is not null;

create index concurrently if not exists funding_step_receipts_physical_hash_hint_idx
  on funding_step_receipt_observations (network_id,md5(lower(evidence->>'transactionHash')))
  where evidence->>'transactionHash' is not null;

create index concurrently if not exists funding_step_receipts_retained_hash_hint_idx
  on funding_step_receipt_observations
    (network_id,md5(lower(evidence#>>'{handoffOwnedPhysicalEventV1,transactionHash}')))
  where evidence#>>'{handoffOwnedPhysicalEventV1,transactionHash}' is not null;
