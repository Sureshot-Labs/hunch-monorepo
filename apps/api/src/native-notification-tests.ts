import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { APNsClient, classifyAPNsResult } from "./services/apns-client.js";
import { nativeProbabilityMove } from "./services/native-push-sources.js";
import { runNativeOnboardingCycle } from "./services/native-onboarding-worker-cycle.js";
import { runSocialTraderStatisticsWorker } from "./services/social-trader-statistics-worker.js";
import {
  nativeDeviceBody,
  nativePreferencesBody,
} from "./schemas/native-notifications.js";
import {
  decodeTraderRankingCursor,
  encodeTraderRankingCursor,
} from "./services/social-trader-ranking-cursor.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});
let now = 1_800_000_000_000;
const client = new APNsClient({
  keyID: "TESTKEY123",
  teamID: "TESTTEAM12",
  privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  bundleID: "trade.hunch.app",
  now: () => now,
});
try {
  const token = client.providerToken();
  const [header, claims, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), {
    alg: "ES256",
    kid: "TESTKEY123",
  });
  assert.equal(
    JSON.parse(Buffer.from(claims, "base64url").toString()).iss,
    "TESTTEAM12",
  );
  assert.equal(Buffer.from(signature, "base64url").length, 64);
  assert.equal(
    verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    ),
    true,
  );
  now += 1_000;
  assert.equal(
    client.providerToken(),
    token,
    "APNs authentication tokens are reused",
  );
  now += 1_600_000;
  assert.notEqual(
    client.providerToken(),
    token,
    "expired cached provider tokens rotate",
  );
  for (const [status, reason, outcome] of [
    [200, null, "sent"],
    [410, "Unregistered", "invalid_device"],
    [400, "BadDeviceToken", "invalid_device"],
    [400, "BadTopic", "failed"],
    [403, "ExpiredProviderToken", "retry"],
    [429, "TooManyRequests", "retry"],
    [503, "Shutdown", "retry"],
  ] as const) {
    assert.equal(
      classifyAPNsResult({ status, reason, invalidatedAt: null }),
      outcome,
    );
  }
  assert.equal(
    nativeProbabilityMove({ bid: "0.69", ask: "0.71", historical: "0.5" }),
    0.19999999999999996,
  );
  for (const value of [
    { bid: null, ask: 0.7, historical: 0.5 },
    { bid: 0.8, ask: 0.7, historical: 0.5 },
    { bid: 0.6, ask: 1.2, historical: 0.5 },
    { bid: 0.6, ask: 0.7, historical: "NaN" },
  ])
    assert.equal(nativeProbabilityMove(value), null);
  assert.equal(
    nativeDeviceBody.safeParse({
      token: "ab".repeat(32),
      environment: "production",
      authorization: "authorized",
    }).success,
    true,
  );
  assert.equal(
    nativeDeviceBody.safeParse({
      token: "ab".repeat(32),
      environment: "production",
      authorization: "authorized",
      userId: "attacker",
    }).success,
    false,
  );
  assert.equal(
    nativePreferencesBody.safeParse({
      expectedRevision: 0,
      enabled: true,
      marketResolution: true,
      followedHunches: true,
      newMarkets: true,
      bigMoves: false,
    }).success,
    true,
  );
  assert.equal(
    nativePreferencesBody.safeParse({
      expectedRevision: Number.MAX_SAFE_INTEGER + 1,
      enabled: true,
      marketResolution: true,
      followedHunches: true,
      newMarkets: true,
      bigMoves: false,
    }).success,
    false,
  );
  const cursor = encodeTraderRankingCursor({
    scope: "viewer-policy",
    snapshot: "00000000-0000-4000-8000-000000000001",
    after: 20,
  });
  assert.equal(decodeTraderRankingCursor(cursor, "viewer-policy")?.after, 20);
  assert.throws(() => decodeTraderRankingCursor(cursor, "another-viewer"), {
    code: "invalid_cursor",
  });
  assert.throws(() => decodeTraderRankingCursor("malformed", "viewer-policy"), {
    code: "invalid_cursor",
  });
  let sourceUnavailable = true;
  const stages: string[] = [];
  const tasks = {
    fanout: async () => {
      stages.push("fanout");
      if (sourceUnavailable) throw new Error("source timeout");
    },
    digest: async () => {
      stages.push("digest");
    },
    big_moves: async () => {
      stages.push("big_moves");
    },
    statistics: async () => {
      stages.push("statistics");
    },
    rankings: async () => {
      stages.push("rankings");
    },
    seed: async () => {
      stages.push("seed");
    },
    retention: async () => {
      stages.push("retention");
      if (sourceUnavailable) throw new Error("cleanup timeout");
    },
    delivery: async () => {
      stages.push("delivery");
    },
  };
  assert.deepEqual(await runNativeOnboardingCycle(tasks), [
    "fanout",
    "retention",
  ]);
  assert.deepEqual(stages, [
    "fanout",
    "digest",
    "big_moves",
    "statistics",
    "rankings",
    "seed",
    "retention",
    "delivery",
  ]);
  sourceUnavailable = false;
  stages.length = 0;
  assert.deepEqual(await runNativeOnboardingCycle(tasks), []);
  assert.equal(
    stages.at(-1),
    "delivery",
    "the next cycle recovers without losing delivery",
  );
  const abort = new AbortController();
  const waits: number[] = [];
  const refreshed: number[] = [];
  const statisticsFailures: string[] = [];
  let batches = 0;
  await runSocialTraderStatisticsWorker({
    signal: abort.signal,
    seed: async () => {
      if (batches === 0) throw new Error("seed unavailable");
    },
    refresh: async (batchSize) => {
      refreshed.push(batchSize);
      batches++;
      if (batches === 4) throw new Error("database temporarily unavailable");
      return batches <= 2 ? batchSize : 1;
    },
    onFailure: (stage) => statisticsFailures.push(stage),
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      if (batches === 5) abort.abort();
    },
  });
  assert.deepEqual(
    waits,
    [25, 25, 5000, 5000, 5000],
    "a full backlog drains continuously and failures back off",
  );
  assert.deepEqual(refreshed, [50, 50, 50, 50, 50]);
  assert.deepEqual(
    statisticsFailures,
    ["seed", "statistics"],
    "seed failures do not starve refresh and the next batch recovers",
  );
  console.log(
    "native notification schema, APNs signing, ranking cursor and worker recovery: passed",
  );
} finally {
  client.close();
}
