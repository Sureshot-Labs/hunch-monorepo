import { tx, type Pool, type PoolClient } from "@hunch/infra";
import { z } from "zod";
import { lockFundingPolicyForTransaction } from "../funding/policies/funding-policy-sidecar.js";

const referenceSchema = z.object({
  userId: z.string().uuid(),
  actionId: z.string().uuid(),
});
export const hip4OrderRecoverySchema = z.object({
  actionId: z.string().uuid(),
  orderId: z.string().uuid(),
  requestKey: z.string().uuid(),
  kind: z.enum(["order", "cancelByCloid"]),
  state: z.enum(["prepared", "abandoned"]),
  submissionState: z
    .enum(["submission_started", "reconcile_required", "rejected"])
    .nullable(),
  // Local expiry is NOT proof of non-submission. Only serialized abandonment
  // or a definitive rejection can resolve an ambiguous local submit attempt.
  expiresAt: z.string().datetime(),
});
export const HIP4_ORDER_RECOVERY_SQL = `select
  action_row.id as "actionId",action_row.order_id as "orderId",
  action_row.request_key as "requestKey",action_row.action_kind as kind,
  action_row.state,submission_row.state as "submissionState",
  action_row.unsigned_envelope->>'expiresAfter' as expiry_ms
  from hip4_order_actions action_row
  join orders order_row on order_row.id=action_row.order_id
  left join hip4_order_submissions submission_row on submission_row.action_id=action_row.id
  where action_row.id=$1 and order_row.user_id=$2 and order_row.venue='hyperliquid'`;

/** Indexed, ownership-scoped read. No signature, provider IO, current trading
 * capability, financial reservation or re-submission needed to recover. */
export async function readHip4OrderRecovery(
  db: Pick<Pool, "query">,
  input: { userId: string; actionId: string },
) {
  const ref = referenceSchema.parse(input);
  const row = (
    await db.query(HIP4_ORDER_RECOVERY_SQL, [ref.actionId, ref.userId])
  ).rows[0];
  if (!row) throw new Error("hip4_preparation_not_found");
  if (typeof row.expiry_ms !== "string" || !/^\d+$/u.test(row.expiry_ms))
    throw new Error("hip4_recovery_invalid");
  const expiry = Number(row.expiry_ms);
  if (!Number.isSafeInteger(expiry) || expiry < 0)
    throw new Error("hip4_recovery_invalid");
  return hip4OrderRecoverySchema.parse({
    ...row,
    expiresAt: new Date(expiry).toISOString(),
  });
}

/** Explicit discard/retry only. Same lock order as admission: an in-flight
 * submit either wins and remains reconciling, or loses and can NEVER POST.
 * This is not cancellation of a live order; it does not release funding/holds,
 * erase nonce claims, contact the exchange or automatically start another buy. */
export async function abandonHip4OrderPreparationInTransaction(
  db: PoolClient,
  input: { userId: string; actionId: string },
) {
  const ref = referenceSchema.parse(input);
  await lockFundingPolicyForTransaction(db);
  await db.query("select id from users where id=$1 for update", [ref.userId]);
  await db.query(
    `select action_row.id from hip4_order_actions action_row
      join orders order_row on order_row.id=action_row.order_id
      where action_row.id=$1 and order_row.user_id=$2 and order_row.venue='hyperliquid'
      for update of order_row,action_row`,
    [ref.actionId, ref.userId],
  );
  const state = await readHip4OrderRecovery(db, ref);
  if (state.submissionState !== null || state.state === "abandoned")
    return state;
  await db.query(
    "update hip4_order_actions set state='abandoned' where id=$1",
    [ref.actionId],
  );
  if (state.kind === "order")
    await db.query("update orders set status='abandoned' where id=$1", [
      state.orderId,
    ]);
  return { ...state, state: "abandoned" as const };
}

export function abandonHip4OrderPreparation(
  pool: Pool,
  input: { userId: string; actionId: string },
) {
  return tx(pool, (db) => abandonHip4OrderPreparationInTransaction(db, input));
}
