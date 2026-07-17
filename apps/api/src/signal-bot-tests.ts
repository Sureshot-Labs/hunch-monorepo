import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { QueryResult, QueryResultRow } from "pg";
import {
  DEFAULT_VENUE_LIFECYCLE_POLICY,
  parseVenueLifecyclePolicy,
  venueHasLifecycleCapability,
} from "@hunch/shared";

import {
  acquireSignalBotLock,
  buildSignalBotHolderUrl,
  buildSignalBotMenuScreen,
  buildSignalBotMessage as buildSignalBotMessageImpl,
  buildSignalBotStatsReport,
  buildSignalBotTradeUrl,
  configureSignalBotTelegramUi,
  disableSignalBotChat,
  drainSignalBotConfirmTasks,
  enableSignalBotChat,
  escapeTelegramMarkdownV2,
  getSignalBotChatState,
  handleSignalBotCommand,
  handleSignalBotMenuCallback,
  handleSignalBotMenuInput,
  loadSignalBotNotes,
  parseSignalBotAggMarketConfig,
  parseSignalBotCommand,
  parseSignalBotFollowthroughPreviewRequest,
  parseSignalBotConfig,
  parseSignalBotStatsRequest,
  parseSignalBotStatsPeriod,
  pollSignalBotCommands,
  prepareSignalBotDelivery,
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
  resolveSignalBotLatestSnapshotMaxAgeMs,
  type SignalBotNote,
  type SignalBotRedisLike,
  type TelegramBotCallbackQuery,
  type TelegramBotUpdate,
  type TelegramSendMessageInput,
  type TelegramSendResult,
} from "./services/signal-bot.js";
import {
  buildPreparedTradeSnapshot,
  buildTelegramBotTradingMarketMessage,
  disableTelegramBotTradingForUser,
  enableTelegramBotTrading,
  getTelegramBotTradingStatus,
  handleTelegramBotTradingCallback,
  reconcileStaleTelegramTradeIntents,
  resolveTelegramBotTradingWalletSetupIssues,
  telegramBotTradingTestHooks,
} from "./services/telegram-bot-trading.js";
import { reconcileTelegramVenueIntents } from "./services/telegram-bot-trading-venue-reconcile.js";
import {
  isTelegramBotTradingReconciliationEnabled,
  reconcileTelegramBotTradingStatus,
  resolveInternalPrivyWalletCandidates,
  resolveInternalPrivyWalletCandidatesForProfile,
  resolveTelegramBotTradingStatusWalletSetupIssues,
} from "./routes/telegram-bot-trading.js";
import {
  PrivyService,
  type PrivyUser,
  type PrivyWalletProfile,
} from "./privy-service.js";
import type {
  PreparedTrade,
  TradeIntent,
  TradeQuote,
  TradingReadiness,
  TradingVenue,
} from "./services/trading-types.js";
import { createTelegramBotTradingInternalApiClient } from "./services/telegram-bot-trading-client.js";
import {
  buildTelegramTradeProgressMessage,
  escapeTelegramMarkdownV2 as escapeTradingMarkdownV2,
  formatTelegramTtl,
} from "./services/telegram-bot-trading-presentation.js";
import { normalizeSignalBotPolicy } from "./services/signal-bot-trading-policy.js";
import {
  buildTelegramActivityNotificationMessage,
  deliverTelegramNotificationOutbox,
  enqueueTelegramActivityNotifications,
  enqueueTelegramPositionSignals,
} from "./services/telegram-notification-delivery.js";
import {
  ensureTelegramNotificationPreferences,
  setTelegramNotificationTopic,
} from "./services/telegram-notification-preferences.js";
import type { PrivyServerSignerStatus } from "./services/api-trading-wallet-signing.js";
import { resolveSignalDeliveryTarget } from "./services/signal-delivery-target.js";
import {
  isSignalBotQuoteFresh,
  SIGNAL_BOT_QUOTE_MAX_AGE_MS,
} from "./services/signal-bot-delivery-policy.js";
import {
  hasHolderResearchPublicationDecisionV1,
  type HolderResearchUpdateReason,
} from "./services/signal-publication-contract.js";
import {
  createDiscordSignalTransport,
  createTelegramSignalTransport,
  createXSignalTransport,
  renderDiscordSignalDelivery,
  renderTelegramSignalDelivery,
  renderXSignalDelivery,
  type SignalDeliveryView,
} from "./services/signal-delivery.js";

const TEST_TELEGRAM_MINI_APP_LINK_BASE = "https://t.me/hunch_signal_bot/hunch";

function buildSignalBotMessage(
  input: Parameters<typeof buildSignalBotMessageImpl>[0],
) {
  return buildSignalBotMessageImpl({
    telegramMiniAppLinkBase: TEST_TELEGRAM_MINI_APP_LINK_BASE,
    ...input,
  });
}

const readyTelegramSignerStatus: PrivyServerSignerStatus = {
  attached: true,
  canRemoveAllSigners: true,
  grant: {
    policyIds: ["policy-1"],
    policyProfile: "buy",
    replaceExistingSigner: false,
    signerId: "signer-1",
    walletAddress: "0x0000000000000000000000000000000000000001",
    walletChain: "ethereum",
  },
  message: null,
  policyId: "policy-1",
  policyMaxBuyUsd: 50,
  signerId: "signer-1",
  state: "ready",
};

const readyTelegramSignerInspector = async (input: {
  authorizationEnabled: boolean;
}) =>
  input.authorizationEnabled
    ? readyTelegramSignerStatus
    : {
        ...readyTelegramSignerStatus,
        message: "Bot access is still attached and must be revoked.",
        state: "revoke_required" as const,
      };

