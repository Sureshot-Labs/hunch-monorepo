#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { Interface, ethers } from "ethers";

import { buildPolymarketRedemptionPlan } from "./services/polymarket-redemption-plan.js";

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const CTF = ethers.getAddress("0x4d97dcd97ec945f40cf65f87097ace5ea0476045");
const ADAPTER = ethers.getAddress("0xd91e80cf2e7be2e162c6513ced06f1dd0da35296");
const CTF_COLLATERAL_ADAPTER = ethers.getAddress(
  "0xada100db00ca00073811820692005400218fce1f",
);
const NEG_RISK_COLLATERAL_ADAPTER = ethers.getAddress(
  "0xada2005600dec949baf300f4c6120000bdb6eaab",
);
const PUSD = ethers.getAddress("0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb");
const USDCE = ethers.getAddress("0x2791bca1f2de4661ed88a30c99a7a9449aa84174");
const WCOL = ethers.getAddress("0x3a3bd7bb9528e159577f7c2e685cc81a765002e2");
const FUNDER = ethers.getAddress("0x496f46aa7500563e7f577d12cb8193421f2963c7");
const CONDITION_ID = `0x${"11".repeat(32)}` as const;
const COLLECTION_ID = `0x${"22".repeat(32)}` as const;

const ctfIface = new Interface([
  "function redeemPositions(address collateralToken,bytes32 parentCollectionId,bytes32 conditionId,uint256[] indexSets)",
  "function getCollectionId(bytes32 parentCollectionId,bytes32 conditionId,uint256 indexSet) view returns (bytes32)",
  "function getPositionId(address collateralToken,bytes32 collectionId) view returns (uint256)",
  "function getConditionId(address oracle,bytes32 questionId,uint256 outcomeSlotCount) view returns (bytes32)",
  "function balanceOf(address account,uint256 id) view returns (uint256)",
  "function payoutDenominator(bytes32 conditionId) view returns (uint256)",
  "function payoutNumerators(bytes32 conditionId,uint256 index) view returns (uint256)",
]);

const adapterIface = new Interface([
  "function redeemPositions(bytes32 conditionId,uint256[] amounts)",
  "function col() view returns (address)",
  "function wcol() view returns (address)",
]);

const ctfCollateralAdapterIface = new Interface([
  "function COLLATERAL_TOKEN() view returns (address)",
  "function USDCE() view returns (address)",
  "function CONDITIONAL_TOKENS() view returns (address)",
]);

const negRiskCollateralAdapterIface = new Interface([
  "function COLLATERAL_TOKEN() view returns (address)",
  "function USDCE() view returns (address)",
  "function WRAPPED_COLLATERAL() view returns (address)",
  "function NEG_RISK_ADAPTER() view returns (address)",
  "function CONDITIONAL_TOKENS() view returns (address)",
]);

type MockRpcState = {
  pUsdBalance?: bigint;
  usdceBalance?: bigint;
  wcolBalance?: bigint;
  adapterCol?: string | "error";
  ctfCollateralAdapterValid?: boolean;
  negRiskCollateralAdapterValid?: boolean;
  outcome?: "YES" | "NO";
};

