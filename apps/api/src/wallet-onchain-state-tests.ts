import assert from "node:assert/strict";

import {
  classifyPolymarketWalletRuntime,
  decodeEip1167ImplementationFromRuntime,
  decodePolymarketDepositWalletOwnerFromRuntime,
  fetchEvmNativeBalancesWithFallback,
  fetchWalletLiquidBalancesPartial,
  isWalletOnchainIdentityErrorFresh,
  isPolymarketMagicProxyRuntime,
  resolveUsdLikeBalance,
  resolveWalletOnchainStateVenueQuotas,
  selectWalletOnchainStateCandidatesFromRanked,
  type WalletOnchainBalances,
} from "./services/wallet-onchain-state.js";

const DEPOSIT_PREFIX =
  "0x363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af4";
const MAGIC_IMPLEMENTATION = "0x44e999d5c2f66ef0861317f9a4805ac2e90aeb4f";

function buildDepositRuntime(owner: string): string {
  const prefixBytes = (DEPOSIT_PREFIX.length - 2) / 2;
  const middleBytes = 125 - prefixBytes - 20;
  return `${DEPOSIT_PREFIX}${"00".repeat(middleBytes)}${owner.slice(2)}`;
}

const tests = [
  {
    name: "deposit wallet runtime decodes owner from bytecode tail",
    run() {
      const owner = "0x1111111111111111111111111111111111111111";
      const code = buildDepositRuntime(owner);
      assert.equal(decodePolymarketDepositWalletOwnerFromRuntime(code), owner);
      const classified = classifyPolymarketWalletRuntime({ code });
      assert.equal(classified.walletKind, "polymarket_deposit_wallet");
      assert.equal(classified.ownerAddress, owner);
      assert.equal(classified.ownerSource, "deposit_runtime_tail");
      assert.equal(classified.ownerConfidence, "high");
    },
  },
  {
    name: "magic proxy runtime detects implementation with no owner",
    run() {
      const code = `0x363d3d373d3d3d363d73${MAGIC_IMPLEMENTATION.slice(2)}5af43d82803e903d91602b57fd5bf3`;
      assert.equal(
        decodeEip1167ImplementationFromRuntime(code),
        MAGIC_IMPLEMENTATION,
      );
      assert.equal(isPolymarketMagicProxyRuntime(code), true);
      const classified = classifyPolymarketWalletRuntime({ code });
      assert.equal(classified.walletKind, "polymarket_magic_proxy");
      assert.equal(classified.ownerAddress, null);
    },
  },
  {
    name: "safe runtime returns single owner and threshold",
    run() {
      const owner = "0x2222222222222222222222222222222222222222";
      const classified = classifyPolymarketWalletRuntime({
        code: "0x60016000",
        safeOwners: [owner],
        safeThreshold: 1,
      });
      assert.equal(classified.walletKind, "safe");
      assert.equal(classified.ownerAddress, owner);
      assert.equal(classified.ownerSource, "safe_getOwners");
    },
  },
  {
    name: "EOA never gets owner from safe inputs",
    run() {
      const classified = classifyPolymarketWalletRuntime({
        code: "0x",
        safeOwners: ["0x3333333333333333333333333333333333333333"],
        safeThreshold: 1,
      });
      assert.equal(classified.walletKind, "eoa");
      assert.equal(classified.ownerAddress, null);
    },
  },
  {
    name: "unknown contract stays contract_unknown",
    run() {
      const classified = classifyPolymarketWalletRuntime({
        code: "0x60016000",
      });
      assert.equal(classified.walletKind, "contract_unknown");
      assert.equal(classified.ownerAddress, null);
    },
  },
  {
    name: "USD-like balance sums only stable-like entries",
    run() {
      const balances: WalletOnchainBalances = {
        pusd: {
          chain: "polygon",
          symbol: "pUSD",
          tokenAddress: "0x1",
          decimals: 6,
          raw: "1000000",
          amount: "1",
          isNative: false,
        },
        usdce: {
          chain: "polygon",
          symbol: "USDC.e",
          tokenAddress: "0x2",
          decimals: 6,
          raw: "2500000",
          amount: "2.5",
          isNative: false,
        },
        pol: {
          chain: "polygon",
          symbol: "POL",
          tokenAddress: null,
          decimals: 18,
          raw: "9000000000000000000",
          amount: "9",
          isNative: true,
        },
      };
      assert.equal(resolveUsdLikeBalance(balances), "3.5");
    },
  },
  {
    name: "on-chain state quota defaults split 300 as 150/75/75",
    run() {
      assert.deepEqual(resolveWalletOnchainStateVenueQuotas(300), {
        polymarket: 150,
        limitless: 75,
        kalshi: 75,
      });
    },
  },
  {
    name: "on-chain state quota custom totals use floor split",
    run() {
      assert.deepEqual(resolveWalletOnchainStateVenueQuotas(5), {
        polymarket: 2,
        limitless: 1,
        kalshi: 2,
      });
      assert.deepEqual(resolveWalletOnchainStateVenueQuotas(7), {
        polymarket: 3,
        limitless: 2,
        kalshi: 2,
      });
    },
  },
  {
    name: "on-chain state selection refills unused quota by global order",
    run() {
      const candidates = [
        { wallet_id: "p1", venue: "polymarket" as const },
        { wallet_id: "p2", venue: "polymarket" as const },
        { wallet_id: "p3", venue: "polymarket" as const },
        { wallet_id: "p4", venue: "polymarket" as const },
        { wallet_id: "k1", venue: "kalshi" as const },
      ];
      const selected = selectWalletOnchainStateCandidatesFromRanked(
        candidates,
        5,
        { polymarket: 2, limitless: 2, kalshi: 1 },
      );
      assert.deepEqual(
        selected.map((candidate) => candidate.wallet_id),
        ["p1", "p2", "p3", "p4", "k1"],
      );
    },
  },
  {
    name: "recent on-chain identity errors are fresh until stale cutoff",
    run() {
      const cutoff = new Date("2026-06-23T06:00:00.000Z");
      assert.equal(
        isWalletOnchainIdentityErrorFresh(
          {
            walletOnchainIdentityCheckStatus: "error",
            walletOnchainIdentityCheckedAt: "2026-06-23T07:00:00.000Z",
          },
          cutoff,
        ),
        true,
      );
      assert.equal(
        isWalletOnchainIdentityErrorFresh(
          {
            walletOnchainIdentityCheckStatus: "error",
            walletOnchainIdentityCheckedAt: "2026-06-23T05:59:59.000Z",
          },
          cutoff,
        ),
        false,
      );
    },
  },
  {
    name: "partial balance fetch keeps successful chains when one chain fails",
    async run() {
      const polygonAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const solanaAddress = "So11111111111111111111111111111111111111112";
      const result = await fetchWalletLiquidBalancesPartial(
        [
          { address: polygonAddress, chain: "polygon" },
          {
            address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            chain: "base",
          },
          { address: solanaAddress, chain: "solana" },
        ],
        {
          polygon: async (wallets) =>
            new Map([
              [
                wallets[0]?.address.toLowerCase() ?? polygonAddress,
                {
                  usdc: {
                    chain: "polygon",
                    symbol: "USDC",
                    tokenAddress: "0x1",
                    decimals: 6,
                    raw: "1000000",
                    amount: "1",
                    isNative: false,
                  },
                },
              ],
            ]),
          base: async () => {
            throw new Error("base rpc down");
          },
          solana: async (wallets) =>
            new Map([
              [
                wallets[0]?.address ?? solanaAddress,
                {
                  usdc: {
                    chain: "solana",
                    symbol: "USDC",
                    tokenAddress: "mint",
                    decimals: 6,
                    raw: "2000000",
                    amount: "2",
                    isNative: false,
                  },
                },
              ],
            ]),
        },
      );

      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0]?.chain, "base");
      assert.equal(
        result.balances.get(`polygon:${polygonAddress}`)?.usdc?.raw,
        "1000000",
      );
      assert.equal(
        result.balances.get(`solana:${solanaAddress}`)?.usdc?.raw,
        "2000000",
      );
    },
  },
  {
    name: "balance fetch dedupes inputs per chain before fetchers run",
    async run() {
      const polygonAddress = "0x1111111111111111111111111111111111111111";
      const baseAddress = "0x2222222222222222222222222222222222222222";
      const solanaAddress = "So11111111111111111111111111111111111111112";
      const seen: Record<string, string[]> = {
        polygon: [],
        base: [],
        solana: [],
      };

      await fetchWalletLiquidBalancesPartial(
        [
          { address: polygonAddress, chain: "polygon" },
          { address: polygonAddress, chain: "polygon" },
          { address: baseAddress, chain: "base" },
          { address: baseAddress, chain: "base" },
          { address: solanaAddress, chain: "solana" },
          { address: solanaAddress, chain: "solana" },
        ],
        {
          polygon: async (wallets) => {
            seen.polygon = wallets.map((wallet) => wallet.address);
            return new Map();
          },
          base: async (wallets) => {
            seen.base = wallets.map((wallet) => wallet.address);
            return new Map();
          },
          solana: async (wallets) => {
            seen.solana = wallets.map((wallet) => wallet.address);
            return new Map();
          },
        },
      );

      assert.deepEqual(seen.polygon, [polygonAddress]);
      assert.deepEqual(seen.base, [baseAddress]);
      assert.deepEqual(seen.solana, [solanaAddress]);
    },
  },
  {
    name: "Solana balance keys preserve address casing",
    async run() {
      const solanaAddress = "So11111111111111111111111111111111111111112";
      const result = await fetchWalletLiquidBalancesPartial(
        [{ address: solanaAddress, chain: "solana" }],
        {
          solana: async (wallets) =>
            new Map([
              [
                wallets[0]?.address ?? solanaAddress,
                {
                  usdc: {
                    chain: "solana",
                    symbol: "USDC",
                    tokenAddress: "mint",
                    decimals: 6,
                    raw: "1",
                    amount: "0.000001",
                    isNative: false,
                  },
                },
              ],
            ]),
        },
      );

      assert.equal(result.balances.has(`solana:${solanaAddress}`), true);
      assert.equal(
        result.balances.has(`solana:${solanaAddress.toLowerCase()}`),
        false,
      );
    },
  },
  {
    name: "EVM native balance batch failure falls back to unique single calls",
    async run() {
      const first = "0x1111111111111111111111111111111111111111";
      const second = "0x2222222222222222222222222222222222222222";
      const singleCalls: string[] = [];
      const balances = await fetchEvmNativeBalancesWithFallback({
        chain: "polygon",
        wallets: [
          { address: first, chain: "polygon" },
          { address: first, chain: "polygon" },
          { address: second, chain: "polygon" },
        ],
        fetchers: {
          batch: async () => {
            throw new Error("multicall failed");
          },
          single: async (address) => {
            singleCalls.push(address);
            return address === first ? 1n : 2n;
          },
        },
      });

      assert.deepEqual(singleCalls, [first, second]);
      assert.equal(balances.get(first), 1n);
      assert.equal(balances.get(second), 2n);
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.run();
    passed += 1;
  } catch (error) {
    console.error(`[wallet-onchain-state-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(`passed ${passed}/${tests.length} wallet-onchain-state tests`);
