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
  loadSignalBotNotes,
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
    const directionEligibleRows = this.rows.filter((row) => {
      const direction = String((row as { direction?: unknown }).direction ?? "");
      return direction === "up" || direction === "down";
    });
    const rows = directionEligibleRows.filter((row) => {
      const confidence = Number((row as { confidence?: unknown }).confidence ?? 0);
      return !Number.isFinite(minConfidence) || confidence >= minConfidence;
    });
    if (sql.includes("below_min_confidence")) {
      const below = directionEligibleRows.length - rows.length;
      const nonDirectional = this.rows.length - directionEligibleRows.length;
      return {
        command: "SELECT",
        fields: [],
        oid: 0,
        rowCount: 1,
        rows: [
          {
            below_min_confidence: below,
            eligible: rows.length,
            non_directional: nonDirectional,
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
    marketVenue: "polymarket",
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
    holderActorMode: "single_holder",
    holderCredentialBullets: [
      "Up $2.5K over the last 30 days",
      "Won 65% of recent trades",
    ],
    holderClusterPnl30dUsd: null,
    holderClusterSharpHolders: null,
    holderClusterSharpUsd: null,
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
    market_venue: "polymarket",
    market_title: "Will test resolve Yes?",
    event_title: "Test event",
    best_bid: "0.30",
    best_ask: "0.32",
    last_price: null,
    holder_address: "0xa022ba0a68e11a78348382ff168601012d4d77f8",
    holder_chain: "polygon",
    holder_target_meta: {
      actorMode: "single_holder",
      credentialBullets: [
        "Up $2.5K over the last 30 days",
        "Won 65% of recent trades",
      ],
      openPnlUsd: -123,
      positionUsd: 12_345,
      side: "YES",
    },
    ...overrides,
  };
}

const tests: Array<{ name: string; run: () => Promise<void> | void }> = [
  {
    name: "env parser handles admins and default buy amount",
    run: () => {
      const config = parseSignalBotConfig({
        HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123, 456, nope",
        HUNCH_SIGNAL_BOT_BUY_AMOUNT_USD: "",
        HUNCH_SIGNAL_BOT_ENABLED: "true",
        HUNCH_SIGNAL_BOT_MIN_CONFIDENCE: "0.8",
        HUNCH_SIGNAL_BOT_TOKEN: "token",
      });
      assert.equal(config.enabled, true);
      assert.deepEqual([...config.adminUserIds], [123, 456]);
      assert.equal(config.buyAmountUsd, 10);
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
    name: "authorized user can enable channel by peer id",
    run: async () => {
      const redis = new FakeRedis();
      const telegram = new FakeTelegram();
      const handled = await handleSignalBotCommand({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        message: {
          chat: { id: 123, title: "Admin DM", type: "private" },
          from: { id: 123 },
          text: "/enable_signals 4249870297",
        },
        redis,
        sendMessage: (message) => telegram.sendMessage(message),
        sendTestSignal: async () => false,
      });
      assert.equal(handled, true);
      const state = await getSignalBotChatState(redis, "-1004249870297");
      assert.equal(state?.chatId, "-1004249870297");
      assert.equal(state?.chatType, "channel");
      assert.equal(
        telegram.messages[0]?.text,
        "Signals enabled for \\-1004249870297\\.",
      );
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
    name: "holder URL uses Hunch tracker with signal context",
    run: () => {
      const url = buildSignalBotHolderUrl({
        address: "0xa022ba0a68e11a78348382ff168601012d4d77f8",
        appBaseUrl: "https://app.hunch.trade",
        chain: "polygon",
        eventId: "polymarket:event-1",
        marketId: "polymarket:market-1",
        noteId: "00000000-0000-4000-8000-000000000001",
        side: "YES",
      });
      assert.ok(url);
      const parsed = new URL(url);
      assert.equal(
        parsed.pathname,
        "/tracking/wallet/0xa022ba0a68e11a78348382ff168601012d4d77f8",
      );
      assert.equal(parsed.searchParams.get("chain"), "polygon");
      assert.equal(parsed.searchParams.get("eventId"), "polymarket:event-1");
      assert.equal(parsed.searchParams.get("marketId"), "polymarket:market-1");
      assert.equal(parsed.searchParams.get("side"), "YES");
      assert.equal(
        parsed.searchParams.get("noteId"),
        "00000000-0000-4000-8000-000000000001",
      );
      assert.equal(parsed.searchParams.get("utm_source"), "telegram_signal_bot");
      assert.equal(buildSignalBotHolderUrl({ address: "", chain: "polygon" }), null);
    },
  },
  {
    name: "message buttons include primary buy with default amount",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note(),
      });
      const rows = message.keyboard?.inline_keyboard ?? [];
      assert.equal(rows[0]?.[0]?.text, "🟠 Buy YES $10 · Poly 32¢");
      assert.equal(new URL(rows[0]?.[0]?.url ?? "").searchParams.get("amountUsd"), "10");
      assert.equal(rows.length, 2);
      assert.equal(rows[1]?.[0]?.text, "👤 YES $12.3K (-$123)");
      const holderButtonUrl = new URL(rows[1]?.[0]?.url ?? "");
      assert.equal(
        holderButtonUrl.pathname,
        "/tracking/wallet/0xa022ba0a68e11a78348382ff168601012d4d77f8",
      );
      assert.equal(holderButtonUrl.searchParams.get("chain"), "polygon");
      assert.equal(holderButtonUrl.searchParams.get("marketId"), "polymarket:market-1");
      assert.equal(holderButtonUrl.searchParams.get("side"), "YES");
      assert.equal(rows[1]?.[1]?.text, "↗️ Open market");
      assert.match(
        message.text,
        /^\*\[Sharp YES interest\]\(https:\/\/app\.hunch\.trade\/events\/polymarket%3Aevent-1\?/,
      );
      assert.match(message.text, /⚡ Sharp holder · YES 31¢ \/ NO 69¢/);
      assert.doesNotMatch(message.text, /🎯 82%/);
      assert.match(message.text, /📍 Test event · Will test resolve Yes\?/);
      assert.match(message.text, /Why this wallet matters:/);
      assert.match(message.text, /• Up \$2\\.5K over the last 30 days/);
      assert.match(message.text, /• Won 65% of recent trades/);
      assert.doesNotMatch(message.text, /sample count|resolved edge|n=/i);
      assert.match(message.text, /📰 Public info followed the holder activity\\\./);
      assert.doesNotMatch(message.text, /confidence/i);
    },
  },
  {
    name: "message includes cheaper alternative button when provided",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        cheaperAlternative: {
          eventId: "kalshi:event-1",
          marketId: "kalshi:market-1",
          price: 0.29,
          side: "YES",
          venue: "kalshi",
        },
        note: note(),
      });
      const rows = message.keyboard?.inline_keyboard ?? [];
      assert.equal(rows[0]?.[0]?.text, "🟠 Buy YES $10 · Poly 32¢");
      assert.equal(rows[1]?.[0]?.text, "💸 Cheaper: Kalshi YES 29¢");
      const url = new URL(rows[1]?.[0]?.url ?? "");
      assert.equal(url.pathname, "/events/kalshi%3Aevent-1");
      assert.equal(url.searchParams.get("market"), "kalshi:market-1");
      assert.equal(url.searchParams.get("side"), "YES");
      assert.equal(url.searchParams.get("amountUsd"), "10");
      assert.equal(rows[2]?.[0]?.text, "👤 YES $12.3K (-$123)");
    },
  },
  {
    name: "message suppresses cheaper alternative for opposite side",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        cheaperAlternative: {
          eventId: "kalshi:event-1",
          marketId: "kalshi:market-1",
          price: 0.7,
          side: "NO",
          venue: "kalshi",
        },
        note: note(),
      });
      const rows = message.keyboard?.inline_keyboard ?? [];
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.[0]?.text, "🟠 Buy YES $10 · Poly 32¢");
      assert.equal(rows[1]?.[0]?.text, "👤 YES $12.3K (-$123)");
    },
  },
  {
    name: "message uses bid-derived buy price for NO",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({ direction: "down" }),
      });
      const rows = message.keyboard?.inline_keyboard ?? [];
      assert.equal(rows[0]?.[0]?.text, "⚪ Buy NO $10 · Poly 70¢");
      assert.match(message.text, /⚡ Sharp holder · YES 31¢ \/ NO 69¢/);
    },
  },
  {
    name: "message strips markdown citations and incomplete URLs from public context",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({
          modelMeta: {
            external_research: {
              summary:
                "**Public previews (Mexico -115 to win, predictions like 0-2 Mexico) preceded/coincided with sharp NO activity; positioning is contrarian to favorites.**[[1]](https://www.cbssports.com/soccer/news/mexico-vs-czechia)[[2]](https://www.usatoday.c...",
            },
          },
        }),
      });

      assert.ok(
        message.text.includes(
          "📰 Public previews \\(Mexico \\-115 to win, predictions like 0\\-2 Mexico\\) preceded/coincided with sharp NO activity; positioning is contrarian to favorites\\.",
        ),
      );
      const contextLine = message.text
        .split("\n")
        .find((line) => line.startsWith("📰"));
      assert.ok(contextLine);
      assert.doesNotMatch(contextLine, /https?:/);
      assert.doesNotMatch(contextLine, /\[\[|\]\(/);
      assert.doesNotMatch(contextLine, /usatoday|cbssports/i);
      assert.doesNotMatch(contextLine, /\\.\\.\\./);
    },
  },
  {
    name: "message omits holder button when no wallet target is available",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({
          holderAddress: null,
          holderChain: null,
          holderOpenPnlUsd: null,
          holderPositionUsd: null,
          holderSide: null,
        }),
      });
      const rows = message.keyboard?.inline_keyboard ?? [];
      assert.equal(rows[1]?.length, 1);
      assert.equal(rows[1]?.[0]?.text, "↗️ Open market");
    },
  },
  {
    name: "message renders sharp cluster credentials with representative holder",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({
          holderActorMode: "sharp_cluster",
          holderClusterPnl30dUsd: 14_000,
          holderClusterSharpHolders: 2,
          holderClusterSharpUsd: 45_000,
          holderCredentialBullets: [
            "Up $14.0K combined over the last 30 days",
            "2 strong wallets on the same side",
          ],
        }),
      });
      const rows = message.keyboard?.inline_keyboard ?? [];
      assert.equal(rows[1]?.[0]?.text, "👤 Top YES $12.3K (-$123)");
      assert.match(message.text, /⚡ Sharp cluster · YES 31¢ \/ NO 69¢/);
      assert.match(message.text, /Why this cluster matters:/);
      assert.match(
        message.text,
        /• Up \$14\\.0K combined over the last 30 days/,
      );
    },
  },
  {
    name: "message omits credential section for legacy notes",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({
          holderActorMode: null,
          holderCredentialBullets: [],
        }),
      });
      assert.doesNotMatch(
        message.text,
        /Why this wallet matters|Why this cluster matters/,
      );
      assert.match(message.text, /⚡ Sharp holder · YES 31¢ \/ NO 69¢/);
      assert.doesNotMatch(message.text, /confidence/i);
    },
  },
  {
    name: "message title link avoids duplicate event and market titles",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
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
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
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
    name: "message keeps public context sentence from being clipped",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({
          modelMeta: {
            external_research: {
              summary:
                "Public pickup reports (Al Arabiya/Reuters June 23: 36 transits, avg rising to 21-27 post-June 14 deal) coincide with holder activity and partially explain the move.",
            },
          },
        }),
      });
      assert.match(message.text, /36 transits/);
      assert.match(message.text, /coincide with holder activity/);
      assert.doesNotMatch(message.text, /coincide with\\\.\\\.\\\./);
    },
  },
  {
    name: "buy side resolves from final note direction only",
    run: () => {
      assert.equal(
        resolveSignalBotBuySide(note({ primaryTargetMeta: { side: "YES" }, direction: "down" })),
        "NO",
      );
      assert.equal(
        resolveSignalBotBuySide(note({ primaryTargetMeta: {}, direction: "mixed" })),
        null,
      );
      assert.equal(
        resolveSignalBotBuySide(
          note({
            primaryTargetMeta: { side: "NO" },
            direction: "up",
          }),
        ),
        "YES",
      );
    },
  },
  {
    name: "message hides holder button when old note holder conflicts with buy side",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({
          direction: "up",
          holderSide: "NO",
          primaryTargetMeta: { bucket: "sharp_side", side: "YES" },
        }),
      });
      const rows = message.keyboard?.inline_keyboard ?? [];
      assert.equal(rows[1]?.length, 1);
      assert.equal(rows[1]?.[0]?.text, "↗️ Open market");
    },
  },
  {
    name: "signal note loader joins holder wallet target by uuid primary key",
    run: async () => {
      const db = new FakeDb();
      await loadSignalBotNotes(db, {
        afterCreatedAt: "1970-01-01T00:00:00.000Z",
        afterId: "00000000-0000-0000-0000-000000000000",
        limit: 1,
        minConfidence: 0.7,
      });
      const sql = db.queries[0]?.sql ?? "";
      assert.match(sql, /join wallets w on w\.id = t\.target_id::uuid/);
      assert.match(sql, /m\.venue as market_venue/);
      assert.doesNotMatch(sql, /w\.id::text = t\.target_id/);
    },
  },
  {
    name: "publish renders cheaper alternative from resolver",
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
        resolveCheaperAlternative: async () => ({
          eventId: "kalshi:event-1",
          marketId: "kalshi:market-1",
          price: 0.29,
          side: "YES",
          venue: "kalshi",
        }),
        telegram,
      });
      assert.equal(result.cheaperAlternatives, 1);
      assert.equal(result.sent, 1);
      assert.equal(
        telegram.messages[0]?.reply_markup?.inline_keyboard[1]?.[0]?.text,
        "💸 Cheaper: Kalshi YES 29¢",
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
      assert.equal(result.nonDirectionalNotes, 0);
      assert.equal(result.sent, 1);
      assert.match(telegram.messages[0]?.text ?? "", /Above threshold/);
    },
  },
  {
    name: "publish skips mixed notes as non-directional",
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
          direction: "mixed",
          id: "00000000-0000-4000-8000-000000000001",
          title: "Mixed context",
        }),
        noteRow({
          direction: "up",
          id: "00000000-0000-4000-8000-000000000002",
          title: "Directional signal",
        }),
      ];
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
      assert.equal(result.nonDirectionalNotes, 1);
      assert.equal(result.eligibleNotes, 1);
      assert.equal(result.sent, 1);
      assert.match(telegram.messages[0]?.text ?? "", /Directional signal/);
      assert.doesNotMatch(telegram.messages[0]?.text ?? "", /Mixed context/);
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
