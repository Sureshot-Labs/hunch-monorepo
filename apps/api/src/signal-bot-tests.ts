import assert from "node:assert/strict";

import type { QueryResult, QueryResultRow } from "pg";

import {
  acquireSignalBotLock,
  buildSignalBotHolderUrl,
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
  refreshSignalBotLock,
  releaseSignalBotLock,
  resolveSignalBotBuySide,
  sendLatestSignalBotTestSignal,
  signalBotLockKey,
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

  async eval(
    script: string,
    options: { arguments: string[]; keys: string[] },
  ): Promise<number> {
    const key = options.keys[0] ?? "";
    const owner = options.arguments[0] ?? "";
    const current = this.strings.get(key);
    if (script.includes("DEL")) {
      if (current !== owner) return 0;
      this.strings.delete(key);
      return 1;
    }
    if (script.includes("PEXPIRE")) {
      return current === owner ? 1 : 0;
    }
    return 0;
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
    options?: { NX?: boolean; PX?: number },
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
  readonly queries: Array<{ params: unknown[]; sql: string }> = [];

  query<T extends QueryResultRow = QueryResultRow>(): Promise<QueryResult<T>>;
  async query<T extends QueryResultRow = QueryResultRow>(
    ...args: unknown[]
  ): Promise<QueryResult<T>> {
    const sql = String(args[0] ?? "");
    const params = Array.isArray(args[1]) ? (args[1] as unknown[]) : [];
    this.queries.push({ params, sql });
    const minConfidence = Number(params[0] ?? 0);
    const rows = this.rows.filter((row) => {
      const confidence = Number((row as { confidence?: unknown }).confidence ?? 0);
      return !Number.isFinite(minConfidence) || confidence >= minConfidence;
    });
    if (sql.includes("below_min_confidence")) {
      const below = this.rows.length - rows.length;
      return {
        command: "SELECT",
        fields: [],
        oid: 0,
        rowCount: 1,
        rows: [
          {
            below_min_confidence: below,
            eligible: rows.length,
            total: this.rows.length,
          },
        ] as unknown as T[],
      };
    }
    const limit = Number(params[3] ?? rows.length);
    const selected = rows.slice(
      0,
      Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : rows.length,
    );
    return {
      command: "SELECT",
      fields: [],
      oid: 0,
      rowCount: selected.length,
      rows: selected as T[],
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
    primaryTargetMeta: { bucket: "sharp_side", side: "YES" },
    marketId: "polymarket:market-1",
    eventId: "polymarket:event-1",
    marketTitle: "Will test resolve Yes?",
    eventTitle: "Test event",
    bestBid: 0.3,
    bestAsk: 0.32,
    lastPrice: null,
    holderAddress: "0xa022ba0a68e11a78348382ff168601012d4d77f8",
    holderChain: "polygon",
    holderOpenPnlUsd: -123,
    holderPositionUsd: 12_345,
    holderSide: "YES",
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
    primary_target_meta: { bucket: "sharp_side", side: "YES" },
    market_id: "polymarket:market-1",
    event_id: "polymarket:event-1",
    market_title: "Will test resolve Yes?",
    event_title: "Test event",
    best_bid: "0.30",
    best_ask: "0.32",
    last_price: null,
    holder_address: "0xa022ba0a68e11a78348382ff168601012d4d77f8",
    holder_chain: "polygon",
    holder_target_meta: { openPnlUsd: -123, positionUsd: 12_345, side: "YES" },
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
    name: "status reports enabled state and minimum confidence",
    run: async () => {
      const redis = new FakeRedis();
      const telegram = new FakeTelegram();
      const handled = await handleSignalBotCommand({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_MIN_CONFIDENCE: "0.8",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        message: {
          chat: { id: -1, title: "Group", type: "group" },
          from: { id: 999 },
          text: "/status",
        },
        redis,
        sendMessage: (message) => telegram.sendMessage(message),
        sendTestSignal: async () => false,
      });
      assert.equal(handled, true);
      assert.match(telegram.messages[0]?.text ?? "", /Signals are disabled here/);
      assert.match(telegram.messages[0]?.text ?? "", /Min confidence: 80%/);
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
    name: "holder URL uses chain-specific explorers",
    run: () => {
      assert.equal(
        buildSignalBotHolderUrl({
          address: "0xa022ba0a68e11a78348382ff168601012d4d77f8",
          chain: "polygon",
        }),
        "https://polygonscan.com/address/0xa022ba0a68e11a78348382ff168601012d4d77f8",
      );
      assert.equal(
        buildSignalBotHolderUrl({
          address: "So11111111111111111111111111111111111111112",
          chain: "solana",
        }),
        "https://solscan.io/account/So11111111111111111111111111111111111111112",
      );
      assert.equal(buildSignalBotHolderUrl({ address: "0xabc", chain: "unknown" }), null);
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
      assert.equal(rows[2]?.[0]?.text, "👤 YES $12.3K (-$123)");
      assert.match(rows[2]?.[0]?.url ?? "", /^https:\/\/polygonscan\.com\/address\//);
      assert.equal(rows[2]?.[1]?.text, "↗️ Open market");
      assert.match(
        message.text,
        /^\*\[Sharp YES interest\]\(https:\/\/app\.hunch\.trade\/events\/polymarket%3Aevent-1\?/,
      );
      assert.match(message.text, /⚡ Sharp holder · 🎯 82% · YES 31¢ \/ NO 69¢/);
      assert.match(message.text, /📍 Test event · Will test resolve Yes\?/);
      assert.match(message.text, /📰 Public info followed the holder activity\\\./);
      assert.doesNotMatch(message.text, /confidence/i);
    },
  },
  {
    name: "message omits holder button when no wallet target is available",
    run: () => {
      const message = buildSignalBotMessage({
        amountsUsd: [5],
        appBaseUrl: "https://app.hunch.trade",
        note: note({
          holderAddress: null,
          holderChain: null,
          holderOpenPnlUsd: null,
          holderPositionUsd: null,
          holderSide: null,
        }),
      });
      const rows = message.keyboard?.inline_keyboard ?? [];
      assert.equal(rows[2]?.length, 1);
      assert.equal(rows[2]?.[0]?.text, "↗️ Open market");
    },
  },
  {
    name: "message title link avoids duplicate event and market titles",
    run: () => {
      const message = buildSignalBotMessage({
        amountsUsd: [5],
        appBaseUrl: "https://app.hunch.trade",
        note: note({
          eventTitle: "Same market title",
          marketTitle: " Same   market title ",
        }),
      });
      assert.match(message.text, /^\*\[Sharp YES interest\]/);
      assert.doesNotMatch(message.text, /Same market title · Same market title/);
    },
  },
  {
    name: "message uses generic external summary before internal rationale",
    run: () => {
      const message = buildSignalBotMessage({
        amountsUsd: [5],
        appBaseUrl: "https://app.hunch.trade",
        note: note({
          modelMeta: {
            external_research: {
              summary:
                "Public deal and early traffic spikes preceded the holder activity; full recovery is still uncertain.",
            },
          },
          rationale: "Publishable because this is internal decision text.",
        }),
      });
      assert.match(message.text, /📰 Public deal and early traffic spikes/);
      assert.doesNotMatch(message.text, /Publishable because/);
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
    name: "publish sends only notes meeting minimum confidence",
    run: async () => {
      const redis = new FakeRedis();
      await enableSignalBotChat({
        chat: { id: "-100", title: "Signals", type: "group" },
        enabledBy: 123,
        now: new Date("2025-12-31T00:00:00.000Z"),
        redis,
      });
      const db = new FakeDb();
      db.rows = [
        noteRow({
          confidence: "0.69",
          id: "00000000-0000-4000-8000-000000000001",
          title: "Below threshold",
        }),
        noteRow({
          confidence: "0.78",
          id: "00000000-0000-4000-8000-000000000002",
          title: "Above threshold",
        }),
      ];
      const telegram = new FakeTelegram();
      const result = await publishSignalBotTick({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_MIN_CONFIDENCE: "0.7",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        redis,
        telegram,
      });
      assert.equal(result.belowConfidenceNotes, 1);
      assert.equal(result.eligibleNotes, 1);
      assert.equal(result.sent, 1);
      assert.match(telegram.messages[0]?.text ?? "", /Above threshold/);
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
    name: "lock release does not delete another owner lock",
    run: async () => {
      const redis = new FakeRedis();
      assert.equal(
        await acquireSignalBotLock({ owner: "owner-1", redis }),
        true,
      );
      await releaseSignalBotLock({ owner: "owner-2", redis });
      assert.equal(await redis.get(signalBotLockKey()), "owner-1");
      await releaseSignalBotLock({ owner: "owner-1", redis });
      assert.equal(await redis.get(signalBotLockKey()), null);
    },
  },
  {
    name: "lock refresh fails after ownership changes",
    run: async () => {
      const redis = new FakeRedis();
      assert.equal(
        await acquireSignalBotLock({ owner: "owner-1", redis }),
        true,
      );
      await redis.set(signalBotLockKey(), "owner-2");
      assert.equal(
        await refreshSignalBotLock({ owner: "owner-1", redis }),
        false,
      );
      assert.equal(await redis.get(signalBotLockKey()), "owner-2");
      assert.equal(
        await refreshSignalBotLock({ owner: "owner-2", redis }),
        true,
      );
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