function rpcResponse(id: number, result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function rpcError(id: number, message: string) {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

function positionIdForCollateral(collateral: string): bigint {
  const normalized = ethers.getAddress(collateral);
  if (normalized === PUSD) return 101n;
  if (normalized === USDCE) return 102n;
  if (normalized === WCOL) return 200n;
  return 0n;
}

function ctfCallResult(data: string, state: MockRpcState): string {
  const decoded = ctfIface.parseTransaction({ data });
  if (!decoded) throw new Error("Unknown CTF call");

  switch (decoded.name) {
    case "payoutDenominator":
      return ctfIface.encodeFunctionResult("payoutDenominator", [1n]);
    case "payoutNumerators": {
      const index = BigInt(String(decoded.args[1]));
      const outcome = state.outcome ?? "YES";
      const winningIndex = outcome === "YES" ? 0n : 1n;
      return ctfIface.encodeFunctionResult("payoutNumerators", [
        index === winningIndex ? 1n : 0n,
      ]);
    }
    case "getConditionId":
      return ctfIface.encodeFunctionResult("getConditionId", [CONDITION_ID]);
    case "getCollectionId":
      return ctfIface.encodeFunctionResult("getCollectionId", [COLLECTION_ID]);
    case "getPositionId": {
      const collateral = String(decoded.args[0]);
      return ctfIface.encodeFunctionResult("getPositionId", [
        positionIdForCollateral(collateral),
      ]);
    }
    case "balanceOf": {
      const id = BigInt(String(decoded.args[1]));
      const balance =
        id === 101n
          ? (state.pUsdBalance ?? 0n)
          : id === 102n
            ? (state.usdceBalance ?? 0n)
            : id === 200n
              ? (state.wcolBalance ?? 0n)
              : 0n;
      return ctfIface.encodeFunctionResult("balanceOf", [balance]);
    }
    default:
      throw new Error(`Unexpected CTF call: ${decoded.name}`);
  }
}

function adapterCallResult(
  data: string,
  state: MockRpcState,
): string | "error" {
  const decoded = adapterIface.parseTransaction({ data });
  if (!decoded) throw new Error("Unknown adapter call");

  switch (decoded.name) {
    case "wcol":
      return adapterIface.encodeFunctionResult("wcol", [WCOL]);
    case "col":
      if (state.adapterCol === "error") return "error";
      return adapterIface.encodeFunctionResult("col", [
        state.adapterCol ?? USDCE,
      ]);
    default:
      throw new Error(`Unexpected adapter call: ${decoded.name}`);
  }
}

function ctfCollateralAdapterCallResult(
  data: string,
  state: MockRpcState,
): string | "error" {
  if (!state.ctfCollateralAdapterValid) return "error";
  const decoded = ctfCollateralAdapterIface.parseTransaction({ data });
  if (!decoded) throw new Error("Unknown CTF collateral adapter call");

  switch (decoded.name) {
    case "COLLATERAL_TOKEN":
      return ctfCollateralAdapterIface.encodeFunctionResult(
        "COLLATERAL_TOKEN",
        [PUSD],
      );
    case "USDCE":
      return ctfCollateralAdapterIface.encodeFunctionResult("USDCE", [USDCE]);
    case "CONDITIONAL_TOKENS":
      return ctfCollateralAdapterIface.encodeFunctionResult(
        "CONDITIONAL_TOKENS",
        [CTF],
      );
    default:
      throw new Error(
        `Unexpected CTF collateral adapter call: ${decoded.name}`,
      );
  }
}

function negRiskCollateralAdapterCallResult(
  data: string,
  state: MockRpcState,
): string | "error" {
  if (!state.negRiskCollateralAdapterValid) return "error";
  const decoded = negRiskCollateralAdapterIface.parseTransaction({ data });
  if (!decoded) throw new Error("Unknown neg-risk collateral adapter call");

  switch (decoded.name) {
    case "COLLATERAL_TOKEN":
      return negRiskCollateralAdapterIface.encodeFunctionResult(
        "COLLATERAL_TOKEN",
        [PUSD],
      );
    case "USDCE":
      return negRiskCollateralAdapterIface.encodeFunctionResult("USDCE", [
        USDCE,
      ]);
    case "WRAPPED_COLLATERAL":
      return negRiskCollateralAdapterIface.encodeFunctionResult(
        "WRAPPED_COLLATERAL",
        [WCOL],
      );
    case "NEG_RISK_ADAPTER":
      return negRiskCollateralAdapterIface.encodeFunctionResult(
        "NEG_RISK_ADAPTER",
        [ADAPTER],
      );
    case "CONDITIONAL_TOKENS":
      return negRiskCollateralAdapterIface.encodeFunctionResult(
        "CONDITIONAL_TOKENS",
        [CTF],
      );
    default:
      throw new Error(
        `Unexpected neg-risk collateral adapter call: ${decoded.name}`,
      );
  }
}

async function withMockRpc(state: MockRpcState, fn: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      id?: number;
      method?: string;
      params?: unknown[];
    };
    const id = body.id ?? 1;
    if (body.method === "eth_getCode") return rpcResponse(id, "0x1234");
    if (body.method !== "eth_call") {
      return rpcError(id, `Unexpected RPC method ${body.method ?? ""}`);
    }

    const [call] = (body.params ?? []) as Array<{
      to?: string;
      data?: string;
    }>;
    const target = ethers.getAddress(String(call?.to ?? ""));
    const data = String(call?.data ?? "");
    if (target === CTF) return rpcResponse(id, ctfCallResult(data, state));
    if (target === ADAPTER) {
      const result = adapterCallResult(data, state);
      return result === "error"
        ? rpcError(id, "execution reverted")
        : rpcResponse(id, result);
    }
    if (target === CTF_COLLATERAL_ADAPTER) {
      const result = ctfCollateralAdapterCallResult(data, state);
      return result === "error"
        ? rpcError(id, "execution reverted")
        : rpcResponse(id, result);
    }
    if (target === NEG_RISK_COLLATERAL_ADAPTER) {
      const result = negRiskCollateralAdapterCallResult(data, state);
      return result === "error"
        ? rpcError(id, "execution reverted")
        : rpcResponse(id, result);
    }
    return rpcError(id, `Unexpected target ${target}`);
  }) as typeof fetch;

  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function baseInputs(overrides: {
  isNegRisk: boolean;
  outcome?: "YES" | "NO";
  positionTokenId?: string;
  ctfCollateralAdapterAddress?: string | null;
  negRiskCollateralAdapterAddress?: string | null;
}) {
  return {
    rpcUrl: `mock://polymarket-redemption-${Math.random()}`,
    timeoutMs: 1000,
    funder: FUNDER,
    conditionalTokensAddress: CTF,
    collateralTokenAddress: PUSD,
    legacyCollateralTokenAddress: USDCE,
    negRiskAdapterAddress: ADAPTER,
    outcome: overrides.outcome ?? "YES",
    positionTokenId: overrides.positionTokenId ?? "101",
    conditionId: CONDITION_ID,
    questionId: null,
    negRiskParentConditionId: null,
    negRiskRequestId: null,
    isNegRisk: overrides.isNegRisk,
    ctfCollateralAdapterAddress: overrides.ctfCollateralAdapterAddress,
    negRiskCollateralAdapterAddress: overrides.negRiskCollateralAdapterAddress,
  };
}

