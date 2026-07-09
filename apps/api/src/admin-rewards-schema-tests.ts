import assert from "node:assert/strict";

import {
  adminRewardsBulkAdjustmentExecuteSchema,
  adminRewardsBulkAdjustmentPreviewSchema,
  adminRewardsMultiplierPolicySchema,
} from "./schemas/admin.js";

async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  console.log(`[admin-rewards-schema-tests] ok ${name}`);
}

await test("multiplier policy accepts nullable notes for clearing notes", () => {
  const parsed = adminRewardsMultiplierPolicySchema.parse({
    globalMultiplier: 1.1,
    globalMultiplierLabel: "Promo",
    referralRules: [],
    tierRules: [],
    notes: null,
  });

  assert.equal(parsed.notes, null);
});

await test("multiplier policy still rejects invalid notes types", () => {
  const parsed = adminRewardsMultiplierPolicySchema.safeParse({
    globalMultiplier: 1.1,
    referralRules: [],
    tierRules: [],
    notes: 123,
  });

  assert.equal(parsed.success, false);
});

await test("bulk adjustment schema accepts fixed grant", () => {
  const parsed = adminRewardsBulkAdjustmentPreviewSchema.parse({
    amount: 1000,
    cohort: {
      createdBefore: "2026-07-09T00:00:00.000Z",
    },
    mode: "fixed_amount",
    runKey: "fixed-grant-test",
    visibility: "hidden",
  });

  assert.equal(parsed.cohort.activeOnly, true);
  assert.equal(parsed.cohort.excludeAdmins, true);
  assert.equal(parsed.cohort.requireWallet, false);
});

await test("bulk adjustment schema accepts arbitrary tier-point top-up", () => {
  const parsed = adminRewardsBulkAdjustmentPreviewSchema.parse({
    cohort: {
      createdBefore: "2026-07-09T00:00:00.000Z",
    },
    mode: "top_up_to_points",
    runKey: "top-up-points-test",
    targetBasis: "tier_points",
    targetPoints: 350000,
    visibility: "hidden",
  });

  assert.equal(parsed.targetBasis, "tier_points");
});

await test("bulk adjustment schema accepts policy tier top-up", () => {
  const parsed = adminRewardsBulkAdjustmentPreviewSchema.parse({
    cohort: {
      createdBefore: "2026-07-09T00:00:00.000Z",
    },
    mode: "top_up_to_tier",
    runKey: "top-up-tier-test",
    targetTier: 5,
    visibility: "hidden",
  });

  assert.equal(parsed.targetTier, 5);
});

await test("bulk adjustment schema rejects hidden public-point top-up", () => {
  const parsed = adminRewardsBulkAdjustmentPreviewSchema.safeParse({
    cohort: {
      createdBefore: "2026-07-09T00:00:00.000Z",
    },
    mode: "top_up_to_points",
    runKey: "hidden-public-test",
    targetBasis: "public_points",
    targetPoints: 1000,
    visibility: "hidden",
  });

  assert.equal(parsed.success, false);
});

await test("bulk adjustment schema rejects missing and invalid run keys", () => {
  assert.equal(
    adminRewardsBulkAdjustmentPreviewSchema.safeParse({
      amount: 1000,
      cohort: {
        createdBefore: "2026-07-09T00:00:00.000Z",
      },
      mode: "fixed_amount",
      visibility: "hidden",
    }).success,
    false,
  );
  assert.equal(
    adminRewardsBulkAdjustmentPreviewSchema.safeParse({
      amount: 1000,
      cohort: {
        createdBefore: "2026-07-09T00:00:00.000Z",
      },
      mode: "fixed_amount",
      runKey: "Bad Key",
      visibility: "hidden",
    }).success,
    false,
  );
});

await test("bulk adjustment execute schema requires confirmation phrase", () => {
  assert.equal(
    adminRewardsBulkAdjustmentExecuteSchema.safeParse({
      amount: 1000,
      cohort: {
        createdBefore: "2026-07-09T00:00:00.000Z",
      },
      confirm: "EXECUTE BULK ADJUSTMENT",
      mode: "fixed_amount",
      runKey: "execute-test",
      visibility: "hidden",
    }).success,
    true,
  );
  assert.equal(
    adminRewardsBulkAdjustmentExecuteSchema.safeParse({
      amount: 1000,
      cohort: {
        createdBefore: "2026-07-09T00:00:00.000Z",
      },
      confirm: "yes",
      mode: "fixed_amount",
      runKey: "execute-test",
      visibility: "hidden",
    }).success,
    false,
  );
});
