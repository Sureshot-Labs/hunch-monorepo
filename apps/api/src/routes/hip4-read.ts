import type {
  FastifyInstance,
  FastifyPluginAsync,
  preHandlerHookHandler,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  hip4ReadResponseSchema,
  type Hip4ReadMarket,
  type Hip4ReadPolicy,
} from "@hunch/shared";
import { z } from "zod";
import { ageHip4Market } from "../services/hip4-mapping.js";

export type Hip4ReadDependencies = {
  authorize: preHandlerHookHandler;
  policy: () => Promise<{ policy: Hip4ReadPolicy; revision: string }>;
  markets: (
    environment: Hip4ReadPolicy["environment"],
    allowlist: number[],
    after: number,
    limit: number,
  ) => Promise<Hip4ReadMarket[]>;
};

export function registerHip4ReadRoutes(
  app: FastifyInstance,
  dependencies: Hip4ReadDependencies,
) {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/markets/hyperliquid/canary",
    {
      preHandler: dependencies.authorize,
      schema: {
        tags: ["Markets"],
        description:
          "Internal passive HIP-4 canary. Requires administrator read permission; never grants trade, funding or automation capability.",
        querystring: z.object({
          afterOutcome: z.coerce.number().int().min(-1).default(-1),
        }),
        response: {
          200: hip4ReadResponseSchema,
          404: z.object({ error: z.string() }),
          503: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      try {
        const { policy, revision } = await dependencies.policy();
        if (!policy.enabled)
          return reply.code(404).send({ error: "hip4_read_disabled" });
        const rows = await dependencies.markets(
          policy.environment,
          policy.outcomeAllowlist,
          request.query.afterOutcome,
          policy.pageSize + 1,
        );
        const selected = rows.slice(0, policy.pageSize);
        return {
          version: 1 as const,
          refreshAfterMs: Math.floor(
            Math.min(policy.pollMs, policy.bookMaxAgeMs / 2),
          ),
          policyRevision: revision,
          environment: policy.environment,
          markets: selected.map((row) =>
            ageHip4Market(row, Date.now(), policy),
          ),
          nextOutcome:
            rows.length > selected.length
              ? (selected.at(-1)?.outcome ?? null)
              : null,
        };
      } catch {
        return reply.code(503).send({ error: "hip4_read_unavailable" });
      }
    },
  );
}

export const hip4ReadRoutes: FastifyPluginAsync = async (app) => {
  const [{ pool }, { createAdminMiddleware }, repository] = await Promise.all([
    import("../db.js"),
    import("../auth.js"),
    import("../services/hip4-repository.js"),
  ]);
  registerHip4ReadRoutes(app, {
    authorize: createAdminMiddleware({
      requiredAdminPermission: "analytics:read",
    }),
    policy: () => repository.readHip4Policy(pool),
    markets: (...args) => repository.readHip4Markets(pool, ...args),
  });
};
