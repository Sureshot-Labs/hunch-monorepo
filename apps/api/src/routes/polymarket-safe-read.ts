import type {
  FastifyInstance,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  readPolymarketSafeRelayer,
  SafeRelayerReadError,
} from "../services/polymarket-safe-relayer-read.js";

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const errorSchema = z.object({ error: z.string() });

export function registerPolymarketSafeReadRoute(
  app: FastifyInstance,
  deps: {
    authenticate: preHandlerHookHandler;
    getWalletAddresses: (
      request: FastifyRequest,
    ) => Promise<readonly string[] | null>;
    fetchImpl?: typeof fetch;
  },
) {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/auth/polymarket/relayer-safe-read",
    {
      preHandler: deps.authenticate,
      schema: {
        querystring: z
          .object({
            address: addressSchema,
            kind: z.enum(["deployed", "nonce"]),
          })
          .strict(),
        response: {
          200: z.discriminatedUnion("kind", [
            z.object({
              kind: z.literal("deployed"),
              safeAddress: addressSchema,
              deployed: z.boolean(),
            }),
            z.object({
              kind: z.literal("nonce"),
              safeAddress: addressSchema,
              nonce: z.string().regex(/^\d+$/),
            }),
          ]),
          400: errorSchema,
          401: errorSchema,
          502: errorSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const walletAddresses = await deps.getWalletAddresses(request);
      if (!walletAddresses)
        return reply.code(401).send({ error: "Unauthorized" });
      try {
        return await readPolymarketSafeRelayer({
          ...request.query,
          walletAddresses,
          fetchImpl: deps.fetchImpl,
        });
      } catch (error) {
        if (error instanceof SafeRelayerReadError) {
          // No upstream body, cookies, credentials, or raw transport errors in logs.
          request.log.warn(
            {
              kind: request.query.kind,
              ownerAddress: request.query.address,
              reason: error.reason,
              upstreamStatus: error.upstreamStatus,
            },
            "Polymarket Safe read failed",
          );
          return reply.code(502).send({ error: error.message });
        }
        return reply
          .code(400)
          .send({ error: "Safe owner must be a linked EVM wallet" });
      }
    },
  );
}
