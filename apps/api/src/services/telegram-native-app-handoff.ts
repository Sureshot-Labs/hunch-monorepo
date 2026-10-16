import { randomUUID } from "node:crypto";
import { hip4RawUnits } from "@hunch/shared";
import { formatUnits } from "ethers";
import { tx, type Pool, type PoolClient } from "@hunch/infra";
import type { DbQuery } from "../db.js";
import type { JsonObject } from "../funding/domain/types.js";
import { canonicalJsonHash } from "../funding/persistence/canonical.js";
import { lockFundingPolicyForTransaction } from "../funding/policies/funding-policy-sidecar.js";
import {
  readHip4OrderController,
  readUnambiguousHip4OrderController,
} from "../repos/hip4-order-controller.js";
import type { TelegramAppHandoffV2ScopeAssertion } from "../repos/telegram-app-handoff-v2-direct-trade-repository.js";
import {
  findTradeMarketById,
  type ApiTradeMarket,
} from "./api-trading-market-repo.js";
import { resolveActiveTelegramAccountLink } from "./telegram-account-link.js";
import {
  buildTelegramAppHandoffNativeAuthority,
  telegramAppHandoffNativeAuthoritySchema,
  telegramAppHandoffNativeAuthorityFingerprint,
} from "./telegram-app-handoff-native-authority.js";
import {
  parseTelegramAppHandoffNativePlan,
  telegramAppHandoffNativeRequestedAmounts,
} from "./telegram-app-handoff-native-trade.js";
import {
  buildTelegramAppHandoffStartParamForIntent,
  cancelTelegramAppHandoff,
  issueTelegramAppHandoff,
  resolveTelegramAppHandoff,
  TelegramAppHandoffError,
  type TelegramAppHandoff,
} from "./telegram-app-handoff.js";
import {
  buildTelegramAppHandoffV2DirectTradePlan,
  parseTelegramAppHandoffV2Plan,
  type TelegramAppHandoffV2Plan,
} from "./telegram-app-handoff-v2.js";
import {
  telegramAppHandoffPolicyAllows,
  isTelegramAppHandoffV2EnabledForVenue,
} from "./telegram-app-handoff-v2-contract.js";
import {
  hip4MarketOrderQuoteRequestSchema,
  type Hip4MarketOrderQuoteRequest,
} from "./hip4-market-order.js";
import { HIP4_MAINNET_ORDER_UNITS } from "./hip4-order-amounts.js";
import {
  quoteTelegramNativeTradeReview,
  readTelegramNativeTradeReviewDraft,
} from "./telegram-native-trade-review.js";
import {
  resolveSignalBotTradingPolicyStateFromDb,
  type SignalBotPolicy,
} from "./signal-bot-trading-policy.js";
import type { TelegramTradeMiniAppFundingInspection } from "./telegram-trade-shortfall-funding.js";
import type { TelegramNativeTradeShortfallIdentity } from "./telegram-native-trade-shortfall.js";
import type { TelegramNativeTradeInputContext } from "./telegram-bot-trade-input-context.js";
import { TELEGRAM_MARKET_INPUT_CONTEXT_TTL_MS } from "./telegram-bot-trade-input-context.js";
import { readTelegramNativeSellAvailable } from "./telegram-native-trade-capacity.js";
import { venueLifecycleAllows } from "./venue-lifecycle.js";
import type {
  TelegramBotTradingCallbackInput,
  TelegramBotTradingMessage,
  TelegramMarketCardContext,
} from "./telegram-bot-trading.js";
import { buildHunchMiniAppDeepLinkButton } from "./telegram-mini-app-buttons.js";
import { joinTelegramMarkdownV2Lines } from "./telegram-bot-trading-presentation.js";

type LifecycleRenderer = (input: {
  heading: string;
  lines?: Array<string | null>;
  marketTitle: string;
  tone: "info" | "warn";
  venue: string;
}) => string;

export class TelegramNativeAppHandoffError extends Error {
  constructor(
    readonly code:
      | "draft_unavailable"
      | "authority_changed"
      | "policy_changed"
      | "quote_expired"
      | "funding_unavailable"
      | "external_deposit_required"
      | "other_trade_unresolved"
      | "input_conflict",
  ) {
    super(code);
    this.name = "TelegramNativeAppHandoffError";
  }
}

export type TelegramNativeTradeIntent = {
  id: string;
  telegram_user_id: string;
  user_id: string;
  chat_id: string;
  telegram_message_id: string | null;
  action: "buy" | "sell";
  market_id: string;
  side: "YES" | "NO";
  status: string;
  delivery_mode: "app_handoff";
  result: JsonObject;
  expires_at: Date;
};

export const TELEGRAM_NATIVE_REVIEW_INTENT_SQL = `select
  id::text,telegram_user_id,user_id::text,chat_id,telegram_message_id::text,
  action,market_id,side,status,delivery_mode,result,expires_at
  from telegram_trade_intents
  where id=$1::uuid and venue='hyperliquid' and delivery_mode='app_handoff'`;
