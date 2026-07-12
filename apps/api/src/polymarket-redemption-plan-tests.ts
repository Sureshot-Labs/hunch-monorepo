#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { Interface, ethers } from "ethers";

import { buildPolymarketRedemptionPlan } from "./services/polymarket-redemption-plan.js";

const CTF = ethers.getAddress("0x4d97dcd97ec945f40cf65f87097ace5ea0476045");
const LEGACY_NEG = ethers.getAddress(
  "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296",
);
const STANDARD_ADAPTER = ethers.getAddress(
  "0xada100db00ca00073811820692005400218fce1f",
);
const NEG_ADAPTER = ethers.getAddress(
  "0xada2005600dec949baf300f4c6120000bdb6eaab",
);
const PUSD = ethers.getAddress("0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb");
const USDCE = ethers.getAddress("0x2791bca1f2de4661ed88a30c99a7a9449aa84174");
const WCOL = ethers.getAddress("0x3a3bd7bb9528e159577f7c2e685cc81a765002e2");
const FUNDER = ethers.getAddress("0x496f46aa7500563e7f577d12cb8193421f2963c7");
const CONDITION = `0x${"11".repeat(32)}` as const;
const YES_COLLECTION = `0x${"21".repeat(32)}` as const;
const NO_COLLECTION = `0x${"22".repeat(32)}` as const;

const ctf = new Interface([
  "function getCollectionId(bytes32,bytes32,uint256) view returns (bytes32)",
  "function getPositionId(address,bytes32) view returns (uint256)",
  "function getConditionId(address,bytes32,uint256) view returns (bytes32)",
  "function balanceOf(address,uint256) view returns (uint256)",
  "function payoutDenominator(bytes32) view returns (uint256)",
  "function payoutNumerators(bytes32,uint256) view returns (uint256)",
  "function redeemPositions(address,bytes32,bytes32,uint256[])",
]);
const adapter = new Interface([
  "function COLLATERAL_TOKEN() view returns (address)",
  "function USDCE() view returns (address)",
  "function CONDITIONAL_TOKENS() view returns (address)",
  "function WRAPPED_COLLATERAL() view returns (address)",
  "function NEG_RISK_ADAPTER() view returns (address)",
]);
const legacy = new Interface(["function wcol() view returns (address)"]);

type State = {
  yesBalance?: bigint;
  noBalance?: bigint;
  yesNumerator?: bigint;
  noNumerator?: bigint;
  denominator?: bigint;
  standardAdapterValid?: boolean;
  negAdapterValid?: boolean;
};

