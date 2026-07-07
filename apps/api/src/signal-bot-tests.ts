import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  parseSignalBotFollowthroughPreviewRequest,
  parseSignalBotConfig,
  parseSignalBotStatsRequest,
  parseSignalBotStatsPeriod,
  pollSignalBotCommands,
  publishSignalBotFollowthroughTick,
  publishSignalBotTick,
  readSignalBotUpdateOffset,
  refreshSignalBotLock,
  releaseSignalBotLock,
  sendSignalBotFollowthroughPreview,
  resolveSignalBotCheaperAlternativeFromAggResponse,
  resolveSignalBotBuySide,
  sendLatestSignalBotTestSignal,
  sendSignalBotStatsReport,
  signalBotLockKey,
  TelegramBotApiClient,
  type SignalBotNote,
  type SignalBotRedisLike,
  type TelegramBotUpdate,
  type TelegramSendMessageInput,
  type TelegramSendResult,
} from "./services/signal-bot.js";
import {
  buildTelegramBotTradingMarketMessage,
  enableTelegramBotTrading,
  handleTelegramBotTradingCallback,
  reconcileStaleTelegramTradeIntents,
} from "./services/telegram-bot-trading.js";
import { createTelegramBotTradingInternalApiClient } from "./services/telegram-bot-trading-client.js";
import { normalizeSignalBotPolicy } from "./services/signal-bot-trading-policy.js";

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

const apiSrcDir = dirname(fileURLToPath(import.meta.url));
const runtimeImportPattern =
  /\b(import|export)\s+([^;]*?)\s+from\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']/gs;

function resolveLocalImport(
  fromFile: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [];
  if (specifier.endsWith(".js")) {
    candidates.push(base.replace(/\.js$/, ".ts"), base);
  } else {
    candidates.push(
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      join(base, "index.ts"),
      join(base, "index.tsx"),
      join(base, "index.js"),
    );
  }
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function readRuntimeLocalImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const imports: string[] = [];
  runtimeImportPattern.lastIndex = 0;
  let match: RegExpExecArray | null = null;
  while ((match = runtimeImportPattern.exec(source))) {
    if (match[4]) {
      const resolvedImport = resolveLocalImport(file, match[4]);
      if (resolvedImport) imports.push(resolvedImport);
      continue;
    }
    const importKind = match[1];
    const clause = (match[2] ?? "").trim();
    const specifier = match[3];
    if (!specifier) continue;
    if (clause.startsWith("type ")) continue;
    if (importKind === "export" && clause.startsWith("type ")) continue;
    const resolvedImport = resolveLocalImport(file, specifier);
    if (resolvedImport) imports.push(resolvedImport);
  }
  return imports;
}

function collectRuntimeImportGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    for (const imported of readRuntimeLocalImports(file)) {
      if (!seen.has(imported)) queue.push(imported);
    }
  }
  return seen;
}

class FakeTelegram {
  readonly callbackAnswers: Array<{
    callbackQueryId: string;
    showAlert?: boolean;
    text?: string;
  }> = [];
  readonly messages: TelegramSendMessageInput[] = [];
  readonly updateRequests: Array<{
    offset: number | null;
    timeoutSec: number;
  }> = [];
  nextResult: TelegramSendResult | null = null;
  nextResults: TelegramSendResult[] = [];
  updates: TelegramBotUpdate[] = [];
  private nextMessageId = 100;

  async answerCallbackQuery(input: {
    callbackQueryId: string;
    showAlert?: boolean;
    text?: string;
  }): Promise<{ ok: true }> {
    this.callbackAnswers.push(input);
    return { ok: true };
  }

  async getUpdates(input: {
    offset: number | null;
    timeoutSec: number;
  }): Promise<TelegramBotUpdate[]> {
    this.updateRequests.push(input);
    return this.updates;
  }

