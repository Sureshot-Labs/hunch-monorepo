import assert from "node:assert/strict";

import { fundingSidecarRuntimeConfig } from "../../runtime/sidecar-runtime-config.js";
import { inspectLimitlessFeeApproval } from "../../preparation/limitless-fee-approval.js";
import {
  fundingPreparationInspectRequestSchema,
  fundingPreparationPrepareRequestSchema,
} from "../../../schemas/funding.js";

const exchange = "0x0000000000000000000000000000000000000011";
const spender = "0x0000000000000000000000000000000000000012";
const owner = "0x0000000000000000000000000000000000000013";
const marketSlug = "btc-up-down";
const collateralToken = fundingSidecarRuntimeConfig.limitlessUsdcAddress;
const request = {
  marketSlug,
  exchangeAddress: exchange,
  owner,
  principalRaw: "1000000",
};
const market = {
  slug: marketSlug,
  venue: { exchange, feeModule: spender, feeModuleType: "COLLATERAL" },
  collateralToken,
};

assert.deepEqual(
  await inspectLimitlessFeeApproval(request, {
    loadMarket: async (slug) => {
      assert.equal(slug, marketSlug);
      return market;
    },
    loadAllowance: async (input) => {
      assert.deepEqual(input, {
        tokenAddress: collateralToken,
        owner,
        spender,
      });
      return 0n;
    },
  }),
  {
    state: "required",
    approval: {
      marketSlug,
      token: collateralToken,
      spender,
      amountRaw: "1000000",
    },
  },
);
assert.deepEqual(
  await inspectLimitlessFeeApproval(request, {
    loadMarket: async () => market,
    loadAllowance: async () => 1n,
  }),
  { state: "ready" },
);
assert.deepEqual(
  await inspectLimitlessFeeApproval(request, {
    loadMarket: async () => market,
    loadAllowance: async () => {
      throw new Error("RPC unavailable");
    },
  }),
  { state: "unavailable" },
);
let mismatchedReads = 0;
const observeNoAllowance = async () => {
  mismatchedReads += 1;
  return 0n;
};
for (const payload of [
  { ...market, slug: "wrong-market" },
  { ...market, venue: { ...market.venue, exchange: owner } },
  { ...market, collateralToken: spender },
  { ...market, venue: { ...market.venue, feeModule: exchange } },
]) {
  assert.deepEqual(
    await inspectLimitlessFeeApproval(request, {
      loadMarket: async () => payload,
      loadAllowance: observeNoAllowance,
    }),
    { state: "unavailable" },
  );
}
assert.deepEqual(
  await inspectLimitlessFeeApproval(request, {
    loadMarket: async () => ({ ...market, venue: { exchange } }),
    loadAllowance: observeNoAllowance,
  }),
  { state: "not_required" },
);
assert.equal(mismatchedReads, 0);

const wire = {
  venueBindingOptionId: "binding_test",
  purpose: "buy",
  marketContextId: "limitless:123",
  marketClass: "clob",
  limitlessMarketBuyRaw: "1000000",
};
assert.equal(
  fundingPreparationInspectRequestSchema.parse(wire).limitlessMarketBuyRaw,
  "1000000",
);
for (const raw of ["0", "-1", "1.5", "9007199254740992"]) {
  assert.equal(
    fundingPreparationInspectRequestSchema.safeParse({
      ...wire,
      limitlessMarketBuyRaw: raw,
    }).success,
    false,
  );
}
const prepare = { ...wire, expectedInspectionRevision: "inspection_test" };
assert.equal(
  fundingPreparationPrepareRequestSchema.safeParse(prepare).success,
  false,
);
assert.equal(
  fundingPreparationPrepareRequestSchema.safeParse({
    ...prepare,
    admissionProtocolVersion: 1,
  }).success,
  true,
);

console.log(
  "[limitless-fee-preparation-tests] verified canonical policy and bounded approval",
);
