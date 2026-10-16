import { z } from "zod";
import type { PoolClient } from "@hunch/infra";
import {
  HIP4_NATIVE_ORDER_READ_FACTS,
  HIP4_NATIVE_ORDER_READ_JOINS,
} from "./hip4-native-order-read.js";
import { nativeHip4OrderReadSchema } from "../schemas/orders.js";

/** Same official order projection as /orders, reached by the existing exact
 * intent -> order link. No provider calls, locks, financial effects or current
 * trading/Telegram grant are required to see an already submitted action.
 */
function linkedNativeOrderPredicateSql(intentAlias: "tti" | "intent") {
  return `o.id=${intentAlias}.order_id and o.user_id=${intentAlias}.user_id
      and o.venue='hyperliquid' and ${intentAlias}.venue='hyperliquid'
      and ${intentAlias}.delivery_mode='app_handoff'
      and native_action.environment='mainnet'
      and native_action.canonical_market_id=${intentAlias}.market_id
      and native_action.token_id=o.token_id
      and native_action.token_id=${intentAlias}.result#>>'{appHandoffV2,plan,trade,outcomeTokenId}'
      and o.side=upper(${intentAlias}.action)
      and native_submission.admission_snapshot#>>'{telegramAppHandoff,handoffId}'
        =${intentAlias}.result#>>'{appHandoffExecution,handoffId}'`;
}

const NATIVE_TERMINAL_ORDER_SQL = `(native_submission.state='rejected'
  or (native_terminal.terminal_confirmed
    and native_state.display_status in ('filled','cancelled')))`;

/** A terminal native IOC no longer blocks a NEW explicit Review. The old
 * handoff is still one-shot and cannot submit again. Do not use a cancel ACK,
 * local expiry, requested quantity or generic order status to release it.
 * Alias is a closed developer-owned set, never user input.
 */
export function telegramNativeHandoffHasTerminalOrderSql(
  intentAlias: "tti" | "intent",
) {
  return `exists(select 1 from orders o ${HIP4_NATIVE_ORDER_READ_JOINS}
    where ${linkedNativeOrderPredicateSql(intentAlias)}
      and ${NATIVE_TERMINAL_ORDER_SQL}
    -- Keep this exact-order probe correlated. Pulling it into a hashed
    -- subplan scans unrelated native submission history on sparse/empty tails.
    offset 0)`;
}

export function telegramNativeHandoffUnresolvedPredicateSql(
  intentAlias: "tti" | "intent",
) {
  // Keep the cheap status restriction visible to the planner and also guard
  // the expensive correlated proof with CASE. A generic plan must not inspect
  // order JSON for every already-terminal native intent before its outer OR
  // status/funding filter happens to reject it.
  const states =
    "('draft','previewed','confirming','funding','external_handoff','executing','submitted','reconcile_required')";
  return `((${intentAlias}.venue<>'hyperliquid' or ${intentAlias}.status in ${states})
    and case when ${intentAlias}.venue<>'hyperliquid' then true
      when ${intentAlias}.status in ${states}
        then not ${telegramNativeHandoffHasTerminalOrderSql(intentAlias)}
      else false end)`;
}

export const TELEGRAM_NATIVE_HANDOFF_ORDER_READ_SQL = `select
  o.id::text as "orderId",o.venue_order_id as "venueOrderId",
  native_state.display_status as status,
  ${NATIVE_TERMINAL_ORDER_SQL} as terminal,
  greatest(intent.updated_at,o.last_update,native_submission.updated_at) as "updatedAt",
  ${HIP4_NATIVE_ORDER_READ_FACTS} as "nativeOrder"
  from telegram_trade_intents intent
  join orders o on o.id=intent.order_id and o.user_id=intent.user_id
  ${HIP4_NATIVE_ORDER_READ_JOINS}
  where intent.id=$1::uuid and intent.user_id=$2::uuid
    and ($3::text is null or intent.telegram_user_id=$3)
    and ($4::text is null or native_submission.admission_snapshot#>>'{telegramAppHandoff,handoffId}'=$4)
    and ${linkedNativeOrderPredicateSql("intent")}`;

/** Derived intent lifecycle only. Caller already owns the native writer's
 * exclusive funding-policy lock and user/order locks. No H lock, new outer
 * financial authority, execution, reservation or monetary mutation is added.
 * The exact admitted action -> order PK -> indexed intent path avoids a history
 * scan. Token-only H->I operations never acquire native order locks afterward.
 * The immutable admitted order binding survives token retention/owner merge;
 * a live handoff row is not required to repair factual execution presentation.
 * Official reads still own presentation/finances; this makes existing pending
 * intent indexes useful instead of probing every historical terminal order.
 */
export const TELEGRAM_NATIVE_HANDOFF_STATUS_PROJECTION_SQL = `with projection_source as materialized (
  select tti.id,tti.user_id,o.id as order_id,
    case when native_submission.state='rejected' then 'failed'
      when native_terminal.terminal_confirmed and native_state.display_status='filled' then 'filled'
      when native_terminal.terminal_confirmed and native_state.display_status='cancelled' then 'cancelled'
      else 'submitted' end as projected_status
    from orders o ${HIP4_NATIVE_ORDER_READ_JOINS}
    join telegram_trade_intents tti on tti.order_id=o.id
      and tti.user_id=o.user_id and tti.order_id is not null
      and tti.venue='hyperliquid' and tti.delivery_mode='app_handoff'
    where native_action.id=$1::uuid and o.user_id=$2::uuid
      and ${linkedNativeOrderPredicateSql("tti")}
) update telegram_trade_intents intent
  set status=projection_source.projected_status,updated_at=clock_timestamp()
  from projection_source
  where intent.id=projection_source.id and intent.user_id=projection_source.user_id
    and intent.order_id=projection_source.order_id
    and intent.venue='hyperliquid' and intent.delivery_mode='app_handoff'
    and intent.status in ('executing','submitted','reconcile_required','filled','cancelled','failed')
    -- A new factual fill/fee observation can leave the terminal status intact.
    -- Wake the existing lifecycle source watermark as well; this is not a new
    -- financial effect or a claim that the history is complete.
`;

export async function projectTelegramNativeHandoffStatusInTransaction(
  db: PoolClient,
  input: { actionId: string; userId: string },
) {
  const result = await db.query(TELEGRAM_NATIVE_HANDOFF_STATUS_PROJECTION_SQL, [
    input.actionId,
    input.userId,
  ]);
  return result.rowCount ?? 0;
}

const readSchema = z.object({
  orderId: z.string().uuid(),
  venueOrderId: z.string().nullable(),
  status: z.string(),
  terminal: z.boolean(),
  updatedAt: z.date(),
  nativeOrder: nativeHip4OrderReadSchema,
});

export async function readTelegramNativeHandoffOrder(
  db: {
    query: (
      sql: string,
      values: (string | null)[],
    ) => Promise<{ rows: unknown[] }>;
  },
  input: {
    tradeIntentId: string;
    userId: string;
    telegramUserId?: string;
    handoffId?: string;
  },
) {
  const { rows } = await db.query(TELEGRAM_NATIVE_HANDOFF_ORDER_READ_SQL, [
    input.tradeIntentId,
    input.userId,
    input.telegramUserId ?? null,
    input.handoffId ?? null,
  ]);
  return rows[0] ? readSchema.parse(rows[0]) : null;
}
