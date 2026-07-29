#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { Interface } from "ethers";

import { fetchLimitlessOnchainSnapshot } from "../../../services/limitless-onchain.js";

const multicallInterface = new Interface([
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)",
]);
const erc20Interface = new Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
]);
const erc1155Interface = new Interface([
  "function isApprovedForAll(address owner,address operator) view returns (bool)",
]);

const originalFetch = globalThis.fetch;
let rpcRequests = 0;

try {
  globalThis.fetch = (async (_input, init) => {
    rpcRequests += 1;
    const request = JSON.parse(String(init?.body)) as {
      method: string;
      params: [{ data: string }];
    };
    assert.equal(request.method, "eth_call");
    const decoded = multicallInterface.decodeFunctionData(
      "aggregate3",
      request.params[0].data,
    ) as unknown;
    const calls = Array.isArray(decoded) ? decoded[0] : null;
    assert.ok(Array.isArray(calls));
    assert.equal(calls.length, 8);

    const returnData = [
      erc20Interface.encodeFunctionResult("balanceOf", [100n]),
      erc20Interface.encodeFunctionResult("allowance", [101n]),
      erc20Interface.encodeFunctionResult("allowance", [102n]),
      erc20Interface.encodeFunctionResult("allowance", [103n]),
      erc1155Interface.encodeFunctionResult("isApprovedForAll", [true]),
      erc1155Interface.encodeFunctionResult("isApprovedForAll", [false]),
      erc1155Interface.encodeFunctionResult("isApprovedForAll", [true]),
      erc1155Interface.encodeFunctionResult("isApprovedForAll", [false]),
    ];
    const result = multicallInterface.encodeFunctionResult("aggregate3", [
      returnData.map((data) => ({ success: true, returnData: data })),
    ]);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
    });
  }) as typeof fetch;

  const snapshot = await fetchLimitlessOnchainSnapshot({
    rpcUrl: "https://rpc.invalid/limitless-snapshot-test",
    timeoutMs: 1_000,
    owner: "0x0000000000000000000000000000000000000001",
    clobAddress: "0x0000000000000000000000000000000000000002",
    negRiskAddress: "0x0000000000000000000000000000000000000003",
    ammAddress: "0x0000000000000000000000000000000000000004",
    adapterAddress: "0x0000000000000000000000000000000000000005",
    conditionalTokensAddress: "0x0000000000000000000000000000000000000006",
  });

  assert.equal(rpcRequests, 1);
  assert.deepEqual(snapshot, {
    usdcBalance: 100n,
    allowanceClob: 101n,
    allowanceNegRisk: 102n,
    allowanceAmm: 103n,
    approvedClob: true,
    approvedNegRisk: false,
    approvedAdapter: true,
    approvedAmm: false,
  });
  console.log(
    "[limitless-onchain-snapshot-tests] account balance, allowances, and approvals use one multicall",
  );
} finally {
  globalThis.fetch = originalFetch;
}
