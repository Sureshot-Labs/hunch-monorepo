/* no-transaction */
create index concurrently if not exists funding_steps_handoff_envelope_idx
  on funding_operation_steps (
    funding_handoff_envelope_key(normalized_action->>'networkId',
      action_validation_result->>'tokenAddress',
      action_validation_result->>'funderAddress',
      action_validation_result->>'recipientAddress',
      action_validation_result->>'amountRaw'), id
  ) where normalized_action->>'kind'='external_handoff'
    and normalized_action->>'handoffKind' in
      ('polymarket_deposit_wallet_transfer','polymarket_safe_transfer');

-- All receipt states participate, including mismatch/reorg. The bounded hash
-- predicate avoids oversized index entries for optional malformed legacy data.
create index concurrently if not exists funding_receipts_handoff_hash_idx
  on funding_step_receipt_observations
    (network_id,lower(evidence->>'transactionHash'),attempt_id)
  where evidence->>'transactionHash' ~ '^0x[0-9a-fA-F]{64}$';
