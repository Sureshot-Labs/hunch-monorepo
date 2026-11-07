import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedBuyRetrySeconds } from "./services/verified-buy-retry.js";

for (const attempts of [1, 2, 3, 4, 20]) {
  await test(`Fresh settlement retry at attempt ${attempts} is bounded`, () => {
    assert.equal(
      verifiedBuyRetrySeconds({
        state: "pending",
        reason: "provider_settlement_pending",
        attempts,
        retrySeconds: 30,
        verifiedRecheckSeconds: 3600,
      }),
      attempts <= 3 ? 5 : 30,
    );
  });
}
for (const reason of [
  "receipt_pending",
  "observation_unavailable",
  "evidence_budget_exhausted:2:1",
]) {
  await test(`${reason} keeps its original backoff`, () => {
    assert.equal(
      verifiedBuyRetrySeconds({
        state: "pending",
        reason,
        attempts: 1,
        retrySeconds: 30,
        verifiedRecheckSeconds: 3600,
      }),
      30,
    );
  });
}
await test("Verified and revoked purchases keep the configured policies", () => {
  assert.equal(
    verifiedBuyRetrySeconds({
      state: "verified",
      reason: null,
      attempts: 1,
      retrySeconds: 30,
      verifiedRecheckSeconds: 3600,
    }),
    3600,
  );
  assert.equal(
    verifiedBuyRetrySeconds({
      state: "revoked",
      reason: "failed",
      attempts: 1,
      retrySeconds: 30,
      verifiedRecheckSeconds: 3600,
    }),
    30,
  );
});
