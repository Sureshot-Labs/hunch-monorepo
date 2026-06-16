#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { VenueCredentialsInfo } from "./auth.js";
import type { TradeCartItem } from "./repos/trade-carts-repo.js";
import {
  buildTradeCartAllocationSnapshot,
  TradeCartAllocationError,
} from "./services/trade-cart-allocation.js";
import {
  buildTradeCartPreflightResult,
  type TradeCartPreflightWalletSnapshot,
} from "./services/trade-cart-preflight.js";
import { buildKalshiVenueStatus } from "./services/venue-wallet-status.js";

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

const tests: TestCase[] = [];

function test(name: string, run: TestCase["run"]) {
  tests.push({ name, run });
}

function cartItem(
  id: string,
  overrides: Partial<TradeCartItem> = {},
): TradeCartItem {
  return {
    id,
    cartId: "cart-1",
    clientItemId: id,
    venue: "polymarket",
    marketId: "market-1",
    tokenId: "token-1",
    marketSlug: null,
    outcome: "YES",
    side: "BUY",
    orderType: "GTC",
    limitPrice: null,
    amountRaw: "100",
    allocationWeight: null,
    walletAddress: "0x1111111111111111111111111111111111111111",
    signerAddress: "0x1111111111111111111111111111111111111111",
    funderAddress: "0x2222222222222222222222222222222222222222",
    status: "draft",
    intentSnapshot: {},
    createdAt: new Date("2026-06-16T00:00:00Z"),
    updatedAt: new Date("2026-06-16T00:00:00Z"),
    ...overrides,
  };
}

const walletSnapshot: TradeCartPreflightWalletSnapshot = {
  wallets: [
    {
      walletAddress: "0x1111111111111111111111111111111111111111",
      walletType: "ethereum",
      polymarket: {
        hasCredentials: true,
        funder: "0x2222222222222222222222222222222222222222",
        pusd: {
          tokenAddress: "0xpolymarket",
          decimals: 6,
          balanceRaw: "2000",
          lockedRaw: "1500",
          availableAfterLockedRaw: "500",
        },
        usdc: {
          tokenAddress: "0xpolymarket",
          decimals: 6,
          balanceRaw: "2000",
          lockedRaw: "1500",
          availableAfterLockedRaw: "500",
        },
      },
      limitless: {
        hasCredentials: true,
        usdc: {
          tokenAddress: "0xlimitless",
          decimals: 6,
          balanceRaw: "1000",
          lockedRaw: "0",
          availableAfterLockedRaw: "1000",
        },
      },
    },
    {
      walletAddress: "So11111111111111111111111111111111111111112",
      walletType: "solana",
      kalshi: {
        hasCredentials: true,
        proofVerified: true,
        proofRequiredForBuy: false,
        proofBypass: "none",
        usdc: {
          tokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          decimals: 6,
          balanceRaw: "1200",
          lockedRaw: "0",
          availableAfterLockedRaw: "1200",
        },
        sol: {
          tokenAddress: "11111111111111111111111111111111",
          decimals: 9,
          balanceRaw: "5000000",
          lockedRaw: "0",
          availableAfterLockedRaw: "5000000",
        },
      },
    },
  ],
};

const kalshiWalletAddress = "So11111111111111111111111111111111111111112";
const kalshiUsdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const kalshiCredentials: VenueCredentialsInfo = {
  id: "kalshi-creds-1",
  userId: "user-1",
  walletAddress: kalshiWalletAddress,
  venue: "kalshi",
  isActive: true,
  createdAt: new Date("2026-06-16T00:00:00Z"),
  updatedAt: new Date("2026-06-16T00:00:00Z"),
};

test("equal-notional allocation is deterministic and assigns remainder by item order", () => {
  const snapshot = buildTradeCartAllocationSnapshot({
    mode: "equal_notional",
    totalAmountRaw: "100",
    items: [cartItem("item-1"), cartItem("item-2"), cartItem("item-3")],
  });

  assert.deepEqual(
    snapshot.items.map((item) => item.amountRaw),
    ["34", "33", "33"],
  );
});

