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
  FundingCommitRequest,
  FundingDestinationOption,
  FundingDiscoveryRequest,
  FundingQuoteRequest,
  FundingQuoteSummary,
  IntentLiquidityProjection,
} from "../funding/domain/types.js";
import { FundingPlannerError } from "../funding/planner/money.js";
import { FundingPlanningRuntime } from "../funding/planner/runtime-service.js";
import {
  FundingPersistenceError,
  type FundingOperationRow,
} from "../funding/persistence/funding-operation-repository.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import {
  fundingApiErrorResponseSchema,
  fundingCommitRequestSchema,
  fundingDestinationsQuerySchema,
  fundingDestinationsResponseSchema,
  fundingLiquidityResponseSchema,
  fundingDiscoveryRequestSchema,
  fundingOperationParamsSchema,
  fundingOperationResponseSchema,
  fundingOperationsQuerySchema,
  fundingOperationsResponseSchema,
  fundingQuoteRequestSchema,
  fundingQuoteResponseSchema,
  fundingValidationErrorResponseSchema,
} from "../schemas/funding.js";

type FundingDestinationQuery = Readonly<{
  purpose: "fund" | "buy" | "sell" | "redeem" | "withdraw";
  marketContextId?: string | null;
  marketClass?: string | null;
}>;

export type FundingRouteDependencies = Readonly<{
  authenticate: preHandlerHookHandler;
  rateLimit(userId: string, endpoint: string): Promise<boolean>;
  destinations(
    userId: string,
    query: FundingDestinationQuery,
  ): Promise<readonly FundingDestinationOption[]>;
  liquidity(
    userId: string,
    request: FundingDiscoveryRequest,
  ): Promise<IntentLiquidityProjection>;
  quote(
    userId: string,
    request: FundingQuoteRequest,
  ): Promise<FundingQuoteSummary>;
  commit(
    userId: string,
    request: FundingCommitRequest,
  ): Promise<Readonly<{ operation: FundingOperationRow; replayed: boolean }>>;
  operation(
    userId: string,
    operationId: string,
  ): Promise<FundingOperationRow | null>;
  operations(
    userId: string,
    input: Readonly<{ limit: number; before: Date | null }>,
  ): Promise<readonly FundingOperationRow[]>;
}>;

function publicOperation(operation: FundingOperationRow) {
  return {
    operationId: operation.id,
    purpose: operation.purpose,
    status: operation.status,
    progressStage: operation.progressStage,
    experienceMode: operation.experienceMode,
    planKind: operation.planKind,
    errorCode: operation.errorCode,
    version: operation.version,
    createdAt: operation.createdAt.toISOString(),
    updatedAt: operation.updatedAt.toISOString(),
    completedAt: operation.completedAt?.toISOString() ?? null,
  };
}

function errorStatus(error: unknown): number {
  if (error instanceof FundingPlannerError) {
    if (error.code === "stale_projection") return 410;
    if (error.code === "invalid_policy") return 503;
    if (
      error.code === "destination_selection_required" ||
      error.code === "source_not_selected"
    ) {
      return 409;
    }
    return 400;
  }
  if (error instanceof FundingPersistenceError) {
    if (
      error.code === "operation_not_found" ||
      error.code === "quote_not_found"
    ) {
      return 404;
    }
    if (error.code === "quote_expired") return 410;
    return 409;
  }
  return 500;
}

function errorCode(error: unknown): string {
  if (
    error instanceof FundingPlannerError ||
    error instanceof FundingPersistenceError
  ) {
    return error.code;
  }
  return "funding_request_failed";
}

async function authorizeRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: FundingRouteDependencies,
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
      error: "Too many funding requests",
      code: "rate_limit_exceeded",
    });
    return null;
  }
  return request.user.id;
}

async function handleFundingRequest<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: FundingRouteDependencies,
  input: Readonly<{
    endpoint: string;
    logMessage: string;
    publicError: string;
  }>,
  execute: (userId: string) => Promise<T>,
): Promise<T | undefined> {
  const userId = await authorizeRequest(
    request,
    reply,
    dependencies,
    input.endpoint,
  );
  if (!userId) return;
  try {
    return await execute(userId);
  } catch (error) {
    request.log.error({ error, userId }, input.logMessage);
    reply.code(errorStatus(error)).send({
      error: input.publicError,
      code: errorCode(error),
    });
    return;
  }
}

