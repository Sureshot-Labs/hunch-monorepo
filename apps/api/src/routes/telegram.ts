import type { FastifyPluginAsync } from "fastify";
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
  telegramGroupMembershipResponseSchema,
} from "../schemas/telegram.js";
import {
  checkTelegramGroupMembership,
  type TelegramGroupMembershipResult,
} from "../services/telegram-group-membership.js";

export type TelegramRoutesDependencies = {
  authPreHandler?: ReturnType<typeof createAuthMiddleware>;
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
        },
      },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
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

      reply.header("Cache-Control", "private, no-store");
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        cached: result.cached,
        checkedAt: result.checkedAt,
        state: result.state,
      });
    },
  );
}

export function createTelegramRoutes(
  dependencies: TelegramRoutesDependencies = {},
): FastifyPluginAsync {
  return (app) => registerTelegramRoutes(app, dependencies);
}

export const telegramRoutes = createTelegramRoutes();
