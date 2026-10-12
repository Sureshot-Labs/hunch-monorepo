import assert from "node:assert/strict";
import { mock } from "node:test";
import Fastify from "fastify";
import type { PoolClient } from "pg";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { PrivyUser } from "./privy-service.js";

// Only the isolated child process loads this fixture. All credentials are fake;
// both network and unexpected database access fail closed.
Object.assign(process.env, {
  HUNCH_RUNTIME_SECRETS_LOADED: "1",
  NODE_ENV: "test",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/privy_native_auth_test",
  JWT_SECRET: "privy-native-auth-test",
  PRIVY_APP_ID: "privy-native-auth-test",
  PRIVY_APP_SECRET: "privy-native-auth-test",
});

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("Network forbidden in Privy auth fixtures");
};
let routeClient: Pick<PoolClient, "query"> | null = null;
mock.module(new URL("./db.ts", import.meta.url).href, {
  namedExports: {
    pool: {
      async query() {
        throw new Error("Unexpected database access in Privy auth fixtures");
      },
      async connect() {
        assert.ok(routeClient, "HTTP fixture must supply a database client");
        return { query: routeClient.query.bind(routeClient), release() {} };
      },
    },
  },
});
mock.module(new URL("./lib/request-ip.ts", import.meta.url).href, {
  namedExports: {
    resolveSecurityClientIp: () => "127.0.0.1",
    checkRateLimitForSecurityClientIp: async () => ({
      allowed: true,
      clientIp: "127.0.0.1",
      key: "auth:privy:fixture",
    }),
  },
});

const { PrivyService } = await import("./privy-service.js");
const {
  AuthService,
  PrivyAccountRecoveryRequiredError,
  PrivyTerminalAuthError,
} = await import("./auth.js");
const { authRoutes } = await import("./routes/auth.js");
const walletAddress = "0xabc0000000000000000000000000000000000000";
const telegramUserId = "123456789";
const userRow = {
  id: "local-user",
  privy_user_id: "did:privy:google-fixture",
  email: "google@example.com",
  username: "legacy_username",
  display_name: "Social name",
  avatar_url: "https://example.com/avatar.jpg",
  handle: "social_handle",
  bio: "Social bio",
  avatar_asset_id: "00000000-0000-4000-8000-000000000001",
  handle_changed_at: new Date("2026-10-08T00:00:00.000Z"),
  is_admin: false,
  kalshi_proof_bypass: false,
  is_active: true,
  is_verified: false,
  created_at: new Date("2026-10-09T00:00:00.000Z"),
  updated_at: new Date("2026-10-09T00:00:00.000Z"),
  last_login_at: new Date("2026-10-09T00:00:00.000Z"),
};

type AccountCase =
  | "new"
  | "privy-id"
  | "wallet"
  | "telegram"
  | "recovery-grant"
  | "email-only-conflict"
  | "cross-account-email-conflict"
  | "user-insert-failure"
  | "wallet-insert-failure"
  | "commit-failure"
  | "missing-wallet";

function makePrivyUser(accountCase: AccountCase): PrivyUser {
  return {
    id: userRow.privy_user_id,
    linked_accounts: [
      { type: "google_oauth", email: userRow.email },
      ...(accountCase === "missing-wallet"
        ? []
        : [
            {
              type: "wallet",
              address: walletAddress,
              chain_type: "ethereum",
              wallet_client_type: "privy",
              connector_type: "embedded",
            },
          ]),
      ...(accountCase === "telegram"
        ? [{ type: "telegram", telegram_user_id: telegramUserId }]
        : []),
    ],
  } as unknown as PrivyUser;
}

