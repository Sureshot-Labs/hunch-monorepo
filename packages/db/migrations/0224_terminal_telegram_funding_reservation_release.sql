-- A zero-allowance cleanup child is hygiene, not money in flight. If that
-- child is terminal without a successful cleanup receipt, a later exact Relay
-- approval safely overwrites the allowance and must not be blocked forever.
create or replace function guard_telegram_funding_authorization_reservation_update()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if current_setting(
      'hunch.telegram_funding_retention_cleanup',
      true
    ) is distinct from 'on' then
      return null;
    end if;
    return old;
  end if;
  if (
    new.id,
    new.authorization_id,
    new.receive_receipt_id,
    new.source_trade_intent_id,
    new.funding_operation_id,
    new.source_raw,
    new.reserved_at,
    new.created_at
  ) is distinct from (
    old.id,
    old.authorization_id,
    old.receive_receipt_id,
    old.source_trade_intent_id,
    old.funding_operation_id,
    old.source_raw,
    old.reserved_at,
    old.created_at
  ) then
    return null;
  end if;
  if not new.resolution_evidence @> old.resolution_evidence then
    return null;
  end if;
  if old.refund_cursor_block is not null and (
    new.refund_cursor_block is null
    or new.refund_cursor_block < old.refund_cursor_block
  ) then
    return null;
  end if;
  if old.cleanup_operation_id is not null and (
    new.cleanup_operation_id,
    new.cleanup_allowance_revision
  ) is distinct from (
    old.cleanup_operation_id,
    old.cleanup_allowance_revision
  ) then
    return null;
  end if;
  if old.cleanup_operation_id is null
     and new.cleanup_operation_id is not null
     and not (
       old.status = 'reserved'
       and new.status = 'cleanup_required'
       and new.cleanup_allowance_revision is not null
     ) then
    return null;
  end if;
  if old.status = new.status then
    if new.resolved_at is distinct from old.resolved_at then
      return null;
    end if;
  elsif not (
    (old.status = 'reserved' and new.status in (
      'cleanup_required', 'settled', 'refunded', 'released'
    ))
    or (old.status = 'cleanup_required' and new.status in ('cleaned', 'released'))
    or (old.status = 'cleaned' and new.status = 'refunded')
  ) then
    return null;
  end if;
  if old.status in ('settled', 'refunded', 'released', 'cleaned')
     and not (old.status = 'cleaned' and new.status = 'refunded')
     and (
       new.status,
       new.resolved_at
     ) is distinct from (
       old.status,
       old.resolved_at
     ) then
    return null;
  end if;
  return new;
end;
$$;
