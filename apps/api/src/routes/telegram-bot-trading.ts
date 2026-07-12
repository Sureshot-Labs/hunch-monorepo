import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { createAuthMiddleware } from "../auth.js";
import { pool, type DbQuery } from "../db.js";
import { env } from "../env.js";
import { evaluateGeoFence, type GeoFenceConfig } from "../lib/geo-fence.js";
import { PrivyService, type PrivyWalletProfile } from "../privy-service.js";
import {
  createApiTradingApplicationService,
  type ApiBotTradingExecutor,
} from "../services/api-trading-service.js";
import { inspectServerEvmWalletAuthorization } from "../services/api-trading-wallet-signing.js";
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
    telegramMessageId: z.number().int().optional().nullable(),
    telegramUserId: z.union([z.string(), z.number()]),
  })
  .strict();

const internalStatusBodySchema = z
  .object({
    telegramUserId: z.union([z.string(), z.number()]),
  })
  .strict();

const internalDisableBodySchema = z
  .object({
    telegramUserId: z.union([z.string(), z.number()]),
  })
  .strict();

const internalCallbackBodySchema = z
  .object({
    appBaseUrl: z.string().trim().min(1),
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
};

async function registerTelegramBotTradingRoutes(
  app: Parameters<FastifyPluginAsync>[0],
  dependencies: TelegramBotTradingRouteDependencies,
): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = dependencies.db ?? pool;
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
    async (request) =>
      reconciliationEnabled
        ? buildTelegramBotTradingMarketMessage({
            appBaseUrl: request.body.appBaseUrl,
            chatId: request.body.chatId,
            db,
            isAdminTest: request.body.isAdminTest,
            marketRef: request.body.marketRef,
            telegramMessageId: request.body.telegramMessageId,
            telegramUserId: request.body.telegramUserId,
            trading: createTradingForRequest(request),
          })
        : {
            parse_mode: "MarkdownV2" as const,
            reply_markup: {
              inline_keyboard: [
                [{ text: "Open in Hunch", url: request.body.appBaseUrl }],
              ],
            },
            text: "Trading is temporarily unavailable\\. Open Hunch to trade\\.",
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
              sellConfigured: Boolean(env.privyPolymarketBotSellPolicyId),
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
