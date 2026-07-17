import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ethers } from "ethers";
import { AuthService, createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { getRedis } from "../redis.js";
import { normalizeLimitlessRawTokenId } from "../lib/limitless-token.js";
import { canonicalMarketTokenIdSql } from "../repos/canonical-market-token-sql.js";
import {
  isLimitlessPartnerHmacConfigured,
  type LimitlessRequestAuthInputs,
} from "../services/limitless-client.js";
import {
  buildLimitlessRequestAuthInputs,
  loadLimitlessProfileForWallet,
  resolveLimitlessAuthContext,
  verifyLimitlessAuthContext,
} from "../services/limitless-auth.js";
import {
  buildLimitlessRedemptionPlanRoute,
  cancelAllLimitlessOrdersRoute,
  cancelLimitlessOrderRoute,
  cancelLimitlessOrdersBatchRoute,
  connectLimitlessPartnerAccountRoute,
  fetchLimitlessAccountRoute,
  fetchLimitlessMarketExchangeRoute,
  fetchLimitlessOpenOrdersRoute,
  fetchLimitlessOrderRoute,
  fetchLimitlessRedemptionStatusRoute,
  fetchLimitlessSigningMessageRoute,
  quoteLimitlessAmmRoute,
  recordLimitlessAmmOrder,
  resolveLimitlessEmbeddedOrderSigningContext,
  submitLimitlessClientSignedOrder,
  syncLimitlessOpenOrdersRoute,
  syncLimitlessOrderHistoryRoute,
} from "../services/limitless-trading-execution-service.js";
import {
  buildEmbeddedLimitlessOrderTypedData,
  type LimitlessEmbeddedOrderPayload,
} from "../services/limitless-trading-service.js";
import {
  buildEmbeddedPersonalSignRequest,
  createEmbeddedPrivyWalletRpcRequest,
  executePreparedPrivySignatureRequest,
  findEmbeddedAuthorizationSignature,
  resolveEmbeddedPrivyWalletContext,
  type EmbeddedPrivyAuthorizationRequest,
} from "../services/embedded-privy.js";
import {
  buildEmbeddedExecutionSingleFlightKey,
  getEmbeddedExecutionSingleFlightPromise,
  runEmbeddedExecutionSingleFlight,
} from "../services/embedded-execution-singleflight.js";
import {
  limitlessAuthLoginBodySchema,
  limitlessAccountQuerySchema,
  limitlessAmmQuoteQuerySchema,
  limitlessAmmOrderBodySchema,
  limitlessCancelBatchBodySchema,
  limitlessClobQuoteQuerySchema,
  limitlessEmbeddedEnsureReadyBodySchema,
  limitlessEmbeddedEnsureReadyExecuteBodySchema,
  limitlessEmbeddedSignOrderExecuteBodySchema,
  limitlessEmbeddedSignOrderPrepareBodySchema,
  limitlessHistoryQuerySchema,
  limitlessMarketExchangeQuerySchema,
  limitlessOpenOrdersQuerySchema,
  limitlessOrderBodySchema,
  limitlessOrderIdParamsSchema,
  limitlessRedemptionPlanQuerySchema,
  limitlessRedemptionQuerySchema,
  limitlessSlugParamsSchema,
} from "../schemas/limitless-private.js";
import { quoteLimitlessClobMarket } from "../services/limitless-clob-quote.js";

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function toChecksumAddress(value: string): string | null {
  try {
    return ethers.getAddress(value.trim());
  } catch {
    return null;
  }
}

function mapLimitlessUpstreamStatus(status: number): number {
  if (status === 401 || status === 403) return 400;
  if (status >= 400 && status < 500) return status;
  return 502;
}

function buildEmbeddedLimitlessOrderRequest(inputs: {
  context: Awaited<ReturnType<typeof resolveEmbeddedPrivyWalletContext>>;
  payload: LimitlessEmbeddedOrderPayload;
  exchangeAddress: string;
}): EmbeddedPrivyAuthorizationRequest {
  const typedData = buildEmbeddedLimitlessOrderTypedData({
    signer: inputs.context.signer,
    payload: inputs.payload,
    exchangeAddress: inputs.exchangeAddress,
  });
  return createEmbeddedPrivyWalletRpcRequest({
    id: "limitless-order-signature",
    label: "Limitless order signature",
    walletId: inputs.context.walletId,
    body: {
      method: "eth_signTypedData_v4",
      params: {
        typed_data: {
          primary_type: typedData.primaryType,
          domain: typedData.domain,
          types: typedData.types,
          message: typedData.message,
        },
      },
    },
  });
}

async function prepareEmbeddedLimitlessOrderSigningRequest(inputs: {
  context: Awaited<ReturnType<typeof resolveEmbeddedPrivyWalletContext>>;
  marketSlug: string;
  requestAuth: LimitlessRequestAuthInputs;
  payload: LimitlessEmbeddedOrderPayload;
  signer: string;
  ownerId: number;
  exchangeAddress?: string | null;
}): Promise<{
  exchangeAddress: string;
  request: EmbeddedPrivyAuthorizationRequest;
}> {
  const providedExchangeAddress = inputs.exchangeAddress?.trim() ?? "";
  const resolvedExchangeAddress = providedExchangeAddress
    ? toChecksumAddress(providedExchangeAddress)
    : null;
  if (providedExchangeAddress && !resolvedExchangeAddress) {
    throw new Error("Embedded Limitless exchange address is invalid.");
  }
  const exchangeAddress =
    resolvedExchangeAddress ??
    (
      await resolveLimitlessEmbeddedOrderSigningContext({
        marketSlug: inputs.marketSlug,
        pool,
        requestAuth: inputs.requestAuth,
        payload: inputs.payload,
        signer: inputs.signer,
        ownerId: inputs.ownerId,
      })
    ).exchangeAddress;

  return {
    exchangeAddress,
    request: buildEmbeddedLimitlessOrderRequest({
      context: inputs.context,
      payload: inputs.payload,
      exchangeAddress,
    }),
  };
}

function getHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name.toLowerCase()];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw[0];
  return undefined;
}