export function registerFundingRoutes(
  app: FastifyInstance,
  dependencies: FundingRouteDependencies,
): void {
  const z = app.withTypeProvider<ZodTypeProvider>();
  const errors = {
    400: fundingValidationErrorResponseSchema,
    401: fundingApiErrorResponseSchema,
    403: fundingApiErrorResponseSchema,
    404: fundingApiErrorResponseSchema,
    409: fundingApiErrorResponseSchema,
    410: fundingApiErrorResponseSchema,
    429: fundingApiErrorResponseSchema,
    500: fundingApiErrorResponseSchema,
    503: fundingApiErrorResponseSchema,
  };

  z.get(
    "/funding/destinations",
    {
      preHandler: dependencies.authenticate,
      schema: {
        querystring: fundingDestinationsQuerySchema,
        response: { 200: fundingDestinationsResponseSchema, ...errors },
      },
    },
    (request, reply) =>
      handleFundingRequest(
        request,
        reply,
        dependencies,
        {
          endpoint: "destinations",
          logMessage: "Funding destinations failed",
          publicError: "Funding destinations are unavailable",
        },
        async (userId) => {
          const options = await dependencies.destinations(
            userId,
            request.query,
          );
          return reply.send(
            fundingDestinationsResponseSchema.parse({ ok: true, options }),
          );
        },
      ),
  );

  z.post(
    "/funding/liquidity",
    {
      preHandler: dependencies.authenticate,
      schema: {
        body: fundingDiscoveryRequestSchema,
        response: { 200: fundingLiquidityResponseSchema, ...errors },
      },
    },
    (request, reply) =>
      handleFundingRequest(
        request,
        reply,
        dependencies,
        {
          endpoint: "liquidity",
          logMessage: "Funding liquidity failed",
          publicError: "Funding liquidity could not be calculated",
        },
        async (userId) => {
          const liquidity = await dependencies.liquidity(userId, request.body);
          return reply.send(
            fundingLiquidityResponseSchema.parse({ ok: true, liquidity }),
          );
        },
      ),
  );

  z.post(
    "/funding/quotes",
    {
      preHandler: dependencies.authenticate,
      schema: {
        body: fundingQuoteRequestSchema,
        response: { 200: fundingQuoteResponseSchema, ...errors },
      },
    },
    (request, reply) =>
      handleFundingRequest(
        request,
        reply,
        dependencies,
        {
          endpoint: "quote",
          logMessage: "Funding quote failed",
          publicError: "Funding quote could not be created",
        },
        async (userId) => {
          const quote = await dependencies.quote(userId, request.body);
          return reply.send(
            fundingQuoteResponseSchema.parse({ ok: true, quote }),
          );
        },
      ),
  );

  z.post(
    "/funding/operations",
    {
      preHandler: dependencies.authenticate,
      schema: {
        body: fundingCommitRequestSchema,
        response: { 200: fundingOperationResponseSchema, ...errors },
      },
    },
    (request, reply) =>
      handleFundingRequest(
        request,
        reply,
        dependencies,
        {
          endpoint: "commit",
          logMessage: "Funding commit failed",
          publicError: "Funding operation could not be committed",
        },
        async (userId) => {
          const committed = await dependencies.commit(userId, request.body);
          return reply.send({
            ok: true,
            operation: publicOperation(committed.operation),
            replayed: committed.replayed,
          });
        },
      ),
  );

  z.get(
    "/funding/operations/:id",
    {
      preHandler: dependencies.authenticate,
      schema: {
        params: fundingOperationParamsSchema,
        response: { 200: fundingOperationResponseSchema, ...errors },
      },
    },
    (request, reply) =>
      handleFundingRequest(
        request,
        reply,
        dependencies,
        {
          endpoint: "operation",
          logMessage: "Funding operation read failed",
          publicError: "Funding operation could not be read",
        },
        async (userId) => {
          const operation = await dependencies.operation(
            userId,
            request.params.id,
          );
          if (!operation) {
            return reply.code(404).send({
              error: "Funding operation not found",
              code: "operation_not_found",
            });
          }
          return reply.send({
            ok: true,
            operation: publicOperation(operation),
          });
        },
      ),
  );

  z.get(
    "/funding/operations",
    {
      preHandler: dependencies.authenticate,
      schema: {
        querystring: fundingOperationsQuerySchema,
        response: { 200: fundingOperationsResponseSchema, ...errors },
      },
    },
    (request, reply) =>
      handleFundingRequest(
        request,
        reply,
        dependencies,
        {
          endpoint: "operations",
          logMessage: "Funding history read failed",
          publicError: "Funding operations could not be read",
        },
        async (userId) => {
          const operations = await dependencies.operations(userId, {
            limit: request.query.limit,
            before: request.query.before
              ? new Date(request.query.before)
              : null,
          });
          return reply.send({
            ok: true,
            operations: operations.map(publicOperation),
          });
        },
      ),
  );
}

export const fundingRoutes: FastifyPluginAsync = async (app) => {
  const runtime = new FundingPlanningRuntime(pool);
  registerFundingRoutes(app, {
    authenticate: createAuthMiddleware(),
    rateLimit: (userId, endpoint) =>
      checkRateLimit(`funding:${endpoint}:${userId}`, 30, 60_000, {
        onError: "fail_closed",
      }),
    destinations: () => runtime.destinations(),
    liquidity: (userId, request) => runtime.liquidity(userId, request),
    quote: (userId, request) => runtime.quote(userId, request),
    commit: (userId, request) => runtime.commit(userId, request),
    operation: (userId, operationId) => runtime.operation(userId, operationId),
    operations: (userId, input) => runtime.operations(userId, input),
  });
};
