import type { DbQuery } from "../db.js";
import type { ApiBotTradingExecutor } from "../services/api-trading-types.js";
import type { ApiTradeMarket } from "../services/api-trading-market-repo.js";
import {
  buildTelegramBotTradingMarketMessage,
  buildTelegramTradeConfirmationMessage,
} from "../services/telegram-bot-trading.js";
import { getDefaultSignalBotPolicy } from "../services/signal-bot-trading-policy.js";
import { telegramTradeLifecycleProgressTestHooks } from "../services/telegram-trade-lifecycle-progress.js";

export const APP_URL = "https://preview.invalid";
export const ID = "11111111-1111-4111-8111-111111111111";
export const AS_OF = "2026-09-23T12:00:00.000Z";
export const market: ApiTradeMarket = {
  id: "polymarket:preview-market",
  venue: "polymarket",
  venue_market_id: "preview-market",
  event_id: "polymarket:preview-event",
  event_title: "Hunch demo event",
  title: "Will the demo rocket launch this year?",
  status: "ACTIVE",
  accepting_orders: true,
  outcomes: JSON.stringify(["YES", "NO"]),
  metadata: {},
  best_bid: "0.40",
  best_ask: "0.42",
  last_price: "0.41",
  token_yes: "111",
  token_no: "222",
  clob_token_ids: JSON.stringify(["111", "222"]),
  close_time: new Date("2026-12-31T23:59:00Z"),
  expiration_time: null,
  event_end_time: null,
  is_initialized: true,
  slug: null,
  updated_at: new Date(AS_OF),
};

type Confirmation = Parameters<typeof buildTelegramTradeConfirmationMessage>[0];
const authorization: Confirmation["authorization"] = {
  id: ID,
  telegram_account_link_id: ID,
  user_id: ID,
  telegram_user_id: "999",
  privy_user_id: "demo-user",
  wallet_address: "0x0000000000000000000000000000000000000000",
  wallet_chain: "ethereum",
  privy_wallet_id: "demo-wallet",
  enabled: true,
  enabled_venues: ["polymarket"],
  limits: null,
  max_amount_usd: "100",
};

export const marketRoutes: Record<string, string> = {};

// In-memory adapter for the existing market presenter. No SQL is executed.
const db = {
  async query(sql: string, params?: unknown[]) {
    if (sql.includes("INSERT INTO telegram_trade_intents") && params) {
      const action = sql.includes("'sell'") ? "sell" : "buy";
      marketRoutes[`hbt:${action}:${params[0]}`] =
        `${action}_${params[10]}_${params[11]}`;
      return { rows: [], rowCount: 1 };
    }
    let rows: unknown[];
    if (/from runtime_policies/i.test(sql) && params?.[0] !== "signal_bot")
      rows = [];
    else if (/from runtime_policies/i.test(sql))
      rows = [
        {
          payload: {
            ...getDefaultSignalBotPolicy(),
            tradingEnabled: true,
            tradingActions: ["buy", "sell"],
            tradingVenues: ["polymarket"],
            buyAmountPresetsUsd: [10, 25, 50],
            maxTradeAmountUsd: 100,
            autoManagedMaxAmountUsd: 100,
            customTradeInputEnabled: true,
            miniAppHandoffMode: "off",
            fundingReceiveEnabled: false,
          },
        },
      ];
    else if (/FROM unified_markets m/.test(sql)) rows = [market];
    else if (/FROM user_telegram_accounts uta/.test(sql))
      rows = [
        {
          ...authorization,
          username: "demo",
          disabled_at: null,
          last_verified_at: new Date(AS_OF),
        },
      ];
    else if (/FROM telegram_bot_trading_authorizations a/.test(sql))
      rows = [authorization];
    else if (/telegram_user_trading_preferences/.test(sql)) rows = [];
    else if (
      /telegram_trade_intents|user_wallets|telegram_bot_trading_authorizations/.test(
        sql,
      )
    )
      rows = [];
    else throw new Error(`Unmocked preview query: ${sql.slice(0, 120)}`);
    return { rows, rowCount: rows.length };
  },
} as DbQuery;

