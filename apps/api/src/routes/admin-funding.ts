import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { DbQuery } from "../db.js";
import {
  FundingPolicyPublishError,
  previewFundingPolicy,
  publishFundingPolicy,
  resolveFundingPolicy,
} from "../funding/policies/funding-policy-service.js";
import {
  adminFundingPolicyDiffBodySchema,
  adminFundingPolicyPublishBodySchema,
} from "../schemas/admin.js";

export type AdminFundingPermission = "funding:read" | "funding:write";

export type AdminFundingRouteDependencies = Readonly<{
  db: DbQuery;
  authorize: (permission: AdminFundingPermission) => preHandlerHookHandler;
  transact: <T>(work: (db: DbQuery) => Promise<T>) => Promise<T>;
}>;

function isMissingTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { code?: unknown }).code === "42P01";
}

export function registerAdminFundingRoutes(
  app: FastifyInstance,
  dependencies: AdminFundingRouteDependencies,
): void {
  const z = app.withTypeProvider<ZodTypeProvider>();

  z.get(
    "/admin/funding/policy",
    {
      preHandler: dependencies.authorize("funding:read"),
    },
    async (_request, reply) => {
      const resolved = await resolveFundingPolicy(dependencies.db);
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, resolved });
    },
  );

  z.post(
    "/admin/funding/policy/diff",
    {
      preHandler: dependencies.authorize("funding:write"),
      schema: { body: adminFundingPolicyDiffBodySchema },
    },
    async (request, reply) => {
      const preview = await previewFundingPolicy(
        dependencies.db,
        request.body.candidate,
      );
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, preview });
    },
  );

  z.post(
    "/admin/funding/policy/publish",
    {
      preHandler: dependencies.authorize("funding:write"),
      schema: { body: adminFundingPolicyPublishBodySchema },
    },
    async (request, reply) => {
      const actorId = request.adminActor?.id ?? request.user?.id;
      if (!actorId) {
        return reply.code(401).send({ error: "Admin identity is required" });
      }
      try {
        const resolved = await dependencies.transact((db) =>
          publishFundingPolicy(db, {
            candidate: request.body.candidate,
            expectedCurrentRevision: request.body.expectedCurrentRevision,
            candidateRevision: request.body.candidateRevision,
            confirmation: request.body.confirmation,
            createdBy: actorId,
          }),
        );
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          requestId: request.body.requestId,
          resolved,
        });
      } catch (error) {
        if (error instanceof FundingPolicyPublishError) {
          reply.code(
            error.code === "invalid_candidate" ||
              error.code === "confirmation_mismatch"
              ? 400
              : 409,
          );
          return reply.send({
            error: error.message,
            code: error.code,
            issues: error.issues,
          });
        }
        if (isMissingTableError(error)) {
          reply.code(503);
          return reply.send({
            error:
              "runtime_policies table is missing. Apply migrations before publishing funding policy.",
          });
        }
        throw error;
      }
    },
  );
}