export const TELEGRAM_NATIVE_INPUT_REPLAY_SQL = `select id::text,user_id::text,telegram_user_id,chat_id,result
  from telegram_trade_intents where idempotency_key=$1 and venue='hyperliquid' and delivery_mode='app_handoff'`;

export async function readTelegramNativeTradeIntent(db: DbQuery, id: string) {
  return (
    (
      await db.query<TelegramNativeTradeIntent>(
        TELEGRAM_NATIVE_REVIEW_INTENT_SQL,
        [id],
      )
    ).rows[0] ?? null
  );
}

export async function isTelegramNativeTradeInputAuthorityCurrent(input: {
  db: DbQuery;
  telegramUserId: string;
  context: Pick<
    TelegramNativeTradeInputContext,
    "authority" | "telegramUserId"
  >;
}): Promise<boolean> {
  if (input.context.telegramUserId !== input.telegramUserId) return false;
  const link = await resolveActiveTelegramAccountLink(input);
  const expected = input.context.authority;
  if (
    !link ||
    link.userId !== expected.userId ||
    link.linkId !== expected.telegramAccountLinkId
  )
    return false;
  try {
    const profile = await readHip4OrderController(input.db, {
      userId: link.userId,
      controllerWalletRef: expected.controllerWalletRef,
    });
    return (
      telegramAppHandoffNativeAuthorityFingerprint(expected) ===
      telegramAppHandoffNativeAuthorityFingerprint(
        buildTelegramAppHandoffNativeAuthority({
          userId: link.userId,
          telegramAccountLinkId: link.linkId,
          profile,
        }),
      )
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "hip4_controller_unavailable"
    )
      return false;
    throw error;
  }
}

export type TelegramNativeInputSelection = Readonly<{
  contextId: string;
  normalized: string;
  mode: "usd" | "shares" | "percent" | "all";
  authority: TelegramNativeTradeInputContext["authority"];
}>;

function assertDraftPolicy(
  request: Hip4MarketOrderQuoteRequest,
  policy: SignalBotPolicy,
) {
  const action = request.side === "BUY" ? "buy" : "sell";
  if (
    !telegramAppHandoffPolicyAllows({
      action,
      executionContractVersion: 2,
      policy,
    })
  )
    throw new TelegramNativeAppHandoffError("policy_changed");
  if (
    request.side === "BUY" &&
    BigInt(request.consentedDebitCapRaw) >
      BigInt(policy.maxTradeAmountUsd) * 100_000_000n
  )
    throw new TelegramNativeAppHandoffError("policy_changed");
  if (
    request.slippageBps != null &&
    request.slippageBps > policy.maxSlippageBps
  )
    throw new TelegramNativeAppHandoffError("policy_changed");
}

function assertNativeCustomInputPolicy(
  policy: SignalBotPolicy,
  action: "buy" | "sell",
) {
  if (
    !policy.customTradeInputEnabled ||
    !policy.tradingEnabled ||
    !policy.tradingActions.includes(action)
  )
    throw new TelegramNativeAppHandoffError("policy_changed");
}

/** A preset/custom choice, not financial consent. Exact native budget remains
 * in nativeReviewDraft; amount_usd is legacy display metadata only (USD6).
 * No bot authorization, quote, reservation or provider IO is created here. */
