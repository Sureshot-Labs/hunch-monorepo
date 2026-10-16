import type { PoolClient } from "@hunch/infra";

/** Bound source enumeration BEFORE any funding facts/receipt joins. The page
 * includes terminal and unchanged sources, never trusts a cached card to prove
 * financial finality, and wraps at most once within the ordinary worker tick. */
export const TELEGRAM_NATIVE_FUNDED_LIFECYCLE_PAGE_SQL = `select id
  from telegram_trade_intents
  where venue='hyperliquid' and delivery_mode='app_handoff'
    and funding_operation_id is not null
    and id > coalesce($1::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
  order by id limit $2::integer`;

// Cached progress changes priority ONLY, never eligibility/financial truth.
// Old terminal cards remain in the independent historical source rotation.
export const TELEGRAM_NATIVE_FUNDED_LIFECYCLE_HOT_PREDICATE = `venue='hyperliquid'
  and delivery_mode='app_handoff' and funding_operation_id is not null
  and (result->'shortfallProgress' is null
    or (status not in ('filled','failed','cancelled','expired')
      and coalesce(result#>>'{shortfallProgress,state}','') not in ('filled','failed','cancelled','stopped','quote_expired'))
    or floor(extract(epoch from updated_at at time zone 'UTC')*1000000)::bigint >
      case when result#>>'{shortfallProgressSourceWatermark,intentUpdatedAtUs}' ~ '^[0-9]{1,18}$'
        then (result#>>'{shortfallProgressSourceWatermark,intentUpdatedAtUs}')::bigint else -1 end)`;

export const TELEGRAM_NATIVE_FUNDED_LIFECYCLE_HOT_SQL = `select id
  from telegram_trade_intents where ${TELEGRAM_NATIVE_FUNDED_LIFECYCLE_HOT_PREDICATE}
  order by (result->'shortfallProgress' is not null),updated_at desc,id
  limit $1::integer`;

/** Reuse the existing reconciliation batch's exact processed operation IDs.
 * One indexed hint per operation; shared selector revalidates all facts and
 * ownership. Aliases/history are still covered by the independent rotation. */
export const TELEGRAM_NATIVE_FUNDED_LIFECYCLE_OPERATIONS_SQL = `select intent_hint.id
  from unnest($1::uuid[]) source_operation(operation_id)
  cross join lateral (
    select next_hint.id from (
      select id,funding_operation_id from telegram_trade_intents
      where venue='hyperliquid' and delivery_mode='app_handoff'
        and funding_operation_id is not null
        and funding_operation_id>=source_operation.operation_id
      order by funding_operation_id,id limit 1
    ) next_hint
    where next_hint.funding_operation_id=source_operation.operation_id
  ) intent_hint`;

export type TelegramNativeLifecyclePage = Readonly<{
  ids: readonly string[];
  preferHistory: boolean;
  afterId: string | null;
}>;

export async function listTelegramNativeFundedLifecyclePage(
  client: PoolClient,
  limit: number,
): Promise<TelegramNativeLifecyclePage | null> {
  const cursor = await client.query<{
    last_intent_id: string | null;
    prefer_history: boolean;
  }>(
    `select last_intent_id,prefer_history from telegram_native_lifecycle_scan
      where scan_name='funded_v1' for update skip locked`,
  );
  // Another projector owns the rotation; other venue/direct work stays live.
  if (!cursor.rows.length) return null;
  let page = await client.query<{ id: string }>(
    TELEGRAM_NATIVE_FUNDED_LIFECYCLE_PAGE_SQL,
    [cursor.rows[0].last_intent_id, limit],
  );
  if (!page.rows.length && cursor.rows[0].last_intent_id !== null)
    page = await client.query<{ id: string }>(
      TELEGRAM_NATIVE_FUNDED_LIFECYCLE_PAGE_SQL,
      [null, limit],
    );
  return {
    ids: page.rows.map((row) => row.id),
    preferHistory: cursor.rows[0].prefer_history,
    afterId: cursor.rows[0].last_intent_id,
  };
}

export async function advanceTelegramNativeFundedLifecyclePage(
  client: PoolClient,
  page: TelegramNativeLifecyclePage | null,
  nextId: string | null,
) {
  if (!page) return;
  await client.query(
    `update telegram_native_lifecycle_scan
      set last_intent_id=$1::uuid,prefer_history=not prefer_history,updated_at=clock_timestamp()
      where scan_name='funded_v1'`,
    [nextId],
  );
  // Cursor + projections commit together. A skipped owner/intent leaves its
  // source position intact; current financial facts are re-read on retry.
}
