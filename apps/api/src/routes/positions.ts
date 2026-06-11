import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createAuthMiddleware } from "../auth.js";
import { env } from "../env.js";
import { pool } from "../db.js";
import { markHotTokens } from "../lib/hot-tokens.js";
import { MIN_POSITION_SIZE } from "../lib/positions-constants.js";
import { requestPriceRefreshForTokens } from "../lib/price-refresh.js";
import { resolveRequestedWalletAddresses } from "../lib/resolve-wallets.js";
import {
  hasUnsupportedHyperliquidVenue,
  sendUnsupportedVenue,
} from "../lib/unsupported-venue.js";
import {
  fetchPositionPnlSummaryForUserWallet,
  fetchPositionsForUserWallet,
  fetchPositionsForUserWalletByTokenIds,
  setPositionHidden,
} from "../repos/positions-repo.js";
import { fetchMarketsByTokenIds as fetchMarketRowsByTokenIds } from "../repos/unified-read.js";
import { mapMarketsByTokenRows } from "../services/markets-by-token-response.js";
import {
  prefetchPolymarketOwnerBalancesForWallets,
  syncPositionsForUserWallet,
  type PrefetchedPolymarketOwnerBalances,
} from "../services/positions-sync.js";
import { getRedis } from "../redis.js";
import {
  positionVisibilitySchema,
  positionVisibilityErrorResponseSchema,
  positionVisibilityResponseSchema,
  positionsByTokenQuerySchema,
  positionsPnlSummaryQuerySchema,
  positionsQuerySchema,
} from "../schemas/positions.js";
import {
  buildKalshiLossCloseTransaction,
  normalizeKalshiSolanaPositionMint,
  type KalshiLossCloseTransaction,
} from "../services/kalshi-loss-close.js";
import { resolveEmbeddedSolanaWalletContext } from "../services/embedded-solana.js";

type AuthenticatedUser = NonNullable<FastifyRequest["user"]>;

