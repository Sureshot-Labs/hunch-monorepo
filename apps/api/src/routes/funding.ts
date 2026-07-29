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
import {
  FundingReceiveSessionService,
  type FundingReceiveSessionResponse,
  type OpenFundingReceiveSessionRequest,
} from "../funding/receive/receive-session-service.js";
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
  type FundingOperationStep,
} from "../funding/persistence/funding-evidence-repository.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import {
  fundingApiErrorResponseSchema,
  fundingCommitRequestSchema,
  fundingCapabilitiesResponseSchema,
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
  fundingReceiveSessionOpenRequestSchema,
  fundingReceiveReceiptParamsSchema,
  fundingReceiveReceiptReviewQuoteResponseSchema,
  fundingReceiveSessionParamsSchema,
  fundingReceiveSessionResponseSchema,
  fundingValidationErrorResponseSchema,
  fundingWithdrawalDestinationParamsSchema,
  fundingWithdrawalDestinationRequestSchema,
  fundingWithdrawalDestinationResponseSchema,
  fundingWithdrawalDestinationRevokeResponseSchema,
  externalIngressInstructionSchema,
} from "../schemas/funding.js";

type FundingDestinationQuery = Readonly<{
  purpose: "fund" | "buy" | "sell" | "redeem" | "withdraw";
  marketContextId?: string | null;
  marketClass?: string | null;
  positionActionRef?: string | null;
  controllerWalletRef?: string | null;
}>;

export type FundingRouteDependencies = Readonly<{
  authenticate: preHandlerHookHandler;
  rateLimit(userId: string, endpoint: string): Promise<boolean>;
  capabilities(): Promise<
    Readonly<{
      fundingApiVersion: 1;
      receiveSessionsVersion: 1;
      creationMode: "off" | "on";
      supportedActionKinds: readonly (
        | "add_funds"
        | "trade_shortfall"
        | "convert_asset"
        | "withdrawal"
        | "redeem"
      )[];
    }>
  >;
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
      positionActionRef?: string | null;
      controllerWalletRef?: string | null;
    }>,
  ): Promise<PreparationResult>;
  prepare(
    userId: string,
    request: Readonly<{
      venueBindingOptionId: string;
      purpose: PreparationPurpose;
      marketContextId: string | null;
      marketClass: string | null;
      positionActionRef?: string | null;
      controllerWalletRef?: string | null;
      operationId: string;
      expectedInspectionRevision: string;
    }>,
  ): Promise<
    Readonly<{
      actions: readonly NormalizedAction[];
      controllerWalletRef: string;
    }>
  >;
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
  operationSteps(
    userId: string,
    operationId: string,
  ): Promise<readonly FundingOperationStep[]>;
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
      controllerWalletRef: string;
      executorId: string;
      executionMode: "web_client" | "privy_authorization" | "venue_relayer";
      payerRequirement: "user" | "privy_sponsor" | "provider";
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
  openReceiveSession(
    userId: string,
    request: OpenFundingReceiveSessionRequest,
  ): Promise<FundingReceiveSessionResponse>;
  receiveSession(
    userId: string,
    receiveSessionId: string,
  ): Promise<FundingReceiveSessionResponse | null>;
  cancelReceiveSession(
    userId: string,
    receiveSessionId: string,
  ): Promise<FundingReceiveSessionResponse | null>;
  reviewReceiveReceipt(
    userId: string,
    receiveSessionId: string,
    receiptId: string,
  ): ReturnType<FundingReceiveSessionService["reviewQuote"]>;
  commitReceiveReceiptReview(
    userId: string,
    receiveSessionId: string,
    receiptId: string,
    request: FundingCommitRequest,
  ): Promise<Readonly<{ operation: FundingOperationRow; replayed: boolean }>>;
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

