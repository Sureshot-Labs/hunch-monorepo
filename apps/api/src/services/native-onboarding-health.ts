import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { NativeDeliveryState } from "./native-push-delivery-runtime.js";
import type { NativeStatisticsDiagnostics } from "./native-worker-diagnostics.js";

export const NATIVE_WORKER_HEALTH_FILE =
  "/tmp/hunch-native-onboarding-health.json";
// Monitoring only; never cancels jobs or blocks public reads. Two existing
// five-minute statistics leases allow a stalled process to be distinguished.
const maxProgressAgeMs = 10 * 60_000;

export type NativeWorkerHealth = {
  version: 1;
  startedAt: number;
  delivery: NativeDeliveryState;
  statistics: {
    lastCycleAt: number | null;
    lastSuccessAt: number | null;
    failedProfiles: number;
    updatedProfiles: number;
    retryStoreFailures: number;
    lastErrorAt: number | null;
  };
  pipeline: {
    lastCycleAt: number | null;
    lastSuccessAt: number | null;
    failedStages: string[];
  };
};

export function createNativeWorkerHealth(
  delivery: NativeDeliveryState,
  options: { path?: string; now?: () => number } = {},
) {
  const now = options.now ?? Date.now;
  const path = options.path ?? NATIVE_WORKER_HEALTH_FILE;
  const state: NativeWorkerHealth = {
    version: 1,
    startedAt: now(),
    delivery,
    statistics: {
      lastCycleAt: null,
      lastSuccessAt: null,
      failedProfiles: 0,
      updatedProfiles: 0,
      retryStoreFailures: 0,
      lastErrorAt: null,
    },
    pipeline: { lastCycleAt: null, lastSuccessAt: null, failedStages: [] },
  };
  let lastWrite = 0;
  function persist(force = false) {
    if (!force && now() - lastWrite < 5_000) return;
    try {
      writeFileSync(`${path}.${process.pid}.tmp`, JSON.stringify(state), {
        mode: 0o600,
      });
      renameSync(`${path}.${process.pid}.tmp`, path);
      lastWrite = now();
    } catch {
      console.error(
        JSON.stringify({ event: "native_worker_health_write_failed" }),
      );
    }
  }
  persist(true);
  return {
    diagnostics(summary: NativeStatisticsDiagnostics) {
      state.statistics.failedProfiles += summary.failed;
      state.statistics.updatedProfiles += summary.updated;
      state.statistics.retryStoreFailures += summary.retryStoreFailed;
      if (summary.errors.length) state.statistics.lastErrorAt = now();
    },
    statistics(failed: boolean, seedFailed = false) {
      const first =
        state.statistics.lastCycleAt === null ||
        (!failed && state.statistics.lastSuccessAt === null);
      state.statistics.lastCycleAt = now();
      if (!failed) state.statistics.lastSuccessAt = now();
      if (failed || seedFailed) state.statistics.lastErrorAt = now();
      persist(first);
    },
    pipeline(failedStages: string[], activeStages = 5) {
      const first =
        state.pipeline.lastCycleAt === null ||
        (failedStages.length < activeStages &&
          state.pipeline.lastSuccessAt === null);
      state.pipeline = {
        lastCycleAt: now(),
        failedStages,
        lastSuccessAt:
          failedStages.length < activeStages
            ? now()
            : state.pipeline.lastSuccessAt,
      };
      persist(first);
    },
    snapshot: () => structuredClone(state),
  };
}

/** Read-only readiness: no secrets bootstrap, database connection or work. */
export function readNativeWorkerHealth(
  path = NATIVE_WORKER_HEALTH_FILE,
  now = Date.now(),
  requireDelivery = false,
) {
  const raw = readFileSync(path, "utf8");
  if (raw.length > 32_768) throw new Error("invalid_worker_health");
  const state = JSON.parse(raw) as NativeWorkerHealth;
  const fresh = (at: unknown) =>
    typeof at === "number" &&
    Number.isFinite(at) &&
    at <= now &&
    now - at <= maxProgressAgeMs;
  if (
    state.version !== 1 ||
    !fresh(state.statistics?.lastCycleAt) ||
    !fresh(state.statistics?.lastSuccessAt) ||
    !fresh(state.pipeline?.lastCycleAt) ||
    !fresh(state.pipeline?.lastSuccessAt)
  )
    throw new Error("worker_progress_unavailable");
  if (
    !["disabled", "ready", "configuration_error"].includes(
      state.delivery?.state,
    )
  )
    throw new Error("invalid_worker_health");
  for (const counter of [
    state.statistics.failedProfiles,
    state.statistics.updatedProfiles,
    state.statistics.retryStoreFailures,
  ])
    if (!Number.isSafeInteger(counter) || counter < 0)
      throw new Error("invalid_worker_health");
  if (requireDelivery && state.delivery.state !== "ready")
    throw new Error("apns_delivery_not_ready");
  return state;
}
