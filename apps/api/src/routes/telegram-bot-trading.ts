import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { createAuthMiddleware } from "../auth.js";
import { pool, type DbQuery } from "../db.js";
import { cancelFundingOperationForUser } from "../funding/reconciliation/funding-operation-cancellation.js";
import { env } from "../env.js";
import { getRedis } from "../redis.js";
import { evaluateGeoFence, type GeoFenceConfig } from "../lib/geo-fence.js";
import { canonicalWalletIdentity } from "../lib/wallet-address.js";
import { PrivyService, type PrivyWalletProfile } from "../privy-service.js";
import {
  createApiTradingApplicationService,
  type ApiBotTradingExecutor,
} from "../services/api-trading-service.js";
import { createAggMarketClient } from "../services/agg-market-client.js";
import { getAggMarketAlternativesResponseCachedWithMetadata } from "../services/agg-market-clusters.js";
import {
  hasConfiguredPrivyBotPolicyForActions,
  inspectServerEvmWalletAuthorization,
} from "../services/api-trading-wallet-signing.js";
import { reconcileTelegramVenueIntents } from "../services/telegram-bot-trading-venue-reconcile.js";
import { verifyProofAddress } from "../services/proof-client.js";
import {
  buildUnlinkedTelegramBotTradingStatus,
  buildTelegramBotTradingActionStatuses,
  buildTelegramBotTradingMarketMessage,
  buildTelegramBotTradingStatusMessage,
  captureTelegramBotTradingCallback,
  changeTelegramFundingBuyContinuationAmount,
  completeTelegramBotTradeInput,
  createTelegramFundingBuyContinuationDecorator,
  cleanupTelegramBotTradingForUnlink,
  disableTelegramBotTradingForUser,
  disableTelegramBotTradingForTelegramUser,
  enableTelegramBotTrading,
  getTelegramBotTradingStatus,
  isTelegramBotTradeInputContextAuthorityCurrent,
  reconcileStaleTelegramTradeIntents,
  resolveTelegramBotTradingWalletSetupIssues,
  resumeTelegramFundingBuyContinuation,
  TelegramBotTradingEnableError,
  type TelegramBotTradingInternalWalletCandidate,
  type TelegramBotTradingWalletSetupIssue,
  type TelegramBotTradingVenue,
} from "../services/telegram-bot-trading.js";
import { isTelegramAppHandoffV2EnabledForVenue } from "../services/telegram-app-handoff-v2-contract.js";
import { resolveSignalBotTradingPolicyStateFromDb } from "../services/signal-bot-trading-policy.js";
import {
  claimTelegramBotTradingAutoSetup,
  failTelegramBotTradingSetupClaim,
  loadTelegramBotTradingPreference,
  resolveTelegramBotTradingManagedTarget,
} from "../services/telegram-bot-trading-preferences.js";
import type { KalshiTradeEligibility } from "../services/trading-types.js";
import {
  mapClusterMarketToTelegramSearchResult,
  searchTelegramMarkets,
} from "../services/telegram-market-search.js";
import { buildTelegramDepositMessage } from "../services/telegram-bot-deposit.js";
import { TelegramTradeShortfallFundingService } from "../services/telegram-trade-shortfall-funding.js";
import { buildHunchMiniAppWebButton } from "../services/telegram-mini-app-buttons.js";
import {
  buildTelegramPositionsMessage,
  loadTelegramPositions,
} from "../services/telegram-bot-positions.js";
import {
  escapeTelegramMarkdownV2,
  formatTelegramBoldMarkdownV2,
  formatTelegramCalloutMarkdownV2,
  joinTelegramMarkdownV2Lines,
} from "../services/telegram-bot-trading-presentation.js";
import { buildTelegramAccountValueMessage } from "../services/telegram-account-value.js";
import { buildTelegramAccountValueUnavailableMessage } from "../services/telegram-account-value-contract.js";
import type { AccountValueReadModel } from "../account-value/runtime-service.js";
import { accountValueReadService } from "../account-value/runtime-read-service.js";
import {
  resolveActiveTelegramAccountLink,
  sameActiveTelegramAccountLink,
} from "../services/telegram-account-link.js";
import {
  TelegramFundingError,
  TelegramFundingService,
} from "../services/telegram-funding.js";
import {
  ensureTelegramFundingAuthorization,
  ensureTelegramRelayEvmFundingAuthorization,
} from "../funding/execution/telegram-funding-authorization.js";
import { resolveTelegramFundingManagedWalletIdentity } from "../funding/execution/telegram-funding-managed-wallet.js";
import {
  buildTelegramFundingActiveElsewhereMessage,
  buildTelegramFundingUnavailableMessage,
} from "../services/telegram-funding-presentation.js";
import {
  readTelegramBotTradeInputContext,
  readTelegramBotTradeInputContextForNavigation,
  telegramBotTradeInputMessageScopeMatches,
  type TelegramBotTradeInputContext,
  writeTelegramBotTradeInputContext,
} from "../services/telegram-bot-trade-input-context.js";

const enableBodySchema = z
  .object({
    enabledVenues: z
      .array(z.enum(["polymarket", "limitless", "kalshi"]))
      .optional(),
    privyWalletId: z.string().trim().min(1).max(256).optional().nullable(),
    walletAddress: z.string().trim().min(1).optional().nullable(),
    maxAmountUsd: z.number().int().positive().optional().nullable(),
  })
  .strict();

const setupClaimBodySchema = z.object({ claimId: z.string().uuid() }).strict();

const setupFinalizeBodySchema = enableBodySchema.extend({
  claimId: z.string().uuid(),
});

const setupFailBodySchema = z
  .object({
    claimId: z.string().uuid(),
    errorCode: z.string().trim().min(1).max(128),
  })
  .strict();

function readPrivateTelegramIdentity(input: {
  chatId: number | string;
  telegramUserId: number | string;
}): { chatId: string; telegramUserId: string } | null {
  const identity = {
    chatId: String(input.chatId),
    telegramUserId: String(input.telegramUserId),
  };
  return identity.chatId === identity.telegramUserId ? identity : null;
}

const requirePrivateTelegramChat: preHandlerHookHandler = async (
  request,
  reply,
) => {
  const identity = readPrivateTelegramIdentity(
    request.body as {
      chatId: number | string;
      telegramUserId: number | string;
    },
  );
  if (!identity) {
    return reply.code(403).send({ error: "private_chat_required" });
  }
};

