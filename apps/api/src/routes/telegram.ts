import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import {
  TelegramInitDataValidationError,
  validateTelegramInitData,
} from "../lib/telegram-mini-app.js";
import { checkRateLimitForSecurityClientIp } from "../lib/request-ip.js";
import { getRedis } from "../redis.js";
import { authErrorResponseSchema } from "../schemas/auth.js";
import {
  telegramContextBodySchema,
  telegramContextErrorResponseSchema,
  telegramContextSuccessResponseSchema,
  telegramAppHandoffCommitRequestSchema,
  telegramAppHandoffProjectionResponseSchema,
  telegramAppHandoffRequestSchema,
  telegramAppHandoffResponseSchema,
  telegramGroupMembershipResponseSchema,
} from "../schemas/telegram.js";
import {
  checkTelegramGroupMembership,
  type TelegramGroupMembershipResult,
} from "../services/telegram-group-membership.js";
import {
  cancelTelegramAppHandoff,
  claimTelegramAppHandoff,
  commitTelegramAppHandoff,
  parseTelegramAppHandoffStartParam,
  resolveTelegramAppHandoff,
  TelegramAppHandoffError,
  type TelegramAppHandoff,
} from "../services/telegram-app-handoff.js";
import { resolveActiveTelegramAccountLink } from "../services/telegram-account-link.js";
import {
  executeCommittedTelegramAppHandoff,
  isTelegramSealedAppHandoffVenue,
  loadTelegramAppHandoffProjection,
  resolveTelegramAppHandoffCurrentScope,
  telegramVenueFromSealedHandoffSnapshot,
} from "../services/telegram-bot-trading.js";
import { createApiTradingApplicationService } from "../services/api-trading-service.js";
import { inspectServerEvmWalletAuthorization } from "../services/api-trading-wallet-signing.js";

export type TelegramRoutesDependencies = {
  authPreHandler?: ReturnType<typeof createAuthMiddleware>;
  checkMembershipRateLimit?: (
    request: FastifyRequest,
    userId: string,
  ) => Promise<boolean>;
  checkGroupMembership?: (
    userId: string,
  ) => Promise<TelegramGroupMembershipResult>;
};