function buildTestTelegramQuote(
  intent: TradeIntent,
  overrides: Partial<TradeQuote> = {},
): TradeQuote {
  const amountUsd = Number(intent.amount.value);
  return {
    action: "BUY",
    amount: intent.amount,
    currentPrice: 0.5,
    estimatedNotionalUsd: amountUsd,
    estimatedShares: amountUsd / 0.525,
    expiresAt: new Date(Date.now() + 30_000),
    fees: {},
    maxSpendUsd: amountUsd,
    meetsVenueMinimum: true,
    minimumOrderSizeShares: 5,
    minReceiveShares: amountUsd / 0.525,
    price: 0.525,
    target: intent.target,
    venue: intent.venue,
    ...overrides,
  };
}

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
  readonly edits: Array<
    Omit<TelegramSendMessageInput, "reply_parameters"> & { message_id: number }
  > = [];
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

  async editMessageText(
    input: Omit<TelegramSendMessageInput, "reply_parameters"> & {
      message_id: number;
    },
  ): Promise<TelegramSendResult> {
    this.edits.push(input);
    return { messageId: input.message_id, ok: true };
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

function buildTradeCallbackQuery(input: {
  chatId?: number | string;
  chatType?: string;
  data: string;
  fromId?: number;
  id?: string;
}): TelegramBotCallbackQuery {
  return {
    data: input.data,
    from: { id: input.fromId ?? 999 },
    id: input.id ?? "callback-1",
    message: {
      chat: {
        id: input.chatId ?? 999,
        type: input.chatType ?? "private",
      },
    },
  };
}

function buildTestPolymarketReadiness(
  input: {
    code?: string | null;
    executable?: boolean;
    message?: string | null;
    repairKind?: "app_required" | "auto";
    sideEffect?: "approval" | "connection" | "credential";
  } = {},
): TradingReadiness {
  const executable = input.executable ?? false;
  const code = executable ? null : (input.code ?? "insufficient_readiness");
  const message = executable ? null : (input.message ?? "Not ready.");
  return {
    ready: executable,
    executable,
    reasonCode: code,
    message,
    setupRequired: !executable,
    ...(input.repairKind && code && message
      ? {
          repair: {
            kind: input.repairKind,
            code,
            message,
            ...(input.sideEffect ? { sideEffect: input.sideEffect } : {}),
          },
        }
      : {}),
    capabilities: {
      venue: "polymarket",
      supportsBuy: true,
      supportsSell: false,
      supportsCancel: false,
      supportsOrderSync: false,
      supportsPositionSync: false,
      supportsExecutionSync: false,
      supportsSetup: false,
      authorizationModes: ["embedded_privy_evm"],
    },
  };
}

type ConfirmIntentUpdate = {
  errorCode: unknown;
  markSubmitStarted: boolean;
  result: Record<string, unknown> | null;
  status: unknown;
};

function createPolymarketConfirmDb(updates: ConfirmIntentUpdate[]) {
  return {
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
        updates.push({
          status: params?.[1],
          errorCode: params?.[2],
          result:
            typeof params?.[4] === "string"
              ? (JSON.parse(params[4]) as Record<string, unknown>)
              : null,
          markSubmitStarted: Boolean(params?.[12]),
        });
        return { rowCount: 1, rows: [{ id: params?.[0] }] };
      }
      if (sql.includes("UPDATE telegram_trade_intents")) {
        return { rowCount: 1, rows: [{ id: params?.[0] }] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
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
      ts: new Date().toISOString(),
    },
    {
      best_ask: "0.61",
      best_bid: "0.6",
      token_id: "no-token",
      ts: new Date().toISOString(),
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
    if (sql.includes("yes_top.best_ask as yes_ask")) {
      const marketIds = new Set(
        Array.isArray(params[0]) ? (params[0] as string[]) : [],
      );
      const rows = this.marketRows
        .filter((row) => marketIds.has(String((row as { id?: unknown }).id)))
        .map((row) => {
          const record = row as {
            id?: unknown;
            token_no?: unknown;
            token_yes?: unknown;
            venue?: unknown;
          };
          const yesTop = this.tokenTopRows.find(
            (top) =>
              String((top as { token_id?: unknown }).token_id) ===
              String(record.token_yes),
          ) as Record<string, unknown> | undefined;
          const noTop = this.tokenTopRows.find(
            (top) =>
              String((top as { token_id?: unknown }).token_id) ===
              String(record.token_no),
          ) as Record<string, unknown> | undefined;
          return {
            active: true,
            market_id: record.id,
            no_ask: noTop?.best_ask ?? null,
            no_bid: noTop?.best_bid ?? null,
            no_ts: noTop?.ts ?? null,
            orderable: true,
            venue: record.venue,
            yes_ask: yesTop?.best_ask ?? null,
            yes_bid: yesTop?.best_bid ?? null,
            yes_ts: yesTop?.ts ?? null,
          };
        });
      return {
        command: "SELECT",
        fields: [],
        oid: 0,
        rowCount: rows.length,
        rows: rows as unknown as T[],
      };
    }
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
        rows: (sql.includes("returning id")
          ? [{ id: "00000000-0000-4000-8000-000000000099" }]
          : []) as unknown as T[],
      };
    }
    if (sql.includes("from unified_market_tokens")) {
      const marketIds = new Set(
        Array.isArray(params[0]) ? (params[0] as string[]) : [],
      );
      const fallbackTokenRows = this.marketRows.flatMap((row) => {
        const market = row as {
          id?: unknown;
          token_no?: unknown;
          token_yes?: unknown;
          venue?: unknown;
        };
        return [
          { outcome_side: "YES", token_id: market.token_yes },
          { outcome_side: "NO", token_id: market.token_no },
        ]
          .filter(
            (token) =>
              typeof token.token_id === "string" && token.token_id.length > 0,
          )
          .map((token) => ({
            market_id: market.id,
            venue: market.venue,
            ...token,
          }));
      });
      const tokenRows =
        this.marketTokenRows.length > 0
          ? this.marketTokenRows
          : fallbackTokenRows;
      const rows = marketIds.size
        ? tokenRows.filter((row) =>
            marketIds.has(String((row as { market_id?: unknown }).market_id)),
          )
        : tokenRows;
      return {
        command: "SELECT",
        fields: [],
        oid: 0,
        rowCount: rows.length,
        rows: rows as unknown as T[],
      };
    }
    if (sql.includes("from unified_token_top_latest")) {
      const tokenIds = new Set(
        Array.isArray(params[0]) ? (params[0] as string[]) : [],
      );
      const rows = tokenIds.size
        ? this.tokenTopRows.filter((row) =>
            tokenIds.has(String((row as { token_id?: unknown }).token_id)),
          )
        : this.tokenTopRows;
      return {
        command: "SELECT",
        fields: [],
        oid: 0,
        rowCount: rows.length,
        rows: rows as T[],
      };
    }
    if (
      sql.includes("FROM unified_markets m") &&
      sql.includes("WHERE m.id = $1")
    ) {
      const row = this.marketRows.find(
        (market) => String((market as { id?: unknown }).id) === params[0],
      );
      const rows = row
        ? [
            {
              accepting_orders: true,
              close_time: new Date("2999-01-01T00:00:00.000Z"),
              event_end_time: null,
              event_id: "polymarket:event-1",
              event_title: "Test event",
              expiration_time: null,
              is_initialized: true,
              metadata: {},
              outcomes: '["YES","NO"]',
              slug: "test-market",
              status: "ACTIVE",
              title: "Test market",
              venue_market_id: "market-1",
              ...row,
            },
          ]
        : [];
      return {
        command: "SELECT",
        fields: [],
        oid: 0,
        rowCount: rows.length,
        rows: rows as unknown as T[],
      };
    }
    if (
      sql.includes("from unified_markets") &&
      sql.includes("where id = any")
    ) {
      const marketIds = new Set(
        Array.isArray(params[0]) ? (params[0] as string[]) : [],
      );
      const rows = marketIds.size
        ? this.marketRows.filter((row) =>
            marketIds.has(String((row as { id?: unknown }).id)),
          )
        : this.marketRows;
      return {
        command: "SELECT",
        fields: [],
        oid: 0,
        rowCount: rows.length,
        rows: rows as T[],
      };
    }
    const publicationRows = this.rows.filter((row) =>
      hasHolderResearchPublicationDecisionV1(
        (row as { metrics?: unknown }).metrics,
      ),
    );
    const directionEligibleRows = publicationRows.filter((row) => {
      const direction = String(
        (row as { direction?: unknown }).direction ?? "",
      );
      return direction === "up" || direction === "down";
    });
    const rows = directionEligibleRows;
    if (sql.includes("publish_notes_seen")) {
      const nonDirectional =
        publicationRows.length - directionEligibleRows.length;
      return {
        command: "SELECT",
        fields: [],
        oid: 0,
        rowCount: 1,
        rows: [
          {
            publish_notes_seen: rows.length,
            non_directional: nonDirectional,
            total: publicationRows.length,
          },
        ] as unknown as T[],
      };
    }
    const limit = Number(params[2] ?? rows.length);
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

const TEST_SIGNAL_PRICE_AS_OF = new Date().toISOString();

function testSignalIdentity(side: "NO" | "YES" = "YES") {
  return {
    asOf: TEST_SIGNAL_PRICE_AS_OF,
    eventId: "polymarket:event-1",
    eventTitle: "Test event",
    marketGroupItemTitle: "Will test resolve Yes?",
    marketId: "polymarket:market-1",
    marketQuestion: "Will test resolve Yes?",
    predicate: "Will test resolve Yes?",
    selectedSide: side,
    selectedSideLabel: side,
    source: "canonical_market" as const,
    subject: "Test event",
    venue: "polymarket",
    version: 1 as const,
  };
}

function testSignalPriceSnapshot(side: "NO" | "YES" = "YES") {
  return {
    asOf: TEST_SIGNAL_PRICE_AS_OF,
    displayPrice: side === "YES" ? 0.31 : 0.69,
    displayPriceSource: "midpoint" as const,
    displaySide: side,
    marketId: "polymarket:market-1",
    NO: { ask: 0.7, bid: 0.68, mark: 0.69 },
    venue: "polymarket",
    version: 1 as const,
    YES: { ask: 0.32, bid: 0.3, mark: 0.31 },
  };
}

function note(overrides: Partial<SignalBotNote> = {}): SignalBotNote {
  const result: SignalBotNote = {
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
    revisionKind: "initial",
    meaningfulDeltaReasons: [],
    decisionSnapshot: null,
    previousDecisionSnapshot: null,
    thesisKey: "holder_research:v2:polymarket:market-1:YES",
    thesisRootNoteId: "00000000-0000-4000-8000-000000000001",
    primaryTargetMeta: { bucket: "sharp_side", side: "YES" },
    marketId: "polymarket:market-1",
    eventId: "polymarket:event-1",
    marketVenue: "polymarket",
    marketTitle: "Will test resolve Yes?",
    marketSlug: null,
    marketDescription: null,
    eventTitle: "Test event",
    eventDescription: null,
    outcomes: null,
    resolutionSource: null,
    marketSegment: null,
    closeTime: null,
    expirationTime: null,
    bestBid: 0.3,
    bestAsk: 0.32,
    lastPrice: null,
    holderAddress: "0xa022ba0a68e11a78348382ff168601012d4d77f8",
    holderChain: "polygon",
    holderWalletId: "wallet-1",
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
  const side: "NO" | "YES" = result.direction === "down" ? "NO" : "YES";
  if (!("telegramMarketIdentityV1" in overrides)) {
    result.telegramMarketIdentityV1 = {
      ...testSignalIdentity(side),
      eventId: result.eventId,
      eventTitle: result.eventTitle,
      marketGroupItemTitle: result.marketTitle,
      marketId: result.marketId ?? "polymarket:market-1",
      marketQuestion: result.marketTitle ?? "Test market",
      predicate: result.marketTitle ?? "Test market",
      subject: result.eventTitle ?? result.marketTitle ?? "Test market",
      venue: result.marketVenue ?? "polymarket",
    };
  }
  if (!("signalPriceSnapshotV1" in overrides)) {
    const yesBid = result.bestBid ?? 0.3;
    const yesAsk = result.bestAsk ?? 0.32;
    const yesMark = (yesBid + yesAsk) / 2;
    const noBid = 1 - yesAsk;
    const noAsk = 1 - yesBid;
    const noMark = (noBid + noAsk) / 2;
    result.signalPriceSnapshotV1 = {
      asOf: TEST_SIGNAL_PRICE_AS_OF,
      displayPrice: side === "YES" ? yesMark : noMark,
      displayPriceSource: "midpoint",
      displaySide: side,
      marketId: result.marketId ?? "polymarket:market-1",
      NO: { ask: noAsk, bid: noBid, mark: noMark },
      venue: result.marketVenue ?? "polymarket",
      version: 1,
      YES: { ask: yesAsk, bid: yesBid, mark: yesMark },
    };
  }
  const meaningfulDeltaReasons = result.meaningfulDeltaReasons ?? [];
  const priceSnapshot = result.signalPriceSnapshotV1;
  if (
    result.revisionKind === "research_update" &&
    !("holderResearchUpdateV1" in overrides) &&
    meaningfulDeltaReasons.length > 0 &&
    priceSnapshot
  ) {
    const currentSnapshot = result.decisionSnapshot as ReturnType<
      typeof researchSnapshot
    > | null;
    const previousSnapshot = result.previousDecisionSnapshot as ReturnType<
      typeof researchSnapshot
    > | null;
    const selectedPrice = (snapshot: ReturnType<typeof researchSnapshot>) =>
      side === "YES" ? snapshot.yesProbability : 1 - snapshot.yesProbability;
    const positionMove = meaningfulDeltaReasons.some((value) =>
      value.startsWith("holder_position_move:"),
    );
    const walletMove = meaningfulDeltaReasons.some((value) =>
      value.startsWith("sharp_holder_count_changed"),
    );
    const supportedPriceMove = meaningfulDeltaReasons.includes("odds_move");
    if (!positionMove && !walletMove && !supportedPriceMove) return result;
    const beforePrice =
      previousSnapshot != null
        ? selectedPrice(previousSnapshot)
        : priceSnapshot.displayPrice - 0.04;
    const afterPrice =
      currentSnapshot != null
        ? selectedPrice(currentSnapshot)
        : priceSnapshot.displayPrice;
    if (supportedPriceMove) {
      result.signalPriceSnapshotV1 = {
        ...priceSnapshot,
        displayPrice: afterPrice,
        [side]: {
          ...priceSnapshot[side],
          mark: afterPrice,
        },
      };
    }
    const previousHolder = previousSnapshot?.evidenceHolders[0];
    const currentHolder = currentSnapshot?.evidenceHolders[0];
    const beforeWallets = previousSnapshot?.sides[side].sharpHolders ?? 1;
    const afterWallets = currentSnapshot?.sides[side].sharpHolders ?? 2;
    const reason: HolderResearchUpdateReason = positionMove
      ? {
          after: currentHolder?.positionUsd ?? 20_000,
          asOf: TEST_SIGNAL_PRICE_AS_OF,
          before: previousHolder?.positionUsd ?? 12_000,
          delta:
            (currentHolder?.positionUsd ?? 20_000) -
            (previousHolder?.positionUsd ?? 12_000),
          kind: "position_increased" as const,
          scope: "representative_wallet" as const,
          side,
          unit: "usd" as const,
          walletId: result.holderWalletId ?? "wallet-1",
        }
      : walletMove
        ? {
            after: afterWallets,
            asOf: TEST_SIGNAL_PRICE_AS_OF,
            before: beforeWallets,
            delta: afterWallets - beforeWallets,
            direction: "increased" as const,
            kind: "wallet_confluence_changed" as const,
            side,
            unit: "wallets" as const,
          }
        : {
            after: afterPrice,
            asOf: TEST_SIGNAL_PRICE_AS_OF,
            before: beforePrice,
            delta: afterPrice - beforePrice,
            kind: "price_moved_with_thesis" as const,
            side,
            unit: "probability" as const,
          };
    result.holderResearchUpdateV1 = {
      baselineAsOf: "2026-01-01T00:00:00.000Z",
      baselineNoteId: result.thesisRootNoteId,
      changedAt: TEST_SIGNAL_PRICE_AS_OF,
      ctaIntent: "open_market",
      fingerprint: `test-${result.id}`,
      materialityPolicy: {
        revision: "test-v1",
        thresholds: { minMeaningfulOddsDelta: 0.02 },
        version: 1,
      },
      primaryReason: reason,
      reasons: [reason],
      selectedSide: side,
      version: 1,
    };
  }
  return result;
}

function noteRow(overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: "00000000-0000-4000-8000-000000000001",
    note_key: "holder_research:v1:test",
    title: "Sharp YES interest",
    description: "A capable holder is leaning yes while public news is thin.",
    rationale: "Holder timing adds useful context.",
    producer_run_id: "run-1",
    direction: "up",
    confidence: "0.82",
    metrics: {},
    model_meta: {
      external_research: {
        summary:
          "Public info followed the holder activity. Later reports may validate the move.",
      },
    },
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    revision_kind: "initial",
    meaningful_delta_reasons: [],
    decision_snapshot: null,
    previous_decision_snapshot: null,
    thesis_key: "holder_research:v2:polymarket:market-1:YES",
    thesis_root_note_id: "00000000-0000-4000-8000-000000000001",
    primary_target_meta: { bucket: "sharp_side", side: "YES" },
    market_id: "polymarket:market-1",
    event_id: "polymarket:event-1",
    market_venue: "polymarket",
    market_title: "Will test resolve Yes?",
    market_slug: null,
    market_description: null,
    event_title: "Test event",
    event_description: null,
    category: null,
    event_category: null,
    series_key: null,
    series_title: null,
    close_time: null,
    expiration_time: null,
    outcomes: null,
    resolution_source: null,
    market_segment: null,
    best_bid: "0.30",
    best_ask: "0.32",
    last_price: null,
    holder_address: "0xa022ba0a68e11a78348382ff168601012d4d77f8",
    holder_chain: "polygon",
    holder_wallet_id: "wallet-1",
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
  if (!("metrics" in overrides)) {
    const side = row.direction === "down" ? "NO" : "YES";
    const identity = {
      ...testSignalIdentity(side),
      eventId: String(row.event_id),
      eventTitle: String(row.event_title),
      marketGroupItemTitle: String(row.market_title),
      marketId: String(row.market_id),
      marketQuestion: String(row.market_title),
      predicate: String(row.market_title),
      venue: String(row.market_venue),
    };
    const priceSnapshot = {
      ...testSignalPriceSnapshot(side),
      marketId: String(row.market_id),
      venue: String(row.market_venue),
    };
    const meaningfulReasons = Array.isArray(row.meaningful_delta_reasons)
      ? row.meaningful_delta_reasons.map(String)
      : [];
    const positionMove = meaningfulReasons.some(
      (reason) =>
        reason.startsWith("holder_position_move") ||
        reason.startsWith("side_exposure_move"),
    );
    const walletMove = meaningfulReasons.some((reason) =>
      reason.startsWith("sharp_holder_count_changed"),
    );
    const priceMove = meaningfulReasons.includes("odds_move");
    const primaryReason = positionMove
      ? {
          after: 20_000,
          asOf: TEST_SIGNAL_PRICE_AS_OF,
          before: 12_000,
          delta: 8_000,
          kind: "position_increased",
          scope: "representative_wallet",
          side,
          unit: "usd",
          walletId: "wallet-1",
        }
      : walletMove
        ? {
            after: 3,
            asOf: TEST_SIGNAL_PRICE_AS_OF,
            before: 1,
            delta: 2,
            direction: "increased",
            kind: "wallet_confluence_changed",
            side,
            unit: "wallets",
          }
        : {
            after: priceSnapshot.displayPrice,
            asOf: TEST_SIGNAL_PRICE_AS_OF,
            before: priceSnapshot.displayPrice - (priceMove ? 0.04 : 0.05),
            delta: priceMove ? 0.04 : 0.05,
            kind: "price_moved_with_thesis",
            side,
            unit: "probability",
          };
    row.metrics = {
      publicationDecisionV1: {
        authority: "holder_research_quality_gate",
        status: "PUBLISH",
        version: 1,
      },
      telegramMarketIdentityV1: identity,
      signalPriceSnapshotV1: priceSnapshot,
      holderResearchUpdateV1:
        row.revision_kind === "research_update"
          ? {
              baselineAsOf: "2026-01-01T00:00:00.000Z",
              baselineNoteId: "00000000-0000-4000-8000-000000000001",
              changedAt: TEST_SIGNAL_PRICE_AS_OF,
              ctaIntent: positionMove || walletMove ? "buy" : "open_market",
              fingerprint: `test-${String(row.id)}`,
              materialityPolicy: {
                revision: "test-v1",
                thresholds: { minMeaningfulOddsDelta: 0.02 },
                version: 1,
              },
              primaryReason,
              reasons: [primaryReason],
              selectedSide: side,
              version: 1,
            }
          : null,
    };
  }
  return row;
}

function researchSnapshot(input: {
  holderPositionUsd?: number;
  noSharpHolders?: number;
  noUsd?: number;
  recentActivityUsd?: number;
  side?: "NO" | "YES";
  yesProbability: number;
  yesSharpHolders?: number;
  yesUsd?: number;
}) {
  const side = input.side ?? "NO";
  const yesUsd = input.yesUsd ?? (side === "YES" ? 7_500 : 2_500);
  const noUsd = input.noUsd ?? (side === "NO" ? 7_500 : 2_500);
  return {
    version: 1,
    yesProbability: input.yesProbability,
    sides: {
      YES: {
        usd: yesUsd,
        wallets: input.yesSharpHolders ?? 1,
        sharpHolders: input.yesSharpHolders ?? 1,
      },
      NO: {
        usd: noUsd,
        wallets: input.noSharpHolders ?? 1,
        sharpHolders: input.noSharpHolders ?? 1,
      },
    },
    evidenceHolders: [
      {
        walletId: "wallet-1",
        side,
        positionUsd:
          input.holderPositionUsd ?? (side === "NO" ? noUsd : yesUsd),
      },
    ],
    recentActivityUsd: input.recentActivityUsd ?? 0,
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
        rows: (sql.includes("returning id")
          ? [{ id: "00000000-0000-4000-8000-000000000099" }]
          : []) as unknown as T[],
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

function readSignalBotMessageInsert(query: { params: unknown[]; sql: string }) {
  const hasExplicitId = /insert into signal_bot_messages\s*\(\s*id,/i.test(
    query.sql,
  );
  const offset = hasExplicitId ? 1 : 0;
  return {
    id: hasExplicitId ? query.params[0] : null,
    chatId: query.params[offset],
    noteId: query.params[offset + 1],
    threadRootNoteId: query.params[offset + 2],
    messageKind: query.params[offset + 3],
    messageId: query.params[offset + 4],
    replyToMessageId: query.params[offset + 5],
    metrics: JSON.parse(String(query.params[offset + 8])) as Record<
      string,
      unknown
    >,
  };
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
    root_metrics: {},
    target_meta: { side: "YES" },
    market_id: "polymarket:market-1",
    event_id: "polymarket:event-1",
    market_title: "Will test resolve Yes?",
    market_slug: null,
    market_description: null,
    event_title: "Test event",
    event_description: null,
    outcomes: null,
    resolution_source: null,
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
    latest_snapshot_at: "2026-01-02T00:30:00.000Z",
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
  button: { text?: string; web_app?: { url: string } } | undefined,
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
    name: "Telegram trading presentation escapes dynamic text and formats progress",
    run: () => {
      assert.equal(
        escapeTradingMarkdownV2("Market_[x]."),
        "Market\\_\\[x\\]\\.",
      );
      assert.equal(formatTelegramTtl(120), "2 minutes");
      assert.match(
        buildTelegramTradeProgressMessage("processing"),
        /Processing trade/,
      );
      assert.match(
        buildTelegramTradeProgressMessage("resolving"),
        /checking automatically/,
      );
      assert.match(buildTelegramTradeProgressMessage("resolving"), /\\\./);
    },
  },
  {
    name: "prepared trade snapshots keep only redacted recovery data",
    run: () => {
      const venues: TradingVenue[] = ["polymarket", "limitless", "kalshi"];
      for (const venue of venues) {
        const prepared: PreparedTrade = {
          authorizationMode:
            venue === "kalshi" ? "embedded_privy_solana" : "embedded_privy_evm",
          authorizationRequests: [],
          expiresAt: new Date("2026-07-07T12:00:00Z"),
          intent: {
            action: "BUY",
            actor: { kind: "telegram_bot", userId: "user-1" },
            amount: { type: "usd", value: "10" },
            id: `intent-${venue}`,
            idempotencyKey: `telegram-bot:intent-${venue}`,
            target: {
              eventId: "event-1",
              marketId: "market-1",
              outcome: "YES",
              title: "Market",
              tokenId: "token-1",
              venue,
              venueMarketId: "venue-market-1",
            },
            venue,
            walletAddress:
              venue === "kalshi"
                ? "So11111111111111111111111111111111111111112"
                : "0x0000000000000000000000000000000000000001",
            walletChain: venue === "kalshi" ? "solana" : "ethereum",
          },
          preparedId: `prepared-${venue}`,
          quote: null,
          reconcileKeys: {
            idempotencyKey: `telegram-bot:intent-${venue}`,
            intentId: `intent-${venue}`,
            safeIdentifier: `safe-${venue}`,
            venue,
          },
          venue,
          venuePayload: {
            signature: "do-not-store-signature",
            transaction: "do-not-store-transaction",
          },
        };

        const snapshot = buildPreparedTradeSnapshot(prepared as never);
        assert.deepEqual(snapshot.reconcileKeys, prepared.reconcileKeys);
        assert.equal("venuePayload" in snapshot, false);
        assert.equal(JSON.stringify(snapshot).includes("do-not-store"), false);
      }
    },
  },
  {
    name: "env parser handles admins and default buy amount",
    run: () => {
      const config = parseSignalBotConfig({
        HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123, 456, nope",
        HUNCH_SIGNAL_BOT_BUY_AMOUNT_USD: "",
        HUNCH_SIGNAL_BOT_ENABLED: "true",
        HUNCH_SIGNAL_BOT_TOKEN: "token",
      });
      assert.equal(config.enabled, true);
      assert.deepEqual([...config.adminUserIds], [123, 456]);
      assert.equal(config.buyAmountUsd, 10);
      assert.equal("minConfidence" in config, false);
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
        terminalInitialCutoff: null,
      });
      assert.equal(config.telegramMiniAppLinkBase, null);
    },
  },
  {
    name: "signal delivery owns the inclusive ten minute quote cutoff",
    run: () => {
      const now = Date.parse("2026-01-01T00:10:00.000Z");
      assert.equal(SIGNAL_BOT_QUOTE_MAX_AGE_MS, 600_000);
      assert.equal(isSignalBotQuoteFresh(now - 599_000, now), true);
      assert.equal(isSignalBotQuoteFresh(now - 600_000, now), true);
      assert.equal(isSignalBotQuoteFresh(now - 601_000, now), false);
      const source = readFileSync(
        join(apiSrcDir, "services", "signal-bot.ts"),
        "utf8",
      );
      assert.doesNotMatch(source, /CLUSTER_EXECUTION_QUOTE_MAX_AGE_MS/);
      assert.match(source, /SIGNAL_BOT_QUOTE_MAX_AGE_MS/);
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
      assert.equal(
        parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE:
            "https://telegram.me/hunch_signal_bot/hunch",
        }).telegramMiniAppLinkBase,
        null,
      );
    },
  },
  {
    name: "production signal bot refuses to start without a Mini App deep link",
    run: () => {
      assert.throws(
        () =>
          parseSignalBotConfig({
            HUNCH_SIGNAL_BOT_ENABLED: "true",
            HUNCH_SIGNAL_BOT_TOKEN: "token",
            NODE_ENV: "production",
          }),
        /HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE is required/,
      );
    },
  },
  {
    name: "menu renderer exposes button-first public navigation and scopes admin tools",
    run: () => {
      const regular = buildSignalBotMenuScreen({
        appBaseUrl: "https://app.hunch.trade",
        isAdmin: false,
        miniAppEnabled: true,
        screen: "home",
      });
      const regularButtons = regular.keyboard.inline_keyboard.flat();
      const regularLabels = regularButtons.map((button) => button.text);
      assert.match(regular.text, /Hunch/);
      assert.doesNotMatch(regular.text, /\/(?:menu|market|trade|help)/);
      assert.equal(
        regularButtons.some((button) => button.text === "🔎 Markets"),
        true,
      );
      assert.equal(
        regularButtons.some((button) => button.text === "⚙️ Settings"),
        true,
      );
      assert.deepEqual(regularLabels, [
        "🔎 Markets",
        "💼 My positions",
        "👤 My trading",
        "💳 Deposit",
        "🔔 Notifications",
        "⚙️ Settings",
        "❓ Help",
      ]);
      assert.equal(
        regularButtons.some((button) => button.text === "📊 Performance"),
        false,
      );
      assert.equal(
        regularButtons.some((button) => button.text === "🛠 Admin"),
        false,
      );
      const admin = buildSignalBotMenuScreen({
        appBaseUrl: "https://app.hunch.trade",
        isAdmin: true,
        miniAppEnabled: true,
        screen: "home",
      });
      const adminLabels = admin.keyboard.inline_keyboard
        .flat()
        .map((button) => button.text);
      assert.equal(adminLabels.includes("📊 Performance"), false);
      assert.equal(adminLabels.includes("🛠 Admin"), true);
    },
  },
  {
    name: "settings renderer groups working notifications, signals, and account links",
    run: () => {
      const settings = buildSignalBotMenuScreen({
        appBaseUrl: "https://app.hunch.trade",
        isAdmin: false,
        miniAppEnabled: true,
        screen: "settings",
      });
      assert.deepEqual(
        settings.keyboard.inline_keyboard.flat().map((button) => button.text),
        [
          "🔔 Notifications",
          "📡 Signals",
          "👤 Account",
          "🤖 Telegram trading",
          "◀ Back",
        ],
      );

      const notificationPreferences = {
        bridgeUpdates: true,
        depositReceived: true,
        orderFilled: true,
        orderIssues: false,
        payoutsRewards: false,
        positionResolved: true,
        positionSignals: true,
        reachable: true,
        userId: "user-1",
      };
      const notifications = buildSignalBotMenuScreen({
        appBaseUrl: "https://app.hunch.trade",
        isAdmin: false,
        miniAppEnabled: true,
        notificationPreferences,
        screen: "notifications",
      });
      const notificationButtons = notifications.keyboard.inline_keyboard.flat();
      assert.deepEqual(
        notificationButtons.map((button) => button.text),
        [
          "📈 Trading · 2/3 on",
          "💰 Funds & payouts · 2/3 on",
          "◀ Back",
          "🏠 Home",
        ],
      );

      const trading = buildSignalBotMenuScreen({
        appBaseUrl: "https://app.hunch.trade",
        isAdmin: false,
        miniAppEnabled: true,
        notificationPreferences,
        screen: "notification_trading",
      });
      assert.equal(
        trading.keyboard.inline_keyboard
          .flat()
          .some(
            (button) =>
              "callback_data" in button &&
              button.callback_data === "hm:v1:ntf:fill:off",
          ),
        true,
      );

      const funds = buildSignalBotMenuScreen({
        appBaseUrl: "https://app.hunch.trade",
        isAdmin: false,
        miniAppEnabled: true,
        notificationPreferences,
        screen: "notification_funds",
      });
      assert.deepEqual(
        funds.keyboard.inline_keyboard.flat().map((button) => button.text),
        [
          "✅ Deposits received",
          "✅ Bridge results",
          "⬜ Payouts & rewards",
          "◀ Back",
          "🏠 Home",
        ],
      );

      const signals = buildSignalBotMenuScreen({
        appBaseUrl: "https://app.hunch.trade",
        isAdmin: false,
        miniAppEnabled: true,
        notificationPreferences,
        screen: "signals",
      });
      assert.equal(
        signals.keyboard.inline_keyboard.flat()[0]?.text,
        "✅ Signals for markets I hold",
      );

      const account = buildSignalBotMenuScreen({
        appBaseUrl: "https://app.hunch.trade",
        isAdmin: false,
        miniAppEnabled: true,
        notificationPreferences,
        screen: "account",
      });
      assert.match(account.text, /Hunch account: Linked/);
      assert.deepEqual(
        account.keyboard.inline_keyboard
          .flat()
          .slice(0, 2)
          .map((button) => button.text),
        ["Manage account", "Manage wallets"],
      );

      const unlinked = buildSignalBotMenuScreen({
        appBaseUrl: "https://app.hunch.trade",
        isAdmin: false,
        miniAppEnabled: true,
        notificationPreferences: null,
        screen: "notifications",
      });
      assert.match(unlinked.text, /Connect this Telegram account/);
      assert.equal(
        unlinked.keyboard.inline_keyboard
          .flat()
          .some((button) => button.text === "Open Hunch"),
        true,
      );
    },
  },
  {
    name: "guest and unavailable home screens remain distinct and Mini App-only",
    run: () => {
      const guest = buildSignalBotMenuScreen({
        appBaseUrl: "https://app.hunch.trade",
        audience: "guest",
        isAdmin: false,
        miniAppEnabled: true,
        screen: "home",
      });
      const guestButtons = guest.keyboard.inline_keyboard.flat();
      assert.match(guest.text, /Welcome to Hunch/);
      assert.match(guest.text, /create an account or sign in/);
      assert.equal(guestButtons.length, 1);
      assert.equal(guestButtons[0]?.text, "Open Hunch · Create or sign in");
      assert.equal(guestButtons[0] && "web_app" in guestButtons[0], true);
      assert.equal(
        guestButtons.some((button) => "callback_data" in button),
        false,
      );

      const unavailable = buildSignalBotMenuScreen({
        appBaseUrl: "https://app.hunch.trade",
        audience: "unavailable",
        isAdmin: false,
        miniAppEnabled: true,
        screen: "home",
      });
      assert.match(
        unavailable.text,
        /Account status is temporarily unavailable/,
      );
      assert.doesNotMatch(unavailable.text, /create an account or sign in/);
      assert.equal(unavailable.keyboard.inline_keyboard.flat().length, 1);

      const missingMiniApp = buildSignalBotMenuScreen({
        appBaseUrl: "https://app.hunch.trade",
        audience: "guest",
        isAdmin: false,
        miniAppEnabled: false,
        screen: "home",
      });
      assert.equal(missingMiniApp.keyboard.inline_keyboard.flat().length, 0);
      assert.match(missingMiniApp.text, /Mini App is temporarily unavailable/);
      assert.doesNotMatch(
        JSON.stringify(missingMiniApp.keyboard),
        /https:\/\/app\.hunch\.trade/,
      );
    },
  },
  {
    name: "Telegram UI configuration registers scoped commands and Mini App menu button",
    run: async () => {
      const commandCalls: Array<
        Parameters<TelegramBotApiClient["setMyCommands"]>[0]
      > = [];
      const menuCalls: Array<
        Parameters<TelegramBotApiClient["setChatMenuButton"]>[0]
      > = [];
      await configureSignalBotTelegramUi({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "456,123",
          HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE:
            "https://t.me/hunch_bot/hunch",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        telegram: {
          setChatMenuButton: async (input) => {
            menuCalls.push(input);
          },
          setMyCommands: async (input) => {
            commandCalls.push(input);
          },
        },
      });
      assert.equal(commandCalls.length, 3);
      assert.deepEqual(commandCalls[0]?.scope, { type: "all_private_chats" });
      assert.deepEqual(
        commandCalls[0]?.commands.map((command) => command.command),
        ["start", "menu", "settings", "help"],
      );
      assert.deepEqual(commandCalls[1]?.scope, {
        chat_id: 123,
        type: "chat",
      });
      assert.equal(
        commandCalls[1]?.commands.some(
          (command) => command.command === "enable_signals",
        ),
        true,
      );
      assert.deepEqual(menuCalls, [
        {
          menu_button: {
            text: "Open Hunch",
            type: "web_app",
            web_app: { url: "https://app.hunch.trade/tg" },
          },
        },
      ]);
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
    name: "Telegram activity notifications render market context and Mini App action",
    run: () => {
      const order = buildTelegramActivityNotificationMessage({
        market: {
          eventId: "polymarket:event-1",
          marketId: "polymarket:market-1",
          side: "YES",
          title: "Fed decision in July?",
        },
        miniAppLinkBase: "https://t.me/hunch_bot/hunch",
        payload: {
          body: "Polymarket order",
          data: { action: "BUY", price: 0.62, size: 100 },
          title: "Order filled",
          type: "order_filled",
        },
      });
      assert.ok(order);
      assert.match(order.text, /Order filled/);
      assert.match(order.text, /Fed decision in July/);
      assert.match(order.text, /100 shares at 62¢/);
      assert.match(order.text, /Estimated spend: \$62/);
      const orderButton = order.keyboard?.inline_keyboard.flat()[0];
      assert.ok(orderButton && "url" in orderButton);
      assert.match(orderButton.url ?? "", /^https:\/\/t\.me\/hunch_bot\/hunch/);

      const resolved = buildTelegramActivityNotificationMessage({
        market: {
          eventId: "polymarket:event-1",
          marketId: "polymarket:market-1",
          side: "YES",
          title: "Fed decision in July?",
        },
        miniAppLinkBase: "https://t.me/hunch_bot/hunch",
        payload: {
          body: "Claim available",
          data: {
            outcomeSide: "YES",
            resolvedOutcome: "YES",
            result: "won",
          },
          title: "Position resolved (win)",
          type: "position_resolved",
        },
      });
      assert.ok(resolved);
      assert.match(resolved.text, /Your YES position won/);
      assert.match(resolved.text, /Resolved outcome: YES/);
      assert.equal(
        resolved.keyboard?.inline_keyboard.flat()[0]?.text,
        "View position",
      );

      const deposit = buildTelegramActivityNotificationMessage({
        market: null,
        miniAppLinkBase: "https://t.me/hunch_bot/hunch",
        payload: {
          body: "250 USDC deposit received on Polygon",
          data: {
            amountLabel: "250 USDC",
            network: "polygon",
          },
          title: "Deposit received",
          type: "deposit_received",
        },
      });
      assert.ok(deposit);
      assert.match(deposit.text, /Deposit received/);
      assert.match(deposit.text, /250 USDC deposit received on Polygon/);
      assert.equal(deposit.keyboard, undefined);

      const bridge = buildTelegramActivityNotificationMessage({
        market: null,
        miniAppLinkBase: null,
        payload: {
          body: "deBridge Base → Polygon",
          data: { status: "refunded" },
          title: "Bridge refunded",
          type: "bridge_refunded",
        },
      });
      assert.ok(bridge);
      assert.match(bridge.text, /Bridge refunded/);
      assert.match(bridge.text, /Base → Polygon/);

      const reward = buildTelegramActivityNotificationMessage({
        market: null,
        miniAppLinkBase: null,
        payload: {
          body: "$12.00 on Base",
          data: { amountUsd: 12, status: "confirmed" },
          title: "Cashback paid out",
          type: "reward_claim_confirmed",
        },
      });
      assert.ok(reward);
      assert.match(reward.text, /Cashback paid out/);
      assert.match(reward.text, /\$12\\\.00 on Base/);
    },
  },
  {
    name: "Telegram notification outbox enqueues unseen events and records delivery",
    run: async () => {
      const enqueueQueries: string[] = [];
      const enqueued = await enqueueTelegramActivityNotifications({
        pool: {
          connect: async () => ({
            query: async (sql: string) => {
              enqueueQueries.push(sql);
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
                  rows: [
                    {
                      enqueued: 1,
                      last_created_at: "2026-01-01T00:00:01.000Z",
                      last_id: "00000000-0000-4000-8000-000000000001",
                    },
                  ],
                };
              }
              return { rows: [] };
            },
            release: () => undefined,
          }),
        } as never,
      });
      assert.equal(enqueued, 1);
      const enqueueSql = enqueueQueries.find((sql) =>
        sql.includes("with candidates as materialized"),
      );
      assert.match(enqueueSql ?? "", /telegram_notification_outbox/);
      assert.match(enqueueSql ?? "", /n\.created_at >= preference/);
      assert.doesNotMatch(enqueueSql ?? "", /n\.updated_at/);
      assert.match(enqueueSql ?? "", /position_resolved_enabled_at/);
      assert.match(enqueueSql ?? "", /deposit_received_enabled_at/);
      assert.match(enqueueSql ?? "", /bridge_updates_enabled_at/);
      assert.match(enqueueSql ?? "", /payouts_rewards_enabled_at/);

      const updates: string[] = [];
      const sentMessages: TelegramSendMessageInput[] = [];
      const payload = {
        body: "Polymarket YES 10 @ $0.55",
        data: {
          marketId: "polymarket:market-1",
          price: 0.55,
          size: 10,
          tokenId: "token-yes",
          venue: "polymarket",
        },
        title: "Order filled",
        type: "order_filled",
      };
      const result = await deliverTelegramNotificationOutbox({
        db: {
          query: async (sql: string) => {
            if (sql.includes("with candidates")) {
              return {
                rows: [
                  {
                    attempt_count: 1,
                    id: "outbox-1",
                    payload,
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
                    enabled_since_event: true,
                    reachable: true,
                    telegram_user_id: "999",
                  },
                ],
              };
            }
            if (sql.includes("from unified_markets market")) {
              return {
                rows: [
                  {
                    event_id: "polymarket:event-1",
                    market_id: "polymarket:market-1",
                    side: "YES",
                    title: "Fed decision in July?",
                  },
                ],
              };
            }
            updates.push(sql);
            return { rows: [] };
          },
        } as never,
        miniAppLinkBase: "https://t.me/hunch_bot/hunch",
        telegram: {
          sendMessage: async (message) => {
            sentMessages.push(message);
            return { messageId: 700, ok: true };
          },
        },
      });
      assert.deepEqual(result, {
        blocked: 0,
        claimed: 1,
        deferred: 0,
        failed: 0,
        sent: 1,
        skipped: 0,
      });
      assert.equal(sentMessages[0]?.chat_id, "999");
      assert.match(sentMessages[0]?.text ?? "", /Order filled/);
      assert.equal(
        updates.some((sql) => /status = 'sent'/.test(sql)),
        true,
      );
    },
  },
  {
    name: "blocked Telegram delivery disables only the notification channel",
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
                    id: "outbox-blocked",
                    payload: {
                      body: "Claim available",
                      data: { result: "won" },
                      title: "Position resolved (win)",
                      type: "position_resolved",
                    },
                    topic: "position_resolved",
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
                    enabled_since_event: true,
                    reachable: true,
                    telegram_user_id: "999",
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
          sendMessage: async () => ({
            error: "blocked_or_missing",
            message: "bot was blocked by the user",
            ok: false,
          }),
        },
      });
      assert.equal(result.blocked, 1);
      assert.equal(
        updates.some(
          (sql) =>
            /telegram_notification_preferences/.test(sql) &&
            /reachable = false/.test(sql),
        ),
        true,
      );
      assert.equal(
        updates.some(
          (sql) =>
            /telegram_notification_outbox/.test(sql) &&
            /status = 'dead'/.test(sql),
        ),
        true,
      );
    },
  },
  {
    name: "position signal fan-out targets exact owned markets and records relationship copy",
    run: async () => {
      const insertedEventKeys: string[] = [];
      const insertedPayloads: unknown[] = [];
      const client = {
        query: async (sql: string, params: unknown[] = []) => {
          if (/^\s*(?:begin|commit|rollback)\s*$/i.test(sql)) {
            return { rows: [] };
          }
          if (sql.includes("insert into telegram_notification_cursors")) {
            return {
              rows: [
                {
                  cursor_created_at: "2025-12-31T00:00:00.000Z",
                  cursor_id: "00000000-0000-0000-0000-000000000000",
                },
              ],
            };
          }
          if (sql.includes("from ai_notes n")) {
            return { rows: [noteRow()] };
          }
          if (sql.includes("from positions p")) {
            assert.match(sql, /ut\.market_id = \$1/);
            assert.match(sql, /p\.position_scope = 'own'/);
            assert.match(sql, /p\.size > 0/);
            assert.match(sql, /root_delivery\.status = 'sent'/);
            assert.match(sql, /root_delivery\.telegram_message_id is not null/);
            return { rows: [{ held_sides: ["YES"], user_id: "user-1" }] };
          }
          if (sql.includes("insert into telegram_notification_outbox")) {
            insertedEventKeys.push(String(params[1]));
            insertedPayloads.push(JSON.parse(String(params[4])));
            return { rows: [{ id: "outbox-signal-1" }] };
          }
          if (sql.includes("update telegram_notification_cursors")) {
            return { rows: [] };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
        release: () => undefined,
      };
      const result = await enqueueTelegramPositionSignals({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE:
            "https://t.me/hunch_bot/hunch",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        pool: { connect: async () => client } as never,
      });
      assert.deepEqual(result, { enqueued: 1, notes: 1 });
      assert.match(
        String((insertedPayloads[0] as { text?: unknown })?.text ?? ""),
        /supports your YES position/,
      );
      assert.match(
        String((insertedPayloads[0] as { text?: unknown })?.text ?? ""),
        /^\*💰 \$12\\\.3K backs YES on /,
      );
      assert.doesNotMatch(
        String((insertedPayloads[0] as { text?: unknown })?.text ?? ""),
        /New signal|Research update for a market/,
      );
      assert.equal(
        (insertedPayloads[0] as { actionText?: unknown })?.actionText,
        "Review position",
      );
      assert.equal(
        (insertedPayloads[0] as { messageKind?: unknown })?.messageKind,
        "initial",
      );
      assert.equal(
        insertedEventKeys[0],
        "position-signal:00000000-0000-4000-8000-000000000001:initial:00000000-0000-4000-8000-000000000001",
      );
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
    name: "Telegram client configures and reads command and menu button metadata",
    run: async () => {
      const originalFetch = globalThis.fetch;
      try {
        const seen: Array<{ body: unknown; url: string }> = [];
        const responses = [
          new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          }),
          new Response(
            JSON.stringify({
              ok: true,
              result: [{ command: "menu", description: "Open menu" }],
            }),
            { status: 200 },
          ),
          new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          }),
        ];
        globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
          seen.push({
            body: JSON.parse(String(args[1]?.body ?? "{}")),
            url: String(args[0]),
          });
          return responses.shift() ?? new Response("{}", { status: 500 });
        }) as typeof fetch;
        const client = new TelegramBotApiClient("token");
        await client.setMyCommands({
          commands: [{ command: "menu", description: "Open menu" }],
          scope: { type: "all_private_chats" },
        });
        assert.deepEqual(
          await client.getMyCommands({
            scope: { type: "all_private_chats" },
          }),
          [{ command: "menu", description: "Open menu" }],
        );
        await client.setChatMenuButton({
          menu_button: {
            text: "Open Hunch",
            type: "web_app",
            web_app: { url: "https://app.hunch.trade/tg" },
          },
        });
        assert.deepEqual(
          seen.map((entry) => new URL(entry.url).pathname.split("/").at(-1)),
          ["setMyCommands", "getMyCommands", "setChatMenuButton"],
        );
        assert.deepEqual(seen[0]?.body, {
          commands: [{ command: "menu", description: "Open menu" }],
          scope: { type: "all_private_chats" },
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
              executionOffers: {
                no: null,
                yes: {
                  ask: 0.32,
                  asOf: "2026-01-01T00:00:00.000Z",
                  fresh: true,
                  nativeOutcome: "YES",
                },
              },
              marketId: "kalshi:market-1",
              outcomeMapping: {
                confidence: 1,
                method: "exact_title",
                sourceYesTo: "YES",
              },
              venue: "kalshi",
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
              executionOffers: {
                no: null,
                yes: {
                  ask: 0.29,
                  asOf: "2026-01-01T00:00:00.000Z",
                  fresh: true,
                  nativeOutcome: "YES",
                },
              },
              marketId: "kalshi:market-1",
              outcomeMapping: {
                confidence: 1,
                method: "exact_title",
                sourceYesTo: "YES",
              },
              venue: "kalshi",
            },
          ] as never,
          status: "matched",
        },
      });
      assert.equal(cheaper.alternative?.marketId, "kalshi:market-1");
      assert.equal(cheaper.diagnostics.aggMatched, 1);
      assert.equal(cheaper.diagnostics.aggCheaperFound, 1);

      const inverted = resolveSignalBotCheaperAlternativeFromAggResponse({
        buySide: "YES",
        note: note({ bestAsk: 0.32 }),
        response: {
          alternatives: [
            {
              eventId: "limitless:event-1",
              executionOffers: {
                no: null,
                yes: {
                  ask: 0.28,
                  asOf: "2026-01-01T00:00:00.000Z",
                  fresh: true,
                  nativeOutcome: "NO",
                },
              },
              marketId: "limitless:market-1",
              outcomeMapping: {
                confidence: 0.98,
                method: "selected_participant",
                sourceYesTo: "NO",
              },
              venue: "limitless",
            },
          ] as never,
          status: "matched",
        },
      });
      assert.equal(inverted.alternative?.side, "NO");
      assert.equal(inverted.alternative?.price, 0.28);
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
      assert.equal(parseSignalBotCommand("/menu", null), "menu");
      assert.equal(parseSignalBotCommand("/settings", null), "settings");
      assert.equal(parseSignalBotCommand("hello", "HunchSignalBot"), null);
    },
  },
  {
    name: "Telegram notification preferences bind to linked users and set topics idempotently",
    run: async () => {
      let orderFilled = true;
      const queries: Array<{ params: unknown[]; sql: string }> = [];
      const db = {
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ params, sql });
          if (sql.includes("update telegram_notification_preferences")) {
            orderFilled = params[1] === true;
          }
          return {
            rows: [
              {
                bridge_updates: true,
                deposit_received: true,
                order_filled: orderFilled,
                order_issues: true,
                payouts_rewards: true,
                position_resolved: true,
                position_signals: true,
                reachable: true,
                user_id: "user-1",
              },
            ],
          };
        },
      } as never;
      const preferences = await ensureTelegramNotificationPreferences({
        db,
        markStarted: true,
        telegramUserId: 999,
      });
      assert.equal(preferences?.orderFilled, true);
      assert.match(queries[0]?.sql ?? "", /user_telegram_accounts/);
      assert.deepEqual(queries[0]?.params, ["999", true]);

      const updated = await setTelegramNotificationTopic({
        db,
        enabled: false,
        telegramUserId: 999,
        topic: "order_filled",
      });
      assert.equal(updated?.orderFilled, false);
      assert.match(
        queries.at(-1)?.sql ?? "",
        /order_filled_enabled_at[\s\S]+order_filled = \$2::boolean/,
      );
      assert.deepEqual(queries.at(-1)?.params, ["user-1", false]);

      const repeated = await setTelegramNotificationTopic({
        db,
        enabled: false,
        telegramUserId: 999,
        topic: "order_filled",
      });
      assert.equal(repeated?.orderFilled, false);
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
          expected: /Telegram trading disabled/,
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
            HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE:
              "https://t.me/hunch_bot/app",
            HUNCH_SIGNAL_BOT_TOKEN: "token",
          }),
          db: {
            query: async () => ({ rows: [{ linked: true }] }),
          } as never,
          disableTrading: async () => testCase.result,
          message: {
            chat: { id: 999, first_name: "Kreedle", type: "private" },
            from: { id: 123 },
            text: "/disable_trading",
          },
          redis,
          sendMessage: (message) => telegram.sendMessage(message),
          sendTestSignal: async () => false,
        });
        assert.equal(handled, true);
        assert.match(telegram.messages[0]?.text ?? "", testCase.expected);
        if (testCase.result !== "unavailable") {
          assert.equal(
            telegram.messages[0]?.reply_markup?.inline_keyboard[0]?.[0]?.text,
            "Revoke access in Hunch",
          );
          assert.match(
            telegram.messages[0]?.reply_markup?.inline_keyboard[0]?.[0]?.web_app
              ?.url ?? "",
            /\/settings\/telegram-trading$/,
          );
        }
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
        await assert.rejects(() => client.buildStatusMessage(999), /timed out/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
  {
    name: "internal trading client preserves Mini App mode for position cards",
    run: async () => {
      const originalFetch = globalThis.fetch;
      let requestBody: Record<string, unknown> | null = null;
      globalThis.fetch = (async (_input, init) => {
        requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        return new Response(JSON.stringify({ text: "Position" }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;
      try {
        const client = createTelegramBotTradingInternalApiClient({
          baseUrl: "https://api.hunch.trade",
          token: "token",
        });
        await client.buildPositionMessage({
          appBaseUrl: "https://app.hunch.trade",
          positionId: "00000000-0000-4000-8000-000000000001",
          telegramMiniAppEnabled: true,
          telegramUserId: 999,
        });
        assert.deepEqual(requestBody, {
          appBaseUrl: "https://app.hunch.trade",
          telegramMiniAppEnabled: true,
          telegramUserId: 999,
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
  {
    name: "internal trading client records a successful terminal edit receipt",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const requests: Array<{ body: unknown; url: string }> = [];
      let terminalEdit: {
        reply_markup?: { inline_keyboard: Array<Array<{ text: string }>> };
      } | null = null;
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        requests.push({
          body: init?.body ? JSON.parse(String(init.body)) : null,
          url,
        });
        const payload = url.endsWith("/receipt")
          ? { marked: true }
          : {
              answers: [],
              handled: true,
              messages: [
                {
                  chat_id: "999",
                  parse_mode: "MarkdownV2",
                  text: "Trade filled\\.",
                },
              ],
            };
        return new Response(JSON.stringify(payload), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        });
      }) as typeof fetch;
      try {
        const client = createTelegramBotTradingInternalApiClient({
          baseUrl: "https://api.hunch.trade",
          token: "token",
        });
        const handled = await client.handleCallback({
          answerCallbackQuery: async () => ({ ok: true }),
          appBaseUrl: "https://app.hunch.trade",
          callbackQuery: {
            data: "hbt:confirm:00000000-0000-4000-8000-000000000001",
            from: { id: 999 },
            id: "callback-receipt",
            message: {
              chat: { id: 999, type: "private" },
              message_id: 77,
            },
          },
          editMessageText: async (message) => {
            terminalEdit = message;
            return { messageId: 77, ok: true };
          },
          sendMessage: async () => ({ messageId: 78, ok: true }),
        });
        assert.equal(handled, true);
        assert.equal(requests.length, 2);
        assert.match(requests[1]?.url ?? "", /\/receipt$/);
        assert.deepEqual(requests[1]?.body, {
          delivery: "edit",
          messageId: 77,
          telegramUserId: 999,
        });
        assert.match(JSON.stringify(terminalEdit), /My positions/);
        assert.match(JSON.stringify(terminalEdit), /Home/);
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
        assert.equal(answers[0]?.showAlert, undefined);
        assert.equal(answers[0]?.text, "Processing trade…");
        assert.match(messages[0]?.text ?? "", /checking automatically/i);
        assert.match(messages[0]?.text ?? "", /do not retry this market/i);
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
        publicBrowseOnly?: boolean;
        telegramMessageId?: number | null;
        telegramUserId: number;
      } | null = null;
      const handled = await handleSignalBotCommand({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db: {
          query: async () => ({ rows: [{ linked: true }] }),
        } as never,
        message: {
          chat: { id: 999, first_name: "Kreedle", type: "private" },
          from: { id: 123 },
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
        publicBrowseOnly: false,
        telegramMessageId: 12,
        telegramUserId: 123,
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
          from: { id: 123 },
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
          if (
            sql.includes("FROM telegram_bot_trading_authorizations") &&
            sql.includes("SELECT enabled")
          ) {
            return { rowCount: 1, rows: [{ enabled: true }] };
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
        signerInspector: readyTelegramSignerInspector,
        telegramMiniAppEnabled: true,
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
        buttons.some((button) => "web_app" in button),
        true,
      );

      const publicMessage = await buildTelegramBotTradingMarketMessage({
        appBaseUrl: "https://app.hunch.trade",
        chatId: "999",
        db: db as never,
        marketRef: "market-1",
        publicBrowseOnly: true,
        signerInspector: readyTelegramSignerInspector,
        telegramMiniAppEnabled: true,
        telegramUserId: 999,
      });
      assert.match(publicMessage.text, /create an account or sign in/);
      assert.doesNotMatch(publicMessage.text, /Buttons valid/);
      const publicButtons =
        publicMessage.reply_markup?.inline_keyboard.flat() ?? [];
      assert.deepEqual(
        publicButtons.map((button) => button.text),
        ["Open Hunch · Create or sign in"],
      );
      assert.equal(
        publicButtons.some((button) => "callback_data" in button),
        false,
      );
      assert.equal(insertCount, 0);
    },
  },
  {
    name: "market card offers buys only when readiness is executable or auto-repairable",
    run: async () => {
      let insertCount = 0;
      let marketOrderable = true;
      let marketVenue = "polymarket";
      let readinessMode: "auto" | "disabled" = "disabled";
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
                  venue: marketVenue,
                  venue_market_id: "venue-market-1",
                  event_id: "event-1",
                  event_title: "Event",
                  title: "Market",
                  status: marketOrderable ? "ACTIVE" : "CLOSED",
                  accepting_orders: marketOrderable,
                  outcomes: JSON.stringify(["YES", "NO"]),
                  metadata: {},
                  close_time: new Date(
                    Date.now() + (marketOrderable ? 60_000 : -60_000),
                  ),
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
            return { rowCount: 1, rows: [] };
          }
          return { rowCount: 0, rows: [] };
        },
      };
      const message = await buildTelegramBotTradingMarketMessage({
        appBaseUrl: "https://app.hunch.trade",
        chatId: "999",
        db: db as never,
        marketRef: "market-1",
        signerInspector: readyTelegramSignerInspector,
        telegramMiniAppEnabled: true,
        telegramUserId: 999,
        trading: {
          quote: async ({ intent }: { intent: TradeIntent }) =>
            buildTestTelegramQuote(intent),
          getReadiness: async () =>
            readinessMode === "disabled"
              ? buildTestPolymarketReadiness({
                  code: "unsupported_capability",
                  message: "Direct bot trading is disabled for this venue.",
                })
              : buildTestPolymarketReadiness({
                  code: "polymarket_approvals_missing",
                  message: "Polymarket setup approvals are missing.",
                  repairKind: "auto",
                  sideEffect: "approval",
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
        buttons.some((button) => "web_app" in button),
        true,
      );

      readinessMode = "auto";
      const repairableMessage = await buildTelegramBotTradingMarketMessage({
        appBaseUrl: "https://app.hunch.trade",
        chatId: "999",
        db: db as never,
        marketRef: "market-1",
        signerInspector: readyTelegramSignerInspector,
        telegramMiniAppEnabled: true,
        telegramUserId: 999,
        trading: {
          quote: async ({ intent }: { intent: TradeIntent }) =>
            buildTestTelegramQuote(intent),
          getReadiness: async () =>
            readinessMode === "auto"
              ? buildTestPolymarketReadiness({
                  code: "polymarket_approvals_missing",
                  message: "Polymarket setup approvals are missing.",
                  repairKind: "auto",
                  sideEffect: "approval",
                })
              : ({} as never),
        } as never,
      });
      assert.equal(insertCount, 2);
      const repairableButtons =
        repairableMessage.reply_markup?.inline_keyboard.flat() ?? [];
      assert.equal(
        repairableButtons.filter((button) => "callback_data" in button).length,
        2,
      );
      assert.match(repairableMessage.text, /Buttons valid for 2 minutes/);
      assert.match(
        repairableButtons.find((button) => "callback_data" in button)?.text ??
          "",
        /Buy YES · 50¢ · Spend \$10/,
      );
      assert.doesNotMatch(repairableMessage.text, /approvals are missing/);

      const unfundedMessage = await buildTelegramBotTradingMarketMessage({
        appBaseUrl: "https://app.hunch.trade",
        chatId: "999",
        db: db as never,
        marketRef: "market-1",
        signerInspector: readyTelegramSignerInspector,
        telegramMiniAppEnabled: true,
        telegramUserId: 999,
        trading: {
          quote: async ({ intent }: { intent: TradeIntent }) =>
            buildTestTelegramQuote(intent),
          getReadiness: async () => ({
            ...buildTestPolymarketReadiness({
              code: "no_executable_funds",
              message: "Deposit funds to continue.",
            }),
            maxExecutableBuyUsd: 0,
            raw: {
              controlledFundsRaw: "0",
              kind: "polymarket_funds_v1",
            },
          }),
        } as never,
      });
      const unfundedButtons =
        unfundedMessage.reply_markup?.inline_keyboard.flat() ?? [];
      assert.equal(
        unfundedButtons.filter((button) => "callback_data" in button).length,
        2,
      );
      assert.match(
        unfundedButtons.find((button) => "callback_data" in button)?.text ?? "",
        /Buy YES/,
      );
      assert.match(unfundedMessage.text, /Buttons valid/);

      marketOrderable = false;
      const closedMessage = await buildTelegramBotTradingMarketMessage({
        appBaseUrl: "https://app.hunch.trade",
        chatId: "999",
        db: db as never,
        marketRef: "market-1",
        signerInspector: readyTelegramSignerInspector,
        telegramMiniAppEnabled: true,
        telegramUserId: 999,
        trading: {
          getReadiness: async () =>
            buildTestPolymarketReadiness({ executable: true }),
        } as never,
      });
      assert.equal(insertCount, 4);
      assert.equal(
        closedMessage.reply_markup?.inline_keyboard
          .flat()
          .some((button) => "callback_data" in button),
        false,
      );
      assert.match(closedMessage.text, /not open for new bot trades/i);

      marketOrderable = true;
      marketVenue = "limitless";
      const appFallbackMessage = await buildTelegramBotTradingMarketMessage({
        appBaseUrl: "https://app.hunch.trade",
        chatId: "999",
        db: db as never,
        marketRef: "market-1",
        signerInspector: readyTelegramSignerInspector,
        telegramMiniAppEnabled: true,
        telegramUserId: 999,
        trading: {
          getReadiness: async () =>
            buildTestPolymarketReadiness({
              code: "unsupported_capability",
              message: "Direct bot trading is disabled for this venue.",
            }),
        } as never,
      });
      assert.doesNotMatch(
        appFallbackMessage.text,
        /venue is disabled by runtime policy/i,
      );
      assert.match(
        appFallbackMessage.text,
        /Direct bot trading is not enabled for Limitless/i,
      );
      const appFallbackButtons =
        appFallbackMessage.reply_markup?.inline_keyboard.flat() ?? [];
      assert.equal(
        appFallbackButtons.some((button) => "callback_data" in button),
        false,
      );
      assert.deepEqual(
        appFallbackButtons.map((button) => button.text),
        ["Buy YES · $10", "Buy NO · $10", "Trade in Hunch"],
      );
      assert.equal(
        appFallbackButtons.some((button) => "url" in button),
        false,
      );
      assert.equal(
        decodeStartAppPayload(readWebAppStartParam(appFallbackButtons[0])),
        "event-1|market-1|Y|10",
      );
      assert.equal(
        decodeStartAppPayload(readWebAppStartParam(appFallbackButtons[1])),
        "event-1|market-1|N|10",
      );
      assert.equal(
        decodeStartAppPayload(readWebAppStartParam(appFallbackButtons[2])),
        "event-1|market-1|",
      );
    },
  },
  {
    name: "market card suppresses live buy callbacks while an existing trade resolves",
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
          if (sql.includes("FROM telegram_trade_intents tti")) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: "intent-existing",
                  side: "YES",
                  status: "executing",
                  error_code: null,
                },
              ],
            };
          }
          if (sql.includes("INSERT INTO telegram_trade_intents")) {
            insertCount += 1;
            throw new Error("unresolved trade should not insert intents");
          }
          return { rowCount: 0, rows: [] };
        },
      };
      const message = await buildTelegramBotTradingMarketMessage({
        appBaseUrl: "https://app.hunch.trade",
        chatId: "999",
        db: db as never,
        marketRef: "market-1",
        signerInspector: readyTelegramSignerInspector,
        telegramMiniAppEnabled: true,
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
      assert.match(message.text, /Existing trade is still resolving/);
      const buttons = message.reply_markup?.inline_keyboard.flat() ?? [];
      assert.equal(
        buttons.some((button) => "callback_data" in button),
        false,
      );
    },
  },
  {
    name: "market card suppresses live buy callbacks when buy presets are empty",
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
                    buyAmountPresetsUsd: [],
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
            throw new Error("empty presets should not insert intents");
          }
          return { rowCount: 0, rows: [] };
        },
      };
      const message = await buildTelegramBotTradingMarketMessage({
        appBaseUrl: "https://app.hunch.trade",
        chatId: "999",
        db: db as never,
        marketRef: "market-1",
        signerInspector: readyTelegramSignerInspector,
        telegramMiniAppEnabled: true,
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
      assert.match(message.text, /No bot buy presets are configured/);
      const buttons = message.reply_markup?.inline_keyboard.flat() ?? [];
      assert.equal(
        buttons.some((button) => "callback_data" in button),
        false,
      );
      assert.equal(
        buttons.some((button) => "web_app" in button),
        true,
      );
    },
  },
  {
    name: "polling routes menu callbacks before trading callbacks",
    run: async () => {
      const redis = new FakeRedis();
      const telegram = new FakeTelegram();
      telegram.updates = [
        {
          callback_query: {
            data: "hm:v1:help",
            from: { id: 999 },
            id: "menu-help",
            message: {
              chat: { id: 999, type: "private" },
              message_id: 71,
            },
          },
          update_id: 90,
        },
      ];
      let tradingCallbackCalls = 0;
      const handled = await pollSignalBotCommands({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db: {
          query: async () => ({ rows: [{ linked: true }] }),
        } as never,
        handleCallback: async () => {
          tradingCallbackCalls += 1;
          return true;
        },
        redis,
        sendTestSignal: async () => false,
        telegram,
      });
      assert.equal(handled, 1);
      assert.equal(tradingCallbackCalls, 0);
      assert.equal(telegram.callbackAnswers.length, 1);
      assert.match(telegram.edits[0]?.text ?? "", /How Hunch works/);
      assert.equal(await readSignalBotUpdateOffset(redis), 91);
    },
  },
  {
    name: "idle private text always enters market search",
    run: async () => {
      const redis = new FakeRedis();
      const telegram = new FakeTelegram();
      telegram.updates = [
        {
          message: {
            chat: { id: 999, type: "private" },
            from: { id: 999 },
            text: "hello?",
          },
          update_id: 95,
        },
      ];
      const handled = await pollSignalBotCommands({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        redis,
        sendTestSignal: async () => false,
        telegram,
      });
      assert.equal(handled, 1);
      assert.match(telegram.messages[0]?.text ?? "", /Searching/);
      assert.match(
        telegram.edits[0]?.text ?? "",
        /Search is temporarily unavailable/,
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
    name: "long confirm callbacks do not block later Telegram updates",
    run: async () => {
      const redis = new FakeRedis();
      const telegram = new FakeTelegram();
      telegram.updates = [
        {
          callback_query: {
            data: "hbt:confirm:00000000-0000-4000-8000-000000000001",
            from: { id: 999 },
            id: "callback-confirm",
          },
          update_id: 100,
        },
        {
          message: {
            chat: { id: 999, type: "private" },
            from: { id: 123 },
            message_id: 2,
            text: "/trade_status",
          },
          update_id: 101,
        },
      ];
      let resolveConfirm!: (value: boolean) => void;
      let statusCalls = 0;
      const confirm = new Promise<boolean>((resolve) => {
        resolveConfirm = resolve;
      });
      const handled = await pollSignalBotCommands({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db: {
          query: async () => ({ rows: [{ linked: true }] }),
        } as never,
        handleCallback: async () => confirm,
        redis,
        sendTestSignal: async () => false,
        sendTradeStatus: async () => {
          statusCalls += 1;
          return true;
        },
        telegram,
      });
      assert.equal(handled, 2);
      assert.equal(statusCalls, 1);
      assert.equal(await readSignalBotUpdateOffset(redis), 102);
      resolveConfirm(true);
      assert.equal(await drainSignalBotConfirmTasks(1_000), true);
    },
  },
  {
    name: "confirm callback pool rejects overflow without running the intent",
    run: async () => {
      const redis = new FakeRedis();
      const telegram = new FakeTelegram();
      telegram.updates = Array.from({ length: 5 }, (_, index) => ({
        callback_query: {
          data: `hbt:confirm:00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          from: { id: 999 },
          id: `callback-${index + 1}`,
        },
        update_id: 200 + index,
      }));
      const resolvers: Array<(value: boolean) => void> = [];
      let callbackRuns = 0;
      const handled = await pollSignalBotCommands({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        handleCallback: async () => {
          callbackRuns += 1;
          return new Promise<boolean>((resolve) => resolvers.push(resolve));
        },
        redis,
        sendTestSignal: async () => false,
        telegram,
      });
      assert.equal(handled, 5);
      assert.equal(callbackRuns, 4);
      assert.match(telegram.callbackAnswers.at(-1)?.text ?? "", /Bot is busy/);
      for (const resolve of resolvers) resolve(true);
      assert.equal(await drainSignalBotConfirmTasks(1_000), true);
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
            from: { id: 123 },
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
        db: {
          query: async () => ({ rows: [{ linked: true }] }),
        } as never,
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
    name: "trading internal client answers malformed prefixed callbacks",
    run: async () => {
      const telegram = new FakeTelegram();
      const client = createTelegramBotTradingInternalApiClient({
        baseUrl: "https://internal.hunch.test",
        token: "service-token",
      });
      const handled = await client.handleCallback({
        answerCallbackQuery: (input) => telegram.answerCallbackQuery(input),
        appBaseUrl: "https://app.hunch.trade",
        callbackQuery: {
          data: "hbt:buy:not-a-real-uuid",
          from: { id: 999 },
          id: "callback-1",
        },
        sendMessage: (message) => telegram.sendMessage(message as never),
      });
      assert.equal(handled, true);
      assert.deepEqual(telegram.callbackAnswers[0], {
        callbackQueryId: "callback-1",
        showAlert: true,
        text: "Trade button expired or invalid. Send /market again.",
      });
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
        backfilledExecutionRefs: 0,
        backfilledOrderRefs: 0,
        expiredPending: 2,
        failedPreSubmitExecuting: 1,
        submittedReconcileRequired: 3,
        unknownSubmitReconcileRequired: 2,
      });
      assert.match(statements[0] ?? "", /expires_at <=/);
      assert.match(statements[1] ?? "", /FROM orders o/);
      assert.match(statements[1] ?? "", /telegramIntentId/);
      assert.match(
        statements[1] ?? "",
        /order_payload->'history'->>'telegramIntentId'/,
      );
      assert.match(
        statements[1] ?? "",
        /prepared_snapshot->'reconcileKeys'->>'clientOrderId'/,
      );
      assert.match(
        statements[1] ?? "",
        /order_payload->'submitted'->'payload'->'reconcileKeys'->>'clientOrderId'/,
      );
      assert.match(statements[2] ?? "", /FROM executions e/);
      assert.match(statements[2] ?? "", /telegramIntentId/);
      assert.match(
        statements[2] ?? "",
        /e\.raw->'history'->'reconcileKeys'->>'intentId'/,
      );
      assert.match(
        statements[2] ?? "",
        /prepared_snapshot->'reconcileKeys'->>'txSignature'/,
      );
      assert.match(statements[3] ?? "", /venue_order_id IS NULL/);
      assert.match(statements[3] ?? "", /submit_started_at IS NULL/);
      assert.match(statements[4] ?? "", /status = 'reconcile_required'/);
      assert.match(statements[4] ?? "", /submit_started_at IS NOT NULL/);
      assert.match(statements[5] ?? "", /venue_order_id IS NOT NULL/);
      assert.match(statements[5] ?? "", /status = 'submitted'/);
      assert.match(statements[5] ?? "", /error_code = 'reconcile_required'/);
    },
  },
  {
    name: "venue reconciliation skips safely when its schema is unavailable",
    run: async () => {
      let connectCalls = 0;
      const db = {
        connect: async () => {
          connectCalls += 1;
          throw new Error("connect must not run");
        },
        query: async () => ({ rows: [{ ready: false }] }),
      };
      const result = await reconcileTelegramVenueIntents(
        db as never,
        {} as never,
      );
      assert.equal(result.skipped, 1);
      assert.equal(result.inspected, 0);
      assert.equal(connectCalls, 0);
    },
  },
  {
    name: "venue reconciliation yields when another sweep holds the advisory lock",
    run: async () => {
      const statements: string[] = [];
      let released = false;
      const db = {
        query: async () => ({ rows: [{ ready: true }] }),
        connect: async () => ({
          query: async (sql: string) => {
            statements.push(sql);
            return sql.includes("pg_try_advisory_xact_lock")
              ? { rows: [{ locked: false }] }
              : { rows: [] };
          },
          release: () => {
            released = true;
          },
        }),
      };
      const result = await reconcileTelegramVenueIntents(
        db as never,
        {} as never,
      );
      assert.equal(result.busy, true);
      assert.equal(result.inspected, 0);
      assert.equal(released, true);
      assert.deepEqual(statements, [
        "BEGIN",
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked",
        "ROLLBACK",
      ]);
    },
  },
  {
    name: "venue reconciliation audits a ref-less unknown without failing it",
    run: async () => {
      const statements: string[] = [];
      const db = {
        query: async () => ({ rows: [{ ready: true }] }),
        connect: async () => ({
          query: async (sql: string) => {
            statements.push(sql);
            if (sql.includes("pg_try_advisory_xact_lock")) {
              return { rows: [{ locked: true }] };
            }
            if (sql.includes("FROM telegram_trade_intents ti")) {
              return {
                rows: [
                  {
                    id: "00000000-0000-4000-8000-000000000001",
                    telegram_user_id: "999",
                    user_id: "user-1",
                    authorization_id: "authorization-1",
                    venue: "polymarket",
                    market_id: "market-1",
                    event_id: "event-1",
                    side: "YES",
                    amount_usd: "10",
                    status: "reconcile_required",
                    prepared_snapshot: {
                      authorizationMode: "embedded_privy_evm",
                      preparedId: "prepared-1",
                      reconcileKeys: {},
                      recoveryPayload: { kind: "polymarket" },
                    },
                    quote_snapshot: {},
                    venue_order_id: null,
                    tx_signature: null,
                    wallet_address:
                      "0x0000000000000000000000000000000000000001",
                    wallet_chain: "ethereum",
                    privy_user_id: "privy-1",
                    privy_wallet_id: "wallet-1",
                    limits: {},
                    venue_market_id: "venue-market-1",
                    market_title: "Market",
                    market_status: "ACTIVE",
                    outcomes: JSON.stringify(["YES", "NO"]),
                    market_metadata: {},
                  },
                ],
              };
            }
            return { rowCount: 1, rows: [] };
          },
          release: () => undefined,
        }),
      };
      const result = await reconcileTelegramVenueIntents(
        db as never,
        {} as never,
        { dryRun: false },
      );
      assert.equal(result.inspected, 1);
      assert.equal(result.skipped, 1);
      assert.equal(result.failedVerified, 0);
      assert.equal(result.items[0]?.venueState, "missing_order_hash");
      const auditUpdate = statements.find((sql) =>
        sql.includes("SET result = coalesce(result"),
      );
      assert.ok(auditUpdate);
      assert.doesNotMatch(auditUpdate, /status = 'failed'/);
    },
  },
  {
    name: "venue reconciliation releases a funding-only executing crash window for safe retry",
    run: async () => {
      const updates: Array<{ params: unknown[]; sql: string }> = [];
      const row = {
        id: "00000000-0000-4000-8000-000000000001",
        telegram_user_id: "999",
        user_id: "user-1",
        authorization_id: "authorization-1",
        venue: "polymarket",
        market_id: "market-1",
        event_id: "event-1",
        side: "YES",
        amount_usd: "1",
        status: "executing",
        prepared_snapshot: null,
        quote_snapshot: {},
        result: {
          setupTransactions: [
            {
              kind: "funding_router",
              referenceId: "hunch:tgfund:test",
              transactionId: "privy-transaction-1",
              txHash: null,
            },
          ],
        },
        venue_order_id: null,
        tx_signature: null,
        wallet_address: "0x0000000000000000000000000000000000000001",
        wallet_chain: "ethereum",
        privy_user_id: "privy-1",
        privy_wallet_id: "wallet-1",
        limits: {},
        venue_market_id: "venue-market-1",
        market_title: "Market",
        market_status: "ACTIVE",
        outcomes: JSON.stringify(["YES", "NO"]),
        market_metadata: {},
        updated_at: new Date(),
      };
      const db = {
        query: async () => ({ rows: [{ ready: true }] }),
        connect: async () => ({
          query: async (sql: string, params: unknown[] = []) => {
            if (sql.includes("pg_try_advisory_xact_lock")) {
              return { rows: [{ locked: true }] };
            }
            if (sql.includes("FROM telegram_trade_intents ti")) {
              return { rows: [row] };
            }
            if (sql.includes("UPDATE telegram_trade_intents")) {
              updates.push({ params, sql });
            }
            return { rowCount: 1, rows: [] };
          },
          release: () => undefined,
        }),
      };
      const result = await reconcileTelegramVenueIntents(
        db as never,
        {} as never,
        { dryRun: false },
        {
          inspectVenueSubmit: async () => ({
            state: "funding_confirmed",
            submitResult: null,
          }),
        },
      );
      assert.equal(result.failedVerified, 1);
      assert.equal(result.items[0]?.venueState, "funding_confirmed");
      assert.equal(updates.length, 1);
      assert.match(updates[0]?.sql ?? "", /SET status = 'failed'/);
      assert.match(updates[0]?.sql ?? "", /order_id IS NULL/);
      assert.match(updates[0]?.sql ?? "", /execution_id IS NULL/);
      assert.equal(
        updates[0]?.params[1],
        "funding_confirmed_order_not_submitted",
      );
      assert.deepEqual(updates[0]?.params[4], [
        "executing",
        "reconcile_required",
      ]);
    },
  },
  {
    name: "venue reconciliation fails a stored definitive rejection once venue confirms not found",
    run: async () => {
      const statements: string[] = [];
      const candidate = {
        id: "00000000-0000-4000-8000-000000000001",
        telegram_user_id: "999",
        user_id: "user-1",
        authorization_id: "authorization-1",
        venue: "polymarket",
        market_id: "market-1",
        event_id: "event-1",
        side: "YES",
        amount_usd: "1",
        status: "reconcile_required",
        prepared_snapshot: {
          authorizationMode: "embedded_privy_evm",
          preparedId: "prepared-1",
          reconcileKeys: { orderHash: "0xorder" },
          recoveryPayload: { kind: "polymarket" },
        },
        quote_snapshot: {},
        result: {
          error: {
            code: "trade_submission_failed",
            message: "Invalid order payload",
            statusCode: 400,
          },
        },
        venue_order_id: null,
        tx_signature: null,
        wallet_address: "0x0000000000000000000000000000000000000001",
        wallet_chain: "ethereum",
        privy_user_id: "privy-1",
        privy_wallet_id: "wallet-1",
        limits: {},
        venue_market_id: "venue-market-1",
        market_title: "Market",
        market_status: "ACTIVE",
        outcomes: JSON.stringify(["YES", "NO"]),
        market_metadata: {},
        updated_at: new Date(Date.now() - 1_000),
      };
      const db = {
        query: async () => ({ rows: [{ ready: true }] }),
        connect: async () => ({
          query: async (sql: string) => {
            statements.push(sql);
            if (sql.includes("pg_try_advisory_xact_lock")) {
              return { rows: [{ locked: true }] };
            }
            if (sql.includes("FROM telegram_trade_intents ti")) {
              return { rows: [candidate] };
            }
            return { rowCount: 1, rows: [] };
          },
          release: () => undefined,
        }),
      };
      const result = await reconcileTelegramVenueIntents(
        db as never,
        {} as never,
        { dryRun: false },
        {
          inspectVenueSubmit: async () => ({
            state: "not_found",
            submitResult: null,
          }),
        } as never,
      );

      assert.equal(result.inspected, 1);
      assert.equal(result.failedVerified, 1);
      assert.equal(result.pending, 0);
      assert.equal(result.items[0]?.result, "failed");
      const terminalUpdate = statements.find((sql) =>
        sql.includes("error_code = 'venue_submit_rejected'"),
      );
      assert.ok(terminalUpdate);
      assert.match(terminalUpdate, /venue_order_id IS NULL/);
      assert.match(terminalUpdate, /order_id IS NULL/);
      assert.match(terminalUpdate, /statusCode' = '400'/);
    },
  },
  {
    name: "venue reconciliation keeps ambiguous submit failures pending when venue says not found",
    run: async () => {
      const statements: string[] = [];
      const db = {
        query: async () => ({ rows: [{ ready: true }] }),
        connect: async () => ({
          query: async (sql: string) => {
            statements.push(sql);
            if (sql.includes("pg_try_advisory_xact_lock")) {
              return { rows: [{ locked: true }] };
            }
            if (sql.includes("FROM telegram_trade_intents ti")) {
              return {
                rows: [
                  {
                    id: "00000000-0000-4000-8000-000000000001",
                    telegram_user_id: "999",
                    user_id: "user-1",
                    authorization_id: "authorization-1",
                    venue: "polymarket",
                    market_id: "market-1",
                    event_id: "event-1",
                    side: "YES",
                    amount_usd: "1",
                    status: "reconcile_required",
                    prepared_snapshot: {
                      reconcileKeys: { orderHash: "0xorder" },
                    },
                    quote_snapshot: {},
                    result: {
                      error: {
                        code: "trade_submission_failed",
                        statusCode: 502,
                      },
                    },
                    venue_order_id: null,
                    tx_signature: null,
                    updated_at: new Date(Date.now() - 1_000),
                  },
                ],
              };
            }
            return { rowCount: 1, rows: [] };
          },
          release: () => undefined,
        }),
      };
      const result = await reconcileTelegramVenueIntents(
        db as never,
        {} as never,
        { dryRun: false },
        {
          inspectVenueSubmit: async () => ({
            state: "not_found",
            submitResult: null,
          }),
        } as never,
      );

      assert.equal(result.failedVerified, 0);
      assert.equal(result.pending, 1);
      assert.equal(result.items[0]?.result, "pending");
      assert.equal(
        statements.some((sql) =>
          sql.includes("error_code = 'venue_submit_rejected'"),
        ),
        false,
      );
    },
  },
  {
    name: "venue reconciliation retries persistence and stops after recovery",
    run: async () => {
      let resolved = false;
      let persistAttempts = 0;
      let effectsAttempts = 0;
      const candidate = {
        id: "00000000-0000-4000-8000-000000000001",
        telegram_user_id: "999",
        user_id: "user-1",
        authorization_id: "authorization-1",
        venue: "polymarket",
        market_id: "market-1",
        event_id: "event-1",
        side: "YES",
        amount_usd: "10",
        status: "reconcile_required",
        prepared_snapshot: {
          authorizationMode: "embedded_privy_evm",
          preparedId: "prepared-1",
          reconcileKeys: { orderHash: "0xorder" },
          recoveryPayload: {
            kind: "polymarket",
            orderHash: "0xorder",
            orderPayload: { recovered: true },
            positionWalletAddress: "0x0000000000000000000000000000000000000002",
            price: 0.5,
            size: 20,
            tokenId: "token-1",
          },
        },
        quote_snapshot: {},
        venue_order_id: "venue-order-1",
        tx_signature: null,
        wallet_address: "0x0000000000000000000000000000000000000001",
        wallet_chain: "ethereum",
        privy_user_id: "privy-1",
        privy_wallet_id: "wallet-1",
        limits: {},
        venue_market_id: "venue-market-1",
        market_title: "Market",
        market_status: "ACTIVE",
        outcomes: JSON.stringify(["YES", "NO"]),
        market_metadata: {},
        updated_at: new Date(Date.now() - 1_000),
      };
      const db = {
        query: async () => ({ rows: [{ ready: true }] }),
        connect: async () => ({
          query: async (sql: string) => {
            if (sql.includes("pg_try_advisory_xact_lock")) {
              return { rows: [{ locked: true }] };
            }
            if (sql.includes("FROM telegram_trade_intents ti")) {
              return { rows: resolved ? [] : [candidate] };
            }
            if (sql.includes("SET status = $2")) {
              resolved = true;
            }
            return { rowCount: 1, rows: [] };
          },
          release: () => undefined,
        }),
      };
      const trading = {
        persistTrade: async () => {
          persistAttempts += 1;
          if (persistAttempts === 1) {
            throw new Error("injected persistence failure");
          }
          return {
            executionId: null,
            orderId: "11111111-1111-4111-8111-111111111111",
            raw: { recovered: true },
            status: "matched",
            venue: "polymarket" as const,
            venueOrderId: "venue-order-1",
          };
        },
        applyTradeEffects: async () => {
          effectsAttempts += 1;
          return { ok: true, positionDeltaApplied: true };
        },
      };
      const dependencies = {
        inspectVenueSubmit: async () => ({
          state: "found",
          submitResult: {
            orderHash: "0xorder",
            price: 0.5,
            size: 20,
            status: "filled" as const,
            txSignature: null,
            venue: "polymarket" as const,
            venueOrderId: "venue-order-1",
          },
        }),
      };

      const failedPersistence = await reconcileTelegramVenueIntents(
        db as never,
        trading as never,
        { dryRun: false },
        dependencies as never,
      );
      assert.equal(failedPersistence.skipped, 1);
      assert.equal(failedPersistence.recovered, 0);
      assert.ok((failedPersistence.oldestAgeMs ?? 0) >= 900);
      assert.equal(resolved, false);

      const recovered = await reconcileTelegramVenueIntents(
        db as never,
        trading as never,
        { dryRun: false },
        dependencies as never,
      );
      assert.equal(recovered.recovered, 1);
      assert.equal(resolved, true);

      const idempotentRepeat = await reconcileTelegramVenueIntents(
        db as never,
        trading as never,
        { dryRun: false },
        dependencies as never,
      );
      assert.equal(idempotentRepeat.inspected, 0);
      assert.equal(persistAttempts, 2);
      assert.equal(effectsAttempts, 1);
    },
  },
  {
    name: "buy callback with unresolved same market opposing side intent does not enter confirming",
    run: async () => {
      const telegram = new FakeTelegram();
      let updateCount = 0;
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
          if (sql.includes("FROM telegram_trade_intents i")) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: "00000000-0000-4000-8000-000000000001",
                  telegram_user_id: "999",
                  user_id: "user-1",
                  authorization_id: null,
                  chat_id: "999",
                  telegram_message_id: null,
                  action: "buy",
                  venue: "polymarket",
                  market_id: "market-1",
                  event_id: "event-1",
                  side: "NO",
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
          if (sql.includes("FROM telegram_trade_intents tti")) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: "00000000-0000-4000-8000-000000000002",
                  side: "YES",
                  status: "reconcile_required",
                  error_code: "submit_state_unknown",
                },
              ],
            };
          }
          if (sql.includes("UPDATE telegram_trade_intents")) {
            updateCount += 1;
            return { rowCount: 1, rows: [] };
          }
          return { rowCount: 0, rows: [] };
        },
      };

      const handled = await handleTelegramBotTradingCallback({
        answerCallbackQuery: (input) => telegram.answerCallbackQuery(input),
        appBaseUrl: "https://app.hunch.trade",
        callbackQuery: buildTradeCallbackQuery({
          data: "hbt:buy:00000000-0000-4000-8000-000000000001",
        }),
        db: db as never,
        sendMessage: (message) => telegram.sendMessage(message as never),
        signerInspector: readyTelegramSignerInspector,
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

      assert.equal(handled, true);
      assert.equal(updateCount, 0);
      assert.match(
        telegram.callbackAnswers[0]?.text ?? "",
        /Existing trade is still resolving/,
      );
      assert.match(
        telegram.messages[0]?.text ?? "",
        /Existing trade is still resolving/,
      );
    },
  },
  {
    name: "stale trading intent reconciliation backfills refs from stored orders and executions",
    run: async () => {
      const db = {
        query: async (sql: string) => {
          if (sql.includes("FROM orders o")) {
            return { rowCount: 2, rows: [] };
          }
          if (sql.includes("FROM executions e")) {
            return { rowCount: 1, rows: [] };
          }
          return { rowCount: 0, rows: [] };
        },
      };
      const result = await reconcileStaleTelegramTradeIntents(db as never, {
        executingGraceMs: 60_000,
        now: new Date("2026-07-07T12:00:00Z"),
      });
      assert.equal(result.backfilledOrderRefs, 2);
      assert.equal(result.backfilledExecutionRefs, 1);
      assert.equal(result.unknownSubmitReconcileRequired, 0);
      assert.equal(result.submittedReconcileRequired, 0);
    },
  },
  {
    name: "telegram bot trading internal Privy wallet resolver filters candidates",
    run: () => {
      const profiles: PrivyWalletProfile[] = [
        {
          address: "0x0000000000000000000000000000000000000001",
          isInternalWallet: true,
          source: "embedded",
          walletId: "  evm-wallet  ",
          walletType: "ethereum",
        },
        {
          address: "0x0000000000000000000000000000000000000002",
          isInternalWallet: false,
          source: "external",
          walletId: "external-wallet",
          walletType: "ethereum",
        },
        {
          address: "So11111111111111111111111111111111111111112",
          isInternalWallet: true,
          source: "embedded",
          walletId: "",
          walletType: "solana",
        },
      ];
      assert.deepEqual(
        resolveInternalPrivyWalletCandidatesForProfile(profiles),
        [
          {
            privyWalletId: "evm-wallet",
            walletAddress: "0x0000000000000000000000000000000000000001",
            walletChain: "ethereum",
          },
        ],
      );
    },
  },
  {
    name: "telegram bot trading Privy lookup failure stops enable wallet resolution",
    run: async () => {
      const privyAny = PrivyService as unknown as {
        getUserById: typeof PrivyService.getUserById;
      };
      const originalGetUserById = privyAny.getUserById;
      let warnCount = 0;
      let downstreamCalled = false;
      try {
        privyAny.getUserById = async () => {
          throw new Error("privy unavailable");
        };
        await assert.rejects(async () => {
          await resolveInternalPrivyWalletCandidates({
            app: {
              log: {
                warn: () => {
                  warnCount += 1;
                },
              },
            } as never,
            privyUserId: "privy-1",
          });
          downstreamCalled = true;
        }, /internal_privy_wallet_lookup_failed/);
        assert.equal(downstreamCalled, false);
        assert.equal(warnCount, 1);
      } finally {
        privyAny.getUserById = originalGetUserById;
      }
    },
  },
  {
    name: "telegram bot trading status wallet setup ignores unknown Privy availability",
    run: async () => {
      const privyAny = PrivyService as unknown as {
        getUserById: typeof PrivyService.getUserById;
      };
      const originalGetUserById = privyAny.getUserById;
      let warnCount = 0;
      let dbQueries = 0;
      try {
        privyAny.getUserById = async () => {
          throw new Error("privy unavailable");
        };
        const issues = await resolveTelegramBotTradingStatusWalletSetupIssues({
          app: {
            log: {
              warn: () => {
                warnCount += 1;
              },
            },
          } as never,
          db: {
            query: async () => {
              dbQueries += 1;
              throw new Error("wallet setup DB should not be queried");
            },
          } as never,
          privyUserId: "privy-1",
          requestedVenues: ["kalshi"],
          userId: "user-1",
        });
        assert.deepEqual(issues, []);
        assert.equal(warnCount, 1);
        assert.equal(dbQueries, 0);
      } finally {
        privyAny.getUserById = originalGetUserById;
      }
    },
  },
  {
    name: "telegram bot trading status wallet setup treats empty internal list as missing wallet",
    run: async () => {
      const privyAny = PrivyService as unknown as {
        classifyWallets: typeof PrivyService.classifyWallets;
        getUserById: typeof PrivyService.getUserById;
      };
      const originalClassifyWallets = privyAny.classifyWallets;
      const originalGetUserById = privyAny.getUserById;
      let dbQueries = 0;
      try {
        privyAny.getUserById = async () => ({ id: "privy-1" }) as PrivyUser;
        privyAny.classifyWallets = () => [
          {
            address: "0x0000000000000000000000000000000000000001",
            isInternalWallet: false,
            source: "external",
            walletId: "external-wallet",
            walletType: "ethereum",
          },
        ];
        const issues = await resolveTelegramBotTradingStatusWalletSetupIssues({
          app: {
            log: {
              warn: () => undefined,
            },
          } as never,
          db: {
            query: async (sql: string) => {
              dbQueries += 1;
              assert.match(sql, /FROM user_wallets uw/);
              return {
                rowCount: 1,
                rows: [
                  {
                    created_at: new Date("2026-01-01T00:00:00.000Z"),
                    is_primary: true,
                    wallet_address:
                      "0x0000000000000000000000000000000000000001",
                    wallet_type: "ethereum",
                  },
                ],
              };
            },
          } as never,
          privyUserId: "privy-1",
          requestedVenues: ["polymarket"],
          userId: "user-1",
        });
        assert.equal(dbQueries, 1);
        assert.deepEqual(issues, [
          {
            code: "internal_wallet_missing",
            message:
              "Telegram bot trading needs an internal Hunch EVM Trading Wallet.",
            venue: "polymarket",
            walletChain: "ethereum",
          },
        ]);
      } finally {
        privyAny.classifyWallets = originalClassifyWallets;
        privyAny.getUserById = originalGetUserById;
      }
    },
  },
  {
    name: "enabling bot trading auto-selects internal wallets by requested chain",
    run: async () => {
      const makeDb = (input: {
        existingAuthorizations?: Array<{
          enabled?: boolean;
          enabledVenues: string[];
          limits?: Record<string, unknown>;
          privyWalletId: string;
          walletAddress: string;
          walletChain: "ethereum" | "solana";
        }>;
        verifiedWallets: Array<{
          address: string;
          type: "ethereum" | "solana";
          isPrimary?: boolean;
          createdAt?: Date;
        }>;
      }) => {
        const storedAuthorizations: Array<{
          enabled: boolean;
          limits: Record<string, unknown>;
          walletAddress: string;
          walletChain: "ethereum" | "solana";
          privyWalletId: string;
          enabledVenues: string[];
        }> =
          input.existingAuthorizations?.map((authorization) => ({
            enabled: authorization.enabled ?? true,
            enabledVenues: authorization.enabledVenues,
            limits: authorization.limits ?? {},
            privyWalletId: authorization.privyWalletId,
            walletAddress: authorization.walletAddress,
            walletChain: authorization.walletChain,
          })) ?? [];
        const stats = {
          disabledRows: 0,
          maxAmounts: [] as number[],
          upserts: 0,
        };
        const db = {
          query: async (sql: string, params?: unknown[]) => {
            if (/FROM users u/i.test(sql)) {
              return {
                rowCount: 1,
                rows: [
                  {
                    privy_user_id: "privy-1",
                    telegram_user_id: "999",
                  },
                ],
              };
            }
            if (sql.includes("FROM user_wallets uw")) {
              return {
                rowCount: input.verifiedWallets.length,
                rows: input.verifiedWallets.map((wallet, index) => ({
                  wallet_address: wallet.address,
                  wallet_type: wallet.type,
                  is_primary: Boolean(wallet.isPrimary),
                  created_at:
                    wallet.createdAt ?? new Date(Date.UTC(2026, 0, index + 1)),
                })),
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
              stats.upserts += 1;
              stats.maxAmounts.push(Number(params?.[7]));
              const walletChain = params?.[4] as "ethereum" | "solana";
              const next = {
                enabled: true,
                walletAddress: String(params?.[3] ?? ""),
                walletChain,
                privyWalletId: String(params?.[5] ?? ""),
                enabledVenues: (params?.[6] as string[] | undefined) ?? [],
                limits: JSON.parse(String(params?.[8] ?? "{}")) as Record<
                  string,
                  unknown
                >,
              };
              const existing = storedAuthorizations.find(
                (authorization) => authorization.walletChain === walletChain,
              );
              if (existing) {
                Object.assign(existing, next);
              } else {
                storedAuthorizations.push(next);
              }
              return { rowCount: 1, rows: [] };
            }
            if (sql.includes("UPDATE telegram_bot_trading_authorizations")) {
              const walletChains = sql.includes("wallet_chain = ANY")
                ? new Set((params?.[1] as string[] | undefined) ?? [])
                : null;
              for (const authorization of storedAuthorizations) {
                if (
                  walletChains &&
                  !walletChains.has(authorization.walletChain)
                ) {
                  continue;
                }
                if (authorization.enabled) stats.disabledRows += 1;
                authorization.enabled = false;
              }
              return { rowCount: storedAuthorizations.length, rows: [] };
            }
            if (sql.includes("UPDATE telegram_trade_intents")) {
              return { rowCount: 0, rows: [] };
            }
            if (sql.includes("FROM user_telegram_accounts uta")) {
              return {
                rowCount: storedAuthorizations.length,
                rows: storedAuthorizations.map((authorization, index) => ({
                  id: `authorization-${index + 1}`,
                  user_id: "user-1",
                  privy_user_id: "privy-1",
                  telegram_user_id: "999",
                  username: "user",
                  wallet_address: authorization.walletAddress,
                  wallet_chain: authorization.walletChain,
                  privy_wallet_id: authorization.privyWalletId,
                  enabled: authorization.enabled,
                  enabled_venues: authorization.enabledVenues,
                  max_amount_usd: "50",
                  limits: authorization.limits,
                  disabled_at: null,
                  last_verified_at: new Date(),
                })),
              };
            }
            return { rowCount: 0, rows: [] };
          },
        };
        return { db, stats, storedAuthorizations };
      };

      {
        const solanaUnselected = "SoUnselected1111111111111111111111111111111";
        const solanaSelected = "SoSelected222222222222222222222222222222222";
        const { db, stats, storedAuthorizations } = makeDb({
          verifiedWallets: [
            {
              address: "0x0000000000000000000000000000000000000001",
              type: "ethereum",
              isPrimary: true,
            },
            {
              address: "0x0000000000000000000000000000000000000002",
              type: "ethereum",
            },
            {
              address: solanaUnselected,
              type: "solana",
            },
            {
              address: solanaSelected,
              type: "solana",
              isPrimary: true,
            },
          ],
        });
        let kalshiEligibilityWalletAddress: string | null = null;
        await assert.rejects(
          () =>
            enableTelegramBotTrading(db as never, {
              buildKalshiEligibilityForWallet: async (walletAddress) => {
                kalshiEligibilityWalletAddress = walletAddress;
                return {
                  checkedAt: "2026-07-08T00:00:00.000Z",
                  expiresAt: "2026-07-08T01:00:00.000Z",
                  geoAllowed: true,
                  proofVerified: true,
                };
              },
              enabledVenues: ["polymarket", "limitless", "kalshi"],
              internalWallets: [
                {
                  privyWalletId: "evm-primary-wallet",
                  walletAddress: "0x0000000000000000000000000000000000000001",
                  walletChain: "ethereum",
                },
                {
                  privyWalletId: "evm-preferred-wallet",
                  walletAddress: "0x0000000000000000000000000000000000000002",
                  walletChain: "ethereum",
                },
                {
                  privyWalletId: "solana-unselected-wallet",
                  walletAddress: solanaUnselected,
                  walletChain: "solana",
                },
                {
                  privyWalletId: "solana-selected-wallet",
                  walletAddress: solanaSelected,
                  walletChain: "solana",
                },
              ],
              preferredWalletAddress:
                "0x0000000000000000000000000000000000000002",
              userId: "user-1",
            }),
          (error: unknown) =>
            (error as { code?: string }).code ===
            "privy_policy_unsupported_for_venue",
        );
        assert.equal(storedAuthorizations.length, 0);
        assert.equal(kalshiEligibilityWalletAddress, null);
        assert.deepEqual(stats.maxAmounts, []);
      }

      {
        const { db, stats } = makeDb({
          verifiedWallets: [
            {
              address: "0x0000000000000000000000000000000000000001",
              type: "ethereum",
            },
          ],
        });
        await enableTelegramBotTrading(db as never, {
          enabledVenues: ["polymarket"],
          internalWallets: [
            {
              privyWalletId: "evm-wallet",
              walletAddress: "0x0000000000000000000000000000000000000001",
              walletChain: "ethereum",
            },
          ],
          maxAmountUsd: 10,
          signerInspector: readyTelegramSignerInspector,
          userId: "user-1",
        });
        assert.deepEqual(stats.maxAmounts, [10]);
        await assert.rejects(
          () =>
            enableTelegramBotTrading(db as never, {
              enabledVenues: ["polymarket"],
              internalWallets: [
                {
                  privyWalletId: "evm-wallet",
                  walletAddress: "0x0000000000000000000000000000000000000001",
                  walletChain: "ethereum",
                },
              ],
              maxAmountUsd: 51,
              userId: "user-1",
            }),
          (error: unknown) =>
            (error as { code?: string }).code === "invalid_max_amount_usd",
        );
        await assert.rejects(
          () =>
            enableTelegramBotTrading(db as never, {
              enabledVenues: ["polymarket"],
              internalWallets: [
                {
                  privyWalletId: "evm-wallet",
                  walletAddress: "0x0000000000000000000000000000000000000001",
                  walletChain: "ethereum",
                },
              ],
              maxAmountUsd: 1.5,
              userId: "user-1",
            }),
          (error: unknown) =>
            (error as { code?: string }).code === "invalid_max_amount_usd",
        );
        assert.deepEqual(stats.maxAmounts, [10]);
      }

      {
        const { db, stats, storedAuthorizations } = makeDb({
          existingAuthorizations: [
            {
              enabled: true,
              enabledVenues: ["polymarket", "limitless"],
              privyWalletId: "evm-wallet",
              walletAddress: "0x0000000000000000000000000000000000000001",
              walletChain: "ethereum",
            },
            {
              enabled: true,
              enabledVenues: ["kalshi"],
              privyWalletId: "solana-wallet",
              walletAddress: "So11111111111111111111111111111111111111112",
              walletChain: "solana",
            },
          ],
          verifiedWallets: [],
        });
        const status = await enableTelegramBotTrading(db as never, {
          enabledVenues: [],
          internalWallets: [],
          userId: "user-1",
        });
        assert.equal(stats.upserts, 0);
        assert.equal(stats.disabledRows, 2);
        assert.equal(status.enabled, false);
        assert.deepEqual(
          storedAuthorizations.map((authorization) => authorization.enabled),
          [false, false],
        );
      }

      {
        const solanaSelected = "SoSelected333333333333333333333333333333333";
        const { db, storedAuthorizations } = makeDb({
          verifiedWallets: [
            {
              address: "0x0000000000000000000000000000000000000001",
              type: "ethereum",
              isPrimary: true,
            },
            {
              address: solanaSelected,
              type: "solana",
              isPrimary: true,
            },
          ],
        });
        const status = await enableTelegramBotTrading(db as never, {
          buildKalshiEligibilityForWallet: async () => ({
            checkedAt: "2026-07-08T00:00:00.000Z",
            expiresAt: "2026-07-08T01:00:00.000Z",
            geoAllowed: true,
            proofVerified: true,
          }),
          enabledVenues: ["polymarket"],
          internalWallets: [
            {
              privyWalletId: "evm-wallet",
              walletAddress: "0x0000000000000000000000000000000000000001",
              walletChain: "ethereum",
            },
            {
              privyWalletId: "solana-selected-wallet",
              walletAddress: solanaSelected,
              walletChain: "solana",
            },
          ],
          privyWalletId: "evm-wallet",
          signerInspector: readyTelegramSignerInspector,
          userId: "user-1",
        });
        assert.equal(storedAuthorizations.length, 1);
        assert.equal(
          storedAuthorizations.find(
            (authorization) => authorization.walletChain === "ethereum",
          )?.privyWalletId,
          "evm-wallet",
        );
        assert.deepEqual(status.enabledVenues, ["polymarket"]);
        assert.deepEqual(status.walletSetupIssues, []);
      }

      {
        const { db, storedAuthorizations } = makeDb({
          verifiedWallets: [
            {
              address: "0x0000000000000000000000000000000000000001",
              type: "ethereum",
              isPrimary: true,
            },
            {
              address: "0x0000000000000000000000000000000000000002",
              type: "ethereum",
            },
          ],
        });
        await enableTelegramBotTrading(db as never, {
          enabledVenues: ["polymarket"],
          internalWallets: [
            {
              privyWalletId: "evm-primary-wallet",
              walletAddress: "0x0000000000000000000000000000000000000001",
              walletChain: "ethereum",
            },
            {
              privyWalletId: "evm-secondary-wallet",
              walletAddress: "0x0000000000000000000000000000000000000002",
              walletChain: "ethereum",
            },
          ],
          preferredWalletAddress: "0x0000000000000000000000000000000000009999",
          signerInspector: readyTelegramSignerInspector,
          userId: "user-1",
        });
        assert.equal(
          storedAuthorizations[0]?.privyWalletId,
          "evm-primary-wallet",
        );
      }

      {
        const { db, stats, storedAuthorizations } = makeDb({
          existingAuthorizations: [
            {
              enabled: true,
              enabledVenues: ["kalshi"],
              privyWalletId: "old-solana-wallet",
              walletAddress: "OldSolana111111111111111111111111111111111",
              walletChain: "solana",
            },
          ],
          verifiedWallets: [
            {
              address: "0x0000000000000000000000000000000000000001",
              type: "ethereum",
            },
          ],
        });
        await assert.rejects(
          () =>
            enableTelegramBotTrading(db as never, {
              enabledVenues: ["polymarket", "limitless", "kalshi"],
              internalWallets: [
                {
                  privyWalletId: "evm-wallet",
                  walletAddress: "0x0000000000000000000000000000000000000001",
                  walletChain: "ethereum",
                },
              ],
              userId: "user-1",
            }),
          (error: unknown) =>
            (error as { code?: string }).code ===
            "privy_policy_unsupported_for_venue",
        );
        const solanaAuthorization = storedAuthorizations.find(
          (authorization) => authorization.walletChain === "solana",
        );
        assert.equal(storedAuthorizations.length, 1);
        assert.equal(stats.upserts, 0);
        assert.equal(stats.disabledRows, 0);
        assert.equal(solanaAuthorization?.enabled, true);
      }

      {
        const { db } = makeDb({
          existingAuthorizations: [
            {
              enabled: true,
              enabledVenues: ["polymarket", "limitless"],
              privyWalletId: "evm-wallet",
              walletAddress: "0x0000000000000000000000000000000000000001",
              walletChain: "ethereum",
            },
          ],
          verifiedWallets: [
            {
              address: "0x0000000000000000000000000000000000000001",
              type: "ethereum",
            },
            {
              address: "So11111111111111111111111111111111111111112",
              type: "solana",
            },
          ],
        });
        const issues = await resolveTelegramBotTradingWalletSetupIssues(
          db as never,
          {
            internalWallets: [
              {
                privyWalletId: "evm-wallet",
                walletAddress: "0x0000000000000000000000000000000000000001",
                walletChain: "ethereum",
              },
              {
                privyWalletId: "solana-wallet",
                walletAddress: "So11111111111111111111111111111111111111112",
                walletChain: "solana",
              },
            ],
            requestedVenues: ["polymarket", "limitless", "kalshi"],
            userId: "user-1",
          },
        );
        assert.deepEqual(issues, []);
      }

      {
        const { db } = makeDb({
          existingAuthorizations: [
            {
              enabled: true,
              enabledVenues: ["polymarket", "limitless"],
              privyWalletId: "evm-wallet",
              walletAddress: "0x0000000000000000000000000000000000000001",
              walletChain: "ethereum",
            },
          ],
          verifiedWallets: [
            {
              address: "0x0000000000000000000000000000000000000001",
              type: "ethereum",
            },
          ],
        });
        const issues = await resolveTelegramBotTradingWalletSetupIssues(
          db as never,
          {
            internalWallets: [
              {
                privyWalletId: "evm-wallet",
                walletAddress: "0x0000000000000000000000000000000000000001",
                walletChain: "ethereum",
              },
            ],
            requestedVenues: ["polymarket", "limitless", "kalshi"],
            userId: "user-1",
          },
        );
        assert.deepEqual(issues, [
          {
            code: "internal_wallet_missing",
            message:
              "Telegram bot trading needs an internal Hunch Solana Trading Wallet.",
            venue: "kalshi",
            walletChain: "solana",
          },
        ]);
      }

      {
        const { db, stats, storedAuthorizations } = makeDb({
          existingAuthorizations: [
            {
              enabled: true,
              enabledVenues: ["polymarket", "limitless"],
              privyWalletId: "old-evm-wallet",
              walletAddress: "0x0000000000000000000000000000000000000001",
              walletChain: "ethereum",
            },
            {
              enabled: true,
              enabledVenues: ["kalshi"],
              privyWalletId: "old-solana-wallet",
              walletAddress: "OldSolana111111111111111111111111111111111",
              walletChain: "solana",
            },
          ],
          verifiedWallets: [
            {
              address: "0x0000000000000000000000000000000000000001",
              type: "ethereum",
            },
            {
              address: "OldSolana111111111111111111111111111111111",
              type: "solana",
            },
          ],
        });
        await assert.rejects(
          () =>
            enableTelegramBotTrading(db as never, {
              enabledVenues: ["polymarket", "limitless", "kalshi"],
              internalWallets: [],
              userId: "user-1",
            }),
          (error: unknown) =>
            (error as { code?: string }).code ===
            "privy_policy_unsupported_for_venue",
        );
        assert.equal(stats.upserts, 0);
        assert.equal(stats.disabledRows, 0);
        assert.deepEqual(
          storedAuthorizations.map((authorization) => authorization.enabled),
          [true, true],
        );
      }
    },
  },
  {
    name: "Telegram submit classification keeps only ambiguous failures unknown",
    run: () => {
      assert.equal(
        telegramBotTradingTestHooks.isDefinitiveSubmitRejection({
          code: "trade_submission_failed",
          statusCode: 400,
        }),
        true,
      );
      assert.equal(
        telegramBotTradingTestHooks.isDefinitiveSubmitRejection({
          code: "trade_submission_failed",
          statusCode: 502,
        }),
        false,
      );
      assert.equal(
        telegramBotTradingTestHooks.isDefinitiveSubmitRejection({
          code: "network_error",
          statusCode: 400,
        }),
        false,
      );
    },
  },
  {
    name: "Telegram venue status serializes ready, setup, funding and unavailable states",
    run: () => {
      const authorization = {
        enabled: true,
        enabled_venues: ["polymarket"],
        id: "authorization-1",
        limits: {},
        max_amount_usd: "50",
        privy_user_id: "privy-1",
        privy_wallet_id: "wallet-1",
        telegram_user_id: "999",
        user_id: "user-1",
        wallet_address: "0x0000000000000000000000000000000000000001",
        wallet_chain: "ethereum",
      } as const;
      const build = (enabled: boolean, readiness: TradingReadiness | null) =>
        telegramBotTradingTestHooks.venueStatusFromReadiness({
          authorization: authorization as never,
          enabled,
          readiness,
          venue: "polymarket",
        });

      const ready = build(true, {
        ...buildTestPolymarketReadiness({ executable: true }),
        maxExecutableBuyUsd: 25,
      });
      assert.equal(ready.state, "ready");
      assert.equal(ready.executable, true);
      assert.equal(ready.message, null);
      assert.equal(ready.maxExecutableBuyUsd, 25);

      const autoSetup = build(
        true,
        buildTestPolymarketReadiness({
          code: "polymarket_clob_credentials_missing",
          repairKind: "auto",
          sideEffect: "credential",
        }),
      );
      assert.equal(autoSetup.state, "auto_setup");
      assert.equal(autoSetup.canAttempt, true);

      const appSetup = build(
        true,
        buildTestPolymarketReadiness({
          code: "polymarket_approvals_missing",
          repairKind: "app_required",
          sideEffect: "approval",
        }),
      );
      assert.equal(appSetup.state, "app_setup");
      assert.equal(appSetup.canAttempt, false);

      const unfunded = build(
        true,
        buildTestPolymarketReadiness({
          code: "polymarket_no_executable_funds",
          message: "No funds.",
        }),
      );
      assert.equal(unfunded.state, "unfunded");

      const unavailable = build(
        true,
        buildTestPolymarketReadiness({
          code: "polymarket_funder_status_unavailable",
          message: "RPC unavailable.",
        }),
      );
      assert.equal(unavailable.state, "unavailable");

      const disabled = build(false, null);
      assert.equal(disabled.state, "disabled");
      assert.equal(disabled.enabled, false);
    },
  },
  {
    name: "Telegram status fail-closes legacy non-Polymarket authorizations",
    run: async () => {
      let disableCount = 0;
      const db = {
        query: async (sql: string) => {
          if (sql.includes("runtime_policies")) {
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes("UPDATE telegram_bot_trading_authorizations")) {
            disableCount += 1;
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes("UPDATE telegram_trade_intents")) {
            return { rowCount: 0, rows: [] };
          }
          assert.match(sql, /FROM user_telegram_accounts uta/);
          return {
            rowCount: 1,
            rows: [
              {
                id: "authorization-1",
                user_id: "user-1",
                privy_user_id: "privy-1",
                telegram_user_id: "999",
                username: "user",
                wallet_address: "0x0000000000000000000000000000000000000001",
                wallet_chain: "ethereum",
                privy_wallet_id: "wallet-1",
                enabled: true,
                enabled_venues: ["polymarket", "limitless"],
                max_amount_usd: "25",
                limits: {},
                disabled_at: null,
                last_verified_at: new Date(),
              },
            ],
          };
        },
      };
      const status = await getTelegramBotTradingStatus(
        db as never,
        "999",
        {
          getReadiness: async (input: { venue: string }) => ({
            ready: input.venue === "polymarket",
            executable: input.venue === "polymarket",
            reasonCode:
              input.venue === "polymarket"
                ? null
                : "limitless_balance_status_unavailable",
            message:
              input.venue === "polymarket"
                ? null
                : "Limitless balance status is temporarily unavailable.",
            setupRequired: false,
            capabilities: {
              venue: input.venue,
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
        readyTelegramSignerInspector,
      );
      assert.equal(status.directExecutionReady, false);
      assert.equal(status.enabled, false);
      assert.equal(disableCount, 1);
      assert.deepEqual(
        (status.authorizations[0]?.venueStatuses ?? []).map((venueStatus) => [
          venueStatus.venue,
          venueStatus.state,
          venueStatus.executable,
        ]),
        [
          ["polymarket", "app_setup", false],
          ["limitless", "app_setup", false],
        ],
      );
      assert.equal(
        status.authorizations[0]?.venueStatuses[0]?.reasonCode,
        "privy_server_signer_revoke_required",
      );
      assert.equal(
        status.authorizations[0]?.venueStatuses[1]?.reasonCode,
        "privy_policy_unsupported_for_venue",
      );
    },
  },
  {
    name: "Telegram bot enable rejects unsupported venues before a transaction",
    run: async () => {
      const storedChains: string[] = [];
      const transactionStatements: string[] = [];
      let snapshot: string[] = [];
      const rootQuery = async (sql: string) => {
        if (/FROM users u/i.test(sql)) {
          return {
            rowCount: 1,
            rows: [{ privy_user_id: "privy-1", telegram_user_id: "999" }],
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
                  tradingVenues: ["polymarket", "kalshi"],
                  buyAmountPresetsUsd: [10],
                  maxTradeAmountUsd: 50,
                  maxSlippageBps: 500,
                  intentTtlSec: 120,
                },
              },
            ],
          };
        }
        if (sql.includes("FROM user_wallets uw")) {
          return {
            rowCount: 2,
            rows: [
              {
                wallet_address: "0x0000000000000000000000000000000000000001",
                wallet_type: "ethereum",
                is_primary: true,
                created_at: new Date("2026-01-01T00:00:00Z"),
              },
              {
                wallet_address: "So11111111111111111111111111111111111111112",
                wallet_type: "solana",
                is_primary: true,
                created_at: new Date("2026-01-01T00:00:00Z"),
              },
            ],
          };
        }
        return { rowCount: 0, rows: [] };
      };
      const db = {
        query: rootQuery,
        connect: async () => ({
          query: async (sql: string, params?: unknown[]) => {
            transactionStatements.push(sql.trim().split(/\s+/)[0] ?? "");
            if (sql === "BEGIN") {
              snapshot = [...storedChains];
              return { rowCount: 0, rows: [] };
            }
            if (sql === "ROLLBACK") {
              storedChains.splice(0, storedChains.length, ...snapshot);
              return { rowCount: 0, rows: [] };
            }
            if (sql === "COMMIT") return { rowCount: 0, rows: [] };
            if (sql.includes("UPDATE telegram_bot_trading_authorizations")) {
              return { rowCount: 0, rows: [] };
            }
            if (
              sql.includes("INSERT INTO telegram_bot_trading_authorizations")
            ) {
              const chain = String(params?.[4]);
              if (chain === "solana") throw new Error("second upsert failed");
              storedChains.push(chain);
              return { rowCount: 1, rows: [] };
            }
            return { rowCount: 0, rows: [] };
          },
          release: () => undefined,
        }),
      };
      await assert.rejects(
        () =>
          enableTelegramBotTrading(db as never, {
            buildKalshiEligibilityForWallet: async () => ({
              checkedAt: "2026-01-01T00:00:00Z",
              expiresAt: "2026-01-01T01:00:00Z",
              geoAllowed: true,
              proofVerified: true,
            }),
            enabledVenues: ["polymarket", "kalshi"],
            internalWallets: [
              {
                privyWalletId: "evm-wallet",
                walletAddress: "0x0000000000000000000000000000000000000001",
                walletChain: "ethereum",
              },
              {
                privyWalletId: "solana-wallet",
                walletAddress: "So11111111111111111111111111111111111111112",
                walletChain: "solana",
              },
            ],
            userId: "user-1",
          }),
        (error: unknown) =>
          (error as { code?: string }).code ===
          "privy_policy_unsupported_for_venue",
      );
      assert.deepEqual(storedChains, []);
      assert.deepEqual(transactionStatements, []);
    },
  },
  {
    name: "Telegram bot enable does not reconnect an active transaction client",
    run: async () => {
      let connectCount = 0;
      let enabled = false;
      let lifecycleParams: unknown[] | undefined;
      const lifecycleOrder: string[] = [];
      const authorizationRow = () => ({
        id: "authorization-1",
        user_id: "user-1",
        privy_user_id: "privy-1",
        telegram_user_id: "999",
        username: "user",
        wallet_address: "0x0000000000000000000000000000000000000001",
        wallet_chain: "ethereum",
        privy_wallet_id: "wallet-1",
        enabled,
        enabled_venues: ["polymarket"],
        max_amount_usd: "2",
        limits: {},
        disabled_at: enabled ? null : new Date(),
        last_verified_at: new Date(),
      });
      const rootQuery = async (sql: string, params?: unknown[]) => {
        if (/insert into analytics_server_events/i.test(sql)) {
          lifecycleOrder.push("analytics");
          lifecycleParams = params;
          return { rowCount: 1, rows: [] };
        }
        if (/FROM users u/i.test(sql)) {
          return {
            rowCount: 1,
            rows: [{ privy_user_id: "privy-1", telegram_user_id: "999" }],
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
                  tradingVenues: ["polymarket"],
                  buyAmountPresetsUsd: [1],
                  maxTradeAmountUsd: 2,
                  maxSlippageBps: 500,
                  intentTtlSec: 120,
                },
              },
            ],
          };
        }
        if (sql.includes("FROM user_wallets uw")) {
          return {
            rowCount: 1,
            rows: [
              {
                wallet_address: "0x0000000000000000000000000000000000000001",
                wallet_type: "ethereum",
                is_primary: true,
                created_at: new Date("2026-01-01T00:00:00Z"),
              },
            ],
          };
        }
        if (sql.includes("FROM user_telegram_accounts uta")) {
          return { rowCount: 1, rows: [authorizationRow()] };
        }
        return { rowCount: 0, rows: [] };
      };
      const transactionClient = {
        connect: async () => {
          throw new Error("Client has already been connected");
        },
        query: async (sql: string) => {
          if (sql === "COMMIT") lifecycleOrder.push("commit");
          if (sql.includes("INSERT INTO telegram_bot_trading_authorizations")) {
            enabled = true;
            return {
              rowCount: 1,
              rows: [
                {
                  enabled_venues: ["polymarket"],
                  id: "authorization-1",
                  updated_at: new Date("2026-07-17T00:00:00.000Z"),
                  wallet_chain: "ethereum",
                },
              ],
            };
          }
          return { rowCount: 0, rows: [] };
        },
        release: () => undefined,
      };
      const db = {
        query: rootQuery,
        connect: async () => {
          connectCount += 1;
          return transactionClient;
        },
      };

      const status = await enableTelegramBotTrading(db as never, {
        enabledVenues: ["polymarket"],
        internalWallets: [
          {
            privyWalletId: "wallet-1",
            walletAddress: "0x0000000000000000000000000000000000000001",
            walletChain: "ethereum",
          },
        ],
        maxAmountUsd: 2,
        signerInspector: readyTelegramSignerInspector,
        userId: "user-1",
      });

      assert.equal(connectCount, 1);
      assert.equal(status.enabled, true);
      assert.deepEqual(lifecycleOrder, ["commit", "analytics"]);
      assert.deepEqual(lifecycleParams?.slice(0, 4), [
        "user-1",
        "hf_telegram_trading_lifecycle",
        "telegram_trading_settings",
        "enabled",
      ]);
      assert.equal(lifecycleParams?.[4], "polymarket");
      assert.equal(JSON.parse(String(lifecycleParams?.[6])).chain, "polygon");
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
                  error_code: "quote_changed",
                  error_message: "Price moved.",
                  status: "failed",
                  submit_started_at: null,
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
        callbackQuery: buildTradeCallbackQuery({
          data: "hbt:buy:00000000-0000-4000-8000-000000000001",
        }),
        db: db as never,
        sendMessage: (message) => telegram.sendMessage(message as never),
      });
      assert.equal(handled, true);
      assert.equal(updateCount, 0);
      assert.match(
        telegram.callbackAnswers[0]?.text ?? "",
        /failed before submission.*Nothing was sent/,
      );
    },
  },
  {
    name: "trading callback is bound to the original private chat",
    run: async () => {
      const cases = [
        {
          chatId: 123,
          chatType: "private",
          name: "wrong private chat",
        },
        {
          chatId: 999,
          chatType: "group",
          name: "non-private chat",
        },
      ];
      for (const testCase of cases) {
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
            if (sql.includes("UPDATE telegram_trade_intents")) {
              updateCount += 1;
            }
            return { rowCount: 0, rows: [] };
          },
        };

        const handled = await handleTelegramBotTradingCallback({
          answerCallbackQuery: (input) => telegram.answerCallbackQuery(input),
          appBaseUrl: "https://app.hunch.trade",
          callbackQuery: buildTradeCallbackQuery({
            chatId: testCase.chatId,
            chatType: testCase.chatType,
            data: "hbt:buy:00000000-0000-4000-8000-000000000001",
          }),
          db: db as never,
          sendMessage: (message) => telegram.sendMessage(message as never),
        });

        assert.equal(handled, true, testCase.name);
        assert.equal(updateCount, 0, testCase.name);
        assert.match(
          telegram.callbackAnswers[0]?.text ?? "",
          /original private bot chat/,
          testCase.name,
        );
      }
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
        callbackQuery: buildTradeCallbackQuery({
          data: "hbt:buy:00000000-0000-4000-8000-000000000001",
        }),
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
    name: "closed market callback fails before quote or venue execution",
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
                  status: "CLOSED",
                  accepting_orders: false,
                  outcomes: JSON.stringify(["YES", "NO"]),
                  metadata: {},
                  close_time: new Date(Date.now() - 60_000),
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
        callbackQuery: buildTradeCallbackQuery({
          data: "hbt:buy:00000000-0000-4000-8000-000000000001",
        }),
        db: db as never,
        sendMessage: (message) => telegram.sendMessage(message as never),
        signerInspector: readyTelegramSignerInspector,
        trading: {
          getReadiness: async () =>
            buildTestPolymarketReadiness({ executable: true }),
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
      assert.match(telegram.messages[0]?.text ?? "", /not ready|not open/i);
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
          if (
            sql.includes("FROM telegram_bot_trading_authorizations") &&
            sql.includes("SELECT enabled")
          ) {
            return { rowCount: 1, rows: [{ enabled: true }] };
          }
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
        callbackQuery: buildTradeCallbackQuery({
          data: "hbt:confirm:00000000-0000-4000-8000-000000000001",
        }),
        db: db as never,
        sendMessage: (message) => telegram.sendMessage(message as never),
        signerInspector: readyTelegramSignerInspector,
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
                onBeforeBroadcast?: () => unknown;
                onSubmitted?: (submitResult: unknown) => unknown;
              }
            ).onBeforeBroadcast?.();
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
            quotedSlippageBps = (input as { intent: { slippageBps?: unknown } })
              .intent.slippageBps;
            return {
              venue: "polymarket",
              target: (input as { intent: { target: unknown } }).intent.target,
              action: "BUY",
              amount: { type: "usd", value: "10" },
              price: 0.5,
              estimatedShares: 20,
              estimatedNotionalUsd: 10,
              maxSpendUsd: 10,
              meetsVenueMinimum: false,
              minimumOrderSizeShares: 100,
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
        ["executing", "executing", "executing", "executing", "submitted"],
      );
      assert.equal(updateStatuses[3]?.venueOrderId, "venue-order-1");
      assert.equal(updateStatuses[4]?.errorCode, "persistence_failed");
      assert.equal(updateStatuses[4]?.venueOrderId, "venue-order-1");
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
    name: "trading confirm fails over-cap quote before prepare or submit",
    run: async () => {
      const telegram = new FakeTelegram();
      const updateStatuses: Array<{
        markSubmitStarted: unknown;
        status: unknown;
      }> = [];
      let prepareCalls = 0;
      let executeCalls = 0;
      const db = {
        query: async (sql: string, params?: unknown[]) => {
          if (
            sql.includes("FROM telegram_bot_trading_authorizations") &&
            sql.includes("SELECT enabled")
          ) {
            return { rowCount: 1, rows: [{ enabled: true }] };
          }
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
                    maxTradeAmountUsd: 10,
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
                  max_amount_usd: "10",
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
              markSubmitStarted: params?.[12],
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
        callbackQuery: buildTradeCallbackQuery({
          data: "hbt:confirm:00000000-0000-4000-8000-000000000001",
        }),
        db: db as never,
        sendMessage: (message) => telegram.sendMessage(message as never),
        signerInspector: readyTelegramSignerInspector,
        trading: {
          executePreparedTrade: async () => {
            executeCalls += 1;
            throw new Error("execute must not be called");
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
          prepareTrade: async () => {
            prepareCalls += 1;
            throw new Error("prepare must not be called");
          },
          quote: async (input: never) => ({
            venue: "polymarket",
            target: (input as { intent: { target: unknown } }).intent.target,
            action: "BUY",
            amount: { type: "usd", value: "10" },
            price: 0.5,
            estimatedShares: 20,
            estimatedNotionalUsd: 10,
            maxSpendUsd: 10.01,
            minReceiveShares: 20,
            fees: { platformFeeEstimateRaw: "10000" },
            expiresAt: null,
          }),
        } as never,
      });

      assert.equal(handled, true);
      assert.equal(prepareCalls, 0);
      assert.equal(executeCalls, 0);
      assert.deepEqual(updateStatuses, [
        { status: "executing", markSubmitStarted: false },
        { status: "failed", markSubmitStarted: false },
      ]);
      assert.match(telegram.callbackAnswers[0]?.text ?? "", /Price moved/i);
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
        callbackQuery: buildTradeCallbackQuery({
          data: "hbt:confirm:00000000-0000-4000-8000-000000000001",
        }),
        db: db as never,
        sendMessage: (message) => telegram.sendMessage(message as never),
        signerInspector: readyTelegramSignerInspector,
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
                onBeforeBroadcast?: () => unknown;
                onSubmitted?: (submitResult: unknown) => unknown;
              }
            ).onBeforeBroadcast?.();
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
        ["executing", "executing", "executing", "executing", "failed"],
      );
      assert.equal(updateStatuses[4]?.errorCode, "no_fill");
      assert.equal(telegram.callbackAnswers[0]?.text, "No fill.");
      assert.match(telegram.messages[0]?.text ?? "", /No fill/);
    },
  },
  {
    name: "trading confirm stops if intent changes before submit",
    run: async () => {
      const telegram = new FakeTelegram();
      const updateAttempts: Array<{
        preparedSnapshot: boolean;
        status: unknown;
      }> = [];
      let executeCalls = 0;
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
            const hasPreparedSnapshot = params?.[10] != null;
            updateAttempts.push({
              status: params?.[1],
              preparedSnapshot: hasPreparedSnapshot,
            });
            return hasPreparedSnapshot
              ? { rowCount: 0, rows: [] }
              : { rowCount: 1, rows: [{ id: params?.[0] }] };
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
        callbackQuery: buildTradeCallbackQuery({
          data: "hbt:confirm:00000000-0000-4000-8000-000000000001",
        }),
        db: db as never,
        sendMessage: (message) => telegram.sendMessage(message as never),
        signerInspector: readyTelegramSignerInspector,
        trading: {
          executePreparedTrade: async () => {
            executeCalls += 1;
            throw new Error("execute must not be called");
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
      assert.equal(executeCalls, 0);
      assert.deepEqual(updateAttempts, [
        { status: "executing", preparedSnapshot: false },
        { status: "executing", preparedSnapshot: true },
      ]);
      assert.match(telegram.callbackAnswers[0]?.text ?? "", /no longer active/);
      assert.equal(telegram.messages.length, 0);
    },
  },
  {
    name: "trading confirm records failed auto-repair without marking submit started",
    run: async () => {
      const telegram = new FakeTelegram();
      const updates: ConfirmIntentUpdate[] = [];
      let ensureCalls = 0;
      let quoteCalls = 0;
      const handled = await handleTelegramBotTradingCallback({
        answerCallbackQuery: (input) => telegram.answerCallbackQuery(input),
        appBaseUrl: "https://app.hunch.trade",
        callbackQuery: buildTradeCallbackQuery({
          data: "hbt:confirm:00000000-0000-4000-8000-000000000001",
        }),
        db: createPolymarketConfirmDb(updates) as never,
        sendMessage: (message) => telegram.sendMessage(message as never),
        signerInspector: readyTelegramSignerInspector,
        telegramMiniAppEnabled: true,
        trading: {
          ensureReadiness: async () => {
            ensureCalls += 1;
            return {
              changed: true,
              sideEffects: ["approval"],
              readiness: buildTestPolymarketReadiness({
                code: "polymarket_approvals_missing",
                message: "Polymarket setup approvals still need attention.",
                repairKind: "app_required",
                sideEffect: "approval",
              }),
            };
          },
          getReadiness: async () =>
            buildTestPolymarketReadiness({
              code: "polymarket_approvals_missing",
              message: "Polymarket setup approvals are missing.",
              repairKind: "auto",
              sideEffect: "approval",
            }),
          quote: async () => {
            quoteCalls += 1;
            throw new Error("quote must not run after failed repair");
          },
        } as never,
      });

      assert.equal(handled, true);
      assert.equal(ensureCalls, 1);
      assert.equal(quoteCalls, 0);
      assert.equal(
        updates.some((update) => update.markSubmitStarted),
        false,
      );
      const failed = updates.at(-1);
      assert.equal(failed?.status, "failed");
      assert.equal(failed?.errorCode, "not_ready");
      assert.deepEqual(failed?.result?.readinessRepair, {
        attempted: true,
        changed: true,
        finalReasonCode: "polymarket_approvals_missing",
        sideEffects: ["approval"],
      });
      const button =
        telegram.messages[0]?.reply_markup?.inline_keyboard[0]?.[0];
      assert.equal(button && "web_app" in button, true);
    },
  },
  {
    name: "setup approval failure records its hash without marking the trade submitted",
    run: async () => {
      const telegram = new FakeTelegram();
      const updates: ConfirmIntentUpdate[] = [];
      const ready = buildTestPolymarketReadiness({ executable: true });
      const handled = await handleTelegramBotTradingCallback({
        answerCallbackQuery: (input) => telegram.answerCallbackQuery(input),
        appBaseUrl: "https://app.hunch.trade",
        callbackQuery: buildTradeCallbackQuery({
          data: "hbt:confirm:00000000-0000-4000-8000-000000000001",
        }),
        db: createPolymarketConfirmDb(updates) as never,
        sendMessage: (message) => telegram.sendMessage(message as never),
        signerInspector: readyTelegramSignerInspector,
        trading: {
          executePreparedTrade: async (input: never) => {
            const lifecycle = input as {
              onBeforeBroadcast?: () => Promise<void>;
              onSetupTransactionSubmitted?: (setup: {
                kind: "approval";
                txHash: string;
              }) => Promise<void>;
            };
            await lifecycle.onSetupTransactionSubmitted?.({
              kind: "approval",
              txHash: "0xapproval",
            });
            throw new Error("approval receipt failed");
          },
          getReadiness: async () => ready,
          normalizeError: (_venue: string, error: unknown) => ({
            code: "trade_submission_failed",
            message: error instanceof Error ? error.message : "fake error",
            statusCode: 504,
            venue: "polymarket",
            raw: error,
          }),
          prepareTrade: async (input: never) => ({
            preparedId: "prepared",
            venue: "polymarket",
            intent: (input as { intent: unknown }).intent,
            quote: null,
            authorizationMode: "embedded_privy_evm",
            authorizationRequests: [],
            reconcileKeys: { orderHash: "0xprepared" },
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
      assert.equal(
        updates.some((update) => update.markSubmitStarted),
        false,
      );
      const failed = updates.at(-1);
      assert.equal(failed?.status, "failed");
      assert.equal(failed?.errorCode, "trade_submission_failed");
      assert.deepEqual(failed?.result?.setupTransactions, [
        { kind: "approval", txHash: "0xapproval" },
      ]);
      assert.match(telegram.callbackAnswers[0]?.text ?? "", /trade failed/i);
    },
  },
  {
    name: "trading confirm continues through submit after successful auto-repair",
    run: async () => {
      const telegram = new FakeTelegram();
      const updates: ConfirmIntentUpdate[] = [];
      const calls: string[] = [];
      const ready = buildTestPolymarketReadiness({ executable: true });
      const handled = await handleTelegramBotTradingCallback({
        answerCallbackQuery: (input) => telegram.answerCallbackQuery(input),
        appBaseUrl: "https://app.hunch.trade",
        callbackQuery: buildTradeCallbackQuery({
          data: "hbt:confirm:00000000-0000-4000-8000-000000000001",
        }),
        db: createPolymarketConfirmDb(updates) as never,
        sendMessage: (message) => telegram.sendMessage(message as never),
        signerInspector: readyTelegramSignerInspector,
        trading: {
          ensureReadiness: async () => {
            calls.push("repair");
            return {
              changed: true,
              sideEffects: ["credential", "approval"],
              readiness: ready,
            };
          },
          executePreparedTrade: async (input: never) => {
            calls.push("execute");
            const lifecycle = input as {
              onBeforeBroadcast?: () => Promise<void>;
              onSubmitted?: (submitResult: unknown) => Promise<void>;
            };
            await lifecycle.onBeforeBroadcast?.();
            const submitResult = {
              orderHash: "0xorder",
              price: 0.5,
              size: 20,
              status: "filled" as const,
              txSignature: "0xtx",
              venue: "polymarket" as const,
              venueOrderId: "order-1",
            };
            await lifecycle.onSubmitted?.(submitResult);
            return {
              effects: { ok: true },
              persisted: {
                executionId: null,
                orderId: "db-order-1",
                raw: null,
                status: "filled",
                venue: "polymarket" as const,
                venueOrderId: "order-1",
              },
              postSubmitError: null,
              submitResult,
            };
          },
          getReadiness: async () =>
            buildTestPolymarketReadiness({
              code: "polymarket_clob_credentials_missing",
              message:
                "Connect Polymarket CLOB credentials before bot trading.",
              repairKind: "auto",
              sideEffect: "credential",
            }),
          normalizeError: (_venue: string, error: unknown) => ({
            code: "fake_error",
            message: error instanceof Error ? error.message : "fake error",
            statusCode: 500,
            venue: "polymarket",
            raw: error,
          }),
          prepareTrade: async (input: never) => {
            calls.push("prepare");
            return {
              preparedId: "prepared",
              venue: "polymarket",
              intent: (input as { intent: unknown }).intent,
              quote: null,
              authorizationMode: "embedded_privy_evm",
              authorizationRequests: [],
              venuePayload: {},
              expiresAt: null,
            };
          },
          quote: async (input: never) => {
            calls.push("quote");
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
      assert.deepEqual(calls, ["repair", "quote", "prepare", "execute"]);
      assert.equal(
        updates.filter((update) => update.markSubmitStarted).length,
        1,
      );
      const finalized = updates.at(-1);
      assert.equal(finalized?.status, "filled");
      assert.deepEqual(finalized?.result?.readinessRepair, {
        attempted: true,
        changed: true,
        finalReasonCode: null,
        sideEffects: ["credential", "approval"],
      });
    },
  },
  {
    name: "trading confirm leaves pre-broadcast Kalshi validation failure failed",
    run: async () => {
      const telegram = new FakeTelegram();
      const updateAttempts: Array<{
        errorCode: unknown;
        markSubmitStarted: unknown;
        preparedSnapshot: boolean;
        status: unknown;
      }> = [];
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
                    tradingVenues: ["kalshi"],
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
                  venue: "kalshi",
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
                  wallet_address: "11111111111111111111111111111111",
                  wallet_chain: "solana",
                  privy_wallet_id: "wallet-1",
                  enabled: true,
                  enabled_venues: ["kalshi"],
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
                  venue: "kalshi",
                  venue_market_id: "venue-market-1",
                  event_id: "event-1",
                  event_title: "Event",
                  title: "Market",
                  status: "ACTIVE",
                  outcomes: JSON.stringify(["YES", "NO"]),
                  metadata: { dflowNativeAcceptingOrders: true },
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
            updateAttempts.push({
              status: params?.[1],
              errorCode: params?.[2],
              markSubmitStarted: params?.[12],
              preparedSnapshot: params?.[10] != null,
            });
            return { rowCount: 1, rows: [{ id: params?.[0] }] };
          }
          return { rowCount: 0, rows: [] };
        },
      };
      const handled = await handleTelegramBotTradingCallback({
        answerCallbackQuery: (input) => telegram.answerCallbackQuery(input),
        appBaseUrl: "https://app.hunch.trade",
        callbackQuery: buildTradeCallbackQuery({
          data: "hbt:confirm:00000000-0000-4000-8000-000000000001",
        }),
        db: db as never,
        sendMessage: (message) => telegram.sendMessage(message as never),
        signerInspector: readyTelegramSignerInspector,
        trading: {
          executePreparedTrade: async () => {
            throw new Error("Kalshi transaction could not be validated");
          },
          getReadiness: async () => ({
            ready: true,
            executable: true,
            reasonCode: null,
            message: null,
            setupRequired: false,
            capabilities: {
              venue: "kalshi",
              supportsBuy: true,
              supportsSell: false,
              supportsCancel: false,
              supportsOrderSync: false,
              supportsPositionSync: false,
              supportsExecutionSync: true,
              supportsSetup: false,
              authorizationModes: ["embedded_privy_solana"],
            },
          }),
          normalizeError: (_venue: string, error: unknown) => ({
            code: "trade_submission_failed",
            message:
              error instanceof Error ? error.message : "submission failed",
            statusCode: 502,
            venue: "kalshi",
            raw: error,
          }),
          prepareTrade: async (input: never) => ({
            preparedId: "prepared",
            venue: "kalshi",
            intent: (input as { intent: unknown }).intent,
            quote: null,
            authorizationMode: "embedded_privy_solana",
            authorizationRequests: [],
            venuePayload: {},
            expiresAt: null,
          }),
          quote: async (input: never) => ({
            venue: "kalshi",
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
      assert.deepEqual(updateAttempts, [
        {
          status: "executing",
          errorCode: null,
          markSubmitStarted: false,
          preparedSnapshot: false,
        },
        {
          status: "executing",
          errorCode: null,
          markSubmitStarted: false,
          preparedSnapshot: true,
        },
        {
          status: "failed",
          errorCode: "trade_submission_failed",
          markSubmitStarted: false,
          preparedSnapshot: false,
        },
      ]);
      assert.match(telegram.callbackAnswers[0]?.text ?? "", /trade failed/i);
      assert.match(
        telegram.messages[0]?.text ?? "",
        /before a confirmed venue submission/i,
      );
    },
  },
  {
    name: "trading confirm marks no-ref post-submit-start failures unknown",
    run: async () => {
      const telegram = new FakeTelegram();
      const updateAttempts: Array<{
        errorCode: unknown;
        markSubmitStarted: unknown;
        preparedSnapshot: boolean;
        status: unknown;
      }> = [];
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
            updateAttempts.push({
              status: params?.[1],
              errorCode: params?.[2],
              markSubmitStarted: params?.[12],
              preparedSnapshot: params?.[10] != null,
            });
            return { rowCount: 1, rows: [{ id: params?.[0] }] };
          }
          return { rowCount: 0, rows: [] };
        },
      };
      const handled = await handleTelegramBotTradingCallback({
        answerCallbackQuery: (input) => telegram.answerCallbackQuery(input),
        appBaseUrl: "https://app.hunch.trade",
        callbackQuery: buildTradeCallbackQuery({
          data: "hbt:confirm:00000000-0000-4000-8000-000000000001",
        }),
        db: db as never,
        sendMessage: (message) => telegram.sendMessage(message as never),
        signerInspector: readyTelegramSignerInspector,
        trading: {
          executePreparedTrade: async (input: never) => {
            await (
              input as {
                onBeforeBroadcast?: () => unknown;
              }
            ).onBeforeBroadcast?.();
            throw new Error("connection dropped after submit started");
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
            code: "network_error",
            message: error instanceof Error ? error.message : "network error",
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
      assert.deepEqual(updateAttempts, [
        {
          status: "executing",
          errorCode: null,
          markSubmitStarted: false,
          preparedSnapshot: false,
        },
        {
          status: "executing",
          errorCode: null,
          markSubmitStarted: false,
          preparedSnapshot: true,
        },
        {
          status: "executing",
          errorCode: null,
          markSubmitStarted: true,
          preparedSnapshot: false,
        },
        {
          status: "reconcile_required",
          errorCode: "submit_state_unknown",
          markSubmitStarted: false,
          preparedSnapshot: false,
        },
      ]);
      assert.match(
        telegram.callbackAnswers[0]?.text ?? "",
        /status is unknown/i,
      );
      assert.match(telegram.messages[0]?.text ?? "", /status is unknown/i);
    },
  },
  {
    name: "Telegram bot trading requires both reconciliation jobs",
    run: async () => {
      assert.equal(
        isTelegramBotTradingReconciliationEnabled({
          financeDbReconcileEnabled: true,
          venueReconcileEnabled: true,
        }),
        true,
      );
      assert.equal(
        isTelegramBotTradingReconciliationEnabled({
          financeDbReconcileEnabled: false,
          venueReconcileEnabled: true,
        }),
        false,
      );
      assert.equal(
        isTelegramBotTradingReconciliationEnabled({
          financeDbReconcileEnabled: true,
          venueReconcileEnabled: false,
        }),
        false,
      );
      const enabledCalls: string[] = [];
      await reconcileTelegramBotTradingStatus({
        reconciliationEnabled: true,
        reconcileLocal: async () => {
          enabledCalls.push("local");
        },
        reconcileVenue: async () => {
          enabledCalls.push("venue");
        },
      });
      assert.deepEqual(enabledCalls, ["local", "venue"]);
      const disabledCalls: string[] = [];
      await reconcileTelegramBotTradingStatus({
        reconciliationEnabled: false,
        reconcileLocal: async () => {
          disabledCalls.push("local");
        },
        reconcileVenue: async () => {
          disabledCalls.push("venue");
        },
      });
      assert.deepEqual(disabledCalls, ["local"]);
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
    name: "signal bot trading policy preserves explicitly configured actions",
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
      assert.equal(sellOnlyActions.requireConfirmation, true);

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

      const emptyPresets = normalizeSignalBotPolicy({
        tradingEnabled: true,
        tradingActions: ["buy"],
        tradingVenues: ["polymarket"],
        buyAmountPresetsUsd: [],
        maxTradeAmountUsd: 50,
        maxSlippageBps: 500,
        intentTtlSec: 120,
        requireConfirmation: true,
      });
      assert.deepEqual(emptyPresets.buyAmountPresetsUsd, []);

      const buyAndSellActions = normalizeSignalBotPolicy({
        tradingEnabled: true,
        tradingActions: ["buy", "sell"],
        tradingVenues: ["polymarket"],
        buyAmountPresetsUsd: [10],
        maxTradeAmountUsd: 50,
        maxSlippageBps: 500,
        intentTtlSec: 120,
        requireConfirmation: false,
      });
      assert.deepEqual(buyAndSellActions.tradingActions, ["buy", "sell"]);
      assert.equal(buyAndSellActions.requireConfirmation, true);
    },
  },
  {
    name: "Telegram SELL callbacks reuse fixed shares until the final fresh prepare check",
    run: () => {
      const market = {
        id: "market-1",
        venue: "polymarket",
        venue_market_id: "venue-market-1",
        event_id: "event-1",
        event_title: "Event",
        title: "Market",
        status: "ACTIVE",
        outcomes: ["YES", "NO"],
        metadata: {},
        token_yes: "token-yes",
        token_no: "token-no",
      } as never;
      const intent = telegramBotTradingTestHooks.buildTelegramSellTradeIntent({
        authorization: {
          id: "authorization-1",
          user_id: "user-1",
          telegram_user_id: "999",
          privy_user_id: "privy-1",
          wallet_address: "0x0000000000000000000000000000000000000001",
          wallet_chain: "ethereum",
          privy_wallet_id: "wallet-1",
          enabled: true,
          enabled_venues: ["polymarket"],
          limits: {},
          max_amount_usd: "2",
        },
        intentId: "00000000-0000-4000-8000-000000000001",
        market,
        maxSlippageBps: 500,
        sharesRaw: 4_750_001n,
        side: "YES",
      });

      assert.equal(intent.action, "SELL");
      assert.ok(intent.raw && typeof intent.raw === "object");
      const raw = intent.raw as Record<string, unknown>;
      assert.equal(raw.sharesRaw, "4750001");
      assert.equal(raw.availableSharesRaw, "4750001");
      assert.equal(
        telegramBotTradingTestHooks.marketForCallbackReadiness("SELL", market),
        null,
      );
      assert.equal(
        telegramBotTradingTestHooks.marketForCallbackReadiness("BUY", market),
        market,
      );
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
      const runnerSource = readFileSync(
        resolve(apiSrcDir, "signal-bot-runner.ts"),
        "utf8",
      );
      assert.match(
        runnerSource,
        /createSignalBotTelegramTransport\(telegram\)/,
      );
      assert.match(runnerSource, /transports:\s*signalTransports/);
      assert.match(
        runnerSource,
        /publishSignalBotFollowthroughTick\([\s\S]*?transports:\s*signalTransports/,
      );
      assert.doesNotMatch(runnerSource, /create(?:Discord|X)SignalTransport/);
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
    name: "guest start and menu commands render only the onboarding Mini App CTA",
    run: async () => {
      for (const command of ["/start", "/menu"]) {
        const redis = new FakeRedis();
        const telegram = new FakeTelegram();
        const handled = await handleSignalBotCommand({
          config: parseSignalBotConfig({
            HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
            HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE:
              "https://t.me/hunch_bot/hunch",
            HUNCH_SIGNAL_BOT_TOKEN: "token",
          }),
          db: {
            query: async () => ({ rows: [] }),
          } as never,
          message: {
            chat: { id: 999, first_name: "Public user", type: "private" },
            from: { id: 999 },
            text: command,
          },
          redis,
          sendMessage: (message) => telegram.sendMessage(message),
          sendTestSignal: async () => false,
        });
        assert.equal(handled, true);
        const message = telegram.messages[0];
        assert.ok(message?.reply_markup);
        assert.match(message.text, /Welcome to Hunch/);
        assert.match(message.text, /enable Telegram Trading in Hunch/);
        const buttons = message.reply_markup.inline_keyboard.flat();
        assert.equal(buttons.length, 1);
        assert.equal(buttons[0]?.text, "Open Hunch · Create or sign in");
        assert.equal(buttons[0] && "web_app" in buttons[0], true);
        assert.doesNotMatch(
          message.text,
          /\/(?:menu|market|trade_status|settings|help)/,
        );
      }
    },
  },
  {
    name: "menu callbacks answer immediately and edit one navigation message",
    run: async () => {
      const redis = new FakeRedis();
      const telegram = new FakeTelegram();
      const config = parseSignalBotConfig({
        HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
        HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE:
          "https://t.me/hunch_bot/hunch",
        HUNCH_SIGNAL_BOT_TOKEN: "token",
      });
      const handled = await handleSignalBotMenuCallback({
        callbackQuery: {
          data: "hm:v1:trading",
          from: { id: 999 },
          id: "menu-callback-1",
          message: {
            chat: { id: 999, type: "private" },
            message_id: 50,
          },
        },
        config,
        db: {
          query: async () => ({ rows: [{ linked: true }] }),
        } as never,
        redis,
        sendTestSignal: async () => false,
        telegram,
      });
      assert.equal(handled, true);
      assert.deepEqual(telegram.callbackAnswers, [
        { callbackQueryId: "menu-callback-1" },
      ]);
      assert.equal(telegram.edits.length, 1);
      assert.equal(telegram.edits[0]?.message_id, 50);
      assert.match(telegram.edits[0]?.text ?? "", /My trading/);
      assert.equal(
        telegram.edits[0]?.reply_markup?.inline_keyboard
          .flat()
          .some(
            (button) =>
              "callback_data" in button &&
              button.callback_data === "hm:v1:home" &&
              button.text === "◀ Back",
          ),
        true,
      );
      assert.equal(telegram.messages.length, 0);
    },
  },
  {
    name: "notification menu callbacks load and persist user toggles",
    run: async () => {
      const redis = new FakeRedis();
      const telegram = new FakeTelegram();
      let orderFilled = true;
      const db = {
        query: async (sql: string, params: unknown[] = []) => {
          if (sql.includes("select exists")) {
            return { rows: [{ linked: true }] };
          }
          if (sql.includes("update telegram_notification_preferences")) {
            orderFilled = params[1] === true;
          }
          return {
            rows: [
              {
                bridge_updates: true,
                deposit_received: true,
                order_filled: orderFilled,
                order_issues: true,
                payouts_rewards: true,
                position_resolved: true,
                position_signals: true,
                reachable: true,
                user_id: "user-1",
              },
            ],
          };
        },
      } as never;
      const config = parseSignalBotConfig({
        HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE:
          "https://t.me/hunch_bot/hunch",
        HUNCH_SIGNAL_BOT_TOKEN: "token",
      });
      const callback = (
        data: string,
        id: string,
      ): TelegramBotCallbackQuery => ({
        data,
        from: { id: 999 },
        id,
        message: { chat: { id: 999, type: "private" }, message_id: 80 },
      });

      await handleSignalBotMenuCallback({
        callbackQuery: callback(
          "hm:v1:settings:notifications",
          "notification-screen",
        ),
        config,
        db,
        redis,
        sendTestSignal: async () => false,
        telegram,
      });
      assert.equal(
        telegram.edits
          .at(-1)
          ?.reply_markup?.inline_keyboard.flat()
          .some((button) => button.text === "📈 Trading · 3/3 on"),
        true,
      );

      await handleSignalBotMenuCallback({
        callbackQuery: callback(
          "hm:v1:settings:notifications:trading",
          "notification-trading",
        ),
        config,
        db,
        redis,
        sendTestSignal: async () => false,
        telegram,
      });
      assert.equal(
        telegram.edits
          .at(-1)
          ?.reply_markup?.inline_keyboard.flat()
          .some((button) => button.text === "✅ Order fills"),
        true,
      );

      await handleSignalBotMenuCallback({
        callbackQuery: callback("hm:v1:ntf:fill:off", "notification-set"),
        config,
        db,
        redis,
        sendTestSignal: async () => false,
        telegram,
      });
      assert.equal(
        telegram.edits
          .at(-1)
          ?.reply_markup?.inline_keyboard.flat()
          .some((button) => button.text === "⬜ Order fills"),
        true,
      );
    },
  },
  {
    name: "stale and unauthorized menu callbacks recover to a usable home screen",
    run: async () => {
      const config = parseSignalBotConfig({
        HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
        HUNCH_SIGNAL_BOT_TOKEN: "token",
      });
      for (const data of ["hm:v0:home", "hm:v1:admin"]) {
        const redis = new FakeRedis();
        const telegram = new FakeTelegram();
        const handled = await handleSignalBotMenuCallback({
          callbackQuery: {
            data,
            from: { id: 999 },
            id: "menu-callback",
            message: {
              chat: { id: 999, type: "private" },
              message_id: 51,
            },
          },
          config,
          db: {
            query: async () => ({ rows: [{ linked: true }] }),
          } as never,
          redis,
          sendTestSignal: async () => false,
          telegram,
        });
        assert.equal(handled, true);
        assert.equal(telegram.edits.length, 1);
        assert.match(telegram.edits[0]?.text ?? "", /Hunch/);
        const labels =
          telegram.edits[0]?.reply_markup?.inline_keyboard
            .flat()
            .map((button) => button.text) ?? [];
        assert.equal(labels.includes("🔎 Markets"), true);
        assert.equal(labels.includes("🛠 Admin"), false);
      }

      const guestTelegram = new FakeTelegram();
      await handleSignalBotMenuCallback({
        callbackQuery: {
          data: "hm:v0:home",
          from: { id: 998 },
          id: "guest-stale-menu-callback",
          message: {
            chat: { id: 998, type: "private" },
            message_id: 52,
          },
        },
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE:
            "https://t.me/hunch_bot/hunch",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db: {
          query: async () => ({ rows: [] }),
        } as never,
        redis: new FakeRedis(),
        sendTestSignal: async () => false,
        telegram: guestTelegram,
      });
      const guestHome = guestTelegram.edits[0];
      assert.match(guestHome?.text ?? "", /Welcome to Hunch/);
      assert.deepEqual(
        guestHome?.reply_markup?.inline_keyboard.flat().map(({ text }) => text),
        ["Open Hunch · Create or sign in"],
      );
    },
  },
  {
    name: "market input flow accepts a link without a slash command and supports cancel",
    run: async () => {
      const redis = new FakeRedis();
      const telegram = new FakeTelegram();
      const config = parseSignalBotConfig({
        HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
        HUNCH_SIGNAL_BOT_TOKEN: "token",
      });
      const db = {
        query: async () => ({ rows: [{ linked: true }] }),
      } as never;
      const callbackQuery: TelegramBotCallbackQuery = {
        data: "hm:v1:trading:market_input",
        from: { id: 999 },
        id: "market-input",
        message: {
          chat: { id: 999, type: "private" },
          message_id: 60,
        },
      };
      assert.equal(
        await handleSignalBotMenuCallback({
          callbackQuery,
          config,
          db,
          redis,
          sendTestSignal: async () => false,
          telegram,
        }),
        true,
      );
      assert.match(telegram.edits.at(-1)?.text ?? "", /markets/i);
      let marketRequest:
        | {
            chatId: string;
            marketRef: string;
            publicBrowseOnly?: boolean;
            telegramMessageId?: number | null;
            telegramUserId: number;
          }
        | undefined;
      const handledInput = await handleSignalBotMenuInput({
        config,
        db,
        message: {
          chat: { id: 999, type: "private" },
          from: { id: 999 },
          message_id: 61,
          text: "https://polymarket.com/event/test-market",
        },
        redis,
        loadMarketCard: async (request) => {
          marketRequest = request;
          return { text: "Test market card" };
        },
        telegram,
      });
      assert.equal(handledInput, true);
      assert.deepEqual(marketRequest, {
        chatId: "999",
        marketRef: "https://polymarket.com/event/test-market",
        publicBrowseOnly: false,
        telegramMessageId: 101,
        telegramUserId: 999,
      });
      assert.match(telegram.messages.at(-1)?.text ?? "", /Searching/);
      assert.match(telegram.edits.at(-1)?.text ?? "", /Test market card/);

      marketRequest = undefined;
      await handleSignalBotMenuInput({
        config,
        db: {
          query: async () => ({ rows: [] }),
        } as never,
        message: {
          chat: { id: 998, type: "private" },
          from: { id: 998 },
          text: "12345",
        },
        redis,
        loadMarketCard: async (request) => {
          marketRequest = request;
          return { text: "Public market card" };
        },
        telegram,
      });
      assert.equal(
        (marketRequest as { publicBrowseOnly?: boolean } | undefined)
          ?.publicBrowseOnly,
        true,
      );

      assert.equal(
        await handleSignalBotMenuInput({
          config,
          message: {
            chat: { id: 999, type: "private" },
            from: { id: 999 },
            text: "another-market",
          },
          redis,
          telegram,
        }),
        true,
      );

      await handleSignalBotMenuCallback({
        callbackQuery,
        config,
        db,
        redis,
        sendTestSignal: async () => false,
        telegram,
      });
      await handleSignalBotMenuCallback({
        callbackQuery: {
          ...callbackQuery,
          data: "hm:v1:trading:cancel_input",
          id: "market-input-cancel",
        },
        config,
        db,
        redis,
        sendTestSignal: async () => false,
        telegram,
      });
      assert.match(telegram.edits.at(-1)?.text ?? "", /input cancelled/i);
      assert.equal(
        await handleSignalBotMenuInput({
          config,
          message: {
            chat: { id: 999, type: "private" },
            from: { id: 999 },
            text: "market-after-cancel",
          },
          redis,
          telegram,
        }),
        true,
      );
    },
  },
  {
    name: "public start and help are Mini App aware and expose no slash commands",
    run: async () => {
      for (const command of ["/start", "/help"]) {
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
            text: command,
          },
          redis,
          sendMessage: (message) => telegram.sendMessage(message),
          sendTestSignal: async () => false,
        });
        assert.equal(handled, true);
        const text = telegram.messages[0]?.text ?? "";
        assert.match(text, /Hunch Signal Bot/);
        assert.match(text, /Hunch Mini App/);
        assert.doesNotMatch(text, /Commands/);
        assert.doesNotMatch(
          text,
          /\/(?:start|help|status|trade|market|disable|enable|stats|test)/,
        );
      }
    },
  },
  {
    name: "public users cannot execute admin signal commands",
    run: async () => {
      const commands = [
        "/enable_signals",
        "/disable_signals",
        "/status",
        "/stats",
        "/test_followthrough stats",
        "/test_signal",
        "/test_trade polymarket:market-1",
      ];
      for (const command of commands) {
        const redis = new FakeRedis();
        const telegram = new FakeTelegram();
        let sideEffects = 0;
        const handled = await handleSignalBotCommand({
          config: parseSignalBotConfig({
            HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
            HUNCH_SIGNAL_BOT_TOKEN: "token",
          }),
          disableTrading: async () => {
            sideEffects += 1;
            return "disabled";
          },
          message: {
            chat: { id: 999, first_name: "Public user", type: "private" },
            from: { id: 999 },
            text: command,
          },
          redis,
          sendMessage: (message) => telegram.sendMessage(message),
          sendStatsReport: async () => {
            sideEffects += 1;
            return true;
          },
          sendTestFollowthrough: async () => {
            sideEffects += 1;
            return true;
          },
          sendTestSignal: async () => {
            sideEffects += 1;
            return true;
          },
          sendTradeMarket: async () => {
            sideEffects += 1;
            return true;
          },
          sendTradeStatus: async () => {
            sideEffects += 1;
            return true;
          },
        });
        assert.equal(handled, true);
        assert.equal(sideEffects, 0);
        assert.equal(await getSignalBotChatState(redis, "999"), null);
        assert.match(telegram.messages[0]?.text ?? "", /Not authorized/);
      }
    },
  },
  {
    name: "linked users can use personal trading intents without admin access",
    run: async () => {
      const redis = new FakeRedis();
      const telegram = new FakeTelegram();
      const linkedDb = {
        query: async () => ({ rows: [{ linked: true }] }),
      } as never;
      let marketCalls = 0;
      let publicBrowseOnly: boolean | undefined;
      const marketHandled = await handleSignalBotCommand({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db: linkedDb,
        message: {
          chat: { id: 999, first_name: "Public user", type: "private" },
          from: { id: 999 },
          message_id: 77,
          text: "/market polymarket:market-1",
        },
        redis,
        sendMessage: (message) => telegram.sendMessage(message),
        sendTestSignal: async () => false,
        sendTradeMarket: async (input) => {
          marketCalls += 1;
          publicBrowseOnly = input.publicBrowseOnly;
          return true;
        },
      });
      assert.equal(marketHandled, true);
      assert.equal(marketCalls, 1);
      assert.equal(publicBrowseOnly, false);
      assert.equal(telegram.messages.length, 0);

      let statusCalls = 0;
      const statusHandled = await handleSignalBotCommand({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db: linkedDb,
        message: {
          chat: { id: 999, first_name: "Public user", type: "private" },
          from: { id: 999 },
          text: "/trade_status",
        },
        redis,
        sendMessage: (message) => telegram.sendMessage(message),
        sendTestSignal: async () => false,
        sendTradeStatus: async () => {
          statusCalls += 1;
          return true;
        },
      });
      assert.equal(statusHandled, true);
      assert.equal(statusCalls, 1);
    },
  },
  {
    name: "guest personal commands cannot bypass onboarding or expose trading actions",
    run: async () => {
      const redis = new FakeRedis();
      const config = parseSignalBotConfig({
        HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
        HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE:
          TEST_TELEGRAM_MINI_APP_LINK_BASE,
        HUNCH_SIGNAL_BOT_TOKEN: "token",
      });
      const guestDb = {
        query: async () => ({ rows: [{ linked: false }] }),
      } as never;
      let publicBrowseOnly: boolean | undefined;
      await handleSignalBotCommand({
        config,
        db: guestDb,
        message: {
          chat: { id: 999, first_name: "Guest", type: "private" },
          from: { id: 999 },
          text: "/market polymarket:market-1",
        },
        redis,
        sendMessage: async () => {
          throw new Error("guest market should render through the market hook");
        },
        sendTestSignal: async () => false,
        sendTradeMarket: async (input) => {
          publicBrowseOnly = input.publicBrowseOnly;
          return true;
        },
      });
      assert.equal(publicBrowseOnly, true);

      for (const command of ["/trade_status", "/disable_trading"]) {
        const telegram = new FakeTelegram();
        let personalActionCalls = 0;
        await handleSignalBotCommand({
          config,
          db: guestDb,
          disableTrading: async () => {
            personalActionCalls += 1;
            return "disabled";
          },
          message: {
            chat: { id: 999, first_name: "Guest", type: "private" },
            from: { id: 999 },
            text: command,
          },
          redis,
          sendMessage: (message) => telegram.sendMessage(message),
          sendTestSignal: async () => false,
          sendTradeStatus: async () => {
            personalActionCalls += 1;
            return true;
          },
        });
        assert.equal(personalActionCalls, 0);
        assert.match(telegram.messages[0]?.text ?? "", /Welcome to Hunch/);
        assert.equal(
          telegram.messages[0]?.reply_markup?.inline_keyboard.flat().length,
          1,
        );
      }
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
          HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE:
            TEST_TELEGRAM_MINI_APP_LINK_BASE,
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
      assert.match(text, /Hunch Signal Bot/);
      assert.match(text, /Admin controls/);
      assert.match(text, /enable\\_signals/);
      assert.match(text, /trade\\_status/);
      assert.match(text, /\/market/);
      assert.match(text, /disable\\_trading/);
      assert.match(text, /test\\_followthrough/);
      assert.match(text, /test\\_signal/);
      assert.match(text, /open the Hunch Mini App/);
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
    name: "status reports enabled state without an independent confidence gate",
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
      assert.doesNotMatch(telegram.messages[0]?.text ?? "", /Min confidence/i);
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
    name: "message uses Buy as the only CTA when trading is available",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note(),
      });
      const rows = message.keyboard?.inline_keyboard ?? [];
      assert.equal(rows[0]?.[0]?.text, "🟠 Buy YES · Poly 32¢");
      assert.equal(
        decodeStartAppPayload(readStartAppParam(rows[0]?.[0]?.url)),
        "p:event-1|market-1|Y|10",
      );
      assert.equal(rows.length, 1);
      assert.doesNotMatch(
        rows
          .flat()
          .map((button) => button.text)
          .join(" "),
        /Wallet|Open market/,
      );
      assert.match(message.text, /^\*💰 \$12\\\.3K backs YES on /);
      assert.match(message.text.split("\n")[0] ?? "", /at 31¢\*$/);
      assert.doesNotMatch(message.text.split("\n")[0] ?? "", /\]\(/);
      assert.doesNotMatch(message.text, /📍/);
      assert.doesNotMatch(message.text, /YES 31¢ \/ NO 69¢/);
      assert.doesNotMatch(message.text, /🎯 82%/);
      assert.doesNotMatch(message.text, /this wallet is still holding/i);
      assert.match(message.text, />\*Wallet edge\*\n>/);
      assert.doesNotMatch(
        message.text,
        /Why this wallet matters|Why this cluster matters/,
      );
      assert.match(message.text, /▸ PnL.*2\\.5K.*30d/);
      assert.doesNotMatch(message.text, /▸ Win rate|65%.*recent trades/);
      assert.doesNotMatch(message.text, /sample count|resolved edge|n=/i);
      assert.doesNotMatch(message.text, /📰/);
      assert.doesNotMatch(message.text, /confidence/i);
    },
  },
  {
    name: "message strips leading at-sign from holder identity mentions",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({
          description:
            "@Valen9 is fading the deadline while positioning is noisy.",
          direction: "down",
          holderDisplayName: "Valen9",
          holderIdentityDisplayName: "@Valen9",
          holderSide: "NO",
          modelMeta: {
            external_research: {
              summary: "Public news does not explain @Valen9 positioning.",
            },
          },
          title: "Valen9 fades Iran withdrawal deadline risk",
        }),
      });

      assert.doesNotMatch(message.text, /@Valen9/);
      assert.match(message.text, /Valen9/);
      assert.doesNotMatch(message.text, /is still holding NO/i);
      assert.doesNotMatch(message.text, /Public news does not explain/);
    },
  },
  {
    name: "initial named outcome keeps matchup context and removes duplicate prose",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({
          bestAsk: 0.6,
          bestBid: 0.58,
          description:
            "Spain trades near 59c to get past Argentina, and this wallet is holding the Spain side with an entry around current levels. Its recent market-price record makes this worth a look now.",
          eventTitle: "Spain vs Argentina",
          holderCredentialBullets: [
            "Up $1.4M over the last 30 days",
            "Beat market prices by 23.3 points across 46 resolved bets",
            "Traded $3.2M over the last 30 days",
          ],
          holderPositionUsd: 23_300,
          marketTitle: "Spain",
          outcomes: ["Spain", "Argentina"],
          signalPriceSnapshotV1: {
            ...testSignalPriceSnapshot("YES"),
            displayPrice: 0.59,
            YES: { ask: 0.6, bid: 0.58, mark: 0.59 },
          },
          telegramMarketIdentityV1: {
            ...testSignalIdentity("YES"),
            eventTitle: "Spain vs Argentina",
            marketGroupItemTitle: "Spain",
            marketQuestion: "Spain",
            predicate: "Spain wins against Argentina",
            selectedSideLabel: "Spain",
            subject: "Spain vs Argentina",
          },
        }),
      });

      assert.match(
        message.text.split("\n")[0] ?? "",
        /^\*💰 \$23\\\.3K backs Spain over Argentina at 59¢\*$/,
      );
      assert.doesNotMatch(
        message.text,
        /trades near 59|holding the Spain side/i,
      );
      assert.doesNotMatch(message.text, /worth a look/i);
      assert.match(message.text, /\n\u2800\n>\*Wallet edge\*\n>\u2800\n/);
      assert.match(message.text, /▸ PnL.*1\\\.4M.*30d/);
      assert.match(message.text, /▸ Volume.*3\\\.2M.*30d/);
    },
  },
  {
    name: "message omits CTAs when Mini App base is unset",
    run: () => {
      const message = buildSignalBotMessageImpl({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note(),
      });
      const rows = message.keyboard?.inline_keyboard ?? [];
      assert.equal(rows.length, 0);
      assert.doesNotMatch(message.text, /https:\/\/app\.hunch\.trade/);
      assert.match(message.text, /Mini App temporarily unavailable/);
    },
  },
  {
    name: "message mentions cents naturally only when price is central",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({
          bestAsk: 0.03,
          bestBid: 0.02,
          description: "Morocco is a long shot, but the wallet is still there.",
          holderCredentialBullets: [
            "Up $1.3M over the last 30 days",
            "Beat market prices by 27 points across 21 resolved bets",
            "Still holding while the market barely prices it",
          ],
          marketTitle: "Morocco",
          title: "athelstan still has not sold Morocco",
        }),
      });
      assert.match(message.text.split("\n")[0] ?? "", /Morocco at 3¢\*$/);
      assert.match(message.text, /▸ PnL.*1.*3M.*30d/);
      assert.doesNotMatch(message.text, /Still holding while the market/);
      assert.doesNotMatch(message.text, /Beat resolved prices/);
      assert.doesNotMatch(message.text, /YES 2¢ \/ NO 98¢/);
    },
  },
  {
    name: "message uses Mini App links in CTA and contextual body links",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({
          description:
            "TestWallet is leaning YES on Will test resolve Yes? after a quiet repricing.",
          eventId: "polymarket:event-1",
          holderDisplayName: "TestWallet",
          marketId: "polymarket:market-1",
        }),
        telegramMiniAppLinkBase: "https://t.me/hunch_signal_bot/hunch",
      });
      const rows = message.keyboard?.inline_keyboard ?? [];
      assert.match(
        rows[0]?.[0]?.url ?? "",
        /^https:\/\/t\.me\/hunch_signal_bot\/hunch\?startapp=b_/,
      );
      assert.equal(rows.length, 1);
      assert.doesNotMatch(message.text, /https:\/\/app\.hunch\.trade/);
      assert.match(
        message.text,
        /\[Will test resolve Yes\?\]\(https:\/\/t\.me\/hunch_signal_bot\/hunch\?startapp=m_/,
      );
      assert.match(
        message.text,
        /\[TestWallet\]\(https:\/\/t\.me\/hunch_signal_bot\/hunch\?startapp=wt_/,
      );
      assert.doesNotMatch(message.text, /Market details|Wallet context/);
      assert.doesNotMatch(message.text.split("\n")[0] ?? "", /\]\(/);
      assert.equal(
        decodeStartAppPayload(readStartAppParam(rows[0]?.[0]?.url)),
        "p:event-1|market-1|Y|10",
      );
    },
  },
  {
    name: "message does not leak web fallbacks when Mini App payload is oversized",
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
      assert.equal(rows.length, 0);
      assert.doesNotMatch(message.text, /https:\/\/app\.hunch\.trade/);
      assert.doesNotMatch(message.text, /https:\/\/t\.me/);
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
      assert.doesNotMatch(single.text, /Strong holder · YES 31¢ \/ NO 69¢/);
      assert.doesNotMatch(single.text, /High conviction|Top signal/i);

      const cluster = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({
          holderActorMode: "sharp_cluster",
          modelMeta: { execution_priority: "high_conviction" },
        }),
      });
      assert.doesNotMatch(cluster.text, /Strong wallets · YES 31¢ \/ NO 69¢/);
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
      assert.equal(
        decodeStartAppPayload(readStartAppParam(rows[1]?.[0]?.url)),
        "k:event-1|market-1|Y|10",
      );
      assert.equal(rows.length, 2);
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
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.[0]?.text, "🟠 Buy YES · Poly 32¢");
    },
  },
  {
    name: "message keeps generic binary buttons as YES NO while market line carries title",
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
      assert.equal(rows[0]?.[0]?.text, "🟠 Buy YES · Poly 32¢");
      assert.equal(rows.length, 1);
      assert.doesNotMatch(message.text, /YES 31¢ \/ NO 69¢/);
    },
  },
  {
    name: "message renders totals as plain English sides",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({
          direction: "down",
          eventTitle: "Portugal vs Spain",
          holderSide: "NO",
          marketDescription:
            "Over if Portugal and Spain combine for 3 or more goals.",
          marketTitle: "O/U 2.5",
          outcomes: ["Over", "Under"],
        }),
      });
      const rows = message.keyboard?.inline_keyboard ?? [];
      assert.equal(
        rows[0]?.[0]?.text,
        "⚪ Buy Under 2.5 total goals · Poly 70¢",
      );
      assert.equal(rows.length, 1);
      assert.doesNotMatch(message.text, /This wins if/);
      assert.doesNotMatch(message.text, /Over 2\\.5 total goals 31¢/);
      assert.equal(message.text.includes("NO O/U 2.5"), false);
    },
  },
  {
    name: "message renders generic team NO as plain NO labels",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({
          direction: "down",
          eventTitle: "World Cup Winner",
          holderSide: "NO",
          marketTitle: "France",
        }),
      });
      const rows = message.keyboard?.inline_keyboard ?? [];
      assert.equal(rows[0]?.[0]?.text, "⚪ Buy NO · Poly 70¢");
      assert.equal(rows.length, 1);
      assert.doesNotMatch(rows[0]?.[0]?.text ?? "", /NO France/);
      assert.doesNotMatch(rows[0]?.[0]?.text ?? "", /not to win/);
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
      assert.doesNotMatch(message.text, /YES 31¢ \/ NO 69¢/);
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
        telegramMiniAppLinkBase: "https://t.me/hunch_signal_bot/hunch",
      });
      const firstLine = message.text.split("\n")[0] ?? "";
      const holderLinks =
        message.text.match(
          /\[TB14\]\(https:\/\/t\.me\/hunch_signal_bot\/hunch\?startapp=wt_/g,
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
        telegramMiniAppLinkBase: "https://t.me/hunch_signal_bot/hunch",
      });
      assert.doesNotMatch(message.text, /\$\[24124\]/);
      assert.doesNotMatch(message.text, /\[24124\]\.50/);
      assert.doesNotMatch(message.text, /\[24124\]%/);
      assert.match(
        message.text,
        /then \[24124\]\(https:\/\/t\.me\/hunch_signal_bot\/hunch\?startapp=wt_/,
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
          telegramMiniAppLinkBase: null,
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
        telegramMiniAppLinkBase: "https://t.me/hunch_signal_bot/hunch",
      });
      assert.match(
        message.text,
        /\[A\\_Bot\]\(https:\/\/t\.me\/hunch_signal_bot\/hunch\?startapp=wt_/,
      );
    },
  },
  {
    name: "message omits standalone time-left metadata",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({ closeTime: "2026-01-01T00:45:00.000Z" }),
      });
      assert.doesNotMatch(message.text, /⏳ 45m left/);
      assert.doesNotMatch(message.text, /YES 31¢ \/ NO 69¢/);
    },
  },
  {
    name: "message renders a structured subject and named outcome labels",
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
      assert.match(
        message.text.split("\n")[0] ?? "",
        /^\*💰 \$12\\\.3K backs Beta Team over Alpha Team in Game 1 at 69¢\*$/,
      );
      assert.doesNotMatch(message.text.split("\n")[0] ?? "", /\]\(/);
      assert.doesNotMatch(message.text, /Alpha Team 31¢ \/ Beta Team 69¢/);
      assert.equal(rows[0]?.[0]?.text, "⚪ Buy Beta Team · Poly 70¢");
      assert.equal(rows[1]?.[0]?.text, "💸 Cheaper: Kalshi Beta Team 48¢");
      assert.equal(rows.length, 2);
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
      assert.doesNotMatch(message.text, /VLA 31¢ \/ VLB 69¢/);
      assert.equal(rows[0]?.[0]?.text, "⚪ Buy VLB · Poly 70¢");
      assert.equal(rows.length, 1);
    },
  },
  {
    name: "message does not append external research as a detached footer",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({
          description: "The holder added after a quiet repricing.",
          modelMeta: {
            external_research: {
              summary:
                "**Public previews (Mexico -115 to win, predictions like 0-2 Mexico) preceded/coincided with sharp NO activity; positioning is contrarian to favorites.**[[1]](https://www.cbssports.com/soccer/news/mexico-vs-czechia)[[2]](https://www.usatoday.c...",
            },
          },
        }),
      });

      assert.doesNotMatch(message.text, /📰|Public previews|https?:/);
      assert.match(message.text, />\*Wallet edge\*/);
    },
  },
  {
    name: "research update renders a compact position and omits missing-evidence boilerplate",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        messageKind: "research_update",
        note: note({
          bestAsk: 0.18,
          bestBid: 0.17,
          description:
            "The market now gives Bitcoin hitting 70k about 18%, and gmtrader is still holding NO after the drop.",
          direction: "down",
          eventTitle: "What price will Bitcoin hit in July?",
          holderCredentialBullets: [],
          holderDisplayName: "gmtrader",
          holderIdentityDisplayName: "gmtrader",
          holderOpenPnlUsd: 829,
          holderPositionUsd: 7_500,
          holderSide: "NO",
          marketTitle: "↑ 70,000",
          meaningfulDeltaReasons: ["odds_move"],
          decisionSnapshot: researchSnapshot({ yesProbability: 0.17 }),
          previousDecisionSnapshot: researchSnapshot({
            yesProbability: 0.25,
          }),
          metrics: {
            signalEvidenceVersion: 1,
            signalEvidence: [
              {
                asOf: "2026-07-17T00:00:00.000Z",
                context: null,
                horizonDays: 30,
                id: "representative_wallet:pricing_edge:30d",
                kind: "pricing_edge",
                measurement: {
                  kind: "scalar",
                  unit: "probability",
                  value: 0.16,
                },
                quality: "verified",
                sampleSize: 38,
                scope: "representative_wallet",
                source: {
                  kind: "hunch_wallet_intel",
                  label: "Representative wallet",
                  url: null,
                },
              },
              {
                asOf: "2026-07-17T00:00:00.000Z",
                context: null,
                horizonDays: 30,
                id: "representative_wallet:track_record:30d",
                kind: "track_record",
                measurement: {
                  kind: "scalar",
                  unit: "usd",
                  value: 118_000,
                },
                quality: "verified",
                sampleSize: null,
                scope: "representative_wallet",
                source: {
                  kind: "hunch_wallet_intel",
                  label: "Representative wallet",
                  url: null,
                },
              },
              {
                asOf: "2026-07-17T00:00:00.000Z",
                context: null,
                horizonDays: 30,
                id: "representative_wallet:volume:30d",
                kind: "volume",
                measurement: {
                  kind: "scalar",
                  unit: "usd",
                  value: 379_000,
                },
                quality: "verified",
                sampleSize: null,
                scope: "representative_wallet",
                source: {
                  kind: "hunch_wallet_intel",
                  label: "Representative wallet",
                  url: null,
                },
              },
            ],
          },
          modelMeta: {
            external_research: {
              summary: "No cited external evidence was available.",
            },
          },
          revisionKind: "research_update",
        }),
        telegramMiniAppLinkBase: "https://t.me/your_hunch_bot",
      });

      assert.match(
        message.text.split("\n")[0] ?? "",
        /^\*📈 NO on BTC hitting \$70K in July rises 8¢ to 83¢\*$/,
      );
      assert.ok(
        message.text.includes(
          "*Wallet now*: $7\\.5K on NO at 83¢ · Est\\. open PnL \\+$829",
        ),
      );
      assert.equal(message.publishable, true);
      assert.doesNotMatch(message.text, /Beat resolved prices|Wallet edge/);
      assert.doesNotMatch(
        message.text,
        /New research|holding fading|after the drop|market now gives/i,
      );
      assert.doesNotMatch(message.text, /No cited external evidence|📰/i);
    },
  },
  {
    name: "research update is suppressed without a supported comparable delta",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        messageKind: "research_update",
        note: note({ revisionKind: "research_update" }),
      });
      assert.equal(message.publishable, false);
      assert.equal(message.text, "");
      assert.equal(message.keyboard, undefined);
    },
  },
  {
    name: "weak initial watch copy stays available privately but is suppressed in public destinations",
    run: () => {
      const weakNote = note({
        holderActorMode: null,
        holderCredentialBullets: [],
        holderPositionUsd: null,
      });
      const privateMessage = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        chatType: "private",
        note: weakNote,
      });
      const publicMessage = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        chatType: "channel",
        note: weakNote,
      });
      assert.equal(privateMessage.publishable, true);
      assert.equal(publicMessage.publishable, false);
      assert.equal(publicMessage.text, "");
    },
  },
  {
    name: "market-wide fresh flow and opposite-side movement do not become directional updates",
    run: () => {
      for (const meaningfulDeltaReasons of [
        ["fresh_flow"],
        ["side_exposure_move:NO"],
      ]) {
        const message = buildSignalBotMessage({
          appBaseUrl: "https://app.hunch.trade",
          buyAmountUsd: 10,
          messageKind: "research_update",
          note: note({
            decisionSnapshot: researchSnapshot({
              recentActivityUsd: 50_000,
              side: "YES",
              yesProbability: 0.32,
              yesUsd: 12_000,
            }),
            meaningfulDeltaReasons,
            previousDecisionSnapshot: researchSnapshot({
              side: "YES",
              yesProbability: 0.32,
              yesUsd: 12_000,
            }),
            revisionKind: "research_update",
          }),
        });
        assert.equal(message.publishable, false);
      }
    },
  },
  {
    name: "positive research position delta can carry a Buy CTA without repeating credentials",
    run: () => {
      const message = buildSignalBotMessage({
        allowBuyCta: true,
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        messageKind: "research_update",
        note: note({
          decisionSnapshot: researchSnapshot({
            holderPositionUsd: 20_000,
            side: "YES",
            yesProbability: 0.32,
            yesUsd: 20_000,
          }),
          meaningfulDeltaReasons: ["holder_position_move:YES"],
          previousDecisionSnapshot: researchSnapshot({
            holderPositionUsd: 12_000,
            side: "YES",
            yesProbability: 0.32,
            yesUsd: 12_000,
          }),
          revisionKind: "research_update",
        }),
      });
      assert.match(message.text.split("\n")[0] ?? "", /^\*💰 \$8K added to/);
      assert.equal(
        message.keyboard?.inline_keyboard[0]?.[0]?.text,
        "🟠 Buy YES · Poly 32¢",
      );
      assert.doesNotMatch(
        message.text,
        /Wallet edge|▸ PnL|Beat resolved prices/,
      );
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
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.[0]?.text, "🟠 Buy YES · Poly 32¢");
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
      assert.equal(rows.length, 1);
      assert.match(
        message.text.split("\n")[0] ?? "",
        /^\*🎯 2 strong wallets back YES on .* at 31¢\*$/,
      );
      assert.doesNotMatch(message.text, /YES 31¢ \/ NO 69¢/);
      assert.match(message.text, />\*The edge\*\n>/);
      assert.doesNotMatch(message.text, /remain aligned behind/);
      assert.doesNotMatch(message.text, /\$12\\.3K still on/);
      assert.doesNotMatch(message.text, /Why this cluster matters:/);
      assert.match(message.text, /▸ PnL.*14K.*30d/);
      assert.match(message.text, /▸ Conviction.*2 strong wallets/);
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
      assert.doesNotMatch(message.text, /YES 31¢ \/ NO 69¢/);
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
      assert.match(
        message.text,
        /^\*💰 \$12\\\.3K backs YES on Same market title at 31¢\*/,
      );
      assert.doesNotMatch(message.text.split("\n")[0] ?? "", /\]\(/);
      assert.doesNotMatch(
        message.text,
        /Same market title · Same market title/,
      );
    },
  },
  {
    name: "message ignores detached external summary and internal rationale",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({
          description: "The holder added after a quiet repricing.",
          modelMeta: {
            external_research: {
              summary:
                "Public deal and early traffic spikes preceded the holder activity; full recovery is still uncertain.",
            },
          },
          rationale: "Publishable because this is internal decision text.",
        }),
      });
      assert.doesNotMatch(
        message.text,
        /Public deal and early traffic spikes|📰/,
      );
      assert.doesNotMatch(message.text, /Publishable because/);
    },
  },
  {
    name: "message keeps integrated public context sentence from being clipped",
    run: () => {
      const message = buildSignalBotMessage({
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        note: note({
          description:
            "Public pickup reports (Al Arabiya/Reuters June 23: 36 transits, avg rising to 21-27 post-June 14 deal) coincide with holder activity and partially explain the move.",
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
      assert.equal(rows.length, 2);
      assert.equal(
        decodeStartAppPayload(readWebAppStartParam(rows[0]?.[0])),
        "p:event-1|market-1|Y|10",
      );
      assert.equal(
        decodeStartAppPayload(readWebAppStartParam(rows[1]?.[0])),
        "k:event-1|market-1|Y|10",
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
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.[0]?.text, "🟠 Buy YES · Poly 32¢");
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
      assert.doesNotMatch(report, /High conviction|conviction/i);
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
      assert.doesNotMatch(report, /By conviction|High conviction/i);
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
      assert.doesNotMatch(queries[0]?.sql ?? "", /n\.confidence >=/);
      assert.doesNotMatch(queries[0]?.sql ?? "", /n\.status = 'active'/);
      assert.match(queries[0]?.sql ?? "", /sbm\.message_kind = 'initial'/);
      assert.match(queries[0]?.sql ?? "", /n\.direction in \('up', 'down'\)/);
      assert.equal(queries[0]?.params.includes(0.7), false);
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
      });
      assert.equal(notes[0]?.holderDisplayName, "TB14");
      assert.equal(notes[0]?.holderIdentityDisplayName, "@TB14");
      const sql = db.queries[0]?.sql ?? "";
      assert.match(sql, /join wallets w on w\.id = t\.target_id::uuid/);
      assert.match(sql, /m\.venue as market_venue/);
      assert.match(sql, /publicationDecisionV1/);
      assert.doesNotMatch(sql, /coalesce\(n\.confidence|and n\.confidence/);
      assert.doesNotMatch(sql, /previous_note|previous_decision_snapshot/);
      assert.doesNotMatch(sql, /accepting_orders/);
      assert.doesNotMatch(sql, /w\.id::text = t\.target_id/);
    },
  },
  {
    name: "publish keeps the primary CTA on the contract source market",
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
          HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE:
            TEST_TELEGRAM_MINI_APP_LINK_BASE,
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        redis,
        telegram,
      });
      assert.equal(result.cheaperAlternatives, 0);
      assert.equal(result.aggCheaperFound, 0);
      assert.equal(result.aggMatched, 0);
      assert.equal(result.sent, 1);
      assert.equal(
        telegram.messages[0]?.reply_markup?.inline_keyboard[0]?.[0]?.text,
        "🟠 Buy YES · Poly 32¢",
      );
    },
  },
  {
    name: "publish removes Buy from terminal-price notes and keeps Open market",
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
          ts: new Date().toISOString(),
        },
        {
          token_id: "no-token",
          best_bid: "0",
          best_ask: "0.01",
          ts: new Date().toISOString(),
        },
      ];
      const telegram = new FakeTelegram();
      const result = await publishSignalBotTick({
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE:
            TEST_TELEGRAM_MINI_APP_LINK_BASE,
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        redis,
        telegram,
      });

      assert.equal(result.sent, 1);
      assert.equal(result.priceGuardSkipped, 0);
      assert.equal(result.priceGuardTerminalPrice, 1);
      assert.equal(telegram.messages.length, 1);
      assert.equal(
        telegram.messages[0]?.reply_markup?.inline_keyboard[0]?.[0]?.text,
        "↗️ Open market",
      );
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
          ts: new Date().toISOString(),
        },
        {
          token_id: "no-token",
          best_bid: null,
          best_ask: null,
          ts: new Date().toISOString(),
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
        {
          id: "polymarket:market-2",
          venue: "polymarket",
          token_yes: "yes-token-2",
          token_no: "no-token-2",
          clob_token_ids: null,
          best_bid: "0.30",
          best_ask: "0.32",
          last_price: null,
        },
      ];
      db.tokenTopRows = [
        {
          token_id: "yes-token",
          best_bid: null,
          best_ask: null,
          ts: new Date().toISOString(),
        },
        {
          token_id: "no-token",
          best_bid: null,
          best_ask: null,
          ts: new Date().toISOString(),
        },
        {
          token_id: "yes-token-2",
          best_bid: "0.30",
          best_ask: "0.32",
          ts: new Date().toISOString(),
        },
        {
          token_id: "no-token-2",
          best_bid: "0.68",
          best_ask: "0.70",
          ts: new Date().toISOString(),
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

      db.rows.push(
        noteRow({
          id: "00000000-0000-4000-8000-000000000002",
          market_id: "polymarket:market-2",
          title: "Later valid signal",
        }),
      );

      const result = await publishSignalBotTick({
        config,
        db,
        redis,
        telegram,
      });
      assert.equal(result.priceGuardDeferred, 0);
      assert.equal(result.priceGuardStaleExpired, 1);
      assert.equal(result.sent, 1);
      assert.match(telegram.messages[0]?.text ?? "", /backs/);
      assert.doesNotMatch(
        telegram.messages[0]?.text ?? "",
        /Later valid signal/,
      );
      const state = await getSignalBotChatState(redis, "-100");
      assert.equal(state?.cursorId, "00000000-0000-4000-8000-000000000002");
    },
  },
  {
    name: "publish marker authorizes a note below the former confidence threshold",
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
          confidence: "0.67",
          id: "00000000-0000-4000-8000-000000000001",
          title: "Final publish decision",
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
      assert.equal(result.publishNotesSeen, 1);
      assert.equal(result.nonDirectionalNotes, 0);
      assert.equal(result.sent, 1);
      assert.match(telegram.messages[0]?.text ?? "", /backs/);
    },
  },
  {
    name: "publish ignores unversioned, context, and skip decisions",
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
        noteRow({ confidence: "0.99", metrics: {} }),
        noteRow({
          id: "00000000-0000-4000-8000-000000000002",
          metrics: {
            publicationDecisionV1: {
              authority: "holder_research_quality_gate",
              status: "CONTEXT",
              version: 1,
            },
          },
        }),
        noteRow({
          id: "00000000-0000-4000-8000-000000000003",
          metrics: {
            publicationDecisionV1: {
              authority: "holder_research_quality_gate",
              status: "SKIP",
              version: 1,
            },
          },
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
      assert.equal(result.publishNotesSeen, 0);
      assert.equal(result.sent, 0);
      assert.equal(telegram.messages.length, 0);
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
      assert.equal(result.publishNotesSeen, 1);
      assert.equal(result.sent, 1);
      assert.match(telegram.messages[0]?.text ?? "", /backs/);
      assert.doesNotMatch(telegram.messages[0]?.text ?? "", /Mixed context/);
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
      const recorded = readSignalBotMessageInsert(delivery);
      assert.match(String(recorded.id), /^[0-9a-f-]{36}$/i);
      assert.equal(recorded.chatId, "-100");
      assert.equal(recorded.noteId, "00000000-0000-4000-8000-000000000001");
      assert.equal(
        recorded.threadRootNoteId,
        "00000000-0000-4000-8000-000000000001",
      );
      assert.equal(recorded.messageKind, "initial");
      assert.equal(recorded.messageId, 101);
      assert.equal(recorded.replyToMessageId, null);
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
          decision_snapshot: researchSnapshot({
            side: "YES",
            yesProbability: 0.32,
          }),
          id: "00000000-0000-4000-8000-000000000002",
          meaningful_delta_reasons: ["odds_move"],
          previous_decision_snapshot: researchSnapshot({
            side: "YES",
            yesProbability: 0.28,
          }),
          revision_kind: "research_update",
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
          HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE:
            TEST_TELEGRAM_MINI_APP_LINK_BASE,
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        redis,
        telegram,
      });
      assert.equal(result.sent, 1);
      assert.equal(telegram.messages[0]?.reply_parameters?.message_id, 77);
      const updateButtons =
        telegram.messages[0]?.reply_markup?.inline_keyboard.flat() ?? [];
      assert.equal(
        updateButtons.some((button) => /Buy/i.test(button.text)),
        false,
      );
      assert.equal(
        updateButtons.some((button) => button.text === "↗️ Open market"),
        true,
      );
      const delivery = db.queries
        .filter((query) =>
          query.sql.includes("insert into signal_bot_messages"),
        )
        .at(-1);
      assert.ok(delivery);
      const recorded = readSignalBotMessageInsert(delivery);
      assert.equal(recorded.noteId, "00000000-0000-4000-8000-000000000002");
      assert.equal(
        recorded.threadRootNoteId,
        "00000000-0000-4000-8000-000000000001",
      );
      assert.equal(recorded.messageKind, "research_update");
      assert.equal(recorded.messageId, 101);
      assert.equal(recorded.replyToMessageId, 77);
    },
  },
  {
    name: "publish positive selected-side research delta uses Buy after delivery guards",
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
          decision_snapshot: researchSnapshot({
            holderPositionUsd: 20_000,
            side: "YES",
            yesProbability: 0.32,
            yesUsd: 20_000,
          }),
          id: "00000000-0000-4000-8000-000000000002",
          meaningful_delta_reasons: ["holder_position_move:YES"],
          previous_decision_snapshot: researchSnapshot({
            holderPositionUsd: 12_000,
            side: "YES",
            yesProbability: 0.32,
            yesUsd: 12_000,
          }),
          revision_kind: "research_update",
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
          HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE:
            TEST_TELEGRAM_MINI_APP_LINK_BASE,
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        redis,
        telegram,
      });
      const buttons =
        telegram.messages[0]?.reply_markup?.inline_keyboard.flat() ?? [];
      assert.equal(result.sent, 1);
      assert.equal(
        buttons.some((button) => /Buy/i.test(button.text)),
        true,
      );
      assert.equal(
        buttons.some((button) => button.text === "↗️ Open market"),
        false,
      );
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
          decision_snapshot: researchSnapshot({
            side: "YES",
            yesProbability: 0.32,
          }),
          id: "00000000-0000-4000-8000-000000000002",
          meaningful_delta_reasons: ["odds_move"],
          previous_decision_snapshot: researchSnapshot({
            side: "YES",
            yesProbability: 0.28,
          }),
          revision_kind: "research_update",
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
      const recorded = readSignalBotMessageInsert(delivery);
      assert.equal(recorded.messageId, 333);
      assert.equal(recorded.replyToMessageId, null);
      const metrics = recorded.metrics as {
        copy?: {
          copyVersion?: string;
          notification?: {
            headline?: {
              lintExceeded?: boolean;
              storyKind?: string;
              subjectVersion?: string;
              templateKey?: string;
              visibleLength?: number;
            };
            subject?: { source?: string; version?: string };
          };
        };
        fallbackStandalone?: boolean;
        noteKind?: string;
      };
      assert.equal(metrics.fallbackStandalone, true);
      assert.equal(metrics.noteKind, "research_update");
      assert.equal(metrics.copy?.copyVersion, "signal_bot_copy_v6");
      assert.equal(
        metrics.copy?.notification?.headline?.storyKind,
        "price_move",
      );
      assert.equal(
        metrics.copy?.notification?.headline?.templateKey,
        "research_price_move_v5",
      );
      assert.equal(
        metrics.copy?.notification?.headline?.subjectVersion,
        "signal_notification_subject_v3",
      );
      assert.equal(
        metrics.copy?.notification?.subject?.version,
        "signal_notification_subject_v3",
      );
      assert.ok(metrics.copy?.notification?.subject?.source);
      assert.equal(
        typeof metrics.copy?.notification?.headline?.visibleLength,
        "number",
      );
      assert.equal(
        typeof metrics.copy?.notification?.headline?.lintExceeded,
        "boolean",
      );
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
        deliveries.map((delivery) => {
          const recorded = readSignalBotMessageInsert(delivery);
          return [recorded.chatId, recorded.messageId];
        }),
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
      db.candidateRows = [
        followthroughCandidateRow({
          root_metrics: {
            delivery: {
              view: {
                target: {
                  eventId: "limitless:event-2",
                  marketId: "limitless:market-2",
                  price: 0.31,
                  side: "NO",
                  venue: "limitless",
                },
              },
            },
          },
        }),
      ];
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
      assert.match(
        telegram.messages[0]?.text ?? "",
        /^\*📈 YES on .* jumps 15¢ to 55¢\*/,
      );
      assert.match(telegram.messages[0]?.text ?? "", />Wallets {2}\*2\* added/);
      assert.match(telegram.messages[0]?.text ?? "", />\*Since the call\*/);
      assert.match(
        telegram.messages[0]?.text ?? "",
        />\*Since the call\*\n>\u2800\n>Net tracked flow/,
      );
      assert.match(
        telegram.messages[0]?.text ?? "",
        /\[YES at 55¢\]\(https:\/\/t\.me\/hunch_bot\/hunch\?startapp=m_/,
      );
      assert.match(
        telegram.messages[0]?.text ?? "",
        /backed by fresh wallet flow/,
      );
      assert.match(telegram.messages[0]?.text ?? "", /\*Read\*:/);
      assert.match(
        telegram.messages[0]?.text ?? "",
        />[^\n]+\n\u2800\n\*Read\*:/,
      );
      const keyboard = telegram.messages[0]?.reply_markup?.inline_keyboard;
      assert.equal(keyboard?.length, 1);
      assert.equal(keyboard?.[0]?.[0]?.text, "↗️ Open market");
      assert.match(keyboard?.[0]?.[0]?.url ?? "", /^https:\/\/t\.me\//);
      const startParam = readStartAppParam(keyboard?.[0]?.[0]?.url);
      assert.match(startParam, /^m_/);
      const startPayload = Buffer.from(startParam.slice(2), "base64url")
        .toString("utf8")
        .split("|");
      assert.deepEqual(startPayload.slice(0, 3), [
        "l:event-2",
        "market-2",
        "N",
      ]);
      assert.equal(startPayload[3], "00000000-0000-4000-8000-000000000099");
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
      const recorded = readSignalBotMessageInsert(delivery);
      assert.equal(recorded.chatId, "-100");
      assert.equal(recorded.noteId, "00000000-0000-4000-8000-000000000101");
      assert.equal(recorded.messageKind, "followthrough_stats");
      assert.equal(recorded.replyToMessageId, 77);
      const metrics = recorded.metrics;
      assert.equal(metrics.joinedOrAddedWallets, 2);
      assert.equal(metrics.netSignalSideFlowUsd, 9500);
      assert.equal(metrics.fallbackStandalone, false);
      const deliveryMetrics = metrics.delivery as
        | { view?: { target?: { marketId?: string } } }
        | undefined;
      assert.equal(
        deliveryMetrics?.view?.target?.marketId,
        "limitless:market-2",
      );
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
        "p:event-1|market-1|Y|00000000-0000-4000-8000-000000000099",
      );
    },
  },
  {
    name: "followthrough stats keep generic binary price labels as YES NO",
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
      assert.doesNotMatch(text, /📍/);
      assert.match(text, />Net tracked flow {2}/);
      assert.match(text, />YES price {2}40¢ → 55¢ {2}\*\\\+15¢\*/);
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
          HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE:
            TEST_TELEGRAM_MINI_APP_LINK_BASE,
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        now: new Date("2026-01-02T01:00:00.000Z"),
        redis,
        telegram,
      });

      const text = telegram.messages[0]?.text ?? "";
      assert.equal(result.sent, 1);
      assert.match(text, />Net tracked flow/);
      assert.match(text, />NYG price {2}40¢ → 55¢ {2}\*\\\+15¢\*/);
      const keyboard = telegram.messages[0]?.reply_markup?.inline_keyboard;
      assert.equal(keyboard?.length, 1);
      assert.equal(keyboard?.[0]?.[0]?.text, "↗️ Open market");
    },
  },
  {
    name: "followthrough stats render totals in copy-trading format",
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
          direction: "down",
          event_title: "Portugal vs Spain",
          market_description:
            "Over if Portugal and Spain combine for 3 or more goals.",
          market_title: "O/U 2.5",
          metrics: {
            signalSnapshot: {
              quote: { buyPrice: 0.4 },
              side: "NO",
            },
          },
          outcomes: JSON.stringify(["Over", "Under"]),
          target_meta: { side: "NO" },
        }),
      ];
      db.flowRows = [
        followthroughFlowRow({
          baseline_shares: "0",
          outcome_side: "NO",
          wallet_id: "wallet-1",
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

      const text = telegram.messages[0]?.text ?? "";
      assert.equal(result.sent, 1);
      assert.match(
        text,
        /^\*📈 Under 2\\\.5 total goals in Portugal vs Spain edges up 3¢ to 43¢\*/,
      );
      assert.doesNotMatch(text, /📍/);
      assert.match(text, />\*Since the call\*/);
      assert.match(text, />Net tracked flow/);
      assert.match(text, />Wallets {2}\*1\* added · \*1\* holding/);
      assert.match(
        text,
        />Under 2\\.5 total goals price {2}40¢ → 43¢ {2}\*\\\+3¢\*/,
      );
      assert.doesNotMatch(text, /Time since signal/);
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
      const recorded = readSignalBotMessageInsert(delivery);
      assert.equal(recorded.messageKind, "followthrough_stats");
      const metrics = recorded.metrics;
      assert.equal(metrics.status, "skipped");
      assert.equal(typeof metrics.nextEvaluateAt, "string");
    },
  },
  {
    name: "followthrough suppresses tiny inflow when breadth and price disagree",
    run: async () => {
      const redis = new FakeRedis();
      await enableFollowthroughTestChat(redis);
      const db = new FakeFollowthroughDb();
      db.runtimePayload = {
        signalBotFollowthroughEnabled: true,
        signalBotFollowthroughTypes: ["stats"],
        signalBotFollowthroughMinJoinedOrAdded: 2,
        signalBotFollowthroughMinNetFlowUsd: 10_000,
        signalBotFollowthroughMinPriceMoveCents: 2,
      };
      db.candidateRows = [
        followthroughCandidateRow({
          best_ask: "0.11",
          best_bid: "0.09",
          event_title: null,
          market_title: "Will the Iranian regime fall before 2027?",
          metrics: {
            market: { yesProbability: 0.1 },
            signalSnapshot: {
              quote: { buyPrice: 0.1 },
              side: "YES",
            },
          },
        }),
      ];
      db.flowRows = [
        followthroughFlowRow({
          baseline_shares: "0",
          latest_size_usd: "300",
          latest_shares: "30",
          net_shares: "30",
          net_usd: "300",
          positive_usd: "300",
          wallet_id: "wallet-added-1",
        }),
        followthroughFlowRow({
          baseline_shares: "100",
          latest_size_usd: "1400",
          latest_shares: "140",
          net_shares: "40",
          net_usd: "400",
          positive_usd: "400",
          wallet_id: "wallet-added-2",
        }),
        followthroughFlowRow({
          baseline_shares: "100",
          latest_size_usd: "800",
          latest_shares: "80",
          negative_usd: "100",
          net_shares: "-20",
          net_usd: "-100",
          positive_usd: "0",
          wallet_id: "wallet-trimmed",
        }),
        followthroughFlowRow({
          baseline_shares: "100",
          latest_size_usd: "0",
          latest_shares: "0",
          negative_usd: "255",
          net_shares: "-100",
          net_usd: "-255",
          positive_usd: "0",
          wallet_id: "wallet-exited",
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
      const delivery = db.queries
        .filter((query) =>
          query.sql.includes("insert into signal_bot_messages"),
        )
        .at(-1);
      assert.ok(delivery);
      const metrics = readSignalBotMessageInsert(delivery).metrics;
      assert.equal(metrics.joinedOrAddedWallets, 2);
      assert.equal(metrics.trimmedWallets, 2);
      assert.equal(metrics.exitedWallets, 1);
      assert.equal(metrics.netSignalSideFlowUsd, 345);
      assert.ok(Math.abs(Number(metrics.priceMoveCents) + 1) < 1e-9);
      assert.equal(metrics.status, "skipped");
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
          HUNCH_SIGNAL_BOT_TELEGRAM_MINI_APP_LINK_BASE:
            TEST_TELEGRAM_MINI_APP_LINK_BASE,
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
        /^\*📈 YES on .* jumps 15¢ to 55¢\*/,
      );
      assert.match(
        telegram.messages[0]?.text ?? "",
        /moved with the read, but tracked wallet follow\\-through is thin so far/,
      );
      const keyboard = telegram.messages[0]?.reply_markup?.inline_keyboard;
      assert.equal(keyboard?.length, 1);
      assert.equal(keyboard?.[0]?.[0]?.text, "↗️ Open market");
    },
  },
  {
    name: "followthrough cooling copy calls out exits",
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
      db.flowRows = [
        followthroughFlowRow({
          baseline_shares: "100",
          latest_shares: "0",
          latest_size_usd: "0",
          negative_usd: "3000",
          net_shares: "-100",
          net_usd: "-3000",
          positive_usd: "0",
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

      const text = telegram.messages[0]?.text ?? "";
      assert.equal(result.sent, 1);
      assert.match(text, /^\*⚠️ 1 wallet exits YES on /);
      assert.match(text, />Wallets {2}\*1\* exited/);
      assert.match(text, /tracked wallets are exiting/);
      assert.match(text, /\*Read\*:/);
      assert.doesNotMatch(text, /0 trimmed/);
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
      const metrics = readSignalBotMessageInsert(delivery).metrics;
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
      const metrics = readSignalBotMessageInsert(delivery).metrics;
      assert.equal(metrics.estimatedOpenPnlUsd, 1.5);
    },
  },
  {
    name: "followthrough does not count stale latest snapshot as still holding",
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
        snapshotHours: 1,
      };
      db.candidateRows = [followthroughCandidateRow()];
      db.flowRows = [
        followthroughFlowRow({
          baseline_shares: "1000",
          latest_snapshot_at: "2025-12-31T00:00:00.000Z",
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
      const metrics = readSignalBotMessageInsert(delivery).metrics;
      assert.equal(metrics.stillHoldingWallets, 0);
      assert.equal(metrics.estimatedOpenPnlUsd, null);
      assert.ok(
        (metrics.dataQualityTags as string[]).includes(
          "stale_latest_snapshots",
        ),
      );
    },
  },
  {
    name: "legacy resolved-win policy publishes the paired terminal loss",
    run: async () => {
      const redis = new FakeRedis();
      await enableFollowthroughTestChat(redis);
      const db = new FakeFollowthroughDb();
      db.runtimePayload = {
        signalBotFollowthroughEnabled: true,
        signalBotFollowthroughTypes: ["resolved_win"],
        signalBotTerminalInitialCutoff: "2025-12-01T00:00:00.000Z",
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
      assert.match(telegram.messages[0]?.text ?? "", /^\*🏁 YES on .* loses\*/);
      assert.match(telegram.messages[0]?.text ?? "", />\*Result\*/);
      assert.doesNotMatch(
        telegram.messages[0]?.text ?? "",
        /Since the call|\*Read\*:/,
      );
      assert.equal(telegram.messages[0]?.reply_markup, undefined);
      const delivery = db.queries
        .filter((query) =>
          query.sql.includes("insert into signal_bot_messages"),
        )
        .at(-1);
      assert.ok(delivery);
      assert.equal(
        readSignalBotMessageInsert(delivery).messageKind,
        "resolved_loss",
      );
    },
  },
  {
    name: "legacy resolved-loss policy publishes the paired terminal win",
    run: async () => {
      const redis = new FakeRedis();
      await enableFollowthroughTestChat(redis);
      const db = new FakeFollowthroughDb();
      db.runtimePayload = {
        signalBotFollowthroughEnabled: true,
        signalBotFollowthroughTypes: ["resolved_loss"],
        signalBotTerminalInitialCutoff: "2025-12-01T00:00:00.000Z",
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
      assert.match(telegram.messages[0]?.text ?? "", /^\*🏁 YES on .* wins\*/);
      assert.match(telegram.messages[0]?.text ?? "", />\*Result\*/);
      assert.doesNotMatch(
        telegram.messages[0]?.text ?? "",
        /Since the call|\*Read\*:/,
      );
      assert.equal(telegram.messages[0]?.reply_markup, undefined);
      const delivery = db.queries
        .filter((query) =>
          query.sql.includes("insert into signal_bot_messages"),
        )
        .at(-1);
      assert.ok(delivery);
      assert.equal(
        readSignalBotMessageInsert(delivery).messageKind,
        "resolved_win",
      );
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
        signalBotTerminalInitialCutoff: "2025-12-01T00:00:00.000Z",
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
    name: "shared delivery preparation is deterministic for preview and publisher inputs",
    run: async () => {
      const db = new FakeDb();
      const input = {
        appBaseUrl: "https://app.hunch.trade",
        buyAmountUsd: 10,
        chatType: "group",
        db,
        deliveryRef: "preview-parity-ref",
        messageKind: "initial" as const,
        note: note(),
        now: new Date(TEST_SIGNAL_PRICE_AS_OF),
        telegramMiniAppLinkBase: "https://t.me/hunch_bot/hunch",
      };
      const publisher = await prepareSignalBotDelivery(input);
      const preview = await prepareSignalBotDelivery(input);
      assert.deepEqual(preview, publisher);
      assert.equal(publisher.status, "ready");
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
        redis,
        telegram,
      });
      assert.deepEqual(sent, { reason: null, sent: true });
      assert.deepEqual(await getSignalBotChatState(redis, "-100"), before);
      assert.equal(
        db.queries.some((query) =>
          query.sql.includes("insert into signal_bot_messages"),
        ),
        false,
      );
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
      assert.deepEqual(sent, { reason: null, sent: true });
      const keyboard = telegram.messages[0]?.reply_markup?.inline_keyboard;
      assert.equal(keyboard?.[0]?.[0]?.url, undefined);
      const payload = decodeStartAppPayload(
        readWebAppStartParam(keyboard?.[0]?.[0]),
      );
      const payloadParts = payload.split("|");
      assert.deepEqual(payloadParts.slice(0, 4), [
        "p:event-1",
        "market-1",
        "Y",
        "10",
      ]);
      assert.match(
        payloadParts[4] ?? "",
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    },
  },
  {
    name: "test signal rejects an unversioned research update with a diagnostic reason",
    run: async () => {
      const row = noteRow({
        revision_kind: "research_update",
      });
      const metrics = row.metrics as Record<string, unknown>;
      delete metrics.holderResearchUpdateV1;
      const db = new FakeDb();
      db.rows = [row];
      const telegram = new FakeTelegram();
      const outcome = await sendLatestSignalBotTestSignal({
        chatId: "-100",
        config: parseSignalBotConfig({
          HUNCH_SIGNAL_BOT_ADMIN_USER_IDS: "123",
          HUNCH_SIGNAL_BOT_TOKEN: "token",
        }),
        db,
        selector: "update",
        telegram,
      });
      assert.deepEqual(outcome, {
        reason: "missing_update_contract",
        sent: false,
      });
      assert.equal(telegram.messages.length, 0);
      assert.equal(db.queries[0]?.params[4], "research_update");
    },
  },
  {
    name: "followthrough freshness uses env snapshot hours when policy row is absent",
    run: async () => {
      const originalSnapshotHours = process.env.WALLET_INTEL_SNAPSHOT_HOURS;
      process.env.WALLET_INTEL_SNAPSHOT_HOURS = "48";
      const db = {
        query: async () => ({ rows: [] }),
      };

      try {
        const maxAgeMs = await resolveSignalBotLatestSnapshotMaxAgeMs(
          db as never,
        );
        assert.equal(maxAgeMs, 96 * 60 * 60 * 1_000);
      } finally {
        if (originalSnapshotHours == null) {
          delete process.env.WALLET_INTEL_SNAPSHOT_HOURS;
        } else {
          process.env.WALLET_INTEL_SNAPSHOT_HOURS = originalSnapshotHours;
        }
      }
    },
  },
  {
    name: "Telegram Polymarket FOK options keep venue minimum informational",
    run: async () => {
      const authorization = {
        enabled: true,
        enabled_venues: ["polymarket"],
        id: "authorization-1",
        limits: {},
        max_amount_usd: "5",
        privy_user_id: "privy-1",
        privy_wallet_id: "wallet-1",
        telegram_user_id: "999",
        user_id: "user-1",
        wallet_address: "0x0000000000000000000000000000000000000001",
        wallet_chain: "ethereum",
      } as const;
      const market = {
        accepting_orders: true,
        best_ask: "0.062",
        best_bid: "0.06",
        clob_token_ids: '["yes-token","no-token"]',
        close_time: new Date(Date.now() + 60_000),
        event_end_time: null,
        event_id: "event-1",
        event_title: "Event",
        expiration_time: null,
        id: "market-1",
        is_initialized: true,
        last_price: "0.061",
        metadata: {},
        outcomes: '["YES","NO"]',
        slug: "market",
        status: "ACTIVE",
        title: "Market",
        token_no: "no-token",
        token_yes: "yes-token",
        venue: "polymarket",
        venue_market_id: "venue-market-1",
      } as const;
      const quotedAmounts: number[] = [];
      const trading = {
        quote: async ({ intent }: { intent: TradeIntent }) => {
          const amountUsd = Number(intent.amount.value);
          quotedAmounts.push(amountUsd);
          if (intent.outcome === "NO") {
            return buildTestTelegramQuote(intent, {
              currentPrice: 0.939,
              maxSpendUsd: 1.01,
              meetsVenueMinimum: false,
              minimumOrderSizeShares: 5,
              price: 0.94,
            });
          }
          return buildTestTelegramQuote(intent, {
            currentPrice: 0.062,
            maxSpendUsd: 1.06,
            minimumOrderSizeShares: 5,
            price: 0.066,
          });
        },
      };

      const yes =
        await telegramBotTradingTestHooks.resolveTelegramExecutableBuyOption({
          authorization: authorization as never,
          market: market as never,
          maxAmountUsd: 2,
          maxSlippageBps: 500,
          nominalAmountUsd: 1,
          side: "YES",
          trading: trading as never,
        });
      const noWithinTwo =
        await telegramBotTradingTestHooks.resolveTelegramExecutableBuyOption({
          authorization: authorization as never,
          market: market as never,
          maxAmountUsd: 2,
          maxSlippageBps: 500,
          nominalAmountUsd: 1,
          side: "NO",
          trading: trading as never,
        });
      const noWithinFive =
        await telegramBotTradingTestHooks.resolveTelegramExecutableBuyOption({
          authorization: authorization as never,
          market: market as never,
          maxAmountUsd: 5,
          maxSlippageBps: 500,
          nominalAmountUsd: 1,
          side: "NO",
          trading: trading as never,
        });

      assert.equal(yes?.amountUsd, 1);
      assert.equal(yes?.currentPrice, 0.062);
      assert.equal(noWithinTwo?.amountUsd, 1);
      assert.equal(noWithinTwo?.maxSpendUsd, 1.01);
      assert.equal(noWithinFive?.amountUsd, 1);
      assert.equal(noWithinFive?.maxSpendUsd, 1.01);
      assert.ok((noWithinFive?.maxSpendUsd ?? Infinity) <= 5);
      assert.deepEqual(quotedAmounts, [1, 1, 1]);
    },
  },
  {
    name: "Telegram venue minimum predicate blocks SELL, limit, and non-Polymarket orders",
    run: () => {
      const predicate =
        telegramBotTradingTestHooks.isTelegramVenueMinimumBlocking;
      assert.equal(
        predicate({
          action: "BUY",
          meetsVenueMinimum: false,
          orderType: "FOK",
          venue: "polymarket",
        }),
        false,
      );
      assert.equal(
        predicate({
          action: "SELL",
          meetsVenueMinimum: false,
          orderType: "FOK",
          venue: "polymarket",
        }),
        true,
      );
      assert.equal(
        predicate({
          action: "BUY",
          meetsVenueMinimum: false,
          orderType: "GTC",
          venue: "polymarket",
        }),
        true,
      );
      assert.equal(
        predicate({
          action: "BUY",
          meetsVenueMinimum: false,
          orderType: "FOK",
          venue: "limitless",
        }),
        true,
      );
    },
  },
  {
    name: "venue lifecycle requires a full snapshot and fails closed for unknown venues",
    run: () => {
      assert.equal(
        parseVenueLifecyclePolicy({
          version: 1,
          venues: {
            polymarket: { lifecycle: "active", indexerMode: "full" },
          },
        }),
        null,
      );
      assert.equal(
        venueHasLifecycleCapability(
          DEFAULT_VENUE_LIFECYCLE_POLICY,
          "polymarket",
          "increaseExposure",
        ),
        true,
      );
      assert.equal(
        venueHasLifecycleCapability(
          DEFAULT_VENUE_LIFECYCLE_POLICY,
          "kalshi",
          "increaseExposure",
        ),
        false,
      );
      assert.equal(
        venueHasLifecycleCapability(
          DEFAULT_VENUE_LIFECYCLE_POLICY,
          "unknown",
          "accountRead",
        ),
        false,
      );
    },
  },
  {
    name: "signal destination resolver maps outcomes explicitly and chooses the cheapest allowed venue",
    run: () => {
      const now = Date.parse("2026-07-13T12:00:00.000Z");
      const resolution = resolveSignalDeliveryTarget({
        candidates: [
          {
            active: true,
            eventId: "source-event",
            executablePrice: 0.42,
            matchMethod: "source_identity",
            mappedSide: "NO",
            mappingConfidence: 1,
            mappingMethod: "source_identity",
            marketId: "source-market",
            orderable: true,
            priceAsOf: "2026-07-13T11:59:30.000Z",
            sourceSide: "NO",
            venue: "polymarket",
          },
          {
            active: true,
            eventId: "target-event",
            executablePrice: 0.39,
            matchMethod: "conditionId",
            mappedSide: "YES",
            mappingConfidence: 0.98,
            mappingMethod: "agg_explicit",
            marketId: "target-market",
            orderable: true,
            priceAsOf: "2026-07-13T11:59:40.000Z",
            sourceSide: "NO",
            venue: "limitless",
          },
          {
            active: true,
            eventId: "blocked-event",
            executablePrice: 0.2,
            matchMethod: "externalIdentifier",
            mappedSide: "NO",
            mappingConfidence: 1,
            mappingMethod: "agg_explicit",
            marketId: "blocked-market",
            orderable: true,
            priceAsOf: "2026-07-13T11:59:50.000Z",
            sourceSide: "NO",
            venue: "kalshi",
          },
          {
            active: true,
            eventId: "closed-event",
            executablePrice: 0.1,
            matchMethod: "conditionId",
            mappedSide: "YES",
            mappingConfidence: 1,
            mappingMethod: "agg_explicit",
            marketId: "closed-market",
            orderable: false,
            priceAsOf: "2026-07-13T11:59:55.000Z",
            sourceSide: "NO",
            venue: "limitless",
          },
        ],
        destinationPolicy: {
          fallback: "skip",
          selectionMode: "best-executable",
          targetVenues: ["kalshi", "limitless", "polymarket"],
        },
        lifecycle: DEFAULT_VENUE_LIFECYCLE_POLICY,
        nowMs: now,
        sourceSide: "NO",
      });
      assert.equal(resolution.reason, null);
      assert.equal(resolution.target?.marketId, "target-market");
      assert.equal(resolution.target?.mappedSide, "YES");

      const stale = resolveSignalDeliveryTarget({
        candidates: [
          {
            active: true,
            eventId: "event",
            executablePrice: 0.1,
            matchMethod: "conditionId",
            mappedSide: "YES",
            mappingConfidence: 1,
            mappingMethod: "agg_explicit",
            marketId: "market",
            orderable: true,
            priceAsOf: "2026-07-13T11:00:00.000Z",
            sourceSide: "YES",
            venue: "limitless",
          },
        ],
        destinationPolicy: {
          fallback: "skip",
          selectionMode: "best-executable",
          targetVenues: ["limitless"],
        },
        lifecycle: DEFAULT_VENUE_LIFECYCLE_POLICY,
        nowMs: now,
        sourceSide: "YES",
      });
      assert.equal(stale.reason, "stale_price");

      const ambiguous = resolveSignalDeliveryTarget({
        candidates: [
          {
            active: true,
            eventId: "event",
            executablePrice: 0.1,
            matchMethod: "",
            mappedSide: "YES",
            mappingConfidence: 1,
            mappingMethod: "",
            marketId: "market",
            orderable: true,
            priceAsOf: "2026-07-13T11:59:55.000Z",
            sourceSide: "YES",
            venue: "limitless",
          },
        ],
        destinationPolicy: {
          fallback: "skip",
          selectionMode: "best-executable",
          targetVenues: ["limitless"],
        },
        lifecycle: DEFAULT_VENUE_LIFECYCLE_POLICY,
        nowMs: now,
        sourceSide: "YES",
      });
      assert.equal(ambiguous.reason, "ambiguous_mapping");
    },
  },
  {
    name: "Discord and X signal renderers remain pure and transport bounded",
    run: async () => {
      const view: SignalDeliveryView = {
        contextLines: ["Context line"],
        credentialLines: ["Wallet has a strong recent record"],
        holder: {
          address: "0x1",
          displayName: "Sharp wallet",
          positionUsd: 100,
          side: "YES",
        },
        kind: "initial",
        source: {
          eventId: "source-event",
          marketId: "source-market",
          side: "YES",
          venue: "polymarket",
        },
        summary: "A mapped signal is executable on the target venue.",
        target: {
          eventId: "target-event",
          marketId: "target-market",
          price: 0.31,
          side: "NO",
          tradeUrl:
            "https://app.hunch.trade/events/target-event?market=target-market",
          venue: "limitless",
        },
        thread: {},
        title: "Signal title",
      };
      const discord = renderDiscordSignalDelivery(view);
      assert.equal(discord.buttons?.[0]?.label, "Open in Hunch");
      assert.equal(
        discord.embeds?.[0]?.fields[0]?.value,
        "limitless · NO · 31.0¢",
      );
      const x = renderXSignalDelivery(view, 80);
      assert.ok((x.thread ?? []).length > 1);
      assert.equal(
        (x.thread ?? []).every((post) => post.length <= 80),
        true,
      );

      const telegram = renderTelegramSignalDelivery(view);
      assert.equal(telegram.telegram?.parseMode, "MarkdownV2");
      assert.match(telegram.text, /Signal title/);

      const sent: Array<{ kind: string; text: string }> = [];
      const telegramTransport = createTelegramSignalTransport(
        async (payload) => {
          sent.push({ kind: "telegram", text: payload.text });
          return { deliveryId: "telegram-1", ok: true };
        },
      );
      const discordTransport = createDiscordSignalTransport(async (payload) => {
        sent.push({ kind: "discord", text: payload.text });
        return { deliveryId: "discord-1", ok: true };
      });
      const xTransport = createXSignalTransport(async (payload) => {
        sent.push({ kind: "x", text: payload.text });
        return { deliveryId: "x-1", ok: true };
      });
      await telegramTransport.send(telegramTransport.render(view));
      await discordTransport.send(discordTransport.render(view));
      await xTransport.send(xTransport.render(view));
      assert.deepEqual(
        sent.map((item) => item.kind),
        ["telegram", "discord", "x"],
      );
      assert.equal(telegramTransport.capabilities.edits, true);
      assert.equal(xTransport.capabilities.maxLength, 280);
    },
  },
  {
    name: "Telegram local disable cancels only pre-submit intents",
    run: async () => {
      const queries: Array<{ params: unknown[]; sql: string }> = [];
      const disabled = await disableTelegramBotTradingForUser(
        {
          query: async (sql: string, params: unknown[] = []) => {
            queries.push({ params, sql });
            if (sql.includes("UPDATE telegram_bot_trading_authorizations")) {
              return {
                rowCount: 1,
                rows: [
                  {
                    enabled_venues: ["polymarket"],
                    id: "authorization-1",
                    updated_at: new Date("2026-07-17T00:00:00.000Z"),
                    user_id: "user-1",
                    wallet_chain: "ethereum",
                  },
                ],
              };
            }
            return {
              rowCount: 3,
              rows: [],
            };
          },
        } as never,
        "user-1",
      );
      assert.equal(disabled, 1);
      assert.equal(queries.length, 3);
      assert.deepEqual(queries[1]?.params[1], [
        "draft",
        "previewed",
        "confirming",
      ]);
      assert.doesNotMatch(queries[1]?.sql ?? "", /executing|submitted/);
      assert.match(queries[1]?.sql ?? "", /authorization_disabled/);
      assert.match(queries[1]?.sql ?? "", /FROM user_telegram_accounts/);
      assert.match(queries[2]?.sql ?? "", /analytics_server_events/);
      assert.deepEqual(queries[2]?.params.slice(0, 4), [
        "user-1",
        "hf_telegram_trading_lifecycle",
        "telegram_trading_settings",
        "disabled",
      ]);
      assert.equal(queries[2]?.params[4], "polymarket");
      assert.equal(JSON.parse(String(queries[2]?.params[6])).chain, "polygon");
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
