import type { Pool, PoolClient } from "@hunch/infra";

import {
  normalizeUnsignedDecimal,
  parseUnsignedDecimal,
} from "../account-value/decimal.js";
import {
  sameAccountAddress,
  sameAsset,
} from "../funding/domain/asset-identity.js";
import type {
  AssetRef,
  FundingDestinationOption,
  FundingReceiveSession,
  JsonValue,
} from "../funding/domain/types.js";
import { FundingPlanningRuntime } from "../funding/planner/runtime-service.js";
import { FundingPlannerError } from "../funding/planner/money.js";
import { canonicalJsonHash } from "../funding/persistence/canonical.js";
import { listFundingReceiveRoutingReceiptIdsAfterBroadcastBoundary } from "../funding/persistence/funding-receive-session-repository.js";
import type { DirectIngressObservationVariant } from "../funding/reconciliation/direct-ingress-observer.js";
import { initializeCanonicalFundingReceiveEventCursors } from "../funding/receive/canonical-receive-event-scanner.js";
import { FundingReceiveSessionService } from "../funding/receive/receive-session-service.js";
import type { DelegatedFundingPreBroadcastDecision } from "../funding/execution/delegated-funding-capability.js";
import { resolveTelegramPolymarketWrapCapability } from "../funding/execution/delegated-funding-capability-resolver.js";
import type { TelegramFundingAuthorization } from "../funding/execution/telegram-funding-authorization.js";
import {
  buildTelegramFundingAutomationPolicyV2,
  parseTelegramFundingAutomationPolicyV2,
  telegramFundingAutomationPolicyJson,
} from "../funding/execution/telegram-funding-automation-policy.js";
import { fundingSidecarRuntimeConfig } from "../funding/runtime/sidecar-runtime-config.js";
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
import { appendTelegramFundingBuyReturnInTransaction } from "./telegram-funding-buy-continuation.js";
import {
  parseTelegramBotTradeAuthorityBinding,
  telegramBotTradeAuthorityFingerprint,
} from "./telegram-bot-trade-input-context.js";
import {
  buildTelegramFundingAddressMessage,
  buildTelegramFundingCancelledMessage,
  buildTelegramFundingProgressMessage,
  buildTelegramFundingTargetMessage,
  buildTelegramFundingUnavailableMessage,
  type TelegramFundingReceivePresentationMode,
} from "./telegram-funding-presentation.js";
import { projectTelegramFundingProgress } from "./telegram-funding-progress.js";
import {
  appendTelegramFundingConsent,
  cancelTelegramFundingSessionContext,
  createOrReuseTelegramFundingSessionInTransaction,
  fetchActiveTelegramFundingConsent,
  fetchTelegramFundingOpenMutationReplay,
  fetchTelegramFundingMutationReplay,
  fetchTelegramFundingSelectionSnapshot,
  fetchTelegramFundingSessionByIdempotency,
  fetchTelegramFundingSessionContext,
  recordTelegramFundingOpenMutation,
  reuseActiveTelegramFundingSession,
  TelegramFundingPersistenceError,
  type TelegramFundingConsent,
  type TelegramFundingSessionContext,
} from "./telegram-funding-sessions.js";
import {
  resolveSignalBotTradingPolicyStateFromDb,
  type SignalBotPolicy,
} from "./signal-bot-trading-policy.js";
import { venueLifecycleAllowsTradingAction } from "./venue-lifecycle.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;
type TelegramFundingOpenContext = Awaited<
  ReturnType<typeof createOrReuseTelegramFundingSessionInTransaction>
>;
type TelegramFundingInitialBuyReturn = Readonly<{
  eventId: string | null;
  marketId: string;
  requestedSpendUsd: string;
  side: "NO" | "YES";
}>;

