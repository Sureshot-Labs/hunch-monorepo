import assert from "node:assert/strict";
import { Interface } from "ethers";
import { POLYMARKET_PROTOCOL_CONTRACTS as contracts } from "@hunch/shared";
import { fetchPolymarketOnchainSnapshot } from "./services/polymarket-onchain.js";

const multicall = new Interface([
  "function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) view returns (tuple(bool success,bytes returnData)[] returnData)",
]);
const erc20 = new Interface([
  "function balanceOf(address) view returns(uint256)",
  "function allowance(address,address) view returns(uint256)",
]);
const erc1155 = new Interface([
  "function isApprovedForAll(address,address) view returns(bool)",
]);
const nonces = new Interface([
  "function nonces(address) view returns(uint256)",
  "function fundingNonce(address) view returns(uint256)",
]);
const signer = "0x0000000000000000000000000000000000000001";
const funder = "0x0000000000000000000000000000000000000002";
const originalFetch = globalThis.fetch;
let failV2 = false;
let observed: Array<{ target: string; fn: string; args: unknown[] }> = [];
globalThis.fetch = async (_url, init) => {
  const request = JSON.parse(String(init?.body));
  assert.equal(request.method, "eth_call", "mock permits only read calls");
  const calls = multicall.decodeFunctionData(
    "aggregate3",
    request.params[0].data,
  )[0];
  observed = [];
  const result = calls.map((entry: { target: string; callData: string }) => {
    const interfaces = [erc20, erc1155, nonces];
    const iface = interfaces.find((candidate) =>
      candidate.getFunction(entry.callData.slice(0, 10)),
    );
    assert.ok(iface);
    const parsed = iface.parseTransaction({ data: entry.callData });
    assert.ok(parsed);
    observed.push({
      target: entry.target.toLowerCase(),
      fn: parsed.name,
      args: [...parsed.args],
    });
    const v2 =
      entry.target.toLowerCase() === contracts.positionManager.toLowerCase() ||
      (parsed.name === "allowance" &&
        String(parsed.args[1]).toLowerCase() ===
          contracts.exchangeV3.toLowerCase());
    if (v2 && failV2) return { success: false, returnData: "0x" };
    return {
      success: true,
      returnData: iface.encodeFunctionResult(parsed.name, [
        parsed.name === "isApprovedForAll" ? !v2 : v2 ? 23n : 71n,
      ]),
    };
  });
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: multicall.encodeFunctionResult("aggregate3", [result]),
    }),
    { status: 200 },
  );
};
try {
  const input = {
    rpcUrl: "https://mock-polyv2.invalid",
    timeoutMs: 1000,
    signer,
    funder,
    includeSignerUsdc: true,
    includeFeeCollectorNonce: true,
    feeCollectorAddress: "0x0000000000000000000000000000000000000003",
    fundingRouterAddress: "0x0000000000000000000000000000000000000004",
    forceFresh: true,
  };
  const legacy = await fetchPolymarketOnchainSnapshot(input);
  const legacyCallCount = observed.length;
  assert.equal(legacy.protocolV2, null);
  assert.equal(
    observed.some(
      (entry) => entry.target === contracts.positionManager.toLowerCase(),
    ),
    false,
  );
  const next = await fetchPolymarketOnchainSnapshot({
    ...input,
    includeProtocolV2: true,
  });
  assert.equal(observed.length, legacyCallCount + 3);
  assert.deepEqual(next.protocolV2, {
    allowanceExchange: 23n,
    okExchange: false,
    okRouter: false,
  });
  assert.deepEqual(
    { ...next, protocolV2: null },
    legacy,
    "optional V2 reads cannot shift legacy cursors or balances",
  );
  const pmCalls = observed.filter(
    (entry) => entry.target === contracts.positionManager.toLowerCase(),
  );
  assert.equal(pmCalls.length, 2);
  assert.deepEqual(
    pmCalls.map((entry) => String(entry.args[1]).toLowerCase()),
    [contracts.exchangeV3.toLowerCase(), contracts.router.toLowerCase()],
  );
  assert.ok(
    pmCalls.every((entry) => String(entry.args[0]).toLowerCase() === funder),
  );
  failV2 = true;
  const unavailable = await fetchPolymarketOnchainSnapshot({
    ...input,
    includeProtocolV2: true,
  });
  assert.deepEqual(unavailable.protocolV2, {
    allowanceExchange: null,
    okExchange: null,
    okRouter: null,
  });
  assert.deepEqual({ ...unavailable, protocolV2: null }, legacy);
  failV2 = false;
  assert.deepEqual(
    (
      await fetchPolymarketOnchainSnapshot({
        ...input,
        includeProtocolV2: true,
      })
    ).protocolV2,
    next.protocolV2,
  );
  console.log(
    "[polymarket-onchain-protocol] ledger targets, legacy compatibility, unknown reads and refresh recovery passed",
  );
} finally {
  globalThis.fetch = originalFetch;
}
