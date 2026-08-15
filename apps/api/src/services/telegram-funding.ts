import { tx, type Pool, type PoolClient } from "@hunch/infra";

import {
  normalizeUnsignedDecimal,
  parseUnsignedDecimal,
} from "../account-value/decimal.js";
import type {
  FundingDestinationOption,
  FundingReceiveSession,
  JsonValue,
} from "../funding/domain/types.js";
import { FundingPlanningRuntime } from "../funding/planner/runtime-service.js";
import { FundingPlannerError } from "../funding/planner/money.js";
import { canonicalJsonHash } from "../funding/persistence/canonical.js";
import {
  listFundingReceiveRoutingReceiptIdsAfterBroadcastBoundary,
  requestFundingReceiveSessionObservation,
} from "../funding/persistence/funding-receive-session-repository.js";
import { lockFundingPolicyForTransaction } from "../funding/policies/funding-policy-service.js";
import { FundingReceiveSessionService } from "../funding/receive/receive-session-service.js";
import type { DelegatedFundingPreBroadcastDecision } from "../funding/execution/delegated-funding-capability.js";
import { lockTelegramFundingLinkLifecycle } from "../funding/execution/telegram-funding-link-lifecycle-lock.js";
import {
  isTelegramFundingReceiveControllerCurrent,
  telegramFundingManagedWalletControllerId,
  telegramFundingVenueNetworkId,
} from "../funding/execution/telegram-funding-managed-wallet.js";
import type { TelegramFundingAuthorization } from "../funding/execution/telegram-funding-authorization.js";
import {
  findTradeMarketById,
  isOrderable,
  type ApiTradeMarket,
} from "./api-trading-market-repo.js";
import {
  resolveActiveTelegramAccountLink,
  sameActiveTelegramAccountLink,
  type ActiveTelegramAccountLink,
} from "./telegram-account-link.js";
import type {
  TelegramFundingMessage,
  TelegramFundingProgressProjection,
} from "./telegram-funding-contracts.js";
import { rearmTelegramFundingCurrentAddressDelivery } from "./telegram-funding-delivery.js";
import { runTelegramFundingProgressProjectionForContext } from "./telegram-funding-progress-projector.js";
import {
  appendTelegramFundingBuyReturnInTransaction,
  type TelegramFundingBuyContinuationMode,
} from "./telegram-funding-buy-continuation.js";
import {
  parseTelegramBotTradeAuthorityBinding,
  telegramBotTradeAuthorityFingerprint,
} from "./telegram-bot-trade-input-context.js";
import {
  buildTelegramFundingActiveElsewhereMessage,
  buildTelegramFundingCancelledMessage,
  buildTelegramFundingBuyReturnAttachedMessage,
  buildTelegramFundingDeliveryQueuedMessage,
  buildTelegramFundingProgressMessage,
  buildTelegramFundingReviewQuoteMessage,
  buildTelegramFundingTargetChoicesMessage,
  buildTelegramFundingUnavailableMessage,
} from "./telegram-funding-presentation.js";
import {
  parseTelegramFundingProgressProjection,
  projectTelegramFundingCancelled,
  projectTelegramFundingProgress,
  resolveTelegramFundingRetainedTerminal,
  telegramFundingProgressFingerprint,
} from "./telegram-funding-progress.js";
import {
  appendTelegramFundingConsent,
  cancelTelegramFundingSessionContext,
  createOrReuseTelegramFundingSessionInTransaction,
  fetchActiveTelegramFundingReviewResponse,
  fetchActiveTelegramFundingConsent,
  fetchTelegramFundingOpenMutationReplay,
  fetchTelegramFundingReviewMutationReplay,
  fetchTelegramFundingMutationReplay,
  fetchTelegramFundingSelectionSnapshot,
  fetchTelegramFundingSessionByIdempotency,
  fetchTelegramFundingSessionContext,
  finalizeSupersededTelegramFundingSessionInTransaction,
  lockActiveTelegramFundingReviewByConsentToken,
  lockActiveTelegramFundingReviewTarget,
  recordTelegramFundingOpenMutation,
  recordTelegramFundingReviewMutation,
  prepareTelegramFundingSessionOpenInTransaction,
  reuseActiveTelegramFundingSession,
  TelegramFundingPersistenceError,
  type TelegramFundingConsent,
  type TelegramFundingReviewTarget,
  type TelegramFundingSessionContext,
} from "./telegram-funding-sessions.js";
import {
  resolveSignalBotTradingPolicyStateFromDb,
  type SignalBotPolicy,
} from "./signal-bot-trading-policy.js";
import { venueLifecycleAllowsTradingAction } from "./venue-lifecycle.js";
import {
  buildTelegramFundingAutomaticPolicyForRoute,
  prepareTelegramFundingAutomaticVariantsForRoute,
  resolveTelegramFundingConsentRoute,
  resolveTelegramFundingConsentCapability,
  resolveTelegramFundingCurrentController,
  resolveTelegramFundingDestination,
  resolveTelegramFundingRouteCapability,
  resolveTelegramFundingRouteCapabilities,
  resolveTelegramFundingTarget,
  resolveTelegramFundingTargets,
  resolveTelegramFundingTargetChoice,
  type TelegramFundingReceivePresentationMode,
  type TelegramFundingTargetCapability,
} from "./telegram-funding-route.js";

export {
  resolveTelegramDirectPusdChoice,
  resolveTelegramFundingTargetChoice,
} from "./telegram-funding-route.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;
type TelegramFundingOpenContext = Awaited<
  ReturnType<typeof createOrReuseTelegramFundingSessionInTransaction>
> &
  Readonly<{
    reusedActiveMessage?: boolean;
    reusedReceiveBinding?: Readonly<{
      destinationOptionId: string;
      venueBindingOptionId: string;
    }>;
  }>;
type TelegramFundingInitialBuyReturn = Readonly<{
  eventId: string | null;
  marketId: string;
  minimumFundingUsd: string | null;
  requestedSpendUsd: string;
  side: "NO" | "YES";
}>;

export type TelegramFundingAuthorizationProvisioner = (
  input: Readonly<{
    userId: string;
    telegramAccountId: string;
    telegramUserId: string;
    controllerWalletId: string;
    destinationOptionId: string;
    venueBindingOptionId: string;
    venueId: "limitless" | "polymarket";
    now: Date;
  }>,
) => Promise<unknown>;

export type TelegramFundingManagedWalletResolver = (
  input: Readonly<{
    userId: string;
    telegramAccountId: string;
    telegramUserId: string;
  }>,
) => Promise<Readonly<{
  controllerWalletId: string;
  walletAddress: string;
}> | null>;

export type TelegramFundingBuyReturnSourceIntent = Readonly<{
  action: string;
  amount_usd: string | number | null;
  authorization_id: string | null;
  authorization_max_amount_usd: string | number | null;
  authorization_privy_wallet_id: string | null;
  authorization_wallet_address: string;
  authorization_wallet_chain: "ethereum" | "solana";
  chat_id: string | null;
  delivery_mode: TelegramFundingBuyContinuationMode;
  event_id: string | null;
  funding_operation_id: string | null;
  funding_reservation_id: string | null;
  market_id: string;
  side: string | null;
  status: string;
  submit_started_at: Date | null;
  telegram_authority: unknown;
  telegram_user_id: string;
  user_id: string | null;
  venue: "limitless" | "polymarket";
}>;

export async function loadTelegramFundingBuyReturnSourceIntentForUpdate(
  client: PoolClient,
  input: Readonly<{
    sourceIntentId: string;
    telegramAccountId: string;
  }>,
): Promise<TelegramFundingBuyReturnSourceIntent | null> {
  const source = await client.query<TelegramFundingBuyReturnSourceIntent>(
    `
      select
        intent.action,
        intent.amount_usd,
        intent.authorization_id,
        auth.max_amount_usd as authorization_max_amount_usd,
        auth.privy_wallet_id as authorization_privy_wallet_id,
        auth.wallet_address as authorization_wallet_address,
        auth.wallet_chain as authorization_wallet_chain,
        intent.chat_id,
        intent.delivery_mode,
        intent.event_id,
        intent.funding_operation_id,
        intent.funding_reservation_id,
        intent.market_id,
        intent.side,
        intent.status,
        intent.submit_started_at,
        intent.result -> 'telegramAuthority' as telegram_authority,
        intent.telegram_user_id,
        intent.user_id,
        intent.venue
      from telegram_trade_intents intent
      join telegram_bot_trading_authorizations auth
        on auth.id = intent.authorization_id
       and auth.user_id = intent.user_id
       and auth.telegram_user_id = intent.telegram_user_id
       and auth.enabled = true
       and (
         (intent.delivery_mode = 'bot_submit'
           and intent.venue = any(auth.enabled_venues))
         or (intent.delivery_mode = 'app_handoff'
           and auth.wallet_chain = 'ethereum')
       )
      join users app_user
        on app_user.id = auth.user_id
       and coalesce(app_user.is_active, true) = true
      join telegram_bot_trading_preferences preference
        on preference.user_id = auth.user_id
       and preference.desired_enabled = true
      join user_telegram_accounts telegram_account
        on telegram_account.id = $2::uuid
       and telegram_account.user_id = auth.user_id
       and telegram_account.telegram_user_id = auth.telegram_user_id
      join user_wallets wallet
        on wallet.user_id = auth.user_id
       and wallet.wallet_type = auth.wallet_chain
       and wallet.is_verified = true
       and (
         (auth.wallet_chain = 'ethereum'
           and funding_account_identifier_equal(
                 auth.wallet_chain,
                 wallet.wallet_address,
                 auth.wallet_address
               ))
         or (auth.wallet_chain <> 'ethereum'
           and wallet.wallet_address = auth.wallet_address)
       )
      where intent.id = $1::uuid
      for update of intent, auth, app_user, preference, telegram_account, wallet
    `,
    [input.sourceIntentId, input.telegramAccountId],
  );
  return source.rows[0] ?? null;
}

