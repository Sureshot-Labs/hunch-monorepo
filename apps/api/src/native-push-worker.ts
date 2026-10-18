import { setTimeout as delay } from "node:timers/promises";
import { createPgPool } from "@hunch/infra";
import { APNsClient } from "./services/apns-client.js";
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

const apns =
  process.env.HUNCH_APNS_DELIVERY_ENABLED === "true"
    ? new APNsClient({
        keyID: required("APNS_KEY_ID"),
        teamID: required("APNS_TEAM_ID"),
        privateKey: required("APNS_PRIVATE_KEY"),
        bundleID: "trade.hunch.app",
      })
    : null;
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
      delivery: apns
        ? async () => {
            const counts = await deliverNativePushBatch({
              db,
              send: apns.send,
            });
            if (Object.values(counts).some(Boolean))
              console.log(
                JSON.stringify({ event: "native_push_delivery", ...counts }),
              );
          }
        : undefined,
    });
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
  await Promise.all([
    runPushCycle(),
    runSocialTraderStatisticsWorker({
      signal: abort.signal,
      seed: () => seedNextSocialTraderStatisticsBatch(db),
      refresh: (batchSize) => refreshSocialTraderStatistics(db, batchSize),
      onFailure: (stage) =>
        console.error(
          JSON.stringify({ event: "native_statistics_cycle_failed", stage }),
        ),
    }),
  ]);
} finally {
  abort.abort();
  apns?.close();
  await db.end();
}
