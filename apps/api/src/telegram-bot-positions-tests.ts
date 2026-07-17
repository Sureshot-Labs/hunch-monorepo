import assert from "node:assert/strict";

import type { Position } from "./order-types.js";
import {
  buildTelegramPositionDetail,
  buildTelegramPositionsSnapshotMessage,
  runTelegramPositionSyncTasks,
  type TelegramPositionDetail,
  type TelegramPositionSyncRedis,
} from "./services/telegram-bot-positions.js";
import {
  TELEGRAM_INLINE_BUTTON_GRAPHEME_LIMIT,
  TELEGRAM_MESSAGE_PAYLOAD_BUDGET,
  telegramPayloadLength,
} from "./services/telegram-bot-text-budget.js";

function position(overrides: Partial<Position> = {}): Position {
  const now = new Date("2026-07-15T10:00:00.000Z");
  return {
    averagePrice: 0.25,
    createdAt: now,
    id: crypto.randomUUID(),
    lastUpdatedAt: now,
    realizedPnl: 0,
    side: "LONG",
    size: 4,
    tokenId: crypto.randomUUID(),
    unrealizedPnl: 0,
    updatedAt: now,
    userId: "user-1",
    venue: "polymarket",
    walletAddress: "0x1111111111111111111111111111111111111111",
    ...overrides,
  };
}

function detail(overrides: Partial<TelegramPositionDetail> = {}) {
  const source = position();
  return {
    averagePrice: 0.25,
    currentValueUsd: 1.4,
    eventId: crypto.randomUUID(),
    marketId: crypto.randomUUID(),
    marketOrderable: true,
    marketTitle: "Spain wins the World Cup",
    markPrice: 0.35,
    pnlPercent: 40,
    pnlUsd: 0.4,
    position: source,
    redemptionStatus: "market_open",
    side: "YES" as const,
    ...overrides,
  } satisfies TelegramPositionDetail;
}

function successfulSyncResult() {
  return {
    flattenedPositions: 0,
    heldTokens: 1,
    knownTokens: 1,
    upsertedPositions: 1,
    venue: "polymarket" as const,
    walletAddress: "0x1111111111111111111111111111111111111111",
  };
}

class FakeCooldownRedis implements TelegramPositionSyncRedis {
  readonly entries = new Map<string, { expiresIn: number; value: string }>();
  readonly writes: Array<{ key: string; options: unknown; value: string }> = [];

  async get(key: string): Promise<string | null> {
    return this.entries.get(key)?.value ?? null;
  }

  async set(
    key: string,
    value: string,
    options?: { EX?: number; NX?: boolean; XX?: boolean },
  ): Promise<unknown> {
    this.writes.push({ key, options, value });
    if (options?.NX && this.entries.has(key)) return null;
    if (options?.XX && !this.entries.has(key)) return null;
    this.entries.set(key, { expiresIn: options?.EX ?? 0, value });
    return "OK";
  }
}