export type TelegramFundingBuyReturnSourceIntent = Readonly<{
  action: string;
  amount_usd: string | number | null;
  authorization_id: string | null;
  authorization_max_amount_usd: string | number | null;
  authorization_privy_wallet_id: string | null;
  authorization_wallet_address: string;
  authorization_wallet_chain: "ethereum" | "solana";
  chat_id: string | null;
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
        intent.event_id,
        intent.funding_operation_id,
        intent.funding_reservation_id,
        intent.market_id,
        intent.side,
        intent.status,
        intent.submit_started_at,
        intent.result -> 'telegramAuthority' as telegram_authority,
        intent.telegram_user_id,
        intent.user_id
      from telegram_trade_intents intent
      join telegram_bot_trading_authorizations auth
        on auth.id = intent.authorization_id
       and auth.user_id = intent.user_id
       and auth.telegram_user_id = intent.telegram_user_id
       and auth.enabled = true
       and 'polymarket' = any(auth.enabled_venues)
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
           and lower(wallet.wallet_address) = lower(auth.wallet_address))
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
  | "funding_session_expired"
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
    eventId: string | null;
    marketId: string;
    requestedSpendUsd: string;
    side: "NO" | "YES";
    sourceIntentId: string;
    venue: "polymarket";
  }>;

export type TelegramFundingProgressDecorator = (
  input: Readonly<{
    consent: TelegramFundingConsent | null;
    context: TelegramFundingSessionContext;
    message: TelegramFundingMessage;
    now: Date;
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
  venue: "polymarket";
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
    throw new TelegramFundingError("funding_session_expired");
  }
  if (
    error instanceof TelegramFundingPersistenceError &&
    error.code === "telegram_funding_active_context_ambiguous"
  ) {
    throw new TelegramFundingError("destination_ambiguous");
  }
  throw error;
}

type TelegramFundingTargetCapability = Readonly<{
  address: string;
  automaticUsdce: boolean;
  primaryAsset: AssetRef;
  mode: TelegramFundingReceivePresentationMode;
  pusd: AssetRef | null;
  receiveTargetId: string;
  usdce: AssetRef | null;
}>;

function exactPolygonPusd(asset: AssetRef): boolean {
  return (
    asset.networkId === "evm:137" &&
    asset.assetId.toLowerCase() ===
      fundingSidecarRuntimeConfig.polymarketPusdAddress.toLowerCase() &&
    asset.decimals === 6
  );
}

function exactPolygonUsdce(asset: AssetRef): boolean {
  return (
    asset.networkId === "evm:137" &&
    asset.assetId.toLowerCase() ===
      fundingSidecarRuntimeConfig.polymarketUsdceAddress.toLowerCase() &&
    asset.decimals === 6
  );
}

function isTelegramFundingReceivePresentationMode(
  value: unknown,
): value is TelegramFundingReceivePresentationMode {
  return (
    value === "pusd_direct" ||
    value === "pusd_or_usdce_automatic" ||
    value === "usdce_automatic"
  );
}

export function telegramFundingConsentPresentationMode(
  consent: TelegramFundingConsent,
  liveMode: TelegramFundingReceivePresentationMode | null,
): TelegramFundingReceivePresentationMode | null {
  const storedMode = consent.policySnapshot.presentationMode;
  const frozenMode = isTelegramFundingReceivePresentationMode(storedMode)
    ? storedMode
    : null;
  if (!liveMode || !frozenMode) return null;
  if (liveMode === frozenMode) return frozenMode;
  if (liveMode === "pusd_or_usdce_automatic") return frozenMode;
  if (frozenMode === "pusd_or_usdce_automatic") return liveMode;
  return null;
}

export function resolveTelegramPolygonFundingTarget(input: {
  automaticUsdceEnabled: boolean;
  session: FundingReceiveSession;
}): TelegramFundingTargetCapability | null {
  const matches = input.session.receiveTargets.flatMap((target) => {
    if (target.networkId !== "evm:137") return [];
    const pusd = target.acceptedAssets.filter(
      (accepted) =>
        accepted.handling === "direct" && exactPolygonPusd(accepted.asset),
    );
    const usdce = target.acceptedAssets.filter(
      (accepted) =>
        accepted.handling === "automatic_conversion" &&
        exactPolygonUsdce(accepted.asset),
    );
    if (pusd.length > 1 || usdce.length > 1) return [];
    const recognized = pusd.length + usdce.length;
    if (recognized !== target.acceptedAssets.length) return [];
    const direct = pusd[0]?.asset ?? null;
    const automatic = input.automaticUsdceEnabled
      ? (usdce[0]?.asset ?? null)
      : null;
    if (!direct && !automatic) return [];
    return [{ target, pusd: direct, usdce: automatic }];
  });
  if (matches.length !== 1) return null;
  const match = matches[0];
  if (!match) return null;
  const mode: TelegramFundingReceivePresentationMode =
    match.pusd && match.usdce
      ? "pusd_or_usdce_automatic"
      : match.usdce
        ? "usdce_automatic"
        : "pusd_direct";
  const primaryAsset = match.pusd ?? match.usdce;
  if (!primaryAsset) return null;
  return {
    address: match.target.destinationAddress,
    automaticUsdce: match.usdce != null,
    primaryAsset,
    mode,
    pusd: match.pusd,
    receiveTargetId: match.target.receiveTargetId,
    usdce: match.usdce,
  };
}

