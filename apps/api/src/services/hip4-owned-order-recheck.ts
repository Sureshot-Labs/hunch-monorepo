import { tx, type Pool } from "@hunch/infra";
import {
  assertHip4ObservationDeadline,
  hip4OptionalObservationPool,
  lockHip4ObservationOwner,
} from "./hip4-optional-observation.js";
import { readHip4OrderRecovery } from "../repos/hip4-order-recovery.js";
import { readHip4OwnedOrderAction } from "../repos/hip4-order-preparation.js";
import {
  HIP4_CLAIM_EXACT_ORDER_OBSERVATION_SQL,
  failHip4OrderObservation,
  type Hip4OrderObservationClaim,
} from "../repos/hip4-order-observation.js";
import { readHip4AccountPolicy } from "./hip4-account-repository.js";
import {
  observeHip4ClaimedOrder,
  type Hip4OrderObservationOptions,
} from "./hip4-order-observer.js";
import { Hip4ReadError } from "./hip4-client.js";

/** Explicit owned read repair through the existing observer/lease/budget. No
 * signer, exchange POST, abandon, funding continuation or hold release by TTL.
 * Current trading disablement must not abandon a previously admitted order. */
export async function recheckHip4OwnedOrder(
  pool: Pool,
  input: { userId: string; actionId: string },
  fetcher?: typeof fetch,
  options: Pick<
    Hip4OrderObservationOptions,
    "deadlineMs" | "maxFillPages"
  > = {},
) {
  if (options.deadlineMs !== undefined)
    pool = hip4OptionalObservationPool(pool, options.deadlineMs);
  assertHip4ObservationDeadline(options.deadlineMs);
  // Ownership is established before any policy/provider IO. A request for a
  // cancellation observes its original economic order, never the cancel ACK.
  await readHip4OrderRecovery(pool, input);
  const account = await readHip4AccountPolicy(pool);
  const claim = await tx(pool, async (db) => {
    await lockHip4ObservationOwner(db, input.userId, options.deadlineMs);
    const current = await readHip4OrderRecovery(db, input);
    const original = await readHip4OwnedOrderAction(db, {
      userId: input.userId,
      orderId: current.orderId,
    });
    assertHip4ObservationDeadline(options.deadlineMs);
    return (
      (
        await db.query<Hip4OrderObservationClaim>(
          HIP4_CLAIM_EXACT_ORDER_OBSERVATION_SQL,
          [
            original.id,
            options.deadlineMs === undefined
              ? account.policy.leaseMs
              : Math.max(
                  1,
                  Math.min(
                    account.policy.leaseMs,
                    options.deadlineMs - Date.now(),
                  ),
                ),
            account.policy.orderObservationIntervalMs,
          ],
        )
      ).rows[0] ?? null
    );
  });
  if (claim) {
    try {
      await observeHip4ClaimedOrder(
        pool,
        claim,
        account.policy.accountingMaxRows,
        account.policy.orderObservationIntervalMs,
        fetcher,
        options,
      );
    } catch (error) {
      try {
        await tx(pool, (db) =>
          failHip4OrderObservation(
            db,
            claim,
            error instanceof Hip4ReadError
              ? error.reason
              : "order_observation_failed",
            account.policy.orderObservationIntervalMs,
            options.deadlineMs,
          ),
        );
      } finally {
        if (options.deadlineMs !== undefined) {
          // This exact observer has stopped IO. Relinquish ONLY its lease,
          // without changing financial/status facts or waiting for P/U locks.
          // If its deadline has elapsed the short fast lease expires naturally.
          await pool.query(
            `update hip4_order_submissions set reconcile_lease_token=null,reconcile_lease_until=null
             where action_id=$1 and reconcile_lease_token=$2 returning action_id`,
            [claim.action_id, claim.reconcile_lease_token],
          );
        }
      }
    }
  }
  return readHip4OrderRecovery(pool, input);
}