const tests: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: "missing market metadata preserves the holding and canonical outcome side",
    run: () => {
      const source = position();
      const result = buildTelegramPositionDetail(source, undefined, "NO");
      assert.equal(result.marketId, null);
      assert.equal(result.eventId, null);
      assert.equal(result.marketTitle, "Polymarket position");
      assert.equal(result.side, "NO");
      assert.equal(result.position.id, source.id);
      assert.equal(result.redemptionStatus, "metadata_unavailable");

      const message = buildTelegramPositionsSnapshotMessage({
        appBaseUrl: "https://app.hunch.trade",
        snapshot: { partialFailure: false, positions: [result] },
        telegramMiniAppEnabled: true,
      });
      assert.match(message.text, /Details unavailable/);
      assert.match(message.text, /Valuation coverage: 0\/1/);
      assert.equal(message.reply_markup?.inline_keyboard.length, 1);
    },
  },
  {
    name: "position summary reports aggregate PnL and respects Telegram budgets",
    run: () => {
      const longTitle = "🏆".repeat(300);
      const positions = Array.from({ length: 8 }, (_, index) =>
        detail({
          marketTitle: `${longTitle}${index}`,
          pnlUsd: index % 2 === 0 ? 0.4 : -0.1,
        }),
      );
      const message = buildTelegramPositionsSnapshotMessage({
        appBaseUrl: "https://app.hunch.trade",
        snapshot: { partialFailure: false, positions },
        telegramMiniAppEnabled: true,
      });
      assert.match(message.text, /Portfolio value/);
      assert.match(message.text, /PnL:/);
      assert.ok(
        telegramPayloadLength(message.text) <= TELEGRAM_MESSAGE_PAYLOAD_BUDGET,
      );
      const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
      for (const row of message.reply_markup?.inline_keyboard ?? []) {
        for (const button of row) {
          assert.ok(
            Array.from(segmenter.segment(button.text)).length <=
              TELEGRAM_INLINE_BUTTON_GRAPHEME_LIMIT,
          );
        }
      }
    },
  },
  {
    name: "Redis outage makes position refresh cached-only",
    run: async () => {
      let syncCalls = 0;
      const result = await runTelegramPositionSyncTasks({
        cooldownSec: 60,
        pool: {} as never,
        redis: null,
        syncPosition: async () => {
          syncCalls += 1;
          return successfulSyncResult();
        },
        tasks: [
          {
            venue: "polymarket",
            walletAddress: "0x1111111111111111111111111111111111111111",
          },
        ],
        userId: "user-1",
        venueAllowed: async () => true,
      });
      assert.equal(syncCalls, 0);
      assert.equal(result.partialFailure, true);
    },
  },
  {
    name: "position sync lock prevents duplicate venue requests",
    run: async () => {
      const redis = new FakeCooldownRedis();
      const key =
        "positions:sync:user-1:0x1111111111111111111111111111111111111111:polymarket";
      redis.entries.set(key, { expiresIn: 60, value: "another-attempt" });
      let syncCalls = 0;
      const result = await runTelegramPositionSyncTasks({
        cooldownSec: 60,
        pool: {} as never,
        redis,
        syncPosition: async () => {
          syncCalls += 1;
          return successfulSyncResult();
        },
        tasks: [
          {
            venue: "polymarket",
            walletAddress: "0x1111111111111111111111111111111111111111",
          },
        ],
        userId: "user-1",
        venueAllowed: async () => true,
      });
      assert.equal(syncCalls, 0);
      assert.equal(result.partialFailure, false);
      assert.equal(redis.entries.get(key)?.value, "another-attempt");
    },
  },
  {
    name: "failed position sync keeps only a short owned backoff",
    run: async () => {
      const redis = new FakeCooldownRedis();
      const result = await runTelegramPositionSyncTasks({
        cooldownSec: 120,
        pool: {} as never,
        redis,
        syncPosition: async () => {
          throw new Error("upstream unavailable");
        },
        tasks: [
          {
            venue: "polymarket",
            walletAddress: "0x1111111111111111111111111111111111111111",
          },
        ],
        userId: "user-1",
        venueAllowed: async () => true,
      });
      assert.equal(result.partialFailure, true);
      assert.equal(redis.writes.length, 2);
      assert.equal(
        redis.writes[1]?.options &&
          (redis.writes[1].options as { EX: number }).EX,
        30,
      );
    },
  },
  {
    name: "zero cooldown explicitly refreshes without Redis",
    run: async () => {
      let syncCalls = 0;
      const result = await runTelegramPositionSyncTasks({
        cooldownSec: 0,
        pool: {} as never,
        redis: null,
        syncPosition: async () => {
          syncCalls += 1;
          return successfulSyncResult();
        },
        tasks: [
          {
            venue: "polymarket",
            walletAddress: "0x1111111111111111111111111111111111111111",
          },
        ],
        userId: "user-1",
        venueAllowed: async () => true,
      });
      assert.equal(result.partialFailure, false);
      assert.equal(syncCalls, 1);
    },
  },
];

for (const test of tests) {
  try {
    await test.run();
    console.log(`✓ ${test.name}`);
  } catch (error) {
    console.error(`✗ ${test.name}`);
    throw error;
  }
}