export function resolveTelegramFundingTargetChoice(input: {
  automaticUsdceEnabled: boolean;
  session: FundingReceiveSession;
  observationVariants: readonly DirectIngressObservationVariant[];
}): Readonly<{
  address: string;
  asset: AssetRef;
  automaticUsdce: boolean;
  mode: TelegramFundingReceivePresentationMode;
  receiveTargetId: string;
  usdceVariants: readonly DirectIngressObservationVariant[];
  variantIds: readonly string[];
}> | null {
  const target = resolveTelegramPolygonFundingTarget(input);
  if (!target) return null;
  const acceptedAssets = [target.pusd, target.usdce].filter(
    (asset): asset is AssetRef => asset != null,
  );
  const variants = input.observationVariants
    .filter(
      (variant) =>
        acceptedAssets.some((asset) => sameAsset(variant.asset, asset)) &&
        sameAccountAddress(
          variant.networkId,
          variant.destinationAddress,
          target.address,
        ) &&
        ((target.pusd != null &&
          sameAsset(variant.asset, target.pusd) &&
          variant.completion.kind === "direct_destination_credit") ||
          (target.usdce != null &&
            sameAsset(variant.asset, target.usdce) &&
            variant.completion.kind === "committed_venue_preparation")),
    )
    .sort((left, right) => left.variantId.localeCompare(right.variantId));
  const variantIds = variants.map((variant) => variant.variantId);
  const usdceVariants = variants.filter(
    (variant) => target.usdce && sameAsset(variant.asset, target.usdce),
  );
  if (variantIds.length === 0) return null;
  const directPusd = target.pusd;
  if (
    directPusd &&
    !variants.some((variant) => sameAsset(variant.asset, directPusd))
  ) {
    return null;
  }
  if (target.usdce && usdceVariants.length === 0) return null;
  return {
    address: target.address,
    asset: target.primaryAsset,
    automaticUsdce: target.automaticUsdce,
    mode: target.mode,
    receiveTargetId: target.receiveTargetId,
    usdceVariants,
    variantIds,
  };
}

/** Compatibility name for pUSD-only callers and tests. */
export function resolveTelegramDirectPusdChoice(input: {
  session: FundingReceiveSession;
  observationVariants: readonly DirectIngressObservationVariant[];
}) {
  return resolveTelegramFundingTargetChoice({
    ...input,
    automaticUsdceEnabled: false,
  });
}

