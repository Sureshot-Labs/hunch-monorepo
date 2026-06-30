import assert from "node:assert/strict";

import type { QueryResult, QueryResultRow } from "pg";

import {
  acquireSignalBotLock,
  buildSignalBotHolderUrl,
  buildSignalBotMessage,
  buildSignalBotStatsReport,
  buildSignalBotTradeUrl,
  disableSignalBotChat,
  enableSignalBotChat,
  escapeTelegramMarkdownV2,
  getSignalBotChatState,
  handleSignalBotCommand,
  loadSignalBotNotes,
  parseSignalBotAggMarketConfig,
  parseSignalBotCommand,
  parseSignalBotConfig,
  parseSignalBotStatsRequest,
  parseSignalBotStatsPeriod,
  publishSignalBotTick,
  refreshSignalBotLock,
  releaseSignalBotLock,
  resolveSignalBotCheaperAlternativeFromAggResponse,
  resolveSignalBotBuySide,
  sendLatestSignalBotTestSignal,
  sendSignalBotStatsReport,
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
  readonly sortedSets = new Map<string, Map<string, number>>();

  private getSortedSet(key: string): Map<string, number> {
    const existing = this.sortedSets.get(key);
    if (existing) return existing;
    const created = new Map<string, number>();
    this.sortedSets.set(key, created);
    return created;
  }

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
    if (script.includes("ZSCORE")) {
      const score = Number(options.arguments[0] ?? 0);
      const set = this.getSortedSet(key);
      let added = 0;
      for (const item of options.arguments.slice(1)) {
        const existing = set.get(item);
        if (existing == null) {
          added += 1;
          set.set(item, score);
        } else if (score < existing) {
          set.set(item, score);
        }
      }
      return added;
    }
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
    options?: { EX?: number; NX?: boolean; PX?: number },
  ): Promise<"OK" | null> {
    if (options?.NX && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return "OK";
  }

  async zCard(key: string): Promise<number> {
    return this.getSortedSet(key).size;
  }

  async zRemRangeByRank(
    key: string,
    start: number,
    stop: number,
  ): Promise<number> {
    const set = this.getSortedSet(key);
    const entries = Array.from(set.entries()).sort(
      (a, b) => a[1] - b[1] || a[0].localeCompare(b[0]),
    );
    const normalizedStart = start < 0 ? entries.length + start : start;
    const normalizedStop = stop < 0 ? entries.length + stop : stop;
    const slice = entries.slice(normalizedStart, normalizedStop + 1);
    for (const [item] of slice) set.delete(item);
    return slice.length;
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
  marketRows: unknown[] = [
    {
      best_ask: null,
      best_bid: null,
      clob_token_ids: null,
      id: "polymarket:market-1",
      last_price: null,
      token_no: "no-token",
      token_yes: "yes-token",
      venue: "polymarket",
    },
  ];
  marketTokenRows: unknown[] = [];
  rows: unknown[] = [];
  tokenTopRows: unknown[] = [
    {
      best_ask: "0.41",
      best_bid: "0.4",
      token_id: "yes-token",
      ts: "2999-01-01T00:00:00.000Z",
    },
    {
      best_ask: "0.61",
      best_bid: "0.6",
      token_id: "no-token",
      ts: "2999-01-01T00:00:00.000Z",
    },
  ];
  readonly queries: Array<{ params: unknown[]; sql: string }> = [];

  query<T extends QueryResultRow = QueryResultRow>(): Promise<QueryResult<T>>;
  async query<T extends QueryResultRow = QueryResultRow>(
    ...args: unknown[]
  ): Promise<QueryResult<T>> {
    const sql = String(args[0] ?? "");
    const params = Array.isArray(args[1]) ? (args[1] as unknown[]) : [];
    this.queries.push({ params, sql });
    if (sql.includes("from unified_market_tokens")) {
      return {
        command: "SELECT",
        fields: [],
        oid: 0,
        rowCount: this.marketTokenRows.length,
        rows: this.marketTokenRows as T[],
      };
    }
    if (sql.includes("from unified_token_top_latest")) {
      return {
        command: "SELECT",
        fields: [],
        oid: 0,
        rowCount: this.tokenTopRows.length,
        rows: this.tokenTopRows as T[],
      };
    }
    if (
      sql.includes("from unified_markets") &&
      sql.includes("where id = any")
    ) {
      return {
        command: "SELECT",
        fields: [],
        oid: 0,
        rowCount: this.marketRows.length,
        rows: this.marketRows as T[],
      };
    }
    const minConfidence = Number(params[0] ?? 0);
    const directionEligibleRows = this.rows.filter((row) => {
      const direction = String(
        (row as { direction?: unknown }).direction ?? "",
      );
      return direction === "up" || direction === "down";
    });
    const rows = directionEligibleRows.filter((row) => {
      const confidence = Number(
        (row as { confidence?: unknown }).confidence ?? 0,
      );
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
    outcomes: null,
    marketSegment: null,
    closeTime: null,
    expirationTime: null,
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
    category: null,
    event_category: null,
    series_key: null,
    series_title: null,
    close_time: null,
    expiration_time: null,
    outcomes: null,
    market_segment: null,
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

function performanceNoteRow(overrides: Record<string, unknown> = {}) {
  return {
    note_id: "00000000-0000-4000-8000-000000000201",
    direction: "up",
    confidence: 0.82,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    metrics: {
      bucket: "sharp_side",
      market: { yesProbability: 0.5 },
      signalSnapshot: {
        version: 1,
        recordedAt: "2026-01-01T00:00:00.000Z",
        marketId: "polymarket:stats-1",
        eventId: "polymarket:event-1",
        venue: "polymarket",
        side: "YES",
        direction: "up",
        marketStatus: "ACTIVE",
        acceptingOrders: true,
        tokens: { yes: "yes-token", no: "no-token" },
        quote: {
          buyPrice: 0.5,
          buyPriceSource: "yes_ask",
        },
      },
    },
    model_meta: {
      primary_holder_credentials: { mode: "single_holder" },
    },
    target_meta: { bucket: "sharp_side", side: "YES" },
    market_id: "polymarket:stats-1",
    event_id: "polymarket:event-1",
    venue: "polymarket",
    market_status: "ACTIVE",
    market_title: "Stats market",
    event_title: "Stats event",
    category: "Politics",
    close_time: new Date("2026-01-01T03:00:00.000Z"),
    expiration_time: null,
    best_bid: 0.6,
    best_ask: 0.62,
    last_price: null,
    resolved_outcome: null,
    resolved_outcome_pct: null,
    accepting_orders: true,
    yes_token_id: "yes-token",
    no_token_id: "no-token",
    market_token_yes: null,
    market_token_no: null,
    clob_token_ids: null,
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
      assert.equal(config.priceGuardMaxDefers, 5);
      assert.equal(config.priceGuardDeferTtlSec, 1_800);
    },
  },
  {
    name: "bot env parsing does not require api-only privy secrets",
    run: () => {
      const config = parseSignalBotConfig({
        HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
        HUNCH_SIGNAL_BOT_ENABLED: "true",
        HUNCH_SIGNAL_BOT_TOKEN: "token",
      });
      assert.equal(config.enabled, true);
      assert.equal(config.token, "token");
      assert.equal(parseSignalBotAggMarketConfig({}), null);
    },
  },
  {
    name: "agg alternatives env requires app id for AGG Market client",
    run: () => {
      const config = parseSignalBotAggMarketConfig({
        AGG_API_KEY: "agg-key",
      });
      assert.equal(config, null);
    },
  },
  {
    name: "agg alternatives env parses app id",
    run: () => {
      const config = parseSignalBotAggMarketConfig({
        AGG_APP_ID: "agg-app",
        AGG_CLUSTERS_CACHE_TTL_SEC: "45",
        AGG_MARKET_ALTERNATIVES_NOT_FOUND_CACHE_TTL_SEC: "90",
        AGG_MARKET_BASE_URL: "https://agg.example.com/",
        AGG_MARKET_TIMEOUT_MS: "2500",
      });
      assert.deepEqual(config, {
        apiKey: null,
        appId: "agg-app",
        baseUrl: "https://agg.example.com/",
        credentialSource: "AGG_APP_ID",
        matchedTtlSec: 45,
        notFoundTtlSec: 90,
        timeoutMs: 2500,
      });
    },
  },
  {
    name: "agg alternatives env keeps app id and api key distinct",
    run: () => {
      const config = parseSignalBotAggMarketConfig({
        AGG_API_KEY: "real-key",
        AGG_APP_ID: "app-id",
      });
      assert.equal(config?.apiKey, "real-key");
      assert.equal(config?.appId, "app-id");
      assert.equal(config?.credentialSource, "AGG_APP_ID");
    },
  },
  {
    name: "agg alternatives env falls back to app id",
    run: () => {
      const config = parseSignalBotAggMarketConfig({
        AGG_APP_ID: "fallback-id",
      });
      assert.equal(config?.apiKey, null);
      assert.equal(config?.appId, "fallback-id");
      assert.equal(config?.credentialSource, "AGG_APP_ID");
    },
  },
  {
    name: "agg alternatives diagnostics classify no response and not found",
    run: () => {
      const noResponse = resolveSignalBotCheaperAlternativeFromAggResponse({
        buySide: "YES",
        note: note(),
        response: null,
      });
      assert.equal(noResponse.alternative, null);
      assert.equal(noResponse.diagnostics.aggNoResponse, 1);

      const notFound = resolveSignalBotCheaperAlternativeFromAggResponse({
        buySide: "YES",
        note: note(),
        response: { alternatives: [], status: "not_found" },
      });
      assert.equal(notFound.alternative, null);
      assert.equal(notFound.diagnostics.aggNotFound, 1);
    },
  },
  {
    name: "agg alternatives diagnostics classify matched prices",
    run: () => {
      const noCheaper = resolveSignalBotCheaperAlternativeFromAggResponse({
        buySide: "YES",
        note: note({ bestAsk: 0.32 }),
        response: {
          alternatives: [
            {
              eventId: "kalshi:event-1",
              marketId: "kalshi:market-1",
              venue: "kalshi",
              yesAsk: 0.32,
            },
          ] as never,
          status: "matched",
        },
      });
      assert.equal(noCheaper.alternative, null);
      assert.equal(noCheaper.diagnostics.aggMatched, 1);
      assert.equal(noCheaper.diagnostics.aggMatchedNotCheaper, 1);

      const cheaper = resolveSignalBotCheaperAlternativeFromAggResponse({
        buySide: "YES",
        note: note({ bestAsk: 0.32 }),
        response: {
          alternatives: [
            {
              eventId: "kalshi:event-1",
              marketId: "kalshi:market-1",
              venue: "kalshi",
              yesAsk: 0.29,
            },
          ] as never,
          status: "matched",
        },
      });
      assert.equal(cheaper.alternative?.marketId, "kalshi:market-1");
      assert.equal(cheaper.diagnostics.aggMatched, 1);
      assert.equal(cheaper.diagnostics.aggCheaperFound, 1);
    },
  },
  {
    name: "command parser accepts bot mentions and ignores other bots",
    run: () => {
      assert.equal(
        parseSignalBotCommand(
          "/enable_signals@HunchSignalBot",
          "HunchSignalBot",
        ),
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
    name: "stats period parser supports default and allowed windows",
    run: () => {
      assert.equal(parseSignalBotCommand("/stats", null), "stats");
      assert.equal(parseSignalBotStatsPeriod("/stats"), "7d");
      assert.equal(parseSignalBotStatsPeriod("/stats 24h"), "24h");
      assert.equal(parseSignalBotStatsPeriod("/stats 7d"), "7d");
      assert.equal(parseSignalBotStatsPeriod("/stats 30d"), "30d");
      assert.deepEqual(parseSignalBotStatsRequest("/stats detail"), {
        detail: true,
        period: "7d",
      });
      assert.deepEqual(parseSignalBotStatsRequest("/stats 24h detail"), {
        detail: true,
        period: "24h",
      });
      assert.equal(parseSignalBotStatsPeriod("/stats 3d"), null);
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
    name: "unauthorized user cannot request stats",
    run: async () => {
      const redis = new FakeRedis();
      const telegram = new FakeTelegram();
      let statsCalled = false;
      const handled = await handleSignalBotCommand({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        message: {
          chat: { id: -1, title: "Group", type: "group" },
          from: { id: 999 },
          text: "/stats",
        },
        redis,
        sendMessage: (message) => telegram.sendMessage(message),
        sendStatsReport: async () => {
          statsCalled = true;
          return true;
        },
        sendTestSignal: async () => false,
      });
      assert.equal(handled, true);
      assert.equal(statsCalled, false);
      assert.match(telegram.messages[0]?.text ?? "", /Not authorized/);
    },
  },
  {
    name: "authorized stats command passes selected period",
    run: async () => {
      const redis = new FakeRedis();
      const telegram = new FakeTelegram();
      const requests: Array<{ detail: boolean; period: string }> = [];
      const handled = await handleSignalBotCommand({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        message: {
          chat: { id: -1, title: "Group", type: "group" },
          from: { id: 123 },
          text: "/stats 30d",
        },
        redis,
        sendMessage: (message) => telegram.sendMessage(message),
        sendStatsReport: async (_chatId, period, detail) => {
          requests.push({ detail, period });
          return true;
        },
        sendTestSignal: async () => false,
      });
      assert.equal(handled, true);
      assert.deepEqual(requests, [{ detail: false, period: "30d" }]);
      assert.equal(telegram.messages.length, 0);
    },
  },
  {
    name: "invalid stats period returns usage",
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
          from: { id: 123 },
          text: "/stats 3d",
        },
        redis,
        sendMessage: (message) => telegram.sendMessage(message),
        sendStatsReport: async () => true,
        sendTestSignal: async () => false,
      });
      assert.equal(handled, true);
      assert.match(telegram.messages[0]?.text ?? "", /Usage: \/stats/);
    },
  },
  {
    name: "stats command catches report failure",
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
          from: { id: 123 },
          text: "/stats",
        },
        redis,
        sendMessage: (message) => telegram.sendMessage(message),
        sendStatsReport: async () => {
          throw new Error("db timeout");
        },
        sendTestSignal: async () => false,
      });
      assert.equal(handled, true);
      assert.match(
        telegram.messages[0]?.text ?? "",
        /Stats are unavailable right now/,
      );
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
    name: "authorized user can disable channel by peer id",
    run: async () => {
      const redis = new FakeRedis();
      const telegram = new FakeTelegram();
      const config = parseSignalBotConfig({
        HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
        HUNCH_SIGNAL_BOT_TOKEN: "token",
      });
      await enableSignalBotChat({
        chat: { id: "-1004249870297", title: "Channel", type: "channel" },
        enabledBy: 123,
        redis,
      });
      const handled = await handleSignalBotCommand({
        config,
        message: {
          chat: { id: 123, title: "Admin DM", type: "private" },
          from: { id: 123 },
          text: "/disable_signals 4249870297",
        },
        redis,
        sendMessage: (message) => telegram.sendMessage(message),
        sendTestSignal: async () => false,
      });
      assert.equal(handled, true);
      const state = await getSignalBotChatState(redis, "-1004249870297");
      assert.equal(state, null);
      assert.equal(
        telegram.messages[0]?.text,
        "Signals disabled for \\-1004249870297\\.",
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
      assert.match(
        telegram.messages[0]?.text ?? "",
        /Signals are disabled here/,
      );
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
      assert.equal(
        (await getSignalBotChatState(redis, "-100"))?.chatTitle,
        "Signals",
      );
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
      assert.equal(
        parsed.searchParams.get("utm_source"),
        "telegram_signal_bot",
      );
      assert.equal(
        buildSignalBotHolderUrl({ address: "", chain: "polygon" }),
        null,
      );
    },
  },
  {
    name: "message buttons include primary buy with market price",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note(),
      });
      const rows = message.keyboard?.inline_keyboard ?? [];
      assert.equal(rows[0]?.[0]?.text, "🟠 Buy YES · Poly 32¢");
      assert.equal(
        new URL(rows[0]?.[0]?.url ?? "").searchParams.get("amountUsd"),
        "10",
      );
      assert.equal(rows.length, 2);
      assert.equal(rows[1]?.[0]?.text, "👤 YES $12.3K (-$123)");
      const holderButtonUrl = new URL(rows[1]?.[0]?.url ?? "");
      assert.equal(
        holderButtonUrl.pathname,
        "/tracking/wallet/0xa022ba0a68e11a78348382ff168601012d4d77f8",
      );
      assert.equal(holderButtonUrl.searchParams.get("chain"), "polygon");
      assert.equal(
        holderButtonUrl.searchParams.get("marketId"),
        "polymarket:market-1",
      );
      assert.equal(holderButtonUrl.searchParams.get("side"), "YES");
      assert.equal(rows[1]?.[1]?.text, "↗️ Open market");
      assert.match(
        message.text,
        /^\*\[Sharp YES interest\]\(https:\/\/app\.hunch\.trade\/events\/polymarket%3Aevent-1\?/,
      );
      assert.match(message.text, /⚡ Strong holder · YES 31¢ \/ NO 69¢/);
      assert.doesNotMatch(message.text, /🎯 82%/);
      assert.match(message.text, /📍 Test event · Will test resolve Yes\?/);
      assert.match(message.text, /Why this wallet matters:/);
      assert.match(message.text, /• Up \$2\\.5K over the last 30 days/);
      assert.match(message.text, /• Won 65% of recent trades/);
      assert.doesNotMatch(message.text, /sample count|resolved edge|n=/i);
      assert.match(
        message.text,
        /📰 Public info followed the holder activity\\\./,
      );
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
      assert.equal(rows[0]?.[0]?.text, "🟠 Buy YES · Poly 32¢");
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
      assert.equal(rows[0]?.[0]?.text, "🟠 Buy YES · Poly 32¢");
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
      assert.equal(rows[0]?.[0]?.text, "⚪ Buy NO · Poly 70¢");
      assert.match(message.text, /⚡ Strong holder · YES 31¢ \/ NO 69¢/);
    },
  },
  {
    name: "message renders time left from close or expiration",
    run: () => {
      const minuteMessage = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({ closeTime: "2026-01-01T00:45:00.000Z" }),
      });
      assert.match(
        minuteMessage.text,
        /⚡ Strong holder · YES 31¢ \/ NO 69¢ · ⏳ 45m left/,
      );

      const hourMessage = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({ closeTime: "2026-01-01T05:00:00.000Z" }),
      });
      assert.match(hourMessage.text, /⏳ 5h left/);

      const dayMessage = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({ expirationTime: "2026-01-04T00:00:00.000Z" }),
      });
      assert.match(dayMessage.text, /⏳ 3d left/);

      const weekMessage = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({ closeTime: "2026-02-05T00:00:00.000Z" }),
      });
      assert.match(weekMessage.text, /⏳ 5w left/);

      const expiredMessage = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({ closeTime: "2025-12-31T23:59:00.000Z" }),
      });
      assert.doesNotMatch(expiredMessage.text, /left/);
    },
  },
  {
    name: "message renders category emoji and named outcome labels",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        cheaperAlternative: {
          eventId: "kalshi:event-1",
          marketId: "kalshi:market-1",
          price: 0.48,
          side: "NO",
          venue: "kalshi",
        },
        note: note({
          direction: "down",
          eventTitle: "Esports: Alpha Team vs Beta Team (BO3)",
          holderSide: "NO",
          marketSegment: "sports_esports_game",
          marketTitle: "Game 1 Winner",
          outcomes: ["Alpha Team", "Beta Team"],
          title: "@TestWallet backs Beta Team in coin-flip opener",
        }),
      });
      const rows = message.keyboard?.inline_keyboard ?? [];
      assert.match(message.text, /^🎮 \*\[@TestWallet backs Beta Team/);
      assert.match(message.text, /⚡ Strong holder · ATL 31¢ \/ BTT 69¢/);
      assert.equal(rows[0]?.[0]?.text, "⚪ Buy BTT · Poly 70¢");
      assert.equal(rows[1]?.[0]?.text, "💸 Cheaper: Kalshi BTT 48¢");
      assert.equal(rows[2]?.[0]?.text, "👤 BTT $12.3K (-$123)");
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
      assert.match(message.text, /⚡ Strong wallets · YES 31¢ \/ NO 69¢/);
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
      assert.match(message.text, /⚡ Strong holder · YES 31¢ \/ NO 69¢/);
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
      assert.doesNotMatch(
        message.text,
        /Same market title · Same market title/,
      );
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
        resolveSignalBotBuySide(
          note({ primaryTargetMeta: { side: "YES" }, direction: "down" }),
        ),
        "NO",
      );
      assert.equal(
        resolveSignalBotBuySide(
          note({ primaryTargetMeta: {}, direction: "mixed" }),
        ),
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
    name: "stats report renders shareable performance copy",
    run: () => {
      const report = buildSignalBotStatsReport({
        buyAmountUsd: 10,
        period: "7d",
        result: {
          aggregates: {
            byActorMode: {},
            byBucket: {},
            byConfidenceBand: {},
            byMarketSegment: {},
            byMarketType: {},
            bySide: {},
            byState: {},
            byVenue: {},
            overall: {
              averageRoi: 0.062,
              correct: 3,
              flat: 0,
              hitRate: 0.75,
              medianRoi: 0.04,
              missingEntry: 0,
              negative: 4,
              notes: 12,
              open: 9,
              positive: 8,
              resolved: 4,
              totalPnlPerDollar: 0.744,
              unknown: 0,
              withEntry: 12,
              wrong: 1,
            },
          },
          considered: 12,
          correct: 3,
          errors: 0,
          evaluated: 12,
          items: [],
          missingEntry: 0,
          open: 9,
          resolved: 4,
          unchanged: 0,
          unknown: 0,
          written: 0,
          wrong: 1,
        },
      });
      assert.match(report, /📊 Hunch signals · 7D/);
      assert.match(report, /💰 \$10 each: \+\$7\.44 \(\+6\.2%\)/);
      assert.match(report, /🎯 Resolved: 3W \/ 1L \(75%\)/);
      assert.doesNotMatch(
        report,
        /evaluated|missingEntry|entryQuality|note_id/i,
      );
    },
  },
  {
    name: "stats detail report renders readable breakdowns",
    run: () => {
      const aggregate = {
        averageRoi: 0.1,
        correct: 1,
        flat: 0,
        hitRate: 1,
        medianRoi: 0.1,
        missingEntry: 0,
        negative: 0,
        notes: 2,
        open: 1,
        positive: 2,
        resolved: 1,
        totalPnlPerDollar: 0.2,
        unknown: 0,
        withEntry: 2,
        wrong: 0,
      };
      const report = buildSignalBotStatsReport({
        buyAmountUsd: 10,
        detail: true,
        period: "7d",
        result: {
          aggregates: {
            byActorMode: { sharp_cluster: aggregate },
            byBucket: { sharp_side: aggregate },
            byConfidenceBand: {},
            byMarketSegment: { sports_soccer_game: aggregate },
            byMarketType: { single_game_sports: aggregate },
            bySide: {},
            byState: {},
            byVenue: {},
            overall: aggregate,
          },
          considered: 2,
          correct: 1,
          errors: 0,
          evaluated: 2,
          items: [],
          missingEntry: 0,
          open: 1,
          resolved: 1,
          unchanged: 0,
          unknown: 0,
          written: 0,
          wrong: 0,
        },
      });
      assert.match(report, /By category/);
      assert.match(report, /Soccer games/);
      assert.match(report, /Wallet clusters/);
      assert.match(report, /Strong same-side wallets/);
      assert.doesNotMatch(report, /sports_soccer_game|sharp_cluster|note_id/i);
    },
  },
  {
    name: "stats report handles no eligible signals",
    run: () => {
      const report = buildSignalBotStatsReport({
        buyAmountUsd: 10,
        period: "24h",
        result: {
          aggregates: {
            byActorMode: {},
            byBucket: {},
            byConfidenceBand: {},
            byMarketSegment: {},
            byMarketType: {},
            bySide: {},
            byState: {},
            byVenue: {},
            overall: {
              averageRoi: null,
              correct: 0,
              flat: 0,
              hitRate: null,
              medianRoi: null,
              missingEntry: 0,
              negative: 0,
              notes: 0,
              open: 0,
              positive: 0,
              resolved: 0,
              totalPnlPerDollar: 0,
              unknown: 0,
              withEntry: 0,
              wrong: 0,
            },
          },
          considered: 0,
          correct: 0,
          errors: 0,
          evaluated: 0,
          items: [],
          missingEntry: 0,
          open: 0,
          resolved: 0,
          unchanged: 0,
          unknown: 0,
          written: 0,
          wrong: 0,
        },
      });
      assert.equal(report, "No bot-eligible signals for 24H yet.");
    },
  },
  {
    name: "stats command sends audit-backed report",
    run: async () => {
      const telegram = new FakeTelegram();
      const queries: Array<{ params: unknown[]; sql: string }> = [];
      const db = {
        query: async (sql: string, params?: unknown[]) => {
          queries.push({ params: params ?? [], sql });
          if (/from\s+ai_notes\s+n/i.test(sql)) {
            return {
              rows: [
                performanceNoteRow(),
                performanceNoteRow({
                  accepting_orders: false,
                  best_ask: 1,
                  best_bid: 0.999,
                  last_price: 1,
                  market_id: "polymarket:stats-2",
                  market_status: "CLOSED",
                  metrics: {
                    bucket: "sharp_side",
                    market: { yesProbability: 0.5 },
                    signalSnapshot: {
                      version: 1,
                      recordedAt: "2026-01-01T00:00:00.000Z",
                      marketId: "polymarket:stats-2",
                      eventId: "polymarket:event-2",
                      venue: "polymarket",
                      side: "YES",
                      direction: "up",
                      marketStatus: "ACTIVE",
                      acceptingOrders: true,
                      tokens: { yes: "yes-token-2", no: "no-token-2" },
                      quote: {
                        buyPrice: 0.5,
                        buyPriceSource: "yes_ask",
                      },
                    },
                  },
                  note_id: "00000000-0000-4000-8000-000000000202",
                  resolved_outcome: "YES",
                }),
              ],
            };
          }
          if (/from\s+jsonb_to_recordset/i.test(sql)) return { rows: [] };
          return { rows: [] };
        },
      } as unknown as import("./db.js").DbQuery;

      const sent = await sendSignalBotStatsReport({
        chatId: "-1",
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_BUY_AMOUNT_USD: "10",
          HUNCH_SIGNAL_BOT_MIN_CONFIDENCE: "0.7",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        period: "7d",
        telegram,
      });

      assert.equal(sent, true);
      assert.equal(telegram.messages.length, 1);
      assert.match(telegram.messages[0]?.text ?? "", /Hunch signals/);
      assert.match(telegram.messages[0]?.text ?? "", /\$10 each/);
      assert.match(
        telegram.messages[0]?.text ?? "",
        /Open signals use current market marks/,
      );
      assert.doesNotMatch(
        telegram.messages[0]?.text ?? "",
        /evaluated|missingEntry|entryQuality|note_id/i,
      );
      assert.match(queries[0]?.sql ?? "", /n\.confidence >=/);
      assert.match(queries[0]?.sql ?? "", /n\.status = 'active'/);
      assert.match(queries[0]?.sql ?? "", /n\.direction in \('up', 'down'\)/);
      assert.equal(queries[0]?.params.includes(0.7), true);
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
      assert.equal(result.aggCheaperFound, 0);
      assert.equal(result.aggMatched, 0);
      assert.equal(result.sent, 1);
      assert.equal(
        telegram.messages[0]?.reply_markup?.inline_keyboard[1]?.[0]?.text,
        "💸 Cheaper: Kalshi YES 29¢",
      );
    },
  },
  {
    name: "publish skips terminal-price notes before sending",
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
      db.marketRows = [
        {
          id: "polymarket:market-1",
          venue: "polymarket",
          token_yes: "yes-token",
          token_no: "no-token",
          clob_token_ids: null,
          best_bid: "0.99",
          best_ask: "1.00",
          last_price: null,
        },
      ];
      db.tokenTopRows = [
        {
          token_id: "yes-token",
          best_bid: "0.99",
          best_ask: "1.00",
          ts: "2999-01-01T00:00:00.000Z",
        },
        {
          token_id: "no-token",
          best_bid: "0",
          best_ask: "0.01",
          ts: "2999-01-01T00:00:00.000Z",
        },
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

      assert.equal(result.sent, 0);
      assert.equal(result.priceGuardSkipped, 1);
      assert.equal(result.priceGuardTerminalPrice, 1);
      assert.equal(telegram.messages.length, 0);
    },
  },
  {
    name: "publish defers stale price guard without advancing cursor",
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
      db.marketRows = [
        {
          id: "polymarket:market-1",
          venue: "polymarket",
          token_yes: "yes-token",
          token_no: "no-token",
          clob_token_ids: null,
          best_bid: "0.99",
          best_ask: "1.00",
          last_price: null,
        },
      ];
      db.tokenTopRows = [
        {
          token_id: "yes-token",
          best_bid: null,
          best_ask: null,
          ts: "2999-01-01T00:00:00.000Z",
        },
        {
          token_id: "no-token",
          best_bid: null,
          best_ask: null,
          ts: "2999-01-01T00:00:00.000Z",
        },
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

      assert.equal(result.sent, 0);
      assert.equal(result.priceGuardDeferred, 1);
      assert.equal(result.priceGuardLivePriceStale, 1);
      assert.equal(telegram.messages.length, 0);
      const state = await getSignalBotChatState(redis, "-100");
      assert.equal(state?.cursorId, "00000000-0000-0000-0000-000000000000");
    },
  },
  {
    name: "publish expires repeatedly stale price guard and continues later notes",
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
          id: "00000000-0000-4000-8000-000000000001",
          market_id: "polymarket:market-1",
          title: "Stale first signal",
        }),
        noteRow({
          id: "00000000-0000-4000-8000-000000000002",
          market_id: null,
          title: "Later valid signal",
        }),
      ];
      db.marketRows = [
        {
          id: "polymarket:market-1",
          venue: "polymarket",
          token_yes: "yes-token",
          token_no: "no-token",
          clob_token_ids: null,
          best_bid: null,
          best_ask: null,
          last_price: null,
        },
      ];
      db.tokenTopRows = [
        {
          token_id: "yes-token",
          best_bid: null,
          best_ask: null,
          ts: "2999-01-01T00:00:00.000Z",
        },
        {
          token_id: "no-token",
          best_bid: null,
          best_ask: null,
          ts: "2999-01-01T00:00:00.000Z",
        },
      ];
      const telegram = new FakeTelegram();
      const config = parseSignalBotConfig({
        HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
        HUNCH_SIGNAL_BOT_TOKEN: "token",
        SIGNAL_BOT_PRICE_GUARD_MAX_DEFERS: "5",
      });

      for (let i = 0; i < 5; i += 1) {
        const result = await publishSignalBotTick({
          config,
          db,
          redis,
          telegram,
        });
        assert.equal(result.sent, 0);
        assert.equal(result.priceGuardDeferred, 1);
        assert.equal(result.priceGuardStaleExpired, 0);
      }

      const result = await publishSignalBotTick({
        config,
        db,
        redis,
        telegram,
      });
      assert.equal(result.priceGuardDeferred, 0);
      assert.equal(result.priceGuardStaleExpired, 1);
      assert.equal(result.sent, 1);
      assert.match(telegram.messages[0]?.text ?? "", /Later valid signal/);
      const state = await getSignalBotChatState(redis, "-100");
      assert.equal(state?.cursorId, "00000000-0000-4000-8000-000000000002");
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
