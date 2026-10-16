/* no-transaction */
-- Discovery indexes on the existing receipt only. Handoff is not a second
-- economic debit/claim. Index hints are revalidated against current ownership,
-- immutable plan, actual reservations, receipt/attempt and canonical event.
-- Bounded shapes tolerate unrelated or malformed historical evidence.
-- Network is fixed by the partial predicate: do NOT put that redundant value
-- first in the key. PG can remove its equality qual, causing leaf-page walks
-- even for an empty physical/time tail when the leading key is unconstrained.
create index concurrently if not exists funding_receipts_handoff_source_tail_idx
  on funding_step_receipt_observations (
    lower(evidence#>>'{polymarketHandoffReadV1,assetId}'),
    lower(evidence#>>'{polymarketHandoffReadV1,sourceAddress}'),
    coalesce(reorged_at,finalized_at,observed_at)
  ) where network_id='evm:137'
    and evidence#>>'{polymarketHandoffReadV1,version}'='1'
    and evidence#>>'{polymarketHandoffReadV1,assetId}' ~ '^0x[0-9a-fA-F]{40}$'
    and evidence#>>'{polymarketHandoffReadV1,sourceAddress}' ~ '^0x[0-9a-fA-F]{40}$';

create index concurrently if not exists funding_receipts_handoff_controller_tail_idx
  on funding_step_receipt_observations (
    lower(evidence#>>'{polymarketHandoffReadV1,assetId}'),
    lower(evidence#>>'{polymarketHandoffReadV1,controllerAddress}'),
    coalesce(reorged_at,finalized_at,observed_at)
  ) where network_id='evm:137'
    and evidence#>>'{polymarketHandoffReadV1,version}'='1'
    and evidence#>>'{polymarketHandoffReadV1,assetId}' ~ '^0x[0-9a-fA-F]{40}$'
    and evidence#>>'{polymarketHandoffReadV1,controllerAddress}' ~ '^0x[0-9a-fA-F]{40}$';
