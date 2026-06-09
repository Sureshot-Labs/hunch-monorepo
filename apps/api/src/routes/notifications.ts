import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../repos/notifications-repo.js";
import { subscribeToNotifications } from "../lib/notifications-stream-manager.js";
import { getRedisStatus } from "../redis.js";
import {
  buildNotificationPayload,
  buildRedemptionNotification,
  createNotificationSafe,
} from "../services/notifications.js";
import {
  notificationReadParamsSchema,
  notificationRedemptionSchema,
  notificationsQuerySchema,
} from "../schemas/notifications.js";

export const notificationsRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  z.get(
    "/notifications",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: notificationsQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;
      const result = await fetchNotifications(pool, {
        userId: user.id,
        limit: query.limit,
        cursor: query.cursor,
        unreadOnly: query.unreadOnly ?? false,
      });

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        items: result.rows.map(buildNotificationPayload),
        nextCursor: result.nextCursor,
      });
    },
  );

  z.post(
    "/notifications/:id/read",
    {
      preHandler: createAuthMiddleware(),
      schema: { params: notificationReadParamsSchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const updated = await markNotificationRead(pool, {
        userId: user.id,
        id: request.params.id,
      });

      if (!updated) {
        reply.code(404);
        return reply.send({ error: "Notification not found" });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true });
    },
  );

  z.post(
    "/notifications/read-all",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const count = await markAllNotificationsRead(pool, {
        userId: user.id,
      });

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, updated: count });
    },
  );

  z.post(
    "/notifications/redemption",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: notificationRedemptionSchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const payload = request.body;
      const created = await createNotificationSafe(
        pool,
        buildRedemptionNotification({
          userId: user.id,
          venue: payload.venue,
          amountUsd: payload.amountUsd ?? null,
          marketId: payload.marketId ?? null,
          tokenId: payload.tokenId ?? null,
          txHash: payload.txHash ?? null,
          walletAddress: payload.walletAddress ?? null,
        }),
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, created: Boolean(created) });
    },
  );

  z.get(
    "/notifications/stream",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const { redis, status } = await getRedisStatus();
      if (!redis) {
        reply.code(503);
        return reply.send({
          error:
            status === "loading" ? "Redis loading, retry" : "Redis unavailable",
        });
      }

      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.flushHeaders();

      let writable = true;
      const send = (evt: string, data: unknown) => {
        if (request.raw.destroyed) return;
        if (!writable) return;
        try {
          const ok =
            reply.raw.write(`event: ${evt}\n`) &&
            reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
          if (!ok) {
            writable = false;
            reply.raw.once("drain", () => {
              writable = true;
            });
          }
        } catch {
          // client closed mid-write
        }
      };

      let unsubscribe: (() => void) | null = null;
      try {
        unsubscribe = await subscribeToNotifications(user.id, (payload) => {
          send("notification", payload);
        });
      } catch (err) {
        request.log.warn({ err }, "notifications SSE subscribe failed");
        send("error", { error: "Notifications stream unavailable" });
        try {
          reply.raw.end();
        } catch {
          // ignore
        }
        return;
      }

      const hb = setInterval(() => {
        try {
          reply.raw.write(":keepalive\n\n");
        } catch {
          // client closed
        }
      }, 20000);

      request.raw.on("close", () => {
        clearInterval(hb);
        unsubscribe?.();
      });
    },
  );
};
