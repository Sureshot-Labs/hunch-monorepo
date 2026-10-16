import { tx, type Pool } from "@hunch/infra";
import { lockFundingPolicyForTransaction } from "../funding/policies/funding-policy-sidecar.js";
import { readHip4OrderRecovery } from "../repos/hip4-order-recovery.js";
import { readHip4OwnedOrderAction } from "../repos/hip4-order-preparation.js";
import {
  HIP4_CLAIM_EXACT_ORDER_OBSERVATION_SQL,
  failHip4OrderObservation,
  type Hip4OrderObservationClaim,
} from "../repos/hip4-order-observation.js";
import { readHip4AccountPolicy } from "./hip4-account-repository.js";
import { observeHip4ClaimedOrder } from "./hip4-order-observer.js";
import { Hip4ReadError } from "./hip4-client.js";

/** Explicit owned read repair through the existing observer/lease/budget. No
 * signer, exchange POST, abandon, funding continuation or hold release by TTL.
 * Current trading disablement must not abandon a previously admitted order. */
export async function recheckHip4OwnedOrder(
  pool: Pool,
  input: { userId: string; actionId: string },
  fetcher?: typeof fetch,
) {
  // Ownership is established before any policy/provider IO. A request for a
  // cancellation observes its original economic order, never the cancel ACK.
  await readHip4OrderRecovery(pool, input);
  const account = await readHip4AccountPolicy(pool);
  const claim = await tx(pool, async (db) => {
    await lockFundingPolicyForTransaction(db);
    await db.query("select id from users where id=$1 for update", [
      input.userId,
    ]);
    const current = await readHip4OrderRecovery(db, input);
    const original = await readHip4OwnedOrderAction(db, {
      userId: input.userId,
      orderId: current.orderId,
    });
    return (
      (
        await db.query<Hip4OrderObservationClaim>(
          HIP4_CLAIM_EXACT_ORDER_OBSERVATION_SQL,
          [
            original.id,
            account.policy.leaseMs,
            account.policy.workerIntervalMs,
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
        account.policy.workerIntervalMs,
        fetcher,
      );
    } catch (error) {
      await tx(pool, (db) =>
        failHip4OrderObservation(
          db,
          claim,
          error instanceof Hip4ReadError
            ? error.reason
            : "order_observation_failed",
          account.policy.workerIntervalMs,
        ),
      );
    }
  }
  return readHip4OrderRecovery(pool, input);
}