async function registerTelegramRoutes(
  app: Parameters<FastifyPluginAsync>[0],
  dependencies: TelegramRoutesDependencies,
): Promise<void> {
  const z = app.withTypeProvider<ZodTypeProvider>();
  const authPreHandler = dependencies.authPreHandler ?? createAuthMiddleware();
  const checkMembershipRateLimit =
    dependencies.checkMembershipRateLimit ??
    (async (request: FastifyRequest, userId: string) => {
      const result = await checkRateLimitForSecurityClientIp(request, {
        keyPrefix: `telegram:membership:${userId}`,
        maxRequests: 10,
        windowMs: 60_000,
        onError: "fail_closed",
      });
      return result.allowed;
    });
  const checkGroupMembership =
    dependencies.checkGroupMembership ??
    (async (userId: string) =>
      checkTelegramGroupMembership({
        botToken: env.telegramBotToken,
        chatId: env.telegramMembershipChatId,
        db: pool,
        expectedBotId: env.telegramMembershipBotId,
        redis: await getRedis(),
        userId,
      }));

  const resolveHandoffIdentity = async (
    request: FastifyRequest,
    reply: FastifyReply,
    initDataRaw: string,
    token: string,
  ): Promise<{ telegramUserId: string; userId: string } | null> => {
    const user = request.user;
    if (!user) {
      reply.code(401).send({ error: "Unauthorized" });
      return null;
    }
    if (!env.telegramMiniAppEnabled || !env.telegramBotToken) {
      reply.code(404).send({ error: "telegram_mini_app_disabled" });
      return null;
    }
    try {
      const context = validateTelegramInitData(initDataRaw, {
        botToken: env.telegramBotToken,
        initDataMaxAgeSeconds: env.telegramInitDataMaxAgeSeconds,
      });
      const link = await resolveActiveTelegramAccountLink({
        db: pool,
        telegramUserId: context.user.id,
      });
      if (!link || link.userId !== user.id) {
        reply.code(403).send({ error: "telegram_handoff_identity_mismatch" });
        return null;
      }
      if (parseTelegramAppHandoffStartParam(context.startParam) !== token) {
        reply
          .code(403)
          .send({ error: "telegram_handoff_start_param_mismatch" });
        return null;
      }
      return { telegramUserId: context.user.id, userId: user.id };
    } catch (error) {
      request.log.warn(
        {
          reason:
            error instanceof TelegramInitDataValidationError
              ? error.code
              : "unexpected_error",
          userId: user.id,
        },
        "Telegram app handoff identity validation failed",
      );
      reply.code(400).send({ error: "invalid_telegram_init_data" });
      return null;
    }
  };

  const sendHandoffError = (reply: FastifyReply, error: unknown) => {
    if (!(error instanceof TelegramAppHandoffError)) {
      return reply
        .code(503)
        .send({ error: "telegram_app_handoff_unavailable" });
    }
    if (
      error.code === "invalid_token" ||
      error.code === "not_found" ||
      error.code === "unauthorized"
    ) {
      return reply.code(404).send({ error: "telegram_app_handoff_not_found" });
    }
    return reply.code(409).send({ error: error.code });
  };

  const sendHandoffResponse = async (
    reply: FastifyReply,
    operation: () => Promise<TelegramAppHandoff>,
  ) => {
    try {
      const handoff = await operation();
      reply.header("Cache-Control", "private, no-store");
      return reply.send({ handoff });
    } catch (error) {
      return sendHandoffError(reply, error);
    }
  };

  const telegramAppHandoffResponses = {
    200: telegramAppHandoffResponseSchema,
    400: telegramContextErrorResponseSchema,
    401: authErrorResponseSchema,
    403: telegramContextErrorResponseSchema,
    404: telegramContextErrorResponseSchema,
    409: telegramContextErrorResponseSchema,
    503: telegramContextErrorResponseSchema,
  };

  z.post(
    "/telegram/context",
    {
      onRequest: async (_request, reply) => {
        if (!env.telegramMiniAppEnabled) {
          reply.code(404);
          return reply.send({ error: "telegram_mini_app_disabled" });
        }
      },
      schema: {
        body: telegramContextBodySchema,
        response: {
          200: telegramContextSuccessResponseSchema,
          400: telegramContextErrorResponseSchema,
          404: telegramContextErrorResponseSchema,
          413: telegramContextErrorResponseSchema,
          429: telegramContextErrorResponseSchema,
          503: telegramContextErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!env.telegramMiniAppEnabled) {
        reply.code(404);
        return reply.send({ error: "telegram_mini_app_disabled" });
      }

      if (!env.telegramBotToken) {
        request.log.error(
          { configured: false },
          "Telegram Mini App bot token is not configured",
        );
        reply.code(503);
        return reply.send({ error: "telegram_mini_app_unconfigured" });
      }

      const rateLimit = await checkRateLimitForSecurityClientIp(request, {
        keyPrefix: "telegram:context",
        maxRequests: 30,
        windowMs: 60_000,
        onError: "fail_closed",
      });
      if (!rateLimit.allowed) {
        reply.code(429);
        return reply.send({ error: "Rate limit exceeded" });
      }

      try {
        const context = validateTelegramInitData(request.body.initDataRaw, {
          botToken: env.telegramBotToken,
          initDataMaxAgeSeconds: env.telegramInitDataMaxAgeSeconds,
        });

        request.log.info(
          {
            clientIp: rateLimit.clientIp,
            hasStartParam: Boolean(context.startParam),
          },
          "Telegram Mini App context validated",
        );

        reply.header("Cache-Control", "no-store");
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          telegram: {
            authDate: context.authDate.toISOString(),
            startParam: context.startParam ?? undefined,
            user: context.user,
          },
        });
      } catch (error) {
        if (error instanceof TelegramInitDataValidationError) {
          request.log.warn(
            {
              clientIp: rateLimit.clientIp,
              reason: error.code,
            },
            "Telegram Mini App context validation failed",
          );
          reply.code(error.code === "oversized_init_data" ? 413 : 400);
          return reply.send({
            error: "invalid_telegram_init_data",
            reason: error.code,
          });
        }

        request.log.error({ error }, "Telegram Mini App validation failed");
        reply.code(503);
        return reply.send({ error: "telegram_mini_app_unavailable" });
      }
    },
  );

  z.get(
    "/telegram/membership",
    {
      preHandler: authPreHandler,
      schema: {
        response: {
          200: telegramGroupMembershipResponseSchema,
          401: authErrorResponseSchema,
          429: authErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      reply.header("Cache-Control", "private, no-store");

      let rateLimitAllowed = false;
      try {
        rateLimitAllowed = await checkMembershipRateLimit(request, user.id);
      } catch (error) {
        request.log.error(
          { error },
          "Telegram group membership rate limit check failed",
        );
      }
      if (!rateLimitAllowed) {
        reply.code(429);
        return reply.send({ error: "Rate limit exceeded" });
      }

      let result: TelegramGroupMembershipResult;
      try {
        result = await checkGroupMembership(user.id);
      } catch (error) {
        request.log.error(
          { error },
          "Unexpected Telegram group membership check failure",
        );
        result = {
          cached: false,
          checkedAt: new Date().toISOString(),
          state: "unavailable",
        };
      }

      if (result.state === "unavailable") {
        request.log.warn(
          { reason: result.unavailableReason ?? "unexpected_error" },
          "Telegram group membership is unavailable",
        );
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        cached: result.cached,
        checkedAt: result.checkedAt,
        state: result.state,
      });
    },
  );

  for (const [path, action] of [
    ["/telegram/app-handoffs/resolve", "resolve"],
    ["/telegram/app-handoffs/claim", "claim"],
    ["/telegram/app-handoffs/cancel", "cancel"],
  ] as const) {
    z.post(
      path,
      {
        preHandler: authPreHandler,
        schema: {
          body: telegramAppHandoffRequestSchema,
          response: telegramAppHandoffResponses,
        },
      },
      async (request, reply) => {
        const identity = await resolveHandoffIdentity(
          request,
          reply,
          request.body.initDataRaw,
          request.body.token,
        );
        if (!identity) return;
        return sendHandoffResponse(reply, async () =>
          action === "resolve"
            ? resolveTelegramAppHandoff({
                db: pool,
                telegramUserId: identity.telegramUserId,
                token: request.body.token,
                userId: identity.userId,
              })
            : action === "claim"
              ? claimTelegramAppHandoff({
                  db: pool,
                  telegramUserId: identity.telegramUserId,
                  token: request.body.token,
                  userId: identity.userId,
                })
              : cancelTelegramAppHandoff({
                  db: pool,
                  telegramUserId: identity.telegramUserId,
                  token: request.body.token,
                  userId: identity.userId,
                }),
        );
      },
    );
  }

  z.post(
    "/telegram/app-handoffs/commit",
    {
      preHandler: authPreHandler,
      schema: {
        body: telegramAppHandoffCommitRequestSchema,
        response: telegramAppHandoffResponses,
      },
    },
    async (request, reply) => {
      const identity = await resolveHandoffIdentity(
        request,
        reply,
        request.body.initDataRaw,
        request.body.token,
      );
      if (!identity) return;
      return sendHandoffResponse(reply, async () => {
        const handoff = await resolveTelegramAppHandoff({
          db: pool,
          telegramUserId: identity.telegramUserId,
          token: request.body.token,
          userId: identity.userId,
        });
        const venue = telegramVenueFromSealedHandoffSnapshot(
          handoff.planSnapshot,
        );
        if (!venue || !isTelegramSealedAppHandoffVenue(venue)) {
          throw new TelegramAppHandoffError("venue_unsupported");
        }
        const scope = await resolveTelegramAppHandoffCurrentScope({
          db: pool,
          telegramUserId: identity.telegramUserId,
          venue,
        });
        if (!scope) {
          throw new TelegramAppHandoffError("policy_changed");
        }
        return commitTelegramAppHandoff({
          currentAuthorityFingerprint: scope.authorityFingerprint,
          currentPolicyRevision: scope.policyRevision,
          db: pool,
          planFingerprint: request.body.planFingerprint,
          telegramUserId: identity.telegramUserId,
          token: request.body.token,
          userId: identity.userId,
        });
      });
    },
  );

  z.post(
    "/telegram/app-handoffs/projection",
    {
      preHandler: authPreHandler,
      schema: {
        body: telegramAppHandoffRequestSchema,
        response: {
          ...telegramAppHandoffResponses,
          200: telegramAppHandoffProjectionResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const identity = await resolveHandoffIdentity(
        request,
        reply,
        request.body.initDataRaw,
        request.body.token,
      );
      if (!identity) return;
      try {
        const handoff = await resolveTelegramAppHandoff({
          db: pool,
          telegramUserId: identity.telegramUserId,
          token: request.body.token,
          userId: identity.userId,
        });
        const projection = await loadTelegramAppHandoffProjection(pool, {
          telegramUserId: identity.telegramUserId,
          tradeIntentId: handoff.tradeIntentId,
          userId: identity.userId,
        });
        if (!projection) {
          return reply
            .code(404)
            .send({ error: "telegram_app_handoff_not_found" });
        }
        reply.header("Cache-Control", "private, no-store");
        return reply.send({ projection });
      } catch (error) {
        return sendHandoffError(reply, error);
      }
    },
  );

  z.post(
    "/telegram/app-handoffs/execute",
    {
      preHandler: authPreHandler,
      schema: {
        body: telegramAppHandoffRequestSchema,
        response: {
          ...telegramAppHandoffResponses,
          200: telegramAppHandoffProjectionResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const identity = await resolveHandoffIdentity(
        request,
        reply,
        request.body.initDataRaw,
        request.body.token,
      );
      if (!identity) return;
      if (
        !env.financeTelegramTradeIntentsEnabled ||
        !env.telegramVenueReconcileEnabled
      ) {
        return reply
          .code(503)
          .send({ error: "telegram_app_handoff_execution_unavailable" });
      }
      try {
        const handoff = await resolveTelegramAppHandoff({
          db: pool,
          telegramUserId: identity.telegramUserId,
          token: request.body.token,
          userId: identity.userId,
        });
        if (handoff.state !== "committed") {
          throw new TelegramAppHandoffError("not_committable");
        }
        const venue = telegramVenueFromSealedHandoffSnapshot(
          handoff.planSnapshot,
        );
        if (!venue || !isTelegramSealedAppHandoffVenue(venue)) {
          throw new TelegramAppHandoffError("venue_unsupported");
        }
        const scope = await resolveTelegramAppHandoffCurrentScope({
          db: pool,
          telegramUserId: identity.telegramUserId,
          venue,
        });
        if (
          !scope ||
          scope.policyRevision !== handoff.policyRevision ||
          scope.authorityFingerprint !== handoff.authorityFingerprint
        ) {
          throw new TelegramAppHandoffError("policy_changed");
        }
        const projection = await executeCommittedTelegramAppHandoff({
          appBaseUrl: "https://app.hunch.trade",
          db: pool,
          log: request.log,
          signerInspector: inspectServerEvmWalletAuthorization,
          telegramUserId: identity.telegramUserId,
          tradeIntentId: handoff.tradeIntentId,
          trading: createApiTradingApplicationService({
            logger: request.log,
            pool,
          }),
          userId: identity.userId,
        });
        if (!projection) {
          return reply
            .code(404)
            .send({ error: "telegram_app_handoff_not_found" });
        }
        reply.header("Cache-Control", "private, no-store");
        return reply.send({ projection });
      } catch (error) {
        return sendHandoffError(reply, error);
      }
    },
  );
}

export function createTelegramRoutes(
  dependencies: TelegramRoutesDependencies = {},
): FastifyPluginAsync {
  return (app) => registerTelegramRoutes(app, dependencies);
}

export const telegramRoutes = createTelegramRoutes();
