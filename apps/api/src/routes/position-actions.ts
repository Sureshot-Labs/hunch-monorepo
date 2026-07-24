import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import type {
  PositionActionReadiness,
  PositionActionResult,
} from "../funding/domain/contracts.js";
import {
  PositionActionPersistenceError,
  type PositionActionSubmissionClaim,
  type StoredPositionAction,
} from "../funding/position-actions/position-action-repository.js";
import {
  PositionActionRuntimeError,
  PositionActionRuntimeService,
  type PreparedPositionAction,
} from "../funding/position-actions/runtime-service.js";
import { PreparationContractError } from "../funding/preparation/core-adapter.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { fundingValidationErrorResponseSchema } from "../schemas/funding.js";
import {
  positionActionApiErrorSchema,
  positionActionInspectRequestSchema,
  positionActionInspectResponseSchema,
  positionActionOperationParamsSchema,
  positionActionOperationResponseSchema,
  positionActionPrepareRequestSchema,
  positionActionPrepareResponseSchema,
  positionActionReconcileResponseSchema,
  positionActionSubmissionClaimResponseSchema,
  positionActionSubmissionReportSchema,
} from "../schemas/position-actions.js";

type PositionActionRequest = Readonly<{
  action: "redeem";
  ownerBindingId: string;
  positionRef: string;
  venueId: string;
}>;

export type PositionActionRouteDependencies = Readonly<{
  authenticate: preHandlerHookHandler;
  claim(
    userId: string,
    operationId: string,
  ): Promise<PositionActionSubmissionClaim>;
  inspect(
    userId: string,
    input: PositionActionRequest,
  ): Promise<PositionActionReadiness>;
  operation(
    userId: string,
    operationId: string,
  ): Promise<StoredPositionAction | null>;
  prepare(
    userId: string,
    input: PositionActionRequest &
      Readonly<{
        expectedInspectionRevision: string;
        idempotencyKey: string;
      }>,
  ): Promise<PreparedPositionAction>;
  rateLimit(userId: string, endpoint: string): Promise<boolean>;
  reconcile(userId: string, operationId: string): Promise<PositionActionResult>;
  report(
    userId: string,
    input: Readonly<{
      attemptNumber: number;
      errorCode: string | null;
      operationId: string;
      outcome: "ambiguous" | "failed" | "not_broadcast" | "submitted";
      submissionFingerprint: string | null;
    }>,
  ): Promise<StoredPositionAction>;
}>;

function publicOperation(operation: StoredPositionAction) {
  return {
    operationId: operation.id,
    venueId: operation.venueId,
    action: operation.action,
    positionRef: operation.positionRef,
    ownerBindingId: operation.ownerBindingId,
    executionMode: operation.executionMode,
    status: operation.status,
    submissionFingerprint: operation.submissionFingerprint,
    broadcastMayHaveOccurred: operation.broadcastMayHaveOccurred,
    receiptStatus: operation.receiptStatus,
    postconditionStatus: operation.postconditionStatus,
    lastErrorCode: operation.lastErrorCode,
    createdAt: operation.createdAt.toISOString(),
    updatedAt: operation.updatedAt.toISOString(),
    completedAt: operation.completedAt?.toISOString() ?? null,
  };
}

function statusForError(error: unknown): number {
  if (error instanceof PreparationContractError) {
    if (error.code === "binding_mismatch") return 404;
    if (error.code === "evidence_expired") return 410;
    if (
      error.code === "evidence_stale" ||
      error.code === "preparation_unavailable" ||
      error.code === "unsupported_market_class"
    ) {
      return 409;
    }
    return 400;
  }
  if (error instanceof PositionActionRuntimeError) {
    if (error.code === "position_not_found") return 404;
    if (error.code === "market_not_found") return 409;
    return 400;
  }
  if (error instanceof PositionActionPersistenceError) {
    return error.code === "operation_not_found" ? 404 : 409;
  }
  return 500;
}

function codeForError(error: unknown): string {
  if (
    error instanceof PreparationContractError ||
    error instanceof PositionActionRuntimeError ||
    error instanceof PositionActionPersistenceError
  ) {
    return error.code;
  }
  return "position_action_failed";
}

async function authorize(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: PositionActionRouteDependencies,
  endpoint: string,
): Promise<string | null> {
  if (!request.user) {
    reply
      .code(401)
      .send({ error: "Unauthorized", code: "account_not_authenticated" });
    return null;
  }
  if (!(await dependencies.rateLimit(request.user.id, endpoint))) {
    reply.code(429).send({
      error: "Too many position action requests",
      code: "rate_limit_exceeded",
    });
    return null;
  }
  return request.user.id;
}

async function handle<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: PositionActionRouteDependencies,
  endpoint: string,
  execute: (userId: string) => Promise<T>,
): Promise<T | undefined> {
  const userId = await authorize(request, reply, dependencies, endpoint);
  if (!userId) return;
  try {
    return await execute(userId);
  } catch (error) {
    request.log.error({ endpoint, error, userId }, "Position action failed");
    reply.code(statusForError(error)).send({
      error: "Position action could not be completed",
      code: codeForError(error),
    });
    return;
  }
}

