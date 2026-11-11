import assert from "node:assert/strict";
import { verifiedBuyRetrySeconds } from "./services/verified-buy-retry.js";
async function test(name: string, run: () => void | Promise<void>) {
  await run();
  console.log(`ok - ${name}`);
}

for (const reason of [
  "provider_settlement_pending",
  "fill_transaction_identity_missing",
])
  for (const attempts of [1, 2, 3, 4, 20, 55_577])
    await test(`Prompt settlement ${reason}, attempt ${attempts}`, () => {
      assert.equal(
        verifiedBuyRetrySeconds({
          state: "pending",
          reason,
          attempts,
          retrySeconds: 30,
          verifiedRecheckSeconds: 3600,
        }),
        attempts <= 3
          ? 5
          : Math.min(
              3600,
              30 * 2 ** Math.min(12, Math.floor((attempts - 4) / 4)),
            ),
      );
    });
for (const reason of [
  "receipt_pending",
  "observation_unavailable",
  "provider_evidence_unavailable",
  "provider_evidence_not_found",
  "evidence_budget_exhausted:2:1",
  "amm_contract_missing",
])
  await test(`${reason} retains bounded technical retry`, () => {
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
for (const reason of [
  "finalized_receipt_failed",
  "receipt_exact_fill_unavailable",
  "amm_exact_fill_unavailable",
])
  await test(`${reason} uses canonicality recheck, not provider rediscovery cadence`, () => {
    assert.equal(
      verifiedBuyRetrySeconds({
        state: reason === "finalized_receipt_failed" ? "revoked" : "pending",
        reason,
        attempts: 1,
        retrySeconds: 30,
        verifiedRecheckSeconds: 3600,
      }),
      3600,
    );
  });
await test("Verified and provider-only revoked purchases retain their policies", () => {
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
      reason: "provider_fill_failed",
      attempts: 1,
      retrySeconds: 30,
      verifiedRecheckSeconds: 3600,
    }),
    30,
  );
});
await test("resumable locator progress is not slowed by legacy attempt count", () => {
  assert.equal(
    verifiedBuyRetrySeconds({
      state: "pending",
      reason: "receipt_locator_search_pending",
      attempts: 5000,
      retrySeconds: 30,
      verifiedRecheckSeconds: 3600,
    }),
    30,
  );
});