function response(id: number, result: string) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function error(id: number, message: string) {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function tokenId(collateral: string, collection: string): bigint {
  const base = ethers.getAddress(collateral) === WCOL ? 200n : 100n;
  return base + (collection === YES_COLLECTION ? 1n : 2n);
}

async function withRpc(state: State, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      id: number;
      method: string;
      params?: Array<{ to?: string; data?: string }>;
    };
    if (body.method === "eth_getCode") return response(body.id, "0x1234");
    if (body.method !== "eth_call") return error(body.id, "unexpected method");
    const call = body.params?.[0];
    const target = ethers.getAddress(String(call?.to));
    const data = String(call?.data ?? "0x");
    if (target === CTF) {
      const decoded = ctf.parseTransaction({ data });
      if (!decoded) return error(body.id, "unknown ctf call");
      switch (decoded.name) {
        case "getConditionId":
          return response(
            body.id,
            ctf.encodeFunctionResult(decoded.name, [CONDITION]),
          );
        case "getCollectionId":
          return response(
            body.id,
            ctf.encodeFunctionResult(decoded.name, [
              BigInt(decoded.args[2]) === 1n ? YES_COLLECTION : NO_COLLECTION,
            ]),
          );
        case "getPositionId":
          return response(
            body.id,
            ctf.encodeFunctionResult(decoded.name, [
              tokenId(String(decoded.args[0]), String(decoded.args[1])),
            ]),
          );
        case "balanceOf": {
          const id = BigInt(decoded.args[1]);
          return response(
            body.id,
            ctf.encodeFunctionResult(decoded.name, [
              id % 100n === 1n
                ? (state.yesBalance ?? 0n)
                : (state.noBalance ?? 0n),
            ]),
          );
        }
        case "payoutDenominator":
          return response(
            body.id,
            ctf.encodeFunctionResult(decoded.name, [state.denominator ?? 1n]),
          );
        case "payoutNumerators":
          return response(
            body.id,
            ctf.encodeFunctionResult(decoded.name, [
              BigInt(decoded.args[1]) === 0n
                ? (state.yesNumerator ?? 1n)
                : (state.noNumerator ?? 0n),
            ]),
          );
      }
    }
    if (target === LEGACY_NEG) {
      return response(body.id, legacy.encodeFunctionResult("wcol", [WCOL]));
    }
    if (target === STANDARD_ADAPTER || target === NEG_ADAPTER) {
      const isNeg = target === NEG_ADAPTER;
      if (isNeg ? !state.negAdapterValid : !state.standardAdapterValid) {
        return error(body.id, "adapter invalid");
      }
      const decoded = adapter.parseTransaction({ data });
      if (!decoded) return error(body.id, "unknown adapter call");
      const values: Record<string, string> = {
        COLLATERAL_TOKEN: PUSD,
        USDCE,
        CONDITIONAL_TOKENS: CTF,
        WRAPPED_COLLATERAL: WCOL,
        NEG_RISK_ADAPTER: LEGACY_NEG,
      };
      return response(
        body.id,
        adapter.encodeFunctionResult(decoded.name, [values[decoded.name]]),
      );
    }
    return error(body.id, `unexpected target ${target}`);
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

function inputs(negRisk: boolean) {
  return {
    rpcUrl: `mock://redeem-${Math.random()}`,
    timeoutMs: 1_000,
    funder: FUNDER,
    conditionalTokensAddress: CTF,
    collateralTokenAddress: PUSD,
    legacyCollateralTokenAddress: USDCE,
    negRiskAdapterAddress: LEGACY_NEG,
    ctfCollateralAdapterAddress: STANDARD_ADAPTER,
    negRiskCollateralAdapterAddress: NEG_ADAPTER,
    executionKind: "external_adapter" as const,
    outcome: "YES" as const,
    positionTokenId: negRisk ? "201" : "101",
    conditionId: CONDITION,
    questionId: null,
    negRiskParentConditionId: null,
    negRiskRequestId: null,
    isNegRisk: negRisk,
  };
}

async function test(name: string, run: () => Promise<void>) {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (cause) {
    console.error(`not ok - ${name}`);
    throw cause;
  }
}

await test("standard redemption uses only USDC.e positions and both index sets", () =>
  withRpc(
    { yesBalance: 700_000n, noBalance: 300_000n, standardAdapterValid: true },
    async () => {
      const plan = await buildPolymarketRedemptionPlan(inputs(false));
      assert.equal(plan.redeemable, true);
      assert.equal(plan.executionKind, "external_adapter");
      assert.equal(plan.targetAddress, STANDARD_ADAPTER);
      assert.equal(plan.yesBalanceRaw, "700000");
      assert.equal(plan.noBalanceRaw, "300000");
      assert.equal(plan.expectedPayoutRaw, "700000");
      const args = ctf.decodeFunctionData("redeemPositions", plan.data ?? "0x");
      assert.equal(ethers.getAddress(String(args[0])), USDCE);
      assert.deepEqual(Array.from(args[3] as bigint[]), [1n, 2n]);
    },
  ));

await test("fractional both-side payout matches the adapter aggregate division", () =>
  withRpc(
    {
      denominator: 2n,
      noBalance: 1n,
      noNumerator: 1n,
      standardAdapterValid: true,
      yesBalance: 1n,
      yesNumerator: 1n,
    },
    async () => {
      const plan = await buildPolymarketRedemptionPlan(inputs(false));
      assert.equal(plan.redeemable, true);
      assert.equal(plan.expectedPayoutRaw, "1");
    },
  ));

await test("neg-risk redemption uses wrapped collateral and canonical adapter", () =>
  withRpc(
    {
      yesBalance: 250_000n,
      noBalance: 900_000n,
      yesNumerator: 0n,
      noNumerator: 1n,
      negAdapterValid: true,
    },
    async () => {
      const plan = await buildPolymarketRedemptionPlan(inputs(true));
      assert.equal(plan.targetAddress, NEG_ADAPTER);
      assert.equal(plan.expectedPayoutRaw, "900000");
      const args = ctf.decodeFunctionData("redeemPositions", plan.data ?? "0x");
      assert.equal(ethers.getAddress(String(args[0])), WCOL);
    },
  ));

await test("missing canonical adapter fails closed without legacy fallback", () =>
  withRpc({ yesBalance: 1_000_000n }, async () => {
    const plan = await buildPolymarketRedemptionPlan(inputs(false));
    assert.equal(plan.redeemable, false);
    assert.equal(plan.reason, "preflight_unavailable");
  }));

await test("resolved zero payout is not offered", () =>
  withRpc(
    {
      yesBalance: 1_000_000n,
      yesNumerator: 0n,
      noNumerator: 1n,
      standardAdapterValid: true,
    },
    async () => {
      const plan = await buildPolymarketRedemptionPlan(inputs(false));
      assert.equal(plan.redeemable, false);
      assert.equal(plan.reason, "resolved_zero_payout");
    },
  ));
