/* no-transaction */
-- Positive transaction witnesses only. Residual user/network/asset/recipient
-- checks remain mandatory. These indexes do not confer negative authority on a
-- missing or old-HMAC-only manifest. No legacy rows are rewritten or asserted.
create index concurrently if not exists funding_segments_destination_hash_idx
  on funding_operation_segments using gin
    ((coalesce(support_metadata->'relaySuccessfulDestinationReferenceHashesV1','[]'::jsonb)) jsonb_path_ops)
  where provider_id = 'relay';

create index concurrently if not exists funding_segments_legacy_reference_idx
  on funding_operation_segments using gin
    ((case when jsonb_typeof(support_metadata->'relayTransactionReferenceFingerprints') = 'array'
        then support_metadata->'relayTransactionReferenceFingerprints'
        else '[]'::jsonb end) jsonb_path_ops)
  where provider_id = 'relay';

-- The unresolved branch must not inspect completed history just to establish
-- that a recipient has no currently-moving, uncorrelated route.
create index concurrently if not exists funding_operations_pending_destination_idx
  on funding_operations (user_id, id)
  where plan_kind in ('wallet_route', 'composite_route')
    and status not in ('ready', 'completed', 'refunded', 'failed', 'cancelled');
