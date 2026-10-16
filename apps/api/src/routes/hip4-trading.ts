import type {
  FastifyInstance,
  FastifyPluginAsync,
  preHandlerHookHandler,
} from "fastify";
import type { Pool } from "@hunch/infra";
import { z } from "zod";
import {
  hip4TradingQuoteSchema,
  hip4TradingMarketQuoteSchema,
  hip4TradingPreparationSchema,
  hip4TradingSubmissionSchema,
  hip4TradingRouteSchemas,
  hip4TradingReadRouteSchemas,
} from "../schemas/hip4-trading.js";
import {
  quoteHip4OrderWithCurrentContext,
  quoteHip4MarketOrderWithCurrentContext,
  prepareHip4OrderWithCurrentContext,
  prepareHip4CancelWithCurrentContext,
  submitHip4OrderWithCurrentContext,
  submitHip4CancelWithCurrentContext,
  type Hip4OrderRuntimeDependencies,
} from "../services/hip4-order-runtime.js";
import { prepareHip4TradeSigning } from "../services/hip4-trade-signing.js";
import { readHip4OrderSubmissionAttempt } from "../repos/hip4-order-admission.js";
import {
  readHip4OrderRecovery,
  abandonHip4OrderPreparation,
} from "../repos/hip4-order-recovery.js";
import { TelegramAppHandoffV2DirectTradeError } from "../repos/telegram-app-handoff-v2-direct-trade-repository.js";
import { TelegramAppHandoffError } from "../services/telegram-app-handoff.js";
import { recheckHip4OwnedOrder } from "../services/hip4-owned-order-recheck.js";

// Exact constants only: transport/SQL/SDK errors can contain a signature or URL.
const conflicts = new Set([
  "hip4_lifecycle_disabled",
  "hip4_controller_changed",
  "hip4_controller_unavailable",
  "hip4_submission_conflict",
  "hip4_preparation_conflict",
  "hip4_preparation_expired",
  "hip4_preparation_unavailable",
  "hip4_fee_preparation_required",
  "hip4_fee_consent_changed",
  "hip4_market_unavailable",
  "hip4_fee_market_unavailable",
  "hip4_current_amounts_invalid",
  "hip4_capacity_reserved",
  "hip4_capacity_unavailable",
  "hip4_capacity_identity_changed",
  "hip4_funding_buy_required",
  "hip4_funding_scope_changed",
  "hip4_funding_destination_changed",
  "hip4_funding_reservation_unavailable",
  "hip4_funding_reconciliation_required",
  "native_cash_mode_unsupported",
  "native_account_role_unsupported",
  "hip4_preparation_buy_below_minimum",
  "hip4_preparation_consented_debit_exceeded",
  "hip4_market_book_stale",
  "hip4_market_no_liquidity",
]);
const invalidRequests = new Set([
  "hip4_trade_signature_invalid",
  "hip4_cancel_preparation_identity_invalid",
  "hip4_order_preparation_identity_invalid",
  "hip4_handoff_binding_invalid",
  "hip4_handoff_order_required",
  "hip4_preparation_invalid_order_amount",
  "hip4_preparation_invalid_order_type",
  "hip4_preparation_price_out_of_range",
  "hip4_preparation_quantity_below_lot",
  "hip4_preparation_fee_exceeds_proceeds",
]);
export function hip4TradingRouteError(error: unknown): {
  status: 400 | 404 | 409 | 503;
  error: string;
} {
  const message = error instanceof Error ? error.message : "";
  if (
    error instanceof TelegramAppHandoffV2DirectTradeError ||
    error instanceof TelegramAppHandoffError
  )
    return { status: 409, error: "hip4_handoff_changed" };
  // HTTP body validation runs before this handler. A later Zod failure can be
  // malformed provider/DB data or a response-contract bug, not a client error.
  if (invalidRequests.has(message))
    return { status: 400, error: "invalid_trade_request" };
  if (
    message === "hip4_preparation_not_found" ||
    message === "hip4_cancel_order_not_found"
  )
    return { status: 404, error: "trade_preparation_not_found" };
  if (conflicts.has(message)) return { status: 409, error: message };
  return { status: 503, error: "trade_temporarily_unavailable" };
}

function preparationDto(
  prepared: Awaited<ReturnType<typeof prepareHip4OrderWithCurrentContext>>,
) {
  const signing = prepareHip4TradeSigning(prepared.envelope);
  const profile = z
    .object({ address: z.string() })
    .parse(prepared.snapshot.profile);
  if (signing.expiresAfter === null)
    throw new Error("missing_preparation_expiry");
  return hip4TradingPreparationSchema.parse({
    actionId: prepared.actionId,
    orderId: prepared.orderId,
    cloid: prepared.cloid,
    state: prepared.state,
    signerAddress: profile.address.toLowerCase(),
    environment: signing.environment,
    action: signing.action,
    nonce: signing.nonce,
    expiresAt: new Date(signing.expiresAfter).toISOString(),
    typedData: signing.typedData,
    amounts: prepared.snapshot.amounts ?? null,
    fees: prepared.snapshot.feeQuote ?? null,
  });
}
function submissionDto(
  result: Awaited<ReturnType<typeof submitHip4OrderWithCurrentContext>>,
) {
  return hip4TradingSubmissionSchema.parse({
    actionId: result.submission.action_id,
    orderId: result.orderId,
    state: result.submission.state,
    replayed: result.replayed,
    reconciliationRequired: result.submission.state !== "rejected",
  });
}

/** Thin venue HTTP adapter, like the existing /trade/limitless surface. All
 * financial authority remains in the common native runtime/admission path. */
