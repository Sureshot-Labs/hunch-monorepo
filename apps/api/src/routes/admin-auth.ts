import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { env } from "../env.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { resolveSecurityClientIp } from "../lib/request-ip.js";
import {
  AdminAuthError,
  AdminAuthService,
  createAdminSessionMiddleware,
  readAdminBearerToken,
} from "../services/admin-auth.js";

const enrollStartBodySchema = z.object({
  token: z.string().min(16),
});

const enrollCompleteBodySchema = z.object({
  token: z.string().min(16),
  password: z.string().min(1),
  totpCode: z.string().min(6).max(16),
});

const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totpCode: z.string().min(6).max(16),
});

const adminIdParamsSchema = z.object({
  id: z.string().uuid(),
});

const inviteAdminBodySchema = z.object({
  email: z.string().email(),
});

const adminRoleBodySchema = z.object({
  role: z.enum(["sadmin", "admin", "viewer", "analyst"]),
});

function readRequestUserAgent(request: FastifyRequest): string | null {
  const raw = request.headers["user-agent"];
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0].trim();
  return null;
}

function adminPayload(admin: {
  id: string;
  email: string;
  status: string;
  role: string | null;
  createdAt: Date;
  invitedAt: Date;
  enrolledAt: Date | null;
  activatedAt: Date | null;
  disabledAt: Date | null;
  lastLoginAt: Date | null;
}) {
  return {
    id: admin.id,
    email: admin.email,
    status: admin.status,
    role: admin.role,
    createdAt: admin.createdAt.toISOString(),
    invitedAt: admin.invitedAt.toISOString(),
    enrolledAt: admin.enrolledAt?.toISOString() ?? null,
    activatedAt: admin.activatedAt?.toISOString() ?? null,
    disabledAt: admin.disabledAt?.toISOString() ?? null,
    lastLoginAt: admin.lastLoginAt?.toISOString() ?? null,
  };
}

function adminAuditActor(request: FastifyRequest) {
  return {
    actorAdminId: request.adminAccount?.id ?? null,
    actorEmail: request.adminAccount?.email ?? null,
    actorRole: request.adminAccount?.role ?? null,
  };
}

function handleAdminAuthError(error: unknown, reply: FastifyReply) {
  if (error instanceof AdminAuthError) {
    reply.code(error.statusCode);
    return reply.send({ error: error.code, message: error.message });
  }
  throw error;
}

async function enforceRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
  reply: FastifyReply,
): Promise<boolean> {
  const ok = await checkRateLimit(key, maxRequests, windowMs, {
    onError: "fail_closed",
  });
  if (ok) return true;
  reply.code(429);
  reply.send({ error: "rate_limit_exceeded" });
  return false;
}

