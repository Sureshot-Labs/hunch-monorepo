import type { Pool } from "@hunch/infra";

import { resolveKnownAccountAssetSymbol } from "../account-value/known-asset-catalog.js";
import {
  sameAccountAddress,
  sameAsset,
} from "../funding/domain/asset-identity.js";
import type {
  AssetRef,
  FundingReceiveSession,
  JsonValue,
} from "../funding/domain/types.js";
import { FundingPlanningRuntime } from "../funding/planner/runtime-service.js";
import { FundingPlannerError } from "../funding/planner/money.js";
import { canonicalJsonHash } from "../funding/persistence/canonical.js";
import type { DirectIngressObservationVariant } from "../funding/reconciliation/direct-ingress-observer.js";
import { FundingReceiveSessionService } from "../funding/receive/receive-session-service.js";
import {
  resolveActiveTelegramAccountLink,
  sameActiveTelegramAccountLink,
} from "./telegram-account-link.js";
import type { TelegramFundingMessage } from "./telegram-funding-contracts.js";
import {
  buildTelegramFundingAddressMessage,
  buildTelegramFundingCancelledMessage,
  buildTelegramFundingProgressMessage,
  buildTelegramFundingTargetMessage,
  buildTelegramFundingUnavailableMessage,
} from "./telegram-funding-presentation.js";
import { projectTelegramFundingProgress } from "./telegram-funding-progress.js";
import {
  appendTelegramFundingConsent,
  cancelTelegramFundingSessionContext,
  createOrReuseTelegramFundingSessionInTransaction,
  fetchActiveTelegramFundingConsent,
  fetchTelegramFundingMutationReplay,
  fetchTelegramFundingSelectionSnapshot,
  fetchTelegramFundingSessionByIdempotency,
  fetchTelegramFundingSessionContext,
  TelegramFundingPersistenceError,
  type TelegramFundingConsent,
  type TelegramFundingSessionContext,
} from "./telegram-funding-sessions.js";
import { resolveSignalBotTradingPolicyStateFromDb } from "./signal-bot-trading-policy.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

export type TelegramFundingErrorCode =
  | "destination_ambiguous"
  | "funding_context_not_found"
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
  throw error;
}

