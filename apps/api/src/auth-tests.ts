#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { AuthService, WalletNotFoundError } from "./auth.js";
import { pool } from "./db.js";
import { MAX_WALLET_NAME_LENGTH, normalizeWalletNameInput } from "./lib/wallet-name.js";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

type UserWalletRow = {
  id: string;
  user_id: string;
  wallet_address: string;
  wallet_type: string;
  name: string | null;
  is_primary: boolean;
  is_verified: boolean;
  created_at: Date;
  updated_at: Date;
};

const tests: TestCase[] = [
  {
    name: "normalize wallet name trims and clears empty input",
    run: () => {
      assert.equal(normalizeWalletNameInput(null), null);
      assert.equal(normalizeWalletNameInput(""), null);
      assert.equal(normalizeWalletNameInput("   "), null);
      assert.equal(normalizeWalletNameInput("  Trading  "), "Trading");
    },
  },
  {
    name: "normalize wallet name rejects invalid input",
    run: () => {
      assert.throws(
        () =>
          normalizeWalletNameInput(
            "a".repeat(MAX_WALLET_NAME_LENGTH + 1),
          ),
        /too long/i,
      );
      assert.throws(() => normalizeWalletNameInput("bad\nname"), /invalid/i);
    },
  },
  {
    name: "updateWalletName updates and maps row for evm wallet",
    run: async () => {
      const poolAny = pool as unknown as {
        query: (sql: string, params?: unknown[]) => Promise<{ rows: UserWalletRow[] }>;
      };
      const originalQuery = poolAny.query;
      const calls: Array<{ sql: string; params?: unknown[] }> = [];
      try {
        poolAny.query = async (sql, params) => {
          calls.push({ sql, params });
          return {
            rows: [
              {
                id: "w-1",
                user_id: "u-1",
                wallet_address: "0xabc0000000000000000000000000000000000000",
                wallet_type: "ethereum",
                name: "Main wallet",
                is_primary: true,
                is_verified: true,
                created_at: new Date("2026-01-01T00:00:00.000Z"),
                updated_at: new Date("2026-01-02T00:00:00.000Z"),
              },
            ],
          };
        };

        const wallet = await AuthService.updateWalletName(
          "u-1",
          "0xAbC0000000000000000000000000000000000000",
          "Main wallet",
        );
        assert.equal(wallet.id, "w-1");
        assert.equal(wallet.userId, "u-1");
        assert.equal(wallet.walletType, "ethereum");
        assert.equal(wallet.name, "Main wallet");
        assert.equal(calls.length, 1);
        assert.match(calls[0].sql, /lower\(wallet_address\)\s*=\s*lower\(\$2\)/i);
        assert.deepEqual(calls[0].params, [
          "u-1",
          "0xAbC0000000000000000000000000000000000000",
          "Main wallet",
        ]);
      } finally {
        poolAny.query = originalQuery;
      }
    },
  },
  {
    name: "updateWalletName throws WalletNotFoundError when no row is updated",
    run: async () => {
      const poolAny = pool as unknown as {
        query: (sql: string, params?: unknown[]) => Promise<{ rows: UserWalletRow[] }>;
      };
      const originalQuery = poolAny.query;
      try {
        poolAny.query = async () => ({ rows: [] });
        await assert.rejects(
          () =>
            AuthService.updateWalletName(
              "u-1",
              "0xabc0000000000000000000000000000000000000",
              "Main wallet",
            ),
          (error: unknown) => error instanceof WalletNotFoundError,
        );
      } finally {
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
  } catch (error) {
    console.error(`[auth-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(`[auth-tests] passed ${passed}/${tests.length}`);
