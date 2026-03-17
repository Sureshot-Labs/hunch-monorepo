#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { AuthService } from "./auth.js";
import { pool } from "./db.js";
import { resolveRequestedWalletAddresses } from "./lib/resolve-wallets.js";
import { derivePolymarketFunderAddresses } from "./services/polymarket-funder.js";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

const tests: TestCase[] = [
  {
    name: "resolveRequestedWalletAddresses rejects polymarket funder without explicit opt-in",
    run: async () => {
      const authAny = AuthService as unknown as {
        getUserWallets: (userId: string) => Promise<
          Array<{ walletAddress: string }>
        >;
      };
      const poolAny = pool as unknown as {
        query: (
          sql: string,
          params?: unknown[],
        ) => Promise<{ rows: Array<Record<string, string>> }>;
      };
      const originalGetUserWallets = authAny.getUserWallets;
      const originalQuery = poolAny.query;
      try {
        authAny.getUserWallets = async () => [
          { walletAddress: "0x072c4c45537fdA4Fa9F9DEac3Cf6D667a210ba08" },
        ];
        poolAny.query = async () => ({
          rows: [
            {
              funder_address: "0xF30C18F8743b01FadD33b1f4D2FcE61711b83f2B",
            },
          ],
        });

        const resolved = await resolveRequestedWalletAddresses(
          "u-1",
          "0x072c4c45537fdA4Fa9F9DEac3Cf6D667a210ba08",
          ["0xF30C18F8743b01FadD33b1f4D2FcE61711b83f2B"],
        );

        assert.deepEqual(resolved, []);
      } finally {
        authAny.getUserWallets = originalGetUserWallets;
        poolAny.query = originalQuery;
      }
    },
  },
  {
    name: "resolveRequestedWalletAddresses accepts active polymarket funder when opted in",
    run: async () => {
      const authAny = AuthService as unknown as {
        getUserWallets: (userId: string) => Promise<
          Array<{ walletAddress: string }>
        >;
      };
      const poolAny = pool as unknown as {
        query: (
          sql: string,
          params?: unknown[],
        ) => Promise<{ rows: Array<Record<string, string>> }>;
      };
      const originalGetUserWallets = authAny.getUserWallets;
      const originalQuery = poolAny.query;
      const calls: Array<{ sql: string; params?: unknown[] }> = [];
      try {
        authAny.getUserWallets = async () => [
          { walletAddress: "0x072c4c45537fdA4Fa9F9DEac3Cf6D667a210ba08" },
        ];
        poolAny.query = async (sql, params) => {
          calls.push({ sql, params });
          return {
            rows: [
              {
                funder_address: "0xF30C18F8743b01FadD33b1f4D2FcE61711b83f2B",
              },
            ],
          };
        };

        const resolved = await resolveRequestedWalletAddresses(
          "u-1",
          "0x072c4c45537fdA4Fa9F9DEac3Cf6D667a210ba08",
          ["0xf30c18f8743b01fadd33b1f4d2fce61711b83f2b"],
          { allowPolymarketFunders: true },
        );

        assert.deepEqual(resolved, [
          "0xF30C18F8743b01FadD33b1f4D2FcE61711b83f2B",
        ]);
        assert.equal(calls.length, 1);
        assert.match(calls[0].sql, /venue = 'polymarket'/i);
        assert.deepEqual(calls[0].params, [
          "u-1",
          ["0xf30c18f8743b01fadd33b1f4d2fce61711b83f2b"],
        ]);
      } finally {
        authAny.getUserWallets = originalGetUserWallets;
        poolAny.query = originalQuery;
      }
    },
  },
  {
    name: "resolveRequestedWalletAddresses accepts derived polymarket safe candidate when opted in",
    run: async () => {
      const signer = "0x072c4c45537fdA4Fa9F9DEac3Cf6D667a210ba08";
      const derived = derivePolymarketFunderAddresses({
        signer,
        includeMagicProxy: true,
      });
      const safeCandidate =
        derived.safeProxy ??
        derived.candidates.find(
          (candidate) => candidate.toLowerCase() !== signer.toLowerCase(),
        );
      assert.ok(safeCandidate);

      const authAny = AuthService as unknown as {
        getUserWallets: (userId: string) => Promise<
          Array<{ walletAddress: string }>
        >;
      };
      const poolAny = pool as unknown as {
        query: (
          sql: string,
          params?: unknown[],
        ) => Promise<{ rows: Array<Record<string, string>> }>;
      };
      const originalGetUserWallets = authAny.getUserWallets;
      const originalQuery = poolAny.query;
      const calls: Array<{ sql: string; params?: unknown[] }> = [];
      try {
        authAny.getUserWallets = async () => [{ walletAddress: signer }];
        poolAny.query = async (sql, params) => {
          calls.push({ sql, params });
          return { rows: [] };
        };

        const resolved = await resolveRequestedWalletAddresses(
          "u-1",
          signer,
          [safeCandidate],
          { allowPolymarketFunders: true },
        );

        assert.deepEqual(resolved, [safeCandidate]);
        assert.equal(calls.length, 1);
        assert.match(calls[0].sql, /venue = 'polymarket'/i);
      } finally {
        authAny.getUserWallets = originalGetUserWallets;
        poolAny.query = originalQuery;
      }
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.run();
    passed += 1;
    console.log(`ok - ${test.name}`);
  } catch (error) {
    console.error(`not ok - ${test.name}`);
    throw error;
  }
}

console.log(`passed ${passed}/${tests.length} resolve-wallets tests`);
