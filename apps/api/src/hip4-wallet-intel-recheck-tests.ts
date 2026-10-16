import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hip4TrackedActivityFlowProof,
  planHip4TrackedActivityBatch,
} from "./services/hip4-wallet-intel-recheck.js";
import {
  hip4TrackedFillFingerprint,
  hip4WalletIntelIdentity,
  normalizeHip4KnownWalletFill,
} from "./services/hip4-wallet-intel.js";

const parsed = normalizeHip4KnownWalletFill({
  identity: hip4WalletIntelIdentity("mainnet", `0x${"1".repeat(40)}`),
  observedAt: "2026-10-16T12:00:00.000Z",
  value: {
    coin: "#410",
    px: "0.125",
    sz: "8",
    side: "B",
    time: Date.parse("2026-10-16T11:59:59.000Z"),
    startPosition: "0",
    dir: "Buy",
    closedPnl: "0",
    hash: `0x${"1".repeat(64)}`,
    oid: 100,
    crossed: true,
    fee: "0",
    tid: 200,
    feeToken: "USDC",
  },
});
if (parsed.kind !== "trade") throw new Error("synthetic native fill missing");
const activity = parsed.activity;
const fingerprint = hip4TrackedFillFingerprint(activity);
const verified = () => ({
  version: 1,
  provenance: "fresh_official_user_fills",
  state: "verified",
  sourceEventKey: activity.sourceEventKey,
  retainedFingerprint: fingerprint,
  lastObservedFingerprint: fingerprint,
  observationId: "synthetic-real-fetch-b",
  observationStartedAtMs: 2000,
  checkedAtMs: 3000,
  conflictObservationId: "synthetic-real-fetch-a",
  conflictAtMs: 1000,
});
const proof = (nativeRecheck?: Record<string, unknown>) =>
  hip4TrackedActivityFlowProof({
    metadata: {
      nativeFingerprint: fingerprint,
      ...(nativeRecheck ? { nativeRecheck } : {}),
    },
    sourceEventKey: activity.sourceEventKey,
  });

test("bounded merged observations keep exact key conflicts sticky regardless of matching replay order", () => {
  const other = { ...activity, sourceEventKey: "unrelated-key" };
  const changed = { ...activity, price: "0.25" };
  for (const rows of [
    [activity, changed, activity, other],
    [changed, activity, changed, other],
  ]) {
    const planned = planHip4TrackedActivityBatch(rows);
    assert.equal(planned.length, 2);
    assert(planned[0].conflictingFingerprint);
    assert.equal(planned[1].conflictingFingerprint, null);
  }
  assert.equal(
    planHip4TrackedActivityBatch([activity, activity])[0]
      .conflictingFingerprint,
    null,
  );
  assert.deepEqual(planHip4TrackedActivityBatch([]), []);
});

test("event flow requires exact fresh proof; legacy, malformed, other-key, disputed and stale observations cannot clear it", () => {
  assert.equal(proof(), "legacy_ambiguous");
  assert.equal(proof(verified()), "eligible");
  assert.equal(proof({ ...verified(), state: "disputed" }), "disputed");
  for (const patch of [
    { sourceEventKey: "unrelated-key" },
    { retainedFingerprint: "0".repeat(64) },
    { lastObservedFingerprint: "0".repeat(64) },
    { provenance: "local_cached_replay" },
    { observationStartedAtMs: 1000 },
    { observationId: "synthetic-real-fetch-a" },
    { checkedAtMs: "3000" },
  ])
    assert.equal(proof({ ...verified(), ...patch }), "invalid_proof");
});
