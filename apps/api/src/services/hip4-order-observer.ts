// Recovery of already-admitted purchases only. No signer, exchange transport,
// order creation or automatic continuation of an abandoned purchase.
import { tx, type Pool } from "@hunch/infra";
import { fetchActiveRuntimePolicy } from "@hunch/db";
import { hip4ReadPolicySchema } from "@hunch/shared";
import { createHip4AccountClient, Hip4ReadError } from "./hip4-client.js";
import { admitHip4OrderEvidenceRequest } from "./hip4-order-evidence-budget.js";
import { readHip4AccountPolicy } from "./hip4-account-repository.js";
import { repairHip4ClaimedOrderFills } from "./hip4-order-fill-repair.js";
import { hip4FillRepairSchema } from "../schemas/hip4-account.js";
import { assertHip4ObservationDeadline } from "./hip4-optional-observation.js";
import {
  HIP4_CLAIM_ORDER_OBSERVATION_SQL,
  HIP4_CLAIM_COMPLETED_ORDER_OBSERVATION_SQL,
  readHip4OrderObservationContext,
  recordHip4OrderObservationInTransaction,
  failHip4OrderObservation,
  type Hip4OrderObservationClaim,
} from "../repos/hip4-order-observation.js";

export type Hip4OrderObservationOptions = Readonly<{
  deadlineMs?: number;
  maxFillPages?: 1;
  // Periodic heavy evidence shares the background quota; explicit repair and
  // post-submit confirmation retain their existing financial-read priority.
  periodic?: boolean;
  // Periodic worker only. Explicit owned repair never waits for housekeeping.
  fillRepairMinimumIntervalMs?: number;
}>;

export function hip4OrderFillRepairDue(
  previous: unknown,
  now: number,
  minimumIntervalMs = 0,
) {
  if (minimumIntervalMs <= 0) return true;
  const repair = hip4FillRepairSchema.safeParse(previous);
  const attemptedAt = repair.success
    ? Date.parse(repair.data.lastAttemptAt ?? "")
    : NaN;
  // Missing/legacy facts and a backward clock must not pin repair forever.
  return (
    !Number.isFinite(attemptedAt) ||
    attemptedAt > now ||
    attemptedAt + minimumIntervalMs <= now
  );
}

/** Single claimed action; exported for bounded explicit repair and offline
 * transport tests. The claim is database-owned, never a public request body. */
export async function observeHip4ClaimedOrder(
  pool: Pool,
  claim: Hip4OrderObservationClaim,
  maxRows: number,
  retryMs: number,
  fetcher?: typeof fetch,
  options: Hip4OrderObservationOptions = {},
) {
  assertHip4ObservationDeadline(options.deadlineMs);
  const context = await readHip4OrderObservationContext(pool, claim);
  if (!context) return { saved: false as const };
  if (context.environment !== "mainnet" || context.action_kind !== "order")
    throw new Error("invalid_reconciliation_scope");
  const raw = await fetchActiveRuntimePolicy(pool, "hip4_read", new Date(), {
    missingTable: "error",
  });
  const policy = {
    ...hip4ReadPolicySchema.parse(raw?.payload ?? {}),
    environment: context.environment,
  };
  const read = createHip4AccountClient(
    policy,
    async (weight) => {
      assertHip4ObservationDeadline(options.deadlineMs);
      if (!(await readHip4OrderObservationContext(pool, claim)))
        throw new Error("order_lease_lost");
      const active = await fetchActiveRuntimePolicy(
        pool,
        "hip4_read",
        new Date(),
        { missingTable: "error" },
      );
      const current = hip4ReadPolicySchema.parse(active?.payload ?? {});
      return admitHip4OrderEvidenceRequest(pool, {
        environment: context.environment,
        weight,
        policy: current,
        periodic: options.periodic === true,
      });
    },
    fetcher,
    options.deadlineMs === undefined
      ? undefined
      : { deadlineMs: options.deadlineMs },
  );
  assertHip4ObservationDeadline(options.deadlineMs);
  const body = await read({
    type: "orderStatus",
    user: context.signer_address,
    oid: context.cloid,
  });
  const responseAt = Date.now();
  // Persist exact status and any invalidation BEFORE the longer fill-repair
  // phase. A transport failure/expired lease there cannot lose this evidence.
  const staged = await tx(pool, (db) =>
    recordHip4OrderObservationInTransaction(db, {
      claim,
      userId: context.user_id,
      body,
      responseAt,
      maxRows,
      retryMs,
      phase: "status",
      deadlineMs: options.deadlineMs,
    }),
  );
  if (!staged.saved) return staged;
  if ("rejected" in staged && staged.rejected) return staged;
  let repairError: string | null = null;
  try {
    const account = await readHip4AccountPolicy(pool);
    if (
      hip4OrderFillRepairDue(
        context.fills_observation?.repair,
        responseAt,
        options.fillRepairMinimumIntervalMs,
      )
    ) {
      repairError = (
        await repairHip4ClaimedOrderFills({
          pool,
          claim,
          policy: {
            ...account.policy,
            historyRepairPagesPerRefresh: Math.min(
              account.policy.historyRepairPagesPerRefresh,
              options.maxFillPages ??
                account.policy.historyRepairPagesPerRefresh,
            ),
          },
          read,
          throughTime: responseAt,
          deadlineMs: options.deadlineMs,
        })
      ).error;
    } else {
      // A skipped history attempt is not a successful repair. Preserve its
      // failure provenance while still consuming independently valid P2 facts.
      repairError = context.fills_observation?.repairError ?? null;
    }
  } catch (error) {
    repairError =
      error instanceof Hip4ReadError
        ? error.reason
        : "order_fill_repair_failed";
  }
  return tx(pool, (db) =>
    recordHip4OrderObservationInTransaction(db, {
      claim,
      userId: context.user_id,
      body,
      responseAt,
      maxRows,
      retryMs,
      repairError,
      deadlineMs: options.deadlineMs,
    }),
  );
}

