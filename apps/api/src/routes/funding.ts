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
  NormalizedAction,
  PreparationPurpose,
} from "../funding/domain/types.js";
import type { PreparationResult } from "../funding/domain/contracts.js";
import { FundingPlannerError } from "../funding/planner/money.js";
import { FundingPlanningRuntime } from "../funding/planner/runtime-service.js";
import { PreparationContractError } from "../funding/preparation/core-adapter.js";
import { WithdrawalDestinationError } from "../funding/execution/withdrawal-destination-runtime.js";
import { cancelFundingOperationForUser } from "../funding/reconciliation/funding-operation-cancellation.js";
import {
  FundingPersistenceError,
  type FundingOperationRow,
} from "../funding/persistence/funding-operation-repository.js";
import {
  fetchFundingConsumerReservationForUser,
  type FundingConsumerReservation,
} from "../funding/persistence/funding-evidence-repository.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import {
  fundingApiErrorResponseSchema,
  fundingCommitRequestSchema,
  fundingDestinationsQuerySchema,
  fundingDestinationsResponseSchema,
  fundingLiquidityResponseSchema,
  fundingDiscoveryRequestSchema,
  fundingOperationParamsSchema,
  fundingOperationActionParamsSchema,
  fundingOperationActionPrepareResponseSchema,
  fundingOperationActionReportRequestSchema,
  fundingOperationActionReportResponseSchema,
  fundingOperationResponseSchema,
  fundingOperationsQuerySchema,
  fundingOperationsResponseSchema,
  fundingQuoteRequestSchema,
  fundingQuoteResponseSchema,
  fundingPreparationInspectRequestSchema,
  fundingPreparationInspectResponseSchema,
  fundingPreparationPrepareRequestSchema,
  fundingPreparationPrepareResponseSchema,
  fundingValidationErrorResponseSchema,
  fundingWithdrawalDestinationParamsSchema,
  fundingWithdrawalDestinationRequestSchema,
  fundingWithdrawalDestinationResponseSchema,
  fundingWithdrawalDestinationRevokeResponseSchema,
} from "../schemas/funding.js";

type FundingDestinationQuery = Readonly<{
  purpose: "fund" | "buy" | "sell" | "redeem" | "withdraw";
  marketContextId?: string | null;
  marketClass?: string | null;
}>;

