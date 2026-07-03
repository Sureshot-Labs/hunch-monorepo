#!/usr/bin/env tsx

import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import {
  AuthService,
  PrivyAccountRecoveryRequiredError,
  PrivyTerminalAuthError,
  WalletNotFoundError,
  resolveWalletRemovalPolicy,
  resetAuthDbFeatureCachesForTests,
  type UserWallet,
} from "./auth.js";
import { pool } from "./db.js";
import { parseJwtExpiresInToMs } from "./env.js";
import {
  PrivyService,
  PrivyTelegramIdentityMismatchError,
  type PrivyUser,
  type PrivyWalletProfile,
} from "./privy-service.js";
import {
  MAX_WALLET_NAME_LENGTH,
  normalizeWalletNameInput,
} from "./lib/wallet-name.js";

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

function makeUserWallet(overrides: Partial<UserWallet> = {}): UserWallet {
  return {
    id: "w-1",
    userId: "u-1",
    walletAddress: "0xabc0000000000000000000000000000000000000",
    walletType: "ethereum",
    name: null,
    isPrimary: false,
    isVerified: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeWalletProfile(
  overrides: Partial<PrivyWalletProfile> = {},
): PrivyWalletProfile {
  const source = overrides.source ?? "external";
  return {
    address: overrides.address ?? "0xabc0000000000000000000000000000000000000",
    walletId: overrides.walletId,
    walletType: overrides.walletType ?? "ethereum",
    source,
    isInternalWallet:
      overrides.isInternalWallet ??
      (source === "embedded" || source === "smart"),
  };
}

const tests: TestCase[] = [
  {
    name: "wallet removal policy protects Privy-managed wallets",
    run: () => {
      const wallet = makeUserWallet({
        walletAddress: "0xabc0000000000000000000000000000000000000",
      });
      const profile = makeWalletProfile({
        address: wallet.walletAddress,
        source: "embedded",
      });

      const policy = resolveWalletRemovalPolicy({
        targetWalletAddress: wallet.walletAddress,
        userEmail: "user@example.com",
        walletProfiles: [profile],
        wallets: [
          wallet,
          makeUserWallet({
            id: "w-2",
            walletAddress: "0xdef0000000000000000000000000000000000000",
          }),
        ],
      });

      assert.equal(policy.allowed, false);
      assert.match(policy.reason ?? "", /privy-managed/i);
    },
  },
  {
    name: "wallet removal policy requires email before removing the only external sign-in wallet",
    run: () => {
      const externalWallet = makeUserWallet({
        walletAddress: "0xabc0000000000000000000000000000000000000",
      });
      const internalWallet = makeUserWallet({
        id: "w-2",
        walletAddress: "0xdef0000000000000000000000000000000000000",
      });

      const policy = resolveWalletRemovalPolicy({
        targetWalletAddress: externalWallet.walletAddress,
        userEmail: null,
        walletProfiles: [
          makeWalletProfile({
            address: internalWallet.walletAddress,
            source: "embedded",
          }),
        ],
        wallets: [externalWallet, internalWallet],
      });

      assert.equal(policy.allowed, false);
      assert.match(policy.reason ?? "", /connect email/i);
    },
  },
  {
    name: "wallet removal policy allows removing the last external sign-in wallet when email exists",
    run: () => {
      const externalWallet = makeUserWallet({
        walletAddress: "0xabc0000000000000000000000000000000000000",
      });
      const internalWallet = makeUserWallet({
        id: "w-2",
        walletAddress: "0xdef0000000000000000000000000000000000000",
      });

      const policy = resolveWalletRemovalPolicy({
        targetWalletAddress: externalWallet.walletAddress,
        userEmail: "user@example.com",
        walletProfiles: [
          makeWalletProfile({
            address: internalWallet.walletAddress,
            source: "embedded",
          }),
        ],
        wallets: [externalWallet, internalWallet],
      });

      assert.equal(policy.allowed, true);
    },
  },
  {
    name: "wallet removal policy allows removing one external wallet when another external sign-in wallet remains",
    run: () => {
      const targetWallet = makeUserWallet({
        walletAddress: "0xabc0000000000000000000000000000000000000",
      });

      const policy = resolveWalletRemovalPolicy({
        targetWalletAddress: targetWallet.walletAddress,
        userEmail: null,
        walletProfiles: [],
        wallets: [
          targetWallet,
          makeUserWallet({
            id: "w-2",
            walletAddress: "0xdef0000000000000000000000000000000000000",
          }),
        ],
      });

      assert.equal(policy.allowed, true);
    },
  },
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
        () => normalizeWalletNameInput("a".repeat(MAX_WALLET_NAME_LENGTH + 1)),
        /too long/i,
      );
      assert.throws(() => normalizeWalletNameInput("bad\nname"), /invalid/i);
    },
  },
  {
    name: "updateWalletName updates and maps row for evm wallet",
    run: async () => {
      const poolAny = pool as unknown as {
        query: (
          sql: string,
          params?: unknown[],
        ) => Promise<{ rows: UserWalletRow[] }>;
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
        assert.match(
          calls[0].sql,
          /lower\(wallet_address\)\s*=\s*lower\(\$2\)/i,
        );
        assert.deepEqual(calls[0].params, [
          "u-1",
          "0xAbC0000000000000000000000000000000000000",
          "Main wallet",
        ]);
      } finally {
        poolAny.query = originalQuery;
        resetAuthDbFeatureCachesForTests();
      }
    },
  },
  {
    name: "updateWalletName throws WalletNotFoundError when no row is updated",
    run: async () => {
      const poolAny = pool as unknown as {
        query: (
          sql: string,
          params?: unknown[],
        ) => Promise<{ rows: UserWalletRow[] }>;
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
        resetAuthDbFeatureCachesForTests();
      }
    },
  },
  {
    name: "getVenueCredentialsInfo uses case-insensitive lookup for EVM wallets",
    run: async () => {
      const poolAny = pool as unknown as {
        query: (
          sql: string,
          params?: unknown[],
        ) => Promise<{ rows: Array<Record<string, unknown>> }>;
      };
      const originalQuery = poolAny.query;
      const calls: Array<{ sql: string; params?: unknown[] }> = [];
      try {
        poolAny.query = async (sql, params) => {
          calls.push({ sql, params });
          return {
            rows: [
              {
                id: "cred-1",
                user_id: "u-1",
                wallet_address: "0xabc0000000000000000000000000000000000000",
                venue: "polymarket",
                additional_data: { role: "maker" },
                is_active: true,
                created_at: new Date("2026-01-01T00:00:00.000Z"),
                updated_at: new Date("2026-01-02T00:00:00.000Z"),
                last_used_at: new Date("2026-01-03T00:00:00.000Z"),
                funder_address: "0xdef0000000000000000000000000000000000000",
                funder_updated_at: new Date("2026-01-04T00:00:00.000Z"),
              },
            ],
          };
        };

        const info = await AuthService.getVenueCredentialsInfo(
          "u-1",
          "polymarket",
          "0xAbC0000000000000000000000000000000000000",
        );

        assert.ok(info);
        assert.equal(
          info.walletAddress,
          "0xabc0000000000000000000000000000000000000",
        );
        const queryCall = calls.at(-1);
        assert.ok(queryCall);
        assert.match(
          queryCall.sql,
          /lower\(wallet_address\)\s*=\s*lower\(\$3\)/i,
        );
        assert.deepEqual(queryCall.params, [
          "u-1",
          "polymarket",
          "0xabc0000000000000000000000000000000000000",
        ]);
      } finally {
        poolAny.query = originalQuery;
      }
    },
  },
  {
    name: "getAllVenueCredentialsInfo uses case-insensitive lookup for EVM wallets",
    run: async () => {
      const poolAny = pool as unknown as {
        query: (
          sql: string,
          params?: unknown[],
        ) => Promise<{ rows: Array<Record<string, unknown>> }>;
      };
      const originalQuery = poolAny.query;
      const calls: Array<{ sql: string; params?: unknown[] }> = [];
      try {
        poolAny.query = async (sql, params) => {
          calls.push({ sql, params });
          return {
            rows: [
              {
                id: "cred-1",
                user_id: "u-1",
                wallet_address: "0xabc0000000000000000000000000000000000000",
                venue: "polymarket",
                additional_data: null,
                is_active: true,
                created_at: new Date("2026-01-01T00:00:00.000Z"),
                updated_at: new Date("2026-01-02T00:00:00.000Z"),
                last_used_at: new Date("2026-01-03T00:00:00.000Z"),
                funder_address: null,
                funder_updated_at: null,
              },
            ],
          };
        };

        const rows = await AuthService.getAllVenueCredentialsInfo(
          "u-1",
          "0xAbC0000000000000000000000000000000000000",
        );

        assert.equal(rows.length, 1);
        assert.equal(
          rows[0]?.walletAddress,
          "0xabc0000000000000000000000000000000000000",
        );
        const queryCall = calls.at(-1);
        assert.ok(queryCall);
        assert.match(
          queryCall.sql,
          /lower\(wallet_address\)\s*=\s*lower\(\$2\)/i,
        );
        assert.deepEqual(queryCall.params, [
          "u-1",
          "0xabc0000000000000000000000000000000000000",
        ]);
      } finally {
        poolAny.query = originalQuery;
      }
    },
  },
  {
    name: "updateVenueFunderAddress lowercases EVM funder storage",
    run: async () => {
      const poolAny = pool as unknown as {
        query: (
          sql: string,
          params?: unknown[],
        ) => Promise<{ rows: Array<Record<string, unknown>> }>;
      };
      const originalQuery = poolAny.query;
      const calls: Array<{ sql: string; params?: unknown[] }> = [];
      try {
        resetAuthDbFeatureCachesForTests();
        poolAny.query = async (sql, params) => {
          calls.push({ sql, params });
          if (/information_schema\.columns/i.test(sql)) {
            return {
              rows: [
                { column_name: "api_secret_enc" },
                { column_name: "api_passphrase_enc" },
                { column_name: "funder_address" },
                { column_name: "funder_updated_at" },
              ],
            };
          }
          return {
            rows: [
              {
                funder_address: "0xdef0000000000000000000000000000000000000",
                funder_updated_at: new Date("2026-01-04T00:00:00.000Z"),
              },
            ],
          };
        };

        const result = await AuthService.updateVenueFunderAddress(
          "u-1",
          "0xAbC0000000000000000000000000000000000000",
          "polymarket",
          "0xDef0000000000000000000000000000000000000",
        );

        assert.equal(
          result.funderAddress,
          "0xdef0000000000000000000000000000000000000",
        );
        const updateCall = calls.find((call) =>
          /update user_venue_credentials/i.test(call.sql),
        );
        assert.ok(updateCall);
        assert.deepEqual(updateCall.params, [
          "u-1",
          "0xabc0000000000000000000000000000000000000",
          "polymarket",
          "0xdef0000000000000000000000000000000000000",
        ]);
      } finally {
        poolAny.query = originalQuery;
        resetAuthDbFeatureCachesForTests();
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
    name: "extractWallets includes supported cross_app embedded and smart wallets",
    run: () => {
      const user = {
        linkedAccounts: [
          {
            type: "wallet",
            address: "0x1111111111111111111111111111111111111111",
            chainType: "ethereum",
          },
          {
            type: "cross_app",
            subject: "cross-app-user-1",
            providerApp: { id: "provider-app-1" },
            embeddedWallets: [
              { address: "0x1111111111111111111111111111111111111111" },
              { address: "So11111111111111111111111111111111111111112" },
            ],
            smartWallets: [
              { address: "0x2222222222222222222222222222222222222222" },
            ],
          },
        ],
      } as unknown as PrivyUser;

      assert.deepEqual(PrivyService.extractWallets(user), [
        {
          address: "0x1111111111111111111111111111111111111111",
          walletType: "ethereum",
        },
        {
          address: "So11111111111111111111111111111111111111112",
          walletType: "solana",
        },
        {
          address: "0x2222222222222222222222222222222222222222",
          walletType: "ethereum",
        },
      ]);
    },
  },
  {
    name: "extractWallets handles raw snake_case Privy user payloads",
    run: () => {
      const user = {
        linked_accounts: [
          {
            type: "wallet",
            address: "0x8874351140f84212436f4D049C2756972702B311",
            chain_type: "ethereum",
            wallet_client_type: "phantom",
            connector_type: "injected",
          },
          {
            id: "a0ozs3h5djalbx2wrqaffktp",
            type: "wallet",
            address: "0x975c31C0cbCF8DA36dAbA7a0d470bCf4C43377E5",
            chain_type: "ethereum",
            wallet_client_type: "privy",
            connector_type: "embedded",
            imported: false,
          },
          {
            id: "g96u1ulpttg2lorgvxwjkwva",
            type: "wallet",
            address: "5zbXV4BrhBinAqyzv18rJod54WgK3Pfqb7m3XrHU69Fj",
            chain_type: "solana",
            wallet_client_type: "privy",
            connector_type: "embedded",
            imported: false,
          },
        ],
        wallet: {
          address: "0x8874351140f84212436f4D049C2756972702B311",
          chain_type: "ethereum",
        },
      } as unknown as PrivyUser;

      assert.deepEqual(PrivyService.extractWallets(user), [
        {
          address: "0x8874351140f84212436f4d049c2756972702b311",
          walletType: "ethereum",
        },
        {
          address: "0x975c31c0cbcf8da36daba7a0d470bcf4c43377e5",
          walletType: "ethereum",
        },
        {
          address: "5zbXV4BrhBinAqyzv18rJod54WgK3Pfqb7m3XrHU69Fj",
          walletType: "solana",
        },
      ]);

      const profiles = PrivyService.classifyWallets(user);
      assert.equal(
        profiles.find(
          (profile) =>
            profile.address === "0x975c31c0cbcf8da36daba7a0d470bcf4c43377e5",
        )?.source,
        "embedded",
      );
      assert.equal(
        profiles.find(
          (profile) =>
            profile.address === "5zbXV4BrhBinAqyzv18rJod54WgK3Pfqb7m3XrHU69Fj",
        )?.source,
        "embedded",
      );
    },
  },
  {
    name: "getPrimaryEmailAddress handles new linked account and legacy email shapes",
    run: () => {
      const newShapeUser = {
        linked_accounts: [
          {
            type: "email",
            address: "user@example.com",
          },
        ],
      } as unknown as PrivyUser;
      const legacyShapeUser = {
        email: { address: "legacy@example.com" },
      } as unknown as PrivyUser;

      assert.equal(
        PrivyService.getPrimaryEmailAddress(newShapeUser),
        "user@example.com",
      );
      assert.equal(
        PrivyService.getPrimaryEmailAddress(legacyShapeUser),
        "legacy@example.com",
      );
    },
  },
  {
    name: "verifyTokenAndGetUser waits for expected added wallets to appear",
    run: async () => {
      const privyAny = PrivyService as unknown as {
        verifyAccessToken: (accessToken: string) => Promise<unknown>;
        getUserData: (claims: unknown) => Promise<PrivyUser>;
      };
      const originalVerifyAccessToken = privyAny.verifyAccessToken;
      const originalGetUserData = privyAny.getUserData;
      let getUserDataCalls = 0;
      try {
        privyAny.verifyAccessToken = async () => ({ userId: "privy-user-1" });
        privyAny.getUserData = async () => {
          getUserDataCalls += 1;
          if (getUserDataCalls === 1) {
            return {
              linkedAccounts: [
                {
                  type: "wallet",
                  address: "0x1111111111111111111111111111111111111111",
                  chainType: "ethereum",
                },
              ],
            } as unknown as PrivyUser;
          }

          return {
            linkedAccounts: [
              {
                type: "wallet",
                address: "0x1111111111111111111111111111111111111111",
                chainType: "ethereum",
              },
              {
                type: "wallet",
                address: "0x2222222222222222222222222222222222222222",
                chainType: "ethereum",
              },
            ],
          } as unknown as PrivyUser;
        };

        const result = await PrivyService.verifyTokenAndGetUser("token", {
          expectedAddedWalletAddresses: [
            "0x1111111111111111111111111111111111111111",
            "0x2222222222222222222222222222222222222222",
          ],
          maxSyncAttempts: 3,
          syncRetryDelayMs: 0,
        });

        assert.equal(getUserDataCalls, 2);
        assert.deepEqual(result.walletAddresses, [
          "0x1111111111111111111111111111111111111111",
          "0x2222222222222222222222222222222222222222",
        ]);
      } finally {
        privyAny.verifyAccessToken = originalVerifyAccessToken;
        privyAny.getUserData = originalGetUserData;
      }
    },
  },
  {
    name: "verifyTokenAndGetUser waits for expected removed wallets to disappear",
    run: async () => {
      const privyAny = PrivyService as unknown as {
        verifyAccessToken: (accessToken: string) => Promise<unknown>;
        getUserData: (claims: unknown) => Promise<PrivyUser>;
      };
      const originalVerifyAccessToken = privyAny.verifyAccessToken;
      const originalGetUserData = privyAny.getUserData;
      let getUserDataCalls = 0;
      try {
        privyAny.verifyAccessToken = async () => ({ userId: "privy-user-1" });
        privyAny.getUserData = async () => {
          getUserDataCalls += 1;
          if (getUserDataCalls === 1) {
            return {
              linkedAccounts: [
                {
                  type: "wallet",
                  address: "0x1111111111111111111111111111111111111111",
                  chainType: "ethereum",
                },
                {
                  type: "wallet",
                  address: "0x2222222222222222222222222222222222222222",
                  chainType: "ethereum",
                },
              ],
            } as unknown as PrivyUser;
          }

          return {
            linkedAccounts: [
              {
                type: "wallet",
                address: "0x1111111111111111111111111111111111111111",
                chainType: "ethereum",
              },
            ],
          } as unknown as PrivyUser;
        };

        const result = await PrivyService.verifyTokenAndGetUser("token", {
          expectedRemovedWalletAddresses: [
            "0x2222222222222222222222222222222222222222",
          ],
          maxSyncAttempts: 3,
          syncRetryDelayMs: 0,
        });

        assert.equal(getUserDataCalls, 2);
        assert.deepEqual(result.walletAddresses, [
          "0x1111111111111111111111111111111111111111",
        ]);
      } finally {
        privyAny.verifyAccessToken = originalVerifyAccessToken;
        privyAny.getUserData = originalGetUserData;
      }
    },
  },
  {
    name: "verifyTokenAndGetUser waits for expected Telegram user id to appear",
    run: async () => {
      const privyAny = PrivyService as unknown as {
        verifyAccessToken: (accessToken: string) => Promise<unknown>;
        getUserData: (claims: unknown) => Promise<PrivyUser>;
      };
      const originalVerifyAccessToken = privyAny.verifyAccessToken;
      const originalGetUserData = privyAny.getUserData;
      let getUserDataCalls = 0;
      try {
        privyAny.verifyAccessToken = async () => ({ userId: "privy-user-1" });
        privyAny.getUserData = async () => {
          getUserDataCalls += 1;
          const linkedAccounts: unknown[] = [
            {
              type: "wallet",
              address: "0x1111111111111111111111111111111111111111",
              chainType: "ethereum",
            },
          ];
          if (getUserDataCalls > 1) {
            linkedAccounts.unshift({
              type: "telegram",
              telegram_user_id: "123456789",
            });
          }
          return { linkedAccounts } as unknown as PrivyUser;
        };

        const result = await PrivyService.verifyTokenAndGetUser("token", {
          expectedTelegramUserId: "123456789",
          maxSyncAttempts: 3,
          syncRetryDelayMs: 0,
        });

        assert.equal(getUserDataCalls, 2);
        assert.equal(
          PrivyService.extractTelegramAccount(result.user)?.telegramUserId,
          "123456789",
        );
      } finally {
        privyAny.verifyAccessToken = originalVerifyAccessToken;
        privyAny.getUserData = originalGetUserData;
      }
    },
  },
  {
    name: "verifyTokenAndGetUser rejects missing expected Telegram user id after retries",
    run: async () => {
      const privyAny = PrivyService as unknown as {
        verifyAccessToken: (accessToken: string) => Promise<unknown>;
        getUserData: (claims: unknown) => Promise<PrivyUser>;
      };
      const originalVerifyAccessToken = privyAny.verifyAccessToken;
      const originalGetUserData = privyAny.getUserData;
      let getUserDataCalls = 0;
      try {
        privyAny.verifyAccessToken = async () => ({ userId: "privy-user-1" });
        privyAny.getUserData = async () => {
          getUserDataCalls += 1;
          return {
            linkedAccounts: [
              {
                type: "wallet",
                address: "0x1111111111111111111111111111111111111111",
                chainType: "ethereum",
              },
            ],
          } as unknown as PrivyUser;
        };

        await assert.rejects(
          () =>
            PrivyService.verifyTokenAndGetUser("token", {
              expectedTelegramUserId: "123456789",
              maxSyncAttempts: 2,
              syncRetryDelayMs: 0,
            }),
          (error: unknown) => {
            assert.ok(error instanceof PrivyTelegramIdentityMismatchError);
            assert.equal(error.expectedTelegramUserId, "123456789");
            assert.equal(error.actualTelegramUserId, null);
            return true;
          },
        );
        assert.equal(getUserDataCalls, 2);
      } finally {
        privyAny.verifyAccessToken = originalVerifyAccessToken;
        privyAny.getUserData = originalGetUserData;
      }
    },
  },
  {
    name: "verifyTokenAndGetUser rejects mismatched expected Telegram user id after retries",
    run: async () => {
      const privyAny = PrivyService as unknown as {
        verifyAccessToken: (accessToken: string) => Promise<unknown>;
        getUserData: (claims: unknown) => Promise<PrivyUser>;
      };
      const originalVerifyAccessToken = privyAny.verifyAccessToken;
      const originalGetUserData = privyAny.getUserData;
      let getUserDataCalls = 0;
      try {
        privyAny.verifyAccessToken = async () => ({ userId: "privy-user-1" });
        privyAny.getUserData = async () => {
          getUserDataCalls += 1;
          return {
            linkedAccounts: [
              {
                type: "telegram",
                telegram_user_id: "987654321",
              },
              {
                type: "wallet",
                address: "0x1111111111111111111111111111111111111111",
                chainType: "ethereum",
              },
            ],
          } as unknown as PrivyUser;
        };

        await assert.rejects(
          () =>
            PrivyService.verifyTokenAndGetUser("token", {
              expectedTelegramUserId: "123456789",
              maxSyncAttempts: 2,
              syncRetryDelayMs: 0,
            }),
          (error: unknown) => {
            assert.ok(error instanceof PrivyTelegramIdentityMismatchError);
            assert.equal(error.expectedTelegramUserId, "123456789");
            assert.equal(error.actualTelegramUserId, "987654321");
            return true;
          },
        );
        assert.equal(getUserDataCalls, 2);
      } finally {
        privyAny.verifyAccessToken = originalVerifyAccessToken;
        privyAny.getUserData = originalGetUserData;
      }
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

      const result =
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

      assert.equal(result.userId, "user-wallet-match");
      assert.equal(result.consumeBindGrant, false);
      assert.equal(calls.length, 2);
      assert.match(calls[1].sql, /lower\(wallet_address\)\s*=\s*lower\(\$2\)/i);
    },
  },
  {
    name: "resolveExistingUserIdForPrivyLoginWithClient consumes an active email bind grant",
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
            return {
              rows: [
                {
                  id: "user-email-only",
                  privy_bind_grant_expires_at: new Date(
                    Date.now() + 60 * 60 * 1000,
                  ),
                },
              ],
            };
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      } as unknown as Pick<PoolClient, "query">;

      const result =
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

      assert.equal(result.userId, "user-email-only");
      assert.equal(result.consumeBindGrant, true);
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
            return {
              rows: [
                {
                  id: "user-email-only",
                  privy_bind_grant_expires_at: null,
                },
              ],
            };
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
        (error: unknown) => {
          assert.ok(error instanceof PrivyTerminalAuthError);
          assert.equal(error.code, "account_merge_required");
          assert.match(error.message, /merge users before login/i);
          assert.deepEqual(error.details?.conflictWalletAddresses, [
            "0xabc0000000000000000000000000000000000000",
          ]);
          return true;
        },
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
          if (
            /FROM users\s+WHERE lower\(email\) = lower\(\$1\)\s+AND id <> \$2/i.test(
              sql,
            )
          ) {
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
          if (
            /FROM users\s+WHERE lower\(email\) = lower\(\$1\)\s+AND id <> \$2/i.test(
              sql,
            )
          ) {
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
        (error: unknown) => {
          assert.ok(error instanceof PrivyTerminalAuthError);
          assert.equal(error.code, "wallet_conflict");
          assert.match(error.message, /wallet address already linked/i);
          assert.equal(
            error.details?.conflictWalletAddress,
            "0xabc0000000000000000000000000000000000000",
          );
          return true;
        },
      );
    },
  },
  {
    name: "extractTelegramAccount reads snake and camel Privy fields",
    run: () => {
      const snakeUser = {
        id: "did:privy:user-1",
        linkedAccounts: [
          {
            type: "telegram",
            telegram_user_id: "123456789012345678",
            first_name: "Ada",
            last_name: "Lovelace",
            username: "ada",
            photo_url: "https://t.me/i/userpic/ada.svg",
          },
        ],
      } as unknown as PrivyUser;
      const camelUser = {
        id: "did:privy:user-2",
        telegram: {
          telegramUserId: "987654321",
          firstName: "Grace",
          lastName: "Hopper",
          username: "grace",
          photoUrl: "https://t.me/i/userpic/grace.svg",
        },
        linkedAccounts: [],
      } as unknown as PrivyUser;

      assert.deepEqual(PrivyService.extractTelegramAccount(snakeUser), {
        telegramUserId: "123456789012345678",
        firstName: "Ada",
        lastName: "Lovelace",
        username: "ada",
        photoUrl: "https://t.me/i/userpic/ada.svg",
      });
      assert.deepEqual(PrivyService.extractTelegramAccount(camelUser), {
        telegramUserId: "987654321",
        firstName: "Grace",
        lastName: "Hopper",
        username: "grace",
        photoUrl: "https://t.me/i/userpic/grace.svg",
      });
    },
  },
  {
    name: "upsertTelegramAccountForUserWithClient rejects Telegram account conflicts as terminal",
    run: async () => {
      const client = {
        query: async (sql: string) => {
          if (/FROM user_telegram_accounts\s+WHERE telegram_user_id = \$1/i.test(sql)) {
            return {
              rows: [
                {
                  user_id: "other-user",
                  telegram_user_id: "123456789",
                },
              ],
            };
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      } as unknown as Pick<PoolClient, "query">;

      await assert.rejects(
        () =>
          AuthService.upsertTelegramAccountForUserWithClient(client, {
            userId: "user-1",
            privyUserId: "did:privy:user-1",
            telegramAccount: {
              telegramUserId: "123456789",
              firstName: "Ada",
            },
          }),
        (error: unknown) => {
          assert.ok(error instanceof PrivyTerminalAuthError);
          assert.equal(error.code, "telegram_conflict");
          assert.equal(error.details?.conflictTelegramUserId, "123456789");
          return true;
        },
      );
    },
  },
  {
    name: "createOrUpdateUserFromPrivyWithClient stores Telegram identity",
    run: async () => {
      const calls: Array<{ sql: string; params?: unknown[] }> = [];
      const privyUser = {
        id: "did:privy:user-telegram",
        linkedAccounts: [
          {
            type: "telegram",
            telegram_user_id: "123456789",
            first_name: "Ada",
            username: "ada",
          },
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
        query: async (sql: string, params?: unknown[]) => {
          calls.push({ sql, params });
          if (/FROM users WHERE privy_user_id = \$1/i.test(sql)) {
            return { rows: [] };
          }
          if (/FROM user_wallets/i.test(sql)) {
            return { rows: [] };
          }
          if (/INSERT INTO users/i.test(sql)) {
            return {
              rows: [
                {
                  id: "user-telegram",
                  privy_user_id: "did:privy:user-telegram",
                  email: null,
                  username: null,
                  display_name: null,
                  avatar_url: null,
                  is_active: true,
                  is_verified: false,
                  created_at: new Date("2026-01-01T00:00:00.000Z"),
                  updated_at: new Date("2026-01-01T00:00:00.000Z"),
                  last_login_at: new Date("2026-01-01T00:00:00.000Z"),
                },
              ],
            };
          }
          if (/INSERT INTO user_wallets/i.test(sql)) {
            return { rows: [] };
          }
          if (/INSERT INTO user_trading_preferences/i.test(sql)) {
            return { rows: [] };
          }
          if (/INSERT INTO user_trading_stats/i.test(sql)) {
            return { rows: [] };
          }
          if (/FROM user_telegram_accounts\s+WHERE telegram_user_id = \$1/i.test(sql)) {
            return { rows: [] };
          }
          if (/FROM user_telegram_accounts\s+WHERE user_id = \$1/i.test(sql)) {
            return { rows: [] };
          }
          if (/INSERT INTO user_telegram_accounts/i.test(sql)) {
            return { rows: [{ user_id: "user-telegram" }] };
          }
          if (/SELECT id, privy_user_id, email/i.test(sql)) {
            return {
              rows: [
                {
                  id: "user-telegram",
                  privy_user_id: "did:privy:user-telegram",
                  email: null,
                  username: null,
                  display_name: null,
                  avatar_url: null,
                  is_admin: false,
                  kalshi_proof_bypass: false,
                  is_active: true,
                  is_verified: false,
                  created_at: new Date("2026-01-01T00:00:00.000Z"),
                  updated_at: new Date("2026-01-01T00:00:00.000Z"),
                  last_login_at: new Date("2026-01-01T00:00:00.000Z"),
                },
              ],
            };
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      } as unknown as Pick<PoolClient, "query">;

      const user = await AuthService.createOrUpdateUserFromPrivyWithClient(
        client,
        privyUser,
        {} as never,
      );

      assert.equal(user.id, "user-telegram");
      const telegramInsert = calls.find((call) =>
        /INSERT INTO user_telegram_accounts/i.test(call.sql),
      );
      assert.ok(telegramInsert);
      assert.deepEqual(telegramInsert.params?.slice(0, 5), [
        "user-telegram",
        "did:privy:user-telegram",
        "123456789",
        "ada",
        "Ada",
      ]);
    },
  },
  {
    name: "createOrUpdateUserFromPrivyWithClient blocks new Telegram-only users by default",
    run: async () => {
      const privyUser = {
        id: "did:privy:user-telegram-only",
        linkedAccounts: [
          {
            type: "telegram",
            telegram_user_id: "123456789",
            first_name: "Ada",
          },
          {
            type: "wallet",
            chainType: "ethereum",
            address: "0xabc0000000000000000000000000000000000000",
            walletClientType: "privy",
            connectorType: "embedded",
            imported: false,
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
            return { rows: [] };
          }
          if (/FROM user_wallets/i.test(sql)) {
            return { rows: [] };
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
        (error: unknown) => {
          assert.ok(error instanceof PrivyTerminalAuthError);
          assert.equal(error.code, "telegram_signup_blocked");
          return true;
        },
      );
    },
  },
  {
    name: "createOrUpdateUserFromPrivyWithClient blocks Telegram-only users with only unknown wallet source",
    run: async () => {
      const privyUser = {
        id: "did:privy:user-telegram-unknown-wallet",
        linkedAccounts: [
          {
            type: "telegram",
            telegram_user_id: "123456789",
            first_name: "Ada",
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
            return { rows: [] };
          }
          if (/FROM user_wallets/i.test(sql)) {
            return { rows: [] };
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
        (error: unknown) => {
          assert.ok(error instanceof PrivyTerminalAuthError);
          assert.equal(error.code, "telegram_signup_blocked");
          return true;
        },
      );
    },
  },
  {
    name: "createOrUpdateUserFromPrivyWithClient deletes stale Telegram identity when Privy unlinks it",
    run: async () => {
      const calls: Array<{ sql: string; params?: unknown[] }> = [];
      const privyUser = {
        id: "did:privy:user-without-telegram",
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
        query: async (sql: string, params?: unknown[]) => {
          calls.push({ sql, params });
          if (/FROM users WHERE privy_user_id = \$1/i.test(sql)) {
            return { rows: [{ id: "user-existing" }] };
          }
          if (/SELECT user_id\s+FROM user_wallets/i.test(sql)) {
            return { rows: [] };
          }
          if (/UPDATE users SET/i.test(sql)) {
            return { rows: [] };
          }
          if (/SELECT id, wallet_address FROM user_wallets/i.test(sql)) {
            return {
              rows: [
                {
                  id: "wallet-1",
                  wallet_address: "0xabc0000000000000000000000000000000000000",
                },
              ],
            };
          }
          if (/SELECT id, wallet_type, is_verified FROM user_wallets/i.test(sql)) {
            return {
              rows: [
                {
                  id: "wallet-1",
                  wallet_type: "ethereum",
                  is_verified: true,
                },
              ],
            };
          }
          if (/UPDATE user_wallets SET is_primary = false/i.test(sql)) {
            return { rows: [] };
          }
          if (/UPDATE user_wallets SET is_primary = true/i.test(sql)) {
            return { rows: [] };
          }
          if (/DELETE FROM user_telegram_accounts WHERE user_id = \$1/i.test(sql)) {
            return { rows: [] };
          }
          if (/SELECT id, privy_user_id, email/i.test(sql)) {
            return {
              rows: [
                {
                  id: "user-existing",
                  privy_user_id: "did:privy:user-without-telegram",
                  email: null,
                  username: null,
                  display_name: null,
                  avatar_url: null,
                  is_admin: false,
                  kalshi_proof_bypass: false,
                  is_active: true,
                  is_verified: false,
                  created_at: new Date("2026-01-01T00:00:00.000Z"),
                  updated_at: new Date("2026-01-01T00:00:00.000Z"),
                  last_login_at: new Date("2026-01-01T00:00:00.000Z"),
                },
              ],
            };
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      } as unknown as Pick<PoolClient, "query">;

      const user = await AuthService.createOrUpdateUserFromPrivyWithClient(
        client,
        privyUser,
        {} as never,
      );

      assert.equal(user.id, "user-existing");
      const telegramDelete = calls.find((call) =>
        /DELETE FROM user_telegram_accounts WHERE user_id = \$1/i.test(call.sql),
      );
      assert.ok(telegramDelete);
      assert.deepEqual(telegramDelete.params, ["user-existing"]);
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
