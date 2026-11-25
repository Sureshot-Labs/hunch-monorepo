import assert from "node:assert/strict";
import test from "node:test";

import { assertLimitlessTradeFundingFeeAllowance } from "./funding/planner/limitless-fee-preflight.js";
import type { FundingCommitPlan } from "./funding/persistence/funding-operation-repository.js";
import { limitlessMarketExchangeResponseSchema } from "./schemas/limitless-private.js";
import { fundingApiErrorResponseSchema } from "./schemas/funding.js";
import {
  classifyFrozenLimitlessFokResult,
  parseLimitlessOrderResult,
} from "./services/limitless-order-result.js";
import {
  classifyLimitlessOrderRejection,
  parseLimitlessOrderRejection,
} from "./services/limitless-order-rejection.js";
import {
  assertLimitlessMarketPayloadSlug,
  assertLimitlessExchangeAllowance,
  assertLimitlessFeeModuleAllowance,
  assertLimitlessSigningFee,
  LimitlessClobFeeError,
  readLimitlessClobFeePolicy,
} from "./services/limitless-clob-fees.js";

const usdc = "0x0000000000000000000000000000000000000011";
const feeModule = "0x0000000000000000000000000000000000000022";
const exchange = "0x0000000000000000000000000000000000000033";
const owner = "0x0000000000000000000000000000000000000044";
const collateralMarket = {
  venue: { exchange, feeModuleType: "COLLATERAL", feeModule },
  collateralToken: { address: usdc },
};
const collateral = readLimitlessClobFeePolicy(collateralMarket, usdc, 300);
const legacy = readLimitlessClobFeePolicy({ venue: { exchange } }, usdc, 300);
const hasCode = (code: string) => (error: unknown) =>
  error instanceof LimitlessClobFeeError && error.code === code;

test("fee facts cannot come from an empty or different market response", () => {
  assert.doesNotThrow(() =>
    assertLimitlessMarketPayloadSlug(
      {
        market: { ...collateralMarket, slug: "requested" },
      },
      "requested",
    ),
  );
  for (const payload of [
    collateralMarket,
    { ...collateralMarket, slug: "other" },
  ]) {
    assert.throws(
      () => assertLimitlessMarketPayloadSlug(payload, "requested"),
      hasCode("limitless_fee_policy_unavailable"),
    );
  }
});

test("venue-confirmed fee-module rejection is actionable without authorizing a replay", () => {
  const decision = classifyLimitlessOrderRejection({
    orderType: "FOK",
    evidence: parseLimitlessOrderRejection({
      status: 400,
      payload: {
        message: "Insufficient collateral allowance for the order fee.",
      },
    }),
  });
  assert.equal(
    decision.errorCode,
    "limitless_fee_module_allowance_insufficient",
  );
  assert.equal(decision.disposition, "definitive_failure");
  assert.equal(decision.mayRetrySubmission, false);
  for (const status of [409, 429, 502]) {
    const transient = classifyLimitlessOrderRejection({
      orderType: "FOK",
      evidence: parseLimitlessOrderRejection({
        status,
        payload: {
          message: "Insufficient collateral allowance for the order fee.",
        },
      }),
    });
    assert.equal(transient.disposition, "ambiguous");
    assert.equal(transient.releaseFundingReservation, false);
  }
});

test("COLLATERAL overrides the profile rate; legacy keeps its rate including zero", () => {
  assert.deepEqual(collateral, {
    mode: "collateral",
    signingFeeRateBps: 0,
    feeModule,
    collateralToken: usdc,
  });
  assert.doesNotThrow(() => assertLimitlessSigningFee(collateral, 0));
  assert.throws(
    () => assertLimitlessSigningFee(collateral, 300),
    hasCode("limitless_fee_rate_mismatch"),
  );
  assert.equal(legacy.signingFeeRateBps, 300);
  assert.doesNotThrow(() => assertLimitlessSigningFee(legacy, 300));
  assert.throws(
    () => assertLimitlessSigningFee(legacy, 0),
    hasCode("limitless_fee_rate_mismatch"),
  );
  assert.equal(
    readLimitlessClobFeePolicy({ venue: { exchange } }, usdc, 0)
      .signingFeeRateBps,
    0,
  );
  assert.equal(
    readLimitlessClobFeePolicy({ venue: { exchange } }, usdc).signingFeeRateBps,
    null,
  );
});

test("explicit unknown/malformed module metadata never becomes legacy", () => {
  for (const payload of [
    {},
    { exchangeAddress: exchange },
    { exchangeAddress: exchange, venue: {} },
    { exchangeAddress: exchange, venue: "bad" },
    { ...collateralMarket, exchangeAddress: owner },
    { venue: { exchange, feeModuleType: "UNKNOWN", feeModule } },
    { venue: { exchange, feeModule } },
    { venue: { exchange, feeModuleType: "COLLATERAL" } },
    { ...collateralMarket, collateralToken: { address: exchange } },
    { venue: { ...collateralMarket.venue, feeModule: "0x" + "0".repeat(40) } },
    null,
  ]) {
    assert.throws(
      () => readLimitlessClobFeePolicy(payload, usdc),
      hasCode("limitless_fee_policy_unavailable"),
    );
  }
});