export type FundingRouteDependencies = Readonly<{
  authenticate: preHandlerHookHandler;
  rateLimit(userId: string, endpoint: string): Promise<boolean>;
  registerWithdrawalDestination(
    userId: string,
    request: Readonly<{
      asset: Readonly<{
        networkId: string;
        assetId: string;
        decimals: number;
      }>;
      address: string;
    }>,
  ): Promise<
    Readonly<{
      recipientId: string;
      networkId: string;
      asset: Readonly<{
        networkId: string;
        assetId: string;
        decimals: number;
      }>;
      safeAddress: string;
      addressFingerprint: string;
      validatedAt: string;
      expiresAt: string;
      validationPolicyVersion: number;
      replayed: boolean;
    }>
  >;
  revokeWithdrawalDestination(
    userId: string,
    recipientId: string,
  ): Promise<
    Readonly<{
      recipientId: string;
      revoked: true;
      revokedAt: string | null;
    }>
  >;
  destinations(
    userId: string,
    query: FundingDestinationQuery,
  ): Promise<readonly FundingDestinationOption[]>;
  inspectPreparation(
    userId: string,
    request: Readonly<{
      venueBindingOptionId: string;
      purpose: PreparationPurpose;
      marketContextId: string | null;
      marketClass: string | null;
    }>,
  ): Promise<PreparationResult>;
  prepare(
    userId: string,
    request: Readonly<{
      venueBindingOptionId: string;
      purpose: PreparationPurpose;
      marketContextId: string | null;
      marketClass: string | null;
      operationId: string;
      expectedInspectionRevision: string;
    }>,
  ): Promise<readonly NormalizedAction[]>;
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
  consumerReservation(
    userId: string,
    operationId: string,
  ): Promise<FundingConsumerReservation | null>;
  operations(
    userId: string,
    input: Readonly<{ limit: number; before: Date | null }>,
  ): Promise<readonly FundingOperationRow[]>;
  cancelOperation(
    userId: string,
    operationId: string,
  ): Promise<FundingOperationRow>;
  prepareOperationAction(
    userId: string,
    input: Readonly<{ operationId: string; stepId: string }>,
  ): Promise<
    Readonly<{
      attemptId: string;
      action: NormalizedAction;
      actionFingerprint: string;
      executorId: string;
      executionMode: "web_client" | "privy_authorization";
      payerRequirement: "user" | "privy_sponsor";
      sponsorshipPolicyId: string | null;
    }>
  >;
  reportOperationAction(
    userId: string,
    input: Readonly<{
      operationId: string;
      stepId: string;
      attemptId: string;
      outcome: "submitted" | "ambiguous" | "failed" | "cancelled";
      transactionReference: string | null;
      actualCosts: Readonly<{ networkFeeRaw: string | null }>;
    }>,
  ): Promise<
    Readonly<{
      accepted: true;
      stepState: "submitted" | "reconcile_required" | "failed" | "cancelled";
    }>
  >;
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

function publicConsumerReservation(
  reservation: FundingConsumerReservation | null,
) {
  return reservation
    ? {
        operationId: reservation.operationId,
        reservationId: reservation.reservationId,
        rawAmount: reservation.rawAmount,
        asset: reservation.asset,
        expiresAt: reservation.expiresAt.toISOString(),
      }
    : null;
}

function errorStatus(error: unknown): number {
  if (error instanceof WithdrawalDestinationError) {
    if (error.code === "withdrawal_destination_not_found") return 404;
    if (error.code === "withdrawal_destination_expired") return 410;
    if (error.code === "withdrawal_destination_policy_disabled") return 503;
    if (error.code === "withdrawal_destination_unsupported") return 409;
    return 400;
  }
  if (error instanceof PreparationContractError) {
    if (error.code === "binding_mismatch") return 404;
    if (error.code === "evidence_expired") return 410;
    if (error.code === "evidence_stale") return 409;
    if (
      error.code === "preparation_unavailable" ||
      error.code === "unsupported_market_class"
    ) {
      return 409;
    }
    return 400;
  }
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
    error instanceof FundingPersistenceError ||
    error instanceof PreparationContractError ||
    error instanceof WithdrawalDestinationError
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

  z.post(
    "/funding/withdrawal-destinations",
    {
      preHandler: dependencies.authenticate,
      schema: {
        body: fundingWithdrawalDestinationRequestSchema,
        response: {
          200: fundingWithdrawalDestinationResponseSchema,
          ...errors,
        },
      },
    },
    (request, reply) =>
      handleFundingRequest(
        request,
        reply,
        dependencies,
        {
          endpoint: "withdrawal-destination-register",
          logMessage: "Funding withdrawal destination registration failed",
          publicError: "Withdrawal destination could not be registered",
        },
        async (userId) => {
          const destination = await dependencies.registerWithdrawalDestination(
            userId,
            request.body,
          );
          return reply.send(
            fundingWithdrawalDestinationResponseSchema.parse({
              ok: true,
              ...destination,
            }),
          );
        },
      ),
  );

  z.delete(
    "/funding/withdrawal-destinations/:id",
    {
      preHandler: dependencies.authenticate,
      schema: {
        params: fundingWithdrawalDestinationParamsSchema,
        response: {
          200: fundingWithdrawalDestinationRevokeResponseSchema,
          ...errors,
        },
      },
    },
    (request, reply) =>
      handleFundingRequest(
        request,
        reply,
        dependencies,
        {
          endpoint: "withdrawal-destination-revoke",
          logMessage: "Funding withdrawal destination revocation failed",
          publicError: "Withdrawal destination could not be revoked",
        },
        async (userId) => {
          const destination = await dependencies.revokeWithdrawalDestination(
            userId,
            request.params.id,
          );
          return reply.send(
            fundingWithdrawalDestinationRevokeResponseSchema.parse({
              ok: true,
              ...destination,
            }),
          );
        },
      ),
  );

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
    "/funding/operations/:id/actions/:stepId/prepare",
    {
      preHandler: dependencies.authenticate,
      schema: {
        params: fundingOperationActionParamsSchema,
        response: {
          200: fundingOperationActionPrepareResponseSchema,
          ...errors,
        },
      },
    },
    (request, reply) =>
      handleFundingRequest(
        request,
        reply,
        dependencies,
        {
          endpoint: "operation-action-prepare",
          logMessage: "Funding operation action prepare failed",
          publicError: "Funding action could not be prepared",
        },
        async (userId) => {
          const prepared = await dependencies.prepareOperationAction(userId, {
            operationId: request.params.id,
            stepId: request.params.stepId,
          });
          return reply.send(
            fundingOperationActionPrepareResponseSchema.parse({
              ok: true,
              ...prepared,
            }),
          );
        },
      ),
  );

  z.post(
    "/funding/operations/:id/actions/:stepId/report",
    {
      preHandler: dependencies.authenticate,
      schema: {
        params: fundingOperationActionParamsSchema,
        body: fundingOperationActionReportRequestSchema,
        response: {
          200: fundingOperationActionReportResponseSchema,
          ...errors,
        },
      },
    },
    (request, reply) =>
      handleFundingRequest(
        request,
        reply,
        dependencies,
        {
          endpoint: "operation-action-report",
          logMessage: "Funding operation action report failed",
          publicError: "Funding action report could not be recorded",
        },
        async (userId) => {
          const reported = await dependencies.reportOperationAction(userId, {
            operationId: request.params.id,
            stepId: request.params.stepId,
            ...request.body,
          });
          return reply.send(
            fundingOperationActionReportResponseSchema.parse({
              ok: true,
              ...reported,
            }),
          );
        },
      ),
  );

  z.post(
    "/funding/preparation/inspect",
    {
      preHandler: dependencies.authenticate,
      schema: {
        body: fundingPreparationInspectRequestSchema,
        response: {
          200: fundingPreparationInspectResponseSchema,
          ...errors,
        },
      },
    },
    (request, reply) =>
      handleFundingRequest(
        request,
        reply,
        dependencies,
        {
          endpoint: "preparation-inspect",
          logMessage: "Funding preparation inspection failed",
          publicError: "Wallet preparation could not be inspected",
        },
        async (userId) => {
          const preparation = await dependencies.inspectPreparation(
            userId,
            request.body,
          );
          return reply.send(
            fundingPreparationInspectResponseSchema.parse({
              ok: true,
              preparation,
            }),
          );
        },
      ),
  );

  z.post(
    "/funding/preparation/prepare",
    {
      preHandler: dependencies.authenticate,
      schema: {
        body: fundingPreparationPrepareRequestSchema,
        response: {
          200: fundingPreparationPrepareResponseSchema,
          ...errors,
        },
      },
    },
    (request, reply) =>
      handleFundingRequest(
        request,
        reply,
        dependencies,
        {
          endpoint: "preparation-prepare",
          logMessage: "Funding preparation action construction failed",
          publicError: "Wallet preparation actions could not be constructed",
        },
        async (userId) => {
          const actions = await dependencies.prepare(userId, request.body);
          return reply.send(
            fundingPreparationPrepareResponseSchema.parse({
              ok: true,
              actions,
            }),
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

  z.post(
    "/funding/operations/:id/cancel",
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
          endpoint: "cancel",
          logMessage: "Funding operation cancellation failed",
          publicError: "Funding operation could not be cancelled",
        },
        async (userId) => {
          const operation = await dependencies.cancelOperation(
            userId,
            request.params.id,
          );
          return reply.send({
            ok: true,
            operation: publicOperation(operation),
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
            consumerReservation: publicConsumerReservation(
              await dependencies.consumerReservation(userId, request.params.id),
            ),
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
    destinations: (userId, query) => runtime.destinations(userId, query),
    registerWithdrawalDestination: (userId, request) =>
      runtime.registerWithdrawalDestination(userId, request),
    revokeWithdrawalDestination: (userId, recipientId) =>
      runtime.revokeWithdrawalDestination(userId, recipientId),
    inspectPreparation: (userId, request) =>
      runtime.inspectPreparation(userId, request),
    prepare: (userId, request) => runtime.prepare(userId, request),
    liquidity: (userId, request) => runtime.liquidity(userId, request),
    quote: (userId, request) => runtime.quote(userId, request),
    commit: (userId, request) => runtime.commit(userId, request),
    operation: (userId, operationId) => runtime.operation(userId, operationId),
    consumerReservation: (userId, operationId) =>
      fetchFundingConsumerReservationForUser(pool, {
        userId,
        operationId,
      }),
    operations: (userId, input) => runtime.operations(userId, input),
    cancelOperation: (userId, operationId) =>
      cancelFundingOperationForUser(pool, { userId, operationId }),
    prepareOperationAction: (userId, input) =>
      runtime.prepareOperationAction(userId, input),
    reportOperationAction: (userId, input) =>
      runtime.reportOperationAction(userId, input),
  });
};