export type TelegramFundingErrorCode =
  | "destination_ambiguous"
  | "funding_context_not_found"
  | "funding_buy_continuation_disabled"
  | "funding_receive_disabled"
  | "funding_session_active_elsewhere"
  | "funding_session_expired"
  | "funding_session_unavailable"
  | "receive_channel_conflict"
  | "invalid_funding_choice"
  | "idempotency_conflict"
  | "private_chat_required"
  | "telegram_account_required";

export class TelegramFundingError extends Error {
  constructor(readonly code: TelegramFundingErrorCode) {
    super(code);
    this.name = "TelegramFundingError";
  }
}

type TelegramFundingIdentityInput = Readonly<{
  chatId: string | number;
  telegramMessageId?: number | null;
  telegramUserId: string | number;
}>;

type TelegramFundingMutationInput = TelegramFundingIdentityInput &
  Readonly<{
    idempotencyKey: string;
    telegramMessageId: number | null;
  }>;

export type TelegramFundingBuyReturnOpenInput = TelegramFundingMutationInput &
  Readonly<{
    authorizationId: string;
    continuationMode?: TelegramFundingBuyContinuationMode;
    eventId: string | null;
    marketId: string;
    minimumFundingUsd?: string;
    requestedSpendUsd: string;
    side: "NO" | "YES";
    sourceIntentId: string;
    venue: "limitless" | "polymarket";
  }>;

export type TelegramFundingMarketReturn = Readonly<{
  marketId: string;
  side: "NO" | "YES";
}>;

export type TelegramFundingProgressDecorator = (
  input: Readonly<{
    consent: TelegramFundingConsent | null;
    context: TelegramFundingSessionContext;
    message: TelegramFundingMessage;
    now: Date;
    presentationMode: TelegramFundingReceivePresentationMode | null;
    progress: TelegramFundingProgressProjection | null;
    session: FundingReceiveSession;
  }>,
) => Promise<TelegramFundingMessage>;

export function resolveTelegramFundingPrivateIdentity(
  input: TelegramFundingIdentityInput,
): {
  chatId: string;
  telegramUserId: string;
} {
  const chatId = String(input.chatId);
  const telegramUserId = String(input.telegramUserId);
  if (chatId !== telegramUserId) {
    throw new TelegramFundingError("private_chat_required");
  }
  return { chatId, telegramUserId };
}

function assertIdempotencyKey(value: string): string {
  const key = value.trim();
  if (key.length < 8 || key.length > 192) {
    throw new TelegramFundingError("invalid_funding_choice");
  }
  return key;
}

function jsonRecord(value: unknown): JsonRecord {
  return JSON.parse(JSON.stringify(value)) as JsonRecord;
}

function telegramFundingMessage(value: JsonRecord): TelegramFundingMessage {
  return value as unknown as TelegramFundingMessage;
}

export function buildTelegramFundingBuyReturnRequestFingerprint(input: {
  destinationOptionId: string;
  identity: Readonly<{ chatId: string; telegramUserId: string }>;
  link: Readonly<{ linkId: string; userId: string }>;
  request: TelegramFundingBuyReturnOpenInput;
  venueBindingOptionId: string;
}): string {
  return canonicalJsonHash([
    "set_buy_return:v1",
    input.request.authorizationId,
    input.request.continuationMode ?? "bot_submit",
    input.link.userId,
    input.link.linkId,
    input.identity.telegramUserId,
    input.identity.chatId,
    input.request.venue,
    input.destinationOptionId,
    input.venueBindingOptionId,
    input.request.marketId,
    input.request.eventId,
    input.request.side,
    canonicalTelegramFundingBuySpend(input.request.requestedSpendUsd),
    input.request.sourceIntentId,
    input.request.telegramMessageId,
  ]);
}

export function canonicalTelegramFundingBuySpend(value: string): string {
  const parsed = parseUnsignedDecimal(value);
  if (parsed.coefficient <= 0n || parsed.scale > 6) {
    throw new TelegramFundingError("funding_context_not_found");
  }
  return normalizeUnsignedDecimal(value);
}

export function canAttachTelegramFundingBuyReturn(input: {
  currentPolicyRevision: string;
  eventId: string | null;
  initialPolicyRevision: string;
  lifecycleAllowed: boolean;
  market:
    | (Pick<
        ApiTradeMarket,
        | "accepting_orders"
        | "close_time"
        | "event_end_time"
        | "event_id"
        | "expiration_time"
        | "metadata"
        | "status"
        | "venue"
      > & { event_id: string })
    | null;
  policy: Pick<
    SignalBotPolicy,
    | "buyContinuationEnabled"
    | "fundingReceiveEnabled"
    | "tradingActions"
    | "tradingEnabled"
    | "tradingVenues"
  >;
  venue: "limitless" | "polymarket";
}): boolean {
  return (
    input.currentPolicyRevision === input.initialPolicyRevision &&
    input.policy.fundingReceiveEnabled &&
    input.policy.buyContinuationEnabled &&
    input.policy.tradingEnabled &&
    input.policy.tradingActions.includes("buy") &&
    input.policy.tradingVenues.includes(input.venue) &&
    input.market?.venue === input.venue &&
    (input.eventId == null || input.market.event_id === input.eventId) &&
    isOrderable(input.market) &&
    input.lifecycleAllowed
  );
}

function rethrowTelegramFundingPersistenceError(error: unknown): never {
  if (
    error instanceof TelegramFundingPersistenceError &&
    error.code === "telegram_funding_idempotency_conflict"
  ) {
    throw new TelegramFundingError("idempotency_conflict");
  }
  if (
    error instanceof TelegramFundingPersistenceError &&
    error.code === "telegram_funding_session_unavailable"
  ) {
    throw new TelegramFundingError("funding_session_unavailable");
  }
  if (
    error instanceof TelegramFundingPersistenceError &&
    error.code === "telegram_funding_active_context_ambiguous"
  ) {
    throw new TelegramFundingError("destination_ambiguous");
  }
  if (
    error instanceof TelegramFundingPersistenceError &&
    error.code === "telegram_funding_session_active_elsewhere"
  ) {
    throw new TelegramFundingError("funding_session_active_elsewhere");
  }
  throw error;
}

export function telegramFundingConsentPresentationMode(
  consent: TelegramFundingConsent,
  liveMode: TelegramFundingReceivePresentationMode | null,
): TelegramFundingReceivePresentationMode | null {
  const frozenMode = resolveTelegramFundingConsentRoute(consent)?.mode ?? null;
  return liveMode && frozenMode ? frozenMode : null;
}

export function buildTelegramFundingTargetMessageForSession(input: {
  automaticConversionEnabled?: boolean;
  targets?: readonly TelegramFundingTargetCapability[];
  contextId: string;
  expiresAt: string;
  session: FundingReceiveSession;
}): TelegramFundingMessage {
  const targets =
    input.targets ??
    resolveTelegramFundingTargets({
      automaticConversionEnabled: input.automaticConversionEnabled === true,
      session: input.session,
    });
  return targets.length > 0
    ? buildTelegramFundingTargetChoicesMessage({
        contextId: input.contextId,
        expiresAt: input.expiresAt,
        targets,
      })
    : buildTelegramFundingUnavailableMessage({ reason: "unavailable" });
}

export function loadTelegramFundingReceiveSession(
  receive: Pick<FundingReceiveSessionService, "get">,
  userId: string,
  receiveSessionId: string,
) {
  return receive.get(userId, receiveSessionId, "telegram");
}

export function canDiscloseTelegramFundingAddress(
  input: Readonly<{
    context: Pick<TelegramFundingSessionContext, "cancelledAt" | "expiresAt">;
    now: Date;
    projection: Readonly<{ terminal: boolean }> | null;
    session: Pick<FundingReceiveSession, "status">;
  }>,
): boolean {
  return (
    !input.context.cancelledAt &&
    new Date(input.context.expiresAt).getTime() > input.now.getTime() &&
    ["open", "processing", "review_required"].includes(input.session.status) &&
    input.projection?.terminal !== true
  );
}

type LockedTelegramFundingReview =
  | Readonly<{ kind: "response"; response: JsonRecord }>
  | Readonly<{ kind: "target"; target: TelegramFundingReviewTarget }>;

async function resolveLockedTelegramFundingReview(
  client: PoolClient,
  input: Readonly<{
    chatId: string;
    idempotencyKey: string;
    link: ActiveTelegramAccountLink;
    now: Date;
    receiptId: string;
    requestFingerprint: string;
    telegramMessageId: number | null;
    telegramUserId: string;
  }>,
): Promise<LockedTelegramFundingReview> {
  await lockTelegramFundingLinkLifecycle(client, input.link.userId);
  const replay = await fetchTelegramFundingReviewMutationReplay(client, {
    idempotencyKey: input.idempotencyKey,
    receiptId: input.receiptId,
    requestFingerprint: input.requestFingerprint,
    telegramAccountId: input.link.linkId,
    telegramUserId: input.telegramUserId,
    chatId: input.chatId,
    userId: input.link.userId,
  });
  if (replay) return { kind: "response", response: replay };
  const target = await lockActiveTelegramFundingReviewTarget(client, {
    receiptId: input.receiptId,
    userId: input.link.userId,
    telegramAccountId: input.link.linkId,
    telegramUserId: input.telegramUserId,
    telegramMessageId: input.telegramMessageId,
    chatId: input.chatId,
    now: input.now,
  });
  if (
    !target ||
    !(await isTelegramFundingReceiveControllerCurrent(client, {
      receiveSessionId: target.receiveSessionId,
      telegramAccountId: input.link.linkId,
      telegramUserId: input.telegramUserId,
      userId: input.link.userId,
    }))
  ) {
    throw new TelegramFundingError("funding_context_not_found");
  }
  if (!target.quoteId) return { kind: "target", target };
  const activeResponse = await fetchActiveTelegramFundingReviewResponse(
    client,
    {
      contextId: target.contextId,
      quoteId: target.quoteId,
      receiptId: target.receiptId,
      userId: input.link.userId,
      now: input.now,
    },
  );
  if (!activeResponse) return { kind: "target", target };
  // One live receipt quote may have many Telegram delivery/callback IDs.
  // Persist each replay key without replacing the consent token already shown.
  const response = await recordTelegramFundingReviewMutation(client, {
    contextId: target.contextId,
    idempotencyKey: input.idempotencyKey,
    quoteId: target.quoteId,
    receiptId: target.receiptId,
    requestFingerprint: input.requestFingerprint,
    responsePayload: activeResponse,
    now: input.now,
  });
  return { kind: "response", response };
}

