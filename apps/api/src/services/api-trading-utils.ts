import crypto from "node:crypto";
import { ethers } from "ethers";

import { isRecord } from "../lib/type-guards.js";
import {
  normalizeTradingError,
  TradingServiceError,
} from "./trading-errors.js";
import type {
  ApplyTradeEffectsInput,
  ExecutedPreparedTradeError,
  ExecutedPreparedTrade,
  ExecutePreparedTradeInput,
  PersistedTrade,
  PersistTradeInput,
  PreparedTrade,
  SubmitPreparedTradeInput,
  SubmitResult,
  TradeIntent,
  TradeQuote,
  TradeEffectsResult,
  TradingVenue,
  VenueTradingCapabilities,
} from "./trading-types.js";
import type { SupportedBotTradingVenue } from "./api-trading-types.js";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
export const POLYGON_CHAIN_ID = 137;
export const SOLANA_CAIP2 = "solana:mainnet";
export const USDC_SCALE = 1_000_000;

export type PreparedPayloadBase = {
  kind: SupportedBotTradingVenue;
};

export function createCapability(input: {
  authorizationMode: "embedded_privy_evm" | "embedded_privy_solana";
  supportsExecutionSync?: boolean;
  supportsSell?: boolean;
  venue: SupportedBotTradingVenue;
}): VenueTradingCapabilities {
  return {
    venue: input.venue,
    supportsBuy: true,
    supportsSell: input.supportsSell ?? false,
    supportsCancel: false,
    supportsOrderSync: false,
    supportsPositionSync: false,
    supportsExecutionSync: input.supportsExecutionSync ?? false,
    supportsSetup: false,
    authorizationModes: [input.authorizationMode],
  };
}

export function tradingError(input: {
  code: string;
  message: string;
  statusCode?: number;
  venue?: TradingVenue | null;
}): TradingServiceError {
  return new TradingServiceError({
    code: input.code,
    message: input.message,
    statusCode: input.statusCode ?? 400,
    venue: input.venue ?? null,
  });
}

export function shouldPersistSubmitResult(submitResult: SubmitResult): boolean {
  switch (submitResult.status) {
    case "filled":
    case "open":
    case "submitted":
      return true;
    case "no_fill":
      return Boolean(submitResult.venueOrderId);
    case "cancelled":
    case "failed":
      return false;
  }
}

export async function executePreparedTradeLifecycle(input: {
  applyTradeEffects: (
    effectsInput: ApplyTradeEffectsInput,
  ) => Promise<TradeEffectsResult>;
  executeInput: ExecutePreparedTradeInput;
  persistTrade: (persistInput: PersistTradeInput) => Promise<PersistedTrade>;
  submitPreparedTrade: (
    submitInput: SubmitPreparedTradeInput,
  ) => Promise<SubmitResult>;
}): Promise<ExecutedPreparedTrade> {
  const submitResult = await input.submitPreparedTrade({
    now: input.executeInput.now,
    onBroadcastSubmitted: input.executeInput.onBroadcastSubmitted,
    onBeforeBroadcast: input.executeInput.onBeforeBroadcast,
    onSetupTransactionSubmitted: input.executeInput.onSetupTransactionSubmitted,
    prepared: input.executeInput.prepared,
    signatures: input.executeInput.signatures,
  });
  let postSubmitError: ExecutedPreparedTradeError | null = null;
  try {
    await input.executeInput.onSubmitted?.(submitResult);
  } catch (error) {
    const normalized = normalizeTradingError(error, {
      message: "Trade submitted but submitted-state recording needs review.",
      venue: input.executeInput.prepared.venue,
    });
    postSubmitError = {
      code: normalized.code,
      message: normalized.message,
      statusCode: normalized.statusCode,
    };
  }
  if (!shouldPersistSubmitResult(submitResult)) {
    return {
      submitResult,
      persisted: null,
      effects: null,
      postSubmitError,
    };
  }

  let persisted: PersistedTrade | null = null;
  let effects: TradeEffectsResult | null = null;
  try {
    persisted = await input.persistTrade({
      intent: input.executeInput.prepared.intent,
      prepared: input.executeInput.prepared,
      submitResult,
    });
    effects = await input.applyTradeEffects({
      intent: input.executeInput.prepared.intent,
      persisted,
      submitResult,
    });
  } catch (error) {
    const normalized = normalizeTradingError(error, {
      message: "Trade submitted but local recording needs review.",
      venue: input.executeInput.prepared.venue,
    });
    return {
      submitResult,
      persisted,
      effects,
      postSubmitError: {
        code: normalized.code,
        message: normalized.message,
        statusCode: normalized.statusCode,
      },
    };
  }

  return {
    submitResult,
    persisted,
    effects,
    postSubmitError,
  };
}

export function buildTelegramTradeSourceMetadata(input: {
  intent: TradeIntent;
  prepared?: PreparedTrade | null;
}): Record<string, unknown> {
  if (input.intent.actor.kind !== "telegram_bot") return {};
  return {
    telegramIntentId: input.intent.id ?? null,
    telegramIdempotencyKey: input.intent.idempotencyKey,
    reconcileKeys: input.prepared?.reconcileKeys ?? null,
  };
}

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function amountUsd(intent: TradeIntent): number {
  if (intent.amount.type !== "usd") {
    throw tradingError({
      code: "invalid_trade_request",
      message: "Telegram bot buys require USD amount.",
      venue: intent.venue,
    });
  }
  const amount = Number(intent.amount.value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw tradingError({
      code: "invalid_trade_request",
      message: "Trade amount must be positive.",
      venue: intent.venue,
    });
  }
  return amount;
}

export function amountShares(intent: TradeIntent): number {
  if (intent.amount.type !== "shares") {
    throw tradingError({
      code: "invalid_trade_request",
      message: "Telegram bot sells require an exact share amount.",
      venue: intent.venue,
    });
  }
  const amount = Number(intent.amount.value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw tradingError({
      code: "invalid_trade_request",
      message: "Sell shares must be positive.",
      venue: intent.venue,
    });
  }
  return amount;
}

export function normalizeSide(value: unknown): "NO" | "YES" {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();
  if (normalized === "YES" || normalized === "NO") return normalized;
  throw tradingError({
    code: "invalid_trade_request",
    message: "Trade outcome side must be YES or NO.",
  });
}

export function toChecksumAddress(
  value: string | null | undefined,
): string | null {
  try {
    return value ? ethers.getAddress(value.trim()) : null;
  } catch {
    return null;
  }
}

export function randomUint256SaltDecimal(): string {
  let value = BigInt(`0x${crypto.randomBytes(32).toString("hex")}`);
  if (value === 0n) value = 1n;
  return value.toString();
}

export function rawUsd(amount: number): string {
  return Math.floor(amount * USDC_SCALE + 1e-9).toString();
}

export function extractQuoteRaw<T extends Record<string, unknown>>(
  quote: TradeQuote | null | undefined,
): T | null {
  return isRecord(quote?.raw) ? (quote.raw as T) : null;
}

export function parsePreparedPayload<T extends PreparedPayloadBase>(
  prepared: PreparedTrade,
  kind: T["kind"],
): T {
  if (!isRecord(prepared.venuePayload) || prepared.venuePayload.kind !== kind) {
    throw tradingError({
      code: "invalid_trade_request",
      message: "Prepared trade payload is invalid.",
      venue: prepared.venue,
    });
  }
  return prepared.venuePayload as T;
}
