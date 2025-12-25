import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { AuthService, createAuthMiddleware } from "../auth.js";
import { env } from "../env.js";
import { pool } from "../db.js";
import { markHotTokens } from "../lib/hot-tokens.js";
import {
  fetchPositionsForUserWallet,
  fetchPositionsForUserWalletByTokenIds,
  setPositionHidden,
} from "../repos/positions-repo.js";
import { syncPositionsForUserWallet } from "../services/positions-sync.js";
import { getRedis } from "../redis.js";
import {
  positionVisibilitySchema,
  positionsByTokenQuerySchema,
  positionsQuerySchema,
} from "../schemas/positions.js";

export const positionsRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  const resolveWalletAddresses = async (
    userId: string,
    walletAddress: string | undefined,
    requestedWallets: string[] | undefined,
    venue: string | undefined,
  ): Promise<string[]> => {
    if (requestedWallets && requestedWallets.length) {
      const wallets = await AuthService.getUserWallets(userId);
      const walletMap = new Map(
        wallets.map((wallet) => [
          wallet.walletAddress.toLowerCase(),
          wallet.walletAddress,
        ]),
      );
      const resolved = requestedWallets
        .map((address) => address.trim().toLowerCase())
        .map((address) => walletMap.get(address))
        .filter((address): address is string => Boolean(address));
      const uniqueResolved = Array.from(new Set(resolved));

      const relevantWallets = venue
        ? venue === "kalshi"
          ? wallets.filter((wallet) => wallet.walletType === "solana")
          : wallets.filter((wallet) => wallet.walletType !== "solana")
        : wallets;
      const relevantSet = new Set(
        relevantWallets
          .map((wallet) => wallet.walletAddress.toLowerCase())
          .filter(Boolean),
      );
      const resolvedSet = new Set(
        uniqueResolved.map((address) => address.toLowerCase()),
      );
      const isAllRelevantWallets =
        relevantSet.size > 0 &&
        resolvedSet.size === relevantSet.size &&
        Array.from(relevantSet).every((address) => resolvedSet.has(address));

      if (!isAllRelevantWallets) {
        return uniqueResolved;
      }

      if (!venue || venue === "polymarket") {
        const { rows } = await pool.query<{ wallet_address: string | null }>(
          `
            select distinct wallet_address
            from positions
            where user_id = $1
              and venue = 'polymarket'
              and wallet_address is not null
          `,
          [userId],
        );
        const extra = rows
          .map((row) => row.wallet_address)
          .filter((address): address is string => Boolean(address));
        return Array.from(new Set([...uniqueResolved, ...extra]));
      }

      return uniqueResolved;
    }

    if (!walletAddress) return [];
    return [walletAddress];
  };

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
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;
      const venue = query.venue;

      try {
        const walletAddresses = await resolveWalletAddresses(
          user.id,
          walletAddress,
          query.wallets,
          venue,
        );
        if (walletAddresses.length === 0) {
          reply.code(400);
          return reply.send({ error: "No wallets available to query." });
        }

        const positions = await fetchPositionsForUserWallet(pool, {
          userId: user.id,
          walletAddresses,
          venue,
          includeHidden: query.includeHidden,
          minSize: query.minSize,
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
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;

      try {
        const walletAddresses = await resolveWalletAddresses(
          user.id,
          walletAddress,
          query.wallets,
          query.venue,
        );
        if (walletAddresses.length === 0) {
          reply.code(400);
          return reply.send({ error: "No wallets available to query." });
        }

        const positions = await fetchPositionsForUserWalletByTokenIds(pool, {
          userId: user.id,
          walletAddresses,
          tokenIds: query.tokenIds,
          venue: query.venue,
          includeHidden: query.includeHidden,
          minSize: query.minSize,
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
   * POST /positions/hide
   * Manually hide/unhide a position
   */
  z.post(
    "/positions/hide",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: positionVisibilitySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const body = request.body;
      try {
        const updated = await setPositionHidden(pool, {
          userId: user.id,
          walletAddress: body.walletAddress,
          venue: body.venue,
          tokenId: body.tokenId,
          hidden: body.hidden,
          reason: body.hidden ? "user" : null,
        });

        if (!updated) {
          reply.code(404);
          return reply.send({ error: "Position not found" });
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ ok: true, hidden: body.hidden });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, body },
          "Failed to update position visibility",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to update position visibility",
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
        if (!query.wallets || query.wallets.length === 0) {
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
        }

        const walletAddresses = await resolveWalletAddresses(
          user.id,
          walletAddress,
          query.wallets,
          query.venue,
        );
        if (walletAddresses.length === 0) {
          reply.code(400);
          return reply.send({ error: "No wallets available to sync." });
        }

        const cooldownSec = Math.max(0, env.positionsSyncCooldownSec);
        const r = cooldownSec > 0 ? await getRedis() : null;

        const results: Array<{
          walletAddress: string;
          venue: string | null;
          status: "ok" | "skipped" | "error";
          heldTokens?: number;
          knownTokens?: number;
          upsertedPositions?: number;
          flattenedPositions?: number;
          skippedReason?: string;
          error?: string;
        }> = [];

        let synced = 0;
        let skipped = 0;
        let errors = 0;

        for (const wallet of walletAddresses) {
          if (r && cooldownSec > 0) {
            const key = `positions:sync:${user.id}:${wallet}:${
              query.venue ?? "all"
            }`;
            const locked = await r.set(key, Date.now().toString(), {
              NX: true,
              EX: cooldownSec,
            });
            if (!locked) {
              skipped += 1;
              results.push({
                walletAddress: wallet,
                venue: query.venue ?? null,
                status: "skipped",
                skippedReason: "cooldown",
              });
              continue;
            }
          }

          try {
            const result = await syncPositionsForUserWallet(pool, {
              userId: user.id,
              walletAddress: wallet,
              venue: query.venue,
            });
            synced += 1;
            results.push({
              walletAddress: wallet,
              venue: result.venue,
              status: "ok",
              heldTokens: result.heldTokens,
              knownTokens: result.knownTokens,
              upsertedPositions: result.upsertedPositions,
              flattenedPositions: result.flattenedPositions,
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Unknown error";
            errors += 1;
            results.push({
              walletAddress: wallet,
              venue: query.venue ?? null,
              status: "error",
              error: message,
            });
          }
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          message: "Positions synced",
          results,
          summary: { synced, skipped, errors },
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