export async function runHip4OrderObservationPass(
  pool: Pool,
  fetcher?: typeof fetch,
) {
  // Same account observer cadence/lease/row bounds; no second product switch.
  // Lifecycle disabling new exposure must not abandon an already sent order.
  const account = await readHip4AccountPolicy(pool);
  const result = {
    claimed: 0,
    saved: 0,
    errors: 0,
    leaseLost: 0,
    budgetExhausted: 0,
    completedClaimed: 0,
  };
  for (let index = 0; index < account.policy.workerBatchSize; index++) {
    const currentAccount = await readHip4AccountPolicy(pool);
    if (index >= currentAccount.policy.workerBatchSize) break;
    // Protect the first hot slot. Later slots may recheck completed receipts,
    // bounded by the SAME total batch; a missing cold row falls back to hot.
    // Batch=0 pauses all work; batch=1 intentionally reserves only hot work.
    const tryCompleted =
      index > 0 &&
      result.completedClaimed < currentAccount.policy.completedOrderBatchSize;
    let claim = tryCompleted
      ? (
          await pool.query<Hip4OrderObservationClaim>(
            HIP4_CLAIM_COMPLETED_ORDER_OBSERVATION_SQL,
            [
              currentAccount.policy.leaseMs,
              currentAccount.policy.completedOrderRecheckIntervalMs,
            ],
          )
        ).rows[0]
      : undefined;
    if (claim) result.completedClaimed++;
    claim ??= (
      await pool.query<Hip4OrderObservationClaim>(
        HIP4_CLAIM_ORDER_OBSERVATION_SQL,
        [
          currentAccount.policy.leaseMs,
          currentAccount.policy.orderObservationIntervalMs,
        ],
      )
    ).rows[0];
    if (!claim) {
      if (index === 0) continue;
      break;
    }
    result.claimed++;
    try {
      const saved = await observeHip4ClaimedOrder(
        pool,
        claim,
        currentAccount.policy.accountingMaxRows,
        currentAccount.policy.orderObservationIntervalMs,
        fetcher,
        {
          periodic: true,
          fillRepairMinimumIntervalMs:
            currentAccount.policy.orderFillRepairIntervalMs,
        },
      );
      if (!saved.saved) result.leaseLost++;
      else {
        result.saved++;
        if (saved.error) result.errors++;
        if (saved.error === "budget_exhausted") {
          result.budgetExhausted++;
          break;
        }
      }
    } catch (error) {
      result.errors++;
      const code =
        error instanceof Hip4ReadError
          ? error.reason
          : "order_observation_failed";
      await tx(pool, (db) =>
        failHip4OrderObservation(
          db,
          claim,
          code,
          currentAccount.policy.orderObservationIntervalMs,
        ),
      );
      if (code === "budget_exhausted") {
        result.budgetExhausted++;
        break;
      }
    }
  }
  return result;
}
