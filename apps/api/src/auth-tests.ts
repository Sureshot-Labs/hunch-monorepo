#!/usr/bin/env tsx

import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import {
  AuthService,
  PrivyAccountRecoveryRequiredError,
  PrivyTerminalAuthError,
  WalletNotFoundError,
} from "./auth.js";
import { pool } from "./db.js";
import { parseJwtExpiresInToMs } from "./env.js";
import type { PrivyUser } from "./privy-service.js";
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
  {
    name: "parseJwtExpiresInToMs matches configured duration semantics",
    run: () => {
      assert.equal(parseJwtExpiresInToMs("24h"), 24 * 60 * 60 * 1000);
      assert.equal(parseJwtExpiresInToMs("30m"), 30 * 60 * 1000);
      assert.equal(parseJwtExpiresInToMs("1500ms"), 1000);
      assert.throws(() => parseJwtExpiresInToMs("120"), /at least 1 second/i);
    },
  },
  {
    name: "resolveExistingUserIdForPrivyLoginWithClient recovers by linked wallet",
    run: async () => {
      const calls: Array<{ sql: string; params?: unknown[] }> = [];
      const client = {
        query: async (sql: string, params?: unknown[]) => {
          calls.push({ sql, params });
          if (/FROM users WHERE privy_user_id = \$1/i.test(sql)) {
            return { rows: [] };
          }
          if (/FROM user_wallets/i.test(sql)) {
            return { rows: [{ user_id: "user-wallet-match" }] };
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      } as unknown as Pick<PoolClient, "query">;

      const userId =
        await AuthService.resolveExistingUserIdForPrivyLoginWithClient(client, {
          privyUserId: "did:privy:new-user",
          privyWallets: [
            {
              address: "0xabc0000000000000000000000000000000000000",
              walletType: "ethereum",
            },
          ],
          email: "user@example.com",
        });

      assert.equal(userId, "user-wallet-match");
      assert.equal(calls.length, 2);
      assert.match(
        calls[1].sql,
        /lower\(wallet_address\)\s*=\s*lower\(\$2\)/i,
      );
    },
  },
  {
    name: "resolveExistingUserIdForPrivyLoginWithClient rejects email-only recovery",
    run: async () => {
      const client = {
        query: async (sql: string) => {
          if (/FROM users WHERE privy_user_id = \$1/i.test(sql)) {
            return { rows: [] };
          }
          if (/FROM user_wallets/i.test(sql)) {
            return { rows: [] };
          }
          if (/FROM users\s+WHERE lower\(email\) = lower\(\$1\)/i.test(sql)) {
            return { rows: [{ id: "user-email-only" }] };
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      } as unknown as Pick<PoolClient, "query">;

      await assert.rejects(
        () =>
          AuthService.resolveExistingUserIdForPrivyLoginWithClient(client, {
            privyUserId: "did:privy:new-user",
            privyWallets: [
              {
                address: "0xabc0000000000000000000000000000000000000",
                walletType: "ethereum",
              },
            ],
            email: "user@example.com",
          }),
        (error: unknown) =>
          error instanceof PrivyAccountRecoveryRequiredError &&
          /email only/i.test(error.message),
      );
    },
  },
  {
    name: "resolveExistingUserIdForPrivyLoginWithClient rejects multi-user wallet conflicts as terminal",
    run: async () => {
      const client = {
        query: async (sql: string, params?: unknown[]) => {
          if (/FROM users WHERE privy_user_id = \$1/i.test(sql)) {
            return { rows: [] };
          }
          if (/FROM user_wallets/i.test(sql)) {
            if (params?.[1] === "0xabc0000000000000000000000000000000000000") {
              return { rows: [{ user_id: "user-1" }, { user_id: "user-2" }] };
            }
            return { rows: [] };
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      } as unknown as Pick<PoolClient, "query">;

      await assert.rejects(
        () =>
          AuthService.resolveExistingUserIdForPrivyLoginWithClient(client, {
            privyUserId: "did:privy:new-user",
            privyWallets: [
              {
                address: "0xabc0000000000000000000000000000000000000",
                walletType: "ethereum",
              },
            ],
            email: null,
          }),
        (error: unknown) =>
          error instanceof PrivyTerminalAuthError &&
          error.code === "account_merge_required" &&
          /merge users before login/i.test(error.message),
      );
    },
  },
  {
    name: "createOrUpdateUserFromPrivyWithClient rejects cross-account email conflicts as terminal",
    run: async () => {
      const privyUser = {
        id: "did:privy:user-1",
        email: { address: "user@example.com" },
        linkedAccounts: [
          {
            type: "wallet",
            chainType: "ethereum",
            address: "0xabc0000000000000000000000000000000000000",
          },
        ],
        wallet: {
          chainType: "ethereum",
          address: "0xabc0000000000000000000000000000000000000",
        },
      } as unknown as PrivyUser;

      const client = {
        query: async (sql: string) => {
          if (/FROM users WHERE privy_user_id = \$1/i.test(sql)) {
            return { rows: [{ id: "user-1" }] };
          }
          if (/FROM users\s+WHERE lower\(email\) = lower\(\$1\)\s+AND id <> \$2/i.test(sql)) {
            return { rows: [{ id: "user-2" }] };
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      } as unknown as Pick<PoolClient, "query">;

      await assert.rejects(
        () =>
          AuthService.createOrUpdateUserFromPrivyWithClient(
            client,
            privyUser,
            {} as never,
          ),
        (error: unknown) =>
          error instanceof PrivyTerminalAuthError &&
          error.code === "email_conflict" &&
          /email already linked/i.test(error.message),
      );
    },
  },
  {
    name: "createOrUpdateUserFromPrivyWithClient rejects cross-account wallet conflicts as terminal",
    run: async () => {
      const privyUser = {
        id: "did:privy:user-1",
        email: { address: "user@example.com" },
        linkedAccounts: [
          {
            type: "wallet",
            chainType: "ethereum",
            address: "0xabc0000000000000000000000000000000000000",
          },
        ],
        wallet: {
          chainType: "ethereum",
          address: "0xabc0000000000000000000000000000000000000",
        },
      } as unknown as PrivyUser;

      const client = {
        query: async (sql: string) => {
          if (/FROM users WHERE privy_user_id = \$1/i.test(sql)) {
            return { rows: [{ id: "user-1" }] };
          }
          if (/FROM users\s+WHERE lower\(email\) = lower\(\$1\)\s+AND id <> \$2/i.test(sql)) {
            return { rows: [] };
          }
          if (/FROM user_wallets/i.test(sql)) {
            return { rows: [{ user_id: "user-2" }] };
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      } as unknown as Pick<PoolClient, "query">;

      await assert.rejects(
        () =>
          AuthService.createOrUpdateUserFromPrivyWithClient(
            client,
            privyUser,
            {} as never,
          ),
        (error: unknown) =>
          error instanceof PrivyTerminalAuthError &&
          error.code === "wallet_conflict" &&
          /wallet address already linked/i.test(error.message),
      );
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
