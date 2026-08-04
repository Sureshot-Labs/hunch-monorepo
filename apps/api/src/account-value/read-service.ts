import type { AccountValueReadModel } from "./runtime-service.js";
import { createAccountValueSnapshotLoader } from "./snapshot-loader.js";

export type AccountValueReadService = Readonly<{
  invalidate: (userId: string) => void;
  load: (userId: string) => Promise<AccountValueReadModel>;
}>;

type RetainedAccountValue = Readonly<{
  capturedAt: number;
  value: AccountValueReadModel;
}>;

function hasRetryableCollectorError(account: AccountValueReadModel): boolean {
  return [
    ...account.projection.collectorErrors,
    ...account.cashAvailability.collectorErrors,
  ].some((error) => error.retryable);
}

export function retainAccountValueDuringRetryablePartial(
  previous: AccountValueReadModel | undefined,
  next: AccountValueReadModel,
): AccountValueReadModel {
  if (!previous || !hasRetryableCollectorError(next)) return next;
  return {
    ...next,
    projection: {
      ...previous.projection,
      asOf: next.projection.asOf,
      collectorErrors: next.projection.collectorErrors,
      positionValuationCompleteness:
        next.projection.positionValuationCompleteness,
      positionValuationFreshness: "stale",
      valuationCompleteness: next.projection.valuationCompleteness,
      valuationFreshness: "stale",
    },
    headline: {
      ...previous.headline,
      completeness: next.headline.completeness,
      freshness: "stale",
    },
    cashAvailability: {
      ...previous.cashAvailability,
      asOf: next.cashAvailability.asOf,
      collectorErrors: next.cashAvailability.collectorErrors,
      completeness: next.cashAvailability.completeness,
      freshness: "stale",
    },
    venues: previous.venues,
  };
}

export function createAccountValueReadService(
  build: (userId: string) => Promise<AccountValueReadModel>,
  options: Readonly<{
    maxEntries?: number;
    now?: () => number;
    retentionMs?: number;
    ttlMs?: number;
  }> = {},
): AccountValueReadService {
  const maxEntries = Math.max(1, Math.trunc(options.maxEntries ?? 500));
  const retentionMs = Math.max(0, Math.trunc(options.retentionMs ?? 60_000));
  const now = options.now ?? Date.now;
  const snapshots = createAccountValueSnapshotLoader(build, {
    maxEntries,
    now,
    ttlMs: options.ttlMs ?? 2_000,
  });
  const retained = new Map<string, RetainedAccountValue>();

  const trim = () => {
    while (retained.size > maxEntries) {
      const oldest = retained.keys().next().value;
      if (typeof oldest !== "string") return;
      retained.delete(oldest);
    }
  };

  return {
    invalidate: (userId) => {
      snapshots.invalidate(userId);
      retained.delete(userId);
    },
    load: async (userId) => {
      const next = await snapshots.load(userId);
      const currentTime = now();
      const previous = retained.get(userId);
      if (previous && currentTime - previous.capturedAt > retentionMs) {
        retained.delete(userId);
      }
      if (hasRetryableCollectorError(next)) {
        return retainAccountValueDuringRetryablePartial(
          previous && currentTime - previous.capturedAt <= retentionMs
            ? previous.value
            : undefined,
          next,
        );
      }
      retained.delete(userId);
      retained.set(userId, { capturedAt: currentTime, value: next });
      trim();
      return next;
    },
  };
}

export const accountValueReadServiceTestHooks = {
  hasRetryableCollectorError,
};
