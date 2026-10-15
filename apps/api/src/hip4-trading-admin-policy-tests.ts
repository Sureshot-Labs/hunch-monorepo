import assert from "node:assert/strict";
import { adminIntelPolicyParamsSchema } from "./schemas/admin.js";
import {
  getIntelPolicyDefaults,
  getIntelPolicySchema,
  resolveIntelPolicy,
} from "./services/runtime-policies.js";
import { DEFAULT_HIP4_TRADING_POLICY } from "./services/hip4-trading-policy.js";

assert.equal(
  adminIntelPolicyParamsSchema.safeParse({ key: "hip4_trading" }).success,
  true,
);
assert.deepEqual(
  getIntelPolicyDefaults("hip4_trading"),
  DEFAULT_HIP4_TRADING_POLICY,
);
assert.deepEqual(
  getIntelPolicySchema("hip4_trading").parse({ minimumBuyNotionalUsd: "5" }),
  { ...DEFAULT_HIP4_TRADING_POLICY, minimumBuyNotionalUsd: "5" },
);
assert.equal(
  getIntelPolicySchema("hip4_trading").safeParse({ enabled: true }).success,
  false,
);
for (const [payload, invalid] of [
  [{ minimumBuyNotionalUsd: "5" }, false],
  [{ minimumBuyNotionalUsd: "0" }, true],
] as const) {
  const db = {
    query: async () => ({
      rows: [
        {
          id: "test",
          policy_key: "hip4_trading",
          effective_at: new Date(),
          created_at: new Date(),
          payload,
        },
      ],
    }),
  } as unknown as Parameters<typeof resolveIntelPolicy>[0];
  const result = await resolveIntelPolicy(db, "hip4_trading");
  assert.equal(result.invalidOverride, invalid);
  assert.equal(result.effective.minimumBuyNotionalUsd, invalid ? "1.00" : "5");
}
console.log(
  "HIP trading policy uses the common admin DTO/editor with explicit invalid-override diagnostics",
);
