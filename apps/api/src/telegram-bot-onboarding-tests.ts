import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { deliverTelegramBotOnboardingActions } from "./services/telegram-bot-onboarding-delivery.js";

const config = {
  adminUserIds: new Set<number>(),
  appBaseUrl: "https://app.hunch.trade",
  telegramMiniAppLinkBase: "https://t.me/hunch_bot/hunch",
};

const outboxRow = {
  attempt_count: 1,
  id: "action-1",
  telegram_account_id: "telegram-account-1",
  telegram_user_id: "999",
  user_id: "user-1",
};

const tests: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: "Telegram account insertion atomically enqueues one welcome menu",
    run: () => {
      const source = readFileSync(
        new URL(
          "../../../packages/db/migrations/0182_telegram_bot_action_outbox.sql",
          import.meta.url,
        ),
        "utf8",
      );
      assert.match(source, /UNIQUE \(telegram_account_id, action\)/);
      assert.match(
        source,
        /CREATE TRIGGER enqueue_telegram_welcome_menu_on_link\s+AFTER INSERT ON user_telegram_accounts/,
      );
      assert.match(
        source,
        /ON CONFLICT \(telegram_account_id, action\) DO NOTHING/,
      );
    },
  },
  {
    name: "onboarding delivery claims safely and sends the linked welcome menu",
    run: async () => {
      const queries: Array<{ params: unknown[]; sql: string }> = [];
      const sentMessages: Array<Record<string, unknown>> = [];
      const db = {
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ params, sql });
          if (sql.includes("with candidates as")) {
            return { rows: [outboxRow] };
          }
          if (sql.includes("select account.telegram_user_id")) {
            return { rows: [{ telegram_user_id: "999" }] };
          }
          return { rows: [] };
        },
      } as never;

      const result = await deliverTelegramBotOnboardingActions({
        config,
        db,
        telegram: {
          sendMessage: async (message) => {
            sentMessages.push(message);
            return { messageId: 123, ok: true };
          },
        },
      });

      assert.deepEqual(result, {
        blocked: 0,
        claimed: 1,
        failed: 0,
        sent: 1,
        skipped: 0,
      });
      assert.match(queries[0]?.sql ?? "", /for update skip locked/i);
      assert.deepEqual(queries[1]?.params, [
        "telegram-account-1",
        "user-1",
        "999",
      ]);
      assert.match(String(sentMessages[0]?.text ?? ""), /Welcome to Hunch/);
      assert.equal(sentMessages[0]?.chat_id, "999");
      assert.equal(
        queries.some(
          ({ params, sql }) =>
            sql.includes("status = 'sent'") && params[1] === 123,
        ),
        true,
      );
    },
  },
  {
    name: "onboarding delivery skips a replaced Telegram account link",
    run: async () => {
      const updates: string[] = [];
      let sends = 0;
      const result = await deliverTelegramBotOnboardingActions({
        config,
        db: {
          query: async (sql: string) => {
            if (sql.includes("with candidates as")) {
              return { rows: [outboxRow] };
            }
            if (sql.includes("select account.telegram_user_id")) {
              return { rows: [] };
            }
            updates.push(sql);
            return { rows: [] };
          },
        } as never,
        telegram: {
          sendMessage: async () => {
            sends += 1;
            return { messageId: 123, ok: true };
          },
        },
      });

      assert.equal(sends, 0);
      assert.equal(result.skipped, 1);
      assert.equal(
        updates.some((sql) => sql.includes("status = 'skipped'")),
        true,
      );
    },
  },
  {
    name: "blocked welcome delivery becomes terminal and marks notifications unreachable",
    run: async () => {
      const queries: Array<{ params: unknown[]; sql: string }> = [];
      const result = await deliverTelegramBotOnboardingActions({
        config,
        db: {
          query: async (sql: string, params: unknown[] = []) => {
            queries.push({ params, sql });
            if (sql.includes("with candidates as")) {
              return { rows: [outboxRow] };
            }
            if (sql.includes("select account.telegram_user_id")) {
              return { rows: [{ telegram_user_id: "999" }] };
            }
            return { rows: [] };
          },
        } as never,
        telegram: {
          sendMessage: async () => ({
            error: "blocked_or_missing",
            message: "bot was blocked",
            ok: false,
          }),
        },
      });

      assert.equal(result.blocked, 1);
      assert.equal(
        queries.some(({ sql }) => sql.includes("set reachable = false")),
        true,
      );
      assert.equal(
        queries.some(
          ({ params, sql }) =>
            sql.includes("status = 'dead'") && params[1] === "bot was blocked",
        ),
        true,
      );
    },
  },
  {
    name: "transient welcome delivery uses bounded retry scheduling",
    run: async () => {
      const queries: Array<{ params: unknown[]; sql: string }> = [];
      const result = await deliverTelegramBotOnboardingActions({
        config,
        db: {
          query: async (sql: string, params: unknown[] = []) => {
            queries.push({ params, sql });
            if (sql.includes("with candidates as")) {
              return { rows: [{ ...outboxRow, attempt_count: 2 }] };
            }
            if (sql.includes("select account.telegram_user_id")) {
              return { rows: [{ telegram_user_id: "999" }] };
            }
            return { rows: [] };
          },
        } as never,
        telegram: {
          sendMessage: async () => ({
            error: "other",
            message: "rate limited",
            ok: false,
            retryAfterSec: 17,
          }),
        },
      });

      assert.equal(result.failed, 1);
      assert.equal(
        queries.some(
          ({ params, sql }) =>
            sql.includes("next_attempt_at") &&
            params[1] === "retry" &&
            params[3] === 17,
        ),
        true,
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
    console.error(`[telegram-bot-onboarding-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(`[telegram-bot-onboarding-tests] passed ${passed}/${tests.length}`);
