import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import * as schema from "../schemas/native-notifications.js";
import {
  NativeNotificationError,
  NativeNotificationPreferencesService,
  readNativePreferences,
} from "../services/native-notification-preferences.js";

export const nativeNotificationsRoutes: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const service = new NativeNotificationPreferencesService(pool);
  const required = createAuthMiddleware();
  const ok = z.object({ ok: z.literal(true) });
  const errors = Object.fromEntries(
    [400, 401, 403, 409, 429, 500, 503].map((code) => [
      code,
      schema.nativeNotificationError,
    ]),
  );
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store");
  });
  const limited = async (request: FastifyRequest, reply: FastifyReply) => {
    if (
      request.user &&
      request.method !== "GET" &&
      !(await checkRateLimit(
        `native-notifications:${request.user.id}`,
        60,
        60_000,
        { onError: "fail_closed" },
      ))
    ) {
      return reply.code(429).send({ error: "rate_limit_exceeded" });
    }
  };
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof NativeNotificationError)
      return reply
        .code(error.statusCode)
        .send({ error: error.code, preferences: error.preferences });
    if (error && typeof error === "object" && "validation" in error)
      return reply.code(400).send({ error: "invalid_request" });
    request.log.error(
      { code: "native_notification_request_failed" },
      "Native notification request failed",
    );
    return reply
      .code(500)
      .send({ error: "native_notification_request_failed" });
  });
  typed.get(
    "/users/me/notification-preferences",
    {
      preHandler: required,
      schema: {
        tags: ["Notifications"],
        response: { 200: schema.nativePreferencesSchema, ...errors },
      },
    },
    async (request) => readNativePreferences(pool, requireUser(request)),
  );
  typed.put(
    "/users/me/notification-preferences",
    {
      preHandler: [required, limited],
      schema: {
        tags: ["Notifications"],
        body: schema.nativePreferencesBody,
        response: { 200: schema.nativePreferencesSchema, ...errors },
      },
    },
    async (request) => service.save(requireUser(request), request.body),
  );
  typed.put(
    "/users/me/push-devices/:id",
    {
      preHandler: [required, limited],
      schema: {
        tags: ["Notifications"],
        params: schema.nativeDeviceParams,
        body: schema.nativeDeviceBody,
        response: { 200: ok, ...errors },
      },
    },
    async (request) => {
      if (!request.session)
        throw new NativeNotificationError("unauthorized", 401);
      await service.register(
        requireUser(request),
        request.session.id,
        request.params.id,
        request.body,
      );
      return { ok: true as const };
    },
  );
  typed.delete(
    "/users/me/push-devices/:id",
    {
      preHandler: [required, limited],
      schema: {
        tags: ["Notifications"],
        params: schema.nativeDeviceParams,
        response: { 200: ok, ...errors },
      },
    },
    async (request) => {
      if (!request.session)
        throw new NativeNotificationError("unauthorized", 401);
      await service.unregister(
        requireUser(request),
        request.session.id,
        request.params.id,
      );
      return { ok: true as const };
    },
  );
};

function requireUser(request: FastifyRequest): string {
  if (!request.user) throw new NativeNotificationError("unauthorized", 401);
  return request.user.id;
}