test("allowance reads exact USDC, wallet and fee module; legacy and post-only skip RPC", async () => {
  let calls = 0;
  const readAllowance = async (input: {
    tokenAddress: string;
    owner: string;
    spender: string;
  }) => {
    calls += 1;
    assert.deepEqual(input, { tokenAddress: usdc, owner, spender: feeModule });
    return 0n;
  };
  await assertLimitlessFeeModuleAllowance({
    policy: legacy,
    owner,
    readAllowance,
  });
  await assertLimitlessFeeModuleAllowance({
    policy: collateral,
    owner,
    postOnly: true,
    readAllowance,
  });
  assert.equal(calls, 0);
  await assert.rejects(
    assertLimitlessFeeModuleAllowance({
      policy: collateral,
      owner,
      readAllowance,
    }),
    hasCode("limitless_fee_module_approval_required"),
  );
  assert.equal(calls, 1);
  await assertLimitlessFeeModuleAllowance({
    policy: collateral,
    owner,
    readAllowance: async () => 1n,
  });
  await assert.rejects(
    assertLimitlessFeeModuleAllowance({
      policy: collateral,
      owner,
      readAllowance: async () => {
        throw new Error("private RPC failure");
      },
    }),
    (error: unknown) =>
      error instanceof LimitlessClobFeeError &&
      error.responseStatus === 503 &&
      error.code === "limitless_fee_module_allowance_unavailable" &&
      !error.message.includes("private"),
  );
});

test("funding checks the exact market and sealed destination wallet, not the source wallet", async () => {
  const operation = {
    purpose: "trade_shortfall",
    venueId: "limitless",
    marketId: "market-key",
    destinationTargetSnapshot: {
      kind: "owned_location",
      location: {
        kind: "venue_account",
        asset: { networkId: "evm:8453", assetId: usdc, decimals: 6 },
        details: { venueId: "limitless", accountRef: owner, address: owner },
      },
    },
  } as unknown as FundingCommitPlan["operation"];
  let verifies = 0;
  let exchangeChecks = 0;
  let remaining = 800_000n;
  const dependencies = {
    loadMarket: async (id: string) => {
      assert.equal(id, "market-key");
      return { slug: "exact-market", venue: "limitless", metadata: null };
    },
    loadFeePolicy: async (slug: string) => {
      assert.equal(slug, "exact-market");
      return { policy: collateral, exchangeAddress: exchange };
    },
    verifyAllowance: async (policy: typeof collateral, wallet: string) => {
      verifies += 1;
      assert.equal(policy, collateral);
      assert.equal(wallet, owner);
    },
    verifyExchangeAllowance: async (
      input: Omit<
        Parameters<typeof assertLimitlessExchangeAllowance>[0],
        "readAllowance"
      >,
    ) => {
      await assertLimitlessExchangeAllowance({
        ...input,
        readAllowance: async ({ spender, owner: wallet, tokenAddress }) => {
          exchangeChecks++;
          assert.equal(wallet, owner);
          assert.equal(spender, exchange);
          assert.equal(tokenAddress, usdc);
          assert.equal(input.principal, 1_000_000n);
          return remaining;
        },
      });
    },
  };
  await assertLimitlessTradeFundingFeeAllowance(operation, dependencies);
  await assertLimitlessTradeFundingFeeAllowance(
    { ...operation, supportMetadata: { limitlessFundingOrderType: "GTC" } },
    {
      ...dependencies,
      loadMarket: async () => {
        throw new Error("GTC must not require the FOK allowance");
      },
    },
  );
  await assertLimitlessTradeFundingFeeAllowance(
    { ...operation, venueId: "polymarket" },
    dependencies,
  );
  await assertLimitlessTradeFundingFeeAllowance(operation, {
    ...dependencies,
    loadFeePolicy: async () => ({ policy: legacy, exchangeAddress: exchange }),
  });
  await assertLimitlessTradeFundingFeeAllowance(operation, {
    ...dependencies,
    loadMarket: async () => ({
      venue: "limitless",
      slug: "another",
      metadata: { tradeType: "amm" },
    }),
  });
  await assert.rejects(
    assertLimitlessTradeFundingFeeAllowance(
      { ...operation, destinationTargetSnapshot: {} },
      dependencies,
    ),
    hasCode("limitless_fee_policy_unavailable"),
  );
  assert.equal(verifies, 1);
  assert.equal(
    exchangeChecks,
    0,
    "old funding operations retain their original contract",
  );
  const scoped = {
    ...operation,
    requestedDestinationAmount: { raw: "704482" },
    supportMetadata: { limitlessClobBuyPrincipalRaw: "1000000" },
  };
  await assert.rejects(
    assertLimitlessTradeFundingFeeAllowance(scoped, dependencies),
    hasCode("limitless_trade_validation_rejected"),
  );
  remaining = 1_000_000n;
  await assertLimitlessTradeFundingFeeAllowance(scoped, dependencies);
  assert.equal(exchangeChecks, 2);
  assert.equal(verifies, 2);
});

