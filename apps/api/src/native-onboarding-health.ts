import {
  NATIVE_WORKER_HEALTH_FILE,
  readNativeWorkerHealth,
} from "./services/native-onboarding-health.js";

try {
  const state = readNativeWorkerHealth(
    process.env.HUNCH_NATIVE_ONBOARDING_HEALTH_FILE ||
      NATIVE_WORKER_HEALTH_FILE,
    Date.now(),
    process.argv.includes("--require-delivery"),
  );
  // Only fixed status vocabulary and aggregate counts. Never print the file.
  console.log(
    JSON.stringify({
      event: "native_worker_ready",
      delivery: state.delivery.state,
      statisticsLastCycleAt: state.statistics.lastCycleAt,
      pipelineLastCycleAt: state.pipeline.lastCycleAt,
      failedProfiles: state.statistics.failedProfiles,
      updatedProfiles: state.statistics.updatedProfiles,
      retryStoreFailures: state.statistics.retryStoreFailures,
    }),
  );
} catch {
  console.error(JSON.stringify({ event: "native_worker_not_ready" }));
  process.exitCode = 1;
}