export class TelegramFundingService {
  private readonly receive: FundingReceiveSessionService;
  private readonly runtime: FundingPlanningRuntime;
  private readonly provisionAuthorization: TelegramFundingAuthorizationProvisioner | null;
  private readonly resolveManagedWallet: TelegramFundingManagedWalletResolver | null;

  constructor(
    private readonly pool: Pool,
    dependencies: Readonly<{
      provisionAuthorization?: TelegramFundingAuthorizationProvisioner;
      resolveManagedWallet?: TelegramFundingManagedWalletResolver;
    }> = {},
  ) {
    this.receive = new FundingReceiveSessionService(pool);
    this.runtime = new FundingPlanningRuntime(pool);
    this.provisionAuthorization = dependencies.provisionAuthorization ?? null;
    this.resolveManagedWallet = dependencies.resolveManagedWallet ?? null;
  }

  private async provisionFundingAuthorization(
    input: Readonly<{
      destination: Pick<
        FundingDestinationOption,
        | "controllerWalletId"
        | "destinationOptionId"
        | "venueBindingOptionId"
        | "venueId"
      >;
      identity: Readonly<{ telegramUserId: string }>;
      link: ActiveTelegramAccountLink;
      now: Date;
    }>,
  ): Promise<void> {
    if (
      input.destination.venueId !== "limitless" &&
      input.destination.venueId !== "polymarket"
    ) {
      return;
    }
    await this.provisionAuthorization?.({
      userId: input.link.userId,
      telegramAccountId: input.link.linkId,
      telegramUserId: input.identity.telegramUserId,
      controllerWalletId: input.destination.controllerWalletId,
      destinationOptionId: input.destination.destinationOptionId,
      venueBindingOptionId: input.destination.venueBindingOptionId,
      venueId: input.destination.venueId,
      now: input.now,
    });
  }

  private async managedWallet(
    link: ActiveTelegramAccountLink,
    telegramUserId: string,
  ): Promise<Readonly<{
    controllerWalletId: string;
    walletAddress: string;
  }> | null> {
    if (!this.resolveManagedWallet) return null;
    return this.resolveManagedWallet({
      userId: link.userId,
      telegramAccountId: link.linkId,
      telegramUserId,
    });
  }

  private async frozenControllerWalletId(
    userId: string,
    receiveSessionId: string,
  ): Promise<string | null> {
    const { rows } = await this.pool.query<{
      controller_wallet_id: string | null;
    }>(
      `select destination_target_snapshot #>>
                '{location,details,controllerWalletId}' as controller_wallet_id
         from funding_receive_sessions
        where id = $1
          and user_id = $2
          and owner_channel = 'telegram'
        limit 1`,
      [receiveSessionId, userId],
    );
    const controllerWalletId = rows[0]?.controller_wallet_id?.trim();
    return controllerWalletId ? controllerWalletId : null;
  }

  private async provisionExistingContext(
    input: Readonly<{
      context: TelegramFundingSessionContext;
      identity: Readonly<{ telegramUserId: string }>;
      link: ActiveTelegramAccountLink;
      now: Date;
    }>,
  ): Promise<void> {
    const [receive, controllerWalletId] = await Promise.all([
      loadTelegramFundingReceiveSession(
        this.receive,
        input.link.userId,
        input.context.receiveSessionId,
      ),
      this.frozenControllerWalletId(
        input.link.userId,
        input.context.receiveSessionId,
      ),
    ]);
    if (!receive || !controllerWalletId) return;
    await this.provisionFundingAuthorization({
      destination: {
        controllerWalletId,
        destinationOptionId: receive.session.destinationOptionId,
        venueBindingOptionId: receive.session.venueBindingOptionId,
        venueId: receive.session.venueId,
      },
      identity: input.identity,
      link: input.link,
      now: input.now,
    });
  }

  private async presentExistingContext(
    input: Readonly<{
      context: TelegramFundingSessionContext;
      decorateProgress?: TelegramFundingProgressDecorator;
      identity: Readonly<{ chatId: string; telegramUserId: string }>;
      link: ActiveTelegramAccountLink;
      now: Date;
      telegramMessageId?: number | null;
      venue?: string;
    }>,
  ): Promise<TelegramFundingMessage> {
    if (
      input.telegramMessageId != null &&
      input.context.telegramMessageId != null &&
      input.telegramMessageId !== input.context.telegramMessageId
    ) {
      return buildTelegramFundingActiveElsewhereMessage({
        projection: parseTelegramFundingProgressProjection(
          input.context.latestProgressProjection,
        ),
        venue: input.venue,
      });
    }
    await this.provisionExistingContext(input);
    const message = await this.session(
      {
        contextId: input.context.id,
        telegramUserId: input.identity.telegramUserId,
        chatId: input.identity.chatId,
        view: "progress",
      },
      input.now,
      input.decorateProgress,
    );
    if (message.durableFundingDeliveryRequired) {
      const currentContext = await fetchTelegramFundingSessionContext(
        this.pool,
        {
          contextId: input.context.id,
          userId: input.link.userId,
          telegramUserId: input.identity.telegramUserId,
          chatId: input.identity.chatId,
        },
      );
      if (!currentContext) return message;
      await rearmTelegramFundingCurrentAddressDelivery({
        context: currentContext,
        pool: this.pool,
        telegramAccountId: input.link.linkId,
        telegramUserId: input.identity.telegramUserId,
        userId: input.link.userId,
      });
    }
    return message;
  }

  private async currentLink(input: TelegramFundingIdentityInput) {
    const identity = resolveTelegramFundingPrivateIdentity(input);
    const link = await resolveActiveTelegramAccountLink({
      db: this.pool,
      telegramUserId: identity.telegramUserId,
    });
    if (!link) throw new TelegramFundingError("telegram_account_required");
    return { identity, link };
  }

  private async resolveTargetCapability(
    input: Readonly<{
      link: ActiveTelegramAccountLink;
      session: FundingReceiveSession;
      telegramUserId: string;
      expectedFundingPolicyRevision?: string;
      routeKey?: string;
    }>,
  ): Promise<
    Readonly<{
      authorization: TelegramFundingAuthorization | null;
      decision: DelegatedFundingPreBroadcastDecision;
      fundingPolicyRevision: string;
      target: TelegramFundingTargetCapability | null;
    }>
  > {
    const capability = await resolveTelegramFundingRouteCapability(this.pool, {
      userId: input.link.userId,
      telegramAccountId: input.link.linkId,
      telegramUserId: input.telegramUserId,
      session: input.session,
      expectedFundingPolicyRevision: input.expectedFundingPolicyRevision,
      routeKey: input.routeKey,
    });
    if (!capability) {
      throw new TelegramFundingError("destination_ambiguous");
    }
    return capability;
  }

  private async resolveTargetCapabilities(
    input: Readonly<{
      link: ActiveTelegramAccountLink;
      session: FundingReceiveSession;
      telegramUserId: string;
    }>,
  ) {
    return resolveTelegramFundingRouteCapabilities(this.pool, {
      userId: input.link.userId,
      telegramAccountId: input.link.linkId,
      telegramUserId: input.telegramUserId,
      session: input.session,
    });
  }

  private async resolveReceiveDestination(
    userId: string,
    venueId: string,
    controllerWalletId: string | null,
  ): Promise<FundingDestinationOption> {
    const policy = await resolveSignalBotTradingPolicyStateFromDb(this.pool);
    if (!policy.policy.fundingReceiveEnabled) {
      throw new TelegramFundingError("funding_receive_disabled");
    }
    const destination = resolveTelegramFundingDestination({
      controllerWalletId,
      destinations: await this.runtime.destinations(userId, {
        purpose: "fund",
      }),
      venueId,
    });
    if (!destination) {
      throw new TelegramFundingError("destination_ambiguous");
    }
    return destination;
  }

  private async currentReceiveControllerWalletId(
    input: Readonly<{
      link: ActiveTelegramAccountLink;
      receiveSessionId: string;
      session: FundingReceiveSession;
      telegramUserId: string;
    }>,
  ): Promise<string | null> {
    const frozenControllerWalletId = await this.frozenControllerWalletId(
      input.link.userId,
      input.receiveSessionId,
    );
    if (!frozenControllerWalletId) return null;
    if (!this.resolveManagedWallet) {
      return resolveTelegramFundingCurrentController({
        currentControllerWalletId: frozenControllerWalletId,
        frozenControllerWalletId,
        session: input.session,
      });
    }
    const managedWallet = await this.managedWallet(
      input.link,
      input.telegramUserId,
    );
    const currentControllerWalletId = managedWallet
      ? telegramFundingManagedWalletControllerId(
          managedWallet,
          input.session.destinationAsset.networkId,
        )
      : null;
    return resolveTelegramFundingCurrentController({
      currentControllerWalletId,
      frozenControllerWalletId,
      session: input.session,
    });
  }