test("open or contradictory FOK evidence does not release a reserve", () => {
  const classify = (status: string, execution: Record<string, unknown>) =>
    classifyFrozenLimitlessFokResult(
      parseLimitlessOrderResult({
        order: { id: "retained-locator", status },
        execution,
      }),
    );
  assert.equal(
    classify("submitted", { matched: false, settlementStatus: "DELAYED" }),
    "pending",
  );
  assert.equal(
    classify("UNMATCHED", { matched: false, settlementStatus: "DELAYED" }),
    "pending",
  );
  assert.equal(
    classify("FAILED", { matched: true, settlementStatus: "DELAYED" }),
    "pending",
  );
  assert.equal(
    classify("FAILED", { matched: true, settlementStatus: "MINED" }),
    "pending",
  );
  assert.equal(
    classify("FAILED", {
      status: "MATCHED",
      totalsRaw: { contractsGross: "2000000", usdGross: "1000000" },
    }),
    "pending",
  );
  assert.equal(classify("FILLED", { status: "UNMATCHED" }), "pending");
  assert.equal(classify("FILLED", { status: "PENDING" }), "pending");
  assert.equal(classify("MATCHED", { status: "SUBMITTED" }), "pending");
  assert.equal(
    classify("REJECTED", { matched: false, settlementStatus: "PENDING" }),
    "pending",
  );
  assert.equal(classify("SUBMITTED", { status: "FAILED" }), "pending");
  for (const [status, orderMatched, executionMatched] of [
    ["REJECTED", true, false],
    ["FILLED", false, true],
  ]) {
    assert.equal(
      classifyFrozenLimitlessFokResult(
        parseLimitlessOrderResult({
          order: { status, matched: orderMatched },
          execution: { matched: executionMatched },
        }),
      ),
      "pending",
    );
  }
  for (const status of ["FAILED", "UNMATCHED"]) {
    assert.equal(
      classifyFrozenLimitlessFokResult(
        parseLimitlessOrderResult({
          order: { status, id: "retained-locator" },
          makerMatches: [{ matchedSize: "4000000" }],
        }),
      ),
      "pending",
      "positive match accounting contradicts a terminal rejection even without a tx hash",
    );
  }
  assert.equal(
    classify("FAILED", { txHash: `0x${"a".repeat(64)}` }),
    "pending",
  );
  assert.equal(
    classify("UNMATCHED", { matched: false, settlementStatus: "UNMATCHED" }),
    "rejected",
  );
  assert.equal(
    classify("filled", { matched: true, settlementStatus: "MINED" }),
    "settled",
  );
});

test("transient collateral FOK allowance responses cannot release funding", () => {
  for (const status of [408, 409, 425, 429, 503]) {
    const result = classifyLimitlessOrderRejection({
      evidence: parseLimitlessOrderRejection({
        status,
        payload: { message: "insufficient allowance" },
      }),
      orderType: "FOK",
      frozenCollateralFok: true,
    });
    assert.equal(result.disposition, "ambiguous");
    assert.equal(result.releaseFundingReservation, false);
  }
  const exact = classifyLimitlessOrderRejection({
    evidence: parseLimitlessOrderRejection({
      status: 400,
      payload: { message: "insufficient allowance" },
    }),
    orderType: "FOK",
    frozenCollateralFok: true,
  });
  assert.equal(exact.disposition, "definitive_failure");
});

test("FOK rejections retain exact transaction locators in alternate envelopes", () => {
  const hash = `0x${"a".repeat(64)}`;
  const order = { id: "retained-locator", status: "UNMATCHED" };
  for (const payload of [
    { order, transactionHash: hash },
    { order: { ...order, txHash: hash } },
    { data: { order, tx_hash: hash } },
    {
      data: {
        order: { order, execution: { txHash: "malformed" }, txHash: hash },
      },
    },
  ]) {
    const parsed = parseLimitlessOrderResult(payload);
    assert.equal(parsed.txHash, hash);
    assert.equal(classifyFrozenLimitlessFokResult(parsed), "pending");
  }
  const nonOk = parseLimitlessOrderResult({
    error: "Insufficient collateral allowance for the order fee.",
    transactionHash: hash,
  });
  assert.equal(nonOk.txHash, hash);
  assert.equal(
    parseLimitlessOrderResult({ order, txHash: "malformed" }).txHash,
    null,
  );
});

test("fee policy survives market and funding response serialization", () => {
  assert.deepEqual(
    limitlessMarketExchangeResponseSchema.parse({
      ok: true,
      marketSlug: "market",
      exchangeAddress: exchange,
      adapterAddress: null,
      feePolicy: collateral,
    }).feePolicy,
    collateral,
  );
  const error = new LimitlessClobFeeError(
    "limitless_fee_module_approval_required",
    "Approve Base USDC.",
    409,
    collateral,
  );
  assert.deepEqual(
    fundingApiErrorResponseSchema.parse({
      error: error.message,
      code: error.code,
    }),
    { error: error.message, code: error.code },
  );
});
