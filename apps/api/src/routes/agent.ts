import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { checkRateLimitForSecurityClientIp } from "../lib/request-ip.js";
import { fetchNotifications } from "../repos/notifications-repo.js";
import {
  agentApprovalTokenParamsSchema,
  agentApproveBodySchema,
  agentAuditQuerySchema,
  agentDenyBodySchema,
  agentDeviceStartBodySchema,
  agentDeviceTokenBodySchema,
  agentGrantParamsSchema,
} from "../schemas/agent.js";
import { notificationsQuerySchema } from "../schemas/notifications.js";
import {
  AgentAuthError,
  AgentAuthService,
  createAgentAuthMiddleware,
  summarizeAgentGrant,
} from "../services/agent-auth.js";

function readRequestUserAgent(request: FastifyRequest): string | null {
  const raw = request.headers["user-agent"];
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0].trim();
  return null;
}

function handleAgentError(error: unknown, reply: FastifyReply) {
  if (error instanceof AgentAuthError) {
    reply.code(error.statusCode);
    return reply.send({ error: error.code, message: error.message });
  }
  throw error;
}

async function enforceAgentRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  suffix: string,
  maxRequests: number,
  windowMs: number,
): Promise<string | null> {
  const result = await checkRateLimitForSecurityClientIp(request, {
    keyPrefix: `agent:${suffix}`,
    maxRequests,
    windowMs,
    onError: "fail_closed",
  });
  if (result.allowed) return result.clientIp;
  reply.code(429);
  reply.send({ error: "rate_limit_exceeded" });
  return null;
}

async function requireAgentAuthEnabled(
  _request: FastifyRequest,
  reply: FastifyReply,
) {
  if (env.agentAuthEnabled) return;
  reply.code(503);
  return reply.send({
    error: "agent_auth_disabled",
    message: "Agent auth is disabled on this API instance.",
  });
}