export function registerHip4TradingRoutes(
  app: FastifyInstance,
  deps: {
    pool: Pool;
    authorize: preHandlerHookHandler;
    runtime?: Hip4OrderRuntimeDependencies;
  },
) {
  const options = {
    preHandler: deps.authorize,
    onRequest: async (
      _request: unknown,
      reply: import("fastify").FastifyReply,
    ) => {
      reply.header("Cache-Control", "private, no-store");
    },
  };
  app.get<{ Params: { actionId: string } }>(
    "/orders/actions/:actionId",
    {
      ...options,
      schema: hip4TradingReadRouteSchemas["/orders/actions/:actionId"],
    },
    async (request, reply) => {
      if (!request.user)
        return reply.code(401).send({ error: "account_not_authenticated" });
      try {
        return await readHip4OrderRecovery(deps.pool, {
          userId: request.user.id,
          actionId: request.params.actionId,
        });
      } catch (error) {
        const failure = hip4TradingRouteError(error);
        return reply.code(failure.status).send({ error: failure.error });
      }
    },
  );
  function post<Body extends z.ZodType, Response extends z.ZodType>(
    path: string,
    schema: { body: Body; response: { 200: Response } },
    handler: (
      userId: string,
      body: z.output<Body>,
    ) => Promise<z.output<Response>>,
  ) {
    const body = schema.body,
      response = schema.response[200];
    app.post<{ Body: z.output<Body> }>(
      path,
      {
        ...options,
        schema,
      },
      async (request, reply) => {
        reply.header("Cache-Control", "private, no-store");
        if (!request.user)
          return reply.code(401).send({ error: "account_not_authenticated" });
        try {
          return response.parse(
            await handler(request.user.id, body.parse(request.body)),
          );
        } catch (error) {
          const failure = hip4TradingRouteError(error);
          return reply.code(failure.status).send({ error: failure.error });
        }
      },
    );
  }
  post(
    "/orders/market-quote",
    hip4TradingRouteSchemas["/orders/market-quote"],
    async (userId, request) => {
      const quoted = await quoteHip4MarketOrderWithCurrentContext(
        deps.pool,
        { userId, actor: "web_app", request },
        deps.runtime,
      );
      return hip4TradingMarketQuoteSchema.parse({
        amounts: quoted.amounts,
        fees: quoted.feeQuote,
        providerCapacity: { ...quoted.capacity, includesHunchHolds: false },
        expiresAt: new Date(quoted.expiresAfter).toISOString(),
        preparationRequest: quoted.preparationRequest,
        executionEstimate: quoted.executionEstimate,
      });
    },
  );
  post(
    "/orders/abandon",
    hip4TradingRouteSchemas["/orders/abandon"],
    (userId, body) =>
      abandonHip4OrderPreparation(deps.pool, {
        userId,
        actionId: body.actionId,
      }),
  );
  post(
    "/orders/recheck",
    hip4TradingRouteSchemas["/orders/recheck"],
    (userId, body) =>
      recheckHip4OwnedOrder(
        deps.pool,
        { userId, actionId: body.actionId },
        deps.runtime?.fetcher,
      ),
  );
  post(
    "/orders/quote",
    hip4TradingRouteSchemas["/orders/quote"],
    async (userId, request) => {
      const quoted = await quoteHip4OrderWithCurrentContext(
        deps.pool,
        { userId, actor: "web_app", request },
        deps.runtime,
      );
      return hip4TradingQuoteSchema.parse({
        amounts: quoted.amounts,
        fees: quoted.feeQuote,
        providerCapacity: { ...quoted.capacity, includesHunchHolds: false },
        expiresAt: new Date(quoted.expiresAfter).toISOString(),
      });
    },
  );
  post(
    "/orders/prepare",
    hip4TradingRouteSchemas["/orders/prepare"],
    async (userId, request) =>
      preparationDto(
        await prepareHip4OrderWithCurrentContext(
          deps.pool,
          { userId, actor: "web_app", request },
          deps.runtime,
        ),
      ),
  );
  post(
    "/orders/submit",
    hip4TradingRouteSchemas["/orders/submit"],
    async (userId, body) => {
      const input = { ...body, userId, actor: "web_app" as const };
      const { row } = await readHip4OrderSubmissionAttempt(deps.pool, input);
      if (row.unsigned_envelope.action.type !== "order")
        throw new Error("hip4_order_preparation_identity_invalid");
      return submissionDto(
        await submitHip4OrderWithCurrentContext(deps.pool, input, {
          ...deps.runtime,
          telegramAppHandoffScope: deps.runtime?.telegramAppHandoffScope,
        }),
      );
    },
  );
  post(
    "/orders/cancel/prepare",
    hip4TradingRouteSchemas["/orders/cancel/prepare"],
    async (userId, request) =>
      preparationDto(
        await prepareHip4CancelWithCurrentContext(
          deps.pool,
          { userId, actor: "web_app", request },
          deps.runtime,
        ),
      ),
  );
  post(
    "/orders/cancel/submit",
    hip4TradingRouteSchemas["/orders/cancel/submit"],
    async (userId, body) =>
      submissionDto(
        await submitHip4CancelWithCurrentContext(
          deps.pool,
          { ...body, userId, actor: "web_app" },
          deps.runtime,
        ),
      ),
  );
}

export const hip4TradingRoutes: FastifyPluginAsync = async (app) => {
  const [
    { pool },
    { createAuthMiddleware },
    { telegramAppHandoffV2CurrentScope },
  ] = await Promise.all([
    import("../db.js"),
    import("../auth.js"),
    import("../services/telegram-bot-trading.js"),
  ]);
  registerHip4TradingRoutes(app, {
    pool,
    authorize: createAuthMiddleware(),
    runtime: { telegramAppHandoffScope: telegramAppHandoffV2CurrentScope },
  });
};