test("weighted allocation is deterministic", () => {
  const snapshot = buildTradeCartAllocationSnapshot({
    mode: "weighted_notional",
    totalAmountRaw: "1000",
    items: [
      cartItem("item-1", { allocationWeight: "1" }),
      cartItem("item-2", { allocationWeight: "3" }),
    ],
  });

  assert.deepEqual(
    snapshot.items.map((item) => item.amountRaw),
    ["250", "750"],
  );
});

test("manual allocation requires every executable item to have an amount", () => {
  assert.throws(
    () =>
      buildTradeCartAllocationSnapshot({
        mode: "manual",
        items: [cartItem("item-1", { amountRaw: null })],
      }),
    TradeCartAllocationError,
  );
});

test("Kalshi venue helper handles missing credentials, proof required, low SOL, and refresh", async () => {
  let forceRefresh: boolean | undefined;
  const status = await buildKalshiVenueStatus(
    {
      userId: "user-1",
      walletAddress: kalshiWalletAddress,
      user: { kalshiProofBypass: false },
      refresh: true,
    },
    {
      getVenueCredentialsInfo: async () => null,
      fetchKalshiAccountBalances: async () => ({
        solLamports: 1_000_000n,
        usdcAmount: 0n,
        usdcDecimals: 6,
      }),
      verifyProofAddress: async (args) => {
        forceRefresh = args.forceRefresh;
        return { ok: true, verified: false, status: 200, source: "live" };
      },
      kalshiProofEnabled: true,
      solanaUsdcMint: kalshiUsdcMint,
    },
  );

  assert.equal(forceRefresh, true);
  assert.equal(status.hasCredentials, false);
  assert.equal(status.proofRequiredForBuy, true);
  assert.equal(status.proofReason, "required");
  assert.ok(status.reasons.includes("low_sol_balance"));
  assert.ok(status.reasons.includes("insufficient_usdc"));
  assert.equal(status.usdc.balanceRaw, "0");
  assert.equal(status.usdc.availableAfterLockedRaw, "0");
});

test("Kalshi venue helper skips proof when disabled", async () => {
  let proofCalled = false;
  const status = await buildKalshiVenueStatus(
    {
      userId: "user-1",
      walletAddress: kalshiWalletAddress,
      user: { kalshiProofBypass: false },
    },
    {
      getVenueCredentialsInfo: async () => kalshiCredentials,
      fetchKalshiAccountBalances: async () => ({
        solLamports: 5_000_000n,
        usdcAmount: 1200n,
        usdcDecimals: 6,
      }),
      verifyProofAddress: async () => {
        proofCalled = true;
        return { ok: false, error: "should not be called" };
      },
      kalshiProofEnabled: false,
      solanaUsdcMint: kalshiUsdcMint,
    },
  );

  assert.equal(proofCalled, false);
  assert.equal(status.ready, true);
  assert.equal(status.hasCredentials, true);
  assert.equal(status.proofRequiredForBuy, false);
  assert.equal(status.proofReason, "disabled");
  assert.equal(status.usdc.availableAfterLockedRaw, "1200");
});

test("Kalshi venue helper skips proof when user bypass is enabled", async () => {
  let proofCalled = false;
  const status = await buildKalshiVenueStatus(
    {
      userId: "user-1",
      walletAddress: kalshiWalletAddress,
      user: { kalshiProofBypass: true },
    },
    {
      getVenueCredentialsInfo: async () => kalshiCredentials,
      fetchKalshiAccountBalances: async () => ({
        solLamports: 5_000_000n,
        usdcAmount: 1200n,
        usdcDecimals: 6,
      }),
      verifyProofAddress: async () => {
        proofCalled = true;
        return { ok: false, error: "should not be called" };
      },
      kalshiProofEnabled: true,
      solanaUsdcMint: kalshiUsdcMint,
    },
  );

  assert.equal(proofCalled, false);
  assert.equal(status.proofBypass, "user");
  assert.equal(status.proofReason, "bypassed");
  assert.equal(status.proofRequiredForBuy, false);
});