export const agentRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const browserAuth = createAuthMiddleware();
  const agentAccountAuth = createAgentAuthMiddleware({
    requiredScopes: ["read:account"],
  });
  const agentNotificationsAuth = createAgentAuthMiddleware({
    requiredScopes: ["read:notifications"],
  });

  r.get("/agent/capabilities", async (_request, reply) => {
    reply.header("Content-Type", "application/json; charset=utf-8");
    return reply.send({
      ok: true,
      enabled: env.agentAuthEnabled,
      scopes: AgentAuthService.allowedReadScopes(),
      approvalTtlMs: env.agentAuthApprovalTtlMs,
      defaultGrantTtlMs: env.agentGrantDefaultTtlMs,
      maxReadGrantTtlMs: env.agentGrantMaxReadTtlMs,
      pollIntervalSec: Math.ceil(env.agentAuthPollIntervalMs / 1000),
    });
  });

  r.post(
    "/agent/device/start",
    {
      preHandler: requireAgentAuthEnabled,
      schema: { body: agentDeviceStartBodySchema },
    },
    async (request, reply) => {
      const clientIp = await enforceAgentRateLimit(
        request,
        reply,
        "device-start",
        20,
        60_000,
      );
      if (!clientIp) return;

      try {
        const body = request.body;
        const result = await AgentAuthService.startDeviceAuthorization({
          requestedScopes: body.requestedScopes,
          requestedWalletAddresses: body.requestedWalletAddresses,
          requestedVenues: body.requestedVenues,
          requestedLimits: body.requestedLimits,
          clientName: body.clientName,
          clientVersion: body.clientVersion,
          clientKind: body.clientKind,
          profileLabel: body.profileLabel,
          grantName: body.grantName,
          ipAddress: clientIp,
          userAgent: readRequestUserAgent(request),
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          deviceCode: result.deviceCode,
          approvalUrl: result.approvalUrl,
          expiresAt: result.expiresAt.toISOString(),
          pollIntervalSec: result.pollIntervalSec,
        });
      } catch (error) {
        return handleAgentError(error, reply);
      }
    },
  );

  r.post(
    "/agent/device/token",
    {
      preHandler: requireAgentAuthEnabled,
      schema: { body: agentDeviceTokenBodySchema },
    },
    async (request, reply) => {
      const clientIp = await enforceAgentRateLimit(
        request,
        reply,
        "device-token",
        120,
        60_000,
      );
      if (!clientIp) return;

      try {
        const result = await AgentAuthService.pollDeviceToken(
          request.body.deviceCode,
        );
        reply.header("Content-Type", "application/json; charset=utf-8");
        if (!result.ok) return reply.send(result);
        return reply.send({
          ok: true,
          token: result.token,
          tokenType: "Bearer",
          grant: result.grant,
          expiresAt: result.expiresAt,
        });
      } catch (error) {
        return handleAgentError(error, reply);
      }
    },
  );

  r.get(
    "/agent/device/approval/:approvalToken",
    {
      preHandler: [requireAgentAuthEnabled, browserAuth],
      schema: { params: agentApprovalTokenParamsSchema },
    },
    async (request, reply) => {
      const auth = await AgentAuthService.getApprovalByToken(
        request.params.approvalToken,
      );
      if (!auth) {
        reply.code(404);
        return reply.send({ error: "authorization_not_found" });
      }
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        authorization: {
          id: auth.id,
          status: auth.status,
          requestedScopes: auth.requestedScopes,
          requestedWalletAddresses: auth.requestedWalletAddresses,
          requestedVenues: auth.requestedVenues,
          requestedLimits: auth.requestedLimits,
          clientName: auth.clientName,
          clientVersion: auth.clientVersion,
          clientKind: auth.clientKind,
          expiresAt: auth.expiresAt.toISOString(),
        },
      });
    },
  );

  r.post(
    "/agent/device/approve",
    {
      preHandler: [requireAgentAuthEnabled, browserAuth],
      schema: { body: agentApproveBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      const clientIp = await enforceAgentRateLimit(
        request,
        reply,
        "device-approve",
        30,
        60_000,
      );
      if (!clientIp) return;

      try {
        const body = request.body;
        await AgentAuthService.approveDeviceAuthorization({
          approvalToken: body.approvalToken,
          userId: user.id,
          scopes: body.scopes,
          walletAddresses: body.walletAddresses,
          venues: body.venues,
          limits: body.limits,
          expiresInDays: body.expiresInDays,
          grantName: body.grantName,
          ipAddress: clientIp,
          userAgent: readRequestUserAgent(request),
        });
        return reply.send({ ok: true, status: "approved" });
      } catch (error) {
        return handleAgentError(error, reply);
      }
    },
  );

  r.post(
    "/agent/device/deny",
    {
      preHandler: [requireAgentAuthEnabled, browserAuth],
      schema: { body: agentDenyBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      const clientIp = await enforceAgentRateLimit(
        request,
        reply,
        "device-deny",
        30,
        60_000,
      );
      if (!clientIp) return;

      try {
        await AgentAuthService.denyDeviceAuthorization({
          approvalToken: request.body.approvalToken,
          userId: user.id,
          ipAddress: clientIp,
          userAgent: readRequestUserAgent(request),
        });
        return reply.send({ ok: true, status: "denied" });
      } catch (error) {
        return handleAgentError(error, reply);
      }
    },
  );

  r.get(
    "/agent/grants",
    { preHandler: [requireAgentAuthEnabled, browserAuth] },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      const grants = await AgentAuthService.listGrants(user.id);
      return reply.send({
        ok: true,
        items: grants.map(summarizeAgentGrant),
      });
    },
  );

  r.delete(
    "/agent/grants/:id",
    {
      preHandler: [requireAgentAuthEnabled, browserAuth],
      schema: { params: agentGrantParamsSchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      const revoked = await AgentAuthService.revokeGrant({
        userId: user.id,
        grantId: request.params.id,
        userAgent: readRequestUserAgent(request),
      });
      if (!revoked) {
        reply.code(404);
        return reply.send({ error: "Grant not found" });
      }
      return reply.send({ ok: true, revoked: true });
    },
  );

  r.get(
    "/agent/audit",
    {
      preHandler: [requireAgentAuthEnabled, browserAuth],
      schema: { querystring: agentAuditQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      const items = await AgentAuthService.listAuditEvents(
        user.id,
        request.query.limit,
      );
      return reply.send({ ok: true, items });
    },
  );

  r.get(
    "/agent/me",
    { preHandler: agentAccountAuth },
    async (request, reply) => {
      const user = request.user;
      const grant = request.agentGrant;
      if (!user || !grant) {
        reply.code(401);
        return reply.send({ error: "agent_auth_required" });
      }
      return reply.send({
        ok: true,
        user: {
          id: user.id,
          email: user.email ?? null,
        },
        grant: summarizeAgentGrant(grant),
      });
    },
  );

  r.get(
    "/agent/notifications",
    {
      preHandler: agentNotificationsAuth,
      schema: { querystring: notificationsQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "agent_auth_required" });
      }
      const query = request.query;
      const result = await fetchNotifications(pool, {
        userId: user.id,
        limit: query.limit,
        cursor: query.cursor,
        unreadOnly: query.unreadOnly ?? false,
      });

      return reply.send({
        ok: true,
        items: result.rows.map((row) => ({
          id: row.id,
          type: row.type,
          title: row.title,
          body: row.body,
          severity: row.severity,
          data: row.data ?? null,
          readAt: row.read_at ? row.read_at.toISOString() : null,
          createdAt: row.created_at.toISOString(),
        })),
        nextCursor: result.nextCursor,
      });
    },
  );
};
