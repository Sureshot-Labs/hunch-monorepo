/* no-transaction */
-- Exact reverse correlation, not a historical status scan. No legacy row is
-- modified or rejected, and malformed optional JSON cannot overflow a btree.
create index concurrently if not exists funding_segments_refund_order_idx
  on funding_operation_segments (
    lower(refund_location_snapshot->>'relayProtocolOrderId'), id
  ) where provider_id='relay'
    and refund_location_snapshot->>'relayProtocolOrderId' ~ '^0x[0-9a-fA-F]{64}$';
