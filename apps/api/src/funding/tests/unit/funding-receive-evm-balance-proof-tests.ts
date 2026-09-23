#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { id, Interface, zeroPadValue } from "ethers";
import { fetchFinalizedEvmOwnedAssetBalanceAfterBlock } from "../../reconciliation/owned-wallet-asset-balance.js";

const originalFetch = globalThis.fetch;
const owner = "0x0000000000000000000000000000000000001234";
const token = "0x000000000000000000000000000000000000abcd";
const blockHash = `0x${"ab".repeat(32)}`;
const otherHash = `0x${"cd".repeat(32)}`;
const block = 70_000_005;
const input = {
  rpcUrl: "https://rpc.invalid",
  timeoutMs: 1_000,
  expectedChainId: 137 as const,
  owner,
  token,
  minimumBlock: String(block - 1),
};

function rpcResponse(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
}

function responseFor(method: string, params: unknown[], hash = blockHash) {
  if (method === "eth_chainId") {
    assert.deepEqual(params, []);
    return rpcResponse("0x89");
  }
  if (method === "eth_getBlockByNumber") {
    assert.deepEqual(params[1], false);
    assert.ok(
      params[0] === "finalized" || params[0] === `0x${block.toString(16)}`,
    );
    return rpcResponse({ number: `0x${block.toString(16)}`, hash });
  }
  assert.equal(method, "eth_call");
  assert.equal(params[1], `0x${block.toString(16)}`);
  assert.equal((params[0] as { to: string }).to.toLowerCase(), token);
  return rpcResponse(`0x${BigInt(1_165_519).toString(16).padStart(64, "0")}`);
}

