import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { createAdminMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { ADMIN_SERVICE_PERMISSIONS } from "../services/admin-service-auth.js";
import {
  createAdminServicePrincipal,
  disableAdminServicePrincipal,
  issueAdminServiceCredential,
  listAdminServicePrincipals,
  revokeAdminServiceCredential,
} from "../services/admin-service-principals.js";

const principalIdSchema = z.object({ id: z.string().uuid() });
const credentialIdSchema = z.object({ credentialId: z.string().uuid() });
const noteSchema = z.string().trim().min(1).max(500);
const createSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(3)
      .max(80)
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
    displayName: z.string().trim().min(1).max(160),
    note: noteSchema,
  })
  .strict();
const issueSchema = z
  .object({
    permissions: z
      .array(z.enum(ADMIN_SERVICE_PERMISSIONS))
      .min(1)
      .max(ADMIN_SERVICE_PERMISSIONS.length),
    ttlDays: z.number().int().min(1),
    note: noteSchema,
  })
  .strict();
const reasonSchema = z.object({ reason: noteSchema }).strict();

function sendError(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error";
  if (/not found/i.test(message)) {
    return reply.code(404).send({ error: "admin_service_not_found", message });
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  ) {
    return reply.code(409).send({
      error: "admin_service_conflict",
      message: "A service principal with this key already exists",
    });
  }
  if (/must|required|unsupported|disabled|already has two/i.test(message)) {
    return reply.code(400).send({ error: "admin_service_invalid", message });
  }
  requestLogSafe(error);
  return reply.code(500).send({ error: "admin_service_error" });
}

function requestLogSafe(error: unknown): void {
  console.error("[admin-service-principals] operation failed", {
    error: error instanceof Error ? error.message : String(error),
  });
}

async function runAdminMutation<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  operation: (actorAdminId: string) => Promise<T>,
  statusCode = 200,
) {
  reply.header("Cache-Control", "no-store");
  const actorAdminId = request.adminAccount?.id;
  if (!actorAdminId) {
    return reply.code(401).send({ error: "admin_access_required" });
  }
  try {
    return reply.code(statusCode).send(await operation(actorAdminId));
  } catch (error) {
    return sendError(reply, error);
  }
}

export const adminServicePrincipalRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const sadmin = createAdminMiddleware({
    minAdminRole: "sadmin",
    allowLegacyFallback: false,
  });

  r.get(
    "/admin/service-principals",
    { preHandler: sadmin },
    async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
      return reply.send({
        ok: true,
        permissions: ADMIN_SERVICE_PERMISSIONS,
        principals: await listAdminServicePrincipals(pool),
      });
    },
  );

  r.post(
    "/admin/service-principals",
    { preHandler: sadmin, schema: { body: createSchema } },
    (request, reply) =>
      runAdminMutation(
        request,
        reply,
        async (actorAdminId) => {
          const principal = await createAdminServicePrincipal(pool, {
            ...request.body,
            actorAdminId,
          });
          return { ok: true, principal };
        },
        201,
      ),
  );

  r.post(
    "/admin/service-principals/:id/credentials",
    {
      preHandler: sadmin,
      schema: { params: principalIdSchema, body: issueSchema },
    },
    (request, reply) =>
      runAdminMutation(
        request,
        reply,
        async (actorAdminId) => {
          const credential = await issueAdminServiceCredential(pool, {
            principalId: request.params.id,
            ...request.body,
            actorAdminId,
          });
          return { ok: true, credential };
        },
        201,
      ),
  );

  r.post(
    "/admin/service-credentials/:credentialId/revoke",
    {
      preHandler: sadmin,
      schema: { params: credentialIdSchema, body: reasonSchema },
    },
    (request, reply) =>
      runAdminMutation(request, reply, async (actorAdminId) => {
        await revokeAdminServiceCredential(pool, {
          credentialId: request.params.credentialId,
          actorAdminId,
          reason: request.body.reason,
        });
        return { ok: true };
      }),
  );

  r.post(
    "/admin/service-principals/:id/disable",
    {
      preHandler: sadmin,
      schema: { params: principalIdSchema, body: reasonSchema },
    },
    (request, reply) =>
      runAdminMutation(request, reply, async (actorAdminId) => {
        await disableAdminServicePrincipal(pool, {
          principalId: request.params.id,
          actorAdminId,
          reason: request.body.reason,
        });
        return { ok: true };
      }),
  );
};
