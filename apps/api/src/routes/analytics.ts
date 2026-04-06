import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { createAdminMiddleware, createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import {
  analyticsForwardBodySchema,
  analyticsForwardResponseSchema,
  analyticsForwardTelemetryResponseSchema,
} from "../schemas/analytics.js";
import {
  fetchAnalyticsForwardingTelemetry,
  ingestForwardedAnalyticsEvent,
} from "../services/analytics-forwarding.js";

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  z.post(
    "/analytics/collector",
    {
      preHandler: createAuthMiddleware({ optional: true }),
      schema: {
        body: analyticsForwardBodySchema,
        response: {
          200: analyticsForwardResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await ingestForwardedAnalyticsEvent(pool, {
        event: request.body.event,
        payload: request.body.payload,
        userId: request.user?.id ?? null,
      });

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        ...result,
      });
    },
  );

  z.get(
    "/analytics/collector/telemetry",
    {
      preHandler: createAdminMiddleware(),
      schema: {
        response: {
          200: analyticsForwardTelemetryResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const telemetry = await fetchAnalyticsForwardingTelemetry(pool);
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        enabled: env.analyticsServerForwardingEnabled,
        ...telemetry,
      });
    },
  );
};
