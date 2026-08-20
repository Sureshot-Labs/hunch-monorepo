-- A v2 sealed Telegram → Mini App handoff owns its quote through the handoff
-- and trade-intent UUIDs. It uses the existing immutable `commit_scope` JSONB
-- column; no historical row is rewritten and existing receive-review scopes
-- remain valid.

alter table funding_quotes
  drop constraint if exists funding_quotes_commit_scope_check;

alter table funding_quotes
  add constraint funding_quotes_commit_scope_check
  check (
    commit_scope is null
    or (
      jsonb_typeof(commit_scope) = 'object'
      and (
        (
          commit_scope
          - 'kind'
          - 'ownerChannel'
          - 'receiveSessionId'
          - 'receiptId'
        ) = '{}'::jsonb
        and commit_scope ->> 'kind' = 'receive_receipt_review_v1'
        and commit_scope ->> 'ownerChannel' in ('web', 'telegram')
        and commit_scope ->> 'receiveSessionId'
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and commit_scope ->> 'receiptId'
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
      or (
        (
          commit_scope
          - 'kind'
          - 'handoffId'
          - 'tradeIntentId'
        ) = '{}'::jsonb
        and commit_scope ->> 'kind' = 'telegram_app_handoff_v2'
        and commit_scope ->> 'handoffId'
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and commit_scope ->> 'tradeIntentId'
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
    )
  );

-- The same v2 handoff may attach its client-executed funding operation to the
-- existing trade intent. Keeping both compatible constraint changes in this
-- migration makes the handoff contract atomic at rollout: there is no schema
-- state in which a v2 quote can be committed but its intent cannot represent
-- the resulting funding state.
alter table telegram_trade_intents
  drop constraint if exists telegram_trade_intents_delivery_authority_check;

alter table telegram_trade_intents
  add constraint telegram_trade_intents_delivery_authority_check
  check (
    delivery_mode = 'bot_submit'
    or (
      action = 'buy'
      and (
        (
          jsonb_typeof(result -> 'appHandoffExecution') = 'object'
          and result -> 'appHandoffExecution' ->> 'version' = '1'
          and nullif(
            result -> 'appHandoffExecution' ->> 'committedAt',
            ''
          ) is not null
          and status in (
            'confirming',
            'executing',
            'submitted',
            'filled',
            'reconcile_required',
            'failed',
            'cancelled',
            'expired'
          )
        )
        or (
          jsonb_typeof(result -> 'appHandoffExecution') = 'object'
          and result -> 'appHandoffExecution' ->> 'version' = '2'
          and nullif(
            result -> 'appHandoffExecution' ->> 'committedAt',
            ''
          ) is not null
          and status in (
            'confirming',
            -- A sealed direct v2 Buy has no FundingOperation. It remains in
            -- this durable handoff state until the ordinary web order claims
            -- and atomically links the exact sealed submission.
            'external_handoff',
            'funding',
            'executing',
            'submitted',
            'filled',
            'reconcile_required',
            'failed',
            'cancelled',
            'expired'
          )
          and (
            status <> 'funding'
            or funding_operation_id is not null
          )
        )
        or (
          status not in (
            'executing',
            'submitted',
            'filled',
            'reconcile_required'
          )
          and (
            status <> 'confirming'
            or (
              result ->> 'fundingState' = 'internal_route'
              and jsonb_typeof(result -> 'fundingProposal') = 'object'
            )
          )
          and (
            status <> 'funding'
            or funding_operation_id is not null
          )
          and submit_started_at is null
          and submitted_at is null
          and order_id is null
          and execution_id is null
          and venue_order_id is null
          and tx_signature is null
        )
      )
    )
  );
