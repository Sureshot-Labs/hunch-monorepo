import type {
  FastifyInstance,
  FastifyPluginAsync,
  preHandlerHookHandler,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  hip4AccountResponseSchema,
  hip4AccountExecutionPageSchema,
  hip4AccountMarketIdSchema,
} from "../schemas/hip4-account.js";
import type { createHip4OwnedAccountService } from "../services/hip4-account-service.js";
import {
  parseHip4ExecutionCursor,
  type readHip4AccountExecutions,
} from "../services/hip4-account-repository.js";

type Service = ReturnType<typeof createHip4OwnedAccountService>;
export function registerHip4AccountRoutes(
  app: FastifyInstance,
  deps: {
    surface?: "owned" | "canary";
    authorize: preHandlerHookHandler;
    owns: (userId: string, address: string) => Promise<boolean>;
    service: Service;
    executions: (
      ...args: Parameters<typeof readHip4AccountExecutions> extends [
        unknown,
        ...infer Rest,
      ]
        ? Rest
        : never
    ) => ReturnType<typeof readHip4AccountExecutions>;
  },
) {
  const basePath =
    deps.surface === "owned"
      ? "/wallets/hyperliquid/account"
      : "/markets/hyperliquid/canary/account";
  for (const kind of ["account", "executions"] as const)
    app.withTypeProvider<ZodTypeProvider>().get(
      `${basePath}${kind === "executions" ? "/executions" : ""}`,
      {
        preHandler: deps.authorize,
        schema: {
          tags: ["Hyperliquid account"],
          querystring: z.object({
            refresh: z.enum(["1"]).optional(),
            marketId: hip4AccountMarketIdSchema.optional(),
            cursor: z.string().max(1000).optional(),
          }),
          response: {
            200:
              kind === "account"
                ? hip4AccountResponseSchema
                : hip4AccountExecutionPageSchema,
            400: z.object({ error: z.string() }),
            401: z.object({ error: z.string() }),
            403: z.object({ error: z.string() }),
            404: z.object({ error: z.string() }),
            503: z.object({ error: z.string() }),
          },
        },
      },
      async (request, reply) => {
        reply.header("Cache-Control", "private, no-store");
        const userId = request.user?.id;
        const address = request.walletAddress?.toLowerCase();
        if (!userId || !address)
          return reply.code(401).send({ error: "account_not_authenticated" });
        if (
          !/^0x[a-f0-9]{40}$/.test(address) ||
          !(await deps.owns(userId, address))
        )
          return reply.code(403).send({ error: "account_not_owned" });
        try {
          const { readPolicy, accountPolicy, revision } =
            await deps.service.policy();
          if (!readPolicy.enabled || !accountPolicy.enabled)
            return reply.code(404).send({ error: "hip4_account_disabled" });
          const marketId = request.query.marketId;
          if (
            marketId &&
            !marketId.startsWith(`hyperliquid:${readPolicy.environment}:`)
          )
            return reply.code(404).send({ error: "hip4_market_unavailable" });
          if (kind === "account")
            return await deps.service.load(
              address,
              readPolicy,
              accountPolicy,
              revision,
              request.query.refresh === "1",
            );
          try {
            parseHip4ExecutionCursor(
              request.query.cursor,
              readPolicy.environment,
              address,
              marketId,
            );
          } catch {
            return reply.code(400).send({ error: "invalid_cursor" });
          }
          return await deps.executions(
            readPolicy.environment,
            address,
            accountPolicy.pageSize,
            request.query.cursor,
            marketId,
          );
        } catch {
          return reply.code(503).send({ error: "hip4_account_unavailable" });
        }
      },
    );
}

export const hip4AccountRoutes: FastifyPluginAsync = async (app) => {
  const [
    { pool },
    { AuthService, createAdminMiddleware, createAuthMiddleware },
    service,
    repository,
  ] = await Promise.all([
    import("../db.js"),
    import("../auth.js"),
    import("../services/hip4-account-service.js"),
    import("../services/hip4-account-repository.js"),
  ]);
  const shared: Pick<
    Parameters<typeof registerHip4AccountRoutes>[1],
    "owns" | "service" | "executions"
  > = {
    owns: async (userId, address) =>
      (await AuthService.getUserWallets(userId)).some(
        (wallet) =>
          wallet.isVerified &&
          wallet.walletType === "ethereum" &&
          wallet.walletAddress.toLowerCase() === address,
      ),
    service: service.createHip4OwnedAccountService(pool),
    executions: (...args) =>
      repository.readHip4AccountExecutions(pool, ...args),
  };
  // Normal account reads use the same session/selected-wallet contract as
  // other wallet APIs. The compatibility canary keeps its existing admin gate.
  registerHip4AccountRoutes(app, {
    ...shared,
    surface: "owned",
    authorize: createAuthMiddleware(),
  });
  registerHip4AccountRoutes(app, {
    ...shared,
    surface: "canary",
    authorize: createAdminMiddleware({
      requiredAdminPermission: "analytics:read",
    }),
  });
};