await test("standard pUSD redemption reports pUSD as payout token", async () => {
  await withMockRpc({ pUsdBalance: 500_000n, outcome: "YES" }, async () => {
    const plan = await buildPolymarketRedemptionPlan(
      baseInputs({ isNegRisk: false, outcome: "YES" }),
    );

    assert.equal(plan.redeemable, true);
    assert.equal(plan.targetAddress, CTF);
    assert.equal(plan.collateralTokenAddress, PUSD);
    assert.equal(plan.payoutTokenAddress, PUSD);
    assert.equal(plan.operatorApprovalAddress, null);
    assert.equal(plan.payoutAmountRaw, "500000");
  });
});

await test("standard legacy USDC.e redemption prefers collateral adapter and pUSD payout", async () => {
  await withMockRpc(
    {
      pUsdBalance: 0n,
      usdceBalance: 700_000n,
      ctfCollateralAdapterValid: true,
      outcome: "YES",
    },
    async () => {
      const plan = await buildPolymarketRedemptionPlan(
        baseInputs({
          isNegRisk: false,
          outcome: "YES",
          ctfCollateralAdapterAddress: CTF_COLLATERAL_ADAPTER,
        }),
      );

      assert.equal(plan.redeemable, true);
      assert.equal(plan.targetAddress, CTF_COLLATERAL_ADAPTER);
      const redeemArgs = ctfIface.decodeFunctionData(
        "redeemPositions",
        plan.data ?? "0x",
      );
      assert.equal(ethers.getAddress(String(redeemArgs[0])), USDCE);
      assert.equal(plan.collateralTokenAddress, PUSD);
      assert.equal(plan.payoutTokenAddress, PUSD);
      assert.equal(plan.operatorApprovalAddress, CTF_COLLATERAL_ADAPTER);
      assert.equal(plan.payoutAmountRaw, "700000");
    },
  );
});

