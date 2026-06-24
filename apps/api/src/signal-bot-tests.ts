import assert from "node:assert/strict";

import type { QueryResult, QueryResultRow } from "pg";

import {
  buildSignalBotMessage,
  buildSignalBotTradeUrl,
  disableSignalBotChat,
  enableSignalBotChat,
  escapeTelegramMarkdownV2,
  getSignalBotChatState,
  handleSignalBotCommand,
  parseSignalBotCommand,
  parseSignalBotConfig,
  publishSignalBotTick,
  resolveSignalBotBuySide,
  sendLatestSignalBotTestSignal,
  type SignalBotNote,
  type SignalBotRedisLike,
  type TelegramSendMessageInput,
  type TelegramSendResult,
} from "./services/signal-bot.js";

class FakeRedis implements SignalBotRedisLike {
  readonly strings = new Map<string, string>();
  readonly hashes = new Map<string, Record<string, string>>();
  readonly sets = new Map<string, Set<string>>();

  async del(key: string): Promise<number> {
    const existed =
      Number(this.strings.delete(key)) +
      Number(this.hashes.delete(key)) +
      Number(this.sets.delete(key));
    return existed;
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    return { ...(this.hashes.get(key) ?? {}) };
  }

  async hSet(key: string, value: Record<string, string>): Promise<number> {
    this.hashes.set(key, {
      ...(this.hashes.get(key) ?? {}),
      ...value,
    });
    return Object.keys(value).length;
  }

  async sAdd(key: string, member: string): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    const existed = set.has(member);
    set.add(member);
    this.sets.set(key, set);
    return existed ? 0 : 1;
  }

  async sMembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? new Set<string>())];
  }

  async sRem(key: string, member: string): Promise<number> {
    return this.sets.get(key)?.delete(member) ? 1 : 0;
  }

  async set(
    key: string,
    value: string,
    options?: { NX?: boolean },
  ): Promise<"OK" | null> {
    if (options?.NX && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return "OK";
  }
}

class FakeTelegram {
  readonly messages: TelegramSendMessageInput[] = [];
  nextResult: TelegramSendResult = { ok: true };

  async getUpdates() {
    return [];
  }

  async sendMessage(
    input: TelegramSendMessageInput,
  ): Promise<TelegramSendResult> {
    this.messages.push(input);
    return this.nextResult;
  }
}

class FakeDb {
  rows: unknown[] = [];

  async query<T extends QueryResultRow = QueryResultRow>(): Promise<QueryResult<T>> {
    return {
      command: "SELECT",
      fields: [],
      oid: 0,
      rowCount: this.rows.length,
      rows: this.rows as T[],
    };
  }
}

function note(overrides: Partial<SignalBotNote> = {}): SignalBotNote {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    noteKey: "holder_research:v1:test",
    title: "Sharp YES interest",
    description: "A capable holder is leaning yes while public news is thin.",
    rationale: "Holder timing adds useful context.",
    producerRunId: "run-1",
    direction: "up",
    confidence: 0.82,
    modelMeta: {
      external_research: {
        summary:
          "Public info followed the holder activity. Later reports may validate the move.",
      },
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    primaryTargetMeta: { side: "YES" },
    marketId: "polymarket:market-1",
    eventId: "polymarket:event-1",
    marketTitle: "Will test resolve Yes?",
    eventTitle: "Test event",
    bestBid: 0.3,
    bestAsk: 0.32,
    lastPrice: null,
    ...overrides,
  };
}

function noteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    note_key: "holder_research:v1:test",
    title: "Sharp YES interest",
    description: "A capable holder is leaning yes while public news is thin.",
    rationale: "Holder timing adds useful context.",
    producer_run_id: "run-1",
    direction: "up",
    confidence: "0.82",
    model_meta: {
      external_research: {
        summary:
          "Public info followed the holder activity. Later reports may validate the move.",
      },
    },
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    primary_target_meta: { side: "YES" },
    market_id: "polymarket:market-1",
    event_id: "polymarket:event-1",
    market_title: "Will test resolve Yes?",
    event_title: "Test event",
    best_bid: "0.30",
    best_ask: "0.32",
    last_price: null,
    ...overrides,
  };
}

