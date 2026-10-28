import type {
  FastifyPluginAsync,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  recommendedSpendBody,
  recommendedSpendError,
  recommendedSpendParams,
  recommendedSpendQuery,
  recommendedSpendResponse,
} from "../schemas/recommended-spend.js";
import {
  RecommendedSpendError,
  type createRecommendedSpendService,
} from "../services/recommended-spend.js";

export function createRecommendedSpendRoutes(
  service: ReturnType<typeof createRecommendedSpendService>,
  authenticate: preHandlerHookHandler,
  allowRequest: (
    request: FastifyRequest,
    personal: boolean,
  ) => Promise<boolean>,
): FastifyPluginAsync {
  return async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    const response = {
      200: recommendedSpendResponse,
      400: recommendedSpendError,
      401: recommendedSpendError,
      403: recommendedSpendError,
      404: recommendedSpendError,
      409: recommendedSpendError,
      429: recommendedSpendError,
    };
    typed.get(
      "/markets/:marketId/recommended-spend",
      {
        schema: {
          tags: ["Trading"],
          summary:
            "Observed BUY capacity within a worst-price slippage boundary; no wallet required",
          params: recommendedSpendParams,
          querystring: recommendedSpendQuery,
          response,
        },
      },
      async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        if (!(await allowRequest(request, false)))
          return reply
            .code(429)
            .send({ error: "Too many requests", code: "rate_limit_exceeded" });
        try {
          return await service.read({
            ...request.query,
            marketId: request.params.marketId,
          });
        } catch (error) {
          if (!(error instanceof RecommendedSpendError)) throw error;
          return reply
            .code(error.statusCode)
            .send({ error: error.message, code: error.code });
        }
      },
    );
    typed.post(
      "/trade/recommended-spend",
      {
        preHandler: authenticate,
        schema: {
          tags: ["Trading"],
          summary:
            "BUY capacity capped by ready collateral of one authenticated trading wallet",
          body: recommendedSpendBody,
          response,
        },
      },
      async (request, reply) => {
        reply.header("Cache-Control", "private, no-store");
        if (!request.user)
          return reply.code(401).send({ error: "Unauthorized" });
        if (!(await allowRequest(request, true)))
          return reply
            .code(429)
            .send({ error: "Too many requests", code: "rate_limit_exceeded" });
        try {
          return await service.read(request.body, {
            userId: request.user.id,
            signer: request.walletAddress ?? null,
          });
        } catch (error) {
          if (!(error instanceof RecommendedSpendError)) throw error;
          return reply
            .code(error.statusCode)
            .send({ error: error.message, code: error.code });
        }
      },
    );
  };
}