function isEvmWallet(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

export const limitlessPrivateRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  const sendLimitlessUnavailable = (reply: FastifyReply) => {
    reply.code(503);
    return reply.send({ error: "Limitless is temporarily unavailable." });
  };

  z.get(
    "/clob/quote",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: limitlessClobQuoteQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;
      const { rows } = await pool.query<{
        token_no: string | null;
        token_yes: string | null;
      }>(
        `
          select
            ${canonicalMarketTokenIdSql("m", "YES")} as token_yes,
            ${canonicalMarketTokenIdSql("m", "NO")} as token_no
          from unified_markets m
          where m.venue = 'limitless'
            and m.slug = $1
          limit 1
        `,
        [query.slug],
      );
      const market = rows[0];
      const requestedTokenId = normalizeLimitlessRawTokenId(query.tokenId);
      const allowed = new Set(
        [market?.token_yes, market?.token_no]
          .filter((tokenId): tokenId is string => Boolean(tokenId))
          .map(normalizeLimitlessRawTokenId)
          .filter((tokenId): tokenId is string => tokenId != null),
      );
      if (!market || !requestedTokenId || !allowed.has(requestedTokenId)) {
        reply.code(400);
        return reply.send({ error: "tokenId does not belong to slug" });
      }

      return reply.send(
        await quoteLimitlessClobMarket({
          amountShares: query.amountShares,
          amountUsd: query.amountUsd,
          side: query.side,
          slug: query.slug,
          tokenId: requestedTokenId,
        }),
      );
    },
  );

  const requireLimitlessPartnerAuth = async (inputs: {
    reply: FastifyReply;
    userId: string;
    walletAddress: string;
  }) => {
    if (!isLimitlessPartnerHmacConfigured()) {
      sendLimitlessUnavailable(inputs.reply);
      return null;
    }

    const creds = await AuthService.getVenueCredentials(
      inputs.userId,
      "limitless",
      inputs.walletAddress,
    );
    const authContext = await resolveLimitlessAuthContext(
      inputs.userId,
      inputs.walletAddress,
    );

    if (!authContext || !creds) {
      inputs.reply.code(400);
      inputs.reply.send({
        error: "Connect Limitless for this wallet first.",
      });
      return null;
    }

    const verification = await verifyLimitlessAuthContext({
      authContext,
      walletAddress: inputs.walletAddress,
    });
    if (!verification.ok) {
      inputs.reply.code(mapLimitlessUpstreamStatus(verification.status));
      inputs.reply.send({
        error:
          verification.message ??
          "Limitless connection is invalid for the selected wallet.",
        status: verification.status,
        payload: verification.payload,
      });
      return null;
    }

    const profile = await loadLimitlessProfileForWallet({
      walletAddress: inputs.walletAddress,
      authContext,
      additionalData: creds.additionalData ?? null,
      baseProfile: verification.profile,
    });

    if (!profile?.id) {
      inputs.reply.code(400);
      inputs.reply.send({
        error: "Limitless profile mapping is missing for this wallet.",
      });
      return null;
    }

    return {
      creds,
      authContext,
      profile,
      requestAuth: buildLimitlessRequestAuthInputs(authContext),
    };
  };

  /**
   * GET /auth/signing-message
   */
  z.get(
    "/auth/signing-message",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      if (!request.user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const result = await fetchLimitlessSigningMessageRoute();
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );

  /**
   * POST /auth/login
   */
  z.post(
    "/auth/login",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: limitlessAuthLoginBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isEvmWallet(signer)) {
        reply.code(400);
        return reply.send({
          error: "Limitless login requires an EVM wallet address",
        });
      }

      const body = request.body;

      const headerAccount = getHeaderValue(request.headers, "x-account");
      const headerMessage = getHeaderValue(
        request.headers,
        "x-signing-message",
      );
      const headerSignature = getHeaderValue(request.headers, "x-signature");

      const account = headerAccount ?? body.account;
      const signingMessage = headerMessage ?? body.signingMessage;
      const signature = headerSignature ?? body.signature;

      if (!account || !signingMessage || !signature) {
        reply.code(400);
        return reply.send({
          error: "Missing x-account, x-signing-message, or x-signature",
        });
      }

      if (normalizeAddress(account) !== normalizeAddress(signer)) {
        reply.code(400);
        return reply.send({
          error: "x-account must match the selected wallet",
        });
      }

      const clientType = body.client ?? "eoa";
      if (!isLimitlessPartnerHmacConfigured()) {
        return sendLimitlessUnavailable(reply);
      }

      const result = await connectLimitlessPartnerAccountRoute({
        pool,
        log: app.log,
        userId: user.id,
        signer,
        account,
        signingMessage,
        signature,
        clientType,
      });

      if (!result.ok) {
        reply.code(result.httpStatus);
        return reply.send({
          error: result.error,
          ...(result.status != null ? { status: result.status } : {}),
          ...(result.payload !== undefined ? { payload: result.payload } : {}),
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result);
    },
  );

  z.post(
    "/embedded/ensure-ready/prepare",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: limitlessEmbeddedEnsureReadyBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      if (!isEvmWallet(signer)) {
        reply.code(400);
        return reply.send({
          error: "Embedded Limitless automation requires an EVM wallet address",
        });
      }
      if (!isLimitlessPartnerHmacConfigured()) {
        return sendLimitlessUnavailable(reply);
      }

      try {
        const context = await resolveEmbeddedPrivyWalletContext({
          user,
          signer,
          venueLabel: "Limitless",
        });
        const creds = await AuthService.getVenueCredentials(
          user.id,
          "limitless",
          signer,
        );
        const authContext = await resolveLimitlessAuthContext(user.id, signer);
        let connected = false;
        if (creds && authContext) {
          const verification = await verifyLimitlessAuthContext({
            authContext,
            walletAddress: signer,
          });
          connected = verification.ok;
        }

        if (connected) {
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send({
            ok: true,
            signer: context.signer,
            connected: true,
            requests: [],
          });
        }

        const signingMessageResult = await fetchLimitlessSigningMessageRoute();
        if (!signingMessageResult.ok) {
          reply.code(signingMessageResult.statusCode);
          return reply.send(signingMessageResult.payload);
        }
        const signingMessage =
          typeof signingMessageResult.payload.message === "string"
            ? signingMessageResult.payload.message
            : null;
        if (!signingMessage) {
          reply.code(502);
          return reply.send({
            error: "Limitless signing message invalid",
            payload: signingMessageResult.payload,
          });
        }

        const requests: EmbeddedPrivyAuthorizationRequest[] = [
          buildEmbeddedPersonalSignRequest({
            context,
            id: "limitless-connect",
            label: "Limitless connect",
            message: signingMessage,
          }),
        ];

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          signer: context.signer,
          connected: false,
          signingMessage,
          requests,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer },
          "Failed to prepare embedded Limitless readiness",
        );
        reply.code(500);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Embedded Limitless setup preparation failed",
        });
      }
    },
  );

  z.post(
    "/embedded/ensure-ready/execute",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: limitlessEmbeddedEnsureReadyExecuteBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      if (!isEvmWallet(signer)) {
        reply.code(400);
        return reply.send({
          error: "Embedded Limitless automation requires an EVM wallet address",
        });
      }
      if (!isLimitlessPartnerHmacConfigured()) {
        return sendLimitlessUnavailable(reply);
      }

      try {
        const lockKey = normalizeAddress(signer);
        const singleFlightKey = buildEmbeddedExecutionSingleFlightKey(
          "limitless-private",
          "embedded-ensure-ready",
          lockKey,
        );
        const existingExecution =
          getEmbeddedExecutionSingleFlightPromise<Record<string, unknown>>(
            singleFlightKey,
          );
        if (existingExecution) {
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send(await existingExecution);
        }

        const result = await runEmbeddedExecutionSingleFlight({
          key: singleFlightKey,
          redis: await getRedis(),
          run: async () => {
            const context = await resolveEmbeddedPrivyWalletContext({
              user,
              signer,
              venueLabel: "Limitless",
            });

            const connectRequest = buildEmbeddedPersonalSignRequest({
              context,
              id: "limitless-connect",
              label: "Limitless connect",
              message: request.body.signingMessage,
            });
            const authorizationSignature = findEmbeddedAuthorizationSignature(
              request.body.signedRequests,
              connectRequest.id,
            );
            const signature = await executePreparedPrivySignatureRequest({
              request: connectRequest,
              authorizationSignature,
            });

            const connectResult = await connectLimitlessPartnerAccountRoute({
              pool,
              log: app.log,
              userId: user.id,
              signer,
              account: context.signer,
              signingMessage: request.body.signingMessage,
              signature,
              clientType: "eoa",
            });

            if (!connectResult.ok) {
              throw Object.assign(new Error(connectResult.error), {
                responseStatus: connectResult.httpStatus,
                responsePayload: {
                  ...(connectResult.status != null
                    ? { status: connectResult.status }
                    : {}),
                  ...(connectResult.payload !== undefined
                    ? { payload: connectResult.payload }
                    : {}),
                },
              });
            }

            return {
              ok: true,
              signer: context.signer,
              connected: true,
              authMode: connectResult.authMode,
              profile: connectResult.profile,
            };
          },
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(result);
      } catch (error) {
        const status =
          typeof (error as { responseStatus?: unknown })?.responseStatus ===
          "number"
            ? ((error as { responseStatus: number }).responseStatus ?? 500)
            : 500;
        const payload =
          (error as { responsePayload?: unknown })?.responsePayload ??
          undefined;
        app.log.error(
          { error, userId: user.id, signer },
          "Failed to execute embedded Limitless readiness",
        );
        reply.code(status);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Embedded Limitless setup execution failed",
          ...(payload !== undefined
            ? (payload as Record<string, unknown>)
            : {}),
        });
      }
    },
  );

  z.post(
    "/embedded/sign-order/prepare",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        body: limitlessEmbeddedSignOrderPrepareBodySchema,
      },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      if (!isEvmWallet(signer)) {
        reply.code(400);
        return reply.send({
          error: "Embedded Limitless automation requires an EVM wallet address",
        });
      }

      try {
        const partnerAuth = await requireLimitlessPartnerAuth({
          reply,
          userId: user.id,
          walletAddress: signer,
        });
        if (!partnerAuth) return;

        const context = await resolveEmbeddedPrivyWalletContext({
          user,
          signer,
          venueLabel: "Limitless",
        });
        const ownerId = partnerAuth.profile.id;
        if (ownerId == null) {
          throw new Error(
            "Limitless profile mapping is missing for this wallet.",
          );
        }
        const prepared = await prepareEmbeddedLimitlessOrderSigningRequest({
          context,
          marketSlug: request.body.marketSlug,
          requestAuth: partnerAuth.requestAuth,
          payload: request.body.order as LimitlessEmbeddedOrderPayload,
          signer,
          ownerId,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          exchangeAddress: prepared.exchangeAddress,
          request: prepared.request,
        });
      } catch (error) {
        const status =
          typeof (error as { responseStatus?: unknown })?.responseStatus ===
          "number"
            ? ((error as { responseStatus: number }).responseStatus ?? 400)
            : 400;
        reply.code(status);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to prepare Limitless order signature",
          ...(((error as { responsePayload?: unknown })?.responsePayload ??
            undefined) as Record<string, unknown> | undefined),
        });
      }
    },
  );

  z.post(
    "/embedded/sign-order",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: limitlessEmbeddedSignOrderExecuteBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      if (!isEvmWallet(signer)) {
        reply.code(400);
        return reply.send({
          error: "Embedded Limitless automation requires an EVM wallet address",
        });
      }

      try {
        const partnerAuth = await requireLimitlessPartnerAuth({
          reply,
          userId: user.id,
          walletAddress: signer,
        });
        if (!partnerAuth) return;

        const context = await resolveEmbeddedPrivyWalletContext({
          user,
          signer,
          venueLabel: "Limitless",
        });
        const ownerId = partnerAuth.profile.id;
        if (ownerId == null) {
          throw new Error(
            "Limitless profile mapping is missing for this wallet.",
          );
        }
        const prepared = await prepareEmbeddedLimitlessOrderSigningRequest({
          context,
          marketSlug: request.body.marketSlug,
          requestAuth: partnerAuth.requestAuth,
          payload: request.body.order as LimitlessEmbeddedOrderPayload,
          signer,
          ownerId,
          exchangeAddress: request.body.exchangeAddress,
        });
        const signature = await executePreparedPrivySignatureRequest({
          request: prepared.request,
          authorizationSignature: request.body.authorizationSignature ?? "",
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ ok: true, signature });
      } catch (error) {
        const status =
          typeof (error as { responseStatus?: unknown })?.responseStatus ===
          "number"
            ? ((error as { responseStatus: number }).responseStatus ?? 400)
            : 400;
        reply.code(status);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to sign Limitless order",
          ...(((error as { responsePayload?: unknown })?.responsePayload ??
            undefined) as Record<string, unknown> | undefined),
        });
      }
    },
  );

  /**
   * GET /auth/verify
   */
  z.get(
    "/auth/verify",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const partnerAuth = await requireLimitlessPartnerAuth({
        reply,
        userId: user.id,
        walletAddress: signer,
      });
      if (!partnerAuth) return;

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        authMode: partnerAuth.authContext.authMode,
        account: partnerAuth.profile.account ?? signer,
        profile: partnerAuth.profile,
      });
    },
  );

  /**
   * POST /auth/logout
   */
  z.post(
    "/auth/logout",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const deactivatedCount = await AuthService.deactivateVenueCredentials(
        user.id,
        "limitless",
        signer,
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        disconnected: true,
        deactivatedCount,
        mode: "local_disconnect",
      });
    },
  );

  /**
   * GET /account
   * Returns a wallet-scoped Limitless account snapshot (Base on-chain reads).
   */
  z.get(
    "/account",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: limitlessAccountQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signerRaw = request.walletAddress;
      if (!user || !signerRaw) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isEvmWallet(signerRaw)) {
        reply.code(400);
        return reply.send({
          error: "Limitless account snapshot requires an EVM wallet address",
        });
      }

      const result = await fetchLimitlessAccountRoute({
        query: request.query,
        userId: user.id,
        signerRaw,
        log: app.log,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );

  /**
   * GET /amm/quote
   * Returns a Base-backed Limitless AMM quote without depending on wallet provider chain state.
   */
  z.get(
    "/amm/quote",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: limitlessAmmQuoteQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const result = await quoteLimitlessAmmRoute({
        query: request.query,
        log: request.log,
        pool,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );

  /**
   * GET /redemption/status
   * Returns payout readiness for one or more Limitless conditions.
   */
  z.get(
    "/redemption/status",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: limitlessRedemptionQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const result = await fetchLimitlessRedemptionStatusRoute({
        query: request.query,
        userId: user.id,
        signer,
        log: app.log,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );

  z.get(
    "/redemption-plan",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: limitlessRedemptionPlanQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const result = await buildLimitlessRedemptionPlanRoute({
        query: request.query,
        userId: user.id,
        signer,
        log: app.log,
        pool,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );

  /**
   * POST /order
   */
  z.post(
    "/order",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: limitlessOrderBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isEvmWallet(signer)) {
        reply.code(400);
        return reply.send({
          error: "Limitless order requires an EVM wallet address",
        });
      }

      const result = await submitLimitlessClientSignedOrder({
        body: request.body,
        log: request.log,
        pool,
        signer,
        userId: user.id,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );

  /**
   * POST /orders/amm
   * Store on-chain AMM executions as filled orders for portfolio/position sync.
   */
  z.post(
    "/orders/amm",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: limitlessAmmOrderBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isEvmWallet(signer)) {
        reply.code(400);
        return reply.send({
          error: "Limitless AMM order requires an EVM wallet address",
        });
      }

      const result = await recordLimitlessAmmOrder({
        body: request.body,
        log: request.log,
        pool,
        settlementMode: "legacy_assume_filled",
        signer,
        userId: user.id,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: result.payload.ok,
        orderId: result.payload.orderId,
        referralFirstTrade: result.payload.referralFirstTrade,
      });
    },
  );

  /**
   * POST /orders/sync
   * Fetch open orders from Limitless and upsert them into `orders`.
   */
  z.post(
    "/orders/sync",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: limitlessOpenOrdersQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const result = await syncLimitlessOpenOrdersRoute({
        log: request.log,
        pool,
        query: request.query,
        signer,
        userId: user.id,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );

  /**
   * POST /orders/history/sync
   * Fetch portfolio history from Limitless and upsert into `orders`.
   */
  z.post(
    "/orders/history/sync",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: limitlessHistoryQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const result = await syncLimitlessOrderHistoryRoute({
        log: request.log,
        pool,
        query: request.query,
        signer,
        userId: user.id,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );

  /**
   * GET /market/exchange
   * Resolve canonical exchange address for a market slug directly from Limitless.
   */
  z.get(
    "/market/exchange",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: limitlessMarketExchangeQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const result = await fetchLimitlessMarketExchangeRoute({
        log: request.log,
        query: request.query,
        signer,
        userId: user.id,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );

  /**
   * GET /orders/:orderId
   */
  z.get(
    "/orders/:orderId",
    {
      preHandler: createAuthMiddleware(),
      schema: { params: limitlessOrderIdParamsSchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const result = await fetchLimitlessOrderRoute({
        orderId: request.params.orderId,
        signer,
        userId: user.id,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );

  /**
   * DELETE /order/:orderId
   */
  z.delete(
    "/order/:orderId",
    {
      preHandler: createAuthMiddleware(),
      schema: { params: limitlessOrderIdParamsSchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const result = await cancelLimitlessOrderRoute({
        orderId: request.params.orderId,
        pool,
        signer,
        userId: user.id,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );

  /**
   * POST /orders/cancel-batch
   */
  z.post(
    "/orders/cancel-batch",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: limitlessCancelBatchBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const result = await cancelLimitlessOrdersBatchRoute({
        orderIds: request.body.orderIds,
        pool,
        signer,
        userId: user.id,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );

  /**
   * DELETE /orders/all/:slug
   */
  z.delete(
    "/orders/all/:slug",
    {
      preHandler: createAuthMiddleware(),
      schema: { params: limitlessSlugParamsSchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const result = await cancelAllLimitlessOrdersRoute({
        log: request.log,
        pool,
        signer,
        slug: request.params.slug,
        userId: user.id,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );

  /**
   * GET /orders/open
   */
  z.get(
    "/orders/open",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: limitlessOpenOrdersQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const result = await fetchLimitlessOpenOrdersRoute({
        query: request.query,
        signer,
        userId: user.id,
      });
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send(result.payload);
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result.payload);
    },
  );
};
