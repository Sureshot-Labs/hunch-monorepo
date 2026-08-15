-- Persist how a Telegram Buy is allowed to finish.  app_handoff is terminal
-- for the bot lifecycle but never grants server-side execution authority.

alter table telegram_trade_intents
  add column delivery_mode text not null default 'bot_submit';

alter table telegram_trade_intents
  add constraint telegram_trade_intents_delivery_mode_check
  check (delivery_mode in ('bot_submit', 'app_handoff'));

alter table telegram_trade_intents
  add constraint telegram_trade_intents_delivery_authority_check
  check (
    delivery_mode = 'bot_submit'
    or (
      action = 'buy'
      and venue = 'limitless'
      and status not in (
        'confirming',
        'executing',
        'submitted',
        'filled',
        'reconcile_required'
      )
      and submit_started_at is null
      and submitted_at is null
      and order_id is null
      and execution_id is null
      and venue_order_id is null
      and tx_signature is null
    )
  );

alter table telegram_trade_intents
  drop constraint if exists telegram_trade_intents_status_check;

alter table telegram_trade_intents
  add constraint telegram_trade_intents_status_check
  check (
    status in (
      'draft',
      'previewed',
      'confirming',
      'executing',
      'submitted',
      'filled',
      'failed',
      'expired',
      'cancelled',
      'reconcile_required',
      'external_handoff'
    )
  );

alter table telegram_funding_buy_return_revisions
  add column continuation_mode text not null default 'bot_submit';

alter table telegram_funding_buy_return_revisions
  add constraint telegram_funding_buy_return_continuation_mode_check
  check (continuation_mode in ('bot_submit', 'app_handoff'));

