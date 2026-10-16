/** Must match migration 0332. This is a derived-work index, not a financial
 * guard: changed/unknown source watermarks and all linked funding stay due.
 * Terminal funding may regress on later official evidence; never prune it
 * solely from a cached operation status owned by this derived card.
 * UTC epoch arithmetic is immutable for PostgreSQL's expression predicate.
 * The safe CASE tolerates old malformed JSON without migration-time failure. */
export const TELEGRAM_NATIVE_LIFECYCLE_DUE_SQL = `intent.venue='hyperliquid'
  and intent.delivery_mode='app_handoff'
  and (
    intent.result->'shortfallProgress' is null
    or intent.status not in ('filled','failed','cancelled','expired')
    or floor(extract(epoch from intent.updated_at at time zone 'UTC')*1000000)::bigint >
      case when intent.result#>>'{shortfallProgressSourceWatermark,intentUpdatedAtUs}' ~ '^[0-9]{1,18}$'
        then (intent.result#>>'{shortfallProgressSourceWatermark,intentUpdatedAtUs}')::bigint
        else -1 end
    or intent.funding_operation_id is not null
  )`;
