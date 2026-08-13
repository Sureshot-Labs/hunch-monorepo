#!/usr/bin/env tsx

import assert from "node:assert/strict";
import bs58 from "bs58";

import {
  fetchEvmBalance,
  fetchEvmBlockNumber,
  fetchEvmBlockHash,
  fetchEvmTransactionByHash,
  fetchEvmTransactionReceipt,
} from "./services/polygon-rpc.js";
import {
  fetchSolanaBalanceLamports,
  fetchSolanaFinalizedSlot,
  fetchSolanaReceiptTransaction,
  fetchSolanaSignatureReceiptStatus,
  sendSolanaRawTransaction,
} from "./services/solana-rpc.js";

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let rpcNow = originalNow();
Date.now = () => rpcNow;
const transactionHash = `0x${"11".repeat(32)}`;
const evmFrom = "0x1111111111111111111111111111111111111111";
const evmTo = "0x2222222222222222222222222222222222222222";
const solanaKeyA = "11111111111111111111111111111111";
const solanaKeyB = "SysvarRent111111111111111111111111111111111";
const attemptsByMethod = new Map<string, number>();
let finalizedSlot = 123;

try {
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
    };
    attemptsByMethod.set(
      request.method,
      (attemptsByMethod.get(request.method) ?? 0) + 1,
    );
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
            logIndex: "0x7",
            topics: [`0x${"33".repeat(32)}`],
          },
        ],
      };
    } else if (request.method === "eth_getBlockByNumber") {
      result = { hash: `0x${"44".repeat(32)}` };
    } else if (request.method === "eth_blockNumber") {
      result = "0x64";
    } else if (request.method === "eth_getBalance") {
      result = "0x5";
    } else if (request.method === "getSignatureStatuses") {
      result = { value: [{ confirmationStatus: null, err: null }] };
    } else if (request.method === "getSlot") {
      result = finalizedSlot;
    } else if (request.method === "getBalance") {
      result = { value: 5 };
    } else if (request.method === "sendTransaction") {
      result = solanaKeyB;
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

  const evmHeadUrl = "https://rpc.test/evm-head";
  assert.deepEqual(
    await Promise.all(
      Array.from({ length: 20 }, () =>
        fetchEvmBlockNumber({ rpcUrl: evmHeadUrl, timeoutMs: 1_000 }),
      ),
    ),
    Array(20).fill(100n),
  );
  assert.equal(
    await fetchEvmBlockNumber({ rpcUrl: evmHeadUrl, timeoutMs: 1_000 }),
    100n,
  );
  assert.equal(attemptsByMethod.get("eth_blockNumber"), 1);
  assert.deepEqual(
    await Promise.all(
      Array.from({ length: 20 }, () =>
        fetchEvmBlockNumber({
          rpcUrl: evmHeadUrl,
          timeoutMs: 1_000,
          bypassCache: true,
        }),
      ),
    ),
    Array(20).fill(100n),
  );
  assert.equal(attemptsByMethod.get("eth_blockNumber"), 2);
  assert.equal(
    await fetchEvmBlockNumber({ rpcUrl: evmHeadUrl, timeoutMs: 1_000 }),
    100n,
  );
  assert.equal(attemptsByMethod.get("eth_blockNumber"), 2);
  rpcNow += 1_001;
  assert.equal(
    await fetchEvmBlockNumber({ rpcUrl: evmHeadUrl, timeoutMs: 1_000 }),
    100n,
  );
  assert.equal(attemptsByMethod.get("eth_blockNumber"), 3);

  const evmBalanceUrl = "https://rpc.test/evm-balance";
  assert.deepEqual(
    await Promise.all(
      Array.from({ length: 20 }, () =>
        fetchEvmBalance({
          rpcUrl: evmBalanceUrl,
          timeoutMs: 1_000,
          address: evmFrom,
        }),
      ),
    ),
    Array(20).fill(5n),
  );
  assert.equal(attemptsByMethod.get("eth_getBalance"), 1);
  await fetchEvmBalance({
    rpcUrl: evmBalanceUrl,
    timeoutMs: 1_000,
    address: evmFrom,
  });
  assert.equal(attemptsByMethod.get("eth_getBalance"), 2);

  const solanaHeadUrls = ["https://rpc.test/solana-head"];
  assert.deepEqual(
    await Promise.all(
      Array.from({ length: 20 }, () =>
        fetchSolanaFinalizedSlot({
          rpcUrls: solanaHeadUrls,
          timeoutMs: 1_000,
        }),
      ),
    ),
    Array(20).fill(123n),
  );
  assert.equal(
    await fetchSolanaFinalizedSlot({
      rpcUrls: solanaHeadUrls,
      timeoutMs: 1_000,
    }),
    123n,
  );
  assert.equal(attemptsByMethod.get("getSlot"), 1);
  finalizedSlot = 124;
  assert.deepEqual(
    await Promise.all(
      Array.from({ length: 20 }, () =>
        fetchSolanaFinalizedSlot({
          rpcUrls: solanaHeadUrls,
          timeoutMs: 1_000,
          bypassCache: true,
        }),
      ),
    ),
    Array(20).fill(124n),
    "fresh finalized-slot reads must ignore completed cache entries and remain single-flight",
  );
  assert.equal(attemptsByMethod.get("getSlot"), 2);
  assert.equal(
    await fetchSolanaFinalizedSlot({
      rpcUrls: solanaHeadUrls,
      timeoutMs: 1_000,
    }),
    124n,
    "the fresh boundary must replace the cached finalized slot",
  );
  rpcNow += 1_001;
  assert.equal(
    await fetchSolanaFinalizedSlot({
      rpcUrls: solanaHeadUrls,
      timeoutMs: 1_000,
    }),
    124n,
  );
  assert.equal(attemptsByMethod.get("getSlot"), 3);

  const solanaBalanceUrls = ["https://rpc.test/solana-balance"];
  assert.deepEqual(
    await Promise.all(
      Array.from({ length: 20 }, () =>
        fetchSolanaBalanceLamports({
          rpcUrls: solanaBalanceUrls,
          timeoutMs: 1_000,
          owner: solanaKeyA,
        }),
      ),
    ),
    Array(20).fill(5n),
  );
  assert.equal(attemptsByMethod.get("getBalance"), 1);
  await fetchSolanaBalanceLamports({
    rpcUrls: solanaBalanceUrls,
    timeoutMs: 1_000,
    owner: solanaKeyA,
  });
  assert.equal(attemptsByMethod.get("getBalance"), 2);

  assert.deepEqual(
    await Promise.all([
      sendSolanaRawTransaction({
        rpcUrls: ["https://rpc.test/solana-submit"],
        timeoutMs: 1_000,
        signedTransaction: "same-signed-transaction",
      }),
      sendSolanaRawTransaction({
        rpcUrls: ["https://rpc.test/solana-submit"],
        timeoutMs: 1_000,
        signedTransaction: "same-signed-transaction",
      }),
    ]),
    [solanaKeyB, solanaKeyB],
  );
  assert.equal(
    attemptsByMethod.get("sendTransaction"),
    2,
    "transaction submission must never be single-flight deduplicated",
  );
} finally {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
}

console.log("rpc gateway tests passed");