function publicIngress(operation: FundingOperationRow) {
  const parsed = externalIngressInstructionSchema.safeParse(
    operation.sourceSnapshot?.ingress,
  );
  return parsed.success ? parsed.data : null;
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

function publicOperationStep(step: FundingOperationStep) {
  return {
    stepId: step.id,
    ordinal: step.ordinal,
    kind: step.stepKind,
    state: step.state,
    dependsOnStepId: step.dependsOnStepId,
    dependencyState: step.dependencyState,
    actionable:
      step.state === "action_required" &&
      (step.dependsOnStepId === null || step.dependencyState === "succeeded"),
  };
}

function publicOperationSteps(steps: readonly FundingOperationStep[]) {
  return steps
    .filter(
      (step) =>
        !(
          step.state === "planned" &&
          step.actionValidationResult.activation === "after_verified_ingress"
        ),
    )
    .map(publicOperationStep);
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
    if (
      error.code === "invalid_policy" ||
      error.code === "provider_unavailable"
    ) {
      return 503;
    }
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
    request.log.error({ err: error, userId }, input.logMessage);
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
    "/funding/capabilities",
    {
      preHandler: dependencies.authenticate,
      schema: {
        response: { 200: fundingCapabilitiesResponseSchema, ...errors },
      },
    },
    (request, reply) =>
      handleFundingRequest(
        request,
        reply,
        dependencies,
        {
          endpoint: "capabilities",
          logMessage: "Funding capabilities failed",
          publicError: "Funding capabilities are unavailable",
        },
        async () => {
          const capabilities = await dependencies.capabilities();
          return reply.send(
            fundingCapabilitiesResponseSchema.parse({
              ok: true,
              ...capabilities,
            }),
          );
        },
      ),
  );

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
    "/funding/receive-sessions",
    {
      preHandler: dependencies.authenticate,
      schema: {
        body: fundingReceiveSessionOpenRequestSchema,
        response: { 200: fundingReceiveSessionResponseSchema, ...errors },
      },
    },
    (request, reply) =>
      handleFundingRequest(
        request,
        reply,
        dependencies,
        {
          endpoint: "receive-session-open",
          logMessage: "Funding receive session open failed",
          publicError: "Receive options could not be prepared",
        },
        async (userId) => {
          const opened = await dependencies.openReceiveSession(
            userId,
            request.body,
          );
          return reply.send(
            fundingReceiveSessionResponseSchema.parse({
              ok: true,
              ...opened,
            }),
          );
        },
      ),
  );

  z.get(
    "/funding/receive-sessions/:id",
    {
      preHandler: dependencies.authenticate,
      schema: {
        params: fundingReceiveSessionParamsSchema,
        response: { 200: fundingReceiveSessionResponseSchema, ...errors },
      },
    },
    (request, reply) =>
      handleFundingRequest(
        request,
        reply,
        dependencies,
        {
          endpoint: "receive-session-read",
          logMessage: "Funding receive session read failed",
          publicError: "Receive status could not be read",
        },
        async (userId) => {
          const found = await dependencies.receiveSession(
            userId,
            request.params.id,
          );
          if (!found) {
            return reply.code(404).send({
              error: "Receive session not found",
              code: "receive_session_not_found",
            });
          }
          return reply.send(
            fundingReceiveSessionResponseSchema.parse({
              ok: true,
              ...found,
            }),
          );
        },
      ),
  );

  z.post(
    "/funding/receive-sessions/:id/cancel",
    {
      preHandler: dependencies.authenticate,
      schema: {
        params: fundingReceiveSessionParamsSchema,
        response: { 200: fundingReceiveSessionResponseSchema, ...errors },
      },
    },
    (request, reply) =>
      handleFundingRequest(
        request,
        reply,
        dependencies,
        {
          endpoint: "receive-session-cancel",
          logMessage: "Funding receive session cancellation failed",
          publicError: "Receive session could not be cancelled",
        },
        async (userId) => {
          const cancelled = await dependencies.cancelReceiveSession(
            userId,
            request.params.id,
          );
          if (!cancelled) {
            return reply.code(409).send({
              error: "Receive session can no longer be cancelled",
              code: "receive_session_not_cancellable",
            });
          }
          return reply.send(
            fundingReceiveSessionResponseSchema.parse({
              ok: true,
              ...cancelled,
            }),
          );
        },
      ),
  );

  z.post(
    "/funding/receive-sessions/:id/receipts/:receiptId/quote",
    {
      preHandler: dependencies.authenticate,
      schema: {
        params: fundingReceiveReceiptParamsSchema,
        response: {
          200: fundingReceiveReceiptReviewQuoteResponseSchema,
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
          endpoint: "receive-receipt-review-quote",
          logMessage: "Funding receive receipt review quote failed",
          publicError: "Conversion review could not be prepared",
        },
        async (userId) => {
          const reviewed = await dependencies.reviewReceiveReceipt(
            userId,
            request.params.id,
            request.params.receiptId,
          );
          return reply.send(
            fundingReceiveReceiptReviewQuoteResponseSchema.parse({
              ok: true,
              ...reviewed,
            }),
          );
        },
      ),
  );

  z.post(
    "/funding/receive-sessions/:id/receipts/:receiptId/commit",
    {
      preHandler: dependencies.authenticate,
      schema: {
        params: fundingReceiveReceiptParamsSchema,
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
          endpoint: "receive-receipt-review-commit",
          logMessage: "Funding receive receipt review commit failed",
          publicError: "Reviewed conversion could not be started",
        },
        async (userId) => {
          const committed = await dependencies.commitReceiveReceiptReview(
            userId,
            request.params.id,
            request.params.receiptId,
            request.body,
          );
          return reply.send({
            ok: true,
            operation: publicOperation(committed.operation),
            steps: publicOperationSteps(
              await dependencies.operationSteps(userId, committed.operation.id),
            ),
            ingress: publicIngress(committed.operation),
            replayed: committed.replayed,
          });
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
          const prepared = await dependencies.prepare(userId, request.body);
          return reply.send(
            fundingPreparationPrepareResponseSchema.parse({
              ok: true,
              ...prepared,
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
            steps: publicOperationSteps(
              await dependencies.operationSteps(userId, committed.operation.id),
            ),
            ingress: publicIngress(committed.operation),
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
            steps: publicOperationSteps(
              await dependencies.operationSteps(userId, operation.id),
            ),
            ingress: publicIngress(operation),
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
            steps: publicOperationSteps(
              await dependencies.operationSteps(userId, operation.id),
            ),
            ingress: publicIngress(operation),
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
  const receiveSessions = new FundingReceiveSessionService(pool);
  registerFundingRoutes(app, {
    authenticate: createAuthMiddleware(),
    rateLimit: (userId, endpoint) =>
      checkRateLimit(`funding:${endpoint}:${userId}`, 30, 60_000, {
        onError: "fail_closed",
      }),
    capabilities: () => runtime.capabilities(),
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
    operationSteps: (userId, operationId) =>
      runtime.operationSteps(userId, operationId),
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
    openReceiveSession: (userId, request) =>
      receiveSessions.open(userId, request),
    receiveSession: (userId, receiveSessionId) =>
      receiveSessions.get(userId, receiveSessionId),
    cancelReceiveSession: (userId, receiveSessionId) =>
      receiveSessions.cancel(userId, receiveSessionId),
    reviewReceiveReceipt: (userId, receiveSessionId, receiptId) =>
      receiveSessions.reviewQuote(userId, receiveSessionId, receiptId),
    commitReceiveReceiptReview: (
      userId,
      receiveSessionId,
      receiptId,
      request,
    ) =>
      receiveSessions.commitReview(
        userId,
        receiveSessionId,
        receiptId,
        request,
      ),
  });
};