function makeDatabaseFixture(accountCase: AccountCase) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
        if (accountCase === "commit-failure" && sql === "COMMIT")
          throw new Error("Fixture commit failure");
        return { rows: [] };
      }
      if (/FROM users WHERE privy_user_id = \$1/i.test(sql))
        return {
          rows: ["privy-id", "cross-account-email-conflict"].includes(
            accountCase,
          )
            ? [{ id: userRow.id, is_active: true }]
            : [],
        };
      if (/FROM user_telegram_accounts account/i.test(sql))
        return {
          rows:
            accountCase === "telegram"
              ? [{ user_id: userRow.id, is_active: true }]
              : [],
        };
      if (/FROM user_wallets/i.test(sql))
        return {
          rows:
            accountCase === "wallet" && /LIMIT 2/i.test(sql)
              ? [{ user_id: userRow.id, is_active: true }]
              : [],
        };
      if (/WHERE lower\(email\) = lower\(\$1\)/i.test(sql)) {
        assert.equal(params[0], userRow.email);
        if (/AND id <>/i.test(sql))
          return {
            rows:
              accountCase === "cross-account-email-conflict"
                ? [{ id: "other-user" }]
                : [],
          };
        return {
          rows: ["recovery-grant", "email-only-conflict"].includes(accountCase)
            ? [
                {
                  id: userRow.id,
                  is_active: true,
                  privy_bind_grant_expires_at:
                    accountCase === "recovery-grant"
                      ? new Date(Date.now() + 60_000)
                      : null,
                },
              ]
            : [],
        };
      }
      if (/INSERT INTO users/i.test(sql)) {
        if (accountCase === "user-insert-failure")
          throw new Error("Fixture user insert failure");
        assert.deepEqual(params, [userRow.email, userRow.privy_user_id]);
        return { rows: [userRow] };
      }
      if (/UPDATE users SET/i.test(sql)) {
        assert.deepEqual(params.slice(0, 3), [
          userRow.email,
          userRow.privy_user_id,
          userRow.id,
        ]);
        assert.equal(params[3], accountCase === "recovery-grant");
        return { rows: [] };
      }
      if (/SELECT id, privy_user_id, email/i.test(sql))
        return { rows: [userRow] };
      if (
        /INSERT INTO user_wallets/i.test(sql) &&
        accountCase === "wallet-insert-failure"
      )
        throw new Error("Fixture wallet insert failure");
      if (/FROM user_telegram_accounts/i.test(sql)) {
        if (accountCase !== "telegram") return { rows: [] };
        return {
          rows: [
            {
              id: "telegram-account",
              user_id: userRow.id,
              telegram_user_id: telegramUserId,
            },
          ],
        };
      }
      if (/INSERT INTO user_telegram_accounts/i.test(sql))
        return { rows: [{ id: "telegram-account", user_id: userRow.id }] };
      if (/FROM runtime_policies/i.test(sql)) return { rows: [] };
      if (
        /pg_advisory_xact_lock|INSERT INTO user_wallets|INSERT INTO user_trading_preferences|INSERT INTO user_trading_stats|UPDATE user_wallets|UPDATE telegram_notification_preferences|DELETE FROM user_telegram_accounts|INSERT INTO telegram_bot_trading_preferences/i.test(
          sql,
        )
      )
        return { rows: [] };
      throw new Error(`Unexpected fixture query: ${sql}`);
    },
  } as unknown as Pick<PoolClient, "query">;
  return { client, queries };
}

