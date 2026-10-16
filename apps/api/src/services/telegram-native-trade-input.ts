import { randomUUID } from "node:crypto";
import type { Pool } from "@hunch/infra";
import { readTelegramNativeSellAvailable } from "./telegram-native-trade-capacity.js";
import {
  telegramAppHandoffNativeAuthoritySchema,
  telegramAppHandoffNativeAuthorityFingerprint,
} from "./telegram-app-handoff-native-authority.js";
import type { TelegramNativeTradeInputContext } from "./telegram-bot-trade-input-context.js";
import { telegramBotTradeInputMessageScopeMatches } from "./telegram-bot-trade-input-context.js";
import { findTradeMarketById } from "./api-trading-market-repo.js";
import { resolveSignalBotTradingPolicyStateFromDb } from "./signal-bot-trading-policy.js";
import { telegramAppHandoffPolicyAllows } from "./telegram-app-handoff-v2-contract.js";
import { venueLifecycleAllows } from "./venue-lifecycle.js";
import {
  parseTelegramNativeTradeInput,
  telegramNativeInputDebitCap,
  telegramNativeInputMarkerSchema,
} from "./telegram-native-trade-input-amounts.js";
import {
  createTelegramNativeTradeDraft,
  isTelegramNativeTradeInputAuthorityCurrent,
  prepareTelegramNativeAppHandoff,
  readTelegramNativeTradeIntent,
  type TelegramNativeReviewDependencies,
} from "./telegram-native-app-handoff.js";

/** Native variant of the existing custom-input workflow. Only an unconsented
 * draft and ordinary immutable Review can be created here, never an order,
 * funding operation, signature or bot authorization. */