export function registerPositionActionRoutes(
  app: FastifyInstance,
  dependencies: PositionActionRouteDependencies,
): void {
  const z = app.withTypeProvider<ZodTypeProvider>();
  const errors = {
    400: fundingValidationErrorResponseSchema,
    401: positionActionApiErrorSchema,
    404: positionActionApiErrorSchema,
    409: positionActionApiErrorSchema,
    410: positionActionApiErrorSchema,
    429: positionActionApiErrorSchema,
    500: positionActionApiErrorSchema,
  };

  z.post(
    "/position-actions/inspect",
    {
      preHandler: dependencies.authenticate,
      schema: {
        body: positionActionInspectRequestSchema,
        response: { 200: positionActionInspectResponseSchema, ...errors },
      },
    },
    (request, reply) =>
      handle(request, reply, dependencies, "inspect", async (userId) => {
        const readiness = await dependencies.inspect(userId, request.body);
        return reply.send(
          positionActionInspectResponseSchema.parse({ ok: true, readiness }),
        );
      }),
  );

  z.post(
    "/position-actions/prepare",
    {
      preHandler: dependencies.authenticate,
      schema: {
        body: positionActionPrepareRequestSchema,
        response: { 200: positionActionPrepareResponseSchema, ...errors },
      },
    },
    (request, reply) =>
      handle(request, reply, dependencies, "prepare", async (userId) => {
        const prepared = await dependencies.prepare(userId, request.body);
        return reply.send(
          positionActionPrepareResponseSchema.parse({
            ok: true,
            operation: publicOperation(prepared.operation),
            actions: prepared.actions,
            replayed: prepared.replayed,
          }),
        );
      }),
  );

  z.get(
    "/position-actions/:id",
    {
      preHandler: dependencies.authenticate,
      schema: {
        params: positionActionOperationParamsSchema,
        response: { 200: positionActionOperationResponseSchema, ...errors },
      },
    },
    (request, reply) =>
      handle(request, reply, dependencies, "read", async (userId) => {
        const operation = await dependencies.operation(
          userId,
          request.params.id,
        );
        if (!operation) {
          return reply.code(404).send({
            error: "Position action not found",
            code: "operation_not_found",
          });
        }
        return reply.send(
          positionActionOperationResponseSchema.parse({
            ok: true,
            operation: publicOperation(operation),
          }),
        );
      }),
  );

  z.post(
    "/position-actions/:id/submission/claim",
    {
      preHandler: dependencies.authenticate,
      schema: {
        params: positionActionOperationParamsSchema,
        response: {
          200: positionActionSubmissionClaimResponseSchema,
          ...errors,
        },
      },
    },
    (request, reply) =>
      handle(request, reply, dependencies, "claim", async (userId) => {
        const claim = await dependencies.claim(userId, request.params.id);
        return reply.send(
          positionActionSubmissionClaimResponseSchema.parse({
            ok: true,
            claimed: claim.claimed,
            attemptNumber: claim.attemptNumber,
            reason: claim.reason,
            operation: publicOperation(claim.operation),
          }),
        );
      }),
  );

  z.post(
    "/position-actions/:id/submission/report",
    {
      preHandler: dependencies.authenticate,
      schema: {
        params: positionActionOperationParamsSchema,
        body: positionActionSubmissionReportSchema,
        response: { 200: positionActionOperationResponseSchema, ...errors },
      },
    },
    (request, reply) =>
      handle(request, reply, dependencies, "report", async (userId) => {
        const operation = await dependencies.report(userId, {
          operationId: request.params.id,
          ...request.body,
        });
        return reply.send(
          positionActionOperationResponseSchema.parse({
            ok: true,
            operation: publicOperation(operation),
          }),
        );
      }),
  );

  z.post(
    "/position-actions/:id/reconcile",
    {
      preHandler: dependencies.authenticate,
      schema: {
        params: positionActionOperationParamsSchema,
        response: {
          200: positionActionReconcileResponseSchema,
          ...errors,
        },
      },
    },
    (request, reply) =>
      handle(request, reply, dependencies, "reconcile", async (userId) => {
        const result = await dependencies.reconcile(userId, request.params.id);
        return reply.send(
          positionActionReconcileResponseSchema.parse({ ok: true, result }),
        );
      }),
  );
}

export const positionActionRoutes: FastifyPluginAsync = async (app) => {
  const runtime = new PositionActionRuntimeService(pool);
  registerPositionActionRoutes(app, {
    authenticate: createAuthMiddleware(),
    rateLimit: (userId, endpoint) =>
      checkRateLimit(`position-action:${endpoint}:${userId}`, 30, 60_000, {
        onError: "fail_closed",
      }),
    inspect: (userId, input) => runtime.inspect(userId, input),
    prepare: (userId, input) => runtime.prepare(userId, input),
    operation: (userId, operationId) => runtime.operation(userId, operationId),
    claim: (userId, operationId) =>
      runtime.claimSubmission(userId, operationId),
    report: (userId, input) => runtime.reportSubmission(userId, input),
    reconcile: (userId, operationId) => runtime.reconcile(userId, operationId),
  });
};