try {
  for (const accountKey of ["linkedAccounts", "linked_accounts"]) {
    const user = {
      [accountKey]: [
        null,
        { type: "google_oauth", email: "   " },
        { type: "google_oauth", email: " google@example.com " },
      ],
    } as unknown as PrivyUser;
    assert.equal(
      PrivyService.getPrimaryEmailAddress(user),
      "google@example.com",
    );
    assert.equal(
      PrivyService.getPrimaryEmailAddress({
        ...user,
        email: { address: "primary@example.com" },
      } as PrivyUser),
      "primary@example.com",
    );
    assert.equal(
      PrivyService.getPrimaryEmailAddress({
        [accountKey]: [
          { type: "google_oauth", email: "google@example.com" },
          { type: "email", address: "linked@example.com" },
        ],
        email: { address: "primary@example.com" },
      } as unknown as PrivyUser),
      "linked@example.com",
    );
  }
  assert.equal(
    PrivyService.getPrimaryEmailAddress({
      linked_accounts: [
        { type: "twitter_oauth", email: "twitter@example.com" },
      ],
    } as unknown as PrivyUser),
    null,
  );
  assert.equal(
    PrivyService.getPrimaryEmailAddress({
      linkedAccounts: [{ type: "google_oauth", email: null }],
    } as unknown as PrivyUser),
    null,
  );
  console.log(
    "PASS Google email fallback preserves primary email and nullable accounts",
  );

  // The actual account service, resolver and Telegram sync run against only a
  // fake storage boundary. No account-status result or callback is mocked.
  for (const accountCase of [
    "new",
    "privy-id",
    "wallet",
    "telegram",
    "recovery-grant",
  ] as const) {
    const fixture = makeDatabaseFixture(accountCase);
    const flags: boolean[] = [];
    const user = await AuthService.createOrUpdateUserFromPrivyWithClient(
      fixture.client,
      makePrivyUser(accountCase),
      {} as never,
      (value) => flags.push(value),
    );
    assert.deepEqual(flags, [accountCase === "new"]);
    assert.equal(
      fixture.queries.filter(({ sql }) => /INSERT INTO users/i.test(sql))
        .length,
      accountCase === "new" ? 1 : 0,
    );
    assert.equal(user.id, userRow.id);
    assert.equal(user.handle, userRow.handle);
    assert.equal(user.bio, userRow.bio);
    assert.equal(user.displayName, userRow.display_name);
    assert.equal(user.avatarAssetId, userRow.avatar_asset_id);
    console.log(`PASS real account service: ${accountCase}`);
  }
  for (const accountCase of [
    "email-only-conflict",
    "cross-account-email-conflict",
    "user-insert-failure",
    "wallet-insert-failure",
    "missing-wallet",
  ] as const) {
    const fixture = makeDatabaseFixture(accountCase);
    const flags: boolean[] = [];
    await assert.rejects(
      () =>
        AuthService.createOrUpdateUserFromPrivyWithClient(
          fixture.client,
          makePrivyUser(accountCase),
          {} as never,
          (value) => flags.push(value),
        ),
      (error: unknown) => {
        if (accountCase === "email-only-conflict")
          return error instanceof PrivyAccountRecoveryRequiredError;
        if (accountCase === "cross-account-email-conflict")
          return (
            error instanceof PrivyTerminalAuthError &&
            error.code === "email_conflict"
          );
        const message =
          accountCase === "missing-wallet"
            ? "No wallet address found in Privy user data"
            : accountCase === "user-insert-failure"
              ? "Fixture user insert failure"
              : "Fixture wallet insert failure";
        return error instanceof Error && error.message === message;
      },
    );
    assert.deepEqual(
      flags,
      [],
      "Rejected account setup must not report successful creation",
    );
    if (
      [
        "email-only-conflict",
        "cross-account-email-conflict",
        "missing-wallet",
      ].includes(accountCase)
    )
      assert.ok(
        fixture.queries.every(({ sql }) => !/INSERT|UPDATE|DELETE/i.test(sql)),
      );
    console.log(`PASS real account service rejects: ${accountCase}`);
  }
  const legacyFixture = makeDatabaseFixture("privy-id");
  const legacyUser = await AuthService.createOrUpdateUserFromPrivyWithClient(
    legacyFixture.client,
    makePrivyUser("privy-id"),
    {} as never,
  );
  assert.equal(legacyUser.id, userRow.id);
  console.log(
    "PASS existing caller without account-status callback remains compatible",
  );

  let routeCase: AccountCase = "new";
  let sessionCount = 0;
  mock.method(PrivyService, "verifyTokenAndGetUser", async (token: string) => {
    assert.equal(token, "privy-access-token");
    return {
      claims: {} as never,
      user: makePrivyUser(routeCase),
      walletAddresses: routeCase === "missing-wallet" ? [] : [walletAddress],
      primaryWalletAddress:
        routeCase === "missing-wallet" ? null : walletAddress,
    };
  });
  mock.method(AuthService, "generateToken", () => "hunch-session-token");
  mock.method(AuthService, "createSession", async () => {
    sessionCount += 1;
    return {
      expiresAt: new Date("2026-10-10T00:00:00.000Z"),
      csrfToken: "hunch-csrf-token",
    } as Awaited<ReturnType<typeof AuthService.createSession>>;
  });
  mock.method(AuthService, "recordAuthAttempt", async () => {});

  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authRoutes);
  try {
    for (const accountCase of ["new", "privy-id"] as const) {
      routeCase = accountCase;
      const fixture = makeDatabaseFixture(accountCase);
      routeClient = fixture.client;
      const response = await app.inject({
        method: "POST",
        url: "/auth/privy",
        payload: {
          accessToken: "privy-access-token",
          isNewUser: accountCase !== "new",
          email: "untrusted-client@example.com",
        },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().isNewUser, accountCase === "new");
      assert.equal(response.json().user.handle, userRow.handle);
      assert.equal(response.json().session.token, "hunch-session-token");
      assert.equal(response.json().session.csrfToken, "hunch-csrf-token");
      assert.deepEqual(
        fixture.queries
          .filter(({ sql }) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql))
          .map(({ sql }) => sql),
        ["BEGIN", "COMMIT"],
      );
    }
    assert.equal(sessionCount, 2);
    for (const accountCase of [
      "email-only-conflict",
      "user-insert-failure",
      "wallet-insert-failure",
      "commit-failure",
      "missing-wallet",
    ] as const) {
      routeCase = accountCase;
      const fixture = makeDatabaseFixture(accountCase);
      routeClient = fixture.client;
      const response = await app.inject({
        method: "POST",
        url: "/auth/privy",
        payload: { accessToken: "privy-access-token" },
      });
      assert.equal(
        response.statusCode,
        accountCase === "email-only-conflict"
          ? 409
          : accountCase === "missing-wallet"
            ? 400
            : 500,
      );
      assert.equal(response.json().isNewUser, undefined);
      assert.equal(response.json().session, undefined);
      assert.equal(
        sessionCount,
        2,
        "Rejected or uncommitted account setup must not issue a session",
      );
      const transactions = fixture.queries
        .filter(({ sql }) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql))
        .map(({ sql }) => sql);
      assert.deepEqual(
        transactions,
        accountCase === "missing-wallet"
          ? []
          : accountCase === "commit-failure"
            ? ["BEGIN", "COMMIT", "ROLLBACK"]
            : ["BEGIN", "ROLLBACK"],
      );
      console.log(`PASS HTTP auth rejects without a session: ${accountCase}`);
    }
    console.log(
      "PASS HTTP auth derives new/returning account status from real account setup",
    );
  } finally {
    await app.close();
  }
} finally {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
}
