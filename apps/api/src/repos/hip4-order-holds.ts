import type { PoolClient } from "@hunch/infra";
import { fundingReservationHoldSql } from "../funding/persistence/source-reservation-hold.js";
import { HYPERCORE_MAINNET_USDC } from "../funding/domain/hypercore-identity.js";

// Exact submitted actions only; an unsigned preparation never locks money.
// A timeout, expired quote or cancel ACK cannot release a possibly live order.
// SQL fragments below are developer-owned expressions, never request input.
// A local barrier orders official API reads; it does not prove replica finality.
function orderBalanceBarrierMsSql(observation: string, expected: string) {
  return `(case when ${observation}@>'${expected}'::jsonb
    and jsonb_typeof(${observation}#>'{balanceBarrier,responseAt}')='number'
    and (${observation}#>>'{balanceBarrier,responseAt}') ~ '^(0|[1-9][0-9]*)$'
    then case when (${observation}#>>'{balanceBarrier,responseAt}')::numeric<=9007199254740991
      then (${observation}#>>'{balanceBarrier,responseAt}')::numeric end end)`;
}
export function hip4TerminalOrderBarrierMsSql(observation: string) {
  return orderBalanceBarrierMsSql(
    observation,
    '{"terminal":true,"balanceBarrier":{"state":"terminal_observed"}}',
  );
}
export function hip4OpenOrderBarrierMsSql(observation: string) {
  return orderBalanceBarrierMsSql(
    observation,
    '{"status":"open","terminal":false,"balanceBarrier":{"state":"accepted_observed"}}',
  );
}

// Cancellation cannot create exposure, including cancellation of an unsigned
// or rejected initial order. Its ACK/timeout is not proof about that order.
// Native terminal state ends exposure, not evidence retention or fill repair.
// Keep the initial-action lookup correlated: generic EXISTS plans otherwise
// scan unrelated submission history even for an owner with no HIP orders.
export const HIP4_ACTIVE_ORDER_EXPOSURE_SQL = `select 1
  from unnest($1::uuid[]) requested_user(user_id)
  cross join lateral (
    select id from orders where user_id=requested_user.user_id and venue='hyperliquid'
    order by coalesce(posted_at,last_update) desc,id desc offset 0
  ) order_row
  cross join lateral (
    select 1 from hip4_order_actions action_row
    join hip4_order_submissions submission_row on submission_row.action_id=action_row.id
    where action_row.order_id=order_row.id and action_row.action_kind='order'
      and submission_row.state<>'rejected'
      and (${hip4TerminalOrderBarrierMsSql("submission_row.order_observation")}<=extract(epoch from statement_timestamp())*1000) is not true
    offset 0
  ) active_native_order`;

export function hip4OrderHoldsSql(input: {
  userId: string;
  address: string;
  assetId: string;
  snapshotMs: string;
}) {
  // A later provider balance already includes both spent principal and the
  // resting order's hold. Do not subtract that principal again. Keep the frozen
  // BUY fee cap: aggregate provider hold does not prove future fee inclusion.
  // SELL fees debit quote proceeds, not the outcome-token capacity. Unknown
  // legacy/malformed snapshots keep the full local debit and recover on a
  // verified terminal observation, never by guessing from incomplete fills.
  const openBarrier = hip4OpenOrderBarrierMsSql(
    "submission_row.order_observation",
  );
  const amounts = "action_row.preparation_snapshot->'amounts'";
  const fee = `(${amounts}->>'feeCapRaw')`;
  // One indexed range, including unknown evidence (sentinel above every safe
  // timestamp) and no snapshot (lower bound zero). Keep expression aligned with
  // migration 0315. An OR/IS NOT TRUE filter scans completed account history.
  const inclusionRange = `coalesce(${hip4TerminalOrderBarrierMsSql("submission_row.order_observation")},9007199254740992)
      >= coalesce(${input.snapshotMs},0)`;
  // The correlated lookup keeps generic plans from hashing all immutable
  // action snapshots/orders when only a few submissions need an adjustment.
  return `select case when ${openBarrier} < ${input.snapshotMs}
      and action_row.action_kind='order'
      and ${amounts}->>'debitCapRaw'=submission_row.debit_raw
    then case
      when ${amounts}@>'{"side":"SELL","debitAsset":"outcome"}'::jsonb
        and submission_row.debit_asset_id=action_row.token_id and submission_row.debit_decimals=5
        and ${amounts}->>'tokenRaw'=submission_row.debit_raw then '0'
      when ${amounts}@>'{"side":"BUY","debitAsset":"quote"}'::jsonb
        and submission_row.debit_asset_id='${HYPERCORE_MAINNET_USDC.assetId}' and submission_row.debit_decimals=8
        and jsonb_typeof(${amounts}->'feeCapRaw')='string' and ${fee} ~ '^(0|[1-9][0-9]*)$'
      then case when ${fee}::numeric<=submission_row.debit_raw::numeric
        then ${fee} else submission_row.debit_raw end
      else submission_row.debit_raw end
    else submission_row.debit_raw end as raw_amount
  from hip4_order_submissions submission_row
  cross join lateral (
    select action_row.* from hip4_order_actions action_row
    join orders order_row on order_row.id=action_row.order_id and order_row.user_id=${input.userId}
    where action_row.id=submission_row.action_id and action_row.environment='mainnet'
    offset 0
  ) action_row
  where submission_row.signer_address=${input.address} and submission_row.debit_asset_id=${input.assetId}
    and submission_row.state<>'rejected'
    and ${inclusionRange}`;
}
export const HIP4_ORDER_HOLDS_SQL = hip4OrderHoldsSql({
  userId: "$1",
  address: "$2",
  assetId: "$3",
  snapshotMs: "$4::numeric",
});