const forbidden = async (): Promise<never> => {
  throw new Error("The preview exporter cannot execute a trade.");
};
const trading: ApiBotTradingExecutor = {
  applyTradeEffects: forbidden,
  executePreparedTrade: forbidden,
  ensureReadiness: forbidden,
  listCapabilities: () => [],
  normalizeError: () => {
    throw new Error("Unexpected executor call.");
  },
  persistTrade: forbidden,
  prepareTrade: forbidden,
  submitPreparedTrade: forbidden,
  getReadiness: async () => ({
    ready: true,
    executable: true,
    reasonCode: null,
    message: null,
    setupRequired: false,
    capabilities: {
      venue: "polymarket",
      supportsBuy: true,
      supportsSell: true,
      supportsCancel: false,
      supportsOrderSync: false,
      supportsPositionSync: false,
      supportsExecutionSync: false,
      supportsSetup: false,
      authorizationModes: ["server_delegated"],
    },
  }),
  quote: async ({ intent }) => {
    const sell = intent.action === "SELL";
    const amount = Number(intent.amount.value);
    const shares = sell ? amount : amount / 0.44;
    return {
      action: intent.action,
      amount: intent.amount,
      target: intent.target,
      venue: intent.venue,
      currentPrice: sell ? 0.4 : 0.42,
      price: sell ? 0.38 : 0.44,
      estimatedShares: shares,
      estimatedNotionalUsd: sell ? shares * 0.4 : amount,
      maxSpendUsd: sell ? null : amount,
      minReceiveShares: sell ? null : shares,
      minimumReceiveUsd: sell ? shares * 0.38 : null,
      availableShares: 100,
      meetsVenueMinimum: true,
      minimumOrderSizeShares: 1,
      fees: {},
      expiresAt: new Date(Date.now() + 30_000),
      raw: { makerAmount: String(Math.round(shares * 1e6)) },
    };
  },
};

export function marketMessage(focusSide?: "YES" | "NO") {
  return buildTelegramBotTradingMarketMessage({
    appBaseUrl: APP_URL,
    chatId: "999",
    ...(focusSide ? { context: { origin: "direct" as const, focusSide } } : {}),
    telegramUserId: "999",
    telegramMessageId: 1,
    marketRef: market.id,
    telegramMiniAppEnabled: true,
    db,
    trading,
    resolveAvailablePosition: async () => ({ availableRaw: 100_000_000n }),
    writeTradeInputContext: async (context) => {
      marketRoutes[`hbt:${context.action}_input:${context.id}`] =
        `input_${context.action}_${context.side}`;
      return true;
    },
    signerInspector: async () => ({
      attached: true,
      canRemoveAllSigners: true,
      grant: null,
      message: null,
      policyId: "preview",
      policyMaxBuyUsd: 100,
      signerId: "preview",
      state: "ready",
    }),
  });
}

export function confirmation(
  action: "buy" | "sell",
  side: "YES" | "NO" = "YES",
  amount = 25,
) {
  return buildTelegramTradeConfirmationMessage({
    authorization,
    market,
    policy: getDefaultSignalBotPolicy(),
    readiness: null,
    intent: {
      id: ID,
      telegram_user_id: "999",
      user_id: ID,
      authorization_id: ID,
      chat_id: "999",
      delivery_mode: "bot_submit",
      telegram_message_id: "1",
      action,
      venue: "polymarket",
      market_id: market.id,
      event_id: market.event_id,
      side,
      amount_usd: action === "buy" ? String(amount) : null,
      sell_percent: action === "sell" ? String(amount) : null,
      shares_raw: action === "sell" ? String(amount * 1e6) : null,
      status: "previewed",
      error_code: null,
      error_message: null,
      submit_started_at: null,
      funding_operation_id: null,
      funding_reservation_id: null,
      quote_snapshot: {},
      policy_snapshot: {},
      result: {},
      idempotency_key: "preview",
      expires_at: new Date(Date.now() + 120_000),
      market_title: market.title,
      market_status: "ACTIVE",
    },
    quote: {
      availableShares: 100,
      currentPrice: action === "buy" ? 0.42 : 0.4,
      estimatedNotionalUsd: amount,
      estimatedShares: amount / 0.44,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      maxSpendUsd: amount,
      minimumReceiveUsd: amount * 0.38,
      minReceiveShares: amount / 0.44,
      minimumOrderSizeShares: 1,
      meetsVenueMinimum: true,
      price: action === "buy" ? 0.44 : 0.38,
    },
  });
}

export function lifecycle(
  action: "buy" | "sell",
  state:
    | "awaiting_client"
    | "filled"
    | "failed"
    | "cancelled"
    | "quote_expired",
  side: "YES" | "NO" = "YES",
  amount = action === "sell" ? 50 : 25,
) {
  const progress: Parameters<
    typeof telegramTradeLifecycleProgressTestHooks.progressText
  >[0] = {
    version: 7,
    action,
    amountUsd: String(amount),
    sharesRaw: action === "sell" ? String(amount * 1e6) : null,
    intentId: ID,
    marketTitle: market.title,
    sideLabel: side,
    venue: "polymarket",
    state,
    canCancel: state === "awaiting_client",
    canCancelBuy: state === "awaiting_client" && action === "buy",
    isDirectHandoff: true,
    requiresMiniAppContinuation: true,
    failureMessage:
      state === "failed" ? "Demo: not enough liquidity at this price." : null,
    fundingAmountLabel: null,
    operationStatus: null,
    progressStage: null,
    reasonCode: null,
    sourceRoute: null,
    venueOrderId: null,
    attemptStateFingerprint: "demo",
    receiptStateFingerprint: "demo",
    stepStateFingerprint: "demo",
  };
  return {
    parse_mode: "MarkdownV2" as const,
    text: telegramTradeLifecycleProgressTestHooks.progressText(progress),
    reply_markup:
      telegramTradeLifecycleProgressTestHooks.progressKeyboard(progress),
  };
}