test("Kalshi venue helper marks proof unavailable", async () => {
  const status = await buildKalshiVenueStatus(
    {
      userId: "user-1",
      walletAddress: kalshiWalletAddress,
      user: { kalshiProofBypass: false },
    },
    {
      getVenueCredentialsInfo: async () => kalshiCredentials,
      fetchKalshiAccountBalances: async () => ({
        solLamports: 5_000_000n,
        usdcAmount: 1200n,
        usdcDecimals: 6,
      }),
      verifyProofAddress: async () => ({ ok: false, error: "Proof down" }),
      kalshiProofEnabled: true,
      solanaUsdcMint: kalshiUsdcMint,
    },
  );

  assert.equal(status.proofRequiredForBuy, true);
  assert.equal(status.proofReason, "unavailable");
});

test("preflight aggregates same Polymarket funder bucket and uses availableAfterLockedRaw", () => {
  const result = buildTradeCartPreflightResult({
    items: [
      cartItem("item-1", { amountRaw: "400" }),
      cartItem("item-2", { amountRaw: "500" }),
    ],
    walletSnapshot,
  });

  assert.equal(result.status, "needs_funding");
  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0].requiredRaw, "900");
  assert.equal(result.buckets[0].balanceRaw, "2000");
  assert.equal(result.buckets[0].lockedRaw, "1500");
  assert.equal(result.buckets[0].availableAfterLockedRaw, "500");
  assert.equal(result.deficits[0].missingRaw, "400");
  assert.deepEqual(
    result.items.map((item) => item.status),
    ["needs_funding", "needs_funding"],
  );
});

test("preflight blocks stale selected wallet and funder context", () => {
  const result = buildTradeCartPreflightResult({
    items: [
      cartItem("item-1", {
        walletAddress: "0x3333333333333333333333333333333333333333",
      }),
      cartItem("item-2", {
        funderAddress: "0x4444444444444444444444444444444444444444",
      }),
    ],
    walletSnapshot,
  });

  assert.equal(result.status, "needs_funding");
  assert.deepEqual(result.deficits, []);
  assert.equal(result.items[0].status, "preflight_failed");
  assert.ok(result.items[0].reasons.includes("stale_wallet_context"));
  assert.equal(result.items[1].status, "preflight_failed");
  assert.ok(result.items[1].reasons.includes("stale_funder_context"));
});

test("Limitless items use their own Base USDC bucket", () => {
  const result = buildTradeCartPreflightResult({
    items: [
      cartItem("item-1", {
        venue: "limitless",
        amountRaw: "600",
        funderAddress: null,
      }),
    ],
    walletSnapshot,
  });

  assert.equal(result.status, "ready");
  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0].venue, "limitless");
  assert.equal(result.buckets[0].chainId, "8453");
  assert.equal(result.buckets[0].availableAfterLockedRaw, "1000");
  assert.deepEqual(result.deficits, []);
});

test("Kalshi items use their own Solana USDC bucket", () => {
  const result = buildTradeCartPreflightResult({
    items: [
      cartItem("item-1", {
        venue: "kalshi",
        amountRaw: "700",
        walletAddress: "So11111111111111111111111111111111111111112",
        signerAddress: "So11111111111111111111111111111111111111112",
        funderAddress: null,
      }),
    ],
    walletSnapshot,
  });

  assert.equal(result.status, "ready");
  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0].venue, "kalshi");
  assert.equal(result.buckets[0].chainId, "7565164");
  assert.equal(result.buckets[0].tokenAddress, kalshiUsdcMint);
  assert.equal(result.buckets[0].availableAfterLockedRaw, "1200");
  assert.deepEqual(result.deficits, []);
});

test("Kalshi item with EVM wallet fails wallet type mismatch instead of unsupported venue", () => {
  const result = buildTradeCartPreflightResult({
    items: [
      cartItem("item-1", {
        venue: "kalshi",
        amountRaw: "700",
        funderAddress: null,
      }),
    ],
    walletSnapshot,
  });

  assert.equal(result.status, "needs_funding");
  assert.equal(result.items[0].status, "preflight_failed");
  assert.ok(result.items[0].reasons.includes("wallet_type_mismatch"));
  assert.equal(result.items[0].reasons.includes("unsupported_venue"), false);
});

for (const { name, run } of tests) {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
