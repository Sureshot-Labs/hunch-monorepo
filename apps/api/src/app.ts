import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { ZodError } from "zod";
import { onReqEnd, onReqStart } from "./metrics.js";
import { closeRedis } from "./redis.js";
import { registerRoutes } from "./routes/index.js";
import { enforceGlobalRateLimit } from "./lib/global-rate-limit.js";
import { flushPendingMarketRefreshes } from "./lib/market-refresh.js";
import { isRecord } from "./lib/type-guards.js";
import { env } from "./env.js";
import { pool } from "./db.js";
import { createApiTradingApplicationService } from "./services/api-trading-service.js";
import { reconcileTelegramVenueIntents } from "./services/telegram-bot-trading-venue-reconcile.js";

function sanitizeErrorEnvelope(
  payload: unknown,
  statusCode: number,
): Record<string, unknown> | unknown {
  if (!isRecord(payload)) return payload;
  const sanitized: Record<string, unknown> = { ...payload };
  delete sanitized.message;
  delete sanitized.stack;

  if (statusCode < 500) return sanitized;

  delete sanitized.details;
  delete sanitized.payload;
  delete sanitized.cause;
  if (
    typeof sanitized.error !== "string" ||
    sanitized.error.trim().length === 0
  ) {
    sanitized.error = "Internal server error";
  }
  return sanitized;
}

export async function buildApp() {
  const trustProxy = env.trustProxy
    ? env.trustProxyHops > 0
      ? env.trustProxyHops
      : true
    : false;
  const app = Fastify({
    logger: true,
    trustProxy,
  }).withTypeProvider<ZodTypeProvider>();
  let telegramVenueReconcileTimer: NodeJS.Timeout | null = null;
  let telegramVenueReconcileRun: Promise<unknown> | null = null;

  if (env.telegramVenueReconcileEnabled) {
    const runTelegramVenueReconcile = () => {
      if (telegramVenueReconcileRun) return;
      const trading = createApiTradingApplicationService({
        logger: app.log,
        pool,
      });
      telegramVenueReconcileRun = reconcileTelegramVenueIntents(pool, trading, {
        dryRun: false,
        limit: env.telegramVenueReconcileBatchSize,
      })
        .then((summary) => {
          app.log.info({ summary }, "Telegram venue reconcile sweep completed");
        })
        .catch((error) => {
          app.log.warn({ error }, "Telegram venue reconcile sweep failed");
        })
        .finally(() => {
          telegramVenueReconcileRun = null;
        });
    };
    telegramVenueReconcileTimer = setInterval(
      runTelegramVenueReconcile,
      env.telegramVenueReconcileIntervalSec * 1_000,
    );
    telegramVenueReconcileTimer.unref?.();
  }

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook("onRequest", async (req, _reply) => {
    req._t0 = onReqStart();
  });
  app.addHook("onRequest", async (req, reply) => {
    await enforceGlobalRateLimit(req, reply);
  });
  app.addHook("onResponse", async (req, _reply) => {
    if (req._t0 != null) onReqEnd(req._t0);
  });
  app.addHook("onClose", async () => {
    if (telegramVenueReconcileTimer) {
      clearInterval(telegramVenueReconcileTimer);
      telegramVenueReconcileTimer = null;
    }
    await telegramVenueReconcileRun;
    await flushPendingMarketRefreshes();
    await closeRedis();
  });

  app.addHook("preSerialization", async (_request, reply, payload) => {
    if (reply.statusCode < 400) return payload;
    return sanitizeErrorEnvelope(payload, reply.statusCode);
  });

  app.setErrorHandler((error, request, reply) => {
    const zodIssues =
      error instanceof ZodError
        ? error.issues
        : isRecord(error) && Array.isArray(error.issues)
          ? error.issues
          : null;

    if (zodIssues) {
      const message =
        isRecord(zodIssues[0]) && typeof zodIssues[0].message === "string"
          ? zodIssues[0].message
          : "Invalid request";
      reply.code(400).send({ error: message });
      return;
    }

    request.log.error({ error }, "Unhandled error");
    const rawStatusCode =
      isRecord(error) && typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    const statusCode =
      Number.isInteger(rawStatusCode) &&
      rawStatusCode >= 400 &&
      rawStatusCode <= 599
        ? rawStatusCode
        : 500;
    if (statusCode >= 500) {
      reply.code(statusCode).send({ error: "Internal server error" });
      return;
    }

    const message =
      error instanceof Error && error.message.trim().length > 0
        ? error.message
        : "Request failed";
    reply.code(statusCode).send({ error: message });
  });

  if (env.enableSwagger) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: "Hunch API",
          version: "0.1.0",
        },
      },
      transform: jsonSchemaTransform,
    });

    await app.register(swaggerUi, {
      routePrefix: "/docs",
    });

    app.get(
      "/openapi.json",
      {
        schema: {
          hide: true,
        },
      },
      async (_request, reply) => {
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(app.swagger());
      },
    );
  }

  await registerRoutes(app);

  return app;
}