const internalMarketCardBodySchema = z
  .object({
    appBaseUrl: z.string().trim().min(1),
    chatId: z.union([z.string(), z.number()]),
    isAdminTest: z.boolean().optional(),
    marketRef: z.string().trim().min(1),
    publicBrowseOnly: z.boolean().optional(),
    telegramMessageId: z.number().int().optional().nullable(),
    telegramMiniAppEnabled: z.boolean().optional(),
    telegramUserId: z.union([z.string(), z.number()]),
    context: z
      .object({
        focusPositionId: z.string().uuid().optional(),
        focusPositionWalletAddress: z.string().optional().nullable(),
        focusSide: z.enum(["YES", "NO"]).optional(),
        observedNoAsk: z.number().min(0).max(1).optional().nullable(),
        observedYesAsk: z.number().min(0).max(1).optional().nullable(),
        origin: z.enum(["direct", "position", "search"]),
        positionLines: z.array(z.string().max(240)).max(8).optional(),
        positionRedemptionStatus: z.string().max(64).optional().nullable(),
        returnCallbackData: z.string().max(64).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const internalMarketSearchBodySchema = z
  .object({ query: z.string().trim().max(240).optional().nullable() })
  .strict();

const internalPositionCardBodySchema = z
  .object({
    appBaseUrl: z.string().trim().url(),
    positionId: z.string().uuid(),
    telegramMessageId: z.number().int().positive(),
    telegramMiniAppEnabled: z.boolean().optional(),
    telegramUserId: z.union([z.string(), z.number()]),
  })
  .strict();

const internalDepositBodySchema = z
  .object({
    appBaseUrl: z.string().trim().url(),
    telegramMiniAppEnabled: z.boolean().optional(),
    telegramUserId: z.union([z.string(), z.number()]),
    venue: z.string().trim().max(32).optional().nullable(),
  })
  .strict();

const internalFundingIdentitySchema = z
  .object({
    chatId: z.union([z.string(), z.number()]),
    telegramUserId: z.union([z.string(), z.number()]),
  })
  .strict();

const internalAccountBodySchema = internalFundingIdentitySchema;

const internalTradeInputMessageIdentitySchema = z
  .object({
    chatId: z.union([z.string(), z.number()]),
    telegramMessageId: z.number().int().positive(),
    telegramUserId: z.union([z.string(), z.number()]),
  })
  .strict();

const internalFundingMutationSchema = internalFundingIdentitySchema.extend({
  idempotencyKey: z.string().trim().min(8).max(192),
  telegramMessageId: z.number().int().positive().nullable(),
});

const internalFundingOpenBodySchema = internalFundingMutationSchema
  .extend({
    appBaseUrl: z.string().trim().url(),
    telegramMiniAppEnabled: z.boolean().optional(),
    venue: z.enum(["limitless", "polymarket"]),
  })
  .strict();

const internalFundingOpenRouteBodySchema = internalFundingOpenBodySchema
  .extend({
    fundingRoute: z.enum([
      "limitless_base_usdc_direct_v1",
      "polymarket_polygon_pusd_direct_v1",
      "polymarket_polygon_usdce_wrap_v1",
    ]),
  })
  .strict();

const internalFundingSessionBodySchema = internalFundingIdentitySchema
  .extend({
    contextId: z.string().uuid(),
    deliveryProjection: z.unknown().optional(),
    requestObservation: z.boolean().optional(),
    telegramMessageId: z.number().int().positive().nullable().optional(),
    view: z.enum(["address", "delivery", "progress"]).optional(),
  })
  .strict()
  .superRefine((body, context) => {
    if (body.view !== "delivery" && body.telegramMessageId == null) {
      context.addIssue({
        code: "custom",
        message: "interactive funding sessions require telegramMessageId",
        path: ["telegramMessageId"],
      });
    }
  });

const internalFundingSelectTargetBodySchema = internalFundingMutationSchema
  .extend({
    contextId: z.string().uuid(),
    choiceToken: z.string().regex(/^[a-z0-9]{1,8}$/i),
  })
  .strict();

const internalFundingCancelBodySchema = internalFundingMutationSchema
  .extend({
    appBaseUrl: z.string().trim().url(),
    contextId: z.string().uuid(),
    telegramMiniAppEnabled: z.boolean().optional(),
  })
  .strict();

const internalFundingCancelActiveBodySchema = internalFundingMutationSchema
  .extend({
    appBaseUrl: z.string().trim().url(),
    telegramMiniAppEnabled: z.boolean().optional(),
  })
  .strict();

const internalFundingBackToMarketBodySchema = internalFundingIdentitySchema
  .extend({
    appBaseUrl: z.string().trim().url(),
    contextId: z.string().uuid(),
    telegramMessageId: z.number().int().positive().nullable(),
    telegramMiniAppEnabled: z.boolean().optional(),
  })
  .strict();

const internalFundingReviewBodySchema = internalFundingMutationSchema
  .extend({ receiptId: z.string().uuid() })
  .strict();

const internalFundingConfirmBodySchema = internalFundingMutationSchema
  .extend({ consentToken: z.string().regex(/^consent_[A-Za-z0-9_-]{43}$/u) })
  .strict();

const internalFundingResumeBuyBodySchema = internalFundingIdentitySchema
  .extend({
    appBaseUrl: z.string().trim().url(),
    continuationToken: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
    idempotencyKey: z.string().trim().min(8).max(192),
    telegramMessageId: z.number().int().positive(),
    telegramMiniAppEnabled: z.boolean().optional(),
  })
  .strict();

const internalFundingChangeBuyAmountBodySchema = internalFundingIdentitySchema
  .extend({
    appBaseUrl: z.string().trim().url(),
    continuationToken: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
    telegramMessageId: z.number().int().positive(),
    telegramMiniAppEnabled: z.boolean().optional(),
  })
  .strict();

const internalStatusBodySchema = z
  .object({
    telegramUserId: z.union([z.string(), z.number()]),
  })
  .strict();

const internalPositionsBodySchema = internalStatusBodySchema.extend({
  appBaseUrl: z.string().trim().url(),
  telegramMiniAppEnabled: z.boolean().optional(),
});

const internalDisableBodySchema = z
  .object({
    telegramUserId: z.union([z.string(), z.number()]),
  })
  .strict();

const internalCallbackBodySchema = z
  .object({
    appBaseUrl: z.string().trim().min(1),
    telegramMiniAppEnabled: z.boolean().optional(),
    callbackQuery: z
      .object({
        data: z.string().optional(),
        from: z.object({ id: z.number().optional() }).optional(),
        id: z.string(),
        message: z
          .object({
            chat: z
              .object({
                id: z.union([z.string(), z.number()]),
                type: z.string().optional(),
              })
              .optional(),
            message_id: z.number().optional(),
          })
          .optional(),
      })
      .passthrough(),
  })
  .strict();

const internalTradeInputParamsSchema = z
  .object({ id: z.string().uuid() })
  .strict();

const internalTradeInputBeginBodySchema =
  internalTradeInputMessageIdentitySchema.extend({
    action: z.enum(["buy", "sell"]),
  });

const internalTradeInputCancelBodySchema =
  internalTradeInputMessageIdentitySchema.extend({
    appBaseUrl: z.string().trim().url(),
    telegramMiniAppEnabled: z.boolean().optional(),
  });

const internalTradeInputCompleteBodySchema =
  internalTradeInputMessageIdentitySchema.extend({
    appBaseUrl: z.string().trim().url(),
    telegramMiniAppEnabled: z.boolean().optional(),
    value: z.string().min(1).max(80),
  });

const internalIntentParamsSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

const internalIntentReceiptBodySchema = z
  .object({
    delivery: z.enum(["edit", "send"]),
    messageId: z.number().int().positive().optional().nullable(),
    telegramUserId: z.union([z.string(), z.number()]),
  })
  .strict();

function isInternalTradingAuthorized(request: {
  headers: Record<string, unknown>;
}): boolean {
  const configured = env.telegramBotInternalApiToken.trim();
  if (!configured) return false;
  const authorization = String(request.headers.authorization ?? "");
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return token === configured;
}

export function resolveInternalPrivyWalletCandidatesForProfile(
  walletProfiles: readonly PrivyWalletProfile[],
): TelegramBotTradingInternalWalletCandidate[] {
  return walletProfiles
    .filter((profile) => profile.isInternalWallet && profile.walletId?.trim())
    .map((profile) => ({
      privyWalletId: profile.walletId?.trim() ?? "",
      walletAddress: profile.address,
      walletChain: profile.walletType,
    }));
}

export async function resolveInternalPrivyWalletCandidates(input: {
  app: Parameters<FastifyPluginAsync>[0];
  privyUserId: string | null | undefined;
}): Promise<TelegramBotTradingInternalWalletCandidate[]> {
  if (!input.privyUserId) return [];
  try {
    const privyUser = await PrivyService.getUserById(input.privyUserId);
    return resolveInternalPrivyWalletCandidatesForProfile(
      PrivyService.classifyWallets(privyUser),
    );
  } catch (error) {
    input.app.log.warn(
      { err: error },
      "Failed to resolve internal Privy wallets for Telegram bot trading",
    );
    throw new Error("internal_privy_wallet_lookup_failed");
  }
}

export async function resolveTelegramBotTradingStatusWalletSetupIssues(input: {
  app: Parameters<FastifyPluginAsync>[0];
  db: DbQuery;
  privyUserId: string | null | undefined;
  requestedVenues: readonly TelegramBotTradingVenue[];
  userId: string;
}): Promise<TelegramBotTradingWalletSetupIssue[]> {
  let internalWallets: TelegramBotTradingInternalWalletCandidate[];
  try {
    internalWallets = await resolveInternalPrivyWalletCandidates({
      app: input.app,
      privyUserId: input.privyUserId,
    });
  } catch {
    return [];
  }
  return resolveTelegramBotTradingWalletSetupIssues(input.db, {
    internalWallets,
    requestedVenues: input.requestedVenues,
    userId: input.userId,
  });
}

export function isTelegramBotTradingReconciliationEnabled(input: {
  financeDbReconcileEnabled: boolean;
  venueReconcileEnabled: boolean;
}): boolean {
  return input.financeDbReconcileEnabled && input.venueReconcileEnabled;
}

export async function reconcileTelegramBotTradingStatus(input: {
  reconciliationEnabled: boolean;
  reconcileLocal: () => Promise<unknown>;
  reconcileVenue: () => Promise<unknown>;
}): Promise<void> {
  await input.reconcileLocal();
  if (input.reconciliationEnabled) await input.reconcileVenue();
}

async function buildKalshiEligibilityForRequest(input: {
  request: FastifyRequest;
  walletAddress: string;
  user: NonNullable<FastifyRequest["user"]>;
  geoFenceConfig: GeoFenceConfig;
}): Promise<KalshiTradeEligibility> {
  const checkedAt = new Date();
  const decision = evaluateGeoFence(input.request, input.geoFenceConfig);
  let proofVerified = true;
  if (env.kalshiProofEnabled && !input.user.kalshiProofBypass) {
    try {
      const proof = await verifyProofAddress({ address: input.walletAddress });
      proofVerified = proof.ok === true && proof.verified === true;
    } catch {
      proofVerified = false;
    }
  }
  return {
    checkedAt: checkedAt.toISOString(),
    expiresAt: new Date(checkedAt.getTime() + 60 * 60 * 1000).toISOString(),
    geoAllowed: decision.allowed,
    proofVerified,
  };
}

export type TelegramBotTradingRouteDependencies = {
  authPreHandler?: ReturnType<typeof createAuthMiddleware>;
  internalPreHandler?: preHandlerHookHandler;
  buildAccountValue?: (userId: string) => Promise<AccountValueReadModel>;
  buildAccountValueMessage?: typeof buildTelegramAccountValueMessage;
  createTrading?: (request: FastifyRequest) => ApiBotTradingExecutor;
  db?: DbQuery;
  reconciliationEnabled?: boolean;
  resolveInternalWallets?: (input: {
    app: Parameters<FastifyPluginAsync>[0];
    privyUserId: string | null | undefined;
  }) => Promise<TelegramBotTradingInternalWalletCandidate[]>;
  signerInspector?: typeof inspectServerEvmWalletAuthorization;
  buildDepositMessage?: typeof buildTelegramDepositMessage;
  buildPositionsMessage?: typeof buildTelegramPositionsMessage;
  loadPositions?: typeof loadTelegramPositions;
  fundingService?: Pick<
    TelegramFundingService,
    "cancel" | "open" | "selectTarget" | "session"
  > &
    Partial<
      Pick<
        TelegramFundingService,
        | "confirmConversion"
        | "loadMarketReturn"
        | "openBuyReturn"
        | "reviewConversion"
      >
    >;
  searchMarkets?: typeof searchTelegramMarkets;
  writeTradeInputContext?: (
    context: TelegramBotTradeInputContext,
  ) => Promise<boolean>;
};

async function registerTelegramBotTradingRoutes(
  app: Parameters<FastifyPluginAsync>[0],
  dependencies: TelegramBotTradingRouteDependencies,
): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = dependencies.db ?? pool;
  const routePool = db as typeof pool;
  const reconciliationEnabled =
    dependencies.reconciliationEnabled ??
    isTelegramBotTradingReconciliationEnabled({
      financeDbReconcileEnabled: env.financeTelegramTradeIntentsEnabled,
      venueReconcileEnabled: env.telegramVenueReconcileEnabled,
    });
  const authPreHandler = dependencies.authPreHandler ?? createAuthMiddleware();
  const signerInspector =
    dependencies.signerInspector ?? inspectServerEvmWalletAuthorization;
  const resolveInternalWallets =
    dependencies.resolveInternalWallets ?? resolveInternalPrivyWalletCandidates;
  const buildPositionsMessage =
    dependencies.buildPositionsMessage ?? buildTelegramPositionsMessage;
  const buildDepositMessage =
    dependencies.buildDepositMessage ?? buildTelegramDepositMessage;
  const buildAccountValue =
    dependencies.buildAccountValue ?? accountValueReadService.load;
  const buildAccountValueMessage =
    dependencies.buildAccountValueMessage ?? buildTelegramAccountValueMessage;
  const loadPositions = dependencies.loadPositions ?? loadTelegramPositions;
  const searchMarkets = dependencies.searchMarkets ?? searchTelegramMarkets;
  const fundingService =
    dependencies.fundingService ??
    new TelegramFundingService(routePool, {
      provisionAuthorization: async (input) => {
        const wrap =
          input.venueId === "polymarket"
            ? await ensureTelegramFundingAuthorization(routePool, input)
            : null;
        const relay = await ensureTelegramRelayEvmFundingAuthorization(
          routePool,
          input,
        );
        return wrap ?? relay;
      },
      resolveManagedWallet: (input) =>
        resolveTelegramFundingManagedWalletIdentity(routePool, input),
    });
  const tradeShortfallFundingService = new TelegramTradeShortfallFundingService(
    routePool,
  );
  const writeTradeInputContext =
    dependencies.writeTradeInputContext ??
    (async (context: TelegramBotTradeInputContext) => {
      const redis = await getRedis().catch(() => null);
      return redis
        ? writeTelegramBotTradeInputContext({ context, redis })
        : false;
    });
  const kalshiGeoFenceConfig: GeoFenceConfig = {
    enabled: env.dflowGeoBlockEnabled,
    blockedCountries: env.dflowGeoBlockCountries,
    defaultPolicy: env.dflowGeoBlockDefault,
    trustProxy: env.trustProxy,
    proxySecret: env.proxySecret,
  };
  const createTradingForRequest = (_request: FastifyRequest) => {
    if (dependencies.createTrading) {
      return dependencies.createTrading(_request);
    }
    return createApiTradingApplicationService({
      logger: app.log,
      pool,
    });
  };
  const createFundingDecoratorForRequest = (
    request: FastifyRequest,
    appBaseUrl?: string,
  ) =>
    createTelegramFundingBuyContinuationDecorator({
      appBaseUrl,
      pool: routePool,
      trading: createTradingForRequest(request),
    });
  const openFundingBuyReturn = async (
    input: Parameters<TelegramFundingService["openBuyReturn"]>[0],
    decorateProgress?: Parameters<TelegramFundingService["openBuyReturn"]>[2],
  ) => {
    if (!fundingService.openBuyReturn) return null;
    try {
      return await fundingService.openBuyReturn(
        input,
        new Date(),
        decorateProgress,
      );
    } catch (error) {
      if (
        error instanceof TelegramFundingError &&
        (error.code === "funding_receive_disabled" ||
          error.code === "funding_buy_continuation_disabled")
      )
        return null;
      throw error;
    }
  };

  const activateManagedTrading = async (input: {
    body: z.infer<typeof enableBodySchema>;
    request: FastifyRequest;
    setupClaimId?: string;
    user: NonNullable<FastifyRequest["user"]>;
  }) => {
    const internalWallets = await resolveInternalWallets({
      app,
      privyUserId: input.user.privyUserId,
    });
    return enableTelegramBotTrading(
      db,
      {
        buildKalshiEligibilityForWallet: (walletAddress) =>
          buildKalshiEligibilityForRequest({
            geoFenceConfig: kalshiGeoFenceConfig,
            request: input.request,
            user: input.user,
            walletAddress,
          }),
        enabledVenues: input.body.enabledVenues as
          | TelegramBotTradingVenue[]
          | undefined,
        internalWallets,
        maxAmountUsd: input.body.maxAmountUsd ?? null,
        preferredWalletAddress: input.body.walletAddress ?? null,
        privyWalletId: input.body.privyWalletId ?? null,
        setupClaimId: input.setupClaimId ?? null,
        signerInspector,
        userId: input.user.id,
      },
      createTradingForRequest(input.request),
    );
  };

  const sendEnableFailure = (
    reply: FastifyReply,
    error: unknown,
    input: { operation: string; userId: string },
  ) => {
    if (error instanceof TelegramBotTradingEnableError) {
      reply.code(error.statusCode);
      return reply.send({
        error: error.code,
        grants: error.grants,
        message: error.message,
        walletSetupIssues: error.walletSetupIssues,
      });
    }
    const knownCode =
      error instanceof Error &&
      [
        "telegram_bot_trading_claim_stale",
        "telegram_bot_trading_opted_out",
        "telegram_bot_trading_policy_changed",
        "telegram_account_required",
        "internal_trading_wallet_required",
        "no_compatible_venues_for_wallet",
      ].includes(error.message)
        ? error.message
        : null;
    app.log.error(
      { err: error, operation: input.operation, userId: input.userId },
      "Telegram bot trading enable failed unexpectedly",
    );
    reply.code(knownCode?.startsWith("telegram_bot_trading_") ? 409 : 400);
    return reply.send({
      error: knownCode ?? "telegram_bot_trading_enable_failed",
      message:
        knownCode === "telegram_bot_trading_claim_stale"
          ? "Auto-setup lease is stale. Refresh status and retry."
          : knownCode === "telegram_bot_trading_opted_out"
            ? "Telegram trading was disabled while setup was in progress."
            : knownCode === "telegram_bot_trading_policy_changed"
              ? "Telegram trading policy changed. Refresh status and retry."
              : knownCode === "telegram_account_required"
                ? "Telegram account is required before enabling bot trading."
                : knownCode === "internal_trading_wallet_required"
                  ? "Create an internal Hunch Trading Wallet before enabling Telegram bot trading."
                  : knownCode === "no_compatible_venues_for_wallet"
                    ? "No compatible bot trading venues are enabled."
                    : "Unable to enable Telegram bot trading.",
    });
  };

  const defaultRequireInternal = async (
    request: { headers: Record<string, unknown> },
    reply: {
      code: (statusCode: number) => unknown;
      send: (body: unknown) => unknown;
    },
  ) => {
    if (isInternalTradingAuthorized(request)) return;
    reply.code(401);
    return reply.send({ error: "Unauthorized" });
  };
  const requireInternal =
    dependencies.internalPreHandler ?? defaultRequireInternal;

  api.post(
    "/internal/telegram-bot/account",
    {
      preHandler: [requireInternal, requirePrivateTelegramChat],
      schema: { body: internalAccountBodySchema },
    },
    async (request, reply) => {
      const telegramUserId = String(request.body.telegramUserId);
      try {
        const initialLink = await resolveActiveTelegramAccountLink({
          db,
          telegramUserId,
        });
        if (!initialLink) {
          return reply.send(buildTelegramAccountValueUnavailableMessage());
        }
        const account = await buildAccountValue(initialLink.userId);
        const currentLink = await resolveActiveTelegramAccountLink({
          db,
          telegramUserId,
        });
        if (!sameActiveTelegramAccountLink(initialLink, currentLink)) {
          return reply.send(buildTelegramAccountValueUnavailableMessage());
        }
        return reply.send(buildAccountValueMessage({ account }));
      } catch (error) {
        const errorCode =
          error && typeof error === "object" && "code" in error
            ? String((error as { code?: unknown }).code ?? "unknown")
            : error instanceof Error
              ? error.name
              : "unknown";
        request.log.warn(
          { errorCode },
          "Telegram Account Value projection failed",
        );
        return reply.send(buildTelegramAccountValueUnavailableMessage());
      }
    },
  );

  const sendTelegramFundingError = (
    request: FastifyRequest,
    reply: FastifyReply,
    error: unknown,
  ) => {
    const errorCode =
      error instanceof TelegramFundingError
        ? error.code
        : "telegram_funding_unexpected_error";
    request.log.warn(
      {
        errorCode,
        errorMessage:
          error instanceof Error
            ? error.message
                .replace(/https?:\/\/\S+/gu, "[redacted-url]")
                .slice(0, 240)
            : undefined,
        errorName: error instanceof Error ? error.name : undefined,
      },
      "Telegram funding request failed",
    );
    if (
      error instanceof TelegramFundingError &&
      error.code === "private_chat_required"
    ) {
      return reply.code(403).send({ error: error.code });
    }
    if (
      error instanceof TelegramFundingError &&
      (error.code === "funding_context_not_found" ||
        error.code === "telegram_account_required")
    ) {
      return reply.code(404).send({ error: error.code });
    }
    if (
      error instanceof TelegramFundingError &&
      error.code === "funding_session_expired"
    ) {
      return reply.send(
        buildTelegramFundingUnavailableMessage({ reason: "expired" }),
      );
    }
    if (
      error instanceof TelegramFundingError &&
      error.code === "funding_session_unavailable"
    ) {
      return reply.send(
        buildTelegramFundingUnavailableMessage({ reason: "unavailable" }),
      );
    }
    if (
      error instanceof TelegramFundingError &&
      error.code === "funding_receive_disabled"
    ) {
      return reply.send(
        buildTelegramFundingUnavailableMessage({ reason: "disabled" }),
      );
    }
    if (
      error instanceof TelegramFundingError &&
      error.code === "funding_session_active_elsewhere"
    ) {
      return reply.send(buildTelegramFundingActiveElsewhereMessage());
    }
    return reply
      .code(error instanceof TelegramFundingError ? 409 : 503)
      .send({ error: errorCode });
  };
  const sendTelegramFundingMessage = async (
    request: FastifyRequest,
    reply: FastifyReply,
    load: () => Promise<unknown>,
  ) => {
    try {
      return reply.send(await load());
    } catch (error) {
      return sendTelegramFundingError(request, reply, error);
    }
  };

  api.post(
    "/internal/telegram-bot/funding/open",
    {
      preHandler: requireInternal,
      schema: { body: internalFundingOpenBodySchema },
    },
    async (request, reply) => {
      return sendTelegramFundingMessage(request, reply, () =>
        fundingService.open(request.body, new Date()),
      );
    },
  );

  api.post(
    "/internal/telegram-bot/funding/open-route",
    {
      preHandler: requireInternal,
      schema: { body: internalFundingOpenRouteBodySchema },
    },
    async (request, reply) => {
      const expectedVenue = request.body.fundingRoute.startsWith("limitless_")
        ? "limitless"
        : "polymarket";
      if (request.body.venue !== expectedVenue) {
        return reply.code(409).send({ error: "invalid_funding_choice" });
      }
      try {
        const opened = await fundingService.open(request.body);
        if (!opened.fundingContextId) {
          return reply.code(409).send({ error: "funding_context_not_found" });
        }
        return await fundingService.selectTarget({
          chatId: request.body.chatId,
          choiceToken: {
            limitless_base_usdc_direct_v1: "ld",
            polymarket_polygon_pusd_direct_v1: "pd",
            polymarket_polygon_usdce_wrap_v1: "pw",
          }[request.body.fundingRoute],
          contextId: opened.fundingContextId,
          idempotencyKey: `${request.body.idempotencyKey.slice(0, 177)}:route`,
          telegramMessageId: request.body.telegramMessageId,
          telegramUserId: request.body.telegramUserId,
        });
      } catch (error) {
        return sendTelegramFundingError(request, reply, error);
      }
    },
  );

  api.post(
    "/internal/telegram-bot/funding/session",
    {
      preHandler: requireInternal,
      schema: { body: internalFundingSessionBodySchema },
    },
    async (request, reply) => {
      return sendTelegramFundingMessage(request, reply, () =>
        fundingService.session(
          request.body,
          new Date(),
          createFundingDecoratorForRequest(request),
        ),
      );
    },
  );

  api.post(
    "/internal/telegram-bot/funding/select-target",
    {
      preHandler: requireInternal,
      schema: { body: internalFundingSelectTargetBodySchema },
    },
    async (request, reply) => {
      try {
        return reply.send(
          await fundingService.selectTarget(
            request.body,
            new Date(),
            createFundingDecoratorForRequest(request),
          ),
        );
      } catch (error) {
        return sendTelegramFundingError(request, reply, error);
      }
    },
  );

  api.post(
    "/internal/telegram-bot/funding/cancel-active",
    {
      preHandler: requireInternal,
      schema: { body: internalFundingCancelActiveBodySchema },
    },
    async (request, reply) => {
      const active = await db.query<{
        context_id: string;
        telegram_message_id: string | number | null;
      }>(
        `
          select
            funding_context.id as context_id,
            funding_context.telegram_message_id
          from user_telegram_accounts telegram_account
          join telegram_funding_sessions funding_context
            on funding_context.user_id = telegram_account.user_id
           and funding_context.telegram_account_id = telegram_account.id
           and funding_context.telegram_user_id = telegram_account.telegram_user_id
          join funding_receive_sessions receive_session
            on receive_session.id = funding_context.receive_session_id
           and receive_session.user_id = funding_context.user_id
           and receive_session.owner_channel = 'telegram'
          where telegram_account.telegram_user_id = $1
            and funding_context.chat_id = $2
            and funding_context.cancelled_at is null
            and funding_context.latest_terminal_projection is null
            and funding_context.expires_at > now()
            and receive_session.status in (
              'open',
              'processing',
              'review_required',
              'recovery_required'
            )
            and receive_session.expires_at > now()
          order by funding_context.created_at desc, funding_context.id desc
          limit 1
        `,
        [String(request.body.telegramUserId), String(request.body.chatId)],
      );
      const activeContext = active.rows[0];
      if (!activeContext) {
        return reply.code(409).send({ error: "funding_context_not_found" });
      }
      const originalMessageId = Number(activeContext.telegram_message_id);
      try {
        return reply.send(
          await fundingService.cancel({
            ...request.body,
            contextId: activeContext.context_id,
            telegramMessageId:
              Number.isSafeInteger(originalMessageId) && originalMessageId > 0
                ? originalMessageId
                : null,
          }),
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "telegram_funding_money_boundary_crossed"
        ) {
          // A received transfer must keep its observation and routing path. Do
          // not turn that correct financial boundary into a generic error: the
          // caller needs the active card, not a retry prompt.
          return sendTelegramFundingMessage(request, reply, () =>
            fundingService.session(
              {
                chatId: request.body.chatId,
                contextId: activeContext.context_id,
                requestObservation: true,
                telegramMessageId:
                  Number.isSafeInteger(originalMessageId) &&
                  originalMessageId > 0
                    ? originalMessageId
                    : undefined,
                telegramUserId: request.body.telegramUserId,
                view: "progress",
              },
              new Date(),
              createFundingDecoratorForRequest(request),
            ),
          );
        }
        return sendTelegramFundingError(request, reply, error);
      }
    },
  );

  api.post(
    "/internal/telegram-bot/funding/cancel",
    {
      preHandler: requireInternal,
      schema: { body: internalFundingCancelBodySchema },
    },
    async (request, reply) => {
      const marketReturn = fundingService.loadMarketReturn
        ? await fundingService.loadMarketReturn(request.body).catch(() => null)
        : null;
      try {
        const cancelled = await fundingService.cancel(request.body);
        if (!marketReturn) return reply.send(cancelled);
        return reply.send(
          await buildTelegramBotTradingMarketMessage({
            appBaseUrl: request.body.appBaseUrl,
            chatId: String(request.body.chatId),
            context: {
              focusSide: marketReturn.side,
              origin: "direct",
              returnCallbackData: "hm:v1:home",
            },
            db,
            marketRef: marketReturn.marketId,
            telegramMessageId: request.body.telegramMessageId,
            telegramMiniAppEnabled: request.body.telegramMiniAppEnabled,
            telegramUserId: request.body.telegramUserId,
            trading: createTradingForRequest(request),
            writeTradeInputContext,
          }),
        );
      } catch (error) {
        if (
          marketReturn &&
          error instanceof Error &&
          error.message === "telegram_funding_money_boundary_crossed"
        ) {
          return reply.send(
            await buildTelegramBotTradingMarketMessage({
              appBaseUrl: request.body.appBaseUrl,
              chatId: String(request.body.chatId),
              context: {
                focusSide: marketReturn.side,
                origin: "direct",
                returnCallbackData: "hm:v1:home",
              },
              db,
              marketRef: marketReturn.marketId,
              telegramMessageId: request.body.telegramMessageId,
              telegramMiniAppEnabled: request.body.telegramMiniAppEnabled,
              telegramUserId: request.body.telegramUserId,
              trading: createTradingForRequest(request),
              writeTradeInputContext,
            }),
          );
        }
        return sendTelegramFundingError(request, reply, error);
      }
    },
  );

  api.post(
    "/internal/telegram-bot/funding/back-to-market",
    {
      preHandler: requireInternal,
      schema: { body: internalFundingBackToMarketBodySchema },
    },
    async (request, reply) => {
      try {
        const marketReturn = fundingService.loadMarketReturn
          ? await fundingService.loadMarketReturn(request.body)
          : null;
        if (!marketReturn) {
          return reply.send(
            buildTelegramFundingUnavailableMessage({ reason: "unavailable" }),
          );
        }
        return reply.send(
          await buildTelegramBotTradingMarketMessage({
            appBaseUrl: request.body.appBaseUrl,
            chatId: String(request.body.chatId),
            context: {
              focusSide: marketReturn.side,
              origin: "direct",
              returnCallbackData: "hm:v1:home",
            },
            db,
            marketRef: marketReturn.marketId,
            telegramMessageId: request.body.telegramMessageId,
            telegramMiniAppEnabled: request.body.telegramMiniAppEnabled,
            telegramUserId: request.body.telegramUserId,
            trading: createTradingForRequest(request),
            writeTradeInputContext,
          }),
        );
      } catch (error) {
        return sendTelegramFundingError(request, reply, error);
      }
    },
  );

  api.post(
    "/internal/telegram-bot/funding/review-conversion",
    {
      preHandler: requireInternal,
      schema: { body: internalFundingReviewBodySchema },
    },
    async (request, reply) => {
      const reviewConversion =
        fundingService.reviewConversion?.bind(fundingService);
      if (!reviewConversion) {
        return reply.code(503).send({ error: "funding_review_unavailable" });
      }
      return sendTelegramFundingMessage(request, reply, () =>
        reviewConversion(request.body, new Date()),
      );
    },
  );

  api.post(
    "/internal/telegram-bot/funding/confirm-conversion",
    {
      preHandler: requireInternal,
      schema: { body: internalFundingConfirmBodySchema },
    },
    async (request, reply) => {
      const confirmConversion =
        fundingService.confirmConversion?.bind(fundingService);
      if (!confirmConversion) {
        return reply.code(503).send({ error: "funding_review_unavailable" });
      }
      return sendTelegramFundingMessage(request, reply, () =>
        confirmConversion(
          request.body,
          new Date(),
          createFundingDecoratorForRequest(request),
        ),
      );
    },
  );

  api.post(
    "/internal/telegram-bot/funding/resume-buy",
    {
      preHandler: [requireInternal, requirePrivateTelegramChat],
      schema: { body: internalFundingResumeBuyBodySchema },
    },
    async (request, reply) => {
      const message = await resumeTelegramFundingBuyContinuation({
        appBaseUrl: request.body.appBaseUrl,
        chatId: String(request.body.chatId),
        db,
        idempotencyKey: request.body.idempotencyKey,
        telegramMessageId: request.body.telegramMessageId,
        telegramMiniAppEnabled: request.body.telegramMiniAppEnabled,
        telegramUserId: String(request.body.telegramUserId),
        token: request.body.continuationToken,
        trading: createTradingForRequest(request),
      });
      return reply.send(message);
    },
  );

  api.post(
    "/internal/telegram-bot/funding/change-buy-amount",
    {
      preHandler: [requireInternal, requirePrivateTelegramChat],
      schema: { body: internalFundingChangeBuyAmountBodySchema },
    },
    async (request, reply) => {
      const message = await changeTelegramFundingBuyContinuationAmount({
        appBaseUrl: request.body.appBaseUrl,
        chatId: String(request.body.chatId),
        db,
        telegramMessageId: request.body.telegramMessageId,
        telegramMiniAppEnabled: request.body.telegramMiniAppEnabled,
        telegramUserId: String(request.body.telegramUserId),
        token: request.body.continuationToken,
        signerInspector,
        trading: createTradingForRequest(request),
        writeTradeInputContext,
      });
      return reply.send(message);
    },
  );

  api.post(
    "/internal/telegram-bot/positions",
    {
      preHandler: requireInternal,
      schema: { body: internalPositionsBodySchema },
    },
    (request) =>
      buildPositionsMessage({
        appBaseUrl: request.body.appBaseUrl,
        pool: routePool,
        telegramMiniAppEnabled: request.body.telegramMiniAppEnabled,
        telegramUserId: request.body.telegramUserId,
      }),
  );

  api.post(
    "/internal/telegram-bot/trading/market-search",
    {
      preHandler: requireInternal,
      schema: { body: internalMarketSearchBodySchema },
    },
    async (request) => {
      const aggClient = env.aggMarketAppId
        ? createAggMarketClient({
            apiKey: env.aggMarketApiKey,
            appId: env.aggMarketAppId,
            baseUrl: env.aggMarketBaseUrl,
            timeoutMs: env.aggMarketTimeoutMs,
          })
        : null;
      const cacheClientPromise = aggClient
        ? getRedis().catch(() => null)
        : Promise.resolve(null);
      let loggedAggFallback = false;
      return searchMarkets({
        pool: routePool,
        query: request.body.query,
        resolveCrossVenueAlternatives: aggClient
          ? async ({ marketId, venues }) => {
              try {
                const { response } =
                  await getAggMarketAlternativesResponseCachedWithMetadata({
                    cacheClient: await cacheClientPromise,
                    client: aggClient,
                    db: routePool,
                    marketId,
                    matchedTtlSec: env.aggClustersCacheTtlSec,
                    notFoundTtlSec:
                      env.aggMarketAlternativesNotFoundCacheTtlSec,
                    onCacheError: (operation, error) => {
                      request.log.warn(
                        { error, operation },
                        "Telegram market search AGG cache failed",
                      );
                    },
                    query: {
                      limit: 10,
                      sourceLimit: 50,
                      venues: venues.join(","),
                    },
                  });
                if (!response || response.status !== "matched") return [];
                return response.alternatives
                  .filter(
                    (market) =>
                      market.active !== false && market.orderable !== false,
                  )
                  .map(mapClusterMarketToTelegramSearchResult);
              } catch (error) {
                if (!loggedAggFallback) {
                  loggedAggFallback = true;
                  request.log.warn(
                    { error },
                    "Telegram market search AGG enrichment skipped",
                  );
                }
                return [];
              }
            }
          : undefined,
      });
    },
  );

  api.post(
    "/internal/telegram-bot/deposit",
    {
      preHandler: requireInternal,
      schema: { body: internalDepositBodySchema },
    },
    async (request) => {
      const venue = request.body.venue?.trim().toLowerCase() ?? null;
      if (venue === null || venue === "any") {
        return buildDepositMessage({
          pool: db,
          telegramUserId: request.body.telegramUserId,
          venue,
        });
      }
      // Explicit legacy venue callbacks cannot bypass the durable funding
      // lifecycle. Future Relay venues remain hidden until an adapter owns
      // their address, consent, delivery, and redaction boundaries.
      return buildTelegramFundingUnavailableMessage({ reason: "disabled" });
    },
  );

  api.post(
    "/internal/telegram-bot/positions/:positionId/card",
    {
      preHandler: requireInternal,
      schema: {
        body: internalPositionCardBodySchema.omit({ positionId: true }),
        params: z.object({ positionId: z.string().uuid() }).strict(),
      },
    },
    async (request) => {
      const loaded = await loadPositions({
        pool: routePool,
        sync: false,
        telegramUserId: request.body.telegramUserId,
      });
      const position = loaded.snapshot.positions.find(
        (candidate) => candidate.position.id === request.params.positionId,
      );
      if (!loaded.linked || !position || !position.marketId || !position.side) {
        return {
          parse_mode: "MarkdownV2" as const,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  callback_data: "hm:v1:positions",
                  text: "⬅️ Back to positions",
                },
              ],
            ],
          },
          text: formatTelegramCalloutMarkdownV2({
            bodyMarkdownV2: "The holding remains visible in My positions\\.",
            icon: "⚠️",
            title: "Position details unavailable",
          }),
        };
      }
      const average =
        position.averagePrice == null
          ? "unavailable"
          : `${(position.averagePrice * 100).toFixed(1)}¢`;
      const bid =
        position.markPrice == null
          ? "unavailable"
          : `${(position.markPrice * 100).toFixed(1)}¢`;
      const pnl =
        position.pnlUsd == null || position.pnlPercent == null
          ? "unavailable"
          : `${position.pnlUsd >= 0 ? "+" : ""}$${position.pnlUsd.toFixed(2)} (${position.pnlPercent >= 0 ? "+" : ""}${position.pnlPercent.toFixed(1)}%)`;
      const matchingHoldings = loaded.snapshot.positions.filter(
        (candidate) =>
          candidate.marketId === position.marketId &&
          candidate.side === position.side,
      );
      const walletSuffix =
        matchingHoldings.length > 1 && position.position.walletAddress
          ? position.position.walletAddress.slice(-6)
          : null;
      const settlementLine =
        position.redemptionStatus === "redeemable"
          ? "Ready to redeem"
          : position.redemptionStatus === "market_open"
            ? null
            : position.redemptionStatus === "resolved_not_redeemable" ||
                position.redemptionStatus === "redeemed"
              ? "Resolved"
              : "Waiting for settlement";
      return buildTelegramBotTradingMarketMessage({
        appBaseUrl: request.body.appBaseUrl,
        chatId: String(request.body.telegramUserId),
        context: {
          focusPositionId: position.position.id,
          focusPositionWalletAddress: position.position.walletAddress,
          focusSide: position.side ?? undefined,
          origin: "position",
          positionLines: [
            `Position: ${position.position.size.toFixed(4)} shares · Avg ${average}`,
            `Live bid: ${bid} · PnL ${pnl}`,
            ...(settlementLine ? [`Status: ${settlementLine}`] : []),
            ...(walletSuffix ? [`Wallet: …${walletSuffix}`] : []),
          ],
          positionRedemptionStatus: position.redemptionStatus,
          returnCallbackData: "hm:v1:positions",
        },
        db,
        marketRef: position.marketId,
        telegramMessageId: request.body.telegramMessageId,
        telegramMiniAppEnabled: request.body.telegramMiniAppEnabled,
        telegramUserId: request.body.telegramUserId,
        trading: createTradingForRequest(request),
        writeTradeInputContext,
      });
    },
  );

  api.post(
    "/internal/telegram-bot/trading/status",
    {
      preHandler: requireInternal,
      schema: { body: internalStatusBodySchema },
    },
    async (request) => {
      const trading = createTradingForRequest(request);
      await reconcileTelegramBotTradingStatus({
        reconciliationEnabled,
        reconcileLocal: () =>
          reconcileStaleTelegramTradeIntents(db, {
            telegramUserId: String(request.body.telegramUserId),
          }).catch((error) => {
            app.log.warn(
              { error, telegramUserId: request.body.telegramUserId },
              "Telegram local reconcile before trade status failed",
            );
          }),
        reconcileVenue: () =>
          reconcileTelegramVenueIntents(db, trading, {
            dryRun: false,
            limit: 3,
            telegramUserId: request.body.telegramUserId,
          }).catch((error) => {
            app.log.warn(
              { error, telegramUserId: request.body.telegramUserId },
              "Telegram venue reconcile before trade status failed",
            );
          }),
      });
      const message = await buildTelegramBotTradingStatusMessage(
        db,
        request.body.telegramUserId,
        trading,
        { reconcileLocal: false },
      );
      return reconciliationEnabled
        ? message
        : {
            ...message,
            text: `${message.text}\n\n${formatTelegramCalloutMarkdownV2({
              bodyMarkdownV2:
                "Required API and finance reconciliation is disabled\\.",
              icon: "⚠️",
              title: "Trading confirmation unavailable",
            })}`,
          };
    },
  );

  api.post(
    "/internal/telegram-bot/trading/disable",
    {
      preHandler: requireInternal,
      schema: { body: internalDisableBodySchema },
    },
    async (request) => {
      const disabled = await disableTelegramBotTradingForTelegramUser(
        db,
        request.body.telegramUserId,
      );
      return {
        disabled,
        status: disabled ? "disabled" : "already_disabled",
      };
    },
  );

  api.post(
    "/internal/telegram-bot/trading/market-card",
    {
      preHandler: requireInternal,
      schema: { body: internalMarketCardBodySchema },
    },
    async (request) => {
      if (reconciliationEnabled) {
        return buildTelegramBotTradingMarketMessage({
          appBaseUrl: request.body.appBaseUrl,
          chatId: request.body.chatId,
          context: request.body.context,
          db,
          isAdminTest: request.body.isAdminTest,
          marketRef: request.body.marketRef,
          publicBrowseOnly: request.body.publicBrowseOnly,
          telegramMessageId: request.body.telegramMessageId,
          telegramMiniAppEnabled: request.body.telegramMiniAppEnabled,
          telegramUserId: request.body.telegramUserId,
          trading: createTradingForRequest(request),
          writeTradeInputContext,
        });
      }
      const openButton = buildHunchMiniAppWebButton({
        appBaseUrl: request.body.appBaseUrl,
        enabled: request.body.telegramMiniAppEnabled === true,
        text: "Open in Hunch",
      });
      return {
        parse_mode: "MarkdownV2" as const,
        ...(openButton
          ? { reply_markup: { inline_keyboard: [[openButton]] } }
          : {}),
        text: formatTelegramCalloutMarkdownV2({
          bodyMarkdownV2: "Open Hunch to trade\\.",
          icon: "⚠️",
          title: "Trading temporarily unavailable",
        }),
      };
    },
  );

  const handleInternalCallback = async (
    request: {
      body: z.infer<typeof internalCallbackBodySchema>;
      params?: z.infer<typeof internalIntentParamsSchema>;
    },
    expectedType?:
      | "buy"
      | "sell"
      | "redeem"
      | "cancel"
      | "change_amount"
      | "confirm",
  ) => {
    if (expectedType === "confirm" && !reconciliationEnabled) {
      const chatId = request.body.callbackQuery.message?.chat?.id;
      const text =
        "Trading is temporarily unavailable because required reconciliation is not enabled.";
      return {
        handled: true,
        answers: [
          {
            callbackQueryId: request.body.callbackQuery.id,
            showAlert: true,
            text,
          },
        ],
        messages:
          chatId == null
            ? []
            : [
                {
                  chat_id: String(chatId),
                  text,
                },
              ],
      };
    }
    return captureTelegramBotTradingCallback({
      appBaseUrl: request.body.appBaseUrl,
      callbackQuery: request.body.callbackQuery,
      db,
      expectedIntentId: request.params?.id ?? null,
      expectedType: expectedType ?? null,
      log: app.log,
      openFundingBuyReturn: (input) =>
        openFundingBuyReturn(
          input,
          createFundingDecoratorForRequest(
            request as FastifyRequest,
            request.body.appBaseUrl,
          ),
        ),
      inspectTradeShortfall: (input) =>
        tradeShortfallFundingService.inspect(input),
      inspectMiniAppFunding: (input, trade) =>
        tradeShortfallFundingService.inspectMiniAppFunding(input, trade),
      commitTradeShortfall: (input) =>
        tradeShortfallFundingService.commit(input),
      cancelFundingOperation: async (input) => {
        await cancelFundingOperationForUser(pool, input);
      },
      signerInspector,
      telegramMiniAppEnabled: request.body.telegramMiniAppEnabled,
      trading: createTradingForRequest(request as FastifyRequest),
      writeTradeInputContext,
    });
  };

  const handleInternalPreviewCallback = async (request: {
    body: z.infer<typeof internalCallbackBodySchema>;
  }) =>
    captureTelegramBotTradingCallback({
      appBaseUrl: request.body.appBaseUrl,
      callbackQuery: request.body.callbackQuery,
      db,
      expectedType: null,
      log: app.log,
      openFundingBuyReturn: (input) =>
        openFundingBuyReturn(
          input,
          createFundingDecoratorForRequest(
            request as FastifyRequest,
            request.body.appBaseUrl,
          ),
        ),
      inspectTradeShortfall: (input) =>
        tradeShortfallFundingService.inspect(input),
      inspectMiniAppFunding: (input, trade) =>
        tradeShortfallFundingService.inspectMiniAppFunding(input, trade),
      commitTradeShortfall: (input) =>
        tradeShortfallFundingService.commit(input),
      cancelFundingOperation: async (input) => {
        await cancelFundingOperationForUser(pool, input);
      },
      signerInspector,
      telegramMiniAppEnabled: request.body.telegramMiniAppEnabled,
      trading: createTradingForRequest(request as FastifyRequest),
      writeTradeInputContext,
    });

  api.post(
    "/internal/telegram-bot/trading/preview-intent",
    {
      preHandler: requireInternal,
      schema: { body: internalCallbackBodySchema },
    },
    handleInternalPreviewCallback,
  );

  api.post(
    "/internal/telegram-bot/trading/input-contexts/:id/begin",
    {
      preHandler: [requireInternal, requirePrivateTelegramChat],
      schema: {
        body: internalTradeInputBeginBodySchema,
        params: internalTradeInputParamsSchema,
      },
    },
    async (request, reply) => {
      const chatId = String(request.body.chatId);
      const telegramUserId = String(request.body.telegramUserId);
      const redis = await getRedis().catch(() => null);
      if (!redis) {
        return reply.code(503).send({ error: "input_context_unavailable" });
      }
      const [context, link, policyState] = await Promise.all([
        readTelegramBotTradeInputContext({ id: request.params.id, redis }),
        resolveActiveTelegramAccountLink({ db, telegramUserId }),
        resolveSignalBotTradingPolicyStateFromDb(db),
      ]);
      if (!context) {
        return reply.code(410).send({ error: "input_context_expired" });
      }
      if (
        !link ||
        context.telegramUserId !== telegramUserId ||
        context.chatId !== chatId ||
        context.action !== request.body.action ||
        !telegramBotTradeInputMessageScopeMatches(
          context.messageScope,
          request.body.telegramMessageId,
        )
      ) {
        return reply.code(403).send({ error: "input_context_mismatch" });
      }
      if (
        !(await isTelegramBotTradeInputContextAuthorityCurrent({
          context,
          db,
          telegramUserId,
        }))
      ) {
        return reply.code(403).send({ error: "input_context_mismatch" });
      }
      const policy = policyState.policy;
      const venueAllowsCustomInput =
        policy.tradingVenues.includes(context.venue) ||
        (context.deliveryMode === "app_handoff" &&
          isTelegramAppHandoffV2EnabledForVenue({
            contractVersion: policy.miniAppHandoffContractVersion,
            mode: policy.miniAppHandoffMode,
            venue: context.venue,
          }));
      if (
        !policy.tradingEnabled ||
        !policy.customTradeInputEnabled ||
        !policy.tradingActions.includes(context.action) ||
        !venueAllowsCustomInput
      ) {
        return reply.code(409).send({ error: "custom_trade_input_disabled" });
      }
      const instruction =
        context.action === "buy"
          ? "Send the USD amount to buy. Examples: 2, 2.50, or $2.50."
          : "Send exact shares, an explicit percentage, or all. Examples: 1.25, 25%, or all. A bare number always means shares.";
      return reply.send({
        action: context.action,
        contextId: context.id,
        expiresAt: context.expiresAt,
        message: {
          parse_mode: "MarkdownV2" as const,
          text: joinTelegramMarkdownV2Lines([
            `✍️ ${formatTelegramBoldMarkdownV2(
              context.action === "buy" ? "Custom buy" : "Custom sell",
            )}`,
            "",
            escapeTelegramMarkdownV2(instruction),
            "",
            escapeTelegramMarkdownV2(
              "Use Cancel below or another menu action to stop this input.",
            ),
          ]),
          reply_markup: {
            inline_keyboard: [
              [
                {
                  callback_data: `hbt:cancel_input:${context.id}`,
                  text: "✖️ Cancel input",
                },
              ],
            ],
          },
        },
      });
    },
  );

  const openTradeInputMarket = async (
    request: FastifyRequest<{
      Body: z.infer<typeof internalTradeInputCancelBodySchema>;
      Params: z.infer<typeof internalTradeInputParamsSchema>;
    }>,
    reply: FastifyReply,
  ) => {
    const chatId = String(request.body.chatId);
    const telegramUserId = String(request.body.telegramUserId);
    const redis = await getRedis().catch(() => null);
    if (!redis) {
      return reply.code(503).send({ error: "input_context_unavailable" });
    }
    const [context, link] = await Promise.all([
      readTelegramBotTradeInputContextForNavigation({
        id: request.params.id,
        redis,
      }),
      resolveActiveTelegramAccountLink({ db, telegramUserId }),
    ]);
    if (!context) {
      return reply.code(410).send({ error: "input_context_expired" });
    }
    // This route only rebuilds a current market card. It deliberately does not
    // revive the expired input or submit a trade, so authority drift does not
    // make navigation from the old private card unsafe.
    if (
      !link ||
      context.telegramUserId !== telegramUserId ||
      context.chatId !== chatId ||
      !telegramBotTradeInputMessageScopeMatches(
        context.messageScope,
        request.body.telegramMessageId,
      )
    ) {
      return reply.code(403).send({ error: "input_context_mismatch" });
    }
    return reply.send(
      await buildTelegramBotTradingMarketMessage({
        appBaseUrl: request.body.appBaseUrl,
        chatId,
        context: { focusSide: context.side, origin: "direct" },
        db,
        marketRef: context.marketId,
        telegramMessageId: request.body.telegramMessageId,
        telegramMiniAppEnabled: request.body.telegramMiniAppEnabled,
        telegramUserId,
        trading: createTradingForRequest(request),
        writeTradeInputContext,
      }),
    );
  };

  for (const action of ["market", "cancel"] as const) {
    api.post(
      `/internal/telegram-bot/trading/input-contexts/:id/${action}`,
      {
        preHandler: [requireInternal, requirePrivateTelegramChat],
        schema: {
          body: internalTradeInputCancelBodySchema,
          params: internalTradeInputParamsSchema,
        },
      },
      openTradeInputMarket,
    );
  }

  api.post(
    "/internal/telegram-bot/trading/input-contexts/:id/complete",
    {
      preHandler: [requireInternal, requirePrivateTelegramChat],
      schema: {
        body: internalTradeInputCompleteBodySchema,
        params: internalTradeInputParamsSchema,
      },
    },
    async (request, reply) => {
      const chatId = String(request.body.chatId);
      const telegramUserId = String(request.body.telegramUserId);
      const initialLink = await resolveActiveTelegramAccountLink({
        db,
        telegramUserId,
      });
      if (!initialLink) {
        return reply.code(403).send({ error: "telegram_account_required" });
      }
      const result = await completeTelegramBotTradeInput({
        appBaseUrl: request.body.appBaseUrl,
        chatId,
        contextId: request.params.id,
        db,
        isLinkCurrent: async () =>
          sameActiveTelegramAccountLink(
            initialLink,
            await resolveActiveTelegramAccountLink({ db, telegramUserId }),
          ),
        loadContext: async () => {
          const redis = await getRedis().catch(() => null);
          return redis
            ? readTelegramBotTradeInputContext({
                id: request.params.id,
                redis,
              })
            : null;
        },
        openFundingBuyReturn: (input) =>
          openFundingBuyReturn(
            input,
            createFundingDecoratorForRequest(
              request as FastifyRequest,
              request.body.appBaseUrl,
            ),
          ),
        inspectTradeShortfall: (input) =>
          tradeShortfallFundingService.inspect(input),
        inspectMiniAppFunding: (input, trade) =>
          tradeShortfallFundingService.inspectMiniAppFunding(input, trade),
        telegramMessageId: request.body.telegramMessageId,
        telegramMiniAppEnabled: request.body.telegramMiniAppEnabled,
        telegramUserId,
        trading: createTradingForRequest(request),
        value: request.body.value,
      });
      return reply.send(result);
    },
  );

  api.post(
    "/internal/telegram-bot/trading/intents/:id/receipt",
    {
      preHandler: requireInternal,
      schema: {
        body: internalIntentReceiptBodySchema,
        params: internalIntentParamsSchema,
      },
    },
    async (request) => {
      const result = await db.query(
        `
          update telegram_trade_intents
          set result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
                'telegramReceipt',
                jsonb_build_object(
                  'deliveredAt', now(),
                  'delivery', $3::text,
                  'messageId', $4::bigint,
                  'intentStatus', status
                )
              ),
              updated_at = now()
          where id = $1::uuid
            and telegram_user_id = $2::text
        `,
        [
          request.params.id,
          String(request.body.telegramUserId),
          request.body.delivery,
          request.body.messageId ?? null,
        ],
      );
      return { marked: (result.rowCount ?? 0) > 0 };
    },
  );

  api.post(
    "/internal/telegram-bot/trading/intents/:id/execute",
    {
      preHandler: requireInternal,
      schema: {
        body: internalCallbackBodySchema,
        params: internalIntentParamsSchema,
      },
    },
    (request) => handleInternalCallback(request, "confirm"),
  );

  api.post(
    "/internal/telegram-bot/trading/intents/:id/cancel",
    {
      preHandler: requireInternal,
      schema: {
        body: internalCallbackBodySchema,
        params: internalIntentParamsSchema,
      },
    },
    (request) => handleInternalCallback(request, "cancel"),
  );

  api.post(
    "/internal/telegram-bot/trading/intents/:id/change-amount",
    {
      preHandler: requireInternal,
      schema: {
        body: internalCallbackBodySchema,
        params: internalIntentParamsSchema,
      },
    },
    (request) => handleInternalCallback(request, "change_amount"),
  );

  api.get(
    "/telegram/bot-trading/status",
    { preHandler: authPreHandler },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      const telegramResult = await db.query<{
        telegram_user_id: string;
      }>(
        `SELECT telegram_user_id
           FROM user_telegram_accounts
          WHERE user_id = $1
          LIMIT 1`,
        [user.id],
      );
      const telegramUserId = telegramResult.rows[0]?.telegram_user_id ?? null;
      const [policyState, preference, status] = await Promise.all([
        resolveSignalBotTradingPolicyStateFromDb(db),
        loadTelegramBotTradingPreference(db, user.id),
        telegramUserId
          ? getTelegramBotTradingStatus(
              db,
              telegramUserId,
              createTradingForRequest(request),
              signerInspector,
            )
          : Promise.resolve(null),
      ]);
      const policy = policyState.policy;
      const targetConfig = resolveTelegramBotTradingManagedTarget(policyState);
      let walletSetupIssues =
        status?.linked && status.userId ? status.walletSetupIssues : [];
      let internalWallets: TelegramBotTradingInternalWalletCandidate[] = [];
      try {
        internalWallets = await resolveInternalWallets({
          app,
          privyUserId: user.privyUserId,
        });
      } catch {
        // The status remains fail-closed; the wallet lookup already logs details.
      }
      if (status?.linked && status.userId) {
        walletSetupIssues = await resolveTelegramBotTradingWalletSetupIssues(
          db,
          {
            internalWallets,
            requestedVenues:
              status.enabled && status.enabledVenues.length > 0
                ? status.enabledVenues
                : policy.tradingVenues,
            userId: status.userId,
          },
        );
      }
      const baseStatusPayload = status
        ? {
            ...status,
            walletSetupIssues,
          }
        : buildUnlinkedTelegramBotTradingStatus({
            policy,
            privyUserId: user.privyUserId ?? null,
            preference,
            setupIssue: "Telegram is not linked to this Hunch account.",
            targetConfig,
            telegramUserId,
            userId: user.id,
          });
      const signerWallets = [...baseStatusPayload.signerWallets];
      const knownWallets = new Set(
        signerWallets.map(
          (wallet) =>
            `${wallet.privyWalletId}:${canonicalWalletIdentity(
              wallet.walletChain,
              wallet.walletAddress,
            )}`,
        ),
      );
      for (const wallet of internalWallets) {
        if (wallet.walletChain !== "ethereum") continue;
        const key = `${wallet.privyWalletId}:${canonicalWalletIdentity(
          wallet.walletChain,
          wallet.walletAddress,
        )}`;
        if (knownWallets.has(key)) continue;
        signerWallets.push({
          privyWalletId: wallet.privyWalletId,
          signerStatus: await signerInspector({
            authorizationEnabled: preference?.desiredEnabled === true,
            requiredActions: policy.tradingActions.map((action) =>
              action === "redeem"
                ? "REDEEM"
                : (action.toUpperCase() as "BUY" | "SELL"),
            ),
            privyUserId: user.privyUserId,
            signer: wallet.walletAddress,
            walletId: wallet.privyWalletId,
          }),
          walletAddress: wallet.walletAddress,
          walletChain: "ethereum",
        });
      }
      const statusPayload = {
        ...baseStatusPayload,
        actionStatuses: status
          ? baseStatusPayload.actionStatuses
          : buildTelegramBotTradingActionStatuses({
              actions: policy.tradingActions,
              directExecutionReady: false,
              sellConfigured:
                policy.tradingActions.includes("sell") &&
                hasConfiguredPrivyBotPolicyForActions(
                  policy.tradingActions.map((action) =>
                    action === "redeem"
                      ? "REDEEM"
                      : (action.toUpperCase() as "BUY" | "SELL"),
                  ),
                ),
              redeemConfigured: Boolean(
                env.privyPolymarketBotRedeemPolicyId &&
                env.polymarketBuilderApiKey &&
                env.polymarketBuilderApiSecret &&
                env.polymarketBuilderApiPassphrase,
              ),
            }),
        signerWallets,
      };
      request.log.debug(
        {
          directExecutionReady: statusPayload.directExecutionReady,
          enabled: statusPayload.enabled,
          userId: user.id,
          venues: statusPayload.venueStatuses.map((venueStatus) => ({
            executable: venueStatus.executable,
            reasonCode: venueStatus.reasonCode,
            state: venueStatus.state,
            venue: venueStatus.venue,
          })),
        },
        "Telegram bot trading readiness status evaluated",
      );
      return reply.send({
        policy: {
          autoEnableOnTelegramLink: policy.autoEnableOnTelegramLink,
          autoManagedMaxAmountUsd: policy.autoManagedMaxAmountUsd,
          autoManagedVenues: policy.autoManagedVenues,
          policyRevision: policyState.policyRevision,
          tradingEnabled: policy.tradingEnabled && reconciliationEnabled,
          tradingActions: policy.tradingActions,
          tradingVenues: policy.tradingVenues.filter(
            (venue) => venue === "polymarket",
          ),
          buyAmountPresetsUsd: policy.buyAmountPresetsUsd,
          maxTradeAmountUsd: policy.maxTradeAmountUsd,
          maxSlippageBps: policy.maxSlippageBps,
          intentTtlSec: policy.intentTtlSec,
          requireConfirmation: true,
        },
        status: statusPayload,
      });
    },
  );

  api.post(
    "/telegram/bot-trading/enable",
    {
      preHandler: authPreHandler,
      schema: { body: enableBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      try {
        const body = request.body;
        if (!reconciliationEnabled) {
          reply.code(503);
          return reply.send({
            error: "telegram_venue_reconcile_required",
            message:
              "Telegram bot trading cannot be enabled until API and finance reconciliation are enabled.",
          });
        }
        const status = await activateManagedTrading({ body, request, user });
        return reply.send({ ok: true, status });
      } catch (error) {
        return sendEnableFailure(reply, error, {
          operation: "telegram-bot-trading-enable",
          userId: user.id,
        });
      }
    },
  );

  api.post(
    "/telegram/bot-trading/auto-setup/claim",
    {
      preHandler: authPreHandler,
      schema: { body: setupClaimBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      if (!reconciliationEnabled) {
        reply.code(503);
        return reply.send({ error: "telegram_venue_reconcile_required" });
      }
      try {
        const claim = await claimTelegramBotTradingAutoSetup(db, {
          claimId: request.body.claimId,
          userId: user.id,
        });
        return reply.send({ claim, ok: true });
      } catch (error) {
        const code = error instanceof Error ? error.message : "claim_failed";
        const conflictCodes = new Set([
          "telegram_bot_trading_claim_held",
          "telegram_bot_trading_retry_wait",
          "telegram_link_generation_blocked",
        ]);
        reply.code(conflictCodes.has(code) ? 409 : 400);
        return reply.send({ error: code });
      }
    },
  );

  api.post(
    "/telegram/bot-trading/auto-setup/finalize",
    {
      preHandler: authPreHandler,
      schema: { body: setupFinalizeBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      try {
        const { claimId, ...body } = request.body;
        const status = await activateManagedTrading({
          body,
          request,
          setupClaimId: claimId,
          user,
        });
        return reply.send({ ok: true, status });
      } catch (error) {
        return sendEnableFailure(reply, error, {
          operation: "telegram-bot-trading-auto-setup-finalize",
          userId: user.id,
        });
      }
    },
  );

  api.post(
    "/telegram/bot-trading/auto-setup/fail",
    {
      preHandler: authPreHandler,
      schema: { body: setupFailBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      try {
        await failTelegramBotTradingSetupClaim(db, {
          blocked:
            request.body.errorCode ===
            "privy_server_signer_unsafe_configuration",
          claimId: request.body.claimId,
          errorCode: request.body.errorCode,
          userId: user.id,
        });
        return reply.send({ ok: true });
      } catch (error) {
        reply.code(409);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "telegram_bot_trading_claim_stale",
        });
      }
    },
  );

  api.post(
    "/telegram/bot-trading/disable",
    { preHandler: authPreHandler },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      await disableTelegramBotTradingForUser(db, user.id);
      return reply.send({ ok: true });
    },
  );

  api.post(
    "/telegram/bot-trading/unlink-cleanup",
    { preHandler: authPreHandler },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      await cleanupTelegramBotTradingForUnlink(db, user.id);
      return reply.send({ ok: true });
    },
  );
}

export function createTelegramBotTradingRoutes(
  dependencies: TelegramBotTradingRouteDependencies = {},
): FastifyPluginAsync {
  return (app) => registerTelegramBotTradingRoutes(app, dependencies);
}

export const telegramBotTradingRoutes = createTelegramBotTradingRoutes();

export const telegramBotTradingRouteTestHooks = {
  internalAccountBodySchema,
  internalFundingBackToMarketBodySchema,
  internalFundingCancelBodySchema,
  internalFundingConfirmBodySchema,
  internalFundingOpenBodySchema,
  internalFundingReviewBodySchema,
  internalFundingResumeBuyBodySchema,
  internalFundingSelectTargetBodySchema,
  internalFundingSessionBodySchema,
  internalMarketCardBodySchema,
  internalTradeInputBeginBodySchema,
  internalTradeInputCancelBodySchema,
  internalTradeInputCompleteBodySchema,
  internalTradeInputParamsSchema,
};
