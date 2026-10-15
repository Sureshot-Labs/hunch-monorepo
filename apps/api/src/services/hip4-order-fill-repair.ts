// Bounded observation of already-admitted orders. Writes only the existing P2
// execution ledger and a resumable cursor on the existing action observation.
import type { Pool } from "@hunch/infra";
import { hip4FillRepairSchema } from "../schemas/hip4-account.js";
import type { Hip4AccountPolicy } from "./hip4-account-policy.js";
import { Hip4ReadError, type createHip4AccountClient } from "./hip4-client.js";
import {
  claimHip4AccountRefresh,
  failHip4AccountRefresh,
  persistHip4AccountRefresh,
} from "./hip4-account-repository.js";
import {
  advanceHip4FillRepair,
  hip4FillPageSchema,
  planHip4FillRepair,
} from "./hip4-account-history.js";
import { projectHip4Execution } from "./hip4-account-projection.js";
import {
  readHip4OrderObservationContext,
  type Hip4OrderObservationClaim,
} from "../repos/hip4-order-observation.js";

export function planHip4OrderFillRepair(
  previous: unknown,
  nonce: number,
  now: number,
  maxGaps: number,
) {
  const parsed = hip4FillRepairSchema.safeParse(previous);
  const saved = parsed.success ? parsed.data : null;
  // Resume the frozen range even when the general account lookback moves on.
  // Exhaustion is not absence proof: restart at this order on a later pass to
  // recover late provider indexing. Immutable P2 identities make replay safe.
  const pending =
    saved?.nextTime != null &&
    saved.startTime === nonce &&
    saved.endTime >= nonce &&
    saved.endTime <= now &&
    saved.lookbackMs === saved.endTime - nonce &&
    saved.nextTime >= nonce &&
    saved.nextTime <= saved.endTime;
  return planHip4FillRepair(
    pending ? saved : null,
    pending ? saved.lookbackMs : now - nonce,
    pending ? saved.endTime : now,
    maxGaps,
  );
}

export async function repairHip4ClaimedOrderFills(input: {
  pool: Pool;
  claim: Hip4OrderObservationClaim;
  policy: Hip4AccountPolicy;
  read: ReturnType<typeof createHip4AccountClient>;
  throughTime: number;
}) {
  let pages = 0;
  for (; pages < input.policy.historyRepairPagesPerRefresh; pages++) {
    const context = await readHip4OrderObservationContext(
      input.pool,
      input.claim,
    );
    if (!context) return { pages, error: "order_lease_lost" };
    if (
      context.fills_observation?.fullQuantityObserved === true &&
      context.fills_observation.feeCoverage === "known"
    )
      return { pages, error: null };
    const envelope = context.unsigned_envelope;
    if (
      context.environment !== "mainnet" ||
      envelope.action.type !== "order" ||
      envelope.action.orders.length !== 1
    )
      throw new Error("invalid_order_fill_repair_scope");
    const coin = `#${envelope.action.orders[0].a - 100000000}`;
    const now = input.throughTime;
    let repair = planHip4OrderFillRepair(
      context.fills_observation?.repair,
      envelope.nonce,
      now,
      input.policy.historyRepairMaxGapDetails,
    );
    const startTime = repair.nextTime;
    if (startTime === null) return { pages, error: null };
    const lease = await claimHip4AccountRefresh(
      input.pool,
      context.environment,
      context.signer_address,
      input.policy.leaseMs,
      new Date(now),
      "order_fills",
    );
    if (!lease) return { pages, error: "account_refresh_in_progress" };
    let saved = false;
    let error: string | null = null;
    try {
      const rows = hip4FillPageSchema.parse(
        await input.read({
          type: "userFillsByTime",
          user: context.signer_address,
          startTime,
          endTime: repair.endTime,
          aggregateByTime: false,
        }),
      );
      // All provider rows count toward the cap, not just the requested coin.
      // Store every observed order of that coin in the SAME P2 ledger, so wrong
      // side/quantity observations remain visible to exact order validation.
      const selected = rows.filter((row) => row.coin === coin);
      const executions = selected.map((row) =>
        projectHip4Execution(context.environment, context.signer_address, row),
      );
      const next = advanceHip4FillRepair(
        repair,
        rows,
        new Date(now).toISOString(),
        input.policy.historyRepairMaxGapDetails,
      );
      saved = await persistHip4AccountRefresh(input.pool, {
        environment: context.environment,
        address: context.signer_address,
        lease,
        observation: null,
        executions,
        executionSources: selected,
        ledger: [],
        history: {},
        error: null,
        preserveAttemptError: true,
      });
      if (saved) repair = next;
      else error = "account_lease_lost";
    } catch (cause) {
      error =
        cause instanceof Hip4ReadError
          ? cause.reason
          : "order_fill_repair_failed";
    } finally {
      if (!saved)
        await failHip4AccountRefresh(
          input.pool,
          context.environment,
          context.signer_address,
          lease,
          error ?? "order_fill_repair_failed",
          true,
        );
    }
    // Facts commit first, cursor second: an interruption replays/deduplicates
    // facts; it never skips missing facts or overwrites another worker's cursor.
    repair = {
      ...repair,
      lastAttemptAt: new Date(now).toISOString(),
      lastError: error,
    };
    const updated = await input.pool.query(
      `update hip4_order_submissions set fills_observation=coalesce(fills_observation,'{}'::jsonb)||jsonb_build_object('repair',$3::jsonb,'repairError',$4::text)
       where action_id=$1 and reconcile_lease_token=$2 and reconcile_lease_until>clock_timestamp() and state<>'rejected' returning action_id`,
      [input.claim.action_id, input.claim.reconcile_lease_token, repair, error],
    );
    if (!updated.rowCount)
      return { pages: pages + 1, error: "order_lease_lost" };
    if (error || repair.nextTime === null) return { pages: pages + 1, error };
  }
  return { pages, error: null };
}