try {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      params: unknown[];
    };
    return responseFor(body.method, body.params);
  };
  assert.deepEqual(await fetchFinalizedEvmOwnedAssetBalanceAfterBlock(input), {
    raw: "1165519",
    block: String(block),
  });
  assert.deepEqual(
    await fetchFinalizedEvmOwnedAssetBalanceAfterBlock({
      ...input,
      owner: "0x000000000000000000000000000000000000FfFf",
      token: "0x000000000000000000000000000000000000aBcD",
    }),
    { raw: "1165519", block: String(block) },
    "accepted mixed-case receive identities must be readable through RPC",
  );
  const sourceBlock = block - 1;
  const sourceAddress = "0x0000000000000000000000000000000000009876";
  const txHash = `0x${"12".repeat(32)}`;
  const sourceEvent = {
    sourceLedgerHeight: String(sourceBlock),
    txHash,
    eventIndex: "7",
    blockHash: otherHash,
    sourceAddress,
    sourceRaw: "1165519",
  };
  const transferInterface = new Interface([
    "event Transfer(address indexed from,address indexed to,uint256 value)",
  ]);
  const transferEvent = transferInterface.getEvent("Transfer");
  assert.ok(transferEvent);
  const encodedTransfer = transferInterface.encodeEventLog(transferEvent, [
    sourceAddress,
    owner,
    1_165_519n,
  ]);
  const recordedLog = {
    address: token,
    topics: encodedTransfer.topics,
    data: encodedTransfer.data,
    transactionHash: txHash,
    transactionIndex: "0x0",
    blockNumber: `0x${sourceBlock.toString(16)}`,
    blockHash: otherHash,
    logIndex: "0x7",
    removed: false,
  };
  let sourceCanonicalHash = otherHash;
  let sourceLogs: readonly (typeof recordedLog)[] = [recordedLog];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      params: unknown[];
    };
    if (body.method === "eth_getBlockByNumber") {
      if (body.params[0] === `0x${sourceBlock.toString(16)}`) {
        return rpcResponse({
          number: `0x${sourceBlock.toString(16)}`,
          hash: sourceCanonicalHash,
        });
      }
      return responseFor(body.method, body.params);
    }
    if (body.method === "eth_getLogs") {
      const filter = body.params[0] as { topics: unknown[] };
      assert.deepEqual(filter.topics, [
        id("Transfer(address,address,uint256)"),
        null,
        zeroPadValue(owner, 32).toLowerCase(),
      ]);
      return rpcResponse(sourceLogs);
    }
    return responseFor(body.method, body.params);
  };
  assert.deepEqual(
    await fetchFinalizedEvmOwnedAssetBalanceAfterBlock({
      ...input,
      sourceEvent,
    }),
    { raw: "1165519", block: String(block) },
    "the original transfer must survive in the finalized canonical block",
  );
  sourceCanonicalHash = blockHash;
  await assert.rejects(
    fetchFinalizedEvmOwnedAssetBalanceAfterBlock({ ...input, sourceEvent }),
    /source event block is not canonical/,
    "a two-confirmation deposit reorg cannot become a source shortage",
  );
  sourceCanonicalHash = otherHash;
  sourceLogs = [];
  await assert.rejects(
    fetchFinalizedEvmOwnedAssetBalanceAfterBlock({ ...input, sourceEvent }),
    /source transfer is not canonical/,
    "a matching block alone does not prove the exact deposit log",
  );
  sourceLogs = [recordedLog];
  await assert.rejects(
    fetchFinalizedEvmOwnedAssetBalanceAfterBlock({
      ...input,
      sourceEvent: { ...sourceEvent, sourceRaw: "1165518" },
    }),
    /source transfer is not canonical/,
    "another transfer amount cannot prove this receipt",
  );
  let balanceReadOnWrongChain = false;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    if (body.method !== "eth_chainId") balanceReadOnWrongChain = true;
    return body.method === "eth_chainId"
      ? rpcResponse("0x2105")
      : responseFor(body.method, []);
  };
  await assert.rejects(
    fetchFinalizedEvmOwnedAssetBalanceAfterBlock(input),
    /network mismatch/,
    "a healthy RPC for the wrong chain cannot terminalize a receipt",
  );
  assert.equal(balanceReadOnWrongChain, false);
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      params: unknown[];
    };
    if (body.method === "eth_getBalance") {
      assert.equal(body.params[0], owner);
      assert.equal(body.params[1], `0x${block.toString(16)}`);
      return rpcResponse("0x3b9aca00");
    }
    return responseFor(body.method, body.params);
  };
  assert.deepEqual(
    await fetchFinalizedEvmOwnedAssetBalanceAfterBlock({
      ...input,
      token: "0x0000000000000000000000000000000000000000",
    }),
    { raw: "1000000000", block: String(block) },
    "native EVM deposits must use eth_getBalance, not ERC-20 balanceOf",
  );
  await assert.rejects(
    fetchFinalizedEvmOwnedAssetBalanceAfterBlock({
      ...input,
      minimumBlock: String(block + 1),
    }),
    /predates a known source credit/,
    "a finalized node behind the latest credit cannot close a review",
  );

  let blockReads = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      params: unknown[];
    };
    if (body.method === "eth_getBlockByNumber") {
      blockReads += 1;
    }
    return responseFor(
      body.method,
      body.params,
      blockReads === 2 ? otherHash : blockHash,
    );
  };
  await assert.rejects(
    fetchFinalizedEvmOwnedAssetBalanceAfterBlock(input),
    /block changed during observation/,
    "a reorg or inconsistent RPC must not create terminal evidence",
  );

  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    return body.method === "eth_call"
      ? rpcResponse("0x")
      : body.method === "eth_chainId"
        ? rpcResponse("0x89")
        : rpcResponse({ number: `0x${block.toString(16)}`, hash: blockHash });
  };
  await assert.rejects(
    fetchFinalizedEvmOwnedAssetBalanceAfterBlock(input),
    /could not decode result data|buffer overrun|invalid|BAD_DATA/i,
    "missing ERC-20 balance data must not be interpreted as zero",
  );
} finally {
  globalThis.fetch = originalFetch;
}