export async function createTelegramNativeTradeDraft(input: {
  db: DbQuery;
  telegramUserId: string;
  chatId: string;
  telegramMessageId?: number | null;
  market: ApiTradeMarket;
  request: Hip4MarketOrderQuoteRequest;
  inputSelection?: TelegramNativeInputSelection;
}) {
  const request = hip4MarketOrderQuoteRequestSchema.parse(input.request);
  if (
    input.market.venue !== "hyperliquid" ||
    input.market.id !== request.marketId
  )
    throw new TelegramNativeAppHandoffError("draft_unavailable");
  const [link, policyState] = await Promise.all([
    resolveActiveTelegramAccountLink({
      db: input.db,
      telegramUserId: input.telegramUserId,
    }),
    resolveSignalBotTradingPolicyStateFromDb(input.db),
  ]);
  if (!link) throw new TelegramNativeAppHandoffError("authority_changed");
  assertDraftPolicy(request, policyState.policy);
  if (input.inputSelection)
    assertNativeCustomInputPolicy(
      policyState.policy,
      request.side === "BUY" ? "buy" : "sell",
    );
  const profile = await readHip4OrderController(input.db, {
    userId: link.userId,
    controllerWalletRef: request.controllerWalletRef,
  });
  const authority = buildTelegramAppHandoffNativeAuthority({
    userId: link.userId,
    telegramAccountLinkId: link.linkId,
    profile,
  });
  if (
    input.inputSelection &&
    telegramAppHandoffNativeAuthorityFingerprint(
      input.inputSelection.authority,
    ) !== telegramAppHandoffNativeAuthorityFingerprint(authority)
  )
    throw new TelegramNativeAppHandoffError("authority_changed");
  const inputMarker = input.inputSelection
    ? {
        version: "hip4-input-v1",
        contextId: input.inputSelection.contextId,
        normalized: input.inputSelection.normalized,
        mode: input.inputSelection.mode,
        action: request.side.toLowerCase(),
        marketId: request.marketId,
        outcomeSide: request.outcomeSide,
        authorityFingerprint:
          telegramAppHandoffNativeAuthorityFingerprint(authority),
      }
    : null;
  const id = randomUUID();
  const idempotencyKey = inputMarker
    ? `telegram-bot-input:${inputMarker.contextId}`
    : `telegram-native:${id}`;
  const inserted = await input.db.query<{ id: string }>(
    `insert into telegram_trade_intents(
      id,telegram_user_id,user_id,authorization_id,chat_id,telegram_message_id,
      delivery_mode,action,venue,market_id,event_id,side,amount_usd,shares_raw,
      status,quote_snapshot,policy_snapshot,result,expires_at,idempotency_key)
    values($1::uuid,$2,$3::uuid,null,$4,$5,'app_handoff',$6,'hyperliquid',$7,$8,$9,
      $10::numeric,$11::text,'draft','{}'::jsonb,$12::jsonb,$13::jsonb,
      clock_timestamp()+make_interval(secs=>$14::int),$15)
      on conflict(idempotency_key) do nothing returning id::text`,
    [
      id,
      input.telegramUserId,
      link.userId,
      input.chatId,
      input.telegramMessageId ?? null,
      request.side.toLowerCase(),
      request.marketId,
      input.market.event_id,
      request.outcomeSide,
      request.side === "BUY"
        ? formatUnits(request.consentedDebitCapRaw, 8)
        : null,
      request.side === "SELL" ? request.consentedDebitCapRaw : null,
      JSON.stringify(policyState.policy),
      JSON.stringify({
        appHandoffNativeAuthority: authority,
        nativeReviewDraft: { version: 1, request },
        ...(inputMarker ? { nativeInput: inputMarker } : {}),
      }),
      policyState.policy.intentTtlSec,
      idempotencyKey,
    ],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const existing = (
    await input.db.query<{
      id: string;
      user_id: string;
      telegram_user_id: string;
      chat_id: string;
      result: JsonObject;
    }>(TELEGRAM_NATIVE_INPUT_REPLAY_SQL, [idempotencyKey])
  ).rows[0];
  if (
    !inputMarker ||
    !existing ||
    existing.user_id !== link.userId ||
    existing.telegram_user_id !== input.telegramUserId ||
    existing.chat_id !== input.chatId ||
    existing.result.nativeInput == null ||
    canonicalJsonHash(existing.result.nativeInput) !==
      canonicalJsonHash(inputMarker)
  )
    throw new TelegramNativeAppHandoffError("input_conflict");
  return existing.id;
}

/** Add existing policy-sized choices to the normal market card. These are
 * unconsented drafts; the next callback obtains the ordinary current quote.
 * Ambiguous/unlinked wallets keep the normal editable app navigation. */
export async function addTelegramNativeTradeChoices(
  input: {
    db: DbQuery;
    telegramUserId: string;
    chatId: string;
    telegramMessageId?: number | null;
    marketId: string;
    side?: "YES" | "NO" | null;
    miniAppEnabled: boolean;
    publicBrowseOnly?: boolean;
    navigation: TelegramBotTradingMessage;
    context?: TelegramMarketCardContext;
    writeTradeInputContext?: (
      input: import("./telegram-bot-trade-input-context.js").TelegramBotTradeInputContext,
    ) => Promise<boolean>;
  },
  dependencies: { sellAvailable?: typeof readTelegramNativeSellAvailable } = {},
): Promise<TelegramBotTradingMessage> {
  if (
    !input.miniAppEnabled ||
    input.publicBrowseOnly ||
    !input.navigation.marketFound
  )
    return input.navigation;
  const policyState = await resolveSignalBotTradingPolicyStateFromDb(input.db);
  if (
    !isTelegramAppHandoffV2EnabledForVenue({
      mode: policyState.policy.miniAppHandoffMode,
      contractVersion: policyState.policy.miniAppHandoffContractVersion,
      venue: "hyperliquid",
    })
  )
    return input.navigation;
  const link = await resolveActiveTelegramAccountLink({
    db: input.db,
    telegramUserId: input.telegramUserId,
  });
  if (!link) return input.navigation;
  const [profile, market] = await Promise.all([
    readUnambiguousHip4OrderController(input.db, link.userId),
    findTradeMarketById(input.db, input.marketId),
  ]);
  const controllerWalletRef = profile?.controllerWalletRef;
  if (
    !controllerWalletRef ||
    !market ||
    market.status !== "ACTIVE" ||
    market.venue !== "hyperliquid" ||
    !market.id.startsWith("hyperliquid:mainnet:")
  )
    return input.navigation;
  const rows: NonNullable<
    TelegramBotTradingMessage["reply_markup"]
  >["inline_keyboard"] = [];
  if (
    !profile ||
    (input.context?.focusPositionWalletAddress &&
      input.context.focusPositionWalletAddress.toLowerCase() !==
        profile.address)
  )
    return input.navigation;
  const authority = buildTelegramAppHandoffNativeAuthority({
    userId: link.userId,
    telegramAccountLinkId: link.linkId,
    profile,
  });
  const policy = policyState.policy;
  const [canBuy, canSell] = await Promise.all(
    (["buy", "sell"] as const).map(
      async (action) =>
        telegramAppHandoffPolicyAllows({
          action,
          executionContractVersion: 2,
          policy,
        }) &&
        (await venueLifecycleAllows(
          input.db,
          "hyperliquid",
          action === "buy" ? "increaseExposure" : "reduceExposure",
        )),
    ),
  );
  const customButton = async (action: "buy" | "sell", side: "YES" | "NO") => {
    if (
      !input.writeTradeInputContext ||
      !policy.customTradeInputEnabled ||
      !policy.tradingEnabled ||
      !policy.tradingActions.includes(action)
    )
      return null;
    const id = randomUUID();
    const now = Date.now();
    const context: TelegramNativeTradeInputContext = {
      version: 3,
      venue: "hyperliquid",
      deliveryMode: "app_handoff",
      authority,
      id,
      action,
      side,
      chatId: input.chatId,
      telegramUserId: input.telegramUserId,
      marketId: market.id,
      eventId: market.event_id,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(
        now + TELEGRAM_MARKET_INPUT_CONTEXT_TTL_MS,
      ).toISOString(),
      controlledPositionId: input.context?.focusPositionId ?? null,
      funderAddress: null,
      messageScope:
        input.telegramMessageId == null
          ? { kind: "new_message_unbound" }
          : { kind: "exact_message", messageId: input.telegramMessageId },
      origin: input.context?.origin ?? "direct",
      returnCallbackData: input.context?.returnCallbackData,
      positionLines: input.context?.positionLines,
      positionRedemptionStatus: input.context?.positionRedemptionStatus,
    };
    if (!(await input.writeTradeInputContext(context).catch(() => false)))
      return null;
    return {
      text: `Custom ${action === "buy" ? "Buy" : "Sell"} ${side}`,
      callback_data: `hbt:${action}_input:${id}`,
    };
  };
  for (const side of input.side ? [input.side] : (["YES", "NO"] as const)) {
    const buttons = [];
    for (const amount of (canBuy
      ? policyState.policy.buyAmountPresetsUsd
      : []
    ).filter((value) => value <= policyState.policy.maxTradeAmountUsd)) {
      const id = await createTelegramNativeTradeDraft({
        ...input,
        market,
        request: {
          requestKey: randomUUID(),
          marketId: market.id,
          outcomeSide: side,
          side: "BUY",
          controllerWalletRef,
          consentedDebitCapRaw: (BigInt(amount) * 100_000_000n).toString(),
          slippageBps: policyState.policy.maxSlippageBps,
        },
      });
      buttons.push({
        text: `Buy ${side} $${amount}`,
        callback_data: `hbt:buy:${id}`,
      });
    }
    // Match the existing market-card row density, never one enormous row.
    for (let index = 0; index < buttons.length; index += 3)
      rows.push(buttons.slice(index, index + 3));
    const customBuy = canBuy ? await customButton("buy", side) : null;
    if (customBuy) rows.push([customBuy]);
    if (canSell) {
      const available = await (
        dependencies.sellAvailable ?? readTelegramNativeSellAvailable
      )({ db: input.db, authority, marketId: market.id, side }).catch(
        () => null,
      );
      const scale = 10n ** BigInt(HIP4_MAINNET_ORDER_UNITS.tokenRawDecimals);
      const cap = available === null ? 0n : (available / scale) * scale;
      if (cap > 0n) {
        const id = await createTelegramNativeTradeDraft({
          ...input,
          market,
          request: {
            requestKey: randomUUID(),
            marketId: market.id,
            outcomeSide: side,
            side: "SELL",
            controllerWalletRef,
            consentedDebitCapRaw: cap.toString(),
            slippageBps: policy.maxSlippageBps,
          },
        });
        const sellRow = [
          { text: `Sell ${side} all`, callback_data: `hbt:sell:${id}` },
        ];
        const customSell = await customButton("sell", side);
        if (customSell) sellRow.push(customSell);
        rows.push(sellRow);
      }
    }
  }
  return rows.length
    ? {
        ...input.navigation,
        reply_markup: {
          inline_keyboard: [
            ...rows,
            ...(input.navigation.reply_markup?.inline_keyboard ?? []),
          ],
        },
      }
    : input.navigation;
}

export type TelegramNativeReviewDependencies = {
  scope: TelegramAppHandoffV2ScopeAssertion;
  quote?: typeof quoteTelegramNativeTradeReview;
  inspectFunding: (
    input: TelegramNativeTradeShortfallIdentity,
    trade: JsonObject,
  ) => Promise<TelegramTradeMiniAppFundingInspection>;
  /** Existing market-scoped unresolved resolver, called under the SAME M/U
   * envelope; it includes issued/claimed handoffs and factual native terminals. */
  hasOtherUnresolved: (
    db: Pick<PoolClient, "query">,
    input: {
      excludeIntentId: string;
      marketId: string;
      telegramUserId: string;
    },
  ) => Promise<boolean>;
};

function tokenForIntent(input: {
  tokenSecret: string;
  telegramUserId: string;
  userId: string;
  tradeIntentId: string;
}) {
  const startParam = buildTelegramAppHandoffStartParamForIntent(input);
  return { startParam, token: startParam.slice("handoff_".length) };
}

function assertIntentIdentity(
  intent: TelegramNativeTradeIntent | null,
  input: { telegramUserId: string; chatId: string },
) {
  if (
    !intent ||
    intent.telegram_user_id !== input.telegramUserId ||
    intent.chat_id !== input.chatId
  )
    throw new TelegramNativeAppHandoffError("draft_unavailable");
  return intent;
}

/** Selected native draft -> immutable shared v2 Review. Quote/funding IO is
 * outside the transaction; publication is P→existing M/U/link/W→H→I. Losing
 * the response reopens the original token before any new quote/provider IO.
 * This prepares consent only: no FundingOperation or native order is created. */
export async function prepareTelegramNativeAppHandoff(
  input: {
    db: Pool;
    intentId: string;
    telegramUserId: string;
    chatId: string;
    tokenSecret: string;
    telegramMessageId?: number;
  },
  dependencies: TelegramNativeReviewDependencies,
): Promise<{ handoff: TelegramAppHandoff; startParam: string }> {
  const intent = assertIntentIdentity(
    await readTelegramNativeTradeIntent(input.db, input.intentId),
    input,
  );
  const access = tokenForIntent({
    ...input,
    tradeIntentId: intent.id,
    userId: intent.user_id,
  });
  const resolveExisting = () =>
    resolveTelegramAppHandoff({
      db: input.db,
      telegramUserId: input.telegramUserId,
      userId: intent.user_id,
      token: access.token,
    });
  try {
    return { handoff: await resolveExisting(), startParam: access.startParam };
  } catch (error) {
    if (
      !(error instanceof TelegramAppHandoffError) ||
      error.code !== "not_found"
    )
      throw error;
  }
  const draft = readTelegramNativeTradeReviewDraft(intent.result);
  const storedAuthority = telegramAppHandoffNativeAuthoritySchema.safeParse(
    intent.result.appHandoffNativeAuthority,
  );
  if (
    !draft ||
    !storedAuthority.success ||
    intent.status !== "draft" ||
    intent.expires_at.getTime() <= Date.now() ||
    draft.request.marketId !== intent.market_id ||
    draft.request.outcomeSide !== intent.side ||
    draft.request.side.toLowerCase() !== intent.action
  )
    throw new TelegramNativeAppHandoffError("draft_unavailable");
  const policyState = await resolveSignalBotTradingPolicyStateFromDb(input.db);
  assertDraftPolicy(draft.request, policyState.policy);
  // Existing Reviews resolve above, before any new-policy/provider checks.
  // An unissued saved custom selection still needs current permission to mint
  // its first Review after a retry. The publication scope fences this revision.
  if (intent.result.nativeInput != null)
    assertNativeCustomInputPolicy(policyState.policy, intent.action);
  const link = await resolveActiveTelegramAccountLink({
    db: input.db,
    telegramUserId: input.telegramUserId,
  });
  if (
    !link ||
    link.userId !== intent.user_id ||
    link.linkId !== storedAuthority.data.telegramAccountLinkId
  )
    throw new TelegramNativeAppHandoffError("authority_changed");
  const market = await findTradeMarketById(input.db, intent.market_id);
  if (!market) throw new TelegramNativeAppHandoffError("draft_unavailable");
  const review = await (dependencies.quote ?? quoteTelegramNativeTradeReview)(
    input.db,
    {
      userId: intent.user_id,
      telegramAccountLinkId: link.linkId,
      market,
      request: draft.request,
    },
  );
  const authorityFingerprint = telegramAppHandoffNativeAuthorityFingerprint(
    review.authority,
  );
  if (
    authorityFingerprint !==
    telegramAppHandoffNativeAuthorityFingerprint(storedAuthority.data)
  )
    throw new TelegramNativeAppHandoffError("authority_changed");
  let plan: TelegramAppHandoffV2Plan;
  if (review.requiredSpend) {
    const funding = await dependencies.inspectFunding(
      {
        userId: intent.user_id,
        requiredSpend: review.requiredSpend,
        maxFeeUsd: formatUnits(review.requiredSpend.raw, 8),
        maxSlippageBps: policyState.policy.maxSlippageBps,
        deadline: review.expiresAt.toISOString(),
      },
      review.trade,
    );
    if (funding.kind === "external_deposit")
      throw new TelegramNativeAppHandoffError("external_deposit_required");
    if (funding.kind === "temporarily_unavailable")
      throw new TelegramNativeAppHandoffError("funding_unavailable");
    plan =
      funding.kind === "web_funding_plan"
        ? funding.plan
        : buildTelegramAppHandoffV2DirectTradePlan({
            controllerWalletAddress: review.authority.walletAddress,
            trade: review.trade,
          });
  } else {
    plan = buildTelegramAppHandoffV2DirectTradePlan({
      controllerWalletAddress: review.authority.walletAddress,
      trade: review.trade,
    });
  }
  plan = parseTelegramAppHandoffV2Plan(plan);
  if (canonicalJsonHash(plan.trade) !== canonicalJsonHash(review.trade))
    throw new TelegramNativeAppHandoffError("authority_changed");
  const native = parseTelegramAppHandoffNativePlan(plan);
  if (!native) throw new TelegramNativeAppHandoffError("draft_unavailable");
  const scope = {
    action: intent.action,
    authorityFingerprint,
    policyRevision: policyState.policyRevision,
    telegramUserId: input.telegramUserId,
    tradeIntentId: intent.id,
    venue: "hyperliquid" as const,
    userId: intent.user_id,
  };
  const published = await tx(input.db, async (client) => {
    await lockFundingPolicyForTransaction(client);
    const db = { query: client.query.bind(client) };
    await dependencies.scope.lockAuthority({ ...scope, db });
    // Issuance for this exact intent can race the preflight read. Lock any
    // existing H before I; do not mutate or re-issue it with a newer quote.
    const existing = await client.query<{ found: boolean }>(
      "select true as found from telegram_app_handoffs where trade_intent_id=$1::uuid for update",
      [intent.id],
    );
    if (existing.rows[0]) return false;
    const current = assertIntentIdentity(
      (
        await client.query<TelegramNativeTradeIntent>(
          TELEGRAM_NATIVE_REVIEW_INTENT_SQL + " for update",
          [intent.id],
        )
      ).rows[0] ?? null,
      input,
    );
    if (
      current.user_id !== intent.user_id ||
      current.status !== "draft" ||
      current.expires_at.getTime() <= Date.now() ||
      (current.telegram_message_id != null &&
        input.telegramMessageId != null &&
        current.telegram_message_id !== String(input.telegramMessageId)) ||
      canonicalJsonHash(current.result) !== canonicalJsonHash(intent.result)
    )
      throw new TelegramNativeAppHandoffError("draft_unavailable");
    if (review.expiresAt.getTime() <= Date.now())
      throw new TelegramNativeAppHandoffError("quote_expired");
    if (
      await dependencies.hasOtherUnresolved(db, {
        excludeIntentId: intent.id,
        marketId: intent.market_id,
        telegramUserId: input.telegramUserId,
      })
    )
      throw new TelegramNativeAppHandoffError("other_trade_unresolved");
    await client.query(
      `update telegram_trade_intents set status='previewed',quote_snapshot=$2::jsonb,
        result=result||jsonb_build_object('appHandoffV2',jsonb_build_object('version',2,'plan',$3::jsonb)),
        shares_raw=case when action='sell' then $4::text else shares_raw end,
        telegram_message_id=coalesce(telegram_message_id,$5),updated_at=clock_timestamp()
        where id=$1::uuid`,
      [
        intent.id,
        JSON.stringify(review.quoteSnapshot),
        JSON.stringify(plan),
        telegramAppHandoffNativeRequestedAmounts(
          native.nativeTrade,
        ).tokenRaw.toString(),
        input.telegramMessageId ?? null,
      ],
    );
    const issued = await issueTelegramAppHandoff({
      db,
      authorityFingerprint,
      policyRevision: policyState.policyRevision,
      telegramUserId: input.telegramUserId,
      userId: intent.user_id,
      tradeIntentId: intent.id,
      planSnapshot: plan,
      quoteSnapshot: review.quoteSnapshot,
      tokenSecret: input.tokenSecret,
      assertCurrentIntent: (currentDb) =>
        dependencies.scope.validate({ ...scope, db: currentDb }),
    });
    // Same pending-choice cleanup as the existing selector, narrowed to native
    // drafts. Claimed/committed other Reviews are rejected by unresolved above.
    await client.query(
      `update telegram_trade_intents set status='cancelled',error_code='superseded_by_intent',
        error_message='Another trade intent for this market was selected.',updated_at=clock_timestamp()
        where telegram_user_id=$1 and market_id=$2 and id<>$3::uuid
          and venue='hyperliquid' and status in ('draft','previewed')`,
      [input.telegramUserId, intent.market_id, intent.id],
    );
    return issued.handoff;
  });
  return {
    handoff: published || (await resolveExisting()),
    startParam: access.startParam,
  };
}

/** Idempotent pre-submit exit. Draft CAS and shared H→I cancellation are
 * separate transactions; a publication/submit winner is read, never undone. */
export async function cancelTelegramNativeReview(input: {
  db: Pool;
  intent: TelegramNativeTradeIntent;
  tokenSecret: string;
}): Promise<"cancelled" | "expired" | "in_flight"> {
  const intent = input.intent;
  const access = tokenForIntent({
    tokenSecret: input.tokenSecret,
    tradeIntentId: intent.id,
    userId: intent.user_id,
    telegramUserId: intent.telegram_user_id,
  });
  const bound = {
    db: input.db,
    telegramUserId: intent.telegram_user_id,
    userId: intent.user_id,
    token: access.token,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await cancelTelegramAppHandoff(bound);
      return "cancelled";
    } catch (error) {
      if (!(error instanceof TelegramAppHandoffError)) throw error;
      if (error.code === "not_found") {
        const cancelled = await input.db.query(
          `update telegram_trade_intents set status='cancelled',error_code='user_cancelled',updated_at=clock_timestamp()
            where id=$1::uuid and user_id=$2::uuid and telegram_user_id=$3 and chat_id=$4
              and venue='hyperliquid' and delivery_mode='app_handoff' and status='draft'
              and funding_operation_id is null and order_id is null and submit_started_at is null`,
          [intent.id, intent.user_id, intent.telegram_user_id, intent.chat_id],
        );
        if (cancelled.rowCount === 1) return "cancelled";
        const current = await readTelegramNativeTradeIntent(
          input.db,
          intent.id,
        );
        if (
          current?.user_id === intent.user_id &&
          current.telegram_user_id === intent.telegram_user_id &&
          current.chat_id === intent.chat_id &&
          (current.status === "cancelled" || current.status === "expired")
        )
          return current.status;
        // Issuance won the draft CAS. Retry H→I from a fresh transaction.
        continue;
      }
      if (error.code === "expired") return "expired";
      if (error.code !== "not_cancellable") throw error;
      const current = await resolveTelegramAppHandoff(bound);
      if (current.state === "cancelled" || current.state === "expired")
        return current.state;
      return "in_flight";
    }
  }
  return "in_flight";
}

