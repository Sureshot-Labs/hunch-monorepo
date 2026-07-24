#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { Interface, ethers } from "ethers";

import { env } from "../../../env.js";
import { buildLimitlessRedemptionPlan } from "../../../services/limitless-redemption-plan.js";

const CTF = ethers.getAddress(env.limitlessConditionalTokensAddress);
const USDC = ethers.getAddress(env.limitlessUsdcAddress);
const OWNER = ethers.getAddress("0x496f46aa7500563e7f577d12cb8193421f2963c7");
const ADAPTER = ethers.getAddress("0xada2005600dec949baf300f4c6120000bdb6eaab");
const CONDITION = `0x${"31".repeat(32)}` as const;
const TOKEN_ID = 101n;

const ctf = new Interface([
  "function redeemPositions(address,bytes32,bytes32,uint256[])",
  "function balanceOf(address,uint256) view returns (uint256)",
  "function payoutDenominator(bytes32) view returns (uint256)",
  "function payoutNumerators(bytes32,uint256) view returns (uint256)",
]);
const negRisk = new Interface([
  "function redeemPositions(bytes32 conditionId,uint256[] amounts)",
]);

type RpcState = Readonly<{
  balance?: bigint;
  denominator?: bigint;
  yesNumerator?: bigint;
  noNumerator?: bigint;
  failReads?: boolean;
}>;

function response(id: number, result: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function rpcError(id: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function withRpc(state: RpcState, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      id: number;
      method: string;
      params?: Array<{ data?: string; to?: string }>;
    };
    if (body.method === "eth_getCode") {
      return response(body.id, "0x1234");
    }
    if (body.method !== "eth_call" || state.failReads) {
      return rpcError(body.id, "temporary rpc failure");
    }
    const call = body.params?.[0];
    if (ethers.getAddress(String(call?.to)) !== CTF) {
      return rpcError(body.id, "unexpected target");
    }
    const decoded = ctf.parseTransaction({ data: String(call?.data ?? "0x") });
    if (!decoded) return rpcError(body.id, "unknown call");
    if (decoded.name === "payoutDenominator") {
      return response(
        body.id,
        ctf.encodeFunctionResult(decoded.name, [state.denominator ?? 2n]),
      );
    }
    if (decoded.name === "payoutNumerators") {
      return response(
        body.id,
        ctf.encodeFunctionResult(decoded.name, [
          BigInt(decoded.args[1]) === 0n
            ? (state.yesNumerator ?? 1n)
            : (state.noNumerator ?? 0n),
        ]),
      );
    }
    if (decoded.name === "balanceOf") {
      return response(
        body.id,
        ctf.encodeFunctionResult(decoded.name, [state.balance ?? 1_000_000n]),
      );
    }
    return rpcError(body.id, "unexpected method");
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

function inputs(isNegRisk: boolean) {
  return {
    rpcUrl: `mock://limitless-redeem-${Math.random()}`,
    timeoutMs: 1_000,
    owner: OWNER,
    conditionId: CONDITION,
    tokenId: `limitless:${TOKEN_ID}`,
    outcome: "YES" as const,
    isNegRisk,
    adapterAddress: isNegRisk ? ADAPTER : null,
  };
}

async function test(name: string, run: () => Promise<void>) {
  await run();
  console.log(`[limitless-redemption-plan-tests] ok ${name}`);
}

await test("standard redemption binds exact owner, condition, and payout", () =>
  withRpc(
    { balance: 1_000_000n, denominator: 2n, yesNumerator: 1n },
    async () => {
      const plan = await buildLimitlessRedemptionPlan(inputs(false));
      assert.equal(plan.redeemable, true);
      assert.equal(plan.targetAddress, CTF);
      assert.equal(plan.payoutTokenAddress, USDC);
      assert.equal(plan.expectedPayoutRaw, "500000");
      assert.equal(plan.yesBalanceRaw, "1000000");
      const args = ctf.decodeFunctionData("redeemPositions", plan.data ?? "0x");
      assert.equal(ethers.getAddress(String(args[0])), USDC);
      assert.equal(String(args[2]), CONDITION);
      assert.deepEqual(Array.from(args[3] as bigint[]), [1n]);
    },
  ));

await test("neg-risk redemption preserves canonical adapter and approval target", () =>
  withRpc({ balance: 750_000n }, async () => {
    const plan = await buildLimitlessRedemptionPlan(inputs(true));
    assert.equal(plan.redeemable, true);
    assert.equal(plan.targetAddress, ADAPTER);
    assert.equal(plan.operatorApprovalAddress, ADAPTER);
    assert.equal(plan.expectedPayoutRaw, "375000");
    const args = negRisk.decodeFunctionData(
      "redeemPositions",
      plan.data ?? "0x",
    );
    assert.equal(String(args[0]), CONDITION);
    assert.deepEqual(Array.from(args[1] as bigint[]), [750_000n, 0n]);
  }));

await test("zero balance and unresolved conditions fail closed", () =>
  withRpc({ balance: 0n }, async () => {
    const empty = await buildLimitlessRedemptionPlan(inputs(false));
    assert.equal(empty.redeemable, false);
    assert.equal(empty.reason, "no_redeemable_balance");
  }).then(() =>
    withRpc({ denominator: 0n }, async () => {
      const unresolved = await buildLimitlessRedemptionPlan(inputs(false));
      assert.equal(unresolved.redeemable, false);
      assert.equal(unresolved.reason, "condition_unresolved");
    }),
  ));

await test("RPC uncertainty is typed and never becomes redeemable", () =>
  withRpc({ failReads: true }, async () => {
    const plan = await buildLimitlessRedemptionPlan(inputs(false));
    assert.equal(plan.redeemable, false);
    assert.equal(plan.reason, "preflight_unavailable");
  }));

console.log("[limitless-redemption-plan-tests] complete");
