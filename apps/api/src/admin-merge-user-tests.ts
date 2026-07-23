import assert from "node:assert/strict";

import type { QueryResult, QueryResultRow } from "pg";

import { mergeUsers, type UserRow } from "./admin-merge-user-core.js";

type QueryCall = {
  params?: unknown[];
  sql: string;
};

type MergeDbFixture = {
  assetPreferenceConflicts?: number;
  assetPreferenceRows?: number;
  authRows?: number;
  intentRows?: number;
  sourceTelegramUserId?: string;
  targetTelegramUserId?: string;
};

function result<T extends QueryResultRow>(
  rows: T[] = [],
  rowCount = rows.length,
): QueryResult<T> {
  return {
    command: "",
    fields: [],
    oid: 0,
    rowCount,
    rows,
  };
}

function compactSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function user(id: string): UserRow {
  return {
    avatar_url: null,
    display_name: null,
    email: `${id}@example.com`,
    id,
    is_admin: false,
    kalshi_proof_bypass: false,
    last_login_at: null,
    privy_user_id: `did:privy:${id}`,
    referral_code: null,
    username: id,
  };
}

function createMergeDb(fixture: MergeDbFixture) {
  const calls: QueryCall[] = [];
  const state = {
    committed: false,
    released: false,
    rolledBack: false,
    sourceTelegramUserId: fixture.sourceTelegramUserId,
    targetTelegramUserId: fixture.targetTelegramUserId,
  };
  const client = {
    async query<T extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: unknown[],
    ): Promise<QueryResult<T>> {
      calls.push({ sql, params });
      const normalized = compactSql(sql);
      if (normalized === "begin") return result<T>();
      if (normalized === "commit") {
        state.committed = true;
        return result<T>();
      }
      if (normalized === "rollback") {
        state.rolledBack = true;
        return result<T>();
      }
      if (normalized.startsWith("select pg_advisory_xact_lock")) {
        return result<T>();
      }
      if (
        normalized.includes("from user_telegram_accounts") &&
        normalized.includes("where user_id = $1")
      ) {
        const userId = params?.[0];
        const telegramUserId =
          userId === "source"
            ? state.sourceTelegramUserId
            : userId === "target"
              ? state.targetTelegramUserId
              : undefined;
        return result<T>(
          telegramUserId
            ? ([{ telegram_user_id: telegramUserId }] as unknown as T[])
            : [],
        );
      }
      if (normalized.startsWith("update user_telegram_accounts")) {
        assert.equal(params?.[0], "target");
        assert.equal(params?.[1], "source");
        assert.equal(state.targetTelegramUserId, undefined);
        const moved = state.sourceTelegramUserId ? 1 : 0;
        state.targetTelegramUserId = state.sourceTelegramUserId;
        state.sourceTelegramUserId = undefined;
        return result<T>([], moved);
      }
      if (normalized.startsWith("update telegram_bot_trading_authorizations")) {
        assert.equal(params?.[0], "target");
        assert.equal(params?.[1], "source");
        return result<T>([], fixture.authRows ?? 0);
      }
      if (
        normalized.startsWith(
          "select count(*)::text as count from telegram_trade_intents",
        )
      ) {
        assert.equal(params?.[0], "source");
        return result<T>([
          { count: String(fixture.intentRows ?? 0) },
        ] as unknown as T[]);
      }
      if (
        normalized.startsWith("select count(*)::text as count") &&
        normalized.includes("from user_asset_funding_preferences source")
      ) {
        return result<T>([
          { count: String(fixture.assetPreferenceConflicts ?? 0) },
        ] as unknown as T[]);
      }
      if (normalized.startsWith("insert into user_asset_funding_preferences")) {
        return result<T>([], fixture.assetPreferenceRows ?? 0);
      }
      if (normalized.startsWith("update telegram_trade_intents")) {
        assert.equal(params?.[0], "target");
        assert.equal(params?.[1], "source");
        return result<T>([], fixture.intentRows ?? 0);
      }
      if (normalized.startsWith("delete from users")) {
        return result<T>([], 1);
      }
      if (normalized.startsWith("update users")) {
        return result<T>([], 1);
      }
      return result<T>();
    },
    release() {
      state.released = true;
    },
  };
  return {
    calls,
    db: {
      async connect() {
        return client;
      },
      async query<T extends QueryResultRow = QueryResultRow>() {
        return result<T>();
      },
    },
    state,
  };
}

function countCalls(calls: QueryCall[], pattern: RegExp): number {
  return calls.filter((call) => pattern.test(compactSql(call.sql))).length;
}

