import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { executionsQuerySchema } from "../schemas/executions.js";
import { fetchExecutionsForUserWallet } from "../repos/executions-repo.js";

export const executionsRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  /**
   * GET /executions
   * Get execution history for the selected wallet
   */
  z.get(
    "/executions",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: executionsQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;

      try {
        const result = await fetchExecutionsForUserWallet(pool, {
          userId: user.id,
          walletAddress,
          venue: query.venue,
          marketId: query.marketId,
          limit: query.limit,
          offset: query.offset,
        });

        const executions = result.rows.map((row) => ({
          id: row.id,
          venue: row.venue,
          unifiedMarketId: row.unified_market_id,
          side: row.side,
          outcome: row.outcome,
          inputMint: row.input_mint,
          outputMint: row.output_mint,
          amountIn: row.amount_in != null ? Number(row.amount_in) : null,
          amountOut: row.amount_out != null ? Number(row.amount_out) : null,
          inputDecimals: row.input_decimals ?? null,
          outputDecimals: row.output_decimals ?? null,
          quoteId: row.quote_id,
          txSignature: row.tx_signature,
          venueOrderId: row.venue_order_id,
          status: row.status,
          raw: row.raw ?? null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }));

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          executions,
          pagination: {
            total: result.total,
            limit: query.limit,
            offset: query.offset,
            hasMore: query.offset + query.limit < result.total,
          },
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress },
          "Failed to fetch executions",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to fetch executions",
        });
      }
    },
  );
};
