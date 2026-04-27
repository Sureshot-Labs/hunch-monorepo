import type { FastifyPluginAsync } from "fastify";
import { pool } from "../db.js";
import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import { PrivyService } from "../privy-service.js";
import { handlePrivyDepositWebhook } from "../services/deposit-events.js";

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const raw = headers[name.toLowerCase()];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return "";
}

export const privyWebhookRoutes: FastifyPluginAsync = async (app) => {
  app.post("/webhooks/privy", async (request, reply) => {
    if (!env.privyWebhookSecret) {
      request.log.warn(
        "Privy webhook received but PRIVY_WEBHOOK_SECRET is unset",
      );
      reply.code(503);
      return reply.send({ error: "Privy webhook is not configured" });
    }

    if (!isRecord(request.body)) {
      reply.code(400);
      return reply.send({ error: "Invalid webhook payload" });
    }

    const headers = {
      id: readHeader(request.headers, "svix-id"),
      timestamp: readHeader(request.headers, "svix-timestamp"),
      signature: readHeader(request.headers, "svix-signature"),
    };

    if (!headers.id || !headers.timestamp || !headers.signature) {
      reply.code(400);
      return reply.send({ error: "Missing webhook signature headers" });
    }

    let verifiedPayload: unknown;
    try {
      verifiedPayload = await PrivyService.verifyWebhook(
        request.body,
        headers,
        env.privyWebhookSecret,
      );
    } catch (error) {
      request.log.warn(
        { error },
        "Privy webhook signature verification failed",
      );
      reply.code(401);
      return reply.send({ error: "Invalid webhook signature" });
    }

    const result = await handlePrivyDepositWebhook(
      pool,
      verifiedPayload,
      request.log,
    );

    reply.header("Content-Type", "application/json; charset=utf-8");
    return reply.send(result);
  });
};
