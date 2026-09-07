import type { Pool } from "@hunch/infra";
import {
  claimStandaloneReconciliation,
  finishStandaloneReconciliation,
  standaloneReconciliationSchemaReady,
  type StandaloneReconciliationKind,
  type StandaloneReconciliationLease,
} from "../persistence/standalone-reconciliation-repository.js";

export type StandaloneReconciliationSummary = {
  claimed: number;
  reconciled: number;
  retryableErrors: number;
  timedOut: number;
  skipped?: "schema_not_ready";
};

type StandaloneReconciler = (userId: string, id: string) => Promise<unknown>;
// A timed-out evidence read may still settle. Keep its lease and prevent this
// process from starting an overlapping read while that promise is alive.
const activeJournals = new Set<StandaloneReconciliationKind>();

/** Independent journals have their own bounded queue; none of these callbacks
 * may prepare, execute, or submit a replacement action. */
export async function runStandaloneReconciliationBatch(
  db: Pick<Pool, "query">,
  dependencies: Readonly<{
    preparation: StandaloneReconciler;
    positionAction: StandaloneReconciler;
  }>,
  options: Readonly<{
    limit?: number;
    itemTimeoutMs?: number;
    retryDelayMs?: number;
    now?: Date;
  }> = {},
): Promise<StandaloneReconciliationSummary> {
  const summary: StandaloneReconciliationSummary = {
    claimed: 0,
    reconciled: 0,
    retryableErrors: 0,
    timedOut: 0,
  };
  if (!(await standaloneReconciliationSchemaReady(db))) {
    return { ...summary, skipped: "schema_not_ready" };
  }
  const limit = Math.max(1, Math.min(4, Math.trunc(options.limit ?? 4)));
  const itemTimeoutMs = Math.max(
    1,
    Math.min(20_000, options.itemTimeoutMs ?? 20_000),
  );
  const retryDelayMs = Math.max(1, options.retryDelayMs ?? 60_000);
  const now = options.now ?? new Date();
  const leaseMs = Math.max(120_000, itemTimeoutMs * limit * 2);
  const groups = await Promise.all(
    (["preparation", "position_action"] as const).map((kind) =>
      activeJournals.has(kind)
        ? Promise.resolve([])
        : claimStandaloneReconciliation(db, { kind, limit, now, leaseMs }),
    ),
  );
  summary.claimed = groups.reduce((count, leases) => count + leases.length, 0);
  const reconcile = async (lease: StandaloneReconciliationLease) => {
    if (activeJournals.has(lease.kind)) return false;
    activeJournals.add(lease.kind);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const pending = Promise.resolve()
      .then(() =>
        (lease.kind === "preparation"
          ? dependencies.preparation
          : dependencies.positionAction)(lease.userId, lease.id),
      )
      .then(() => {
        if (!timedOut) summary.reconciled += 1;
      })
      .catch(() => {
        // Do not log provider errors: they may contain authenticated RPC URLs.
        if (!timedOut) summary.retryableErrors += 1;
      })
      .finally(async () => {
        try {
          await finishStandaloneReconciliation(db, {
            lease,
            retryAt: new Date(
              (options.now?.getTime() ?? Date.now()) + retryDelayMs,
            ),
          });
        } finally {
          activeJournals.delete(lease.kind);
        }
      });
    try {
      await Promise.race([
        pending,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            summary.timedOut += 1;
            resolve();
          }, itemTimeoutMs);
        }),
      ]);
    } catch {
      summary.retryableErrors += 1;
    } finally {
      if (timer) clearTimeout(timer);
    }
    return !timedOut;
  };
  // At most two concurrent evidence reads; both journals make progress.
  await Promise.all(
    groups.map(async (leases) => {
      for (const lease of leases) {
        if (!(await reconcile(lease))) break;
      }
    }),
  );
  return summary;
}
