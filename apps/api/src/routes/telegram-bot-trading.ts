import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import {
  evaluateGeoFence,
  type GeoFenceConfig,
} from "../lib/geo-fence.js";
import { PrivyService } from "../privy-service.js";
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
  resolveTelegramBotTradingPolicy,
  type TelegramBotTradingVenue,
} from "../services/telegram-bot-trading.js";
import type { KalshiTradeEligibility } from "../services/trading-types.js";

const enableBodySchema = z
  .object({
    enabledVenues: z
      .array(z.enum(["polymarket", "limitless", "kalshi"]))
      .optional(),
    privyWalletId: z.string().trim().min(1).max(256).optional().nullable(),
    walletAddress: z.string().trim().min(1),
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
              .object({ id: z.union([z.string(), z.number()]) })
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

function walletAddressMatches(input: {
  walletAddress: string;
  walletType: "ethereum" | "solana";
  selectedAddress: string;
}): boolean {
  if (input.walletType === "ethereum") {
    return (
      input.walletAddress.trim().toLowerCase() ===
      input.selectedAddress.trim().toLowerCase()
    );
  }
  return input.walletAddress.trim() === input.selectedAddress.trim();
}

async function resolvePrivyWalletIdForAddress(input: {
  app: Parameters<FastifyPluginAsync>[0];
  privyUserId: string | null | undefined;
  walletAddress: string;
}): Promise<string | null> {
  if (!input.privyUserId) return null;
  try {
    const privyUser = await PrivyService.getUserById(input.privyUserId);
    const walletProfiles = PrivyService.classifyWallets(privyUser);
    const wallet = walletProfiles.find((profile) =>
      walletAddressMatches({
        selectedAddress: input.walletAddress,
        walletAddress: profile.address,
        walletType: profile.walletType,
      }),
    );
    if (wallet && !wallet.isInternalWallet) return null;
    return wallet?.walletId?.trim() || null;
  } catch (error) {
    input.app.log.warn(
      { err: error },
      "Failed to resolve Privy wallet id for Telegram bot trading",
    );
    return null;
  }
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
        status: status ?? {
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
        },
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
        const privyWalletId = await resolvePrivyWalletIdForAddress({
          app,
          privyUserId: user.privyUserId,
          walletAddress: body.walletAddress,
        });
        if (!privyWalletId) {
          reply.code(409);
          return reply.send({
            error: "privy_wallet_id_required",
            message:
              "Selected wallet must be an internal Privy trading wallet before bot trading can be enabled.",
          });
        }
        const kalshiEligibility = await buildKalshiEligibilityForRequest({
          geoFenceConfig: kalshiGeoFenceConfig,
          request,
          user,
          walletAddress: body.walletAddress,
        });
        const status = await enableTelegramBotTrading(pool, {
          enabledVenues: body.enabledVenues as
            | TelegramBotTradingVenue[]
            | undefined,
          kalshiEligibility,
          privyWalletId,
          userId: user.id,
          walletAddress: body.walletAddress,
        }, createTradingForRequest(request));
        return reply.send({ ok: true, status });
      } catch (error) {
        const message =
          error instanceof Error && error.message === "telegram_account_required"
            ? "Telegram account is required before enabling bot trading."
            : error instanceof Error &&
                error.message === "privy_wallet_id_required"
              ? "Selected wallet must be an internal Privy trading wallet before bot trading can be enabled."
            : error instanceof Error &&
                error.message === "no_compatible_venues_for_wallet"
              ? "Selected wallet is not compatible with any enabled bot trading venue."
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