export async function completeTelegramNativeTradeInput(
  input: {
    db: Pool;
    context?: TelegramNativeTradeInputContext;
    intentId?: string;
    contextId: string;
    telegramUserId: string;
    chatId: string;
    telegramMessageId: number;
    value: string;
    tokenSecret: string;
    miniAppEnabled: boolean;
    isLinkCurrent: () => Promise<boolean>;
  },
  dependencies: TelegramNativeReviewDependencies & {
    sellAvailable?: typeof readTelegramNativeSellAvailable;
  },
) {
  const unavailable = (
    title: string,
    body: string,
    marketIntentId?: string,
  ) => ({ completed: false as const, notice: { title, body, marketIntentId } });
  let intent = input.intentId
    ? await readTelegramNativeTradeIntent(input.db, input.intentId)
    : null;
  const context = input.context;
  if (!input.miniAppEnabled)
    return unavailable(
      "Open Hunch",
      "Mini App continuation is unavailable. Reopen this market in Hunch.",
      intent?.id,
    );
  if (intent) {
    if (
      intent.telegram_user_id !== input.telegramUserId ||
      intent.chat_id !== input.chatId ||
      (intent.telegram_message_id !== null &&
        intent.telegram_message_id !== String(input.telegramMessageId))
    )
      return unavailable(
        "Input conflict",
        "This input belongs to another trade card.",
      );
    const parsed = parseTelegramNativeTradeInput(intent.action, input.value);
    const marker = telegramNativeInputMarkerSchema.safeParse(
      intent.result.nativeInput,
    ).data;
    if (
      !parsed ||
      !marker ||
      marker.contextId !== input.contextId ||
      marker.normalized !== parsed.normalized ||
      marker.mode !== parsed.mode ||
      marker.action !== intent.action ||
      marker.marketId !== intent.market_id ||
      marker.outcomeSide !== intent.side
    )
      return unavailable(
        "Input conflict",
        "This request was already used with a different amount. Open the market card for a new request.",
      );
    const authority = telegramAppHandoffNativeAuthoritySchema.safeParse(
      intent.result.appHandoffNativeAuthority,
    );
    if (
      !authority.success ||
      marker.authorityFingerprint !==
        telegramAppHandoffNativeAuthorityFingerprint(authority.data) ||
      !(await isTelegramNativeTradeInputAuthorityCurrent({
        ...input,
        context: {
          authority: authority.data,
          telegramUserId: intent.telegram_user_id,
        },
      }))
    )
      return unavailable(
        "Account binding changed",
        "The linked Hunch account or controller changed. Reopen the market card.",
      );
  } else {
    if (
      !context ||
      context.id !== input.contextId ||
      context.telegramUserId !== input.telegramUserId ||
      context.chatId !== input.chatId ||
      Date.parse(context.expiresAt) <= Date.now() ||
      !telegramBotTradeInputMessageScopeMatches(
        context.messageScope,
        input.telegramMessageId,
      )
    )
      return unavailable(
        "Input expired",
        "Open the market card to enter a new amount.",
      );
    const parsed = parseTelegramNativeTradeInput(context.action, input.value);
    if (!parsed)
      return unavailable(
        "Invalid amount",
        context.action === "buy"
          ? "Enter a positive USD amount with at most two decimals, for example 2.50."
          : "Enter whole contracts, a percentage such as 25%, or all. Fractional exact contracts are not supported.",
      );
    const { policy } = await resolveSignalBotTradingPolicyStateFromDb(input.db);
    if (
      !policy.customTradeInputEnabled ||
      !policy.tradingEnabled ||
      !policy.tradingActions.includes(context.action) ||
      !telegramAppHandoffPolicyAllows({
        action: context.action,
        executionContractVersion: 2,
        policy,
      }) ||
      !(await venueLifecycleAllows(
        input.db,
        "hyperliquid",
        context.action === "buy" ? "increaseExposure" : "reduceExposure",
      ))
    )
      return unavailable(
        "Trade not ready",
        "Current trading policy does not allow this input. Reopen the market card.",
      );
    if (
      parsed.mode === "usd" &&
      parsed.scaled > BigInt(policy.maxTradeAmountUsd) * 100_000_000n
    )
      return unavailable(
        "Amount exceeds policy",
        `Enter an amount no greater than $${policy.maxTradeAmountUsd}.`,
      );
    if (
      !(await isTelegramNativeTradeInputAuthorityCurrent({
        ...input,
        context,
      })) ||
      !(await input.isLinkCurrent())
    )
      return unavailable(
        "Account binding changed",
        "The linked Hunch account or controller changed. Reopen the market card.",
      );
    const market = await findTradeMarketById(input.db, context.marketId);
    if (!market || market.venue !== "hyperliquid" || market.status !== "ACTIVE")
      return unavailable(
        "Market unavailable",
        "Open the current market in Hunch.",
      );
    const available =
      context.action === "sell"
        ? await (dependencies.sellAvailable ?? readTelegramNativeSellAvailable)(
            {
              db: input.db,
              authority: context.authority,
              marketId: context.marketId,
              side: context.side,
            },
          )
        : undefined;
    const debit = telegramNativeInputDebitCap(parsed, available);
    if (!debit)
      return unavailable(
        "Sell amount unavailable",
        "Choose no more than the currently available whole contracts. Small percentages may round below one contract.",
      );
    const id = await createTelegramNativeTradeDraft({
      ...input,
      market,
      request: {
        requestKey: randomUUID(),
        marketId: market.id,
        side: context.action === "buy" ? "BUY" : "SELL",
        outcomeSide: context.side,
        controllerWalletRef: context.authority.controllerWalletRef,
        consentedDebitCapRaw: debit,
        slippageBps: policy.maxSlippageBps,
      },
      inputSelection: {
        contextId: context.id,
        normalized: parsed.normalized,
        mode: parsed.mode,
        authority: context.authority,
      },
    });
    intent = await readTelegramNativeTradeIntent(input.db, id);
  }
  if (!intent || !(await input.isLinkCurrent()))
    return unavailable(
      "Account link changed",
      "Reopen the market card with the current linked account.",
    );
  const prepared = await prepareTelegramNativeAppHandoff(
    { ...input, intentId: intent.id },
    dependencies,
  );
  return { completed: true as const, review: { ...prepared, intent } };
}
