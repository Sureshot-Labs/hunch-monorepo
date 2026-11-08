import { setTimeout as delay } from "node:timers/promises";
import { createPgPool } from "@hunch/infra";
import { createNativePushDelivery } from "./services/native-push-delivery-runtime.js";
import { createNativeWorkerHealth } from "./services/native-onboarding-health.js";
import { nativeWorkerErrorCode } from "./services/native-worker-diagnostics.js";
import { deliverNativePushBatch } from "./services/native-push-queue.js";
import {
  enqueueNativeBigMoves,
  enqueueNativeMarketDigest,
  fanoutNativePushEvent,
} from "./services/native-push-sources.js";
import {
  publishSocialTraderRanking,
  refreshSocialTraderStatistics,
  seedNextSocialTraderStatisticsBatch,
} from "./services/social-trader-statistics.js";
import { retainNativeOnboardingData } from "./services/native-onboarding-retention.js";
import { runNativeOnboardingCycle } from "./services/native-onboarding-worker-cycle.js";
import { runSocialTraderStatisticsWorker } from "./services/social-trader-statistics-worker.js";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing native push configuration: ${name}`);
  return value;
}

const delivery = createNativePushDelivery();
const sendNativePush = delivery.send;
const health = createNativeWorkerHealth(delivery.status, {
  path: process.env.HUNCH_NATIVE_ONBOARDING_HEALTH_FILE,
});
console.log(
  JSON.stringify({
    event: "native_onboarding_worker_started",
    delivery: delivery.status.state,
  }),
);
if (delivery.status.state === "configuration_error")
  console.error(
    JSON.stringify({
      event: "native_push_configuration_failed",
      code: delivery.status.code,
      recovery: "correct_configuration_and_restart_worker",
    }),
  );
const db = createPgPool({
  connectionString: required("DATABASE_URL"),
  max: 10,
  statement_timeout: 10_000,
  connectionTimeoutMillis: 5_000,
});
const abort = new AbortController();
process.once("SIGINT", () => abort.abort());
process.once("SIGTERM", () => abort.abort());
async function runPushCycle() {
  while (!abort.signal.aborted) {
    const failures = await runNativeOnboardingCycle({
      fanout: async () => {
        for (let batch = 0; batch < 10; batch++) {
          if (!(await fanoutNativePushEvent(db))) break;
        }
      },
      digest: () => enqueueNativeMarketDigest(db),
      big_moves: async () => {
        for (let batch = 0; batch < 10; batch++) {
          if (!(await enqueueNativeBigMoves(db))) break;
        }
      },
      rankings: () => publishSocialTraderRanking(db),
      retention: () => retainNativeOnboardingData(db),
      delivery: sendNativePush
        ? async () => {
            const counts = await deliverNativePushBatch({
              db,
              send: sendNativePush,
            });
            if (Object.values(counts).some(Boolean))
              console.log(
                JSON.stringify({ event: "native_push_delivery", ...counts }),
              );
          }
        : undefined,
    });
    health.pipeline(failures, sendNativePush ? 6 : 5);
    if (failures.length) {
      // Only fixed stage identifiers enter logs, never tokens, content, keys or URLs.
      console.error(
        JSON.stringify({ event: "native_push_cycle_failed", stages: failures }),
      );
    }
    try {
      await delay(5_000, undefined, { signal: abort.signal });
    } catch {
      break;
    }
  }
}
try {
  let lastStatisticsLogAt = 0;
  await Promise.all([
    runPushCycle(),
    runSocialTraderStatisticsWorker({
      signal: abort.signal,
      seed: () => seedNextSocialTraderStatisticsBatch(db),
      refresh: (batchSize) =>
        refreshSocialTraderStatistics(db, batchSize, (summary) => {
          health.diagnostics(summary);
          const now = Date.now();
          if (
            summary.claimed ||
            summary.pendingDrained ||
            summary.policyScanned ||
            summary.errors.length ||
            now - lastStatisticsLogAt >= 60_000
          ) {
            console.log(
              JSON.stringify({ event: "native_statistics_batch", ...summary }),
            );
            lastStatisticsLogAt = now;
          }
        }),
      onFailure: (stage, error) =>
        console.error(
          JSON.stringify({
            event: "native_statistics_cycle_failed",
            stage,
            code: nativeWorkerErrorCode(error),
          }),
        ),
      onIteration: ({ seedFailed, refreshFailed }) =>
        health.statistics(refreshFailed, seedFailed),
    }),
  ]);
} finally {
  abort.abort();
  delivery.close();
  await db.end();
}