  private async openReceiveContext(
    input: Readonly<{
      afterContext?: (
        client: PoolClient,
        context: TelegramFundingOpenContext,
      ) => Promise<void>;
      contextIdempotencyKey: string;
      controllerWalletId: string | null;
      destination: Pick<
        FundingDestinationOption,
        "destinationOptionId" | "venueBindingOptionId"
      >;
      identity: Readonly<{ chatId: string; telegramUserId: string }>;
      initialBuyReturn?: TelegramFundingInitialBuyReturn;
      initialLink: ActiveTelegramAccountLink;
      now: Date;
      reuseActiveContextForBuyReturn?: boolean;
      telegramMessageId: number | null;
      venueId: string;
    }>,
  ): Promise<TelegramFundingOpenContext> {
    let result: TelegramFundingOpenContext | undefined;
    let supersededContext: TelegramFundingSessionContext | null = null;
    const reuseActiveContext = async (): Promise<
      TelegramFundingOpenContext | undefined
    > => {
      if (!input.reuseActiveContextForBuyReturn) return undefined;
      return tx(this.pool, async (client) => {
        const active = await prepareTelegramFundingSessionOpenInTransaction(
          client,
          {
            chatId: input.identity.chatId,
            controllerWalletId: input.controllerWalletId ?? undefined,
            destinationOptionId: input.destination.destinationOptionId,
            now: input.now,
            reuseActiveContextForBuyReturn: true,
            telegramAccountId: input.initialLink.linkId,
            telegramMessageId: input.telegramMessageId,
            telegramUserId: input.identity.telegramUserId,
            userId: input.initialLink.userId,
            venueBindingOptionId: input.destination.venueBindingOptionId,
            venueId: input.venueId,
          },
        );
        if (!active) return undefined;
        const frozenReceive = await client.query<{
          destination_option_id: string;
          venue_binding_option_id: string;
        }>(
          `
            select
              receive_session.destination_option_id,
              receive_session.venue_binding_option_id
            from funding_receive_sessions receive_session
            where receive_session.id = $1::uuid
              and receive_session.user_id = $2::uuid
              and receive_session.owner_channel = 'telegram'
              and receive_session.venue_id = $3
            for update of receive_session
          `,
          [active.receiveSessionId, input.initialLink.userId, input.venueId],
        );
        const frozenBinding = frozenReceive.rows[0];
        if (!frozenBinding) {
          throw new TelegramFundingPersistenceError(
            "telegram_funding_session_unavailable",
          );
        }
        const opened: TelegramFundingOpenContext = {
          context: active,
          replayed: false,
          reusedActiveMessage: true,
          reusedReceiveBinding: {
            destinationOptionId: frozenBinding.destination_option_id,
            venueBindingOptionId: frozenBinding.venue_binding_option_id,
          },
        };
        await input.afterContext?.(client, opened);
        return opened;
      });
    };
    try {
      const active = await reuseActiveContext();
      if (active) return active;
      await this.receive.open(
        input.initialLink.userId,
        {
          destinationOptionId: input.destination.destinationOptionId,
          venueBindingOptionId: input.destination.venueBindingOptionId,
          selectedReceiveTargetId: null,
        },
        input.now,
        "telegram",
        async (client, persisted) => {
          const currentLink = await resolveActiveTelegramAccountLink({
            db: client,
            telegramUserId: input.identity.telegramUserId,
          });
          if (!sameActiveTelegramAccountLink(input.initialLink, currentLink)) {
            throw new TelegramFundingError("telegram_account_required");
          }
          if (supersededContext) {
            const priorProjection = parseTelegramFundingProgressProjection(
              supersededContext.latestProgressProjection,
            );
            const priorConsent = await fetchActiveTelegramFundingConsent(
              client,
              supersededContext.id,
            );
            const presentation =
              priorProjection?.presentation ??
              (priorConsent
                ? resolveTelegramFundingConsentRoute(priorConsent)?.presentation
                : null) ??
              resolveTelegramFundingTarget({
                automaticConversionEnabled: false,
                session: persisted.snapshot.session,
              })?.presentation;
            if (!presentation) {
              throw new TelegramFundingError("destination_ambiguous");
            }
            const terminal = projectTelegramFundingCancelled(
              supersededContext,
              presentation,
            );
            await finalizeSupersededTelegramFundingSessionInTransaction(
              client,
              {
                context: supersededContext,
                fingerprint: telegramFundingProgressFingerprint(terminal),
                now: input.now,
                projection: jsonRecord(terminal),
              },
            );
          }
          const opened = await createOrReuseTelegramFundingSessionInTransaction(
            client,
            {
              userId: input.initialLink.userId,
              telegramAccountId: input.initialLink.linkId,
              telegramUserId: input.identity.telegramUserId,
              chatId: input.identity.chatId,
              telegramMessageId: input.telegramMessageId,
              receiveSessionId: persisted.snapshot.session.receiveSessionId,
              idempotencyKey: input.contextIdempotencyKey,
              expiresAt: new Date(persisted.snapshot.session.expiresAt),
              now: input.now,
              initialBuyReturn: input.initialBuyReturn,
            },
          );
          await input.afterContext?.(client, opened);
          result = opened;
        },
        async (client) => {
          supersededContext =
            await prepareTelegramFundingSessionOpenInTransaction(client, {
              chatId: input.identity.chatId,
              controllerWalletId: input.controllerWalletId ?? undefined,
              destinationOptionId: input.destination.destinationOptionId,
              now: input.now,
              ...(input.reuseActiveContextForBuyReturn
                ? { supersedeInactiveContextForBuyReturn: true }
                : {}),
              telegramAccountId: input.initialLink.linkId,
              telegramMessageId: input.telegramMessageId,
              telegramUserId: input.identity.telegramUserId,
              userId: input.initialLink.userId,
              venueBindingOptionId: input.destination.venueBindingOptionId,
              venueId: input.venueId,
            });
        },
      );
    } catch (error) {
      if (
        input.reuseActiveContextForBuyReturn &&
        error instanceof TelegramFundingPersistenceError &&
        error.code === "telegram_funding_session_active_elsewhere"
      ) {
        const raced = await reuseActiveContext();
        if (raced) return raced;
      }
      if (
        error instanceof FundingPlannerError &&
        error.code === "receive_channel_conflict"
      ) {
        throw new TelegramFundingError("receive_channel_conflict");
      }
      rethrowTelegramFundingPersistenceError(error);
    }
    if (!result) {
      throw new TelegramFundingError("funding_context_not_found");
    }
    return result;
  }

  async open(
    input: TelegramFundingMutationInput & { venue: string },
    now = new Date(),
    decorateProgress?: TelegramFundingProgressDecorator,
  ): Promise<TelegramFundingMessage> {
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    const { identity, link: initialLink } = await this.currentLink(input);
    const requestFingerprint = canonicalJsonHash({
      action: "open",
      chatId: identity.chatId,
      telegramMessageId: input.telegramMessageId,
      telegramUserId: identity.telegramUserId,
      userId: initialLink.userId,
      venue: input.venue,
    });
    try {
      const mutationReplay = await fetchTelegramFundingOpenMutationReplay(
        this.pool,
        {
          idempotencyKey,
          requestFingerprint,
          userId: initialLink.userId,
          telegramUserId: identity.telegramUserId,
          chatId: identity.chatId,
        },
      );
      if (mutationReplay) {
        return this.presentExistingContext({
          context: mutationReplay,
          decorateProgress,
          identity,
          link: initialLink,
          now,
          telegramMessageId: input.telegramMessageId,
          venue: input.venue,
        });
      }
    } catch (error) {
      rethrowTelegramFundingPersistenceError(error);
    }
    const replay = await fetchTelegramFundingSessionByIdempotency(this.pool, {
      idempotencyKey,
      userId: initialLink.userId,
      telegramUserId: identity.telegramUserId,
      chatId: identity.chatId,
    });
    if (replay) {
      return this.presentExistingContext({
        context: replay,
        decorateProgress,
        identity,
        link: initialLink,
        now,
        telegramMessageId: input.telegramMessageId,
        venue: input.venue,
      });
    }
    const managedWallet = this.resolveManagedWallet
      ? await this.managedWallet(initialLink, identity.telegramUserId)
      : null;
    if (this.resolveManagedWallet && !managedWallet) {
      throw new TelegramFundingError("destination_ambiguous");
    }
    const requestedNetworkId = telegramFundingVenueNetworkId(input.venue);
    const controllerWalletId =
      managedWallet && requestedNetworkId
        ? telegramFundingManagedWalletControllerId(
            managedWallet,
            requestedNetworkId,
          )
        : null;
    if (this.resolveManagedWallet && !controllerWalletId) {
      throw new TelegramFundingError("destination_ambiguous");
    }
    let destination = this.resolveManagedWallet
      ? await this.resolveReceiveDestination(
          initialLink.userId,
          input.venue,
          controllerWalletId,
        )
      : null;
    let active: TelegramFundingSessionContext | null;
    try {
      active = await reuseActiveTelegramFundingSession(this.pool, {
        userId: initialLink.userId,
        telegramAccountId: initialLink.linkId,
        telegramUserId: identity.telegramUserId,
        chatId: identity.chatId,
        telegramMessageId: input.telegramMessageId,
        venueId: input.venue,
        presentAcrossMessages: true,
        controllerWalletId: controllerWalletId ?? undefined,
        venueBindingOptionId: destination?.venueBindingOptionId,
        idempotencyKey,
        requestFingerprint,
        now,
      });
    } catch (error) {
      rethrowTelegramFundingPersistenceError(error);
    }
    if (active) {
      return this.presentExistingContext({
        context: active,
        decorateProgress,
        identity,
        link: initialLink,
        now,
        telegramMessageId: input.telegramMessageId,
        venue: input.venue,
      });
    }
    destination ??= await this.resolveReceiveDestination(
      initialLink.userId,
      input.venue,
      controllerWalletId,
    );
    await this.provisionFundingAuthorization({
      destination: { ...destination, venueId: input.venue },
      identity,
      link: initialLink,
      now,
    });
    const context = await this.openReceiveContext({
      initialLink,
      identity,
      destination,
      controllerWalletId,
      telegramMessageId: input.telegramMessageId,
      contextIdempotencyKey: idempotencyKey,
      now,
      venueId: input.venue,
      afterContext: async (client, opened) => {
        await recordTelegramFundingOpenMutation(client, {
          contextId: opened.context.id,
          idempotencyKey,
          requestFingerprint,
          now,
        });
      },
    });
    if (context.replayed) {
      return this.session(
        {
          contextId: context.context.id,
          telegramUserId: identity.telegramUserId,
          telegramMessageId: input.telegramMessageId,
          chatId: identity.chatId,
          view: "progress",
        },
        now,
        decorateProgress,
      );
    }
    return this.session(
      {
        contextId: context.context.id,
        telegramUserId: identity.telegramUserId,
        telegramMessageId: input.telegramMessageId,
        chatId: identity.chatId,
        view: "progress",
      },
      now,
      decorateProgress,
    );
  }

