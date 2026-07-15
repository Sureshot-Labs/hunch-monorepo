import assert from "node:assert/strict";

import {
  buildSignalBotMenuScreen,
  handleSignalBotMenuCallback,
  parseSignalBotConfig,
} from "./services/signal-bot.js";
import { buildTelegramActivityNotificationMessage } from "./services/telegram-notification-delivery.js";
import { buildPositionResolutionFacts } from "./services/positions-notifications.js";
import { runPositionResolutionNotificationProducer } from "./services/position-resolution-producer.js";

const tests: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: "resolution facts distinguish binary wins, losses, and scalar settlement",
    run: () => {
      assert.equal(
        buildPositionResolutionFacts({
          outcomeSide: "YES",
          resolvedOutcome: "YES",
          resolvedOutcomePct: null,
        })?.result,
        "won",
      );
      assert.equal(
        buildPositionResolutionFacts({
          outcomeSide: "NO",
          resolvedOutcome: "YES",
          resolvedOutcomePct: null,
        })?.result,
        "lost",
      );
      assert.deepEqual(
        buildPositionResolutionFacts({
          outcomeSide: "YES",
          resolvedOutcome: null,
          resolvedOutcomePct: "3750",
        }),
        {
          outcomeSide: "YES",
          resolvedOutcome: null,
          resolvedOutcomePct: 3750,
          result: "settled",
        },
      );
    },
  },
  {
    name: "settled Telegram copy stays neutral and uses safe portfolio CTA",
    run: () => {
      const message = buildTelegramActivityNotificationMessage({
        market: {
          eventId: "event-1",
          marketId: "market-1",
          side: "YES",
          title: "Scalar market",
        },
        miniAppLinkBase: "https://t.me/hunch_bot/hunch",
        payload: {
          body: "The market settled with a scalar result",
          data: { outcomeSide: "YES", result: "settled" },
          title: "Position settled",
          type: "position_resolved",
        },
      });
      assert.match(message?.text ?? "", /position settled/i);
      assert.doesNotMatch(message?.text ?? "", /claim|payout|profit/i);
      assert.equal(
        message?.keyboard?.inline_keyboard[0]?.[0]?.text,
        "View position",
      );
    },
  },
  {
    name: "resolution producer is cutoff-gated and keeps notification when sync fails",
    run: async () => {
      let released = false;
      let syncCalls = 0;
      const client = {
        query: async (sql: string, params: unknown[] = []) => {
          if (sql.includes("pg_try_advisory_lock")) {
            return { rows: [{ acquired: true }] };
          }
          if (sql.includes("from unified_markets market")) {
            assert.equal(params[0], "2026-07-15T12:00:00.000Z");
            assert.match(sql, /resolution_observed_at >= \$1/);
            assert.match(sql, /not exists/);
            return {
              rows: [
                {
                  id: "position-1",
                  market_id: "market-1",
                  outcome_side: "YES",
                  position_snapshot_at: "2026-07-15T11:59:00.000Z",
                  resolved_outcome: "YES",
                  resolved_outcome_pct: null,
                  token_id: "token-1",
                  user_id: "user-1",
                  venue: "polymarket",
                  wallet_address: "0x0000000000000000000000000000000000000001",
                },
              ],
            };
          }
          if (sql.includes("pg_advisory_unlock")) {
            released = true;
            return { rows: [] };
          }
          throw new Error(`unexpected SQL: ${sql}`);
        },
        release: () => undefined,
      };
      const summary = await runPositionResolutionNotificationProducer({
        allowsLifecycle: async () => true,
        createNotification: async () => ({ id: "notification-1" }) as never,
        pool: {
          connect: async () => client,
        } as never,
        resolvePolicy: async () => ({
          effectiveAt: "2026-07-15T12:00:00.000Z",
          invalidOverride: false,
          policy: {
            activityEnqueueEnabled: false,
            deliveryEnabled: false,
            positionResolutionProducerEnabled: true,
            positionSignalEnqueueEnabled: false,
            version: 1,
          },
          source: "db",
        }),
        syncPositions: async () => {
          syncCalls += 1;
          throw new Error("venue unavailable");
        },
      });
      assert.equal(summary.notificationsCreated, 1);
      assert.equal(summary.syncFailed, 1);
      assert.equal(syncCalls, 1);
      assert.equal(released, true);
    },
  },
  {
    name: "My positions is a single refresh-and-render menu action",
    run: async () => {
      const config = parseSignalBotConfig({
        HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE:
          "https://t.me/hunch_bot/hunch",
        HUNCH_SIGNAL_BOT_TOKEN: "token",
      });
      const home = buildSignalBotMenuScreen({
        appBaseUrl: config.appBaseUrl,
        isAdmin: false,
        miniAppEnabled: true,
        screen: "home",
      });
      assert.equal(
        home.keyboard.inline_keyboard
          .flat()
          .some(
            (button) =>
              "callback_data" in button &&
              button.callback_data === "hm:v1:positions",
          ),
        true,
      );

      const edits: string[] = [];
      let loads = 0;
      const handled = await handleSignalBotMenuCallback({
        callbackQuery: {
          data: "hm:v1:positions",
          from: { id: 99 },
          id: "positions-callback",
          message: {
            chat: { id: 99, type: "private" },
            message_id: 10,
          },
        },
        config,
        loadPositions: async () => {
          loads += 1;
          return {
            parse_mode: "MarkdownV2",
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "Open portfolio",
                    url: "https://app.hunch.trade/portfolio",
                  },
                ],
              ],
            },
            text: "*💼 My positions*\n\nNo open positions\\.",
          };
        },
        redis: {
          del: async () => 0,
          get: async () => null,
          set: async () => null,
        } as never,
        sendTestSignal: async () => false,
        telegram: {
          answerCallbackQuery: async () => ({ ok: true }),
          editMessageText: async (input: {
            message_id: number;
            text: string;
          }) => {
            edits.push(input.text);
            return { messageId: input.message_id, ok: true };
          },
          sendMessage: async () => ({ messageId: 11, ok: true }),
        } as never,
      });
      assert.equal(handled, true);
      assert.equal(loads, 1);
      assert.match(edits[0] ?? "", /Updating positions/);
      assert.match(edits.at(-1) ?? "", /No open positions/);
      assert.equal(edits.length, 2);
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

console.log(`[position-notification-tests] passed ${passed}/${tests.length}`);
