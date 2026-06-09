import assert from "node:assert/strict";

import { adminRewardsMultiplierPolicySchema } from "./schemas/admin.js";

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