-- Relay refunds can be re-mined after a reorg on either supported EVM source
-- chain. Keep the full 0211 receive-allocation guard and widen only the exact
-- observer-owned refund asset allowlist to the Polygon ingress assets.
create or replace function funding_guard_observation_update()
returns trigger
language plpgsql
as $$
declare
  transition_allowed boolean;
  refund_recanonicalization boolean;
  receipt_reallocation boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'funding observations cannot be deleted'
      using errcode = '23514';
  end if;

  refund_recanonicalization :=
    old.kind = 'refund_credit'
    and (
      (
        old.network_id = 'evm:8453'
        and lower(old.asset_id) =
              '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
      )
      or (
        old.network_id = 'evm:137'
        and lower(old.asset_id) in (
          '0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb',
          '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
          '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'
        )
      )
    )
    and old.metadata ->> 'observerId' =
          'relay_owned_refund_observation_v1'
    and old.finality_status = 'reorged'
    and not old.canonical
    and old.reorged_at is not null
    and new.kind = old.kind
    and new.finality_status = 'finalized'
    and new.canonical
    and new.reorged_at is null
    and new.finalized_at is not null
    and new.ledger_height is not null
    and new.block_hash is not null
    and jsonb_typeof(
          new.metadata -> 'relayRefundCanonicalityHistory'
        ) = 'array'
    and new.metadata -> 'relayRefundCanonicalityHistory' @>
          jsonb_build_array(jsonb_build_object(
            'previousBlock', old.ledger_height,
            'previousBlockHash', old.block_hash,
            'reorgedAt', old.reorged_at
          ));

  receipt_reallocation :=
    old.kind = 'source_credit'
    and old.finality_status = 'finalized'
    and old.canonical
    and old.metadata ->> 'receiptId' is not null
    and new.operation_id is distinct from old.operation_id
    and new.kind = old.kind
    and new.finality_status = old.finality_status
    and new.canonical = old.canonical
    and new.finalized_at is not distinct from old.finalized_at
    and new.reorged_at is not distinct from old.reorged_at
    and jsonb_typeof(
          new.metadata -> 'receiveReceiptAllocationHistory'
        ) = 'array'
    and new.metadata -> 'receiveReceiptAllocationHistory' @>
          jsonb_build_array(jsonb_build_object(
            'previousOperationId', old.operation_id::text,
            'previousSegmentId', old.segment_id::text,
            'nextOperationId', new.operation_id::text
          ))
    and exists (
      select 1
      from funding_receive_receipts receipt_row
      join funding_operations prior_operation
        on prior_operation.id = old.operation_id
       and prior_operation.user_id = receipt_row.user_id
       and prior_operation.status in ('failed', 'cancelled')
       and prior_operation.progress_stage = 'terminal'
       and prior_operation.support_metadata ->> 'fundingReceiveReceiptId' =
             receipt_row.id::text
      join funding_operations next_operation
        on next_operation.id = new.operation_id
       and next_operation.user_id = receipt_row.user_id
       and next_operation.status not in (
             'completed', 'refunded', 'failed', 'cancelled'
           )
       and next_operation.support_metadata ->> 'fundingReceiveReceiptId' =
             receipt_row.id::text
       and next_operation.requested_source_amount ->> 'raw' = old.raw_amount
      where receipt_row.id::text = old.metadata ->> 'receiptId'
        and receipt_row.child_funding_operation_id = next_operation.id
        and receipt_row.status = 'routing'
        and receipt_row.handling = 'automatic_conversion'
        and receipt_row.raw_amount::text = old.raw_amount
        and (
          exists (
            select 1
            from telegram_funding_authorization_reservations
                 prior_reservation
            join telegram_funding_authorization_reservations
                 next_reservation
              on next_reservation.receive_receipt_id =
                    prior_reservation.receive_receipt_id
             and next_reservation.funding_operation_id = next_operation.id
             and next_reservation.status = 'reserved'
             and next_reservation.source_raw = prior_reservation.source_raw
            where prior_reservation.receive_receipt_id = receipt_row.id
              and prior_reservation.funding_operation_id = prior_operation.id
              and prior_reservation.source_raw::text = old.raw_amount
              and (
                prior_reservation.status = 'released'
                or (
                  prior_reservation.status = 'cleaned'
                  and exists (
                    select 1
                    from funding_operations cleanup_operation
                    join funding_operation_steps cleanup_step
                      on cleanup_step.operation_id = cleanup_operation.id
                     and cleanup_step.action_validation_result ->>
                           'relayStepKind' = 'cleanup'
                     and cleanup_step.action_validation_result ->>
                           'cleanupContext' in (
                             'approval_exhausted',
                             'pre_deposit_failure'
                           )
                    where cleanup_operation.id =
                          prior_reservation.cleanup_operation_id
                      and cleanup_operation.status = 'completed'
                      and cleanup_operation.progress_stage = 'terminal'
                  )
                )
              )
          )
          or (
            not exists (
              select 1
              from telegram_funding_authorization_reservations reservation_row
              where reservation_row.funding_operation_id in (
                prior_operation.id,
                next_operation.id
              )
            )
            and not exists (
              select 1
              from funding_operation_steps prior_step
              join funding_operation_step_attempts prior_attempt
                on prior_attempt.step_id = prior_step.id
              where prior_step.operation_id = prior_operation.id
                and (
                  prior_attempt.broadcast_may_have_occurred
                  or prior_attempt.outcome = 'started'
                )
            )
          )
        )
    );

  if (
    (new.operation_id, new.segment_id) is distinct from
      (old.operation_id, old.segment_id)
    and not receipt_reallocation
  ) or (
    new.kind,
    new.network_id,
    new.asset_id,
    new.asset_decimals,
    new.tx_hash,
    new.event_index,
    new.from_address,
    new.to_address,
    new.raw_amount,
    new.observed_at,
    new.created_at
  ) is distinct from (
    old.kind,
    old.network_id,
    old.asset_id,
    old.asset_decimals,
    old.tx_hash,
    old.event_index,
    old.from_address,
    old.to_address,
    old.raw_amount,
    old.observed_at,
    old.created_at
  ) or (
    not refund_recanonicalization
    and (new.ledger_height, new.block_hash) is distinct from
        (old.ledger_height, old.block_hash)
  ) then
    raise exception 'funding observation allocation and transfer identity are immutable'
      using errcode = '23514';
  end if;

  transition_allowed :=
    new.finality_status = old.finality_status
    or (old.finality_status = 'observed' and new.finality_status in ('confirmed', 'finalized', 'reorged'))
    or (old.finality_status = 'confirmed' and new.finality_status in ('finalized', 'reorged'))
    or (old.finality_status = 'finalized' and new.finality_status = 'reorged')
    or refund_recanonicalization;
  if not transition_allowed then
    raise exception 'invalid funding observation finality transition: % -> %',
      old.finality_status,
      new.finality_status
      using errcode = '23514';
  end if;
  if new.finality_status = old.finality_status and (
    new.canonical,
    new.finalized_at,
    new.reorged_at
  ) is distinct from (
    old.canonical,
    old.finalized_at,
    old.reorged_at
  ) then
    raise exception 'funding observation finality evidence cannot change without a transition'
      using errcode = '23514';
  end if;
  if old.finalized_at is not null
    and new.finalized_at is distinct from old.finalized_at
    and not refund_recanonicalization then
    raise exception 'funding observation finalized_at is immutable'
      using errcode = '23514';
  end if;
  if old.reorged_at is not null
    and new.reorged_at is distinct from old.reorged_at
    and not refund_recanonicalization then
    raise exception 'funding observation reorged_at is immutable'
      using errcode = '23514';
  end if;
  if not (new.metadata @> old.metadata) then
    raise exception 'funding observation metadata is append-only'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