await test("standard legacy USDC.e redemption falls back to direct USDC.e payout", async () => {
  await withMockRpc(
    { pUsdBalance: 0n, usdceBalance: 700_000n, outcome: "YES" },
    async () => {
      const plan = await buildPolymarketRedemptionPlan(
        baseInputs({ isNegRisk: false, outcome: "YES" }),
      );

      assert.equal(plan.redeemable, true);
      assert.equal(plan.targetAddress, CTF);
      assert.equal(plan.collateralTokenAddress, USDCE);
      assert.equal(plan.payoutTokenAddress, USDCE);
      assert.equal(plan.operatorApprovalAddress, null);
      assert.equal(plan.payoutAmountRaw, "700000");
    },
  );
});

await test("neg-risk redemption prefers collateral adapter and pUSD payout", async () => {
  await withMockRpc(
    {
      wcolBalance: 1_333_332n,
      adapterCol: "error",
      negRiskCollateralAdapterValid: true,
      outcome: "NO",
    },
    async () => {
      const plan = await buildPolymarketRedemptionPlan(
        baseInputs({
          isNegRisk: true,
          outcome: "NO",
          positionTokenId: "200",
          negRiskCollateralAdapterAddress: NEG_RISK_COLLATERAL_ADAPTER,
        }),
      );

      assert.equal(plan.redeemable, true);
      assert.equal(plan.targetAddress, NEG_RISK_COLLATERAL_ADAPTER);
      const redeemArgs = ctfIface.decodeFunctionData(
        "redeemPositions",
        plan.data ?? "0x",
      );
      assert.equal(ethers.getAddress(String(redeemArgs[0])), WCOL);
      assert.equal(plan.collateralTokenAddress, PUSD);
      assert.equal(plan.payoutTokenAddress, PUSD);
      assert.equal(plan.operatorApprovalAddress, NEG_RISK_COLLATERAL_ADAPTER);
      assert.equal(plan.payoutAmountRaw, "1333332");
    },
  );
});

await test("legacy neg-risk fallback reports adapter col as payout token", async () => {
  await withMockRpc(
    {
      wcolBalance: 1_333_332n,
      adapterCol: USDCE,
      outcome: "NO",
    },
    async () => {
      const plan = await buildPolymarketRedemptionPlan(
        baseInputs({
          isNegRisk: true,
          outcome: "NO",
          positionTokenId: "200",
        }),
      );

      assert.equal(plan.redeemable, true);
      assert.equal(plan.targetAddress, ADAPTER);
      assert.equal(plan.collateralTokenAddress, USDCE);
      assert.equal(plan.payoutTokenAddress, USDCE);
      assert.equal(plan.operatorApprovalAddress, ADAPTER);
      assert.equal(plan.payoutAmountRaw, "1333332");
    },
  );
});

await test("legacy neg-risk col read failure returns preflight_unavailable", async () => {
  await withMockRpc(
    {
      wcolBalance: 1_333_332n,
      adapterCol: "error",
      outcome: "NO",
    },
    async () => {
      const plan = await buildPolymarketRedemptionPlan(
        baseInputs({
          isNegRisk: true,
          outcome: "NO",
          positionTokenId: "200",
        }),
      );

      assert.equal(plan.redeemable, false);
      assert.equal(plan.reason, "preflight_unavailable");
      assert.equal(plan.diagnostics?.functionName, "col");
    },
  );
});