export function buildTelegramNativeReviewMessage(input: {
  intent: TelegramNativeTradeIntent;
  handoff: TelegramAppHandoff;
  startParam: string;
  miniAppLinkBase: string | null | undefined;
  fundingReviewLines: readonly string[];
  renderLifecycle: LifecycleRenderer;
}): TelegramBotTradingMessage {
  const plan = parseTelegramAppHandoffNativePlan(input.handoff.planSnapshot);
  if (!plan) throw new TelegramNativeAppHandoffError("draft_unavailable");
  const native = plan.nativeTrade;
  const terminal =
    input.handoff.state === "expired" || input.handoff.state === "cancelled";
  const button = terminal
    ? null
    : buildHunchMiniAppDeepLinkButton({
        miniAppLinkBase: input.miniAppLinkBase,
        startParam: input.startParam,
        text:
          input.handoff.state === "issued"
            ? `Confirm ${input.intent.action}`
            : "Continue in Hunch",
      });
  if (!terminal && !button)
    throw new TelegramNativeAppHandoffError("draft_unavailable");
  const debit = formatUnits(
    native.consentedDebitCapRaw,
    native.side === "BUY" ? 8 : 5,
  );
  const priceCents = formatUnits(
    hip4RawUnits(native.limitPrice, HIP4_MAINNET_ORDER_UNITS.priceDecimals) *
      100n,
    HIP4_MAINNET_ORDER_UNITS.priceDecimals,
  );
  const marketTitle =
    typeof plan.trade.marketTitle === "string"
      ? plan.trade.marketTitle
      : "Market";
  return {
    parse_mode: "MarkdownV2",
    text: joinTelegramMarkdownV2Lines([
      input.renderLifecycle({
        heading: terminal
          ? `Review ${input.handoff.state}.`
          : `Review ${native.side === "BUY" ? "Buy" : "Sell"}`,
        tone: terminal ? "warn" : "info",
        marketTitle,
        venue: "hyperliquid",
        lines: [
          `Outcome: ${native.outcomeSide}`,
          `Contracts: ${native.quantity}`,
          `Limit price: ${priceCents}¢`,
          `${native.side === "BUY" ? "Maximum order debit" : "Maximum contracts sold"}: ${native.side === "BUY" ? "$" : ""}${debit}${native.side === "BUY" ? " USDC" : ""}`,
          "Immediate-or-cancel. Partial fills are possible; the remainder is cancelled.",
          ...(terminal
            ? []
            : [
                "Confirm and sign in Hunch. No order is placed by this chat button.",
              ]),
        ],
      }),
      ...input.fundingReviewLines,
    ]),
    reply_markup: {
      inline_keyboard: [
        ...(button ? [[button]] : []),
        ...(!terminal
          ? [
              [
                {
                  text: "Cancel",
                  callback_data: `hbt:cancel:${input.intent.id}`,
                },
              ],
            ]
          : []),
        [
          {
            text: "Open market",
            callback_data: `hbt:open_market:${input.intent.id}`,
          },
        ],
        [{ text: "Home", callback_data: "hm:v1:home" }],
      ],
    },
  };
}

