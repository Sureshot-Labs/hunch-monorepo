#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { resolvePersistedSignalEvidence } from "./services/legacy-signal-evidence.js";

const createdAt = "2026-07-16T00:00:00.000Z";

assert.deepEqual(
  resolvePersistedSignalEvidence({
    createdAt,
    holderCredentialBullets: ["Up $12K over the last 30 days"],
    metrics: { signalEvidence: [], signalEvidenceVersion: 1 },
  }),
  [],
  "a versioned empty typed snapshot must not fall back to legacy prose",
);

const legacy = resolvePersistedSignalEvidence({
  createdAt,
  holderCredentialBullets: ["Up $12K over the last 30 days"],
  metrics: {},
});
assert.equal(legacy.length, 1);
assert.equal(legacy[0]?.id, "legacy:track_record:0");
assert.deepEqual(legacy[0]?.measurement, {
  kind: "scalar",
  value: 12_000,
  unit: "usd",
});

console.log("[signal-evidence-tests] passed 2/2");