  async sendMessage(
    input: TelegramSendMessageInput,
  ): Promise<TelegramSendResult> {
    this.messages.push(input);
    const nextResult = this.nextResults.shift();
    if (nextResult) return nextResult;
    if (this.nextResult) return this.nextResult;
    this.nextMessageId += 1;
    return { messageId: this.nextMessageId, ok: true };
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
  threadContextRows: unknown[] = [];
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
    if (sql.includes("from signal_bot_messages prior")) {
      return {
        command: "SELECT",
        fields: [],
        oid: 0,
        rowCount: this.threadContextRows.length,
        rows: this.threadContextRows as T[],
      };
    }
    if (sql.includes("insert into signal_bot_messages")) {
      return {
        command: "INSERT",
        fields: [],
        oid: 0,
        rowCount: 1,
        rows: [],
      };
    }
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

class FakeFollowthroughDb {
  candidateRows: unknown[] = [];
  flowRows: unknown[] = [];
  runtimePayload: unknown = null;
  readonly queries: Array<{ params: unknown[]; sql: string }> = [];

  query<T extends QueryResultRow = QueryResultRow>(): Promise<QueryResult<T>>;
  async query<T extends QueryResultRow = QueryResultRow>(
    ...args: unknown[]
  ): Promise<QueryResult<T>> {
    const sql = String(args[0] ?? "");
    const params = Array.isArray(args[1]) ? (args[1] as unknown[]) : [];
    this.queries.push({ params, sql });
    if (sql.includes("from runtime_policies")) {
      const rows =
        this.runtimePayload == null ? [] : [{ payload: this.runtimePayload }];
      return {
        command: "SELECT",
        fields: [],
        oid: 0,
        rowCount: rows.length,
        rows: rows as unknown as T[],
      };
    }
    if (sql.includes("from signal_bot_messages root")) {
      return {
        command: "SELECT",
        fields: [],
        oid: 0,
        rowCount: this.candidateRows.length,
        rows: this.candidateRows as T[],
      };
    }
    if (sql.includes("from wallet_activity_events")) {
      return {
        command: "SELECT",
        fields: [],
        oid: 0,
        rowCount: this.flowRows.length,
        rows: this.flowRows as T[],
      };
    }
    if (sql.includes("insert into signal_bot_messages")) {
      return {
        command: "INSERT",
        fields: [],
        oid: 0,
        rowCount: 1,
        rows: [],
      };
    }
    return {
      command: "SELECT",
      fields: [],
      oid: 0,
      rowCount: 0,
      rows: [],
    };
  }
}

function followthroughCandidateRow(overrides: Record<string, unknown> = {}) {
  return {
    chat_id: "-100",
    thread_root_note_id: "00000000-0000-4000-8000-000000000101",
    reply_to_message_id: "77",
    baseline_at: "2026-01-01T00:00:00.000Z",
    title: "Wallets liked YES",
    direction: "up",
    metrics: {
      market: { yesProbability: 0.4 },
      signalSnapshot: {
        quote: { buyPrice: 0.4 },
        side: "YES",
      },
    },
    target_meta: { side: "YES" },
    market_id: "polymarket:market-1",
    event_id: "polymarket:event-1",
    market_title: "Will test resolve Yes?",
    event_title: "Test event",
    outcomes: null,
    venue: "polymarket",
    best_bid: "0.55",
    best_ask: "0.57",
    last_price: null,
    resolved_outcome: null,
    resolved_outcome_pct: null,
    accepting_orders: true,
    ...overrides,
  };
}

function followthroughFlowRow(overrides: Record<string, unknown> = {}) {
  return {
    wallet_id: "wallet-1",
    outcome_side: "YES",
    baseline_shares: null,
    latest_shares: "100",
    latest_size_usd: "5500",
    positive_usd: "5000",
    negative_usd: "0",
    net_usd: "5000",
    net_shares: "100",
    event_count: "1",
    ...overrides,
  };
}

async function enableFollowthroughTestChat(redis: FakeRedis): Promise<void> {
  await enableSignalBotChat({
    chat: { id: "-100", title: "Signals", type: "channel" },
    enabledBy: 123,
    now: new Date("2026-01-01T00:00:00.000Z"),
    redis,
  });
}

function readStartAppParam(url: string | undefined): string {
  assert.ok(url);
  const startapp = new URL(url).searchParams.get("startapp");
  assert.ok(startapp);
  assert.match(startapp, /^[A-Za-z0-9_-]{1,512}$/);
  return startapp;
}

function readWebAppStartParam(
  button: { web_app?: { url: string } } | undefined,
): string {
  assert.ok(button?.web_app?.url);
  const url = new URL(button.web_app.url);
  assert.equal(url.origin, "https://app.hunch.trade");
  assert.equal(url.pathname, "/tg");
  const startParam = url.searchParams.get("tgWebAppStartParam");
  assert.ok(startParam);
  assert.match(startParam, /^[A-Za-z0-9_-]{1,512}$/);
  return startParam;
}

function decodeStartAppPayload(startParam: string): string {
  const separator = startParam.indexOf("_");
  assert.notEqual(separator, -1);
  const payload = startParam.slice(separator + 1);
  return Buffer.from(payload, "base64url").toString("utf8");
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
      assert.deepEqual(config.followthrough, {
        enabled: false,
        types: ["stats", "resolved_win", "resolved_loss"],
        minAgeHours: 24,
        maxPerTick: 3,
        minJoinedOrAdded: 2,
        minNetFlowUsd: 10_000,
        minPriceMoveCents: 10,
        requirePositiveFlowForStats: false,
        minDataQuality: "any",
      });
      assert.equal(config.telegramMiniAppLinkBase, null);
    },
  },
  {
    name: "env parser accepts Telegram Mini App link base",
    run: () => {
      const config = parseSignalBotConfig({
        HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE:
          "https://t.me/hunch_signal_bot/hunch?ignored=1#hash",
        HUNCH_SIGNAL_BOT_TOKEN: "token",
      });
      assert.equal(
        config.telegramMiniAppLinkBase,
        "https://t.me/hunch_signal_bot/hunch",
      );

      const invalid = parseSignalBotConfig({
        HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE:
          "https://app.hunch.trade/tg",
        HUNCH_SIGNAL_BOT_TOKEN: "token",
      });
      assert.equal(invalid.telegramMiniAppLinkBase, null);
    },
  },
  {
    name: "Telegram client returns message id and retry_after",
    run: async () => {
      const originalFetch = globalThis.fetch;
      try {
        const responses = [
          new Response(
            JSON.stringify({ ok: true, result: { message_id: 456 } }),
            { status: 200 },
          ),
          new Response(
            JSON.stringify({
              description: "Too Many Requests",
              ok: false,
              parameters: { retry_after: 9 },
            }),
            { status: 429 },
          ),
        ];
        globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
          const init = args[1];
          assert.equal(init?.method, "POST");
          const body = JSON.parse(String(init?.body ?? "{}"));
          assert.equal(body.chat_id, "-100");
          return responses.shift() ?? new Response("{}", { status: 500 });
        }) as typeof fetch;

        const client = new TelegramBotApiClient("token");
        const sent = await client.sendMessage({
          chat_id: "-100",
          disable_web_page_preview: true,
          parse_mode: "MarkdownV2",
          text: "hello",
        });
        assert.deepEqual(sent, { messageId: 456, ok: true });
        const rateLimited = await client.sendMessage({
          chat_id: "-100",
          disable_web_page_preview: true,
          parse_mode: "MarkdownV2",
          text: "hello",
        });
        assert.deepEqual(rateLimited, {
          error: "other",
          message: "Too Many Requests",
          ok: false,
          retryAfterSec: 9,
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
  {
    name: "Telegram client polls callback queries and answers callbacks",
    run: async () => {
      const originalFetch = globalThis.fetch;
      try {
        const seenUrls: string[] = [];
        const seenBodies: unknown[] = [];
        const responses = [
          new Response(JSON.stringify({ ok: true, result: [] }), {
            status: 200,
          }),
          new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          }),
        ];
        globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
          seenUrls.push(String(args[0]));
          if (args[1]?.body) seenBodies.push(JSON.parse(String(args[1].body)));
          return responses.shift() ?? new Response("{}", { status: 500 });
        }) as typeof fetch;

        const client = new TelegramBotApiClient("token");
        await client.getUpdates({ offset: 42, timeoutSec: 25 });
        const url = new URL(seenUrls[0] ?? "");
        assert.equal(url.searchParams.get("offset"), "42");
        assert.deepEqual(
          JSON.parse(url.searchParams.get("allowed_updates") ?? "[]"),
          ["message", "callback_query"],
        );

        await client.answerCallbackQuery({
          callbackQueryId: "callback-1",
          showAlert: true,
          text: "Done",
        });
        assert.deepEqual(seenBodies[0], {
          callback_query_id: "callback-1",
          show_alert: true,
          text: "Done",
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
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
    name: "followthrough preview parser supports kind aliases and target chat",
    run: () => {
      assert.equal(
        parseSignalBotCommand("/test_followthrough", null),
        "test_followthrough",
      );
      assert.deepEqual(
        parseSignalBotFollowthroughPreviewRequest("/test_followthrough"),
        { kind: "stats", targetChatId: null },
      );
      assert.deepEqual(
        parseSignalBotFollowthroughPreviewRequest(
          "/test_followthrough win -1001234567890",
        ),
        { kind: "resolved_win", targetChatId: "-1001234567890" },
      );
      assert.deepEqual(
        parseSignalBotFollowthroughPreviewRequest(
          "/test_followthrough 1234567890 loss",
        ),
        { kind: "resolved_loss", targetChatId: "-1001234567890" },
      );
      assert.equal(
        parseSignalBotFollowthroughPreviewRequest("/test_followthrough maybe"),
        null,
      );
    },
  },
  {
    name: "trading command parser accepts private trading commands",
    run: () => {
      assert.equal(
        parseSignalBotCommand("/trade_status", null),
        "trade_status",
      );
      assert.equal(
        parseSignalBotCommand("/disable_trading", null),
        "disable_trading",
      );
      assert.equal(parseSignalBotCommand("/market", null), "market");
      assert.equal(parseSignalBotCommand("/test_trade", null), "test_trade");
    },
  },
  {
    name: "disable trading command reports disabled, already disabled, and unavailable distinctly",
    run: async () => {
      const cases = [
        {
          expected: /Telegram bot trading disabled/,
          result: "disabled" as const,
        },
        {
          expected: /already disabled/,
          result: "already_disabled" as const,
        },
        {
          expected: /Trading is unavailable/,
          result: "unavailable" as const,
        },
      ];
      for (const testCase of cases) {
        const redis = new FakeRedis();
        const telegram = new FakeTelegram();
        const handled = await handleSignalBotCommand({
          config: parseSignalBotConfig({
            HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
            HUNCH_SIGNAL_BOT_TOKEN: "token",
          }),
          disableTrading: async () => testCase.result,
          message: {
            chat: { id: 999, first_name: "Kreedle", type: "private" },
            from: { id: 999 },
            text: "/disable_trading",
          },
          redis,
          sendMessage: (message) => telegram.sendMessage(message),
          sendTestSignal: async () => false,
        });
        assert.equal(handled, true);
        assert.match(telegram.messages[0]?.text ?? "", testCase.expected);
      }
    },
  },
  {
    name: "internal trading API client times out stalled calls",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        })) as typeof fetch;
      try {
        const client = createTelegramBotTradingInternalApiClient({
          baseUrl: "https://api.hunch.trade",
          timeoutMs: 1,
          token: "token",
        });
        await assert.rejects(
          () => client.buildStatusMessage(999),
          /timed out/,
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
  {
    name: "internal trading API client reports unknown status on confirm timeout",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        })) as typeof fetch;
      try {
        const client = createTelegramBotTradingInternalApiClient({
          baseUrl: "https://api.hunch.trade",
          executeTimeoutMs: 1,
          timeoutMs: 60_000,
          token: "token",
        });
        const answers: Array<{ text?: string; showAlert?: boolean }> = [];
        const messages: Array<{ text: string }> = [];
        const handled = await client.handleCallback({
          answerCallbackQuery: async (input) => {
            answers.push(input);
          },
          appBaseUrl: "https://app.hunch.trade",
          callbackQuery: {
            data: "hbt:confirm:00000000-0000-4000-8000-000000000001",
            from: { id: 999 },
            id: "callback-1",
            message: { chat: { id: 999 } },
          },
          sendMessage: async (input) => {
            messages.push(input);
          },
        });
        assert.equal(handled, true);
        assert.equal(answers[0]?.showAlert, true);
        assert.match(answers[0]?.text ?? "", /status is unknown/i);
        assert.match(messages[0]?.text ?? "", /before retrying/i);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
  {
    name: "private market command delegates to trading card hook",
    run: async () => {
      const redis = new FakeRedis();
      const telegram = new FakeTelegram();
      let call: {
        chatId: string;
        isAdminTest?: boolean;
        marketRef: string;
        telegramMessageId?: number | null;
        telegramUserId: number;
      } | null = null;
      const handled = await handleSignalBotCommand({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        message: {
          chat: { id: 999, first_name: "Kreedle", type: "private" },
          from: { id: 999 },
          message_id: 12,
          text: "/market polymarket:market-1",
        },
        redis,
        sendMessage: (message) => telegram.sendMessage(message),
        sendTestSignal: async () => false,
        sendTradeMarket: async (input) => {
          call = input;
          return true;
        },
      });
      assert.equal(handled, true);
      assert.deepEqual(call, {
        chatId: "999",
        marketRef: "polymarket:market-1",
        telegramMessageId: 12,
        telegramUserId: 999,
      });
      assert.equal(telegram.messages.length, 0);
    },
  },
  {
    name: "market command refuses group trading for non-test users",
    run: async () => {
      const redis = new FakeRedis();
      const telegram = new FakeTelegram();
      let called = false;
      const handled = await handleSignalBotCommand({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        message: {
          chat: { id: -100, title: "Group", type: "group" },
          from: { id: 999 },
          text: "/market polymarket:market-1",
        },
        redis,
        sendMessage: (message) => telegram.sendMessage(message),
        sendTestSignal: async () => false,
        sendTradeMarket: async () => {
          called = true;
          return true;
        },
      });
      assert.equal(handled, true);
      assert.equal(called, false);
      assert.match(telegram.messages[0]?.text ?? "", /private chat/);
    },
  },
  {
    name: "admin test trade delegates to trading card preview hook",
    run: async () => {
      const redis = new FakeRedis();
      const telegram = new FakeTelegram();
      let isAdminTest = false;
      const handled = await handleSignalBotCommand({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        message: {
          chat: { id: -100, title: "Group", type: "group" },
          from: { id: 123 },
          message_id: 44,
          text: "/test_trade https://app.hunch.trade/events/e?market=m1",
        },
        redis,
        sendMessage: (message) => telegram.sendMessage(message),
        sendTestSignal: async () => false,
        sendTradeMarket: async (input) => {
          isAdminTest = Boolean(input.isAdminTest);
          assert.equal(
            input.marketRef,
            "https://app.hunch.trade/events/e?market=m1",
          );
          assert.equal(input.telegramMessageId, 44);
          return true;
        },
      });
      assert.equal(handled, true);
      assert.equal(isAdminTest, true);
      assert.match(telegram.messages[0]?.text ?? "", /Sent trade card preview/);
    },
  },
  {
    name: "admin test trade card preview never creates live trade callbacks",
    run: async () => {
      let insertCount = 0;
      const db = {
        query: async (sql: string) => {
          if (/from runtime_policies/i.test(sql)) {
            return {
              rowCount: 1,
              rows: [
                {
                  payload: {
                    tradingEnabled: true,
                    tradingActions: ["buy"],
                    tradingVenues: ["polymarket"],
                    buyAmountPresetsUsd: [10],
                    maxTradeAmountUsd: 50,
                    maxSlippageBps: 500,
                    intentTtlSec: 120,
                  },
                },
              ],
            };
          }
          if (sql.includes("FROM user_telegram_accounts uta")) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: "authorization-1",
                  user_id: "user-1",
                  privy_user_id: "privy-1",
                  telegram_user_id: "999",
                  username: "admin",
                  wallet_address: "0x0000000000000000000000000000000000000001",
                  wallet_chain: "ethereum",
                  privy_wallet_id: "wallet-1",
                  enabled: true,
                  enabled_venues: ["polymarket"],
                  max_amount_usd: "50",
                  disabled_at: null,
                  last_verified_at: new Date(),
                },
              ],
            };
          }
          if (sql.includes("FROM telegram_bot_trading_authorizations a")) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: "authorization-1",
                  user_id: "user-1",
                  telegram_user_id: "999",
                  privy_user_id: "privy-1",
                  wallet_address: "0x0000000000000000000000000000000000000001",
                  wallet_chain: "ethereum",
                  privy_wallet_id: "wallet-1",
                  enabled: true,
                  enabled_venues: ["polymarket"],
                  max_amount_usd: "50",
                },
              ],
            };
          }
          if (sql.includes("FROM telegram_bot_trading_authorizations a")) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: "authorization-1",
                  user_id: "user-1",
                  telegram_user_id: "999",
                  privy_user_id: "privy-1",
                  wallet_address: "0x0000000000000000000000000000000000000001",
                  wallet_chain: "ethereum",
                  privy_wallet_id: "wallet-1",
                  enabled: true,
                  enabled_venues: ["polymarket"],
                  max_amount_usd: "50",
                },
              ],
            };
          }
          if (sql.includes("FROM unified_markets m")) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: "market-1",
                  venue: "polymarket",
                  venue_market_id: "venue-market-1",
                  event_id: "event-1",
                  event_title: "Event",
                  title: "Market",
                  status: "ACTIVE",
                  outcomes: JSON.stringify(["YES", "NO"]),
                  metadata: {},
                  close_time: new Date(Date.now() + 60_000),
                  expiration_time: null,
                  event_end_time: null,
                  best_bid: "0.4",
                  best_ask: "0.6",
                  last_price: "0.5",
                },
              ],
            };
          }
          if (sql.includes("INSERT INTO telegram_trade_intents")) {
            insertCount += 1;
            throw new Error("preview should not insert intents");
          }
          return { rowCount: 0, rows: [] };
        },
      };
      const message = await buildTelegramBotTradingMarketMessage({
        appBaseUrl: "https://app.hunch.trade",
        chatId: "999",
        db: db as never,
        isAdminTest: true,
        marketRef: "market-1",
        telegramUserId: 999,
        trading: {
          getReadiness: async () => ({
            ready: true,
            executable: true,
            reasonCode: null,
            message: null,
            setupRequired: false,
            capabilities: {
              venue: "polymarket",
              supportsBuy: true,
              supportsSell: false,
              supportsCancel: false,
              supportsOrderSync: false,
              supportsPositionSync: false,
              supportsExecutionSync: false,
              supportsSetup: false,
              authorizationModes: ["server_delegated"],
            },
          }),
        } as never,
      });
      assert.equal(insertCount, 0);
      assert.match(message.text, /Preview only/);
      const buttons = message.reply_markup?.inline_keyboard.flat() ?? [];
      assert.equal(
        buttons.some((button) => "callback_data" in button),
        false,
      );
      assert.equal(
        buttons.some((button) => "url" in button),
        true,
      );
    },
  },
  {
    name: "market card suppresses live buy callbacks while venue execution is disabled",
    run: async () => {
      let insertCount = 0;
      const db = {
        query: async (sql: string) => {
          if (/from runtime_policies/i.test(sql)) {
            return {
              rowCount: 1,
              rows: [
                {
                  payload: {
                    tradingEnabled: true,
                    tradingActions: ["buy"],
                    tradingVenues: ["polymarket"],
                    buyAmountPresetsUsd: [10, 25],
                    maxTradeAmountUsd: 50,
                    maxSlippageBps: 500,
                    intentTtlSec: 120,
                  },
                },
              ],
            };
          }
          if (sql.includes("FROM user_telegram_accounts uta")) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: "authorization-1",
                  user_id: "user-1",
                  privy_user_id: "privy-1",
                  telegram_user_id: "999",
                  username: "admin",
                  wallet_address: "0x0000000000000000000000000000000000000001",
                  wallet_chain: "ethereum",
                  privy_wallet_id: "wallet-1",
                  enabled: true,
                  enabled_venues: ["polymarket"],
                  max_amount_usd: "50",
                  disabled_at: null,
                  last_verified_at: new Date(),
                },
              ],
            };
          }
          if (sql.includes("FROM telegram_bot_trading_authorizations a")) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: "authorization-1",
                  user_id: "user-1",
                  telegram_user_id: "999",
                  privy_user_id: "privy-1",
                  wallet_address: "0x0000000000000000000000000000000000000001",
                  wallet_chain: "ethereum",
                  privy_wallet_id: "wallet-1",
                  enabled: true,
                  enabled_venues: ["polymarket"],
                  max_amount_usd: "50",
                },
              ],
            };
          }
          if (sql.includes("FROM unified_markets m")) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: "market-1",
                  venue: "polymarket",
                  venue_market_id: "venue-market-1",
                  event_id: "event-1",
                  event_title: "Event",
                  title: "Market",
                  status: "ACTIVE",
                  outcomes: JSON.stringify(["YES", "NO"]),
                  metadata: {},
                  close_time: new Date(Date.now() + 60_000),
                  expiration_time: null,
                  event_end_time: null,
                  best_bid: "0.4",
                  best_ask: "0.6",
                  last_price: "0.5",
                },
              ],
            };
          }
          if (sql.includes("INSERT INTO telegram_trade_intents")) {
            insertCount += 1;
            throw new Error("disabled execution should not insert intents");
          }
          return { rowCount: 0, rows: [] };
        },
      };
      const message = await buildTelegramBotTradingMarketMessage({
        appBaseUrl: "https://app.hunch.trade",
        chatId: "999",
        db: db as never,
        marketRef: "market-1",
        telegramUserId: 999,
        trading: {
          getReadiness: async () => ({
            ready: false,
            executable: false,
            reasonCode: "unsupported_capability",
            message: "Direct bot trading is disabled for this venue.",
            setupRequired: false,
            capabilities: {
              venue: "polymarket",
              supportsBuy: false,
              supportsSell: false,
              supportsCancel: false,
              supportsOrderSync: false,
              supportsPositionSync: false,
              supportsExecutionSync: false,
              supportsSetup: false,
              authorizationModes: ["unsupported"],
            },
          }),
        } as never,
      });
      assert.equal(insertCount, 0);
      assert.match(message.text, /Direct bot trading is disabled/);
      const buttons = message.reply_markup?.inline_keyboard.flat() ?? [];
      assert.equal(
        buttons.some((button) => "callback_data" in button),
        false,
      );
      assert.equal(
        buttons.some((button) => "url" in button),
        true,
      );
    },
  },
  {
    name: "polling handles callback queries and advances offset",
    run: async () => {
      const redis = new FakeRedis();
      const telegram = new FakeTelegram();
      telegram.updates = [
        {
          callback_query: {
            data: "hbt:buy:00000000-0000-4000-8000-000000000001",
            from: { id: 999 },
            id: "callback-1",
          },
          update_id: 100,
        },
      ];
      let callbackData: string | undefined;
      const handled = await pollSignalBotCommands({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        handleCallback: async (callbackQuery) => {
          callbackData = callbackQuery.data;
          return true;
        },
        redis,
        sendTestSignal: async () => false,
        telegram,
      });
      assert.equal(handled, 1);
      assert.equal(
        callbackData,
        "hbt:buy:00000000-0000-4000-8000-000000000001",
      );
      assert.equal(await readSignalBotUpdateOffset(redis), 101);
    },
  },
  {
    name: "polling catches callback errors and advances offset",
    run: async () => {
      const redis = new FakeRedis();
      const telegram = new FakeTelegram();
      telegram.updates = [
        {
          callback_query: {
            data: "hbt:buy:00000000-0000-4000-8000-000000000001",
            from: { id: 999 },
            id: "callback-1",
          },
          update_id: 100,
        },
      ];
      const handled = await pollSignalBotCommands({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        handleCallback: async () => {
          throw new Error("callback failed");
        },
        redis,
        sendTestSignal: async () => false,
        telegram,
      });
      assert.equal(handled, 1);
      assert.equal(await readSignalBotUpdateOffset(redis), 101);
      assert.deepEqual(telegram.callbackAnswers[0], {
        callbackQueryId: "callback-1",
        showAlert: true,
        text: "Action failed. Try again.",
      });
    },
  },
  {
    name: "polling catches message command errors and advances offset",
    run: async () => {
      const redis = new FakeRedis();
      const telegram = new FakeTelegram();
      telegram.updates = [
        {
          message: {
            chat: { id: 999, type: "private" },
            from: { id: 999 },
            message_id: 1,
            text: "/trade_status",
          },
          update_id: 100,
        },
      ];
      const handled = await pollSignalBotCommands({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        redis,
        sendTestSignal: async () => false,
        sendTradeStatus: async () => {
          throw new Error("internal API down");
        },
        telegram,
      });
      assert.equal(handled, 1);
      assert.equal(await readSignalBotUpdateOffset(redis), 101);
      assert.match(telegram.messages[0]?.text ?? "", /Command failed/);
    },
  },
  {
    name: "trading callback parser rejects malformed UUID payloads before DB access",
    run: async () => {
      const telegram = new FakeTelegram();
      const db = {
        query: async () => {
          throw new Error("unexpected db query");
        },
      };
      for (const data of [
        "hbt:buy:not-a-real-uuid",
        "hbt:buy:00000000-0000-0000-0000-000000000001",
        "hbt:buy:00000000-0000-4000-8000-000000000001:extra",
      ]) {
        const handled = await handleTelegramBotTradingCallback({
          answerCallbackQuery: (input) => telegram.answerCallbackQuery(input),
          appBaseUrl: "https://app.hunch.trade",
          callbackQuery: {
            data,
            from: { id: 999 },
            id: "callback-1",
          },
          db: db as never,
          sendMessage: (message) => telegram.sendMessage(message as never),
        });
        assert.equal(handled, false);
      }
      assert.equal(telegram.callbackAnswers.length, 0);
      assert.equal(telegram.messages.length, 0);
    },
  },
  {
    name: "trading callback rejects expected route action or intent mismatch before DB access",
    run: async () => {
      const telegram = new FakeTelegram();
      const db = {
        query: async () => {
          throw new Error("unexpected db query");
        },
      };
      const handled = await handleTelegramBotTradingCallback({
        answerCallbackQuery: (input) => telegram.answerCallbackQuery(input),
        appBaseUrl: "https://app.hunch.trade",
        callbackQuery: {
          data: "hbt:confirm:00000000-0000-4000-8000-000000000001",
          from: { id: 999 },
          id: "callback-1",
        },
        db: db as never,
        expectedIntentId: "00000000-0000-4000-8000-000000000002",
        expectedType: "confirm",
        sendMessage: (message) => telegram.sendMessage(message as never),
      });
      assert.equal(handled, true);
      assert.equal(telegram.messages.length, 0);
      assert.match(telegram.callbackAnswers[0]?.text ?? "", /does not match/);
    },
  },
  {
    name: "stale trading intent reconciliation separates pre-submit and post-submit rows",
    run: async () => {
      const statements: string[] = [];
      const db = {
        query: async (sql: string) => {
          statements.push(sql);
          if (sql.includes("status = 'expired'")) {
            return { rowCount: 2, rows: [] };
          }
          if (sql.includes("stale_pre_submit_execution")) {
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes("submit_state_unknown")) {
            return { rowCount: 2, rows: [] };
          }
          if (sql.includes("error_code = 'reconcile_required'")) {
            return { rowCount: 3, rows: [] };
          }
          return { rowCount: 0, rows: [] };
        },
      };
      const result = await reconcileStaleTelegramTradeIntents(db as never, {
        executingGraceMs: 60_000,
        now: new Date("2026-07-07T12:00:00Z"),
      });
      assert.deepEqual(result, {
        expiredPending: 2,
        failedPreSubmitExecuting: 1,
        submittedReconcileRequired: 3,
        unknownSubmitReconcileRequired: 2,
      });
      assert.match(statements[0] ?? "", /expires_at <=/);
      assert.match(statements[1] ?? "", /venue_order_id IS NULL/);
      assert.match(statements[1] ?? "", /submit_started_at IS NULL/);
      assert.match(statements[2] ?? "", /status = 'reconcile_required'/);
      assert.match(statements[2] ?? "", /submit_started_at IS NOT NULL/);
      assert.match(statements[3] ?? "", /venue_order_id IS NOT NULL/);
      assert.match(statements[3] ?? "", /status = 'submitted'/);
      assert.match(statements[3] ?? "", /error_code = 'reconcile_required'/);
    },
  },
  {
    name: "enabling bot trading stores only venues compatible with selected wallet chain",
    run: async () => {
      const cases: Array<{
        expectedVenues: string[];
        walletAddress: string;
        walletType: "ethereum" | "solana";
      }> = [
        {
          expectedVenues: ["polymarket", "limitless"],
          walletAddress: "0x0000000000000000000000000000000000000001",
          walletType: "ethereum",
        },
        {
          expectedVenues: ["kalshi"],
          walletAddress: "So11111111111111111111111111111111111111112",
          walletType: "solana",
        },
      ];
      for (const testCase of cases) {
        let storedVenues: unknown = null;
        const db = {
          query: async (sql: string, params?: unknown[]) => {
            if (sql.includes("FROM user_wallets uw")) {
              return {
                rowCount: 1,
                rows: [
                  {
                    privy_user_id: "privy-1",
                    telegram_user_id: "999",
                    wallet_address: testCase.walletAddress,
                    wallet_type: testCase.walletType,
                  },
                ],
              };
            }
            if (/from runtime_policies/i.test(sql)) {
              return {
                rowCount: 1,
                rows: [
                  {
                    payload: {
                      tradingEnabled: true,
                      tradingActions: ["buy"],
                      tradingVenues: ["polymarket", "limitless", "kalshi"],
                      buyAmountPresetsUsd: [10],
                      maxTradeAmountUsd: 50,
                      maxSlippageBps: 500,
                      intentTtlSec: 120,
                    },
                  },
                ],
              };
            }
            if (
              sql.includes("INSERT INTO telegram_bot_trading_authorizations")
            ) {
              storedVenues = params?.[6];
              return { rowCount: 1, rows: [] };
            }
            if (sql.includes("FROM user_telegram_accounts uta")) {
              return {
                rowCount: 1,
                rows: [
                  {
                    id: "authorization-1",
                    user_id: "user-1",
                    privy_user_id: "privy-1",
                    telegram_user_id: "999",
                    username: "user",
                    wallet_address: testCase.walletAddress,
                    wallet_chain: testCase.walletType,
                    privy_wallet_id: "wallet-1",
                    enabled: true,
                    enabled_venues: storedVenues,
                    max_amount_usd: "50",
                    disabled_at: null,
                    last_verified_at: new Date(),
                  },
                ],
              };
            }
            return { rowCount: 0, rows: [] };
          },
        };
        const status = await enableTelegramBotTrading(db as never, {
          enabledVenues: ["polymarket", "limitless", "kalshi"],
          privyWalletId: "wallet-1",
          userId: "user-1",
          walletAddress: testCase.walletAddress,
        });
        assert.deepEqual(storedVenues, testCase.expectedVenues);
        assert.deepEqual(status.enabledVenues, testCase.expectedVenues);
      }
    },
  },
  {
    name: "trading callback does not advance terminal intents",
    run: async () => {
      const telegram = new FakeTelegram();
      let updateCount = 0;
      const db = {
        query: async (sql: string) => {
          if (sql.includes("FROM telegram_trade_intents i")) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: "00000000-0000-4000-8000-000000000001",
                  telegram_user_id: "999",
                  user_id: null,
                  authorization_id: null,
                  chat_id: "999",
                  telegram_message_id: null,
                  action: "buy",
                  venue: "polymarket",
                  market_id: "market-1",
                  event_id: "event-1",
                  side: "YES",
                  amount_usd: "10",
                  status: "failed",
                  quote_snapshot: {},
                  policy_snapshot: {},
                  expires_at: new Date(Date.now() + 60_000),
                  market_title: "Market",
                  market_status: "ACTIVE",
                },
              ],
            };
          }
          if (sql.includes("UPDATE telegram_trade_intents")) {
            updateCount += 1;
          }
          return { rowCount: 0, rows: [] };
        },
      };
      const handled = await handleTelegramBotTradingCallback({
        answerCallbackQuery: (input) => telegram.answerCallbackQuery(input),
        appBaseUrl: "https://app.hunch.trade",
        callbackQuery: {
          data: "hbt:buy:00000000-0000-4000-8000-000000000001",
          from: { id: 999 },
          id: "callback-1",
        },
        db: db as never,
        sendMessage: (message) => telegram.sendMessage(message as never),
      });
      assert.equal(handled, true);
      assert.equal(updateCount, 0);
      assert.match(
        telegram.callbackAnswers[0]?.text ?? "",
        /already processed/,
      );
    },
  },
  {
    name: "trading callback enforces authorization max amount before confirmation",
    run: async () => {
      const telegram = new FakeTelegram();
      const updateStatuses: string[] = [];
      const db = {
        query: async (sql: string, params?: unknown[]) => {
          if (/from runtime_policies/i.test(sql)) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: "runtime-policy-1",
                  policy_key: "signal_bot",
                  effective_at: new Date("2026-01-01T00:00:00.000Z"),
                  created_at: new Date("2026-01-01T00:00:00.000Z"),
                  created_by: null,
                  payload: {
                    tradingEnabled: true,
                    tradingActions: ["buy"],
                    tradingVenues: ["polymarket"],
                    buyAmountPresetsUsd: [10],
                    maxTradeAmountUsd: 50,
                    maxSlippageBps: 500,
                    intentTtlSec: 120,
                  },
                },
              ],
            };
          }
          if (sql.includes("FROM telegram_trade_intents i")) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: "00000000-0000-4000-8000-000000000001",
                  telegram_user_id: "999",
                  user_id: null,
                  authorization_id: null,
                  chat_id: "999",
                  telegram_message_id: null,
                  action: "buy",
                  venue: "polymarket",
                  market_id: "market-1",
                  event_id: "event-1",
                  side: "YES",
                  amount_usd: "10",
                  status: "draft",
                  quote_snapshot: {},
                  policy_snapshot: {},
                  expires_at: new Date(Date.now() + 60_000),
                  market_title: "Market",
                  market_status: "ACTIVE",
                },
              ],
            };
          }
          if (sql.includes("FROM telegram_bot_trading_authorizations a")) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: "authorization-1",
                  user_id: "user-1",
                  telegram_user_id: "999",
                  privy_user_id: "privy-1",
                  wallet_address: "0x0000000000000000000000000000000000000001",
                  wallet_chain: "ethereum",
                  privy_wallet_id: null,
                  enabled: true,
                  enabled_venues: ["polymarket"],
                  max_amount_usd: "5",
                },
              ],
            };
          }
          if (sql.includes("FROM unified_markets m")) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: "market-1",
                  venue: "polymarket",
                  venue_market_id: "venue-market-1",
                  event_id: "event-1",
                  event_title: "Event",
                  title: "Market",
                  status: "ACTIVE",
                  outcomes: JSON.stringify(["YES", "NO"]),
                  metadata: {},
                  close_time: new Date(Date.now() + 60_000),
                  expiration_time: null,
                  event_end_time: null,
                  best_bid: "0.4",
                  best_ask: "0.6",
                  last_price: "0.5",
                },
              ],
            };
          }
          if (sql.includes("UPDATE telegram_trade_intents")) {
            updateStatuses.push(String(params?.[1]));
            return { rowCount: 1, rows: [{ id: params?.[0] }] };
          }
          return { rowCount: 0, rows: [] };
        },
      };
      const handled = await handleTelegramBotTradingCallback({
        answerCallbackQuery: (input) => telegram.answerCallbackQuery(input),
        appBaseUrl: "https://app.hunch.trade",
        callbackQuery: {
          data: "hbt:buy:00000000-0000-4000-8000-000000000001",
          from: { id: 999 },
          id: "callback-1",
        },
        db: db as never,
        sendMessage: (message) => telegram.sendMessage(message as never),
      });
      assert.equal(handled, true);
      assert.deepEqual(updateStatuses, ["failed"]);
      assert.match(telegram.callbackAnswers[0]?.text ?? "", /not ready/);
      assert.equal(telegram.messages.length, 1);
      assert.match(telegram.messages[0]?.text ?? "", /Open Hunch/);
    },
  },
  {
    name: "old buy callback fails closed before quote or venue execution",
    run: async () => {
      const telegram = new FakeTelegram();
      let quoteCalls = 0;
      const updateStatuses: string[] = [];
      const db = {
        query: async (sql: string, params?: unknown[]) => {
          if (/from runtime_policies/i.test(sql)) {
            return {
              rowCount: 1,
              rows: [
                {
                  payload: {
                    tradingEnabled: true,
                    tradingActions: ["buy"],
                    tradingVenues: ["polymarket"],
                    buyAmountPresetsUsd: [10],
                    maxTradeAmountUsd: 50,
                    maxSlippageBps: 500,
                    intentTtlSec: 120,
                  },
                },
              ],
            };
          }
          if (sql.includes("FROM telegram_trade_intents i")) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: "00000000-0000-4000-8000-000000000001",
                  telegram_user_id: "999",
                  user_id: null,
                  authorization_id: null,
                  chat_id: "999",
                  telegram_message_id: null,
                  action: "buy",
                  venue: "polymarket",
                  market_id: "market-1",
                  event_id: "event-1",
                  side: "YES",
                  amount_usd: "10",
                  status: "draft",
                  quote_snapshot: {},
                  policy_snapshot: {},
                  expires_at: new Date(Date.now() + 60_000),
                  market_title: "Market",
                  market_status: "ACTIVE",
                },
              ],
            };
          }
          if (sql.includes("FROM telegram_bot_trading_authorizations a")) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: "authorization-1",
                  user_id: "user-1",
                  telegram_user_id: "999",
                  privy_user_id: "privy-1",
                  wallet_address: "0x0000000000000000000000000000000000000001",
                  wallet_chain: "ethereum",
                  privy_wallet_id: "wallet-1",
                  enabled: true,
                  enabled_venues: ["polymarket"],
                  max_amount_usd: "50",
                },
              ],
            };
          }
          if (sql.includes("FROM unified_markets m")) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: "market-1",
                  venue: "polymarket",
                  venue_market_id: "venue-market-1",
                  event_id: "event-1",
                  event_title: "Event",
                  title: "Market",
                  status: "ACTIVE",
                  outcomes: JSON.stringify(["YES", "NO"]),
                  metadata: {},
                  close_time: new Date(Date.now() + 60_000),
                  expiration_time: null,
                  event_end_time: null,
                  best_bid: "0.4",
                  best_ask: "0.6",
                  last_price: "0.5",
                },
              ],
            };
          }
          if (sql.includes("UPDATE telegram_trade_intents")) {
            updateStatuses.push(String(params?.[1]));
            return { rowCount: 1, rows: [{ id: params?.[0] }] };
          }
          return { rowCount: 0, rows: [] };
        },
      };
      const handled = await handleTelegramBotTradingCallback({
        answerCallbackQuery: (input) => telegram.answerCallbackQuery(input),
        appBaseUrl: "https://app.hunch.trade",
        callbackQuery: {
          data: "hbt:buy:00000000-0000-4000-8000-000000000001",
          from: { id: 999 },
          id: "callback-1",
        },
        db: db as never,
        sendMessage: (message) => telegram.sendMessage(message as never),
        trading: {
          getReadiness: async () => ({
            ready: false,
            executable: false,
            reasonCode: "unsupported_capability",
            message: "Direct bot trading is disabled for this venue.",
            setupRequired: false,
            capabilities: {
              venue: "polymarket",
              supportsBuy: false,
              supportsSell: false,
              supportsCancel: false,
              supportsOrderSync: false,
              supportsPositionSync: false,
              supportsExecutionSync: false,
              supportsSetup: false,
              authorizationModes: ["unsupported"],
            },
          }),
          quote: async () => {
            quoteCalls += 1;
            throw new Error("quote must not be called");
          },
        } as never,
      });
      assert.equal(handled, true);
      assert.equal(quoteCalls, 0);
      assert.deepEqual(updateStatuses, ["failed"]);
      assert.match(telegram.callbackAnswers[0]?.text ?? "", /not ready/);
      assert.match(telegram.messages[0]?.text ?? "", /disabled/);
    },
  },
  {
    name: "trading confirm records post-submit persistence failure without marking trade failed",
    run: async () => {
      const telegram = new FakeTelegram();
      const updateStatuses: Array<{
        errorCode: unknown;
        errorMessage: unknown;
        status: unknown;
        venueOrderId: unknown;
      }> = [];
      let quotedSlippageBps: unknown = null;
      const db = {
        query: async (sql: string, params?: unknown[]) => {
          if (/from runtime_policies/i.test(sql)) {
            return {
              rowCount: 1,
              rows: [
                {
                  payload: {
                    tradingEnabled: true,
                    tradingActions: ["buy"],
                    tradingVenues: ["polymarket"],
                    buyAmountPresetsUsd: [10],
                    maxTradeAmountUsd: 50,
                    maxSlippageBps: 500,
                    intentTtlSec: 120,
                  },
                },
              ],
            };
          }
          if (sql.includes("FROM telegram_trade_intents i")) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: "00000000-0000-4000-8000-000000000001",
                  telegram_user_id: "999",
                  user_id: "user-1",
                  authorization_id: "authorization-1",
                  chat_id: "999",
                  telegram_message_id: null,
                  action: "buy",
                  venue: "polymarket",
                  market_id: "market-1",
                  event_id: "event-1",
                  side: "YES",
                  amount_usd: "10",
                  status: "confirming",
                  quote_snapshot: {},
                  policy_snapshot: {},
                  expires_at: new Date(Date.now() + 60_000),
                  market_title: "Market",
                  market_status: "ACTIVE",
                },
              ],
            };
          }
          if (sql.includes("FROM telegram_bot_trading_authorizations a")) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: "authorization-1",
                  user_id: "user-1",
                  telegram_user_id: "999",
                  privy_user_id: "privy-1",
                  wallet_address: "0x0000000000000000000000000000000000000001",
                  wallet_chain: "ethereum",
                  privy_wallet_id: "wallet-1",
                  enabled: true,
                  enabled_venues: ["polymarket"],
                  max_amount_usd: "50",
                },
              ],
            };
          }
          if (sql.includes("FROM unified_markets m")) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: "market-1",
                  venue: "polymarket",
                  venue_market_id: "venue-market-1",
                  event_id: "event-1",
                  event_title: "Event",
                  title: "Market",
                  status: "ACTIVE",
                  outcomes: JSON.stringify(["YES", "NO"]),
                  metadata: {},
                  close_time: new Date(Date.now() + 60_000),
                  expiration_time: null,
                  event_end_time: null,
                  best_bid: "0.4",
                  best_ask: "0.6",
                  last_price: "0.5",
                },
              ],
            };
          }
          if (
            sql.includes("UPDATE telegram_trade_intents") &&
            sql.includes("SET status = $2")
          ) {
            updateStatuses.push({
              status: params?.[1],
              errorCode: params?.[2],
              errorMessage: params?.[3],
              venueOrderId: params?.[7],
            });
            return { rowCount: 1, rows: [{ id: params?.[0] }] };
          }
          if (sql.includes("UPDATE telegram_trade_intents")) {
            return { rowCount: 1, rows: [{ id: params?.[0] }] };
          }
          return { rowCount: 0, rows: [] };
        },
      };
      const handled = await handleTelegramBotTradingCallback({
        answerCallbackQuery: (input) => telegram.answerCallbackQuery(input),
        appBaseUrl: "https://app.hunch.trade",
        callbackQuery: {
          data: "hbt:confirm:00000000-0000-4000-8000-000000000001",
          from: { id: 999 },
          id: "callback-1",
        },
        db: db as never,
        sendMessage: (message) => telegram.sendMessage(message as never),
        trading: {
          executePreparedTrade: async (input: never) => {
            const submitResult = {
              venue: "polymarket",
              status: "submitted" as const,
              venueOrderId: "venue-order-1",
              orderHash: "hash",
              txSignature: null,
              price: 0.5,
              size: 20,
            };
            await (
              input as {
                onSubmitted?: (submitResult: unknown) => unknown;
              }
            ).onSubmitted?.(submitResult);
            return {
              submitResult,
              persisted: null,
              effects: null,
              postSubmitError: {
                code: "persistence_failed",
                message: "store down",
                statusCode: 500,
              },
            };
          },
          getReadiness: async () => ({
            ready: true,
            executable: true,
            reasonCode: null,
            message: null,
            setupRequired: false,
            capabilities: {
              venue: "polymarket",
              supportsBuy: true,
              supportsSell: false,
              supportsCancel: false,
              supportsOrderSync: false,
              supportsPositionSync: false,
              supportsExecutionSync: false,
              supportsSetup: false,
              authorizationModes: ["server_delegated"],
            },
          }),
          normalizeError: (_venue: string, error: unknown) => ({
            code: "persistence_failed",
            message:
              error instanceof Error ? error.message : "persistence failed",
            statusCode: 500,
            venue: "polymarket",
            raw: error,
          }),
          prepareTrade: async (input: never) => ({
            preparedId: "prepared",
            venue: "polymarket",
            intent: (input as { intent: unknown }).intent,
            quote: null,
            authorizationMode: "server_delegated",
            authorizationRequests: [],
            venuePayload: {},
            expiresAt: null,
          }),
          quote: async (input: never) => {
            quotedSlippageBps = (
              input as { intent: { slippageBps?: unknown } }
            ).intent.slippageBps;
            return {
              venue: "polymarket",
              target: (input as { intent: { target: unknown } }).intent.target,
              action: "BUY",
              amount: { type: "usd", value: "10" },
              price: 0.5,
              estimatedShares: 20,
              estimatedNotionalUsd: 10,
              maxSpendUsd: 10,
              minReceiveShares: 20,
              fees: {},
              expiresAt: null,
            };
          },
        } as never,
      });
      assert.equal(handled, true);
      assert.deepEqual(
        updateStatuses.map((entry) => entry.status),
        ["executing", "executing", "executing", "submitted"],
      );
      assert.equal(updateStatuses[2]?.venueOrderId, "venue-order-1");
      assert.equal(updateStatuses[3]?.errorCode, "persistence_failed");
      assert.equal(updateStatuses[3]?.venueOrderId, "venue-order-1");
      assert.equal(quotedSlippageBps, 500);
      assert.match(
        telegram.callbackAnswers[0]?.text ?? "",
        /Recording needs review/,
      );
      assert.match(
        telegram.messages[0]?.text ?? "",
        /Venue accepted the submit/,
      );
    },
  },
  {
    name: "trading confirm reports no-fill distinctly",
    run: async () => {
      const telegram = new FakeTelegram();
      const updateStatuses: Array<{ errorCode: unknown; status: unknown }> = [];
      const db = {
        query: async (sql: string, params?: unknown[]) => {
          if (/from runtime_policies/i.test(sql)) {
            return {
              rowCount: 1,
              rows: [
                {
                  payload: {
                    tradingEnabled: true,
                    tradingActions: ["buy"],
                    tradingVenues: ["polymarket"],
                    buyAmountPresetsUsd: [10],
                    maxTradeAmountUsd: 50,
                    maxSlippageBps: 500,
                    intentTtlSec: 120,
                  },
                },
              ],
            };
          }
          if (sql.includes("FROM telegram_trade_intents i")) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: "00000000-0000-4000-8000-000000000001",
                  telegram_user_id: "999",
                  user_id: "user-1",
                  authorization_id: "authorization-1",
                  chat_id: "999",
                  telegram_message_id: null,
                  action: "buy",
                  venue: "polymarket",
                  market_id: "market-1",
                  event_id: "event-1",
                  side: "YES",
                  amount_usd: "10",
                  status: "confirming",
                  quote_snapshot: {},
                  policy_snapshot: {},
                  expires_at: new Date(Date.now() + 60_000),
                  market_title: "Market",
                  market_status: "ACTIVE",
                },
              ],
            };
          }
          if (sql.includes("FROM telegram_bot_trading_authorizations a")) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: "authorization-1",
                  user_id: "user-1",
                  telegram_user_id: "999",
                  privy_user_id: "privy-1",
                  wallet_address: "0x0000000000000000000000000000000000000001",
                  wallet_chain: "ethereum",
                  privy_wallet_id: "wallet-1",
                  enabled: true,
                  enabled_venues: ["polymarket"],
                  max_amount_usd: "50",
                },
              ],
            };
          }
          if (sql.includes("FROM unified_markets m")) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: "market-1",
                  venue: "polymarket",
                  venue_market_id: "venue-market-1",
                  event_id: "event-1",
                  event_title: "Event",
                  title: "Market",
                  status: "ACTIVE",
                  outcomes: JSON.stringify(["YES", "NO"]),
                  metadata: {},
                  close_time: new Date(Date.now() + 60_000),
                  expiration_time: null,
                  event_end_time: null,
                  best_bid: "0.4",
                  best_ask: "0.6",
                  last_price: "0.5",
                },
              ],
            };
          }
          if (
            sql.includes("UPDATE telegram_trade_intents") &&
            sql.includes("SET status = $2")
          ) {
            updateStatuses.push({
              status: params?.[1],
              errorCode: params?.[2],
            });
            return { rowCount: 1, rows: [{ id: params?.[0] }] };
          }
          if (sql.includes("UPDATE telegram_trade_intents")) {
            return { rowCount: 1, rows: [{ id: params?.[0] }] };
          }
          return { rowCount: 0, rows: [] };
        },
      };
      const handled = await handleTelegramBotTradingCallback({
        answerCallbackQuery: (input) => telegram.answerCallbackQuery(input),
        appBaseUrl: "https://app.hunch.trade",
        callbackQuery: {
          data: "hbt:confirm:00000000-0000-4000-8000-000000000001",
          from: { id: 999 },
          id: "callback-1",
        },
        db: db as never,
        sendMessage: (message) => telegram.sendMessage(message as never),
        trading: {
          executePreparedTrade: async (input: never) => {
            const submitResult = {
              venue: "polymarket",
              status: "no_fill" as const,
              venueOrderId: null,
              orderHash: null,
              txSignature: null,
              price: 0.5,
              size: 0,
            };
            await (
              input as {
                onSubmitted?: (submitResult: unknown) => unknown;
              }
            ).onSubmitted?.(submitResult);
            return {
              submitResult,
              persisted: null,
              effects: null,
              postSubmitError: null,
            };
          },
          getReadiness: async () => ({
            ready: true,
            executable: true,
            reasonCode: null,
            message: null,
            setupRequired: false,
            capabilities: {
              venue: "polymarket",
              supportsBuy: true,
              supportsSell: false,
              supportsCancel: false,
              supportsOrderSync: false,
              supportsPositionSync: false,
              supportsExecutionSync: false,
              supportsSetup: false,
              authorizationModes: ["server_delegated"],
            },
          }),
          normalizeError: (_venue: string, error: unknown) => ({
            code: "fake_error",
            message: error instanceof Error ? error.message : "fake error",
            statusCode: 500,
            venue: "polymarket",
            raw: error,
          }),
          prepareTrade: async (input: never) => ({
            preparedId: "prepared",
            venue: "polymarket",
            intent: (input as { intent: unknown }).intent,
            quote: null,
            authorizationMode: "server_delegated",
            authorizationRequests: [],
            venuePayload: {},
            expiresAt: null,
          }),
          quote: async (input: never) => ({
            venue: "polymarket",
            target: (input as { intent: { target: unknown } }).intent.target,
            action: "BUY",
            amount: { type: "usd", value: "10" },
            price: 0.5,
            estimatedShares: 20,
            estimatedNotionalUsd: 10,
            maxSpendUsd: 10,
            minReceiveShares: 20,
            fees: {},
            expiresAt: null,
          }),
        } as never,
      });
      assert.equal(handled, true);
      assert.deepEqual(
        updateStatuses.map((entry) => entry.status),
        ["executing", "executing", "executing", "failed"],
      );
      assert.equal(updateStatuses[3]?.errorCode, "no_fill");
      assert.equal(telegram.callbackAnswers[0]?.text, "No fill.");
      assert.match(telegram.messages[0]?.text ?? "", /No fill/);
    },
  },
  {
    name: "signal bot trading policy preserves explicitly empty venues",
    run: () => {
      const policy = normalizeSignalBotPolicy({
        tradingEnabled: true,
        tradingActions: ["buy"],
        tradingVenues: [],
        buyAmountPresetsUsd: [10],
        maxTradeAmountUsd: 50,
        maxSlippageBps: 500,
        intentTtlSec: 120,
        requireConfirmation: true,
      });
      assert.deepEqual(policy.tradingVenues, []);
      assert.equal(policy.tradingEnabled, true);
    },
  },
  {
    name: "signal bot trading policy preserves explicitly disabled buy actions",
    run: () => {
      const emptyActions = normalizeSignalBotPolicy({
        tradingEnabled: true,
        tradingActions: [],
        tradingVenues: ["polymarket"],
        buyAmountPresetsUsd: [10],
        maxTradeAmountUsd: 50,
        maxSlippageBps: 500,
        intentTtlSec: 120,
        requireConfirmation: true,
      });
      assert.deepEqual(emptyActions.tradingActions, []);

      const sellOnlyActions = normalizeSignalBotPolicy({
        tradingEnabled: true,
        tradingActions: ["sell"],
        tradingVenues: ["polymarket"],
        buyAmountPresetsUsd: [10],
        maxTradeAmountUsd: 50,
        maxSlippageBps: 500,
        intentTtlSec: 120,
        requireConfirmation: true,
      });
      assert.deepEqual(sellOnlyActions.tradingActions, ["sell"]);

      const buyActions = normalizeSignalBotPolicy({
        tradingEnabled: true,
        tradingActions: ["buy"],
        tradingVenues: ["polymarket"],
        buyAmountPresetsUsd: [10],
        maxTradeAmountUsd: 50,
        maxSlippageBps: 500,
        intentTtlSec: 120,
        requireConfirmation: true,
      });
      assert.deepEqual(buyActions.tradingActions, ["buy"]);
    },
  },
  {
    name: "telegram bot trading modules stay sidecar-safe",
    run: () => {
      const graph = collectRuntimeImportGraph(
        resolve(apiSrcDir, "signal-bot-runner.ts"),
      );
      const relativeFiles = Array.from(graph, (file) =>
        relative(apiSrcDir, file).replaceAll("\\", "/"),
      );
      assert.equal(relativeFiles.includes("env.ts"), false);
      assert.equal(relativeFiles.includes("privy-service.ts"), false);
      assert.equal(
        relativeFiles.includes("services/telegram-bot-trading.ts"),
        false,
      );
      assert.equal(relativeFiles.includes("repos/runtime-policies.ts"), false);
      assert.equal(
        relativeFiles.some((file) =>
          file.endsWith("-trading-execution-service.ts"),
        ),
        false,
      );
      const retentionSelector = readFileSync(
        new URL("./market-retention-selector.ts", import.meta.url),
        "utf8",
      );
      assert.match(retentionSelector, /telegram_trade_intents/);
      assert.match(
        retentionSelector,
        /telegram_trade_intents_ephemeral_cleanup/,
      );
    },
  },
  {
    name: "public start help is Mini App aware and hides admin controls",
    run: async () => {
      const redis = new FakeRedis();
      const telegram = new FakeTelegram();
      const handled = await handleSignalBotCommand({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE:
            "https://t.me/hunch_bot/hunch",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        message: {
          chat: { id: -1, title: "Group", type: "group" },
          from: { id: 999 },
          text: "/start",
        },
        redis,
        sendMessage: (message) => telegram.sendMessage(message),
        sendTestSignal: async () => false,
      });
      assert.equal(handled, true);
      const text = telegram.messages[0]?.text ?? "";
      assert.match(text, /Public help/);
      assert.match(text, /Hunch Mini App/);
      assert.doesNotMatch(text, /enable\\_signals/);
      assert.doesNotMatch(text, /test\\_signal/);
    },
  },
  {
    name: "admin help includes public help and admin controls",
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
          text: "/help",
        },
        redis,
        sendMessage: (message) => telegram.sendMessage(message),
        sendTestSignal: async () => false,
      });
      assert.equal(handled, true);
      const text = telegram.messages[0]?.text ?? "";
      assert.match(text, /Public help/);
      assert.match(text, /Admin controls/);
      assert.match(text, /enable\\_signals/);
      assert.match(text, /test\\_followthrough/);
      assert.match(text, /test\\_signal/);
      assert.match(text, /Buttons open Hunch web links/);
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
    name: "unauthorized user cannot request followthrough preview",
    run: async () => {
      const redis = new FakeRedis();
      const telegram = new FakeTelegram();
      let previewCalled = false;
      const handled = await handleSignalBotCommand({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        message: {
          chat: { id: -1, title: "Group", type: "group" },
          from: { id: 999 },
          text: "/test_followthrough stats",
        },
        redis,
        sendMessage: (message) => telegram.sendMessage(message),
        sendTestFollowthrough: async () => {
          previewCalled = true;
          return true;
        },
        sendTestSignal: async () => false,
      });
      assert.equal(handled, true);
      assert.equal(previewCalled, false);
      assert.match(telegram.messages[0]?.text ?? "", /Not authorized/);
    },
  },
  {
    name: "authorized followthrough preview command passes kind and target",
    run: async () => {
      const redis = new FakeRedis();
      const telegram = new FakeTelegram();
      const requests: Array<{ chatId: string; kind: string }> = [];
      const handled = await handleSignalBotCommand({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        message: {
          chat: { id: -1, title: "Group", type: "group" },
          from: { id: 123 },
          text: "/test_followthrough win -1001234567890",
        },
        redis,
        sendMessage: (message) => telegram.sendMessage(message),
        sendTestFollowthrough: async (chatId, kind) => {
          requests.push({ chatId, kind });
          return true;
        },
        sendTestSignal: async () => false,
      });
      assert.equal(handled, true);
      assert.deepEqual(requests, [
        { chatId: "-1001234567890", kind: "resolved_win" },
      ]);
      assert.match(telegram.messages[0]?.text ?? "", /Sent follow\\-through/);
    },
  },
  {
    name: "authorized followthrough preview command explains empty preview",
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
          text: "/test_followthrough stats -1001234567890",
        },
        redis,
        sendMessage: (message) => telegram.sendMessage(message),
        sendTestFollowthrough: async () => false,
        sendTestSignal: async () => false,
      });
      assert.equal(handled, true);
      assert.match(
        telegram.messages[0]?.text ?? "",
        /No follow\\-through preview found for stats in \\-1001234567890/,
      );
      assert.match(
        telegram.messages[0]?.text ?? "",
        /Check age\/policy\/type\/thresholds/,
      );
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
      assert.equal(
        parsed.searchParams.get("signalEventId"),
        "polymarket:event-1",
      );
      assert.equal(
        parsed.searchParams.get("signalMarketId"),
        "polymarket:market-1",
      );
      assert.equal(parsed.searchParams.get("signalSide"), "YES");
      assert.equal(
        parsed.searchParams.get("signalSource"),
        "telegram_signal_bot",
      );
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
      assert.equal(rows[1]?.[0]?.text, "👤 Wallet · YES $12.3K (-$123 PnL)");
      const holderButtonUrl = new URL(rows[1]?.[0]?.url ?? "");
      assert.equal(
        holderButtonUrl.pathname,
        "/tracking/wallet/0xa022ba0a68e11a78348382ff168601012d4d77f8",
      );
      assert.equal(holderButtonUrl.searchParams.get("chain"), "polygon");
      assert.equal(
        holderButtonUrl.searchParams.get("signalMarketId"),
        "polymarket:market-1",
      );
      assert.equal(holderButtonUrl.searchParams.get("signalSide"), "YES");
      assert.equal(
        holderButtonUrl.searchParams.get("signalSource"),
        "telegram_signal_bot",
      );
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
    name: "message keeps web links when Mini App base is unset",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note(),
      });
      const rows = message.keyboard?.inline_keyboard ?? [];
      assert.match(rows[0]?.[0]?.url ?? "", /^https:\/\/app\.hunch\.trade\//);
      assert.match(rows[1]?.[0]?.url ?? "", /^https:\/\/app\.hunch\.trade\//);
      assert.match(rows[1]?.[1]?.url ?? "", /^https:\/\/app\.hunch\.trade\//);
    },
  },
  {
    name: "message prefers Mini App button links and keeps web title fallback",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({
          eventId: "polymarket:event-1",
          marketId: "polymarket:market-1",
        }),
        telegramMiniAppLinkBase: "https://t.me/hunch_signal_bot/hunch",
      });
      const rows = message.keyboard?.inline_keyboard ?? [];
      assert.match(
        rows[0]?.[0]?.url ?? "",
        /^https:\/\/t\.me\/hunch_signal_bot\/hunch\?startapp=b_/,
      );
      assert.match(
        rows[1]?.[0]?.url ?? "",
        /^https:\/\/t\.me\/hunch_signal_bot\/hunch\?startapp=wt_/,
      );
      assert.match(
        rows[1]?.[1]?.url ?? "",
        /^https:\/\/t\.me\/hunch_signal_bot\/hunch\?startapp=m_/,
      );
      assert.match(
        message.text,
        /\(https:\/\/app\.hunch\.trade\/events\/polymarket%3Aevent-1\?/,
      );
      assert.equal(
        decodeStartAppPayload(readStartAppParam(rows[0]?.[0]?.url)),
        "p:event-1|market-1|Y|10",
      );
      assert.equal(
        decodeStartAppPayload(readStartAppParam(rows[1]?.[0]?.url)),
        "polygon|0xa022ba0a68e11a78348382ff168601012d4d77f8|" +
          "polymarket:event-1|polymarket:market-1|Y|" +
          "00000000-0000-4000-8000-000000000001",
      );
      assert.equal(
        decodeStartAppPayload(readStartAppParam(rows[1]?.[1]?.url)),
        "p:event-1|market-1|Y",
      );
    },
  },
  {
    name: "message falls back to web button when Mini App payload is oversized",
    run: () => {
      const longId = `polymarket:${"x".repeat(500)}`;
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({
          eventId: longId,
          marketId: longId,
        }),
        telegramMiniAppLinkBase: "https://t.me/hunch_signal_bot",
      });
      const rows = message.keyboard?.inline_keyboard ?? [];
      assert.match(rows[0]?.[0]?.url ?? "", /^https:\/\/app\.hunch\.trade\//);
      assert.match(rows[1]?.[1]?.url ?? "", /^https:\/\/app\.hunch\.trade\//);
    },
  },
  {
    name: "message swaps label icon for high-conviction notes",
    run: () => {
      const single = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({
          modelMeta: { execution_priority: "high_conviction" },
        }),
      });
      assert.match(single.text, /🔥 Strong holder · YES 31¢ \/ NO 69¢/);
      assert.doesNotMatch(single.text, /High conviction|Top signal/i);

      const cluster = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({
          holderActorMode: "sharp_cluster",
          modelMeta: { execution_priority: "high_conviction" },
        }),
      });
      assert.match(cluster.text, /🔥 Strong wallets · YES 31¢ \/ NO 69¢/);
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
      assert.equal(rows[2]?.[0]?.text, "👤 Wallet · YES $12.3K (-$123 PnL)");
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
      assert.equal(rows[1]?.[0]?.text, "👤 Wallet · YES $12.3K (-$123 PnL)");
    },
  },
  {
    name: "message uses short market title for generic outcome buttons",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({
          eventTitle: "World Cup Winner",
          marketTitle: "France",
        }),
      });
      const rows = message.keyboard?.inline_keyboard ?? [];
      assert.equal(rows[0]?.[0]?.text, "🟠 Buy France · Poly 32¢");
      assert.equal(rows[1]?.[0]?.text, "👤 Wallet · France $12.3K (-$123 PnL)");
      assert.match(message.text, /⚡ Strong holder · YES 31¢ \/ NO 69¢/);
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
    name: "message linkifies a safe holder display name once in body text",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({
          description:
            "TB14 is still holding France after the move. TB14 has not backed off.",
          holderIdentityDisplayName: "@TB14",
          title: "TB14 is still riding France higher",
        }),
      });
      const firstLine = message.text.split("\n")[0] ?? "";
      const holderLinks =
        message.text.match(
          /\[TB14\]\(https:\/\/app\.hunch\.trade\/tracking\/wallet\//g,
        ) ?? [];
      assert.equal(holderLinks.length, 1);
      assert.doesNotMatch(firstLine, /tracking\/wallet/);
    },
  },
  {
    name: "message linkifies standalone numeric holder names",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({
          description:
            "$24124 was a value, 24124.50 was not a holder, 24124% was a percent, then 24124.",
          holderDisplayName: "24124",
        }),
      });
      assert.doesNotMatch(message.text, /\$\[24124\]/);
      assert.doesNotMatch(message.text, /\[24124\]\.50/);
      assert.doesNotMatch(message.text, /\[24124\]%/);
      assert.match(
        message.text,
        /then \[24124\]\(https:\/\/app\.hunch\.trade\/tracking\/wallet\//,
      );
      assert.equal((message.text.match(/\[24124\]\(/g) ?? []).length, 1);
    },
  },
  {
    name: "message skips ambiguous holder display names",
    run: () => {
      for (const displayName of ["that", "1", "YES", "France"]) {
        const message = buildSignalBotMessage({
          appBaseUrl: "https://app.hunch.trade",
          buyAmountUsd: 10,
          note: note({
            description: `${displayName} added size after the latest move.`,
            holderDisplayName: displayName,
            marketTitle:
              displayName === "France" ? "France" : "Will test resolve Yes?",
          }),
        });
        assert.doesNotMatch(
          message.text,
          new RegExp(`\\[${displayName}\\]\\(`),
        );
      }
    },
  },
  {
    name: "message escapes markdown in linked holder display names",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({
          description: "A_Bot added again after the dip.",
          holderDisplayName: "A_Bot",
        }),
      });
      assert.match(
        message.text,
        /\[A\\_Bot\]\(https:\/\/app\.hunch\.trade\/tracking\/wallet\//,
      );
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
      assert.match(
        message.text,
        /⚡ Strong holder · Alpha Team 31¢ \/ Beta Team 69¢/,
      );
      assert.equal(rows[0]?.[0]?.text, "⚪ Buy Beta Team · Poly 70¢");
      assert.equal(rows[1]?.[0]?.text, "💸 Cheaper: Kalshi Beta Team 48¢");
      assert.equal(
        rows[2]?.[0]?.text,
        "👤 Wallet · Beta Team $12.3K (-$123 PnL)",
      );
    },
  },
  {
    name: "message abbreviates long named outcome labels",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({
          direction: "down",
          holderSide: "NO",
          outcomes: ["Very Long Alpha Team", "Very Long Beta Team"],
        }),
      });
      const rows = message.keyboard?.inline_keyboard ?? [];
      assert.match(message.text, /⚡ Strong holder · VLA 31¢ \/ VLB 69¢/);
      assert.equal(rows[0]?.[0]?.text, "⚪ Buy VLB · Poly 70¢");
      assert.equal(rows[1]?.[0]?.text, "👤 Wallet · VLB $12.3K (-$123 PnL)");
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
      assert.equal(
        rows[1]?.[0]?.text,
        "👥 Top wallet · YES $12.3K (-$123 PnL)",
      );
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
    name: "message uses private chat web app buttons when Mini App base is set",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        chatType: "private",
        cheaperAlternative: {
          eventId: "kalshi:event-1",
          marketId: "kalshi:market-1",
          price: 0.29,
          side: "YES",
          venue: "kalshi",
        },
        note: note({
          eventId: "polymarket:event-1",
          marketId: "polymarket:market-1",
        }),
        telegramMiniAppLinkBase: "https://t.me/hunch_signal_bot/hunch",
      });
      const rows = message.keyboard?.inline_keyboard ?? [];
      assert.equal(rows[0]?.[0]?.url, undefined);
      assert.equal(rows[1]?.[0]?.url, undefined);
      assert.equal(rows[2]?.[0]?.url, undefined);
      assert.equal(rows[2]?.[1]?.url, undefined);
      assert.equal(
        decodeStartAppPayload(readWebAppStartParam(rows[0]?.[0])),
        "p:event-1|market-1|Y|10",
      );
      assert.equal(
        decodeStartAppPayload(readWebAppStartParam(rows[1]?.[0])),
        "k:event-1|market-1|Y|10",
      );
      assert.equal(
        decodeStartAppPayload(readWebAppStartParam(rows[2]?.[0])),
        "polygon|0xa022ba0a68e11a78348382ff168601012d4d77f8|" +
          "polymarket:event-1|polymarket:market-1|Y|" +
          "00000000-0000-4000-8000-000000000001",
      );
      assert.equal(
        decodeStartAppPayload(readWebAppStartParam(rows[2]?.[1])),
        "p:event-1|market-1|Y",
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
            byExecutionPriority: {
              high_conviction: {
                averageRoi: 0.18,
                correct: 1,
                flat: 0,
                hitRate: 1,
                medianRoi: 0.18,
                missingEntry: 0,
                negative: 0,
                notes: 2,
                open: 1,
                positive: 2,
                resolved: 1,
                totalPnlPerDollar: 0.36,
                unknown: 0,
                withEntry: 2,
                wrong: 0,
              },
            },
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
      assert.match(report, /🔥 High conviction: \+18\.0% avg vs all \+6\.2%/);
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
            byExecutionPriority: { high_conviction: aggregate },
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
      assert.match(report, /By conviction/);
      assert.match(report, /🔥 High conviction/);
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
            byExecutionPriority: {},
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
      db.rows = [
        noteRow({
          holder_target_meta: {
            actorMode: "single_holder",
            holderDescriptor: "TB14",
            identityDisplayName: "@TB14",
            openPnlUsd: -123,
            positionUsd: 12_345,
            side: "YES",
          },
        }),
      ];
      const notes = await loadSignalBotNotes(db, {
        afterCreatedAt: "1970-01-01T00:00:00.000Z",
        afterId: "00000000-0000-0000-0000-000000000000",
        limit: 1,
        minConfidence: 0.7,
      });
      assert.equal(notes[0]?.holderDisplayName, "TB14");
      assert.equal(notes[0]?.holderIdentityDisplayName, "@TB14");
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
      const delivery = db.queries
        .filter((query) =>
          query.sql.includes("insert into signal_bot_messages"),
        )
        .at(-1);
      assert.ok(delivery);
      assert.equal(delivery.params[0], "-100");
      assert.equal(delivery.params[1], "00000000-0000-4000-8000-000000000001");
      assert.equal(delivery.params[2], "00000000-0000-4000-8000-000000000001");
      assert.equal(delivery.params[3], "initial");
      assert.equal(delivery.params[4], 101);
      assert.equal(delivery.params[5], null);
      const state = await getSignalBotChatState(redis, "-100");
      assert.equal(state?.cursorCreatedAt, "2026-01-01T00:00:00.000Z");
      assert.equal(state?.cursorId, "00000000-0000-4000-8000-000000000001");
    },
  },
  {
    name: "publish research update replies to prior market thread",
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
          id: "00000000-0000-4000-8000-000000000002",
          title: "Fresh update",
        }),
      ];
      db.threadContextRows = [
        {
          baseline_at: "2026-01-01T00:00:00.000Z",
          reply_to_message_id: "77",
          thread_root_note_id: "00000000-0000-4000-8000-000000000001",
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
      assert.equal(result.sent, 1);
      assert.equal(telegram.messages[0]?.reply_parameters?.message_id, 77);
      const delivery = db.queries
        .filter((query) =>
          query.sql.includes("insert into signal_bot_messages"),
        )
        .at(-1);
      assert.ok(delivery);
      assert.equal(delivery.params[1], "00000000-0000-4000-8000-000000000002");
      assert.equal(delivery.params[2], "00000000-0000-4000-8000-000000000001");
      assert.equal(delivery.params[3], "research_update");
      assert.equal(delivery.params[4], 101);
      assert.equal(delivery.params[5], 77);
    },
  },
  {
    name: "publish reply failure falls back to standalone delivery",
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
          id: "00000000-0000-4000-8000-000000000002",
          title: "Fresh update",
        }),
      ];
      db.threadContextRows = [
        {
          baseline_at: "2026-01-01T00:00:00.000Z",
          reply_to_message_id: "77",
          thread_root_note_id: "00000000-0000-4000-8000-000000000001",
        },
      ];
      const telegram = new FakeTelegram();
      telegram.nextResults = [
        { error: "other", message: "reply target missing", ok: false },
        { messageId: 333, ok: true },
      ];
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
      assert.equal(telegram.messages.length, 2);
      assert.equal(telegram.messages[0]?.reply_parameters?.message_id, 77);
      assert.equal(telegram.messages[1]?.reply_parameters, undefined);
      const delivery = db.queries
        .filter((query) =>
          query.sql.includes("insert into signal_bot_messages"),
        )
        .at(-1);
      assert.ok(delivery);
      assert.equal(delivery.params[4], 333);
      assert.equal(delivery.params[5], null);
      assert.deepEqual(JSON.parse(String(delivery.params[8])), {
        fallbackStandalone: true,
        noteKind: "research_update",
      });
    },
  },
  {
    name: "multiple chats store independent telegram message ids",
    run: async () => {
      const redis = new FakeRedis();
      await enableSignalBotChat({
        chat: { id: "-100", title: "Signals A", type: "group" },
        enabledBy: 123,
        now: new Date("2025-12-31T00:00:00.000Z"),
        redis,
      });
      await enableSignalBotChat({
        chat: { id: "-200", title: "Signals B", type: "channel" },
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
      assert.equal(result.sent, 2);
      const deliveries = db.queries.filter((query) =>
        query.sql.includes("insert into signal_bot_messages"),
      );
      assert.equal(deliveries.length, 2);
      assert.deepEqual(
        deliveries.map((delivery) => [delivery.params[0], delivery.params[4]]),
        [
          ["-100", 101],
          ["-200", 102],
        ],
      );
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
    name: "publish backs off after transient Telegram send failure",
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
        error: "other",
        message: "Too Many Requests",
        ok: false,
        retryAfterSec: 7,
      };
      const first = await publishSignalBotTick({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        redis,
        telegram,
      });
      assert.equal(first.sent, 0);
      assert.equal(telegram.messages.length, 1);
      assert.equal(
        [...redis.strings.entries()].find(([key]) =>
          key.includes("send_cooldown"),
        )?.[1],
        "Too Many Requests",
      );

      telegram.nextResult = null;
      const second = await publishSignalBotTick({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        redis,
        telegram,
      });
      assert.equal(second.sent, 0);
      assert.equal(telegram.messages.length, 1);
    },
  },
  {
    name: "followthrough tick sends stats reply when policy threshold passes",
    run: async () => {
      const redis = new FakeRedis();
      await enableFollowthroughTestChat(redis);
      const db = new FakeFollowthroughDb();
      db.runtimePayload = {
        signalBotFollowthroughEnabled: true,
        signalBotFollowthroughTypes: ["stats"],
        signalBotFollowthroughMinJoinedOrAdded: 2,
        signalBotFollowthroughMinNetFlowUsd: 100_000,
        signalBotFollowthroughMinPriceMoveCents: 100,
      };
      db.candidateRows = [followthroughCandidateRow()];
      db.flowRows = [
        followthroughFlowRow({ baseline_shares: "0", wallet_id: "wallet-1" }),
        followthroughFlowRow({
          wallet_id: "wallet-2",
          baseline_shares: "50",
          latest_shares: "90",
          latest_size_usd: "4950",
          positive_usd: "4500",
          net_usd: "4500",
          net_shares: "40",
        }),
      ];
      const telegram = new FakeTelegram();
      const result = await publishSignalBotFollowthroughTick({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE:
            "https://t.me/hunch_bot/hunch",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        now: new Date("2026-01-02T01:00:00.000Z"),
        redis,
        telegram,
      });

      assert.equal(result.policyEnabled, true);
      assert.equal(result.sent, 1);
      assert.equal(result.sentStats, 1);
      assert.equal(telegram.messages[0]?.reply_parameters?.message_id, 77);
      assert.match(telegram.messages[0]?.text ?? "", /Wallets followed/);
      assert.match(telegram.messages[0]?.text ?? "", /wallets followed/);
      assert.match(
        telegram.messages[0]?.text ?? "",
        /Tracked wallets are still leaning with the signal/,
      );
      const keyboard = telegram.messages[0]?.reply_markup?.inline_keyboard;
      assert.equal(keyboard?.length, 1);
      assert.equal(keyboard?.[0]?.[0]?.text, "↗️ Open market");
      assert.match(keyboard?.[0]?.[0]?.url ?? "", /^https:\/\/t\.me\//);
      assert.match(readStartAppParam(keyboard?.[0]?.[0]?.url), /^m_/);
      const candidateQuery = db.queries.find((query) =>
        query.sql.includes("from signal_bot_messages root"),
      );
      assert.equal(candidateQuery?.params[6], false);
      const delivery = db.queries
        .filter((query) =>
          query.sql.includes("insert into signal_bot_messages"),
        )
        .at(-1);
      assert.ok(delivery);
      assert.equal(delivery.params[0], "-100");
      assert.equal(delivery.params[1], "00000000-0000-4000-8000-000000000101");
      assert.equal(delivery.params[3], "followthrough_stats");
      assert.equal(delivery.params[5], 77);
      const metrics = JSON.parse(String(delivery.params[8]));
      assert.equal(metrics.joinedOrAddedWallets, 2);
      assert.equal(metrics.netSignalSideFlowUsd, 9500);
      assert.equal(metrics.fallbackStandalone, false);
      const flowQuery = db.queries.find((query) =>
        query.sql.includes("from wallet_activity_events"),
      );
      assert.equal(flowQuery?.params[3], "polymarket");
    },
  },
  {
    name: "followthrough private chat buttons use web app payloads",
    run: async () => {
      const redis = new FakeRedis();
      await enableSignalBotChat({
        chat: { id: "-100", first_name: "Kreedle", type: "private" },
        enabledBy: 123,
        now: new Date("2026-01-01T00:00:00.000Z"),
        redis,
      });
      const db = new FakeFollowthroughDb();
      db.runtimePayload = {
        signalBotFollowthroughEnabled: true,
        signalBotFollowthroughTypes: ["stats"],
        signalBotFollowthroughMinJoinedOrAdded: 1,
        signalBotFollowthroughMinNetFlowUsd: 100_000,
        signalBotFollowthroughMinPriceMoveCents: 100,
      };
      db.candidateRows = [followthroughCandidateRow()];
      db.flowRows = [
        followthroughFlowRow({ baseline_shares: "0", wallet_id: "wallet-1" }),
      ];
      const telegram = new FakeTelegram();
      const result = await publishSignalBotFollowthroughTick({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE:
            "https://t.me/hunch_bot/hunch",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        now: new Date("2026-01-02T01:00:00.000Z"),
        redis,
        telegram,
      });

      assert.equal(result.sent, 1);
      const keyboard = telegram.messages[0]?.reply_markup?.inline_keyboard;
      assert.equal(keyboard?.[0]?.[0]?.url, undefined);
      assert.equal(
        decodeStartAppPayload(readWebAppStartParam(keyboard?.[0]?.[0])),
        "p:event-1|market-1|Y",
      );
    },
  },
  {
    name: "followthrough stats use short market title as side label",
    run: async () => {
      const redis = new FakeRedis();
      await enableFollowthroughTestChat(redis);
      const db = new FakeFollowthroughDb();
      db.runtimePayload = {
        signalBotFollowthroughEnabled: true,
        signalBotFollowthroughTypes: ["stats"],
        signalBotFollowthroughMinJoinedOrAdded: 1,
        signalBotFollowthroughMinNetFlowUsd: 100_000,
        signalBotFollowthroughMinPriceMoveCents: 100,
      };
      db.candidateRows = [
        followthroughCandidateRow({
          event_title: "World Cup Winner",
          market_title: "Argentina",
        }),
      ];
      db.flowRows = [
        followthroughFlowRow({ baseline_shares: "0", wallet_id: "wallet-1" }),
      ];
      const telegram = new FakeTelegram();
      const result = await publishSignalBotFollowthroughTick({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        now: new Date("2026-01-02T01:00:00.000Z"),
        redis,
        telegram,
      });

      const text = telegram.messages[0]?.text ?? "";
      assert.equal(result.sent, 1);
      assert.match(text, /net tracked Argentina flow/);
      assert.match(text, /Argentina: 40¢ → 55¢/);
      assert.doesNotMatch(text, /net tracked YES flow/);
    },
  },
  {
    name: "followthrough stats abbreviate long outcome labels",
    run: async () => {
      const redis = new FakeRedis();
      await enableFollowthroughTestChat(redis);
      const db = new FakeFollowthroughDb();
      db.runtimePayload = {
        signalBotFollowthroughEnabled: true,
        signalBotFollowthroughTypes: ["stats"],
        signalBotFollowthroughMinJoinedOrAdded: 1,
        signalBotFollowthroughMinNetFlowUsd: 100_000,
        signalBotFollowthroughMinPriceMoveCents: 100,
      };
      db.candidateRows = [
        followthroughCandidateRow({
          event_title: "NFL Division Winner",
          market_title: "Will the Giants win the division?",
          outcomes: JSON.stringify(["New York Giants", "Field"]),
        }),
      ];
      db.flowRows = [
        followthroughFlowRow({ baseline_shares: "0", wallet_id: "wallet-1" }),
      ];
      const telegram = new FakeTelegram();
      const result = await publishSignalBotFollowthroughTick({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        now: new Date("2026-01-02T01:00:00.000Z"),
        redis,
        telegram,
      });

      const text = telegram.messages[0]?.text ?? "";
      assert.equal(result.sent, 1);
      assert.match(text, /net tracked NYG flow/);
      assert.match(text, /NYG: 40¢ → 55¢/);
      const keyboard = telegram.messages[0]?.reply_markup?.inline_keyboard;
      assert.equal(keyboard?.length, 1);
      assert.equal(keyboard?.[0]?.[0]?.text, "↗️ Open market");
    },
  },
  {
    name: "followthrough preview sends marked reply without recording delivery",
    run: async () => {
      const db = new FakeFollowthroughDb();
      db.candidateRows = [followthroughCandidateRow()];
      db.flowRows = [
        followthroughFlowRow({ baseline_shares: "0", wallet_id: "wallet-1" }),
        followthroughFlowRow({
          wallet_id: "wallet-2",
          baseline_shares: "50",
          latest_shares: "90",
          latest_size_usd: "4950",
          positive_usd: "4500",
          net_usd: "4500",
          net_shares: "40",
        }),
      ];
      const telegram = new FakeTelegram();
      const sent = await sendSignalBotFollowthroughPreview({
        chatId: "-100",
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        kind: "stats",
        now: new Date("2026-01-02T01:00:00.000Z"),
        telegram,
      });

      assert.equal(sent, true);
      assert.equal(telegram.messages[0]?.reply_parameters?.message_id, 77);
      assert.match(telegram.messages[0]?.text ?? "", /Preview only/);
      const candidateQuery = db.queries.find((query) =>
        query.sql.includes("from signal_bot_messages root"),
      );
      assert.equal(candidateQuery?.params[6], true);
      assert.equal(
        db.queries.filter((query) =>
          query.sql.includes("insert into signal_bot_messages"),
        ).length,
        0,
      );
    },
  },
  {
    name: "followthrough stats thresholds suppress weak open updates",
    run: async () => {
      const redis = new FakeRedis();
      await enableFollowthroughTestChat(redis);
      const db = new FakeFollowthroughDb();
      db.runtimePayload = {
        signalBotFollowthroughEnabled: true,
        signalBotFollowthroughTypes: ["stats"],
        signalBotFollowthroughMinJoinedOrAdded: 3,
        signalBotFollowthroughMinNetFlowUsd: 100_000,
        signalBotFollowthroughMinPriceMoveCents: 30,
      };
      db.candidateRows = [
        followthroughCandidateRow({
          best_bid: "0.45",
          best_ask: "0.47",
        }),
      ];
      db.flowRows = [followthroughFlowRow()];
      const telegram = new FakeTelegram();
      const result = await publishSignalBotFollowthroughTick({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        now: new Date("2026-01-02T01:00:00.000Z"),
        redis,
        telegram,
      });

      assert.equal(result.sent, 0);
      assert.equal(result.skipped, 1);
      assert.equal(telegram.messages.length, 0);
      const delivery = db.queries
        .filter((query) =>
          query.sql.includes("insert into signal_bot_messages"),
        )
        .at(-1);
      assert.ok(delivery);
      assert.equal(delivery.params[3], "followthrough_stats");
      const metrics = JSON.parse(String(delivery.params[8]));
      assert.equal(metrics.status, "skipped");
      assert.equal(typeof metrics.nextEvaluateAt, "string");
    },
  },
  {
    name: "followthrough price-only stats do not claim wallet evidence",
    run: async () => {
      const redis = new FakeRedis();
      await enableFollowthroughTestChat(redis);
      const db = new FakeFollowthroughDb();
      db.runtimePayload = {
        signalBotFollowthroughEnabled: true,
        signalBotFollowthroughTypes: ["stats"],
        signalBotFollowthroughMinJoinedOrAdded: 99,
        signalBotFollowthroughMinNetFlowUsd: 100_000,
        signalBotFollowthroughMinPriceMoveCents: 10,
      };
      db.candidateRows = [followthroughCandidateRow()];
      db.flowRows = [];
      const telegram = new FakeTelegram();
      const result = await publishSignalBotFollowthroughTick({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        now: new Date("2026-01-02T01:00:00.000Z"),
        redis,
        telegram,
      });

      assert.equal(result.sent, 1);
      assert.match(
        telegram.messages[0]?.text ?? "",
        /Market moved after the read/,
      );
      assert.match(
        telegram.messages[0]?.text ?? "",
        /Market moved with the read, but tracked wallet follow\\-through is thin/,
      );
      const keyboard = telegram.messages[0]?.reply_markup?.inline_keyboard;
      assert.equal(keyboard?.length, 1);
      assert.equal(keyboard?.[0]?.[0]?.text, "↗️ Open market");
    },
  },
  {
    name: "followthrough missing baseline snapshot is not counted as joined",
    run: async () => {
      const redis = new FakeRedis();
      await enableFollowthroughTestChat(redis);
      const db = new FakeFollowthroughDb();
      db.runtimePayload = {
        signalBotFollowthroughEnabled: true,
        signalBotFollowthroughTypes: ["stats"],
        signalBotFollowthroughMinJoinedOrAdded: 1,
        signalBotFollowthroughMinNetFlowUsd: 100_000,
        signalBotFollowthroughMinPriceMoveCents: 100,
      };
      db.candidateRows = [followthroughCandidateRow()];
      db.flowRows = [followthroughFlowRow()];
      const telegram = new FakeTelegram();
      const result = await publishSignalBotFollowthroughTick({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        now: new Date("2026-01-02T01:00:00.000Z"),
        redis,
        telegram,
      });

      assert.equal(result.sent, 0);
      assert.equal(result.skipped, 1);
      const delivery = db.queries
        .filter((query) =>
          query.sql.includes("insert into signal_bot_messages"),
        )
        .at(-1);
      assert.ok(delivery);
      const metrics = JSON.parse(String(delivery.params[8]));
      assert.equal(metrics.joinedWallets, 0);
      assert.equal(metrics.joinedOrAddedWallets, 0);
      assert.equal(metrics.missingBaselineSnapshots, 1);
      assert.deepEqual(metrics.dataQualityTags, [
        "missing_baseline_snapshots",
        "pnl_estimated",
      ]);
    },
  },
  {
    name: "followthrough estimated PnL uses post-signal net shares",
    run: async () => {
      const redis = new FakeRedis();
      await enableFollowthroughTestChat(redis);
      const db = new FakeFollowthroughDb();
      db.runtimePayload = {
        signalBotFollowthroughEnabled: true,
        signalBotFollowthroughTypes: ["stats"],
        signalBotFollowthroughMinJoinedOrAdded: 1,
        signalBotFollowthroughMinNetFlowUsd: 1,
        signalBotFollowthroughMinPriceMoveCents: 1,
      };
      db.candidateRows = [followthroughCandidateRow()];
      db.flowRows = [
        followthroughFlowRow({
          baseline_shares: "1000",
          latest_shares: "1010",
          latest_size_usd: "5555",
          net_shares: "10",
          net_usd: "500",
          positive_usd: "500",
        }),
      ];
      const telegram = new FakeTelegram();
      const result = await publishSignalBotFollowthroughTick({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        now: new Date("2026-01-02T01:00:00.000Z"),
        redis,
        telegram,
      });

      assert.equal(result.sent, 1);
      const delivery = db.queries
        .filter((query) =>
          query.sql.includes("insert into signal_bot_messages"),
        )
        .at(-1);
      assert.ok(delivery);
      const metrics = JSON.parse(String(delivery.params[8]));
      assert.equal(metrics.estimatedOpenPnlUsd, 1.5);
    },
  },
  {
    name: "followthrough policy can enable only resolved wins",
    run: async () => {
      const redis = new FakeRedis();
      await enableFollowthroughTestChat(redis);
      const db = new FakeFollowthroughDb();
      db.runtimePayload = {
        signalBotFollowthroughEnabled: true,
        signalBotFollowthroughTypes: ["resolved_win"],
      };
      db.candidateRows = [
        followthroughCandidateRow({
          accepting_orders: false,
          resolved_outcome: "YES",
        }),
      ];
      const telegram = new FakeTelegram();
      const result = await publishSignalBotFollowthroughTick({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        now: new Date("2026-01-02T01:00:00.000Z"),
        redis,
        telegram,
      });

      assert.equal(result.sent, 1);
      assert.equal(result.sentResolvedWin, 1);
      assert.match(telegram.messages[0]?.text ?? "", /Closed green/);
      assert.equal(telegram.messages[0]?.reply_markup, undefined);
      const delivery = db.queries
        .filter((query) =>
          query.sql.includes("insert into signal_bot_messages"),
        )
        .at(-1);
      assert.ok(delivery);
      assert.equal(delivery.params[3], "resolved_win");
    },
  },
  {
    name: "followthrough policy can enable only resolved losses",
    run: async () => {
      const redis = new FakeRedis();
      await enableFollowthroughTestChat(redis);
      const db = new FakeFollowthroughDb();
      db.runtimePayload = {
        signalBotFollowthroughEnabled: true,
        signalBotFollowthroughTypes: ["resolved_loss"],
      };
      db.candidateRows = [
        followthroughCandidateRow({
          accepting_orders: false,
          resolved_outcome: "NO",
        }),
      ];
      const telegram = new FakeTelegram();
      const result = await publishSignalBotFollowthroughTick({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        now: new Date("2026-01-02T01:00:00.000Z"),
        redis,
        telegram,
      });

      assert.equal(result.sent, 1);
      assert.equal(result.sentResolvedLoss, 1);
      assert.match(telegram.messages[0]?.text ?? "", /Closed red/);
      assert.equal(telegram.messages[0]?.reply_markup, undefined);
      const delivery = db.queries
        .filter((query) =>
          query.sql.includes("insert into signal_bot_messages"),
        )
        .at(-1);
      assert.ok(delivery);
      assert.equal(delivery.params[3], "resolved_loss");
    },
  },
  {
    name: "followthrough ignores terminal prices for resolved closeouts",
    run: async () => {
      const redis = new FakeRedis();
      await enableFollowthroughTestChat(redis);
      const db = new FakeFollowthroughDb();
      db.runtimePayload = {
        signalBotFollowthroughEnabled: true,
        signalBotFollowthroughTypes: ["resolved_win", "resolved_loss"],
      };
      db.candidateRows = [
        followthroughCandidateRow({
          accepting_orders: false,
          best_ask: "1",
          best_bid: "0.99",
          last_price: "1",
          resolved_outcome: null,
          resolved_outcome_pct: null,
        }),
      ];
      const telegram = new FakeTelegram();
      const result = await publishSignalBotFollowthroughTick({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        now: new Date("2026-01-02T01:00:00.000Z"),
        redis,
        telegram,
      });

      assert.equal(result.sent, 0);
      assert.equal(result.skipped, 1);
      assert.equal(telegram.messages.length, 0);
      assert.equal(
        db.queries.filter((query) =>
          query.sql.includes("insert into signal_bot_messages"),
        ).length,
        0,
      );
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
  {
    name: "test signal uses private chat web app buttons from redis state",
    run: async () => {
      const redis = new FakeRedis();
      await enableSignalBotChat({
        chat: { id: "-100", first_name: "Kreedle", type: "private" },
        enabledBy: 123,
        now: new Date("2026-01-01T00:00:00.000Z"),
        redis,
      });
      const db = new FakeDb();
      db.rows = [noteRow({ id: "00000000-0000-4000-8000-000000000099" })];
      const telegram = new FakeTelegram();
      const sent = await sendLatestSignalBotTestSignal({
        chatId: "-100",
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE:
            "https://t.me/hunch_bot/hunch",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        redis,
        telegram,
      });
      assert.equal(sent, true);
      const keyboard = telegram.messages[0]?.reply_markup?.inline_keyboard;
      assert.equal(keyboard?.[0]?.[0]?.url, undefined);
      assert.equal(
        decodeStartAppPayload(readWebAppStartParam(keyboard?.[0]?.[0])),
        "p:event-1|market-1|Y|10",
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
    console.error(`[signal-bot-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(`[signal-bot-tests] passed ${passed}/${tests.length}`);
