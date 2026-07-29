#!/usr/bin/env node

import assert from "node:assert/strict";

import { Interface } from "ethers";

import { fetchLimitlessAmmQuotePair } from "./ammQuote.js";

const ammIface = new Interface([
  "function calcBuyAmount(uint256 investmentAmount,uint256 outcomeIndex) view returns (uint256 outcomeTokens)",
]);
const encodedShares = ammIface.encodeFunctionResult("calcBuyAmount", [
  2_000_000n,
]);

async function test(name: string, run: () => Promise<void>) {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const originalFetch = globalThis.fetch;

try {
  await test("paces concurrent AMM RPC calls through one shared queue", async () => {
    const starts: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    globalThis.fetch = async () => {
      starts.push(Date.now());
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: encodedShares }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    await Promise.all([
      fetchLimitlessAmmQuotePair({
        rpcUrl: "https://rpc.test/pacing",
        timeoutMs: 1_000,
        minDelayMs: 40,
        marketAddress: "0x1111111111111111111111111111111111111111",
      }),
      fetchLimitlessAmmQuotePair({
        rpcUrl: "https://rpc.test/pacing",
        timeoutMs: 1_000,
        minDelayMs: 40,
        marketAddress: "0x2222222222222222222222222222222222222222",
      }),
    ]);

    assert.equal(starts.length, 4);
    assert.equal(maxInFlight, 1);
    for (let index = 1; index < starts.length; index += 1) {
      const previousStart = starts[index - 1];
      const currentStart = starts[index];
      assert.ok(previousStart !== undefined && currentStart !== undefined);
      assert.ok(
        currentStart - previousStart >= 20,
        `RPC calls ${index} and ${index + 1} started too close together`,
      );
    }
  });

  await test("deduplicates an identical in-flight AMM quote pair", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 2));
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: encodedShares }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };
    const inputs = {
      rpcUrl: "https://rpc.test/dedupe",
      timeoutMs: 1_000,
      minDelayMs: 10,
      marketAddress: "0x3333333333333333333333333333333333333333",
    };

    const [first, second] = await Promise.all([
      fetchLimitlessAmmQuotePair(inputs),
      fetchLimitlessAmmQuotePair(inputs),
    ]);

    assert.equal(calls, 2);
    assert.deepEqual(first, second);
  });
} finally {
  globalThis.fetch = originalFetch;
}