export const adminAuthRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const sadminOnly = createAdminSessionMiddleware({ minRole: "sadmin" });

  r.post(
    "/admin-auth/enroll/start",
    {
      schema: { body: enrollStartBodySchema },
    },
    async (request, reply) => {
      if (!env.adminAuthEnabled) {
        reply.code(404);
        return reply.send({ error: "admin_auth_disabled" });
      }
      const clientIp = resolveSecurityClientIp(request);
      const body = request.body;
      const ipOk = await enforceRateLimit(
        `admin:enroll:start:ip:${clientIp}`,
        30,
        60_000,
        reply,
      );
      if (!ipOk) return;
      const canProceed = await enforceRateLimit(
        `admin:enroll:start:${clientIp}:${body.token.slice(0, 16)}`,
        10,
        60_000,
        reply,
      );
      if (!canProceed) return;

      try {
        const result = await AdminAuthService.startEnrollment(body.token);
        return reply.send({
          ok: true,
          email: result.email,
          otpauthUri: result.otpauthUri,
          manualSecret: result.manualSecret,
          expiresAt: result.expiresAt.toISOString(),
        });
      } catch (error) {
        return handleAdminAuthError(error, reply);
      }
    },
  );

  r.post(
    "/admin-auth/enroll/complete",
    {
      schema: { body: enrollCompleteBodySchema },
    },
    async (request, reply) => {
      if (!env.adminAuthEnabled) {
        reply.code(404);
        return reply.send({ error: "admin_auth_disabled" });
      }
      const clientIp = resolveSecurityClientIp(request);
      const body = request.body;
      const ipOk = await enforceRateLimit(
        `admin:enroll:complete:ip:${clientIp}`,
        30,
        60_000,
        reply,
      );
      if (!ipOk) return;
      const canProceed = await enforceRateLimit(
        `admin:enroll:complete:${clientIp}:${body.token.slice(0, 16)}`,
        10,
        60_000,
        reply,
      );
      if (!canProceed) return;

      try {
        const result = await AdminAuthService.completeEnrollment({
          token: body.token,
          password: body.password,
          totpCode: body.totpCode,
          ipAddress: clientIp,
          userAgent: readRequestUserAgent(request),
        });
        return reply.send({ ok: true, admin: adminPayload(result.admin) });
      } catch (error) {
        return handleAdminAuthError(error, reply);
      }
    },
  );

  r.post(
    "/admin-auth/login",
    {
      schema: { body: loginBodySchema },
    },
    async (request, reply) => {
      if (!env.adminAuthEnabled) {
        reply.code(404);
        return reply.send({ error: "admin_auth_disabled" });
      }
      const clientIp = resolveSecurityClientIp(request);
      const body = request.body;
      const emailKey = body.email.trim().toLowerCase();
      const ipOk = await enforceRateLimit(
        `admin:login:ip:${clientIp}`,
        30,
        60_000,
        reply,
      );
      if (!ipOk) return;
      const emailOk = await enforceRateLimit(
        `admin:login:email:${emailKey}`,
        10,
        60_000,
        reply,
      );
      if (!emailOk) return;

      try {
        const result = await AdminAuthService.login({
          email: body.email,
          password: body.password,
          totpCode: body.totpCode,
          ipAddress: clientIp,
          userAgent: readRequestUserAgent(request),
        });
        return reply.send({
          ok: true,
          admin: adminPayload(result.admin),
          session: {
            token: result.session.token,
            csrfToken: result.session.csrfToken,
            expiresAt: result.session.expiresAt.toISOString(),
          },
        });
      } catch (error) {
        return handleAdminAuthError(error, reply);
      }
    },
  );

  r.get(
    "/admin-auth/me",
    { preHandler: createAdminSessionMiddleware() },
    async (request, reply) => {
      return reply.send({
        ok: true,
        admin: request.adminAccount ? adminPayload(request.adminAccount) : null,
        session: request.adminSession
          ? {
              expiresAt: request.adminSession.expiresAt.toISOString(),
            }
          : null,
      });
    },
  );

  r.post(
    "/admin-auth/logout",
    { preHandler: createAdminSessionMiddleware() },
    async (request, reply) => {
      const token = readAdminBearerToken(request);
      if (token) await AdminAuthService.revokeSession(token);
      return reply.send({ ok: true });
    },
  );

  r.post(
    "/admin-auth/logout-all",
    { preHandler: createAdminSessionMiddleware() },
    async (request, reply) => {
      const adminId = request.adminAccount?.id;
      const revoked = adminId
        ? await AdminAuthService.revokeAllSessions(adminId)
        : 0;
      return reply.send({ ok: true, revoked });
    },
  );

  r.get(
    "/admin-auth/admins",
    { preHandler: sadminOnly },
    async (_request, reply) => {
      const admins = await AdminAuthService.listAdmins();
      return reply.send({
        ok: true,
        admins: admins.map(adminPayload),
      });
    },
  );

  r.post(
    "/admin-auth/admins/invite",
    {
      preHandler: sadminOnly,
      schema: { body: inviteAdminBodySchema },
    },
    async (request, reply) => {
      try {
        const result = await AdminAuthService.inviteAdmin(
          request.body.email,
          adminAuditActor(request),
        );
        return reply.send({
          ok: true,
          admin: adminPayload(result.admin),
          enrollmentUrl: result.enrollmentUrl,
          expiresAt: result.expiresAt.toISOString(),
        });
      } catch (error) {
        return handleAdminAuthError(error, reply);
      }
    },
  );

  r.post(
    "/admin-auth/admins/:id/activate",
    {
      preHandler: sadminOnly,
      schema: { params: adminIdParamsSchema, body: adminRoleBodySchema },
    },
    async (request, reply) => {
      try {
        const admin = await AdminAuthService.activateAdminById(
          request.params.id,
          request.body.role,
          adminAuditActor(request),
        );
        return reply.send({ ok: true, admin: adminPayload(admin) });
      } catch (error) {
        return handleAdminAuthError(error, reply);
      }
    },
  );

  r.post(
    "/admin-auth/admins/:id/role",
    {
      preHandler: sadminOnly,
      schema: { params: adminIdParamsSchema, body: adminRoleBodySchema },
    },
    async (request, reply) => {
      const actorAdminId = request.adminAccount?.id;
      if (!actorAdminId) {
        reply.code(401);
        return reply.send({ error: "admin_access_required" });
      }
      try {
        const admin = await AdminAuthService.setAdminRoleById({
          actorAdminId,
          targetAdminId: request.params.id,
          role: request.body.role,
        });
        return reply.send({ ok: true, admin: adminPayload(admin) });
      } catch (error) {
        return handleAdminAuthError(error, reply);
      }
    },
  );

  r.post(
    "/admin-auth/admins/:id/disable",
    {
      preHandler: sadminOnly,
      schema: { params: adminIdParamsSchema },
    },
    async (request, reply) => {
      const actorAdminId = request.adminAccount?.id;
      if (!actorAdminId) {
        reply.code(401);
        return reply.send({ error: "admin_access_required" });
      }
      try {
        const admin = await AdminAuthService.disableAdminById({
          actorAdminId,
          targetAdminId: request.params.id,
        });
        return reply.send({ ok: true, admin: adminPayload(admin) });
      } catch (error) {
        return handleAdminAuthError(error, reply);
      }
    },
  );

  r.post(
    "/admin-auth/admins/:id/rotate-link",
    {
      preHandler: sadminOnly,
      schema: { params: adminIdParamsSchema },
    },
    async (request, reply) => {
      const actorAdminId = request.adminAccount?.id;
      if (!actorAdminId) {
        reply.code(401);
        return reply.send({ error: "admin_access_required" });
      }
      try {
        const result = await AdminAuthService.rotateEnrollmentLinkById({
          actorAdminId,
          targetAdminId: request.params.id,
        });
        return reply.send({
          ok: true,
          admin: adminPayload(result.admin),
          enrollmentUrl: result.enrollmentUrl,
          expiresAt: result.expiresAt.toISOString(),
        });
      } catch (error) {
        return handleAdminAuthError(error, reply);
      }
    },
  );

  r.post(
    "/admin-auth/admins/:id/revoke-sessions",
    {
      preHandler: sadminOnly,
      schema: { params: adminIdParamsSchema },
    },
    async (request, reply) => {
      try {
        const revoked = await AdminAuthService.revokeSessionsById(
          request.params.id,
          adminAuditActor(request),
        );
        return reply.send({ ok: true, revoked });
      } catch (error) {
        return handleAdminAuthError(error, reply);
      }
    },
  );
};