/** Only repository product callbacks. Never sends messages itself or touches a
 * Telegram account; the existing API/bot transport delivers the returned UI. */
export async function handleTelegramNativeAppHandoffCallback(input: {
  callback: TelegramBotTradingCallbackInput;
  callbackType: string;
  intentId: string;
  tokenSecret: string;
  miniAppLinkBase: string | null | undefined;
  dependencies: TelegramNativeReviewDependencies;
  buildMarket: () => Promise<TelegramBotTradingMessage>;
  fundingReviewLines: (
    plan: TelegramAppHandoffV2Plan,
  ) => Promise<readonly string[]>;
  renderLifecycle: LifecycleRenderer;
}) {
  const cb = input.callback;
  const intent = await readTelegramNativeTradeIntent(cb.db, input.intentId);
  if (!intent) return false;
  const source = cb.callbackQuery.message;
  const chatId = source?.chat ? String(source.chat.id) : "";
  const senderId = cb.callbackQuery.from?.id;
  const answer = (text: string, showAlert = true) =>
    cb.answerCallbackQuery({
      callbackQueryId: cb.callbackQuery.id,
      text,
      showAlert,
    });
  if (
    !senderId ||
    String(senderId) !== intent.telegram_user_id ||
    source?.chat?.type !== "private" ||
    chatId !== intent.chat_id
  ) {
    await answer("Open the original private chat to use this trade button.");
    return true;
  }
  if (input.callbackType === "open_market") {
    await cb.sendMessage({ chat_id: chatId, ...(await input.buildMarket()) });
    await answer("Opening the current market.", false);
    return true;
  }
  const navigation = input.callbackType === "retry_buy";
  if (
    !navigation &&
    input.callbackType !== "cancel" &&
    intent.telegram_message_id != null &&
    String(source.message_id) !== intent.telegram_message_id
  ) {
    await answer("This trade card is no longer current. Use the latest card.");
    return true;
  }
  if (input.callbackType === "cancel") {
    try {
      const state = await cancelTelegramNativeReview({
        db: cb.db as Pool,
        intent,
        tokenSecret: input.tokenSecret,
      });
      await answer(
        state === "cancelled"
          ? "The trade continuation was cancelled. Submitted funding may still finish."
          : state === "expired"
            ? "This Review has expired. Open the current market for a new Review."
            : "This trade already started. Check its current status in Hunch; no replacement was submitted.",
        state === "in_flight",
      );
    } catch {
      await answer(
        "Cancellation could not be confirmed. Check the existing trade in Hunch before retrying.",
      );
    }
    return true;
  }
  if (
    (input.callbackType === "buy" && intent.action !== "buy") ||
    (input.callbackType === "sell" && intent.action !== "sell") ||
    !["buy", "sell", "confirm", "retry_buy", "refresh_quote"].includes(
      input.callbackType,
    )
  ) {
    await answer("Choose the amount and action from the current market card.");
    return true;
  }
  if (
    cb.telegramMiniAppEnabled !== true ||
    !buildHunchMiniAppDeepLinkButton({
      miniAppLinkBase: input.miniAppLinkBase,
      startParam: tokenForIntent({
        tokenSecret: input.tokenSecret,
        tradeIntentId: intent.id,
        userId: intent.user_id,
        telegramUserId: intent.telegram_user_id,
      }).startParam,
      text: "Continue in Hunch",
    })
  ) {
    await answer(
      "Open Hunch to review this trade. Mini App continuation is currently unavailable.",
    );
    return true;
  }
  try {
    const review = await prepareTelegramNativeAppHandoff(
      {
        db: cb.db as Pool,
        intentId: intent.id,
        chatId,
        telegramUserId: intent.telegram_user_id,
        tokenSecret: input.tokenSecret,
        telegramMessageId: source.message_id,
      },
      input.dependencies,
    );
    const plan = parseTelegramAppHandoffV2Plan(review.handoff.planSnapshot);
    await cb.sendMessage({
      chat_id: chatId,
      ...buildTelegramNativeReviewMessage({
        intent,
        ...review,
        miniAppLinkBase: input.miniAppLinkBase,
        renderLifecycle: input.renderLifecycle,
        fundingReviewLines: await input.fundingReviewLines(plan),
      }),
    });
    await answer("Review the exact trade in Hunch.", false);
  } catch (error) {
    cb.log?.warn?.(
      {
        code:
          error instanceof TelegramNativeAppHandoffError ||
          error instanceof TelegramAppHandoffError
            ? error.code
            : "native_review_unavailable",
        intentId: intent.id,
      },
      "Native app review unavailable",
    );
    const text =
      error instanceof TelegramNativeAppHandoffError &&
      error.code === "external_deposit_required"
        ? "Add funds in Hunch, then open a fresh market Review. No order was submitted."
        : error instanceof TelegramNativeAppHandoffError &&
            error.code === "other_trade_unresolved"
          ? "An existing trade for this market is still resolving. Reopen it before starting another."
          : "This Review is unavailable. Reopen the market or check the existing trade in Hunch.";
    await answer(text);
  }
  return true;
}
