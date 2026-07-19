import assert from "node:assert/strict";

import {
  configureSignalBotTelegramUi,
  handleSignalBotCommand,
  parseSignalBotConfig,
  type SignalBotRedisLike,
} from "./services/signal-bot.js";
import {
  buildTelegramActivityNotificationMessage,
  cleanupTelegramNotificationOutbox,
  deliverTelegramNotificationOutbox,
  enqueueTelegramActivityNotifications,
} from "./services/telegram-notification-delivery.js";
import { TELEGRAM_CUSTOM_EMOJI } from "./services/telegram-custom-emoji.js";
import {
  clearTelegramNotificationsPolicyCache,
  DEFAULT_TELEGRAM_NOTIFICATIONS_POLICY,
  resolveTelegramNotificationsPolicy,
} from "./services/telegram-notification-policy.js";
import { ensureTelegramNotificationPreferences } from "./services/telegram-notification-preferences.js";

const tests: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: "notification policy defaults fail closed when no row exists",
    run: async () => {
      const db = { query: async () => ({ rows: [] }) } as never;
      clearTelegramNotificationsPolicyCache();
      const resolved = await resolveTelegramNotificationsPolicy(db);
      assert.deepEqual(resolved.policy, DEFAULT_TELEGRAM_NOTIFICATIONS_POLICY);
      assert.equal(resolved.source, "default");
      assert.equal(resolved.invalidOverride, false);
    },
  },
  {
    name: "notification policy accepts only the exact V1 payload",
    run: async () => {
      const effectiveAt = "2026-07-15T10:00:00.000Z";
      const db = {
        query: async () => ({
          rows: [
            {
              created_at: new Date(effectiveAt),
              created_by: null,
              effective_at: effectiveAt,
              id: "policy-1",
              payload: {
                activityEnqueueEnabled: true,
                deliveryEnabled: false,
                positionSignalEnqueueEnabled: false,
                version: 1,
              },
              policy_key: "telegram_notifications",
            },
          ],
        }),
      } as never;
      clearTelegramNotificationsPolicyCache();
      const resolved = await resolveTelegramNotificationsPolicy(db);
      assert.equal(resolved.source, "db");
      assert.equal(resolved.effectiveAt, effectiveAt);
      assert.equal(resolved.policy.activityEnqueueEnabled, true);
      assert.equal(resolved.policy.positionResolutionProducerEnabled, false);

      const invalidDb = {
        query: async () => ({
          rows: [
            {
              created_at: new Date(effectiveAt),
              created_by: null,
              effective_at: new Date(effectiveAt),
              id: "policy-2",
              payload: {
                ...resolved.policy,
                unexpectedPermission: true,
              },
              policy_key: "telegram_notifications",
            },
          ],
        }),
      } as never;
      const invalid = await resolveTelegramNotificationsPolicy(invalidDb);
      assert.equal(invalid.invalidOverride, true);
      assert.deepEqual(invalid.policy, DEFAULT_TELEGRAM_NOTIFICATIONS_POLICY);
    },
  },
  {
    name: "only an explicit start request marks preferences reachable",
    run: async () => {
      const paramsSeen: unknown[][] = [];
      const db = {
        query: async (_sql: string, params: unknown[] = []) => {
          paramsSeen.push(params);
          return {
            rows: [
              {
                bridge_updates: true,
                deposit_received: true,
                order_filled: true,
                order_issues: true,
                payouts_rewards: true,
                position_resolved: true,
                position_signals: false,
                reachable: Boolean(params[1]),
                user_id: "user-1",
              },
            ],
          };
        },
      } as never;
      const passive = await ensureTelegramNotificationPreferences({
        db,
        telegramUserId: 99,
      });
      const started = await ensureTelegramNotificationPreferences({
        db,
        markStarted: true,
        telegramUserId: 99,
      });
      assert.equal(passive?.reachable, false);
      assert.equal(started?.reachable, true);
      assert.deepEqual(paramsSeen, [
        ["99", false],
        ["99", true],
      ]);
    },
  },
  {
    name: "menu and settings commands do not impersonate an explicit start",
    run: async () => {
      const preferenceWrites: unknown[][] = [];
      const db = {
        query: async (sql: string, params: unknown[] = []) => {
          if (sql.includes("select exists (")) {
            assert.deepEqual(params, ["99"]);
            return { rows: [{ linked: true }] };
          }
          preferenceWrites.push(params);
          return {
            rows: [
              {
                bridge_updates: true,
                deposit_received: true,
                order_filled: true,
                order_issues: true,
                payouts_rewards: true,
                position_resolved: true,
                position_signals: false,
                reachable: true,
                user_id: "user-1",
              },
            ],
          };
        },
      } as never;
      const redis: SignalBotRedisLike = {
        del: async () => 0,
        eval: async () => null,
        get: async () => null,
        hGetAll: async () => ({}),
        hSet: async () => 0,
        sAdd: async () => 0,
        sMembers: async () => [],
        sRem: async () => 0,
        set: async () => null,
      };
      const config = parseSignalBotConfig({
        HUNCH_SIGNAL_BOT_TOKEN: "token",
      });
      for (const command of ["/menu", "/settings", "/start"]) {
        await handleSignalBotCommand({
          config,
          db,
          message: {
            chat: { id: 99, type: "private" },
            from: { id: 99 },
            text: command,
          },
          redis,
          sendMessage: async () => ({ messageId: 1, ok: true }),
          sendTestSignal: async () => false,
        });
      }
      assert.deepEqual(preferenceWrites, [["99", true]]);
    },
  },
  {
    name: "first activity cursor starts at now without replaying history",
    run: async () => {
      const queries: string[] = [];
      const client = {
        query: async (sql: string) => {
          queries.push(sql);
          if (sql.includes("returning consumer_key")) {
            return { rowCount: 1, rows: [{ consumer_key: "cursor" }] };
          }
          return { rows: [] };
        },
        release: () => undefined,
      };
      const enqueued = await enqueueTelegramActivityNotifications({
        pool: { connect: async () => client } as never,
      });
      assert.equal(enqueued, 0);
      assert.equal(
        queries.some((sql) => sql.includes("with candidates as materialized")),
        false,
      );
      assert.equal(
        queries.some((sql) => /^\s*commit\s*$/i.test(sql)),
        true,
      );
    },
  },
  {
    name: "activity cursor uses immutable creation identity",
    run: async () => {
      const queries: string[] = [];
      const client = {
        query: async (sql: string) => {
          queries.push(sql);
          if (sql.includes("returning consumer_key")) {
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes("for update")) {
            return {
              rows: [
                {
                  cursor_created_at: "2026-01-01T00:00:00.000Z",
                  cursor_id: "00000000-0000-0000-0000-000000000000",
                },
              ],
            };
          }
          if (sql.includes("with candidates as materialized")) {
            return {
              rows: [{ enqueued: 0, last_created_at: null, last_id: null }],
            };
          }
          return { rows: [] };
        },
        release: () => undefined,
      };
      await enqueueTelegramActivityNotifications({
        pool: { connect: async () => client } as never,
      });
      const candidateSql = queries.find((sql) =>
        sql.includes("with candidates as materialized"),
      );
      assert.match(candidateSql ?? "", /n\.created_at/);
      assert.doesNotMatch(candidateSql ?? "", /n\.updated_at/);
      assert.match(candidateSql ?? "", /event_occurred_at/);
      assert.match(candidateSql ?? "", /last_candidate\.created_at::text/);
    },
  },
  {
    name: "Telegram-origin fill is skipped after its terminal receipt was delivered",
    run: async () => {
      const queries: string[] = [];
      const result = await deliverTelegramNotificationOutbox({
        db: {
          query: async (sql: string) => {
            queries.push(sql);
            if (sql.includes("with candidates")) {
              return {
                rows: [
                  {
                    attempt_count: 1,
                    id: "outbox-telegram-trade",
                    payload: {
                      data: {
                        source: "telegram_bot",
                        sourceIntentId: "11111111-1111-4111-8111-111111111111",
                      },
                      title: "Order filled",
                      type: "order_filled",
                    },
                    topic: "order_filled",
                    user_id: "user-1",
                  },
                ],
              };
            }
            if (sql.includes("from telegram_trade_intents")) {
              return { rows: [{ delivered: true }] };
            }
            return { rowCount: 1, rows: [] };
          },
        } as never,
        miniAppLinkBase: null,
        telegram: {
          sendMessage: async () => {
            throw new Error("generic fill must not be sent");
          },
        },
      });
      assert.equal(result.skipped, 1);
      assert.equal(result.sent, 0);
      assert.match(queries[0] ?? "", /interval '30 seconds'/);
      assert.equal(
        queries.some(
          (sql) =>
            sql.includes("status = 'skipped'") &&
            sql.includes("last_error = $2"),
        ),
        true,
      );
    },
  },
  {
    name: "delivery recheck skips events older than a re-enabled topic",
    run: async () => {
      const updates: string[] = [];
      const result = await deliverTelegramNotificationOutbox({
        db: {
          query: async (sql: string) => {
            if (sql.includes("with candidates")) {
              return {
                rows: [
                  {
                    attempt_count: 1,
                    id: "outbox-1",
                    payload: { title: "Old fill", type: "order_filled" },
                    topic: "order_filled",
                    user_id: "user-1",
                  },
                ],
              };
            }
            if (sql.includes("case outbox.topic")) {
              return {
                rows: [
                  {
                    enabled: true,
                    enabled_since_event: false,
                    reachable: true,
                    telegram_user_id: "99",
                  },
                ],
              };
            }
            updates.push(sql);
            return { rows: [] };
          },
        } as never,
        miniAppLinkBase: null,
        telegram: {
          sendMessage: async () => {
            throw new Error("send must not be called");
          },
        },
      });
      assert.equal(result.skipped, 1);
      assert.equal(result.sent, 0);
      assert.equal(
        updates.some(
          (sql) =>
            /status = 'skipped'/.test(sql) && /last_error = \$2/.test(sql),
        ),
        true,
      );
    },
  },
  {
    name: "activity copy distinguishes SELL proceeds and safe legacy fills",
    run: () => {
      const market = {
        eventId: "polymarket:event-1",
        marketId: "polymarket:market-1",
        side: "YES" as const,
        title: "Will it happen?",
      };
      const sell = buildTelegramActivityNotificationMessage({
        market,
        miniAppLinkBase: "https://t.me/hunch_bot/hunch",
        payload: {
          data: {
            action: "SELL",
            outcomeSide: "YES",
            price: 0.4,
            size: 2,
            venue: "polymarket",
          },
          title: "Order filled",
          type: "order_filled",
        },
      });
      assert.match(sell?.text ?? "", /SELL · YES/);
      assert.ok((sell?.text ?? "").includes("Estimated proceeds: $0\\.80"));
      assert.doesNotMatch(sell?.text ?? "", /cost/i);
      assert.match(
        sell?.text ?? "",
        new RegExp(TELEGRAM_CUSTOM_EMOJI.polymarket.id),
      );
      assert.equal(
        sell?.keyboard?.inline_keyboard[0]?.[0]?.icon_custom_emoji_id,
        TELEGRAM_CUSTOM_EMOJI.polymarket.id,
      );

      const legacy = buildTelegramActivityNotificationMessage({
        market,
        miniAppLinkBase: null,
        payload: {
          data: { price: 0.4, side: "YES", size: 2 },
          title: "Order filled",
          type: "order_filled",
        },
      });
      assert.ok(
        (legacy?.text ?? "").includes("Estimated filled value: $0\\.80"),
      );

      const resolved = buildTelegramActivityNotificationMessage({
        market,
        miniAppLinkBase: "https://t.me/hunch_bot/hunch",
        payload: {
          body: "Claim available",
          data: { result: "won", venue: "kalshi" },
          title: "Position resolved",
          type: "position_resolved",
        },
      });
      assert.equal(
        resolved?.keyboard?.inline_keyboard[0]?.[0]?.text,
        "View position",
      );
      assert.equal(
        resolved?.keyboard?.inline_keyboard[0]?.[0]?.icon_custom_emoji_id,
        TELEGRAM_CUSTOM_EMOJI.kalshi.id,
      );

      const deposit = buildTelegramActivityNotificationMessage({
        market: null,
        miniAppLinkBase: "https://t.me/hunch_bot/hunch",
        payload: {
          body: "250 USDC deposit received on Polygon",
          data: { amountLabel: "250 USDC", network: "Polygon" },
          title: "Deposit received",
          type: "deposit_received",
        },
      });
      assert.equal(deposit?.keyboard, undefined);
      assert.match(
        deposit?.text ?? "",
        new RegExp(TELEGRAM_CUSTOM_EMOJI.usdc.id),
      );
      assert.match(
        deposit?.text ?? "",
        new RegExp(TELEGRAM_CUSTOM_EMOJI.polygon.id),
      );

      const reward = buildTelegramActivityNotificationMessage({
        market: null,
        miniAppLinkBase: null,
        payload: {
          body: "$12.00 on Base",
          data: { amountUsd: 12, chainId: "eip155:8453" },
          title: "Cashback paid out",
          type: "reward_claim_confirmed",
        },
      });
      assert.match(
        reward?.text ?? "",
        new RegExp(TELEGRAM_CUSTOM_EMOJI.usdc.id),
      );
      assert.match(
        reward?.text ?? "",
        new RegExp(TELEGRAM_CUSTOM_EMOJI.base.id),
      );
    },
  },
  {
    name: "cleanup deletes only terminal outbox rows after retention",
    run: async () => {
      let capturedSql = "";
      let capturedParams: unknown[] = [];
      const deleted = await cleanupTelegramNotificationOutbox({
        db: {
          query: async (sql: string, params: unknown[] = []) => {
            capturedSql = sql;
            capturedParams = params;
            return { rowCount: 7, rows: [] };
          },
        } as never,
      });
      assert.equal(deleted, 7);
      assert.match(capturedSql, /status in \('sent', 'skipped', 'dead'\)/);
      assert.doesNotMatch(capturedSql, /status in \('pending'/);
      assert.deepEqual(capturedParams, [90, 1000]);
    },
  },
  {
    name: "Telegram UI setup isolates one invalid admin scope",
    run: async () => {
      const operations: string[] = [];
      const result = await configureSignalBotTelegramUi({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123,456",
          HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE:
            "https://t.me/hunch_bot/hunch",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        telegram: {
          setChatMenuButton: async () => {
            operations.push("menu");
          },
          setMyCommands: async (input) => {
            const scope = input.scope;
            if (scope?.type === "chat" && scope.chat_id === 123) {
              throw new Error("bad chat id");
            }
            operations.push(
              scope?.type === "chat" ? `admin:${scope.chat_id}` : "private",
            );
          },
        },
      });
      assert.deepEqual(operations, ["private", "admin:456", "menu"]);
      assert.equal(result.configured, 3);
      assert.deepEqual(result.failures, [
        { error: "bad chat id", operation: "commands:admin:123" },
      ]);
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.run();
    passed += 1;
  } catch (error) {
    console.error(`[telegram-notification-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(`[telegram-notification-tests] passed ${passed}/${tests.length}`);