const tests: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: "merge moves source Telegram account, bot authorizations, and intents",
    run: async () => {
      const fake = createMergeDb({
        assetPreferenceConflicts: 1,
        assetPreferenceRows: 2,
        authRows: 2,
        intentRows: 3,
        sourceTelegramUserId: "tg-source",
      });
      const resultValue = await mergeUsers(
        user("source"),
        user("target"),
        { dryRun: false, keepSource: false },
        fake.db as never,
      );

      assert.equal(resultValue.dryRun, false);
      assert.equal(resultValue.summary.telegramAccountsMoved, 1);
      assert.equal(resultValue.summary.telegramAccountsConflictBlocked, 0);
      assert.equal(
        resultValue.summary.telegramBotTradingAuthorizationsMoved,
        2,
      );
      assert.equal(
        resultValue.summary.telegramBotTradingAuthorizationsDropped,
        0,
      );
      assert.equal(resultValue.summary.assetFundingPrefsConflictsReset, 1);
      assert.equal(resultValue.summary.assetFundingPrefsMerged, 2);
      assert.equal(resultValue.summary.telegramTradeIntentsMoved, 3);
      assert.equal(fake.state.committed, true);
      assert.equal(fake.state.rolledBack, false);
      assert.equal(fake.state.released, true);
      assert.equal(countCalls(fake.calls, /^update user_telegram_accounts/), 1);
      assert.equal(
        countCalls(fake.calls, /^update telegram_bot_trading_authorizations/),
        1,
      );
      assert.equal(countCalls(fake.calls, /^update telegram_trade_intents/), 1);
      const preferenceMerge = fake.calls.find((call) =>
        compactSql(call.sql).startsWith(
          "insert into telegram_bot_trading_preferences",
        ),
      );
      assert.ok(preferenceMerge);
      const preferenceSql = compactSql(preferenceMerge.sql);
      assert.match(
        preferenceSql,
        /desired_enabled = telegram_bot_trading_preferences\.desired_enabled and excluded\.desired_enabled/,
      );
      assert.match(preferenceSql, /claim_id = null/);
      const assetPreferenceMerge = fake.calls.find((call) =>
        compactSql(call.sql).startsWith(
          "insert into user_asset_funding_preferences",
        ),
      );
      assert.ok(assetPreferenceMerge);
      const assetPreferenceSql = compactSql(assetPreferenceMerge.sql);
      assert.match(assetPreferenceSql, /else 'ask' end, revision = greatest/);
      assert.equal(
        countCalls(
          fake.calls,
          /^delete from user_asset_funding_preferences where user_id = \$1/,
        ),
        1,
      );
    },
  },
  {
    name: "dry-run reports Telegram moves and rolls back",
    run: async () => {
      const fake = createMergeDb({
        authRows: 1,
        intentRows: 4,
        sourceTelegramUserId: "tg-source",
      });
      const resultValue = await mergeUsers(
        user("source"),
        user("target"),
        { dryRun: true, keepSource: false },
        fake.db as never,
      );

      assert.equal(resultValue.dryRun, true);
      assert.equal(resultValue.summary.telegramAccountsMoved, 1);
      assert.equal(
        resultValue.summary.telegramBotTradingAuthorizationsMoved,
        1,
      );
      assert.equal(resultValue.summary.telegramTradeIntentsMoved, 4);
      assert.equal(fake.state.committed, false);
      assert.equal(fake.state.rolledBack, true);
      assert.equal(fake.state.released, true);
    },
  },
  {
    name: "merge fails closed when both users have different Telegram accounts",
    run: async () => {
      const fake = createMergeDb({
        intentRows: 2,
        sourceTelegramUserId: "tg-source",
        targetTelegramUserId: "tg-target",
      });

      await assert.rejects(
        () =>
          mergeUsers(
            user("source"),
            user("target"),
            { dryRun: false, keepSource: false },
            fake.db as never,
          ),
        /different linked Telegram accounts/,
      );
      assert.equal(fake.state.committed, false);
      assert.equal(fake.state.rolledBack, true);
      assert.equal(fake.state.released, true);
      assert.equal(countCalls(fake.calls, /^update user_telegram_accounts/), 0);
      assert.equal(
        countCalls(fake.calls, /^update telegram_bot_trading_authorizations/),
        0,
      );
      assert.equal(countCalls(fake.calls, /^update telegram_trade_intents/), 0);
    },
  },
  {
    name: "keep-source merge preserves Telegram login rows and intents",
    run: async () => {
      const fake = createMergeDb({
        authRows: 2,
        intentRows: 5,
        sourceTelegramUserId: "tg-source",
      });
      const resultValue = await mergeUsers(
        user("source"),
        user("target"),
        { dryRun: false, keepSource: true },
        fake.db as never,
      );

      assert.equal(resultValue.summary.telegramAccountsMoved, 0);
      assert.equal(resultValue.summary.telegramAccountsConflictBlocked, 1);
      assert.equal(
        resultValue.summary.telegramBotTradingAuthorizationsMoved,
        0,
      );
      assert.equal(resultValue.summary.telegramTradeIntentsMoved, 0);
      assert.equal(
        resultValue.summary.telegramTradeIntentsPreservedWithSource,
        5,
      );
      assert.equal(fake.state.committed, true);
      assert.equal(countCalls(fake.calls, /^update user_telegram_accounts/), 0);
      assert.equal(
        countCalls(fake.calls, /^update telegram_bot_trading_authorizations/),
        0,
      );
      assert.equal(countCalls(fake.calls, /^update telegram_trade_intents/), 0);
      assert.equal(
        countCalls(
          fake.calls,
          /^select count\(\*\)::text as count from telegram_trade_intents/,
        ),
        1,
      );
    },
  },
];

for (const test of tests) {
  await test.run();
  console.log(`[admin-merge-user-tests] ok ${test.name}`);
}