export const positionsRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

  const isEthAddress = (address: string): boolean =>
    ETH_ADDRESS_RE.test(address);

  const allowedVenues = new Set(["polymarket", "kalshi", "limitless"] as const);
  type AllowedVenue = "polymarket" | "kalshi" | "limitless";
  const isAllowedVenue = (venue: string | undefined): venue is AllowedVenue =>
    Boolean(venue && allowedVenues.has(venue as AllowedVenue));
  const canUseEmbeddedSolanaExecution = async (
    user: AuthenticatedUser,
    walletAddress: string,
  ): Promise<boolean> => {
    try {
      await resolveEmbeddedSolanaWalletContext({
        user,
        signer: walletAddress,
      });
      return true;
    } catch {
      return false;
    }
  };
  const isSkippableSyncMessage = (message: string): boolean => {
    const normalized = message.toLowerCase();
    return (
      normalized.includes("connect first") ||
      (normalized.startsWith("connect ") &&
        normalized.includes(" before syncing positions")) ||
      normalized.includes("session not found") ||
      normalized.includes("credentials not found") ||
      normalized.includes("ownerid not available")
    );
  };

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
        const allowPolymarketFunders =
          venue === "polymarket" ||
          venues?.includes("polymarket") ||
          (!venue && (!venues || venues.length === 0));
        const walletAddresses = await resolveRequestedWalletAddresses(
          user.id,
          walletAddress,
          query.wallets,
          { allowPolymarketFunders },
        );
        if (walletAddresses.length === 0) {
          reply.code(400);
          return reply.send({ error: "No wallets available to query." });
        }

        const tokenIds = await resolveTokenIdsForFilter(
          query.marketId,
          query.eventId,
        );
        const effectiveMinSize = query.minSize ?? MIN_POSITION_SIZE;

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
                  minSize: effectiveMinSize,
                })
            : await fetchPositionsForUserWallet(pool, {
                userId: user.id,
                walletAddresses,
                venue,
                venues,
                includeHidden: query.includeHidden,
                minSize: effectiveMinSize,
              });

        if (positions.length) {
          const tokenIds = positions.map((position) => position.tokenId);
          void markHotTokens({
            tokenIds,
          });
          void requestPriceRefreshForTokens({ tokenIds });
        }

        let marketsByToken:
          | ReturnType<typeof mapMarketsByTokenRows>
          | undefined;
        if (query.includeMarkets && positions.length) {
          const tokenIds = Array.from(
            new Set(
              positions
                .map((position) => position.tokenId)
                .filter((tokenId) => tokenId.length > 0),
            ),
          );
          if (tokenIds.length) {
            try {
              const marketRows = await fetchMarketRowsByTokenIds(pool, {
                tokenIds,
                venue: responseVenue,
                includeTop: true,
              });
              marketsByToken = mapMarketsByTokenRows(marketRows);
            } catch (marketError) {
              app.log.warn(
                {
                  error: marketError,
                  userId: user.id,
                  tokenCount: tokenIds.length,
                  tokenSample: tokenIds.slice(0, 8),
                },
                "Failed to include market metadata with positions",
              );
            }
          }
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          positions,
          ...(marketsByToken ? { marketsByToken } : {}),
          ...(responseVenue ? { venue: responseVenue } : {}),
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress },
          "Failed to fetch positions",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to fetch positions",
        });
      }
    },
  );

  /**
   * GET /positions/pnl
   * Get aggregated portfolio pnl metrics for current user wallets.
   */
  z.get(
    "/positions/pnl",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: positionsPnlSummaryQuerySchema },
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
        const allowPolymarketFunders =
          venue === "polymarket" ||
          venues?.includes("polymarket") ||
          (!venue && (!venues || venues.length === 0));
        const walletAddresses = await resolveRequestedWalletAddresses(
          user.id,
          walletAddress,
          query.wallets,
          { allowPolymarketFunders },
        );
        if (walletAddresses.length === 0) {
          reply.code(400);
          return reply.send({ error: "No wallets available to query." });
        }

        const summary = await fetchPositionPnlSummaryForUserWallet(pool, {
          userId: user.id,
          walletAddresses,
          venue,
          venues,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        if (responseVenue) return reply.send({ summary, venue: responseVenue });
        return reply.send({ summary });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress },
          "Failed to fetch position pnl summary",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to fetch position pnl summary",
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
        const allowPolymarketFunders =
          venue === "polymarket" ||
          venues?.includes("polymarket") ||
          (!venue && (!venues || venues.length === 0));
        const walletAddresses = await resolveRequestedWalletAddresses(
          user.id,
          walletAddress,
          query.wallets,
          { allowPolymarketFunders },
        );
        if (walletAddresses.length === 0) {
          reply.code(400);
          return reply.send({ error: "No wallets available to query." });
        }

        const effectiveMinSize = query.minSize ?? MIN_POSITION_SIZE;
        const positions = await fetchPositionsForUserWalletByTokenIds(pool, {
          userId: user.id,
          walletAddresses,
          tokenIds: query.tokenIds,
          venue,
          venues,
          includeHidden: query.includeHidden,
          minSize: effectiveMinSize,
        });

        if (positions.length) {
          const tokenIds = positions.map((position) => position.tokenId);
          void markHotTokens({
            tokenIds,
          });
          void requestPriceRefreshForTokens({ tokenIds });
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        if (responseVenue)
          return reply.send({ positions, venue: responseVenue });
        return reply.send({ positions });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress, tokenIds: query.tokenIds },
          "Failed to fetch positions by token",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to fetch positions by token",
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
      schema: {
        body: positionVisibilitySchema,
        response: {
          200: positionVisibilityResponseSchema,
          400: positionVisibilityErrorResponseSchema,
          401: positionVisibilityErrorResponseSchema,
          404: positionVisibilityErrorResponseSchema,
          500: positionVisibilityErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const body = request.body;
      if (body.venue === "hyperliquid") {
        return sendUnsupportedVenue(reply);
      }

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

        let closeLossTransaction: KalshiLossCloseTransaction | null = null;
        let closeLoss:
          | { skippedReason: string; error?: never }
          | { skippedReason: "prepare_failed"; error: string }
          | undefined;

        if (body.hidden && body.venue === "kalshi") {
          try {
            if (
              normalizeKalshiSolanaPositionMint(body.tokenId) &&
              !(await canUseEmbeddedSolanaExecution(user, body.walletAddress))
            ) {
              closeLoss = { skippedReason: "non_embedded_wallet" };
            } else {
              const closeResult = await buildKalshiLossCloseTransaction({
                pool,
                userId: user.id,
                walletAddress: body.walletAddress,
                tokenId: body.tokenId,
                rpcUrls: env.solanaRpcUrls,
                timeoutMs: env.solanaRpcTimeoutMs,
              });
              closeLossTransaction = closeResult.transaction;
              if (!closeResult.transaction) {
                closeLoss = { skippedReason: closeResult.skippedReason };
              }
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Unknown error";
            closeLoss = { skippedReason: "prepare_failed", error: message };
            app.log.warn(
              {
                error,
                userId: user.id,
                walletAddress: body.walletAddress,
                tokenId: body.tokenId,
              },
              "Failed to prepare Kalshi loss close transaction",
            );
          }
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          hidden: body.hidden,
          ...(closeLossTransaction ? { closeLossTransaction } : {}),
          ...(closeLoss ? { closeLoss } : {}),
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, body },
          "Failed to update position visibility",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to update position visibility",
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
      if (query.venue === "hyperliquid") {
        return sendUnsupportedVenue(reply);
      }
      if (
        hasUnsupportedHyperliquidVenue({
          venue: query.venue,
          venues,
        })
      ) {
        return sendUnsupportedVenue(reply);
      }
      const usingVenueList = Boolean(venues && venues.length);
      const forceSync = query.force === true;
      const startedAt = Date.now();
      const allowPolymarketFunders =
        query.venue === "polymarket" ||
        venues?.includes("polymarket") ||
        (!query.venue && (!venues || venues.length === 0));

      try {
        if (!query.wallets || query.wallets.length === 0) {
          if (usingVenueList) {
            // Fall through to multi-venue sync below.
          } else {
            let result: Awaited<
              ReturnType<typeof syncPositionsForUserWallet>
            > | null = null;
            let skippedReason: string | undefined;
            try {
              result = await syncPositionsForUserWallet(pool, {
                userId: user.id,
                walletAddress,
                venue: query.venue,
              });
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "Unknown error";
              if (!isSkippableSyncMessage(message)) {
                throw error;
              }
              skippedReason = "connect_first";
            }

            const durationMs = Date.now() - startedAt;
            const logPayload = {
              userId: user.id,
              walletAddress,
              venue: query.venue ?? null,
              durationMs,
              status: result ? "ok" : "skipped",
              skippedReason,
            };
            if (durationMs >= 5000) {
              app.log.warn(logPayload, "Positions sync completed slowly");
            } else {
              app.log.info(logPayload, "Positions sync completed");
            }
            const includeDebug = query.debug || durationMs >= 5000;
            reply.header("Content-Type", "application/json; charset=utf-8");
            return reply.send({
              message: "Positions synced",
              ...(result ?? {
                walletAddress,
                venue: query.venue ?? null,
                status: "skipped" as const,
                skippedReason,
              }),
              ...(includeDebug ? { durationMs } : {}),
            });
          }
        }

        const baseWalletAddresses = query.wallets?.length
          ? await resolveRequestedWalletAddresses(
              user.id,
              walletAddress,
              query.wallets,
              { allowPolymarketFunders },
            )
          : [walletAddress];
        const expandedWalletAddresses = baseWalletAddresses;
        if (baseWalletAddresses.length === 0) {
          reply.code(400);
          return reply.send({ error: "No wallets available to sync." });
        }

        const cooldownSec = Math.max(0, env.positionsSyncCooldownSec);
        const r = cooldownSec > 0 ? await getRedis() : null;

        const evmConcurrency = Math.max(1, env.positionsSyncConcurrencyEvm);
        const solanaConcurrency = Math.max(
          1,
          env.positionsSyncConcurrencySolana,
        );

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
          durationMs?: number;
          timings?: Record<string, number>;
        }> = [];

        type SyncTask = {
          walletAddress: string;
          venue: "polymarket" | "kalshi" | "limitless" | null;
          chain: "evm" | "solana";
        };

        let polymarketPrefetchWallets: string[] = [];
        let polymarketPrefetchPromise: Promise<PrefetchedPolymarketOwnerBalances> | null =
          null;
        let polymarketPrefetchValue: PrefetchedPolymarketOwnerBalances | null =
          null;
        let polymarketPrefetchAttempted = false;
        let polymarketPrefetchDurationMs = 0;
        let polymarketPrefetchFailed = false;

        const isPolymarketEvmTask = (task: SyncTask): boolean =>
          task.chain === "evm" &&
          (task.venue === null || task.venue === "polymarket");

        const enablePolymarketBatchPrefetch = (tasks: SyncTask[]) => {
          if (!forceSync) {
            polymarketPrefetchWallets = [];
            return;
          }
          polymarketPrefetchWallets = Array.from(
            new Map(
              tasks
                .filter(isPolymarketEvmTask)
                .map((task) => [
                  task.walletAddress.toLowerCase(),
                  task.walletAddress,
                ]),
            ).values(),
          );
        };

        const getPolymarketBatchPrefetch =
          async (): Promise<PrefetchedPolymarketOwnerBalances | null> => {
            if (polymarketPrefetchWallets.length === 0) return null;
            if (!polymarketPrefetchPromise) {
              const prefetchStartedAt = Date.now();
              polymarketPrefetchAttempted = true;
              polymarketPrefetchPromise =
                prefetchPolymarketOwnerBalancesForWallets(pool, {
                  userId: user.id,
                  walletAddresses: polymarketPrefetchWallets,
                })
                  .then((prefetched) => {
                    polymarketPrefetchDurationMs =
                      Date.now() - prefetchStartedAt;
                    polymarketPrefetchValue = prefetched;
                    return prefetched;
                  })
                  .catch((error) => {
                    polymarketPrefetchFailed = true;
                    polymarketPrefetchDurationMs =
                      Date.now() - prefetchStartedAt;
                    throw error;
                  });
            }
            return polymarketPrefetchPromise;
          };

        const executeTask = async (task: SyncTask) => {
          const taskStartedAt = Date.now();
          if (!forceSync && r && cooldownSec > 0) {
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
                durationMs: Date.now() - taskStartedAt,
              };
            }
          }

          try {
            const prefetchedPolymarketBalances = isPolymarketEvmTask(task)
              ? await getPolymarketBatchPrefetch()
              : null;
            const result = await syncPositionsForUserWallet(pool, {
              userId: user.id,
              walletAddress: task.walletAddress,
              venue: task.venue ?? undefined,
              prefetchedPolymarketBalances,
            });
            return {
              walletAddress: task.walletAddress,
              venue: result.venue ?? task.venue ?? null,
              status: "ok" as const,
              heldTokens: result.heldTokens,
              knownTokens: result.knownTokens,
              upsertedPositions: result.upsertedPositions,
              flattenedPositions: result.flattenedPositions,
              durationMs: Date.now() - taskStartedAt,
              timings: result.timings,
            };
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Unknown error";
            if (isSkippableSyncMessage(message)) {
              return {
                walletAddress: task.walletAddress,
                venue: task.venue ?? null,
                status: "skipped" as const,
                skippedReason: "connect_first",
                durationMs: Date.now() - taskStartedAt,
              };
            }
            return {
              walletAddress: task.walletAddress,
              venue: task.venue ?? null,
              status: "error" as const,
              error: message,
              durationMs: Date.now() - taskStartedAt,
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
          enablePolymarketBatchPrefetch(evmTasks);
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
            ? await resolveRequestedWalletAddresses(
                user.id,
                walletAddress,
                query.wallets,
                { allowPolymarketFunders: true },
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
          enablePolymarketBatchPrefetch(evmTasks);
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

        let polymarketPrefetchStats: {
          walletCount: number;
          ownerCount: number;
          candidateTokenCount: number;
          rpcCallEstimate: number;
          rpcCallCount: number;
          durationMs: number;
          failed: boolean;
          sourceCounts:
            | PrefetchedPolymarketOwnerBalances["sourceCounts"]
            | null;
          timings: PrefetchedPolymarketOwnerBalances["timings"] | null;
        } | null = null;
        if (polymarketPrefetchAttempted) {
          const prefetchedForStats =
            polymarketPrefetchValue as PrefetchedPolymarketOwnerBalances | null;
          polymarketPrefetchStats = {
            walletCount: polymarketPrefetchWallets.length,
            ownerCount: prefetchedForStats?.owners.length ?? 0,
            candidateTokenCount:
              prefetchedForStats?.candidateTokenIds.length ?? 0,
            rpcCallEstimate: prefetchedForStats?.rpcCallEstimate ?? 0,
            rpcCallCount: prefetchedForStats?.rpcCallCount ?? 0,
            durationMs: polymarketPrefetchDurationMs,
            failed: polymarketPrefetchFailed,
            sourceCounts: prefetchedForStats?.sourceCounts ?? null,
            timings: prefetchedForStats?.timings ?? null,
          };
        }

        const durationMs = Date.now() - startedAt;
        const logPayload = {
          userId: user.id,
          walletAddress,
          venue: query.venue ?? null,
          venues: query.venues ?? null,
          forceSync,
          requestedWalletCount: query.wallets?.length ?? 0,
          resolvedWalletCount: expandedWalletAddresses.length,
          resultCount: results.length,
          summary,
          durationMs,
          polymarketPrefetch: polymarketPrefetchStats,
        };
        if (durationMs >= 5000) {
          app.log.warn(logPayload, "Positions sync completed slowly");
        } else {
          app.log.info(logPayload, "Positions sync completed");
        }
        const includeDebug = query.debug || durationMs >= 5000;
        const responseResults = includeDebug
          ? results
          : results.map(
              ({ durationMs: _durationMs, timings: _timings, ...result }) =>
                result,
            );
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          message: "Positions synced",
          results: responseResults,
          summary,
          ...(includeDebug
            ? {
                durationMs,
                debug: {
                  polymarketPrefetch: polymarketPrefetchStats,
                  taskTimings: results.map((result) => ({
                    walletAddress: result.walletAddress,
                    venue: result.venue,
                    status: result.status,
                    durationMs: result.durationMs ?? null,
                    heldTokens: result.heldTokens ?? null,
                    knownTokens: result.knownTokens ?? null,
                    timings: result.timings ?? null,
                  })),
                },
              }
            : {}),
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
              durationMs: Date.now() - startedAt,
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
