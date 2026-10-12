import type {
  FastifyInstance,
  FastifyPluginAsync,
  preHandlerHookHandler,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  hip4ReadResponseSchema,
  hip4TradePageSchema,
  hip4CandlePageSchema,
  hip4Identity,
  hip4ReadOutcomeAllowed,
  type Hip4ReadMarket,
  type Hip4ReadPolicy,
} from "@hunch/shared";
import { z } from "zod";
import { ageHip4Market } from "../services/hip4-mapping.js";
import {
  parseHip4TradeCursor,
  type readHip4Trades,
  type readHip4Candles,
} from "../services/hip4-history.js";

export type Hip4ReadDependencies = {
  maxStreamTokens?: number;
  authorize: preHandlerHookHandler;
  policy: () => Promise<{ policy: Hip4ReadPolicy; revision: string }>;
  markets: (
    environment: Hip4ReadPolicy["environment"],
    allowlist: number[] | null,
    after: number,
    limit: number,
  ) => Promise<Hip4ReadMarket[]>;
  trades?: (
    ...args: Parameters<typeof readHip4Trades> extends [unknown, ...infer Rest]
      ? Rest
      : never
  ) => ReturnType<typeof readHip4Trades>;
  candles?: (
    ...args: Parameters<typeof readHip4Candles> extends [unknown, ...infer Rest]
      ? Rest
      : never
  ) => ReturnType<typeof readHip4Candles>;
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
          afterOutcome: z.coerce
            .number()
            .int()
            .min(-1)
            .max(900000000)
            .default(-1),
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
          policy.catalogMode === "all" ? null : policy.outcomeAllowlist,
          request.query.afterOutcome,
          policy.pageSize + 1,
        );
        const selected = rows.slice(0, policy.pageSize);
        return {
          version: 1 as const,
          catalogMode: policy.catalogMode,
          refreshAfterMs: Math.floor(
            Math.min(
              policy.pollMs,
              policy.bookMaxAgeMs / 2,
              policy.policyCheckMs,
            ),
          ),
          policyRevision: revision,
          environment: policy.environment,
          streamTokenIds: policy.liveEnabled
            ? selected
                .filter((row) => !row.settlement)
                .slice(0, policy.maxLiveOutcomes)
                .flatMap((row) => row.sides.map((side) => side.tokenId))
                .slice(0, dependencies.maxStreamTokens)
            : [],
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

  for (const kind of ["detail", "trades", "candles"] as const) {
    app.withTypeProvider<ZodTypeProvider>().get(
      `/markets/hyperliquid/canary/:marketId${kind === "detail" ? "" : `/${kind}`}`,
      {
        preHandler: dependencies.authorize,
        schema: {
          tags: ["Markets"],
          params: z.object({
            marketId: z
              .string()
              .regex(/^hyperliquid:(mainnet|testnet):outcome:(0|[1-9]\d*)$/)
              .max(80),
          }),
          querystring: z.object({
            cursor: z.string().max(512).optional(),
            from: z.coerce
              .number()
              .int()
              .nonnegative()
              .max(Number.MAX_SAFE_INTEGER)
              .optional(),
            before: z.coerce
              .number()
              .int()
              .positive()
              .max(Number.MAX_SAFE_INTEGER)
              .optional(),
            policyRevision: z.string().max(100).optional(),
          }),
          response: {
            200:
              kind === "detail"
                ? hip4ReadResponseSchema
                : kind === "trades"
                  ? hip4TradePageSchema
                  : hip4CandlePageSchema,
            400: z.object({ error: z.string() }),
            404: z.object({ error: z.string() }),
            409: z.object({ error: z.string() }),
            503: z.object({ error: z.string() }),
          },
        },
      },
      async (request, reply) => {
        reply.header("Cache-Control", "private, no-store");
        try {
          const { policy, revision } = await dependencies.policy();
          const marketId = request.params.marketId;
          const outcome = Number(marketId.split(":").at(-1));
          if (
            !policy.enabled ||
            !hip4ReadOutcomeAllowed(policy, outcome) ||
            hip4Identity(policy.environment, outcome).marketId !== marketId
          )
            return reply.code(404).send({ error: "hip4_market_unavailable" });
          if (
            request.query.policyRevision &&
            request.query.policyRevision !== revision
          )
            return reply.code(409).send({ error: "hip4_policy_changed" });
          const rows = await dependencies.markets(
            policy.environment,
            [outcome],
            outcome - 1,
            1,
          );
          if (!rows.length)
            return reply.code(404).send({ error: "hip4_market_unavailable" });
          if (kind === "detail")
            return {
              version: 1 as const,
              catalogMode: policy.catalogMode,
              refreshAfterMs: Math.floor(
                Math.min(
                  policy.pollMs,
                  policy.bookMaxAgeMs / 2,
                  policy.policyCheckMs,
                ),
              ),
              policyRevision: revision,
              environment: policy.environment,
              markets: [ageHip4Market(rows[0], Date.now(), policy)],
              nextOutcome: null,
              streamTokenIds:
                policy.liveEnabled && !rows[0].settlement
                  ? rows[0].sides
                      .map((side) => side.tokenId)
                      .slice(0, dependencies.maxStreamTokens)
                  : [],
            };
          if (kind === "trades") {
            try {
              parseHip4TradeCursor(request.query.cursor, marketId);
            } catch {
              return reply.code(400).send({ error: "invalid_cursor" });
            }
            if (!dependencies.trades) throw new Error("history_not_configured");
            return {
              policyRevision: revision,
              environment: policy.environment,
              marketId,
              ...(await dependencies.trades(
                marketId,
                request.query.cursor,
                policy.pageSize,
              )),
            };
          }
          const before = request.query.before ?? Date.now();
          const from =
            request.query.from ??
            Math.max(0, before - policy.historyMaxRangeMs);
          if (before < from || before - from > policy.historyMaxRangeMs)
            return reply.code(400).send({ error: "invalid_history_range" });
          if (!dependencies.candles) throw new Error("history_not_configured");
          return {
            policyRevision: revision,
            environment: policy.environment,
            marketId,
            ...(await dependencies.candles(
              marketId,
              from,
              before,
              policy.candlePageSize,
            )),
          };
        } catch {
          return reply.code(503).send({ error: "hip4_read_unavailable" });
        }
      },
    );
  }
}

export const hip4ReadRoutes: FastifyPluginAsync = async (app) => {
  const [{ pool }, { createAdminMiddleware }, repository, history, { env }] =
    await Promise.all([
      import("../db.js"),
      import("../auth.js"),
      import("../services/hip4-repository.js"),
      import("../services/hip4-history.js"),
      import("../env.js"),
    ]);
  registerHip4ReadRoutes(app, {
    maxStreamTokens: env.pricesSseMaxTokens,
    authorize: createAdminMiddleware({
      requiredAdminPermission: "analytics:read",
    }),
    policy: () => repository.readHip4Policy(pool),
    markets: (...args) => repository.readHip4Markets(pool, ...args),
    trades: (...args) => history.readHip4Trades(pool, ...args),
    candles: (...args) => history.readHip4Candles(pool, ...args),
  });
};