  async openBuyReturn(
    input: TelegramFundingBuyReturnOpenInput,
    now = new Date(),
    decorateProgress?: TelegramFundingProgressDecorator,
  ): Promise<TelegramFundingMessage> {
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    const { identity, link: initialLink } = await this.currentLink(input);
    const requestedSpendUsd = canonicalTelegramFundingBuySpend(
      input.requestedSpendUsd,
    );
    const minimumFundingUsd = input.minimumFundingUsd
      ? canonicalTelegramFundingBuySpend(input.minimumFundingUsd)
      : null;
    const replay = await this.pool.query<{
      action: string;
      buy_return_revision: number | null;
      chat_id: string;
      destination_option_id: string;
      funding_context_id: string;
      request_fingerprint: string;
      telegram_account_id: string | null;
      telegram_message_id: string | number | null;
      telegram_user_id: string;
      user_id: string;
      venue_binding_option_id: string;
      venue_id: string;
    }>(
      `
        select
          mutation.action,
          mutation.buy_return_revision,
          mutation.funding_context_id,
          mutation.request_fingerprint,
          context.user_id,
          context.telegram_account_id,
          context.telegram_message_id,
          context.telegram_user_id,
          context.chat_id,
          buy_return.venue_id,
          buy_return.destination_option_id,
          buy_return.venue_binding_option_id
        from telegram_funding_mutations mutation
        join telegram_funding_sessions context
          on context.id = mutation.funding_context_id
        join telegram_funding_buy_return_revisions buy_return
          on buy_return.telegram_funding_session_id = mutation.funding_context_id
         and buy_return.revision = mutation.buy_return_revision
        where mutation.idempotency_key = $1
        limit 1
      `,
      [idempotencyKey],
    );
    const replayed = replay.rows[0];
    if (replayed) {
      const replayFingerprint =
        replayed.venue_id === "polymarket" || replayed.venue_id === "limitless"
          ? buildTelegramFundingBuyReturnRequestFingerprint({
              destinationOptionId: replayed.destination_option_id,
              identity,
              link: initialLink,
              request: input,
              venueBindingOptionId: replayed.venue_binding_option_id,
            })
          : null;
      if (
        replayed.action !== "set_buy_return" ||
        replayed.buy_return_revision == null ||
        replayed.user_id !== initialLink.userId ||
        replayed.telegram_account_id !== initialLink.linkId ||
        replayed.telegram_user_id !== identity.telegramUserId ||
        replayed.chat_id !== identity.chatId ||
        replayed.venue_id !== input.venue ||
        replayFingerprint !== replayed.request_fingerprint
      ) {
        throw new TelegramFundingError("idempotency_conflict");
      }
      const replayContext = await fetchTelegramFundingSessionContext(
        this.pool,
        {
          contextId: replayed.funding_context_id,
          userId: initialLink.userId,
          telegramUserId: identity.telegramUserId,
          chatId: identity.chatId,
        },
      );
      if (!replayContext) {
        throw new TelegramFundingError("funding_context_not_found");
      }
      if (
        replayed.telegram_message_id != null &&
        Number(replayed.telegram_message_id) !== input.telegramMessageId
      ) {
        await this.projectBuyReturnAttachmentBestEffort(replayContext.id, now);
        return buildTelegramFundingBuyReturnAttachedMessage();
      }
      return this.presentExistingContext({
        context: replayContext,
        decorateProgress,
        identity,
        link: initialLink,
        now,
      });
    }
    const initialPolicy = await resolveSignalBotTradingPolicyStateFromDb(
      this.pool,
    );
    if (
      !initialPolicy.policy.fundingReceiveEnabled ||
      !initialPolicy.policy.buyContinuationEnabled
    ) {
      throw new TelegramFundingError("funding_buy_continuation_disabled");
    }
    const managedWallet = await this.managedWallet(
      initialLink,
      identity.telegramUserId,
    );
    if (this.resolveManagedWallet && !managedWallet) {
      throw new TelegramFundingError("destination_ambiguous");
    }
    const destination = await this.resolveReceiveDestination(
      initialLink.userId,
      input.venue,
      managedWallet?.controllerWalletId ?? null,
    );
    await this.provisionFundingAuthorization({
      destination: { ...destination, venueId: input.venue },
      identity,
      link: initialLink,
      now,
    });
    const telegramBinding = {
      userId: initialLink.userId,
      telegramAccountId: initialLink.linkId,
      telegramUserId: identity.telegramUserId,
      chatId: identity.chatId,
    } as const;
    const receiveBinding = {
      venueId: input.venue,
      destinationOptionId: destination.destinationOptionId,
      venueBindingOptionId: destination.venueBindingOptionId,
    } as const;
    const returnRequest = {
      marketId: input.marketId,
      eventId: input.eventId,
      side: input.side,
      requestedSpendUsd,
      sourceShortfallIntentId: input.sourceIntentId,
    } as const;
    const context = await this.openReceiveContext({
      initialLink,
      identity,
      destination,
      controllerWalletId: managedWallet?.controllerWalletId ?? null,
      telegramMessageId: input.telegramMessageId,
      contextIdempotencyKey: `buy-return:${input.sourceIntentId}`,
      initialBuyReturn: {
        eventId: input.eventId,
        marketId: input.marketId,
        minimumFundingUsd,
        requestedSpendUsd,
        side: input.side,
      },
      now,
      reuseActiveContextForBuyReturn: true,
      venueId: input.venue,
      afterContext: async (client, context) => {
        const effectiveReceiveBinding = {
          venueId: input.venue,
          ...(context.reusedReceiveBinding ?? receiveBinding),
        } as const;
        const requestFingerprint =
          buildTelegramFundingBuyReturnRequestFingerprint({
            destinationOptionId: effectiveReceiveBinding.destinationOptionId,
            identity,
            link: initialLink,
            request: input,
            venueBindingOptionId: effectiveReceiveBinding.venueBindingOptionId,
          });
        const mutation = await client.query<{
          action: string;
          funding_context_id: string;
          request_fingerprint: string;
        }>(
          `
              select action, funding_context_id, request_fingerprint
              from telegram_funding_mutations
              where idempotency_key = $1
              limit 1
            `,
          [idempotencyKey],
        );
        const existingMutation = mutation.rows[0];
        if (existingMutation) {
          if (
            existingMutation.action !== "set_buy_return" ||
            existingMutation.funding_context_id !== context.context.id ||
            existingMutation.request_fingerprint !== requestFingerprint
          ) {
            throw new TelegramFundingError("idempotency_conflict");
          }
          return;
        }

        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [
            [
              "telegram-bot-trade",
              identity.telegramUserId,
              input.marketId,
            ].join(":"),
          ],
        );
        const currentPolicy =
          await resolveSignalBotTradingPolicyStateFromDb(client);
        const currentMarket = await findTradeMarketById(client, input.marketId);
        const lifecycleAllowed = await venueLifecycleAllowsTradingAction(
          client,
          input.venue,
          "BUY",
          { automation: true },
        );
        if (
          !canAttachTelegramFundingBuyReturn({
            currentPolicyRevision: currentPolicy.policyRevision,
            eventId: input.eventId,
            initialPolicyRevision: initialPolicy.policyRevision,
            lifecycleAllowed,
            market: currentMarket,
            policy: currentPolicy.policy,
            venue: input.venue,
          })
        ) {
          throw new TelegramFundingError("funding_buy_continuation_disabled");
        }
        const sourceIntent =
          await loadTelegramFundingBuyReturnSourceIntentForUpdate(client, {
            sourceIntentId: input.sourceIntentId,
            telegramAccountId: initialLink.linkId,
          });
        const sourceAuthority = parseTelegramBotTradeAuthorityBinding(
          sourceIntent?.telegram_authority,
        );
        const currentAuthority = sourceIntent
          ? {
              authorizationId: sourceIntent.authorization_id ?? "",
              privyWalletId: sourceIntent.authorization_privy_wallet_id ?? "",
              telegramAccountLinkId: initialLink.linkId,
              userId: initialLink.userId,
              walletAddress: sourceIntent.authorization_wallet_address,
              walletChain: sourceIntent.authorization_wallet_chain,
            }
          : null;
        const authorizationMaxAmountUsd = Number(
          sourceIntent?.authorization_max_amount_usd,
        );
        const effectiveMaxAmountUsd =
          sourceIntent?.authorization_max_amount_usd == null
            ? currentPolicy.policy.maxTradeAmountUsd
            : Math.min(
                currentPolicy.policy.maxTradeAmountUsd,
                authorizationMaxAmountUsd,
              );
        if (
          !sourceIntent ||
          !sourceAuthority ||
          !currentAuthority ||
          telegramBotTradeAuthorityFingerprint(sourceAuthority) !==
            telegramBotTradeAuthorityFingerprint(currentAuthority) ||
          sourceAuthority.authorizationId !== input.authorizationId ||
          sourceAuthority.telegramAccountLinkId !== initialLink.linkId ||
          sourceAuthority.userId !== initialLink.userId ||
          sourceIntent.action !== "buy" ||
          sourceIntent.user_id !== initialLink.userId ||
          sourceIntent.authorization_id !== input.authorizationId ||
          sourceIntent.telegram_user_id !== identity.telegramUserId ||
          sourceIntent.chat_id !== identity.chatId ||
          sourceIntent.delivery_mode !==
            (input.continuationMode ?? "bot_submit") ||
          sourceIntent.venue !== input.venue ||
          sourceIntent.market_id !== input.marketId ||
          sourceIntent.event_id !== input.eventId ||
          sourceIntent.side !== input.side ||
          sourceIntent.amount_usd == null ||
          canonicalTelegramFundingBuySpend(String(sourceIntent.amount_usd)) !==
            requestedSpendUsd ||
          !Number.isFinite(effectiveMaxAmountUsd) ||
          Number(requestedSpendUsd) > effectiveMaxAmountUsd ||
          !["draft", "previewed"].includes(sourceIntent.status) ||
          sourceIntent.submit_started_at != null ||
          sourceIntent.funding_operation_id != null ||
          sourceIntent.funding_reservation_id != null
        ) {
          throw new TelegramFundingError("funding_context_not_found");
        }
        const unresolved = await client.query<{ blocked: boolean }>(
          `
              select exists (
                select 1
                from telegram_trade_intents
                where telegram_user_id = $1
                  and market_id = $2
                  and id <> $3::uuid
                  and status in (
                    'confirming',
                    'executing',
                    'submitted',
                    'reconcile_required'
                  )
              ) as blocked
            `,
          [identity.telegramUserId, input.marketId, input.sourceIntentId],
        );
        if (unresolved.rows[0]?.blocked) {
          throw new TelegramFundingError("funding_context_not_found");
        }
        const appended = await appendTelegramFundingBuyReturnInTransaction(
          client,
          {
            contextId: context.context.id,
            ...telegramBinding,
            ...effectiveReceiveBinding,
            ...returnRequest,
            sourceAuthorityFingerprint:
              telegramBotTradeAuthorityFingerprint(sourceAuthority),
            continuationMode: input.continuationMode ?? "bot_submit",
            idempotencyKey,
            requestFingerprint,
            responsePayload: { fundingContextId: context.context.id },
            now,
          },
        );
        if (!appended.replayed) {
          const cancelled = await client.query(
            `
                update telegram_trade_intents
                set status = 'cancelled',
                    error_code = 'superseded_via_funding',
                    error_message = 'A fresh Buy will be created after funding is ready.',
                    updated_at = $2
                where id = $1::uuid
                  and status in ('draft', 'previewed')
                  and submit_started_at is null
                  and funding_operation_id is null
                  and funding_reservation_id is null
              `,
            [input.sourceIntentId, now],
          );
          if ((cancelled.rowCount ?? 0) !== 1) {
            throw new TelegramFundingError("funding_context_not_found");
          }
        }
      },
    });
    if (context.reusedActiveMessage) {
      await this.projectBuyReturnAttachmentBestEffort(context.context.id, now);
      return buildTelegramFundingBuyReturnAttachedMessage();
    }
    return this.session(
      {
        contextId: context.context.id,
        telegramUserId: identity.telegramUserId,
        telegramMessageId: input.telegramMessageId,
        chatId: identity.chatId,
        view: "progress",
      },
      now,
      decorateProgress,
    );
  }

  private async loadOwned(
    input: TelegramFundingIdentityInput & { contextId: string },
  ) {
    const { identity, link } = await this.currentLink(input);
    const context = await fetchTelegramFundingSessionContext(this.pool, {
      contextId: input.contextId,
      userId: link.userId,
      telegramUserId: identity.telegramUserId,
      chatId: identity.chatId,
    });
    if (!context) {
      throw new TelegramFundingError("funding_context_not_found");
    }
    if (
      input.telegramMessageId != null &&
      context.telegramMessageId !== input.telegramMessageId
    ) {
      throw new TelegramFundingError("funding_context_not_found");
    }
    const receive = await loadTelegramFundingReceiveSession(
      this.receive,
      link.userId,
      context.receiveSessionId,
    );
    if (!receive) {
      throw new TelegramFundingError("funding_context_not_found");
    }
    const [consent, afterBroadcastBoundaryReceiptIds] = await Promise.all([
      fetchActiveTelegramFundingConsent(this.pool, context.id),
      listFundingReceiveRoutingReceiptIdsAfterBroadcastBoundary(this.pool, {
        userId: link.userId,
        receiveSessionId: context.receiveSessionId,
      }),
    ]);
    return {
      afterBroadcastBoundaryReceiptIds,
      consent,
      context,
      identity,
      link,
      receive,
    };
  }

  private async enqueueQrPhoto(input: {
    context: TelegramFundingSessionContext;
    link: ActiveTelegramAccountLink;
  }): Promise<boolean> {
    return tx(this.pool, async (client) => {
      await lockTelegramFundingLinkLifecycle(client, input.link.userId);
      // A sent QR may already have been hidden or deleted in Telegram. An
      // explicit QR callback therefore re-arms the single durable outbox row.
      const queued = await client.query(
        `
          insert into telegram_bot_action_outbox (
            action,
            telegram_account_id,
            user_id,
            telegram_user_id,
            funding_session_id,
            state_revision,
            payload
          )
          select
            'funding_qr',
            account.id,
            context.user_id,
            context.telegram_user_id,
            context.id,
            context.progress_revision,
            context.latest_progress_projection
          from telegram_funding_sessions context
          join user_telegram_accounts account
            on account.id = $3::uuid
           and account.user_id = context.user_id
           and account.telegram_user_id = context.telegram_user_id
          where context.id = $1::uuid
            and context.user_id = $2::uuid
            and context.telegram_message_id is not null
            and context.progress_revision > 0
            and context.latest_progress_projection is not null
            and context.latest_terminal_projection is null
            and jsonb_typeof(
                  context.latest_progress_projection->'receiveAddress'
                ) = 'string'
            and length(trim(
                  context.latest_progress_projection->>'receiveAddress'
                )) > 0
          on conflict (funding_session_id, action)
            where action = 'funding_qr'
          do update
            set telegram_account_id = excluded.telegram_account_id,
                user_id = excluded.user_id,
                telegram_user_id = excluded.telegram_user_id,
                state_revision = excluded.state_revision,
                payload = excluded.payload,
                status = 'pending',
                attempt_count = 0,
                next_attempt_at = now(),
                telegram_message_id = null,
                last_error = null,
                sent_at = null,
                delivery_attempt_id = null,
                delivery_started_at = null,
                updated_at = now()
          where (
            telegram_bot_action_outbox.status in ('retry', 'dead', 'skipped')
            and telegram_bot_action_outbox.telegram_message_id is null
          ) or telegram_bot_action_outbox.status = 'sent'
          returning id
        `,
        [input.context.id, input.link.userId, input.link.linkId],
      );
      if ((queued.rowCount ?? 0) === 1) return true;
      const existing = await client.query<{ id: string }>(
        `
          select id
          from telegram_bot_action_outbox
          where funding_session_id = $1::uuid
            and action = 'funding_qr'
            and status in (
              'pending',
              'retry',
              'sending',
              'delivery_unknown',
              'sent'
            )
          limit 1
        `,
        [input.context.id],
      );
      return existing.rows.length === 1;
    });
  }

  async reviewConversion(
    input: TelegramFundingMutationInput & { receiptId: string },
    now = new Date(),
  ): Promise<TelegramFundingMessage> {
    const { identity, link } = await this.currentLink(input);
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    const requestFingerprint = canonicalJsonHash({
      action: "review_conversion",
      receiptId: input.receiptId,
      telegramAccountId: link.linkId,
      telegramMessageId: input.telegramMessageId,
      telegramUserId: identity.telegramUserId,
      chatId: identity.chatId,
      userId: link.userId,
    });
    const lockedInput = {
      chatId: identity.chatId,
      idempotencyKey,
      link,
      now,
      receiptId: input.receiptId,
      requestFingerprint,
      telegramMessageId: input.telegramMessageId,
      telegramUserId: identity.telegramUserId,
    };
    const initial = await tx(this.pool, (client) =>
      resolveLockedTelegramFundingReview(client, lockedInput),
    );
    if (initial.kind === "response") {
      return telegramFundingMessage(initial.response);
    }
    const prepared = await this.receive.prepareReviewQuote(
      link.userId,
      initial.target.receiveSessionId,
      initial.target.receiptId,
      "telegram",
      now,
    );
    const attachNow = new Date(Math.max(now.getTime(), Date.now()));
    const response = await tx(this.pool, async (client) => {
      const current = await resolveLockedTelegramFundingReview(client, {
        ...lockedInput,
        now: attachNow,
      });
      if (current.kind === "response") return current.response;
      const reviewed =
        await this.receive.attachPreparedReviewQuoteInTransaction(
          client,
          prepared,
          attachNow,
          current.target.quoteId,
        );
      const message = buildTelegramFundingReviewQuoteMessage({
        contextId: current.target.contextId,
        quote: reviewed.quote,
      });
      return recordTelegramFundingReviewMutation(client, {
        contextId: current.target.contextId,
        idempotencyKey,
        quoteId: reviewed.quote.quoteId,
        receiptId: current.target.receiptId,
        requestFingerprint,
        responsePayload: jsonRecord(message),
        now: attachNow,
      });
    });
    return telegramFundingMessage(response);
  }

  async confirmConversion(
    input: TelegramFundingIdentityInput & {
      consentToken: string;
      idempotencyKey: string;
    },
    now = new Date(),
    decorateProgress?: TelegramFundingProgressDecorator,
  ): Promise<TelegramFundingMessage> {
    const { identity, link } = await this.currentLink(input);
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    const lockTarget = async (client: PoolClient, checkedAt: Date) => {
      await lockTelegramFundingLinkLifecycle(client, link.userId);
      await lockFundingPolicyForTransaction(client);
      const clock = await client.query<{ now: Date }>(
        "select greatest($1::timestamptz, clock_timestamp()) as now",
        [checkedAt],
      );
      const boundaryNow = clock.rows[0]?.now;
      if (!boundaryNow) {
        throw new TelegramFundingError("funding_context_not_found");
      }
      const locked = await lockActiveTelegramFundingReviewByConsentToken(
        client,
        {
          userId: link.userId,
          telegramAccountId: link.linkId,
          telegramUserId: identity.telegramUserId,
          telegramMessageId: input.telegramMessageId ?? null,
          chatId: identity.chatId,
          consentToken: input.consentToken,
          now: boundaryNow,
        },
      );
      if (!locked?.quoteId) {
        throw new TelegramFundingError("funding_context_not_found");
      }
      if (
        !(await isTelegramFundingReceiveControllerCurrent(client, {
          receiveSessionId: locked.receiveSessionId,
          telegramAccountId: link.linkId,
          telegramUserId: identity.telegramUserId,
          userId: link.userId,
        }))
      ) {
        throw new TelegramFundingError("funding_context_not_found");
      }
      return { ...locked, quoteId: locked.quoteId, checkedAt: boundaryNow };
    };
    // Resolve the exact scoped quote first, then perform provider/RPC account
    // inspection with no lifecycle or receipt locks held. The second lock/CAS
    // below rejects any target, wallet, policy, or consent change.
    const initial = await tx(this.pool, (client) => lockTarget(client, now));
    const prepared = await this.receive.prepareReviewCommit(
      link.userId,
      initial.receiveSessionId,
      initial.receiptId,
      {
        quoteId: initial.quoteId,
        consentToken: input.consentToken,
        idempotencyKey,
      },
      "telegram",
    );
    const target = await tx(this.pool, async (client) => {
      const locked = await lockTarget(client, now);
      if (
        locked.contextId !== initial.contextId ||
        locked.receiveSessionId !== initial.receiveSessionId ||
        locked.receiptId !== initial.receiptId ||
        locked.quoteId !== initial.quoteId
      ) {
        throw new TelegramFundingError("funding_context_not_found");
      }
      await this.receive.commitReviewInTransaction(
        client,
        link.userId,
        locked.receiveSessionId,
        locked.receiptId,
        {
          quoteId: locked.quoteId,
          consentToken: input.consentToken,
          idempotencyKey,
        },
        prepared,
        "telegram",
      );
      return locked;
    });
    await this.projectMutationContext(target.contextId, target.checkedAt);
    return this.session(
      {
        contextId: target.contextId,
        telegramUserId: identity.telegramUserId,
        telegramMessageId: input.telegramMessageId,
        chatId: identity.chatId,
        view: "progress",
      },
      target.checkedAt,
      decorateProgress,
    );
  }

  async session(
    input: TelegramFundingIdentityInput & {
      contextId: string;
      deliveryProjection?: unknown;
      requestObservation?: boolean;
      view?: "address" | "delivery" | "progress";
    },
    now = new Date(),
    decorateProgress?: TelegramFundingProgressDecorator,
  ): Promise<TelegramFundingMessage> {
    const owned = await this.loadOwned(input);
    if (input.requestObservation === true) {
      await requestFundingReceiveSessionObservation(this.pool, {
        now,
        receiveSessionId: owned.context.receiveSessionId,
        userId: owned.link.userId,
      });
    }
    const frozenPresentationMode = owned.consent
      ? (resolveTelegramFundingConsentRoute(owned.consent)?.mode ?? null)
      : null;
    const presentFrozenProgress = (
      progress: TelegramFundingProgressProjection,
      presentationMode: TelegramFundingReceivePresentationMode | null,
    ): Promise<TelegramFundingMessage> | TelegramFundingMessage => {
      const message = buildTelegramFundingProgressMessage(progress);
      return decorateProgress
        ? decorateProgress({
            consent: owned.consent,
            context: owned.context,
            message,
            now,
            presentationMode,
            progress,
            session: owned.receive.session,
          })
        : message;
    };
    const presentRetainedTerminal = (
      progress: TelegramFundingProgressProjection,
    ): Promise<TelegramFundingMessage> | TelegramFundingMessage =>
      progress.state === "ready"
        ? presentFrozenProgress(progress, frozenPresentationMode)
        : buildTelegramFundingProgressMessage(progress);
    const retainedTerminal = resolveTelegramFundingRetainedTerminal(
      owned.context.latestTerminalProjection,
      owned.context.id,
    );
    if (retainedTerminal.kind === "invalid") {
      return buildTelegramFundingUnavailableMessage({ reason: "unavailable" });
    }
    if (input.view === "delivery") {
      // The durable outbox projection is the only address-bearing input.
      // Buy continuation may decorate it, but must never recompute funding
      // state and revive an address after terminal redaction.
      const deliveryProgress = parseTelegramFundingProgressProjection(
        input.deliveryProjection,
      );
      if (
        !deliveryProgress ||
        deliveryProgress.fundingContextId !== owned.context.id
      ) {
        return buildTelegramFundingUnavailableMessage({
          reason: "unavailable",
        });
      }
      return retainedTerminal.kind === "valid"
        ? presentRetainedTerminal(retainedTerminal.projection)
        : presentFrozenProgress(deliveryProgress, frozenPresentationMode);
    }
    // Terminality is a context-level fact, not just a projector/outbox rule.
    // Every interactive view and Buy decorator must reuse the retained terminal
    // projection instead of rebuilding live progress after a controller restore.
    if (retainedTerminal.kind === "valid") {
      return presentRetainedTerminal(retainedTerminal.projection);
    }
    if (
      !(await this.currentReceiveControllerWalletId({
        link: owned.link,
        receiveSessionId: owned.context.receiveSessionId,
        session: owned.receive.session,
        telegramUserId: owned.identity.telegramUserId,
      }))
    ) {
      return buildTelegramFundingUnavailableMessage({ reason: "unavailable" });
    }
    const consentCapability = owned.consent
      ? await resolveTelegramFundingConsentCapability(this.pool, {
          consent: owned.consent,
          userId: owned.link.userId,
          telegramAccountId: owned.link.linkId,
          telegramUserId: owned.identity.telegramUserId,
          destinationOptionId: owned.receive.session.destinationOptionId,
          venueBindingOptionId: owned.receive.session.venueBindingOptionId,
          now,
        })
      : null;
    const consentRoute = owned.consent
      ? resolveTelegramFundingConsentRoute(owned.consent)
      : null;
    const liveCapabilities = await this.resolveTargetCapabilities({
      link: owned.link,
      session: owned.receive.session,
      telegramUserId: owned.identity.telegramUserId,
    });
    const liveCapability =
      owned.consent && consentRoute
        ? await this.resolveTargetCapability({
            link: owned.link,
            session: owned.receive.session,
            telegramUserId: owned.identity.telegramUserId,
            routeKey: consentRoute.presentation.routeKey,
          })
        : liveCapabilities[0];
    if (!liveCapability) {
      return buildTelegramFundingUnavailableMessage({ reason: "unavailable" });
    }
    const frozenTarget = owned.consent
      ? (resolveTelegramFundingTargets({
          automaticConversionEnabled: owned.consent.automationEnabled,
          session: owned.receive.session,
        }).find(
          (target) =>
            target.presentation.routeKey ===
            consentRoute?.presentation.routeKey,
        ) ?? null)
      : liveCapability.target;
    const capability = owned.consent?.automationEnabled
      ? {
          authorization: consentCapability?.authorization ?? null,
          decision: consentCapability?.decision ?? {
            kind: "hard_invalid" as const,
            reasonCode: "delegated_route_changed" as const,
          },
          fundingPolicyRevision:
            consentCapability?.fundingPolicyRevision ??
            liveCapability.fundingPolicyRevision,
          target: frozenTarget,
        }
      : { ...liveCapability, target: frozenTarget };
    const progress = projectTelegramFundingProgress({
      afterBroadcastBoundaryReceiptIds: owned.afterBroadcastBoundaryReceiptIds,
      automaticConversionAvailable:
        owned.consent?.automationEnabled === true &&
        capability.decision.kind === "allowed",
      automaticConversionMode:
        capability.decision.kind === "allowed"
          ? "available"
          : capability.decision.kind === "soft_paused"
            ? "soft_paused"
            : "hard_invalid",
      consent: owned.consent,
      context: owned.context,
      receipts: owned.receive.receipts,
      session: owned.receive.session,
      now,
    });
    const addressDisclosureOpen = canDiscloseTelegramFundingAddress({
      context: owned.context,
      now,
      projection: progress,
      session: owned.receive.session,
    });
    const presentationMode = owned.consent
      ? telegramFundingConsentPresentationMode(
          owned.consent,
          capability.target?.mode ?? null,
        )
      : null;
    if (input.view === "address" && owned.consent && addressDisclosureOpen) {
      if (!(await this.enqueueQrPhoto(owned))) {
        return buildTelegramFundingUnavailableMessage({
          reason: "unavailable",
        });
      }
      return buildTelegramFundingDeliveryQueuedMessage({
        contextId: owned.context.id,
      });
    }
    if (progress) {
      const decorated = await presentFrozenProgress(progress, presentationMode);
      return progress.receiveAddress !== null
        ? buildTelegramFundingDeliveryQueuedMessage({
            contextId: owned.context.id,
          })
        : decorated;
    }
    if (owned.consent) {
      return buildTelegramFundingUnavailableMessage({
        reason: "unavailable",
      });
    }
    if (!addressDisclosureOpen) {
      return buildTelegramFundingUnavailableMessage({ reason: "expired" });
    }
    const message = buildTelegramFundingTargetMessageForSession({
      contextId: owned.context.id,
      expiresAt: owned.context.expiresAt,
      session: owned.receive.session,
      automaticConversionEnabled: liveCapabilities.some(
        (candidate) => candidate.authorization != null,
      ),
      targets: liveCapabilities.flatMap((candidate) =>
        candidate.authorization ||
        candidate.target.automaticSourceAsset === null
          ? [candidate.target]
          : [],
      ),
    });
    return decorateProgress
      ? decorateProgress({
          consent: owned.consent,
          context: owned.context,
          message,
          now,
          presentationMode,
          progress: null,
          session: owned.receive.session,
        })
      : message;
  }

  async selectTarget(
    input: TelegramFundingMutationInput & {
      choiceToken: string;
      contextId: string;
    },
    now = new Date(),
    decorateProgress?: TelegramFundingProgressDecorator,
  ): Promise<TelegramFundingMessage> {
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    const { identity, link } = await this.currentLink(input);
    const requestFingerprint = canonicalJsonHash({
      action: "select_target",
      chatId: identity.chatId,
      choiceToken: input.choiceToken,
      contextId: input.contextId,
      telegramMessageId: input.telegramMessageId,
      telegramUserId: identity.telegramUserId,
      userId: link.userId,
    });
    try {
      const replay = await fetchTelegramFundingMutationReplay(this.pool, {
        action: "select_target",
        contextId: input.contextId,
        idempotencyKey,
        requestFingerprint,
      });
      if (replay) {
        const replayOwned = await this.loadOwned(input);
        await requestFundingReceiveSessionObservation(this.pool, {
          now,
          receiveSessionId: replayOwned.context.receiveSessionId,
          userId: replayOwned.link.userId,
        });
        await this.projectMutationContext(input.contextId, now);
        return this.session(
          {
            contextId: input.contextId,
            telegramUserId: identity.telegramUserId,
            telegramMessageId: input.telegramMessageId,
            chatId: identity.chatId,
            view: "progress",
          },
          now,
          decorateProgress,
        );
      }
    } catch (error) {
      rethrowTelegramFundingPersistenceError(error);
    }
    const routeKeyByChoiceToken: Readonly<Record<string, string>> = {
      a: "polymarket_polygon_pusd_usdce_v1",
      b: "polymarket_base_usdc_relay_v1",
      d: "polymarket_polygon_pusd_direct_v1",
      l: "limitless_base_usdc_direct_v1",
      p: "polymarket_polygon_pusd_direct_v1",
      ld: "limitless_base_usdc_direct_v1",
      le: "limitless_polygon_usdce_relay_v1",
      ln: "limitless_polygon_usdc_relay_v1",
      lp: "limitless_polygon_pusd_relay_v1",
      pb: "polymarket_base_usdc_relay_v1",
      pd: "polymarket_polygon_pusd_direct_v1",
      pn: "polymarket_polygon_usdc_relay_v1",
      pw: "polymarket_polygon_usdce_wrap_v1",
    };
    const selectedRouteKey = routeKeyByChoiceToken[input.choiceToken] ?? null;
    const automaticConversionRequested =
      selectedRouteKey != null && !selectedRouteKey.endsWith("_direct_v1");
    if (!selectedRouteKey) {
      throw new TelegramFundingError("invalid_funding_choice");
    }
    const policy = await resolveSignalBotTradingPolicyStateFromDb(this.pool);
    if (!policy.policy.fundingReceiveEnabled) {
      throw new TelegramFundingError("funding_receive_disabled");
    }
    const snapshot = await fetchTelegramFundingSelectionSnapshot(this.pool, {
      contextId: input.contextId,
      userId: link.userId,
      telegramUserId: identity.telegramUserId,
      telegramMessageId: input.telegramMessageId,
      chatId: identity.chatId,
    });
    if (!snapshot) {
      throw new TelegramFundingError("funding_context_not_found");
    }
    if (
      snapshot.context.cancelledAt ||
      new Date(snapshot.context.expiresAt).getTime() <= now.getTime()
    ) {
      throw new TelegramFundingError("funding_session_expired");
    }
    const receive = await loadTelegramFundingReceiveSession(
      this.receive,
      link.userId,
      snapshot.context.receiveSessionId,
    );
    if (!receive) {
      throw new TelegramFundingError("funding_context_not_found");
    }
    const controllerWalletId = await this.currentReceiveControllerWalletId({
      link,
      receiveSessionId: snapshot.context.receiveSessionId,
      session: receive.session,
      telegramUserId: identity.telegramUserId,
    });
    if (!controllerWalletId) {
      throw new TelegramFundingError("destination_ambiguous");
    }
    const capability = await this.resolveTargetCapability({
      link,
      session: receive.session,
      telegramUserId: identity.telegramUserId,
      routeKey: selectedRouteKey,
    });
    if (
      automaticConversionRequested &&
      (capability.decision.kind !== "allowed" || !capability.authorization)
    ) {
      throw new TelegramFundingError("invalid_funding_choice");
    }
    const choice = resolveTelegramFundingTargetChoice({
      automaticConversionEnabled: automaticConversionRequested,
      session: receive.session,
      observationVariants: snapshot.observationVariants,
      routeKey: selectedRouteKey,
    });
    if (!choice) throw new TelegramFundingError("invalid_funding_choice");
    let consentVariants = snapshot.observationVariants.filter((variant) =>
      choice.variantIds.includes(variant.variantId),
    );
    let automationPolicy: JsonRecord;
    if (choice.automaticConversion) {
      const primaryAutomaticVariant = choice.automaticVariants[0];
      if (!capability.authorization || !primaryAutomaticVariant) {
        throw new TelegramFundingError("invalid_funding_choice");
      }
      const preparedAutomaticVariants =
        await prepareTelegramFundingAutomaticVariantsForRoute({
          presentation: choice.presentation,
          variants: choice.automaticVariants,
        });
      if (!preparedAutomaticVariants) {
        throw new TelegramFundingError("invalid_funding_choice");
      }
      const refreshedById = new Map(
        preparedAutomaticVariants.map((variant) => [
          variant.variantId,
          variant,
        ]),
      );
      consentVariants = consentVariants.map(
        (variant) => refreshedById.get(variant.variantId) ?? variant,
      );
      const automaticPolicy = buildTelegramFundingAutomaticPolicyForRoute({
        authorization: capability.authorization,
        choice: {
          presentation: choice.presentation,
          automaticVariants: preparedAutomaticVariants,
        },
        destinationAsset: receive.session.destinationAsset,
        fundingPolicyRevision: capability.fundingPolicyRevision,
      });
      if (!automaticPolicy) {
        throw new TelegramFundingError("invalid_funding_choice");
      }
      automationPolicy = automaticPolicy;
    } else {
      automationPolicy = jsonRecord({
        version: 1,
        mode: "direct",
        automationEnabled: false,
        telegramPolicyRevision: policy.policyRevision,
        receiveAutomationPolicy: snapshot.automationPolicy,
      });
    }
    const policySnapshot = jsonRecord({
      ...automationPolicy,
      presentationMode: choice.mode,
      presentation: choice.presentation,
    });
    const fingerprint = canonicalJsonHash({
      fundingContextId: snapshot.context.id,
      receiveSessionId: snapshot.context.receiveSessionId,
      receiveTargetId: choice.receiveTargetId,
      asset: choice.asset,
      variantIds: consentVariants.map((variant) => variant.variantId).sort(),
      automationEnabled: choice.automaticConversion,
      policySnapshot,
    });
    const response = buildTelegramFundingDeliveryQueuedMessage({
      contextId: snapshot.context.id,
    });
    try {
      await appendTelegramFundingConsent(this.pool, {
        contextId: snapshot.context.id,
        userId: link.userId,
        telegramAccountId: link.linkId,
        telegramUserId: identity.telegramUserId,
        chatId: identity.chatId,
        telegramMessageId: input.telegramMessageId,
        controllerWalletId,
        receiveTargetId: choice.receiveTargetId,
        asset: choice.asset,
        variantIds: consentVariants.map((variant) => variant.variantId).sort(),
        automationEnabled: choice.automaticConversion,
        maximumAutomaticRaw:
          choice.automaticConversion && capability.authorization?.maxSourceRaw
            ? capability.authorization.maxSourceRaw
            : null,
        policySnapshot,
        fingerprint,
        mutation: {
          idempotencyKey,
          requestFingerprint,
          responsePayload: jsonRecord(response),
        },
        now,
      });
      await this.projectMutationContext(input.contextId, now);
      return this.session(
        {
          contextId: input.contextId,
          telegramUserId: identity.telegramUserId,
          telegramMessageId: input.telegramMessageId,
          chatId: identity.chatId,
          view: "progress",
        },
        now,
        decorateProgress,
      );
    } catch (error) {
      rethrowTelegramFundingPersistenceError(error);
    }
  }

  async cancel(
    input: TelegramFundingMutationInput & { contextId: string },
    now = new Date(),
  ): Promise<TelegramFundingMessage> {
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    const { identity, link } = await this.currentLink(input);
    const requestFingerprint = canonicalJsonHash({
      action: "cancel",
      chatId: identity.chatId,
      contextId: input.contextId,
      telegramMessageId: input.telegramMessageId,
      telegramUserId: identity.telegramUserId,
      userId: link.userId,
    });
    try {
      const replay = await fetchTelegramFundingMutationReplay(this.pool, {
        action: "cancel",
        contextId: input.contextId,
        idempotencyKey,
        requestFingerprint,
      });
      if (replay) {
        await this.projectMutationContext(input.contextId, now);
        return telegramFundingMessage(replay);
      }
      const response = buildTelegramFundingCancelledMessage();
      const cancelled = await cancelTelegramFundingSessionContext(this.pool, {
        contextId: input.contextId,
        userId: link.userId,
        telegramAccountId: link.linkId,
        telegramUserId: identity.telegramUserId,
        chatId: identity.chatId,
        telegramMessageId: input.telegramMessageId,
        idempotencyKey,
        requestFingerprint,
        responsePayload: jsonRecord(response),
        now,
      });
      if (!cancelled) {
        throw new TelegramFundingError("funding_context_not_found");
      }
      await this.projectMutationContext(cancelled.context.id, now);
      return cancelled.mutationResponse
        ? telegramFundingMessage(cancelled.mutationResponse)
        : response;
    } catch (error) {
      rethrowTelegramFundingPersistenceError(error);
    }
  }

  async loadMarketReturn(
    input: TelegramFundingIdentityInput & { contextId: string },
  ): Promise<TelegramFundingMarketReturn | null> {
    const { identity, link } = await this.currentLink(input);
    const { rows } = await this.pool.query<{
      market_id: string;
      side: "NO" | "YES";
    }>(
      `
        select buy_return.market_id, buy_return.side
        from telegram_funding_sessions context
        join telegram_funding_buy_return_revisions buy_return
          on buy_return.telegram_funding_session_id = context.id
         and buy_return.revision = context.active_buy_return_revision
        where context.id = $1
          and context.user_id = $2
          and context.telegram_account_id = $3::uuid
          and context.telegram_user_id = $4
          and context.chat_id = $5
          and context.origin = 'buy_return_context'
        limit 1
      `,
      [
        input.contextId,
        link.userId,
        link.linkId,
        identity.telegramUserId,
        identity.chatId,
      ],
    );
    const row = rows[0];
    return row ? { marketId: row.market_id, side: row.side } : null;
  }

  private async projectMutationContext(
    contextId: string,
    now: Date,
  ): Promise<void> {
    await runTelegramFundingProgressProjectionForContext(this.pool, {
      contextId,
      now,
    });
  }

  private async projectBuyReturnAttachmentBestEffort(
    contextId: string,
    now: Date,
  ): Promise<void> {
    try {
      await this.projectMutationContext(contextId, now);
    } catch (error) {
      console.warn("[telegram-funding] Buy return projection deferred", {
        contextId,
        errorName: error instanceof Error ? error.name : "unknown_error",
      });
    }
  }
}
