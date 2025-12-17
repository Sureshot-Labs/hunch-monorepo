import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  AuthService,
  WalletAlreadyExistsError,
  createAuthMiddleware,
} from "../auth.js";
import { PrivyService } from "../privy-service.js";
import {
  addWalletBodySchema,
  authPrivyBodySchema,
  polymarketCredentialsBodySchema,
  venueCredentialsBodySchema,
} from "../schemas/auth.js";

export const authRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  /**
   * POST /auth/privy
   * Authenticate user using Privy access token
   */
  z.post(
    "/auth/privy",
    { schema: { body: authPrivyBodySchema } },
    async (request, reply) => {
      const body = request.body;

      const clientIp = request.ip || "unknown";
      const userAgent = request.headers["user-agent"] || "unknown";

      try {
        const {
          claims,
          user: privyUser,
          walletAddresses,
          primaryWalletAddress,
        } = await PrivyService.verifyTokenAndGetUser(body.accessToken);

        if (!primaryWalletAddress) {
          reply.code(400);
          return reply.send({
            error: "No wallet address found in Privy user data",
          });
        }

        const user = await AuthService.createOrUpdateUserFromPrivy(
          privyUser,
          claims,
        );

        const sessionToken = AuthService.generateToken(user.id);

        const session = await AuthService.createSession(
          user.id,
          primaryWalletAddress,
          sessionToken,
          clientIp,
          userAgent,
        );

        await AuthService.recordAuthAttempt(
          primaryWalletAddress,
          "privy-auth",
          true,
          clientIp,
          userAgent,
        );

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          user: {
            id: user.id,
            email: user.email,
            username: user.username,
            displayName: user.displayName,
            avatarUrl: user.avatarUrl,
            isActive: user.isActive,
            isVerified: user.isVerified,
            createdAt: user.createdAt,
            lastLoginAt: user.lastLoginAt,
          },
          session: {
            token: sessionToken,
            expiresAt: session.expiresAt,
          },
          walletAddresses,
          primaryWalletAddress,
          privyUserId: privyUser.id,
        });
      } catch (error) {
        app.log.error({ error }, "Privy authentication failed");

        await AuthService.recordAuthAttempt(
          "unknown",
          "privy-auth",
          false,
          clientIp,
          userAgent,
          error instanceof Error ? error.message : "Unknown error",
        );

        reply.code(401);
        return reply.send({
          error: "Authentication failed",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * POST /auth/logout
   * Logout user and invalidate session
   */
  z.post("/auth/logout", async (request, reply) => {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      reply.code(401);
      return reply.send({ error: "Missing or invalid authorization header" });
    }

    const token = authHeader.substring(7);

    try {
      await AuthService.invalidateSession(token);
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ message: "Successfully logged out" });
    } catch (error) {
      app.log.error({ error }, "Logout failed");
      reply.code(500);
      return reply.send({
        error: "Logout failed",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  /**
   * GET /auth/me
   * Get current user information
   */
  z.get(
    "/auth/me",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const wallets = await AuthService.getUserWallets(user.id);
        const polymarketCreds = await AuthService.getPolymarketCredentials(
          user.id,
          walletAddress,
        );

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          user: {
            id: user.id,
            email: user.email,
            username: user.username,
            displayName: user.displayName,
            avatarUrl: user.avatarUrl,
            isActive: user.isActive,
            isVerified: user.isVerified,
            createdAt: user.createdAt,
            lastLoginAt: user.lastLoginAt,
          },
          wallets: wallets.map((w) => ({
            id: w.id,
            walletAddress: w.walletAddress,
            walletType: w.walletType,
            isPrimary: w.isPrimary,
            isVerified: w.isVerified,
            createdAt: w.createdAt,
          })),
          polymarketCredentials: polymarketCreds
            ? {
                id: polymarketCreds.id,
                walletAddress: polymarketCreds.walletAddress,
                isActive: polymarketCreds.isActive,
                createdAt: polymarketCreds.createdAt,
                lastUsedAt: polymarketCreds.lastUsedAt,
              }
            : null,
          currentWallet: walletAddress,
        });
      } catch (error) {
        app.log.error({ error, userId: user.id }, "Get user info failed");
        reply.code(500);
        return reply.send({
          error: "Failed to get user information",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * DELETE /auth/me
   * Delete the current user account (local DB + best-effort Privy deletion).
   */
  z.delete(
    "/auth/me",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const privyUserId = user.privyUserId;

      try {
        await AuthService.deleteUser(user.id);
      } catch (error) {
        app.log.error({ error, userId: user.id }, "Failed to delete user");
        reply.code(500);
        return reply.send({
          error: "Failed to delete user",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }

      let privyDeleted = false;
      if (privyUserId) {
        try {
          await PrivyService.deleteUser(privyUserId);
          privyDeleted = true;
        } catch (error) {
          app.log.error(
            { error, userId: user.id, privyUserId },
            "Failed to delete Privy user",
          );
        }
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, privyDeleted });
    },
  );

  /**
   * POST /auth/venue-credentials
   * Set API credentials for any venue (Polymarket, Kalshi, Limitless)
   */
  z.post(
    "/auth/venue-credentials",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: venueCredentialsBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const body = request.body;
      const venue = body.venue;

      try {
        const credentials = await AuthService.createOrUpdateVenueCredentials(
          user.id,
          walletAddress,
          venue,
          body.apiKey,
          body.apiSecret,
          body.additionalData,
        );

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          message: `${venue} credentials updated successfully`,
          credentials: {
            id: credentials.id,
            venue: credentials.venue,
            walletAddress: credentials.walletAddress,
            isActive: credentials.isActive,
            createdAt: credentials.createdAt,
            lastUsedAt: credentials.lastUsedAt,
          },
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress, venue },
          "Failed to update venue credentials",
        );
        reply.code(500);
        return reply.send({
          error: `Failed to update ${venue} credentials`,
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * GET /auth/venue-credentials
   * Get all venue credentials for user + wallet
   */
  z.get(
    "/auth/venue-credentials",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const credentials = await AuthService.getAllVenueCredentials(
          user.id,
          walletAddress,
        );

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          credentials: credentials.map((c) => ({
            id: c.id,
            venue: c.venue,
            walletAddress: c.walletAddress,
            isActive: c.isActive,
            createdAt: c.createdAt,
            lastUsedAt: c.lastUsedAt,
            additionalData: c.additionalData,
          })),
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id },
          "Failed to get venue credentials",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to get venue credentials",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * POST /auth/polymarket-credentials
   * Set Polymarket API credentials for user (backward compatibility)
   */
  z.post(
    "/auth/polymarket-credentials",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketCredentialsBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const body = request.body;

      try {
        const credentials =
          await AuthService.createOrUpdatePolymarketCredentials(
            user.id,
            walletAddress,
            body.apiKey,
            body.apiSecret,
          );

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          message: "Polymarket credentials updated successfully",
          credentials: {
            id: credentials.id,
            venue: "polymarket",
            walletAddress: credentials.walletAddress,
            isActive: credentials.isActive,
            createdAt: credentials.createdAt,
            lastUsedAt: credentials.lastUsedAt,
          },
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress },
          "Failed to update Polymarket credentials",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to update Polymarket credentials",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * GET /auth/wallets
   * Get user's wallets
   */
  z.get(
    "/auth/wallets",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const wallets = await AuthService.getUserWallets(user.id);

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          wallets: wallets.map((w) => ({
            id: w.id,
            walletAddress: w.walletAddress,
            walletType: w.walletType,
            isPrimary: w.isPrimary,
            isVerified: w.isVerified,
            createdAt: w.createdAt,
            updatedAt: w.updatedAt,
          })),
        });
      } catch (error) {
        app.log.error({ error, userId: user.id }, "Failed to get user wallets");
        reply.code(500);
        return reply.send({
          error: "Failed to get user wallets",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * POST /auth/wallets
   * Add a new wallet to user account
   */
  z.post(
    "/auth/wallets",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: addWalletBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const body = request.body;

      const walletType = body.walletType || "ethereum";
      const verificationSignature = body.verificationSignature || undefined;

      try {
        const newWallet = await AuthService.addWallet(user.id, {
          walletAddress: body.walletAddress,
          walletType,
          verificationSignature,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          message: "Wallet added successfully",
          wallet: {
            id: newWallet.id,
            walletAddress: newWallet.walletAddress,
            walletType: newWallet.walletType,
            isPrimary: newWallet.isPrimary,
            isVerified: newWallet.isVerified,
            createdAt: newWallet.createdAt,
            updatedAt: newWallet.updatedAt,
          },
        });
      } catch (error) {
        if (error instanceof WalletAlreadyExistsError) {
          reply.code(409);
          return reply.send({ error: "Wallet address already exists" });
        }

        app.log.error(
          { error, userId: user.id, walletAddress: body.walletAddress },
          "Failed to add wallet",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to add wallet",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );
};
