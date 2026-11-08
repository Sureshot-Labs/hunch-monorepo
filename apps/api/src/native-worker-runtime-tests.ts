import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativePushDelivery } from "./services/native-push-delivery-runtime.js";
import {
  createNativeWorkerHealth,
  readNativeWorkerHealth,
} from "./services/native-onboarding-health.js";
import { nativeWorkerErrorCode } from "./services/native-worker-diagnostics.js";

let created = 0,
  closed = 0;
const createClient = () => {
  created++;
  return {
    send: async () => ({ status: 200, reason: null, invalidatedAt: null }),
    close() {
      closed++;
    },
  };
};
const disabled = createNativePushDelivery({}, createClient);
assert.equal(disabled.status.state, "disabled");
assert.equal(created, 0);
const missing = createNativePushDelivery(
  { HUNCH_APNS_DELIVERY_ENABLED: "true" },
  createClient,
);
assert.deepEqual(missing.status, {
  state: "configuration_error",
  code: "missing_apns_configuration",
});
assert.equal(created, 0);
const configuration = {
  HUNCH_APNS_DELIVERY_ENABLED: "true",
  APNS_KEY_ID: "TESTKEY123",
  APNS_TEAM_ID: "TESTTEAM12",
  APNS_PRIVATE_KEY: "synthetic-private-material",
};
const invalid = createNativePushDelivery(configuration, () => {
  throw Error("DO_NOT_LOG_private_key_or_token");
});
assert.deepEqual(invalid.status, {
  state: "configuration_error",
  code: "invalid_apns_configuration",
});
assert.ok(!JSON.stringify(invalid).includes("DO_NOT_LOG"));
assert.equal(invalid.send, undefined);
const ready = createNativePushDelivery(configuration, createClient);
assert.equal(ready.status.state, "ready");
assert.ok(ready.send);
assert.equal(
  (
    await ready.send({
      token: "synthetic",
      environment: "sandbox",
      id: "test",
      payload: {},
      expiresAt: 1,
    })
  ).status,
  200,
);
ready.close();
assert.equal(closed, 1);
for (const code of ["57014", "40P01", "53200", "ECONNRESET"])
  assert.equal(nativeWorkerErrorCode({ code }), code);
for (const error of [
  null,
  Error("private text"),
  { code: "secret_token_with_long_private_text" },
])
  assert.equal(nativeWorkerErrorCode(error), "unknown");

const root = mkdtempSync(join(tmpdir(), "hunch-native-health-test-"));
try {
  let now = Date.now();
  const path = join(root, "status.json");
  const health = createNativeWorkerHealth(disabled.status, {
    path,
    now: () => now,
  });
  assert.throws(() => readNativeWorkerHealth(path, now));
  health.statistics(true);
  health.pipeline(["fanout", "digest", "big_moves", "rankings", "retention"]);
  assert.throws(
    () => readNativeWorkerHealth(path, now),
    /worker_progress_unavailable/,
  );
  now += 5000;
  health.statistics(false);
  health.pipeline([]);
  assert.equal(readNativeWorkerHealth(path, now).delivery.state, "disabled");
  assert.throws(
    () => readNativeWorkerHealth(path, now, true),
    /apns_delivery_not_ready/,
  );
  health.diagnostics({
    claimed: 3,
    updated: 2,
    failed: 1,
    retryScheduled: 1,
    retryStoreFailed: 0,
    leaseLost: 0,
    pendingDrained: 0,
    policyScanned: 0,
    completed: true,
    durationMs: 1,
    errors: [{ stage: "profile", code: "57014", count: 1 }],
  });
  now += 5000;
  health.statistics(false);
  assert.equal(readNativeWorkerHealth(path, now).statistics.failedProfiles, 1);
  assert.equal(readNativeWorkerHealth(path, now).statistics.updatedProfiles, 2);
  now += 600001;
  assert.throws(
    () => readNativeWorkerHealth(path, now),
    /worker_progress_unavailable/,
  );
  health.statistics(false);
  health.pipeline([]);
  now += 5000;
  health.pipeline([]);
  assert.ok(readNativeWorkerHealth(path, now));
  const degraded = createNativeWorkerHealth(missing.status, {
    path,
    now: () => now,
  });
  degraded.statistics(false);
  degraded.pipeline([]);
  assert.equal(
    readNativeWorkerHealth(path, now).delivery.state,
    "configuration_error",
  );
  assert.throws(() => readNativeWorkerHealth(path, now, true));
  const recovered = createNativeWorkerHealth(ready.status, {
    path,
    now: () => now,
  });
  recovered.statistics(false);
  recovered.pipeline([]);
  assert.equal(readNativeWorkerHealth(path, now, true).delivery.state, "ready");
  writeFileSync(path, "not JSON, no raw text must be printed");
  assert.throws(() => readNativeWorkerHealth(path, now));
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(
  "native worker runtime: APNs isolation/recovery, safe diagnostics, progress readiness and stale/restart handling passed",
);
