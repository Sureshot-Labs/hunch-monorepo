import {
  hip4CatalogRefreshIntervalMs,
  type Hip4ReadPolicy,
} from "@hunch/shared";

/** Catalog observations expire independently of depth/history repair work. */
export function createHip4ReadSchedule() {
  let lastStartedAt: number | undefined;
  let lastRepairStartedAt: number | undefined;
  let metadataBudgetDenied = false;
  return {
    start: (policy: Hip4ReadPolicy, now: number) => {
      lastStartedAt = now;
      metadataBudgetDenied = false;
      return {
        repair:
          lastRepairStartedAt === undefined ||
          now - lastRepairStartedAt >= policy.pollMs,
      };
    },
    complete: (
      startedAt: number,
      repairAttempted: boolean,
      metadataDenied = false,
    ) => {
      // A denied metadata pair made no repair attempt. Let the next ordinary
      // catalog deadline recover without clearing state or waiting a full poll.
      if (repairAttempted) lastRepairStartedAt = startedAt;
      metadataBudgetDenied = metadataDenied;
    },
    waitMs: (policy: Hip4ReadPolicy, now: number, maintenance = false) => {
      const ordinaryInterval = maintenance
        ? policy.pollMs
        : hip4CatalogRefreshIntervalMs(policy);
      // DB admission times can straddle a rolling-window boundary even when
      // cycle starts are exactly spaced. Denied pairs perform no HTTP: retry
      // at the existing bounded minimum rather than missing an entire deadline.
      const interval = metadataBudgetDenied
        ? Math.min(ordinaryInterval, policy.minRefreshMs)
        : ordinaryInterval;
      // Count from the actual cycle start. Publication time must not be added
      // to every refresh interval; overlong work schedules one next pass, never
      // a burst of historical missed slots.
      return Math.max(0, (lastStartedAt ?? now) + interval - now);
    },
  };
}