/** An admitted action replaces its own common funded-consumer hold even when
 * the native debit is already included in the supplied account snapshot. */
export function hip4ReplacedConsumerHoldSql(
  reservationAlias: "balance_reservations" | "reservation",
) {
  return `exists(select 1 from funding_trade_attempts attempt_row
      join hip4_order_submissions submission_row on submission_row.funding_trade_attempt_id=attempt_row.id
      where attempt_row.reservation_id=${reservationAlias}.id and submission_row.state<>'rejected')`;
}

/** Includes settled-for-consumer cash; it is owned cash but already promised to
 * another purchase. A submitted HIP action replaces its own consumer hold in
 * this sum, never adds a second economic debit. Source debit observations are
 * accounted separately against the provider snapshot. */
export const HIP4_FUNDING_CASH_HOLDS_SQL = `select reservation.raw_amount,reservation.id,reservation.asset_decimals
  from balance_reservations reservation
  where reservation.user_id=$1 and reservation.location_id=$2
    and reservation.network_id='hyperliquid:mainnet' and reservation.asset_id=$3
    and reservation.state='active' and reservation.id is distinct from $4::uuid
    and (
      (reservation.mode='subtract_available' and ${fundingReservationHoldSql("reservation")}
        and not exists(select 1 from funding_observations debit
          where debit.operation_id=reservation.operation_id
            and debit.segment_id is not distinct from reservation.segment_id
            and debit.kind='source_debit' and debit.canonical and debit.finality_status='finalized'))
      or (reservation.mode='settled_for_consumer' and (
        reservation.expires_at>now() or exists(select 1 from funding_trade_attempts attempt_row
          where attempt_row.reservation_id=reservation.id
            and attempt_row.state in ('claimed','submission_started','ambiguous')))))
    and not ${hip4ReplacedConsumerHoldSql("reservation")}`;

export async function readHip4OrderHoldRaw(
  db: Pick<PoolClient, "query">,
  userId: string,
  address: string,
  assetId: string,
  snapshotObservedAt?: string,
): Promise<bigint> {
  const snapshotMs =
    snapshotObservedAt === undefined ? null : Date.parse(snapshotObservedAt);
  if (
    snapshotMs !== null &&
    (!Number.isSafeInteger(snapshotMs) ||
      snapshotMs < 0 ||
      snapshotMs > Date.now())
  )
    throw new Error("hip4_hold_snapshot_invalid");
  const result = await db.query<{ raw_amount: string }>(HIP4_ORDER_HOLDS_SQL, [
    userId,
    address.toLowerCase(),
    assetId,
    snapshotMs,
  ]);
  return result.rows.reduce((total, row) => total + BigInt(row.raw_amount), 0n);
}