export function buildTelegramFundingTargetMessageForSession(input: {
  automaticUsdceEnabled?: boolean;
  contextId: string;
  expiresAt: string;
  session: FundingReceiveSession;
}): TelegramFundingMessage {
  const target = resolveTelegramPolygonFundingTarget({
    automaticUsdceEnabled: input.automaticUsdceEnabled === true,
    session: input.session,
  });
  return target
    ? buildTelegramFundingTargetMessage({ ...input, mode: target.mode })
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

export class TelegramFundingService {
  private readonly receive: FundingReceiveSessionService;
  private readonly runtime: FundingPlanningRuntime;

  constructor(private readonly pool: Pool) {
    this.receive = new FundingReceiveSessionService(pool);
    this.runtime = new FundingPlanningRuntime(pool);
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
    }>,
  ): Promise<
    Readonly<{
      authorization: TelegramFundingAuthorization | null;
      decision: DelegatedFundingPreBroadcastDecision;
      fundingPolicyRevision: string;
      target: TelegramFundingTargetCapability | null;
    }>
  > {
    const capability = await resolveTelegramPolymarketWrapCapability(
      this.pool,
      {
        userId: input.link.userId,
        telegramAccountId: input.link.linkId,
        telegramUserId: input.telegramUserId,
        destinationOptionId: input.session.destinationOptionId,
        venueBindingOptionId: input.session.venueBindingOptionId,
        expectedFundingPolicyRevision: input.expectedFundingPolicyRevision,
      },
    );
    return {
      authorization: capability.authorization,
      decision: capability.decision,
      fundingPolicyRevision: capability.fundingPolicyRevision,
      target: resolveTelegramPolygonFundingTarget({
        automaticUsdceEnabled: capability.authorization != null,
        session: input.session,
      }),
    };
  }

  private async resolveReceiveDestination(
    userId: string,
    venue: "polymarket",
  ): Promise<FundingDestinationOption> {
    const policy = await resolveSignalBotTradingPolicyStateFromDb(this.pool);
    if (!policy.policy.fundingReceiveEnabled) {
      throw new TelegramFundingError("funding_receive_disabled");
    }
    const destinations = (
      await this.runtime.destinations(userId, { purpose: "fund" })
    ).filter(
      (destination) => destination.venueId === venue && destination.selectable,
    );
    const destination = destinations[0];
    if (destinations.length !== 1 || !destination) {
      throw new TelegramFundingError("destination_ambiguous");
    }
    return destination;
  }

  private async openReceiveContext(
    input: Readonly<{
      afterContext?: (
        client: PoolClient,
        context: TelegramFundingOpenContext,
      ) => Promise<void>;
      contextIdempotencyKey: string;
      destination: Pick<
        FundingDestinationOption,
        "destinationOptionId" | "venueBindingOptionId"
      >;
      identity: Readonly<{ chatId: string; telegramUserId: string }>;
      initialBuyReturn?: TelegramFundingInitialBuyReturn;
      initialLink: ActiveTelegramAccountLink;
      now: Date;
      telegramMessageId: number | null;
    }>,
  ): Promise<TelegramFundingOpenContext> {
    let result: TelegramFundingOpenContext | undefined;
    try {
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
      );
    } catch (error) {
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
    input: TelegramFundingMutationInput & { venue: "polymarket" },
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
        return this.session(
          {
            contextId: mutationReplay.id,
            telegramUserId: identity.telegramUserId,
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
    const replay = await fetchTelegramFundingSessionByIdempotency(this.pool, {
      idempotencyKey,
      userId: initialLink.userId,
      telegramUserId: identity.telegramUserId,
      chatId: identity.chatId,
    });
    if (replay) {
      return this.session(
        {
          contextId: replay.id,
          telegramUserId: identity.telegramUserId,
          chatId: identity.chatId,
          view: "progress",
        },
        now,
        decorateProgress,
      );
    }
    let active: TelegramFundingSessionContext | null;
    try {
      active = await reuseActiveTelegramFundingSession(this.pool, {
        userId: initialLink.userId,
        telegramAccountId: initialLink.linkId,
        telegramUserId: identity.telegramUserId,
        chatId: identity.chatId,
        telegramMessageId: input.telegramMessageId,
        venueId: input.venue,
        idempotencyKey,
        requestFingerprint,
        now,
      });
    } catch (error) {
      rethrowTelegramFundingPersistenceError(error);
    }
    if (active) {
      return this.session(
        {
          contextId: active.id,
          telegramUserId: identity.telegramUserId,
          chatId: identity.chatId,
          view: "progress",
        },
        now,
        decorateProgress,
      );
    }
    const destination = await this.resolveReceiveDestination(
      initialLink.userId,
      input.venue,
    );
    const context = await this.openReceiveContext({
      initialLink,
      identity,
      destination,
      telegramMessageId: input.telegramMessageId,
      contextIdempotencyKey: idempotencyKey,
      now,
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
    const replay = await this.pool.query<{
      action: string;
      buy_return_revision: number | null;
      chat_id: string;
      destination_option_id: string;
      funding_context_id: string;
      request_fingerprint: string;
      telegram_account_id: string | null;
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
        replayed.venue_id === "polymarket"
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
      return this.session(
        {
          contextId: replayed.funding_context_id,
          telegramUserId: identity.telegramUserId,
          chatId: identity.chatId,
          view: "progress",
        },
        now,
        decorateProgress,
      );
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
    const destination = await this.resolveReceiveDestination(
      initialLink.userId,
      input.venue,
    );
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
    const requestFingerprint = buildTelegramFundingBuyReturnRequestFingerprint({
      destinationOptionId: destination.destinationOptionId,
      identity,
      link: initialLink,
      request: input,
      venueBindingOptionId: destination.venueBindingOptionId,
    });
    const context = await this.openReceiveContext({
      initialLink,
      identity,
      destination,
      telegramMessageId: input.telegramMessageId,
      contextIdempotencyKey: `buy-return:${input.sourceIntentId}`,
      initialBuyReturn: {
        eventId: input.eventId,
        marketId: input.marketId,
        requestedSpendUsd,
        side: input.side,
      },
      now,
      afterContext: async (client, context) => {
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
            ...receiveBinding,
            ...returnRequest,
            sourceAuthorityFingerprint:
              telegramBotTradeAuthorityFingerprint(sourceAuthority),
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
    return this.session(
      {
        contextId: context.context.id,
        telegramUserId: identity.telegramUserId,
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

  private addressMessage(input: {
    consent: TelegramFundingConsent;
    context: TelegramFundingSessionContext;
    mode: TelegramFundingReceivePresentationMode | null;
    session: FundingReceiveSession;
  }): TelegramFundingMessage {
    if (!input.mode) {
      return buildTelegramFundingUnavailableMessage({ reason: "unavailable" });
    }
    const target = input.session.receiveTargets.find(
      (candidate) =>
        candidate.receiveTargetId === input.consent.receiveTargetId &&
        candidate.acceptedAssets.some((accepted) =>
          sameAsset(accepted.asset, input.consent.asset),
        ),
    );
    if (!target) {
      return buildTelegramFundingUnavailableMessage({ reason: "unavailable" });
    }
    return buildTelegramFundingAddressMessage({
      address: target.destinationAddress,
      contextId: input.context.id,
      expiresAt: input.context.expiresAt,
      mode: input.mode,
    });
  }

  async session(
    input: TelegramFundingIdentityInput & {
      contextId: string;
      view?: "address" | "progress";
    },
    now = new Date(),
    decorateProgress?: TelegramFundingProgressDecorator,
  ): Promise<TelegramFundingMessage> {
    const owned = await this.loadOwned(input);
    const automation = parseTelegramFundingAutomationPolicyV2(
      owned.consent?.policySnapshot,
    );
    const capability = await this.resolveTargetCapability({
      link: owned.link,
      session: owned.receive.session,
      telegramUserId: owned.identity.telegramUserId,
      expectedFundingPolicyRevision: automation?.fundingPolicyRevision,
    });
    const progress = projectTelegramFundingProgress({
      afterBroadcastBoundaryReceiptIds: owned.afterBroadcastBoundaryReceiptIds,
      automaticConversionAvailable:
        capability.target?.mode === "pusd_or_usdce_automatic" ||
        capability.target?.mode === "usdce_automatic",
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
    if (input.view === "address" && owned.consent && addressDisclosureOpen) {
      const message = this.addressMessage({
        consent: owned.consent,
        context: owned.context,
        mode: telegramFundingConsentPresentationMode(
          owned.consent,
          capability.target?.mode ?? null,
        ),
        session: owned.receive.session,
      });
      return decorateProgress
        ? decorateProgress({
            consent: owned.consent,
            context: owned.context,
            message,
            now,
            progress,
            session: owned.receive.session,
          })
        : message;
    }
    if (progress) {
      const message = buildTelegramFundingProgressMessage(progress);
      return decorateProgress
        ? decorateProgress({
            consent: owned.consent,
            context: owned.context,
            message,
            now,
            progress,
            session: owned.receive.session,
          })
        : message;
    }
    if (!addressDisclosureOpen) {
      return buildTelegramFundingUnavailableMessage({ reason: "expired" });
    }
    const message = buildTelegramFundingTargetMessageForSession({
      contextId: owned.context.id,
      expiresAt: owned.context.expiresAt,
      session: owned.receive.session,
      automaticUsdceEnabled: capability.authorization != null,
    });
    return decorateProgress
      ? decorateProgress({
          consent: owned.consent,
          context: owned.context,
          message,
          now,
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
        return this.session(
          {
            contextId: input.contextId,
            telegramUserId: identity.telegramUserId,
            chatId: identity.chatId,
            view: "address",
          },
          now,
          decorateProgress,
        );
      }
    } catch (error) {
      rethrowTelegramFundingPersistenceError(error);
    }
    if (input.choiceToken !== "p") {
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
    const capability = await this.resolveTargetCapability({
      link,
      session: receive.session,
      telegramUserId: identity.telegramUserId,
    });
    const choice = resolveTelegramFundingTargetChoice({
      automaticUsdceEnabled: capability.authorization != null,
      session: receive.session,
      observationVariants: snapshot.observationVariants,
    });
    if (!choice) throw new TelegramFundingError("invalid_funding_choice");
    let consentVariants = snapshot.observationVariants.filter((variant) =>
      choice.variantIds.includes(variant.variantId),
    );
    let automationPolicy: JsonRecord;
    if (choice.automaticUsdce) {
      const primaryUsdceVariant = choice.usdceVariants[0];
      if (!capability.authorization || !primaryUsdceVariant) {
        throw new TelegramFundingError("invalid_funding_choice");
      }
      const refreshedUsdce =
        await initializeCanonicalFundingReceiveEventCursors(
          choice.usdceVariants,
        );
      const refreshedById = new Map(
        refreshedUsdce.map((variant) => [variant.variantId, variant]),
      );
      consentVariants = consentVariants.map(
        (variant) => refreshedById.get(variant.variantId) ?? variant,
      );
      automationPolicy = telegramFundingAutomationPolicyJson(
        buildTelegramFundingAutomationPolicyV2({
          authorization: capability.authorization,
          sourceAsset: primaryUsdceVariant.asset,
          destinationAsset: receive.session.destinationAsset,
          fundingPolicyRevision: capability.fundingPolicyRevision,
          variants: refreshedUsdce,
        }),
      );
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
    });
    const fingerprint = canonicalJsonHash({
      fundingContextId: snapshot.context.id,
      receiveSessionId: snapshot.context.receiveSessionId,
      receiveTargetId: choice.receiveTargetId,
      asset: choice.asset,
      variantIds: consentVariants.map((variant) => variant.variantId).sort(),
      automationEnabled: choice.automaticUsdce,
      policySnapshot,
    });
    const response = buildTelegramFundingAddressMessage({
      address: choice.address,
      contextId: snapshot.context.id,
      expiresAt: snapshot.context.expiresAt,
      mode: choice.mode,
    });
    try {
      await appendTelegramFundingConsent(this.pool, {
        contextId: snapshot.context.id,
        userId: link.userId,
        telegramAccountId: link.linkId,
        telegramUserId: identity.telegramUserId,
        chatId: identity.chatId,
        telegramMessageId: input.telegramMessageId,
        receiveTargetId: choice.receiveTargetId,
        asset: choice.asset,
        variantIds: consentVariants.map((variant) => variant.variantId).sort(),
        automationEnabled: choice.automaticUsdce,
        maximumAutomaticRaw: null,
        policySnapshot,
        fingerprint,
        mutation: {
          idempotencyKey,
          requestFingerprint,
          responsePayload: jsonRecord(response),
        },
        now,
      });
      return this.session(
        {
          contextId: input.contextId,
          telegramUserId: identity.telegramUserId,
          chatId: identity.chatId,
          view: "address",
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
      if (replay) return telegramFundingMessage(replay);
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
      return cancelled.mutationResponse
        ? telegramFundingMessage(cancelled.mutationResponse)
        : response;
    } catch (error) {
      rethrowTelegramFundingPersistenceError(error);
    }
  }
}
