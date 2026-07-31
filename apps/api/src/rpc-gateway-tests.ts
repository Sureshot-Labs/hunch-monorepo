#!/usr/bin/env tsx

import assert from "node:assert/strict";
import bs58 from "bs58";

import {
  fetchEvmBlockHash,
  fetchEvmTransactionByHash,
  fetchEvmTransactionReceipt,
} from "./services/polygon-rpc.js";
import {
  fetchSolanaReceiptTransaction,
  fetchSolanaSignatureReceiptStatus,
} from "./services/solana-rpc.js";

const originalFetch = globalThis.fetch;
const transactionHash = `0x${"11".repeat(32)}`;
const evmFrom = "0x1111111111111111111111111111111111111111";
const evmTo = "0x2222222222222222222222222222222222222222";
const solanaKeyA = "11111111111111111111111111111111";
const solanaKeyB = "SysvarRent111111111111111111111111111111111";

try {
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
    };
    let result: unknown;
    if (request.method === "eth_getTransactionByHash") {
      result = {
        chainId: "0x89",
        from: evmFrom,
        to: evmTo,
        input: "0xabcdef",
        value: "0x2a",
      };
    } else if (request.method === "eth_getTransactionReceipt") {
      result = {
        status: "0x1",
        blockNumber: "0x10",
        blockHash: `0x${"22".repeat(32)}`,
        logs: [
          {
            address: evmTo,
            data: "0x",
            topics: [`0x${"33".repeat(32)}`],
          },
        ],
      };
    } else if (request.method === "eth_getBlockByNumber") {
      result = { hash: `0x${"44".repeat(32)}` };
    } else if (request.method === "getSignatureStatuses") {
      result = { value: [{ confirmationStatus: null, err: null }] };
    } else if (request.method === "getTransaction") {
      result = {
        slot: 123,
        transaction: {
          message: {
            header: { numRequiredSignatures: 1 },
            accountKeys: [solanaKeyA, solanaKeyB],
            instructions: [
              {
                programIdIndex: 0,
                accounts: [1],
                data: bs58.encode(Uint8Array.from([1, 2, 3])),
              },
            ],
            addressTableLookups: [{ accountKey: solanaKeyB }],
          },
        },
        meta: {
          err: null,
          loadedAddresses: { writable: [solanaKeyA], readonly: [] },
        },
      };
    } else {
      throw new Error(`Unexpected RPC method: ${request.method}`);
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  assert.deepEqual(
    await fetchEvmTransactionByHash({
      rpcUrl: "https://rpc.test/evm",
      timeoutMs: 1_000,
      transactionHash,
    }),
    {
      chainId: 137n,
      from: evmFrom,
      to: evmTo,
      data: "0xabcdef",
      value: 42n,
    },
  );
  const receipt = await fetchEvmTransactionReceipt({
    rpcUrl: "https://rpc.test/evm",
    timeoutMs: 1_000,
    transactionHash,
  });
  assert.equal(receipt?.succeeded, true);
  assert.equal(receipt?.blockNumber, 16);
  assert.equal(receipt?.logs.length, 1);
  assert.equal(
    await fetchEvmBlockHash({
      rpcUrl: "https://rpc.test/evm",
      timeoutMs: 1_000,
      blockNumber: 16,
    }),
    `0x${"44".repeat(32)}`,
  );

  assert.deepEqual(
    await fetchSolanaSignatureReceiptStatus({
      rpcUrls: ["https://rpc.test/solana"],
      signature: bs58.encode(Uint8Array.from({ length: 64 }, () => 7)),
      timeoutMs: 1_000,
    }),
    { confirmationStatus: "processed", failed: false },
  );
  const solanaTransaction = await fetchSolanaReceiptTransaction({
    rpcUrls: ["https://rpc.test/solana"],
    signature: bs58.encode(Uint8Array.from({ length: 64 }, () => 7)),
    timeoutMs: 1_000,
    commitment: "confirmed",
  });
  assert.equal(solanaTransaction?.slot, 123);
  assert.deepEqual(solanaTransaction?.accountKeys, [
    solanaKeyA,
    solanaKeyB,
    solanaKeyA,
  ]);
  assert.deepEqual(solanaTransaction?.instructions[0], {
    programIdIndex: 0,
    accountIndexes: [1],
    data: bs58.encode(Uint8Array.from([1, 2, 3])),
  });
  assert.deepEqual(solanaTransaction?.addressLookupTables, [solanaKeyB]);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("rpc gateway tests passed");
