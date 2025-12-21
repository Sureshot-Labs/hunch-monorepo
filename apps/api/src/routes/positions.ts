import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { markHotTokens } from "../lib/hot-tokens.js";
import {
  fetchPositionsForUserWallet,
  fetchPositionsForUserWalletByTokenIds,
} from "../repos/positions-repo.js";
import { syncPositionsForUserWallet } from "../services/positions-sync.js";
import {
  positionsByTokenQuerySchema,
  positionsQuerySchema,
} from "../schemas/positions.js";

export const positionsRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  /**
   * GET /positions
   * Get user positions
   */
  z.get(
    "/positions",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: positionsQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;
      const venue = query.venue;

      try {
        const positions = await fetchPositionsForUserWallet(pool, {
          userId: user.id,
          walletAddress,
          venue,
        });

        if (positions.length) {
          void markHotTokens({
            tokenIds: positions.map((position) => position.tokenId),
          });
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        if (venue) return reply.send({ positions, venue });
        return reply.send({ positions });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress },
          "Failed to fetch positions",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to fetch positions",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * GET /positions/by-token
   * Get user positions for a list of token IDs
   */
  z.get(
    "/positions/by-token",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: positionsByTokenQuerySchema },
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
        const positions = await fetchPositionsForUserWalletByTokenIds(pool, {
          userId: user.id,
          walletAddress,
          tokenIds: query.tokenIds,
          venue: query.venue,
        });

        if (positions.length) {
          void markHotTokens({
            tokenIds: positions.map((position) => position.tokenId),
          });
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        if (query.venue) return reply.send({ positions, venue: query.venue });
        return reply.send({ positions });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress, tokenIds: query.tokenIds },
          "Failed to fetch positions by token",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to fetch positions by token",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * POST /positions/sync
   * Sync cached positions for the selected wallet
   */
  z.post(
    "/positions/sync",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: positionsQuerySchema },
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
        const result = await syncPositionsForUserWallet(pool, {
          userId: user.id,
          walletAddress,
          venue: query.venue,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          message: "Positions synced",
          ...result,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        const messageLower = message.toLowerCase();
        const statusCode = messageLower.includes("not implemented")
          ? 501
          : messageLower.includes("select a solana") ||
              messageLower.includes("evm address")
            ? 400
            : 500;

        if (statusCode >= 500) {
          app.log.error(
            { error, userId: user.id, walletAddress, venue: query.venue },
            "Failed to sync positions",
          );
        }

        reply.code(statusCode);
        return reply.send({ error: message });
      }
    },
  );
};
