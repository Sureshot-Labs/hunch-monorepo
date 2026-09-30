import type { Pool } from "@hunch/infra";
import type { BridgeOrderStatus } from "../services/bridge-status.js";

/** A late provider response cannot overwrite a terminal canonical result. */
export async function syncPendingDebridgeOrderStatus(
  db: Pick<Pool, "query">,
  input: {
    userId: string;
    operationId: string;
    status: BridgeOrderStatus;
    payload?: Record<string, unknown> | null;
  },
): Promise<boolean> {
  const result = await db.query(
    `update bridge_orders
      set status = $1,
          metadata = case when $2::jsonb is null then metadata else
            jsonb_set(coalesce(metadata, '{}'::jsonb), '{debridge}',
              coalesce(metadata->'debridge', '{}'::jsonb)
                || jsonb_build_object('statusPayload', $2::jsonb, 'lastStatusSyncedAt', now()), true)
          end,
          updated_at = now()
      where id = $3 and user_id = $4 and provider = 'debridge'
        and status in ('created', 'submitted')`,
    [
      input.status,
      input.payload ? JSON.stringify(input.payload) : null,
      input.operationId,
      input.userId,
    ],
  );
  return result.rowCount === 1;
}