const tests: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: "env parser handles admins and default amount buttons",
    run: () => {
      const config = parseSignalBotConfig({
        HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123, 456, nope",
        HUNCH_SIGNAL_BOT_AMOUNTS_USD: "",
        HUNCH_SIGNAL_BOT_ENABLED: "true",
        HUNCH_SIGNAL_BOT_MIN_CONFIDENCE: "0.8",
        HUNCH_SIGNAL_BOT_TOKEN: "token",
      });
      assert.equal(config.enabled, true);
      assert.deepEqual([...config.adminUserIds], [123, 456]);
      assert.deepEqual(config.amountsUsd, [5, 20, 50]);
      assert.equal(config.minConfidence, 0.8);
    },
  },
  {
    name: "command parser accepts bot mentions and ignores other bots",
    run: () => {
      assert.equal(
        parseSignalBotCommand("/enable_signals@HunchSignalBot", "HunchSignalBot"),
        "enable_signals",
      );
      assert.equal(
        parseSignalBotCommand("/enable_signals@OtherBot", "HunchSignalBot"),
        null,
      );
      assert.equal(parseSignalBotCommand("hello", "HunchSignalBot"), null);
    },
  },
  {
    name: "unauthorized user cannot enable chat",
    run: async () => {
      const redis = new FakeRedis();
      const telegram = new FakeTelegram();
      const handled = await handleSignalBotCommand({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        message: {
          chat: { id: -1, title: "Group", type: "group" },
          from: { id: 999 },
          text: "/enable_signals",
        },
        redis,
        sendMessage: (message) => telegram.sendMessage(message),
        sendTestSignal: async () => false,
      });
      assert.equal(handled, true);
      assert.equal(await getSignalBotChatState(redis, "-1"), null);
      assert.match(telegram.messages[0]?.text ?? "", /Not authorized/);
    },
  },
  {
    name: "enable chat initializes cursor to now and disable removes state",
    run: async () => {
      const redis = new FakeRedis();
      const state = await enableSignalBotChat({
        chat: { id: "-100", title: "Signals", type: "supergroup" },
        enabledBy: 123,
        now: new Date("2026-01-01T00:00:00.000Z"),
        redis,
      });
      assert.equal(state.cursorCreatedAt, "2026-01-01T00:00:00.000Z");
      assert.equal(state.cursorId, "00000000-0000-0000-0000-000000000000");
      assert.equal((await getSignalBotChatState(redis, "-100"))?.chatTitle, "Signals");
      await disableSignalBotChat(redis, "-100");
      assert.equal(await getSignalBotChatState(redis, "-100"), null);
    },
  },
  {
    name: "MarkdownV2 escaping protects special characters",
    run: () => {
      assert.equal(
        escapeTelegramMarkdownV2("Will A+B (yes/no)? 31¢."),
        "Will A\\+B \\(yes/no\\)? 31¢\\.",
      );
    },
  },
  {
    name: "trade URL omits amount for primary buy button",
    run: () => {
      const url = buildSignalBotTradeUrl({
        appBaseUrl: "https://app.hunch.trade",
        eventId: "polymarket:event-1",
        marketId: "polymarket:market-1",
        side: "YES",
      });
      const parsed = new URL(url);
      assert.equal(parsed.pathname, "/events/polymarket%3Aevent-1");
      assert.equal(parsed.searchParams.get("market"), "polymarket:market-1");
      assert.equal(parsed.searchParams.get("side"), "YES");
      assert.equal(parsed.searchParams.get("openTrade"), "1");
      assert.equal(parsed.searchParams.has("amountUsd"), false);
    },
  },
  {
    name: "message buttons include primary buy without amount and amount shortcuts",
    run: () => {
      const message = buildSignalBotMessage({
        amountsUsd: [5, 20, 50],
        appBaseUrl: "https://app.hunch.trade",
        note: note(),
      });
      const rows = message.keyboard?.inline_keyboard ?? [];
      assert.equal(rows[0]?.[0]?.text, "🟢 Buy YES 31¢");
      assert.equal(new URL(rows[0]?.[0]?.url ?? "").searchParams.has("amountUsd"), false);
      assert.deepEqual(rows[1]?.map((button) => button.text), [
        "💵 5",
        "💵 20",
        "💵 50",
      ]);
      assert.equal(
        new URL(rows[1]?.[0]?.url ?? "").searchParams.get("amountUsd"),
        "5",
      );
      assert.equal(rows[2]?.[0]?.text, "↗️ Open market");
      assert.match(message.text, /Context: Public info followed the holder activity\\\./);
      assert.doesNotMatch(message.text, /confidence/i);
      assert.match(
        message.text,
        /\[Test event · Will test resolve Yes\? · YES 31¢ \/ NO 69¢\]\(https:\/\/app\.hunch\.trade\/events\/polymarket%3Aevent-1\?/,
      );
    },
  },
  {
    name: "message market line deduplicates matching event and market titles",
    run: () => {
      const message = buildSignalBotMessage({
        amountsUsd: [5],
        appBaseUrl: "https://app.hunch.trade",
        note: note({
          eventTitle: "Same market title",
          marketTitle: " Same   market title ",
        }),
      });
      assert.match(message.text, /Same market title · YES 31¢/);
      assert.doesNotMatch(message.text, /Same market title · Same market title/);
    },
  },
  {
    name: "buy side resolves from target meta before direction fallback",
    run: () => {
      assert.equal(resolveSignalBotBuySide(note({ direction: "down" })), "YES");
      assert.equal(
        resolveSignalBotBuySide(note({ primaryTargetMeta: {}, direction: "down" })),
        "NO",
      );
      assert.equal(
        resolveSignalBotBuySide(note({ primaryTargetMeta: {}, direction: "mixed" })),
        null,
      );
    },
  },
  {
    name: "publish sends new signal once and advances cursor after success",
    run: async () => {
      const redis = new FakeRedis();
      await enableSignalBotChat({
        chat: { id: "-100", title: "Signals", type: "group" },
        enabledBy: 123,
        now: new Date("2025-12-31T00:00:00.000Z"),
        redis,
      });
      const db = new FakeDb();
      db.rows = [noteRow()];
      const telegram = new FakeTelegram();
      const result = await publishSignalBotTick({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        redis,
        telegram,
      });
      assert.equal(result.sent, 1);
      assert.equal(telegram.messages.length, 1);
      assert.equal(telegram.messages[0]?.disable_web_page_preview, false);
      const state = await getSignalBotChatState(redis, "-100");
      assert.equal(state?.cursorCreatedAt, "2026-01-01T00:00:00.000Z");
      assert.equal(state?.cursorId, "00000000-0000-4000-8000-000000000001");
    },
  },
  {
    name: "publish preserves microsecond timestamp cursor precision",
    run: async () => {
      const redis = new FakeRedis();
      await enableSignalBotChat({
        chat: { id: "-100", title: "Signals", type: "group" },
        enabledBy: 123,
        now: new Date("2025-12-31T00:00:00.000Z"),
        redis,
      });
      const db = new FakeDb();
      db.rows = [noteRow({ created_at: "2026-01-01 00:00:00.123456+00" })];
      const telegram = new FakeTelegram();
      const result = await publishSignalBotTick({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        redis,
        telegram,
      });
      assert.equal(result.sent, 1);
      const state = await getSignalBotChatState(redis, "-100");
      assert.equal(state?.cursorCreatedAt, "2026-01-01 00:00:00.123456+00");
    },
  },
  {
    name: "blocked chat disables itself",
    run: async () => {
      const redis = new FakeRedis();
      await enableSignalBotChat({
        chat: { id: "-100", title: "Signals", type: "group" },
        enabledBy: 123,
        now: new Date("2025-12-31T00:00:00.000Z"),
        redis,
      });
      const db = new FakeDb();
      db.rows = [noteRow()];
      const telegram = new FakeTelegram();
      telegram.nextResult = {
        error: "blocked_or_missing",
        message: "blocked",
        ok: false,
      };
      const result = await publishSignalBotTick({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        redis,
        telegram,
      });
      assert.equal(result.blockedChats, 1);
      assert.equal(await getSignalBotChatState(redis, "-100"), null);
    },
  },
  {
    name: "test signal sends latest signal without touching chat cursor",
    run: async () => {
      const redis = new FakeRedis();
      await enableSignalBotChat({
        chat: { id: "-100", title: "Signals", type: "group" },
        enabledBy: 123,
        now: new Date("2026-01-01T00:00:00.000Z"),
        redis,
      });
      const before = await getSignalBotChatState(redis, "-100");
      const db = new FakeDb();
      db.rows = [noteRow({ id: "00000000-0000-4000-8000-000000000099" })];
      const telegram = new FakeTelegram();
      const sent = await sendLatestSignalBotTestSignal({
        chatId: "-100",
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        telegram,
      });
      assert.equal(sent, true);
      assert.deepEqual(await getSignalBotChatState(redis, "-100"), before);
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.run();
    passed += 1;
  } catch (error) {
    console.error(`[signal-bot-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(`[signal-bot-tests] passed ${passed}/${tests.length}`);
