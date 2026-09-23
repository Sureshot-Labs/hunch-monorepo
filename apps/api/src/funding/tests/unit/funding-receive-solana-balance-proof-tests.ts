#!/usr/bin/env tsx

import assert from "node:assert/strict";
import {
  fetchFinalizedSolanaOwnedBalanceAtOrAfterSlot,
  fetchFinalizedSolanaOwnedTokenDebit,
  parseFinalizedSolanaOwnedTokenDebit,
} from "../../../services/solana-rpc.js";

const originalFetch = globalThis.fetch;
const owner = "9xQeWvG816bUx9EPjHmaT23yvVMZq4XFmYdWkP3vZC8V";
const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const minimumSlot = 449_676_815;
const request = {
  rpcUrls: ["https://rpc.invalid"],
  owner,
  mint,
  decimals: 6,
  minimumSlot,
  timeoutMs: 1_000,
};
const signature = "synthetic-finalized-signature";
const tokenBalance = (
  accountIndex: number,
  amount: string,
  accountOwner = owner,
) => ({
  accountIndex,
  mint,
  owner: accountOwner,
  uiTokenAmount: { amount, decimals: 6 },
});
const finalizedTransaction = {
  slot: minimumSlot,
  meta: {
    err: null,
    preTokenBalances: [tokenBalance(0, "1112645"), tokenBalance(1, "3000")],
    postTokenBalances: [tokenBalance(0, "0"), tokenBalance(1, "3000")],
  },
  transaction: {
    signatures: [signature],
    message: { accountKeys: ["source-token", "second-token"] },
  },
};

function rpcResponse(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
}

function tokenEntry(amount: string, accountOwner = owner) {
  return {
    pubkey: "synthetic-token-account",
    account: {
      data: {
        parsed: {
          info: {
            owner: accountOwner,
            mint,
            tokenAmount: { amount, decimals: 6 },
          },
        },
      },
    },
  };
}

try {
  assert.deepEqual(
    parseFinalizedSolanaOwnedTokenDebit(finalizedTransaction, {
      owner,
      mint,
      decimals: 6,
    }),
    { raw: "1112645", slot: String(minimumSlot) },
  );
  assert.equal(
    parseFinalizedSolanaOwnedTokenDebit(
      {
        ...finalizedTransaction,
        meta: {
          ...finalizedTransaction.meta,
          err: { InstructionError: [0, "Custom"] },
        },
      },
      { owner, mint, decimals: 6 },
    ),
    null,
    "a failed transaction cannot prove source debit",
  );
  assert.equal(
    parseFinalizedSolanaOwnedTokenDebit(
      {
        ...finalizedTransaction,
        meta: {
          ...finalizedTransaction.meta,
          postTokenBalances: [
            tokenBalance(0, "1112645"),
            tokenBalance(1, "3000"),
          ],
        },
      },
      { owner, mint, decimals: 6 },
    ),
    null,
    "a finalized non-debit step cannot prove source debit",
  );
  assert.equal(
    parseFinalizedSolanaOwnedTokenDebit(finalizedTransaction, {
      owner: "different-owner",
      mint,
      decimals: 6,
    }),
    null,
    "debit from another wallet must not count",
  );
  assert.equal(
    parseFinalizedSolanaOwnedTokenDebit(
      {
        ...finalizedTransaction,
        meta: {
          ...finalizedTransaction.meta,
          preTokenBalances: [{ ...tokenBalance(0, "1112645"), owner: null }],
          postTokenBalances: [{ ...tokenBalance(0, "0"), owner: null }],
        },
      },
      { owner, mint, decimals: 6 },
    ),
    null,
    "an ownerless token balance cannot be attributed to this wallet",
  );
  assert.equal(
    parseFinalizedSolanaOwnedTokenDebit(finalizedTransaction, {
      owner,
      mint: "different-mint",
      decimals: 6,
    }),
    null,
    "debit of another asset must not count",
  );
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.method, "getTransaction");
    assert.equal(body.params[1].commitment, "finalized");
    return rpcResponse(finalizedTransaction);
  };
  assert.deepEqual(
    await fetchFinalizedSolanaOwnedTokenDebit({
      rpcUrls: ["https://rpc.invalid"],
      signature,
      owner,
      mint,
      decimals: 6,
      timeoutMs: 1_000,
    }),
    { raw: "1112645", slot: String(minimumSlot) },
  );
  globalThis.fetch = async () =>
    rpcResponse({
      ...finalizedTransaction,
      transaction: {
        ...finalizedTransaction.transaction,
        signatures: ["other"],
      },
    });
  assert.equal(
    await fetchFinalizedSolanaOwnedTokenDebit({
      rpcUrls: ["https://rpc.invalid"],
      signature,
      owner,
      mint,
      decimals: 6,
      timeoutMs: 1_000,
    }),
    null,
    "the RPC transaction must match the persisted signature",
  );

  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.method, "getTokenAccountsByOwner");
    assert.equal(body.params[2].commitment, "finalized");
    assert.equal(body.params[2].minContextSlot, minimumSlot);
    return rpcResponse({
      context: { slot: minimumSlot - 1 },
      value: [tokenEntry("4259")],
    });
  };
  await assert.rejects(
    fetchFinalizedSolanaOwnedBalanceAtOrAfterSlot(request),
    /unproven finalized token balance/,
    "a lagging provider must not produce terminal review evidence",
  );

  globalThis.fetch = async () =>
    rpcResponse({
      context: { slot: minimumSlot },
      value: [tokenEntry("4000"), tokenEntry("259")],
    });
  assert.deepEqual(
    await fetchFinalizedSolanaOwnedBalanceAtOrAfterSlot(request),
    {
      amount: 4259n,
      slot: minimumSlot,
    },
  );

  globalThis.fetch = async () =>
    rpcResponse({ context: { slot: minimumSlot }, value: [] });
  assert.deepEqual(
    await fetchFinalizedSolanaOwnedBalanceAtOrAfterSlot(request),
    {
      amount: 0n,
      slot: minimumSlot,
    },
  );

  globalThis.fetch = async () =>
    rpcResponse({
      context: { slot: minimumSlot },
      value: [tokenEntry("4259", "wrong-owner")],
    });
  await assert.rejects(
    fetchFinalizedSolanaOwnedBalanceAtOrAfterSlot(request),
    /invalid finalized token account/,
  );

  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.method, "getBalance");
    assert.equal(body.params[1].commitment, "finalized");
    assert.equal(body.params[1].minContextSlot, minimumSlot);
    return rpcResponse({ context: { slot: minimumSlot }, value: 0 });
  };
  assert.deepEqual(
    await fetchFinalizedSolanaOwnedBalanceAtOrAfterSlot({
      ...request,
      mint: null,
      decimals: 9,
    }),
    { amount: 0n, slot: minimumSlot },
  );
} finally {
  globalThis.fetch = originalFetch;
}
