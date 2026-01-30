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

  const normalizeVenues = (
    venue: string | undefined,
    venues: string[] | undefined,
  ): string[] | undefined => {
    if (venues && venues.length) return Array.from(new Set(venues));
    if (venue) return [venue];
    return undefined;
  };

  const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

  const isEthAddress = (address: string): boolean => ETH_ADDRESS_RE.test(address);

  const allowedVenues = new Set(["polymarket", "kalshi", "limitless"] as const);
  type AllowedVenue = "polymarket" | "kalshi" | "limitless";
  const isAllowedVenue = (venue: string | undefined): venue is AllowedVenue =>
    Boolean(venue && allowedVenues.has(venue as AllowedVenue));

  const runWithConcurrency = async <T, R>(
    items: T[],
    limit: number,
    handler: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> => {
    if (items.length === 0) return [];
    const concurrency = Math.max(1, limit);
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, items.length) },
      async () => {
        while (true) {
          const index = nextIndex++;
          if (index >= items.length) return;
          results[index] = await handler(items[index], index);
        }
      },
    );
    await Promise.all(workers);
    return results;
  };

  const filterWalletsByVenueCredentials = async (
    userId: string,
    venue: "polymarket" | "kalshi" | "limitless",
    walletAddresses: string[],
  ): Promise<string[]> => {
    if (walletAddresses.length === 0) return [];
    const normalized = walletAddresses.map((address) => address.toLowerCase());
    const { rows } = await pool.query<{ wallet_address: string }>(
      `
        select wallet_address
        from user_venue_credentials
        where user_id = $1
          and venue = $2
          and is_active = true
          and lower(wallet_address) = any($3::text[])
      `,
      [userId, venue, normalized],
    );
    const allowed = new Set(
      rows.map((row) => row.wallet_address.toLowerCase()),
    );
    return walletAddresses.filter((address) =>
      allowed.has(address.toLowerCase()),
    );
  };

  const resolveWalletAddresses = async (
    userId: string,
    walletAddress: string | undefined,
    requestedWallets: string[] | undefined,
    venue: string | undefined,
    venues: string[] | undefined,
    expandPolymarketFunders = true,
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
      const venueList = normalizeVenues(venue, venues);
      const relevantWallets = (() => {
        if (!venueList?.length) return wallets;
        const hasKalshi = venueList.includes("kalshi");
        const hasEvmVenue = venueList.some((item) => item !== "kalshi");
        if (hasKalshi && hasEvmVenue) return wallets;
        if (hasKalshi) {
          return wallets.filter((wallet) => wallet.walletType === "solana");
        }
        return wallets.filter((wallet) => wallet.walletType !== "solana");
      })();
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

      if (
        expandPolymarketFunders &&
        (!venueList || venueList.includes("polymarket"))
      ) {
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

  const resolveTokenIdsForFilter = async (
    marketId: string | undefined,
    eventId: string | undefined,
  ): Promise<string[] | null> => {
    if (marketId) {
      const { rows } = await pool.query<{ token_id: string }>(
        `
          select token_id
          from unified_tokens
          where market_id = $1
        `,
        [marketId],
      );
      return rows.map((row) => row.token_id);
    }

    if (eventId) {
      const { rows } = await pool.query<{ token_id: string }>(
        `
          select ut.token_id
          from unified_tokens ut
          join unified_markets m
            on m.id = ut.market_id
          where m.event_id = $1
        `,
        [eventId],
      );
      return rows.map((row) => row.token_id);
    }

    return null;
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
      const venues = query.venues;
      const responseVenue =
        venue ?? (venues && venues.length === 1 ? venues[0] : undefined);

      try {
        const walletAddresses = await resolveWalletAddresses(
          user.id,
          walletAddress,
          query.wallets,
          venue,
          query.venues,
        );
        if (walletAddresses.length === 0) {
          reply.code(400);
          return reply.send({ error: "No wallets available to query." });
        }

        const tokenIds = await resolveTokenIdsForFilter(
          query.marketId,
          query.eventId,
        );

        const positions =
          tokenIds != null
            ? tokenIds.length === 0
              ? []
              : await fetchPositionsForUserWalletByTokenIds(pool, {
                  userId: user.id,
                  walletAddresses,
                  tokenIds,
                  venue,
                  venues,
                  includeHidden: query.includeHidden,
                  minSize: query.minSize,
                })
            : await fetchPositionsForUserWallet(pool, {
                userId: user.id,
                walletAddresses,
                venue,
                venues,
                includeHidden: query.includeHidden,
                minSize: query.minSize,
              });

        if (positions.length) {
          void markHotTokens({
            tokenIds: positions.map((position) => position.tokenId),
          });
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        if (responseVenue) return reply.send({ positions, venue: responseVenue });
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
      const venue = query.venue;
      const venues = query.venues;
      const responseVenue =
        venue ?? (venues && venues.length === 1 ? venues[0] : undefined);

      try {
        const walletAddresses = await resolveWalletAddresses(
          user.id,
          walletAddress,
          query.wallets,
          venue,
          venues,
        );
        if (walletAddresses.length === 0) {
          reply.code(400);
          return reply.send({ error: "No wallets available to query." });
        }

        const positions = await fetchPositionsForUserWalletByTokenIds(pool, {
          userId: user.id,
          walletAddresses,
          tokenIds: query.tokenIds,
          venue,
          venues,
          includeHidden: query.includeHidden,
          minSize: query.minSize,
        });

        if (positions.length) {
          void markHotTokens({
            tokenIds: positions.map((position) => position.tokenId),
          });
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        if (responseVenue) return reply.send({ positions, venue: responseVenue });
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
      const venues = query.venues;
      const usingVenueList = Boolean(venues && venues.length);

      try {
        if (!query.wallets || query.wallets.length === 0) {
          if (usingVenueList) {
            // Fall through to multi-venue sync below.
          } else {
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
        }

        const baseWalletAddresses = query.wallets?.length
          ? await resolveWalletAddresses(
              user.id,
              walletAddress,
              query.wallets,
              query.venue,
              query.venues,
              false,
            )
          : [walletAddress];
        const expandedWalletAddresses = query.wallets?.length
          ? await resolveWalletAddresses(
              user.id,
              walletAddress,
              query.wallets,
              query.venue,
              query.venues,
            )
          : baseWalletAddresses;
        if (baseWalletAddresses.length === 0) {
          reply.code(400);
          return reply.send({ error: "No wallets available to sync." });
        }

        const cooldownSec = Math.max(0, env.positionsSyncCooldownSec);
        const r = cooldownSec > 0 ? await getRedis() : null;

        const evmConcurrency = Math.max(1, env.positionsSyncConcurrencyEvm);
        const solanaConcurrency = Math.max(1, env.positionsSyncConcurrencySolana);

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

        type SyncTask = {
          walletAddress: string;
          venue: "polymarket" | "kalshi" | "limitless" | null;
          chain: "evm" | "solana";
        };

        const executeTask = async (task: SyncTask) => {
          if (r && cooldownSec > 0) {
            const key = `positions:sync:${user.id}:${task.walletAddress}:${
              task.venue ?? "all"
            }`;
            const locked = await r.set(key, Date.now().toString(), {
              NX: true,
              EX: cooldownSec,
            });
            if (!locked) {
              return {
                walletAddress: task.walletAddress,
                venue: task.venue ?? null,
                status: "skipped" as const,
                skippedReason: "cooldown",
              };
            }
          }

          try {
            const result = await syncPositionsForUserWallet(pool, {
              userId: user.id,
              walletAddress: task.walletAddress,
              venue: task.venue ?? undefined,
            });
            return {
              walletAddress: task.walletAddress,
              venue: result.venue ?? task.venue ?? null,
              status: "ok" as const,
              heldTokens: result.heldTokens,
              knownTokens: result.knownTokens,
              upsertedPositions: result.upsertedPositions,
              flattenedPositions: result.flattenedPositions,
            };
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Unknown error";
            return {
              walletAddress: task.walletAddress,
              venue: task.venue ?? null,
              status: "error" as const,
              error: message,
            };
          }
        };

        if (!usingVenueList) {
          const resolvedVenue = isAllowedVenue(query.venue)
            ? query.venue
            : null;
          const tasks: SyncTask[] = expandedWalletAddresses.map((wallet) => ({
            walletAddress: wallet,
            venue: resolvedVenue,
            chain: isEthAddress(wallet) ? "evm" : "solana",
          }));
          const evmTasks = tasks.filter((task) => task.chain === "evm");
          const solTasks = tasks.filter((task) => task.chain === "solana");
          const [evmResults, solResults] = await Promise.all([
            runWithConcurrency(evmTasks, evmConcurrency, executeTask),
            runWithConcurrency(solTasks, solanaConcurrency, executeTask),
          ]);
          results.push(...evmResults, ...solResults);
        } else {
          const venuesToSync = (venues ?? []).filter(isAllowedVenue);
          const baseSolanaWallets = baseWalletAddresses.filter(
            (wallet) => !isEthAddress(wallet),
          );
          const baseEvmWallets = baseWalletAddresses.filter((wallet) =>
            isEthAddress(wallet),
          );

          const polymarketWallets = venuesToSync.includes("polymarket")
            ? await resolveWalletAddresses(
                user.id,
                walletAddress,
                query.wallets,
                "polymarket",
                undefined,
              )
            : [];
          const kalshiWallets = venuesToSync.includes("kalshi")
            ? baseSolanaWallets
            : [];
          const limitlessWalletsBase = venuesToSync.includes("limitless")
            ? baseEvmWallets
            : [];
          const limitlessWallets = venuesToSync.includes("limitless")
            ? await filterWalletsByVenueCredentials(
                user.id,
                "limitless",
                limitlessWalletsBase,
              )
            : [];

          const tasks: SyncTask[] = [];
          if (venuesToSync.includes("polymarket")) {
            const polymarketEvmWallets = polymarketWallets.filter((wallet) =>
              isEthAddress(wallet),
            );
            tasks.push(
              ...polymarketEvmWallets.map(
                (wallet) =>
                  ({
                    walletAddress: wallet,
                    venue: "polymarket",
                    chain: "evm",
                  }) as SyncTask,
              ),
            );
          }
          if (venuesToSync.includes("kalshi")) {
            tasks.push(
              ...kalshiWallets.map(
                (wallet) =>
                  ({
                    walletAddress: wallet,
                    venue: "kalshi",
                    chain: "solana",
                  }) as SyncTask,
              ),
            );
          }
          if (venuesToSync.includes("limitless")) {
            tasks.push(
              ...limitlessWallets.map(
                (wallet) =>
                  ({
                    walletAddress: wallet,
                    venue: "limitless",
                    chain: "evm",
                  }) as SyncTask,
              ),
            );
          }

          const evmTasks = tasks.filter((task) => task.chain === "evm");
          const solTasks = tasks.filter((task) => task.chain === "solana");
          const [evmResults, solResults] = await Promise.all([
            runWithConcurrency(evmTasks, evmConcurrency, executeTask),
            runWithConcurrency(solTasks, solanaConcurrency, executeTask),
          ]);
          results.push(...evmResults, ...solResults);
        }

        const summary = results.reduce(
          (acc, result) => {
            if (result.status === "ok") acc.synced += 1;
            if (result.status === "skipped") acc.skipped += 1;
            if (result.status === "error") acc.errors += 1;
            return acc;
          },
          { synced: 0, skipped: 0, errors: 0 },
        );

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          message: "Positions synced",
          results,
          summary,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        const messageLower = message.toLowerCase();
        const statusCode = messageLower.includes("not implemented")
          ? 501
          : messageLower.includes("select a solana") ||
              messageLower.includes("evm address") ||
              messageLower.includes("connect first") ||
              messageLower.includes("session not found")
            ? 400
            : 500;

        if (statusCode >= 500) {
          app.log.error(
            {
              error,
              userId: user.id,
              walletAddress,
              venue: query.venue,
              venues: query.venues,
            },
            "Failed to sync positions",
          );
        }

        reply.code(statusCode);
        return reply.send({ error: message });
      }
    },
  );
};
