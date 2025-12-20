import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { BuilderSigner } from "@polymarket/builder-signing-sdk";
import { z as zod } from "zod";
import {
  AuthService,
  WalletAlreadyExistsError,
  createAuthMiddleware,
} from "../auth.js";
import { env } from "../env.js";
import { PrivyService } from "../privy-service.js";
import {
  addWalletBodySchema,
  authPrivyBodySchema,
  polymarketConnectBodySchema,
  polymarketCredentialsBodySchema,
  polymarketFunderBodySchema,
  polymarketRelayerStatusResponseSchema,
  polymarketRelayerSignBodySchema,
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
        const polymarketCreds = await AuthService.getVenueCredentialsInfo(
          user.id,
          "polymarket",
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
        const credentials = await AuthService.getAllVenueCredentialsInfo(
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
   * POST /auth/polymarket/connect
   * Derive Polymarket CLOB L2 credentials via L1 signature and store encrypted-at-rest.
   */
  z.post(
    "/auth/polymarket/connect",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketConnectBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!walletAddress.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error: "Polymarket connect requires an EVM wallet address",
        });
      }

      const body = request.body;

      const clobBase =
        process.env.POLYMARKET_CLOB_BASE?.trim() ||
        "https://clob.polymarket.com";

      try {
        const upstream = await fetch(`${clobBase}/auth/api-key`, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json; charset=utf-8",
            "user-agent": "Hunch-API/1.0",
            POLY_ADDRESS: walletAddress,
            POLY_SIGNATURE: body.signature,
            POLY_TIMESTAMP: body.timestamp,
            POLY_NONCE: body.nonce.toString(),
          },
          body: JSON.stringify({}),
        });

        if (!upstream.ok) {
          const text = await upstream.text().catch(() => "");
          const message = text.trim().length
            ? text
            : `${upstream.status} ${upstream.statusText}`;
          reply.code(upstream.status === 401 ? 400 : 502);
          return reply.send({
            error: "Polymarket auth failed",
            message,
          });
        }

        const payload = (await upstream.json()) as unknown;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          reply.code(502);
          return reply.send({
            error: "Polymarket auth failed",
            message: "Unexpected response from Polymarket",
          });
        }

        const record = payload as Record<string, unknown>;
        const apiKeyRaw =
          record.apiKey ??
          record.api_key ??
          record.key ??
          record.apiKeyId ??
          record.api_key_id;
        const secretRaw =
          record.secret ?? record.apiSecret ?? record.api_secret;
        const passphraseRaw = record.passphrase ?? record.apiPassphrase;

        const apiKey = typeof apiKeyRaw === "string" ? apiKeyRaw.trim() : "";
        const apiSecret = typeof secretRaw === "string" ? secretRaw.trim() : "";
        const passphrase =
          typeof passphraseRaw === "string" ? passphraseRaw.trim() : "";

        if (!apiKey || !apiSecret || !passphrase) {
          reply.code(502);
          return reply.send({
            error: "Polymarket auth failed",
            message: "Polymarket did not return apiKey/secret/passphrase",
          });
        }

        const additionalData: Record<string, unknown> = {
          passphrase,
          ...(body.funderAddress ? { funderAddress: body.funderAddress } : {}),
        };

        await AuthService.createOrUpdateVenueCredentials(
          user.id,
          walletAddress,
          "polymarket",
          apiKey,
          apiSecret,
          additionalData,
        );

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ ok: true });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress },
          "Polymarket connect failed",
        );
        reply.code(500);
        return reply.send({
          error: "Polymarket connect failed",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * POST /auth/polymarket/funder
   * Update (or clear) the Polymarket funder/vault address for this signer wallet.
   */
  z.post(
    "/auth/polymarket/funder",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketFunderBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!walletAddress.startsWith("0x")) {
        reply.code(400);
        return reply.send({
          error: "Polymarket funder update requires an EVM wallet address",
        });
      }

      try {
        const updated = await AuthService.updateVenueFunderAddress(
          user.id,
          walletAddress,
          "polymarket",
          request.body.funderAddress,
        );

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          venue: "polymarket",
          walletAddress,
          funderAddress: updated.funderAddress,
          funderUpdatedAt: updated.funderUpdatedAt,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress },
          "Polymarket funder update failed",
        );
        reply.code(400);
        return reply.send({
          error: "Polymarket funder update failed",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * GET /auth/polymarket/relayer-status
   * Returns whether relayer signing is configured on the server.
   */
  z.get(
    "/auth/polymarket/relayer-status",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        response: {
          200: polymarketRelayerStatusResponseSchema,
          401: zod.object({ error: zod.string() }),
        },
      },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const key = env.polymarketBuilderApiKey;
      const secret = env.polymarketBuilderApiSecret;
      const passphrase = env.polymarketBuilderApiPassphrase;
      const enabled = Boolean(key && secret && passphrase);

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        enabled,
        reason: enabled ? undefined : "Builder credentials not configured.",
      });
    },
  );

  /**
   * POST /auth/polymarket/relayer-sign
   * Returns builder auth headers for the Polymarket relayer (used by client-side relayer requests).
   */
  z.post(
    "/auth/polymarket/relayer-sign",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketRelayerSignBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const key = env.polymarketBuilderApiKey;
      const secret = env.polymarketBuilderApiSecret;
      const passphrase = env.polymarketBuilderApiPassphrase;

      if (!key || !secret || !passphrase) {
        reply.code(501);
        return reply.send({
          error: "Polymarket relayer signing is not configured",
        });
      }

      const { method, path, body, timestamp } = request.body;
      const bodyString =
        typeof body === "string"
          ? body
          : body == null
            ? ""
            : JSON.stringify(body);

      try {
        const signer = new BuilderSigner({ key, secret, passphrase });
        const headers = signer.createBuilderHeaderPayload(
          method,
          path,
          bodyString,
          timestamp,
        );

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(headers);
      } catch (error) {
        app.log.error(
          { error, userId: user.id },
          "Polymarket relayer signing failed",
        );
        reply.code(500);
        return reply.send({
          error: "Polymarket relayer signing failed",
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
