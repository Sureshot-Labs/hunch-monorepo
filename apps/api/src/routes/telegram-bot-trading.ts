import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { createAuthMiddleware } from "../auth.js";
import { pool, type DbQuery } from "../db.js";
import { env } from "../env.js";
import {
  evaluateGeoFence,
  type GeoFenceConfig,
} from "../lib/geo-fence.js";
import {
  PrivyService,
  type PrivyWalletProfile,
} from "../privy-service.js";
import { createApiTradingApplicationService } from "../services/api-trading-service.js";
import { verifyProofAddress } from "../services/proof-client.js";
import {
  buildTelegramBotTradingMarketMessage,
  buildTelegramBotTradingStatusMessage,
  captureTelegramBotTradingCallback,
  disableTelegramBotTradingForUser,
  disableTelegramBotTradingForTelegramUser,
  enableTelegramBotTrading,
  getTelegramBotTradingStatus,
  resolveTelegramBotTradingWalletSetupIssues,
  resolveTelegramBotTradingPolicy,
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

export const telegramBotTradingRoutes: FastifyPluginAsync = async (app) => {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const kalshiGeoFenceConfig: GeoFenceConfig = {
    enabled: env.dflowGeoBlockEnabled,
    blockedCountries: env.dflowGeoBlockCountries,
    defaultPolicy: env.dflowGeoBlockDefault,
    trustProxy: env.trustProxy,
    proxySecret: env.proxySecret,
  };
  const createTradingForRequest = (_request: FastifyRequest) => {
    return createApiTradingApplicationService({
      logger: app.log,
      pool,
    });
  };

  const requireInternal = async (
    request: { headers: Record<string, unknown> },
    reply: { code: (statusCode: number) => unknown; send: (body: unknown) => unknown },
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
    async (request) =>
      buildTelegramBotTradingStatusMessage(
        pool,
        request.body.telegramUserId,
        createTradingForRequest(request),
      ),
  );

  api.post(
    "/internal/telegram-bot/trading/disable",
    {
      preHandler: requireInternal,
      schema: { body: internalDisableBodySchema },
    },
    async (request) => {
      const disabled = await disableTelegramBotTradingForTelegramUser(
        pool,
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
      buildTelegramBotTradingMarketMessage({
        appBaseUrl: request.body.appBaseUrl,
        chatId: request.body.chatId,
        db: pool,
        isAdminTest: request.body.isAdminTest,
        marketRef: request.body.marketRef,
        telegramMessageId: request.body.telegramMessageId,
        telegramUserId: request.body.telegramUserId,
        trading: createTradingForRequest(request),
      }),
  );

  const handleInternalCallback = async (request: {
    body: z.infer<typeof internalCallbackBodySchema>;
    params?: z.infer<typeof internalIntentParamsSchema>;
  }, expectedType?: "buy" | "cancel" | "confirm") =>
    captureTelegramBotTradingCallback({
      appBaseUrl: request.body.appBaseUrl,
      callbackQuery: request.body.callbackQuery,
      db: pool,
      expectedIntentId: request.params?.id ?? null,
      expectedType: expectedType ?? null,
      trading: createTradingForRequest(request as FastifyRequest),
    });

  const handleInternalPreviewCallback = async (request: {
    body: z.infer<typeof internalCallbackBodySchema>;
  }) =>
    captureTelegramBotTradingCallback({
      appBaseUrl: request.body.appBaseUrl,
      callbackQuery: request.body.callbackQuery,
      db: pool,
      expectedType: "buy",
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
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      const telegramResult = await pool.query<{
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
        resolveTelegramBotTradingPolicy(pool),
        telegramUserId
          ? getTelegramBotTradingStatus(
              pool,
              telegramUserId,
              createTradingForRequest(request),
            )
          : Promise.resolve(null),
      ]);
      let walletSetupIssues =
        status?.linked && status.userId
          ? status.walletSetupIssues
          : [];
      if (status?.linked && status.userId) {
        walletSetupIssues =
          await resolveTelegramBotTradingStatusWalletSetupIssues({
            app,
            db: pool,
            privyUserId: user.privyUserId,
            requestedVenues: policy.tradingVenues,
            userId: status.userId,
          });
      }
      const statusPayload = status
        ? {
            ...status,
            walletSetupIssues,
          }
        : {
            authorizationId: null,
            activeAuthorization: null,
            authorizations: [],
            directExecutionReady: false,
            enabled: false,
            enabledVenues: [],
            linked: false,
            maxAmountUsd: null,
            privyUserId: user.privyUserId ?? null,
            privyWalletId: null,
            setupIssue: "Telegram is not linked to this Hunch account.",
            telegramUserId,
            username: null,
            userId: user.id,
            walletAddress: null,
            walletChain: null,
            walletSetupIssues: [],
          };
      return reply.send({
        policy: {
          tradingEnabled: policy.tradingEnabled,
          tradingActions: policy.tradingActions,
          tradingVenues: policy.tradingVenues,
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
      preHandler: createAuthMiddleware(),
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
        const internalWallets = await resolveInternalPrivyWalletCandidates({
          app,
          privyUserId: user.privyUserId,
        });
        const status = await enableTelegramBotTrading(pool, {
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
          preferredWalletAddress: body.walletAddress ?? null,
          userId: user.id,
        }, createTradingForRequest(request));
        return reply.send({ ok: true, status });
      } catch (error) {
        const message =
          error instanceof Error && error.message === "telegram_account_required"
            ? "Telegram account is required before enabling bot trading."
            : error instanceof Error &&
                error.message === "internal_trading_wallet_required"
              ? "Create an internal Hunch Trading Wallet before enabling Telegram bot trading."
            : error instanceof Error &&
                error.message === "no_compatible_venues_for_wallet"
              ? "No compatible bot trading venues are enabled."
            : "Unable to enable Telegram bot trading.";
        reply.code(400);
        return reply.send({ error: "telegram_bot_trading_enable_failed", message });
      }
    },
  );

  api.post(
    "/telegram/bot-trading/disable",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      await disableTelegramBotTradingForUser(pool, user.id);
      return reply.send({ ok: true });
    },
  );
};
