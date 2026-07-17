import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { createAuthMiddleware } from "../auth.js";
import { pool, type DbQuery } from "../db.js";
import { env } from "../env.js";
import { getRedis } from "../redis.js";
import { evaluateGeoFence, type GeoFenceConfig } from "../lib/geo-fence.js";
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
  disableTelegramBotTradingForUser,
  disableTelegramBotTradingForTelegramUser,
  enableTelegramBotTrading,
  getTelegramBotTradingStatus,
  reconcileStaleTelegramTradeIntents,
  resolveTelegramBotTradingWalletSetupIssues,
  resolveTelegramBotTradingPolicy,
  TelegramBotTradingEnableError,
  type TelegramBotTradingInternalWalletCandidate,
  type TelegramBotTradingWalletSetupIssue,
  type TelegramBotTradingVenue,
} from "../services/telegram-bot-trading.js";
import type { KalshiTradeEligibility } from "../services/trading-types.js";
import { searchTelegramMarkets } from "../services/telegram-market-search.js";
import { buildTelegramDepositMessage } from "../services/telegram-bot-deposit.js";
import { buildHunchMiniAppWebButton } from "../services/telegram-mini-app-buttons.js";
import {
  buildTelegramPositionsMessage,
  loadTelegramPositions,
} from "../services/telegram-bot-positions.js";

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
  searchMarkets?: typeof searchTelegramMarkets;
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
  const loadPositions = dependencies.loadPositions ?? loadTelegramPositions;
  const searchMarkets = dependencies.searchMarkets ?? searchTelegramMarkets;
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

  const requireInternal = async (
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
                  .map((market) => ({
                    eventId: market.eventId,
                    eventTitle: market.eventTitle,
                    lastPrice: market.yesMid,
                    marketId: market.marketId,
                    marketTitle:
                      market.marketTitle?.trim() || "Prediction market",
                    noAsk: market.noMid,
                    venue: market.venue,
                    yesAsk: market.yesAsk ?? market.yesMid,
                  }));
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
      let internalWallets:
        | TelegramBotTradingInternalWalletCandidate[]
        | null
        | undefined;
      if (venue === "limitless") {
        const { rows } = await db.query<{ privy_user_id: string }>(
          `select privy_user_id
             from user_telegram_accounts
            where telegram_user_id = $1
            limit 1`,
          [String(request.body.telegramUserId)],
        );
        const privyUserId = rows[0]?.privy_user_id ?? null;
        if (!privyUserId) {
          internalWallets = [];
        } else {
          try {
            internalWallets = await resolveInternalWallets({
              app,
              privyUserId,
            });
          } catch {
            internalWallets = null;
          }
        }
      }
      return buildDepositMessage({
        appBaseUrl: request.body.appBaseUrl,
        internalWallets,
        pool: db,
        telegramMiniAppEnabled: request.body.telegramMiniAppEnabled,
        telegramUserId: request.body.telegramUserId,
        venue: request.body.venue,
      });
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
                  text: "Back to positions",
                },
              ],
            ],
          },
          text: "Position details are temporarily unavailable\\. The holding remains visible in My positions\\.",
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
            `${position.position.size.toFixed(4)} shares · Avg ${average}`,
            `Live bid ${bid} · PnL ${pnl}`,
            ...(settlementLine ? [settlementLine] : []),
            ...(walletSuffix ? [`Wallet …${walletSuffix}`] : []),
          ],
          positionRedemptionStatus: position.redemptionStatus,
          returnCallbackData: "hm:v1:positions",
        },
        db,
        marketRef: position.marketId,
        telegramMiniAppEnabled: request.body.telegramMiniAppEnabled,
        telegramUserId: request.body.telegramUserId,
        trading: createTradingForRequest(request),
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
            text: `${message.text}\n\nRequired API and finance reconciliation: disabled\\. Trading confirmation is unavailable\\.`,
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
        text: "Trading is temporarily unavailable\\. Open Hunch to trade\\.",
      };
    },
  );

  const handleInternalCallback = async (
    request: {
      body: z.infer<typeof internalCallbackBodySchema>;
      params?: z.infer<typeof internalIntentParamsSchema>;
    },
    expectedType?: "buy" | "sell" | "redeem" | "cancel" | "confirm",
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
      signerInspector,
      telegramMiniAppEnabled: request.body.telegramMiniAppEnabled,
      trading: createTradingForRequest(request as FastifyRequest),
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
      signerInspector,
      telegramMiniAppEnabled: request.body.telegramMiniAppEnabled,
      trading: createTradingForRequest(request as FastifyRequest),
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
                  'messageId', $4::bigint
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
      const [policy, status] = await Promise.all([
        resolveTelegramBotTradingPolicy(db),
        telegramUserId
          ? getTelegramBotTradingStatus(
              db,
              telegramUserId,
              createTradingForRequest(request),
              signerInspector,
            )
          : Promise.resolve(null),
      ]);
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
            privyUserId: user.privyUserId ?? null,
            setupIssue: "Telegram is not linked to this Hunch account.",
            telegramUserId,
            userId: user.id,
          });
      const signerWallets = [...baseStatusPayload.signerWallets];
      const knownWallets = new Set(
        signerWallets.map(
          (wallet) =>
            `${wallet.privyWalletId}:${wallet.walletAddress.toLowerCase()}`,
        ),
      );
      for (const wallet of internalWallets) {
        if (wallet.walletChain !== "ethereum") continue;
        const key = `${wallet.privyWalletId}:${wallet.walletAddress.toLowerCase()}`;
        if (knownWallets.has(key)) continue;
        signerWallets.push({
          privyWalletId: wallet.privyWalletId,
          signerStatus: await signerInspector({
            authorizationEnabled: false,
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
        const disableAll = body.enabledVenues?.length === 0;
        if (!disableAll && !reconciliationEnabled) {
          reply.code(503);
          return reply.send({
            error: "telegram_venue_reconcile_required",
            message:
              "Telegram bot trading cannot be enabled until API and finance reconciliation are enabled.",
          });
        }
        const internalWallets = disableAll
          ? []
          : await resolveInternalWallets({
              app,
              privyUserId: user.privyUserId,
            });
        const status = await enableTelegramBotTrading(
          db,
          {
            buildKalshiEligibilityForWallet: (walletAddress) =>
              buildKalshiEligibilityForRequest({
                geoFenceConfig: kalshiGeoFenceConfig,
                request,
                user,
                walletAddress,
              }),
            enabledVenues: body.enabledVenues as
              | TelegramBotTradingVenue[]
              | undefined,
            internalWallets,
            maxAmountUsd: body.maxAmountUsd ?? null,
            preferredWalletAddress: body.walletAddress ?? null,
            privyWalletId: body.privyWalletId ?? null,
            signerInspector,
            userId: user.id,
          },
          createTradingForRequest(request),
        );
        return reply.send({ ok: true, status });
      } catch (error) {
        if (error instanceof TelegramBotTradingEnableError) {
          reply.code(error.statusCode);
          return reply.send({
            error: error.code,
            grants: error.grants,
            message: error.message,
            walletSetupIssues: error.walletSetupIssues,
          });
        }
        app.log.error(
          {
            err: error,
            operation: "telegram-bot-trading-enable",
            userId: user.id,
          },
          "Telegram bot trading enable failed unexpectedly",
        );
        const message =
          error instanceof Error &&
          error.message === "telegram_account_required"
            ? "Telegram account is required before enabling bot trading."
            : error instanceof Error &&
                error.message === "internal_trading_wallet_required"
              ? "Create an internal Hunch Trading Wallet before enabling Telegram bot trading."
              : error instanceof Error &&
                  error.message === "no_compatible_venues_for_wallet"
                ? "No compatible bot trading venues are enabled."
                : "Unable to enable Telegram bot trading.";
        reply.code(400);
        return reply.send({
          error: "telegram_bot_trading_enable_failed",
          message,
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
}

export function createTelegramBotTradingRoutes(
  dependencies: TelegramBotTradingRouteDependencies = {},
): FastifyPluginAsync {
  return (app) => registerTelegramBotTradingRoutes(app, dependencies);
}

export const telegramBotTradingRoutes = createTelegramBotTradingRoutes();
