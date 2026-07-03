import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  TelegramInitDataValidationError,
  validateTelegramInitData,
} from "../lib/telegram-mini-app.js";
import { checkRateLimitForSecurityClientIp } from "../lib/request-ip.js";
import {
  telegramContextBodySchema,
  telegramContextErrorResponseSchema,
  telegramContextSuccessResponseSchema,
} from "../schemas/telegram.js";
import { env } from "../env.js";

export const telegramRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

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
};