export function resolveTelegramDirectPusdChoice(input: {
  session: FundingReceiveSession;
  observationVariants: readonly DirectIngressObservationVariant[];
}): Readonly<{
  address: string;
  asset: AssetRef;
  receiveTargetId: string;
  variantIds: readonly string[];
}> | null {
  const matches = input.session.receiveTargets.flatMap((target) =>
    target.acceptedAssets.flatMap((accepted) =>
      accepted.handling === "direct" &&
      resolveKnownAccountAssetSymbol(accepted.asset) === "pUSD"
        ? [{ target, accepted }]
        : [],
    ),
  );
  if (matches.length !== 1) return null;
  const match = matches[0];
  if (!match) return null;
  const variantIds = input.observationVariants
    .filter(
      (variant) =>
        variant.completion.kind === "direct_destination_credit" &&
        sameAsset(variant.asset, match.accepted.asset) &&
        sameAccountAddress(
          variant.networkId,
          variant.destinationAddress,
          match.target.destinationAddress,
        ),
    )
    .map((variant) => variant.variantId)
    .sort();
  if (variantIds.length === 0) return null;
  return {
    address: match.target.destinationAddress,
    asset: match.accepted.asset,
    receiveTargetId: match.target.receiveTargetId,
    variantIds,
  };
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

  async open(
    input: TelegramFundingMutationInput,
    now = new Date(),
  ): Promise<TelegramFundingMessage> {
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    const { identity, link: initialLink } = await this.currentLink(input);
    const replay = await fetchTelegramFundingSessionByIdempotency(this.pool, {
      idempotencyKey,
      userId: initialLink.userId,
      telegramUserId: identity.telegramUserId,
      chatId: identity.chatId,
    });
    if (replay) {
      return this.session({
        contextId: replay.id,
        telegramUserId: identity.telegramUserId,
        chatId: identity.chatId,
        view: "progress",
      });
    }
    const policy = await resolveSignalBotTradingPolicyStateFromDb(this.pool);
    if (!policy.policy.fundingReceiveEnabled) {
      throw new TelegramFundingError("funding_receive_disabled");
    }
    const destinations = (
      await this.runtime.destinations(initialLink.userId, { purpose: "fund" })
    ).filter(
      (destination) =>
        destination.venueId === "polymarket" && destination.selectable,
    );
    if (destinations.length !== 1) {
      throw new TelegramFundingError("destination_ambiguous");
    }
    const destination = destinations[0];
    if (!destination) throw new TelegramFundingError("destination_ambiguous");
    let context:
      | Awaited<
          ReturnType<typeof createOrReuseTelegramFundingSessionInTransaction>
        >
      | undefined;
    try {
      await this.receive.open(
        initialLink.userId,
        {
          destinationOptionId: destination.destinationOptionId,
          venueBindingOptionId: destination.venueBindingOptionId,
          selectedReceiveTargetId: null,
        },
        now,
        "telegram",
        async (client, persisted) => {
          const currentLink = await resolveActiveTelegramAccountLink({
            db: client,
            telegramUserId: identity.telegramUserId,
          });
          if (!sameActiveTelegramAccountLink(initialLink, currentLink)) {
            throw new TelegramFundingError("telegram_account_required");
          }
          context = await createOrReuseTelegramFundingSessionInTransaction(
            client,
            {
              userId: initialLink.userId,
              telegramAccountId: initialLink.linkId,
              telegramUserId: identity.telegramUserId,
              chatId: identity.chatId,
              telegramMessageId: input.telegramMessageId,
              receiveSessionId: persisted.snapshot.session.receiveSessionId,
              idempotencyKey,
              expiresAt: new Date(persisted.snapshot.session.expiresAt),
              now,
            },
          );
        },
      );
    } catch (error) {
      if (
        error instanceof FundingPlannerError &&
        error.code === "receive_channel_conflict"
      ) {
        throw new TelegramFundingError("receive_channel_conflict");
      }
      throw error;
    }
    if (!context) {
      throw new TelegramFundingError("funding_context_not_found");
    }
    if (context.replayed) {
      return this.session(
        {
          contextId: context.context.id,
          telegramUserId: identity.telegramUserId,
          chatId: identity.chatId,
          view: "progress",
        },
        now,
      );
    }
    return buildTelegramFundingTargetMessage({
      contextId: context.context.id,
      expiresAt: context.context.expiresAt,
    });
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
    const consent = await fetchActiveTelegramFundingConsent(
      this.pool,
      context.id,
    );
    return { consent, context, identity, link, receive };
  }

  private addressMessage(input: {
    consent: TelegramFundingConsent;
    context: TelegramFundingSessionContext;
    session: FundingReceiveSession;
  }): TelegramFundingMessage {
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
    });
  }

  async session(
    input: TelegramFundingIdentityInput & {
      contextId: string;
      view?: "address" | "progress";
    },
    now = new Date(),
  ): Promise<TelegramFundingMessage> {
    const owned = await this.loadOwned(input);
    const progress = projectTelegramFundingProgress({
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
      return this.addressMessage({
        consent: owned.consent,
        context: owned.context,
        session: owned.receive.session,
      });
    }
    if (progress) return buildTelegramFundingProgressMessage(progress);
    if (!addressDisclosureOpen) {
      return buildTelegramFundingUnavailableMessage({ reason: "expired" });
    }
    return buildTelegramFundingTargetMessage({
      contextId: owned.context.id,
      expiresAt: owned.context.expiresAt,
    });
  }

  async selectTarget(
    input: TelegramFundingMutationInput & {
      choiceToken: string;
      contextId: string;
    },
    now = new Date(),
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
    const choice = resolveTelegramDirectPusdChoice({
      session: receive.session,
      observationVariants: snapshot.observationVariants,
    });
    if (!choice) throw new TelegramFundingError("invalid_funding_choice");
    const policySnapshot = jsonRecord({
      mode: "direct",
      automationEnabled: false,
      telegramPolicyRevision: policy.policyRevision,
      receiveAutomationPolicy: snapshot.automationPolicy,
    });
    const fingerprint = canonicalJsonHash({
      fundingContextId: snapshot.context.id,
      receiveSessionId: snapshot.context.receiveSessionId,
      receiveTargetId: choice.receiveTargetId,
      asset: choice.asset,
      variantIds: choice.variantIds,
      automationEnabled: false,
      policySnapshot,
    });
    const response = buildTelegramFundingAddressMessage({
      address: choice.address,
      contextId: snapshot.context.id,
      expiresAt: snapshot.context.expiresAt,
    });
    try {
      const selected = await appendTelegramFundingConsent(this.pool, {
        contextId: snapshot.context.id,
        userId: link.userId,
        telegramAccountId: link.linkId,
        telegramUserId: identity.telegramUserId,
        chatId: identity.chatId,
        telegramMessageId: input.telegramMessageId,
        receiveTargetId: choice.receiveTargetId,
        asset: choice.asset,
        variantIds: choice.variantIds,
        policySnapshot,
        fingerprint,
        mutation: {
          idempotencyKey,
          requestFingerprint,
          responsePayload: jsonRecord(response),
        },
        now,
      });
      if (selected.mutationResponse) {
        return this.session(
          {
            contextId: input.contextId,
            telegramUserId: identity.telegramUserId,
            chatId: identity.chatId,
            view: "address",
          },
          now,
        );
      }
      return response;
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
