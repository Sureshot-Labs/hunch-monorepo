import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import crypto from "node:crypto";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { ethers } from "ethers";
import { z as zod } from "zod";
import {
  AuthService,
  PrivyTerminalAuthError,
  type User,
  type UserWallet,
  WalletAlreadyExistsError,
  WalletNotFoundError,
  WalletUnlinkNotAllowedError,
  createAuthMiddleware,
} from "../auth.js";
import { checkRateLimitForSecurityClientIp } from "../lib/request-ip.js";
import { normalizeWalletNameInput } from "../lib/wallet-name.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import {
  PrivyAccessTokenError,
  PrivyService,
  PrivyTelegramIdentityMismatchError,
  type PrivyWalletProfile,
  PrivyUpstreamError,
} from "../privy-service.js";
import {
  addWalletBodySchema,
  authMeSuccessResponseSchema,
  authErrorResponseSchema,
  authPrivyBodySchema,
  authPrivySuccessResponseSchema,
  authInviteRequiredResponseSchema,
  authPrivyTerminalErrorResponseSchema,
  walletNonceBodySchema,
  polymarketConnectBodySchema,
  polymarketEmbeddedConnectBodySchema,
  polymarketCredentialsBodySchema,
  polymarketFunderBodySchema,
  polymarketRelayerStatusResponseSchema,
  polymarketRelayerSignBodySchema,
  removeWalletBodySchema,
  updateWalletNameBodySchema,
  venueCredentialsBodySchema,
} from "../schemas/auth.js";
import { resolveAuthAccessPolicy } from "../services/runtime-policies.js";
import { validatePolymarketFunderSelection } from "../services/polymarket-funder.js";
import { requestPolymarketCredentials } from "../services/polymarket-credentials.js";
import {
  createPolymarketRelayerHeaderPayload,
  validatePolymarketRelayerSignRequestForLinkedWallets,
} from "../services/polymarket-relayer-signing.js";
import {
  buildEmbeddedPolymarketConnectRequest,
  executeEmbeddedPolymarketConnectRequest,
  resolveEmbeddedPolymarketWalletContext,
} from "../services/polymarket-embedded.js";
import {
  attachReferralCodeForExistingUser,
  getReferralAttachmentStatus,
  type ReferralAttachmentStatus,
} from "../services/rewards.js";
import { buildReferralSignupAttributionPayload } from "../services/analytics-referrals.js";
import {
  DEFAULT_PRIVY_TERMINAL_AUTH_MESSAGE,
  getPrivyTerminalAuthMessage,
} from "../lib/privy-auth-errors.js";

const WALLET_TYPES = new Set(["ethereum", "solana"]);
const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function readRequestHeaderValue(
  headers: Record<string, unknown>,
  name: string,
): string | undefined {
  const raw = headers[name.toLowerCase()];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return undefined;
}

function readRequestUserAgent(headers: Record<string, unknown>): string {
  return (
    readRequestHeaderValue(headers, "x-hunch-user-agent") ??
    readRequestHeaderValue(headers, "user-agent") ??
    "unknown"
  );
}

function resolvePostSignupOnboardingRequired(user: User): boolean {
  return user.createdAt >= env.postSignupOnboardingEligibleAfter;
}

function buildAuthUserPayload(user: User) {
  const legacyAdminAccessEnabled =
    env.adminAuthEnabled && env.adminAuthLegacyFallback;
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    isAdmin: legacyAdminAccessEnabled ? user.isAdmin : false,
    isActive: user.isActive,
    isVerified: user.isVerified,
    postSignupOnboardingRequired: resolvePostSignupOnboardingRequired(user),
    createdAt: user.createdAt.toISOString(),
    lastLoginAt: user.lastLoginAt?.toISOString(),
  };
}

function buildPrivyWalletProfileLookup(
  walletProfiles: PrivyWalletProfile[] | null | undefined,
): Map<string, PrivyWalletProfile> {
  const lookup = new Map<string, PrivyWalletProfile>();
  for (const profile of walletProfiles ?? []) {
    const walletType = normalizeWalletType(profile.walletType);
    const normalizedAddress = normalizeWalletAddressForType(
      walletType,
      profile.address,
    );
    lookup.set(`${walletType}:${normalizedAddress}`, profile);
  }
  return lookup;
}

function buildAuthWalletPayloads(
  wallets: UserWallet[],
  walletProfiles?: PrivyWalletProfile[] | null,
) {
  const walletProfileLookup = buildPrivyWalletProfileLookup(walletProfiles);
  return wallets.map((wallet) => {
    const walletType = normalizeWalletType(wallet.walletType);
    const normalizedAddress = normalizeWalletAddressForType(
      walletType,
      wallet.walletAddress,
    );
    const profile = walletProfileLookup.get(
      `${walletType}:${normalizedAddress}`,
    );
    const isEmbeddedWallet = profile?.source === "embedded";
    const isSmartWallet = profile?.source === "smart";
    const isInternalWallet = profile?.isInternalWallet;
    const walletName = wallet.name?.trim();

    return {
      id: wallet.id,
      walletAddress: wallet.walletAddress,
      walletType: wallet.walletType,
      walletSource: profile?.source ?? "unknown",
      isEmbeddedWallet,
      isSmartWallet,
      isInternalWallet,
      name: walletName || (isInternalWallet ? "Trading Wallet" : null),
      isPrimary: wallet.isPrimary,
      isVerified: wallet.isVerified,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  });
}

function getPolymarketConnectFailureResponse(error: unknown): {
  status: number;
  body: { error: string; message?: string };
} {
  const message =
    error instanceof Error ? error.message : "Polymarket connect failed";
  const status =
    error instanceof Error &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : null;

  if (/not deployed yet|valid EVM address/i.test(message)) {
    return {
      status: 400,
      body: { error: "Polymarket connect failed", message },
    };
  }

  if (status === 401) {
    return {
      status: 400,
      body: { error: "Polymarket auth failed", message },
    };
  }

  if (status != null && status >= 400 && status < 500) {
    return {
      status,
      body: { error: "Polymarket auth failed", message },
    };
  }

  if (status != null) {
    return {
      status: 502,
      body: { error: "Polymarket auth failed", message },
    };
  }

  return {
    status: 500,
    body: { error: "Polymarket connect failed", message },
  };
}

function getPrivyAuthFailureResponse(error: unknown): {
  status: 400 | 401 | 500 | 503;
  body: { error: string; message?: string };
} {
  if (error instanceof PrivyAccessTokenError) {
    return {
      status: 401,
      body: {
        error: "invalid_privy_access_token",
        message: "Privy authentication failed. Please try logging in again.",
      },
    };
  }

  if (error instanceof PrivyUpstreamError) {
    return {
      status: 503,
      body: {
        error: "auth_unavailable",
        message:
          "Authentication is temporarily unavailable. Please try again later.",
      },
    };
  }

  if (
    error instanceof Error &&
    error.message === "No wallet address found in Privy user data"
  ) {
    return {
      status: 400,
      body: {
        error: "invalid_privy_user",
        message: "No supported wallet address was found in the Privy account.",
      },
    };
  }

  return {
    status: 500,
    body: {
      error: "auth_unavailable",
      message:
        "Authentication is temporarily unavailable. Please try again later.",
    },
  };
}

function normalizeWalletType(input?: string): string {
  const raw = (input ?? "").trim().toLowerCase();
  return raw.length ? raw : "ethereum";
}

function normalizeWalletAddressForType(
  walletType: string,
  address: string,
): string {
  const trimmed = address.trim();
  if (walletType === "ethereum") return trimmed.toLowerCase();
  return trimmed;
}

function assertWalletAddress(walletType: string, address: string): void {
  if (!WALLET_TYPES.has(walletType)) {
    throw new Error("Unsupported wallet type");
  }
  if (walletType === "ethereum") {
    if (!ETH_ADDRESS_RE.test(address)) {
      throw new Error("Invalid wallet address format");
    }
    return;
  }

  try {
    // PublicKey will throw if invalid base58 or wrong length.
    new PublicKey(address);
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : "Invalid wallet address format",
    );
  }
}

function decodeSignatureBytes(signature: string): Buffer {
  try {
    return Buffer.from(bs58.decode(signature));
  } catch {
    try {
      return Buffer.from(signature, "base64");
    } catch {
      throw new Error("Invalid signature encoding");
    }
  }
}

function verifySolanaSignature(params: {
  walletAddress: string;
  message: string;
  signature: string;
}): boolean {
  const publicKey = new PublicKey(params.walletAddress);
  const publicKeyBytes = Buffer.from(publicKey.toBytes());
  const key = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
    format: "der",
    type: "spki",
  });
  const messageBytes = Buffer.from(params.message, "utf8");
  const signatureBytes = decodeSignatureBytes(params.signature);
  return crypto.verify(null, messageBytes, key, signatureBytes);
}

type AuthAccessState = "off" | "prompt" | "required";
type InviteReason =
  | "missing_code"
  | "invalid_code"
  | "not_found"
  | "self_referral";

function mapAttachStatusToInviteReason(
  status: ReferralAttachmentStatus,
): InviteReason | null {
  switch (status) {
    case "invalid_code":
      return "invalid_code";
    case "not_found":
      return "not_found";
    case "self_referral":
      return "self_referral";
    default:
      return null;
  }
}

function resolvePolicyVersionToken(input: {
  source: "env" | "db";
  effectiveAt: Date | null;
}): string {
  if (input.source === "db" && input.effectiveAt) {
    return input.effectiveAt.toISOString();
  }
  return "env-default-v1";
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  z.get("/auth/invite-status", async (_request, reply) => {
    const resolved = await resolveAuthAccessPolicy(pool);
    const state = resolved.effective.state as AuthAccessState;
    const policyVersion = resolvePolicyVersionToken({
      source: resolved.source,
      effectiveAt: resolved.effectiveAt,
    });
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Type", "application/json; charset=utf-8");
    return reply.send({ state, policyVersion });
  });

  /**
   * POST /auth/privy
   * Authenticate user using Privy access token
   */
  z.post(
    "/auth/privy",
    {
      schema: {
        body: authPrivyBodySchema,
        response: {
          200: authPrivySuccessResponseSchema,
          400: authErrorResponseSchema,
          401: authErrorResponseSchema,
          403: authInviteRequiredResponseSchema,
          409: authPrivyTerminalErrorResponseSchema,
          429: authErrorResponseSchema,
          500: authErrorResponseSchema,
          503: authErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const body = request.body;

      const userAgent = readRequestUserAgent(
        request.headers as Record<string, unknown>,
      );
      let clientIp = "unknown";
      let primaryWalletAddress = "unknown";

      try {
        const rateLimit = await checkRateLimitForSecurityClientIp(request, {
          keyPrefix: "auth:privy",
          maxRequests: 20,
          windowMs: 60_000,
          onError: "fail_closed",
        });
        if (!rateLimit.allowed) {
          reply.code(429);
          return reply.send({ error: "Rate limit exceeded" });
        }
        clientIp = rateLimit.clientIp;

        const {
          claims,
          user: privyUser,
          walletAddresses,
          primaryWalletAddress: resolvedPrimaryWalletAddress,
        } = await PrivyService.verifyTokenAndGetUser(body.accessToken, {
          expectedAddedWalletAddresses: body.expectedAddedWalletAddresses,
          expectedRemovedWalletAddresses: body.expectedRemovedWalletAddresses,
          expectedTelegramUserId: body.expectedTelegramUserId,
        });
        primaryWalletAddress = resolvedPrimaryWalletAddress ?? "unknown";

        if (!resolvedPrimaryWalletAddress) {
          reply.code(400);
          return reply.send({
            error: "invalid_privy_user",
            message:
              "No supported wallet address was found in the Privy account.",
          });
        }

        const accessPolicyResolved = await resolveAuthAccessPolicy(pool);
        const policyVersion = resolvePolicyVersionToken({
          source: accessPolicyResolved.source,
          effectiveAt: accessPolicyResolved.effectiveAt,
        });

        let user: Awaited<
          ReturnType<typeof AuthService.createOrUpdateUserFromPrivy>
        >;
        let invitePrompt = false;
        let inviteReason: InviteReason | null = null;
        let referralSignupAttribution: ReturnType<
          typeof buildReferralSignupAttributionPayload
        > | null = null;
        let effectiveAccessState = accessPolicyResolved.effective
          .state as AuthAccessState;

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          user = await AuthService.createOrUpdateUserFromPrivyWithClient(
            client,
            privyUser,
            claims,
          );

          // Admin bypass is always-on and non-configurable.
          if (user.isAdmin) {
            effectiveAccessState = "off";
          }

          const referralCode =
            typeof body.referralCode === "string" ? body.referralCode : "";
          const hasReferralCode = referralCode.trim().length > 0;
          const inviteConfirmed = body.inviteConfirmed === true;

          if (
            effectiveAccessState === "required" ||
            effectiveAccessState === "prompt"
          ) {
            const current = await getReferralAttachmentStatus(client, {
              userId: user.id,
            });
            let hasReferrer = current.hasReferrer;

            if (!hasReferrer) {
              if (!inviteConfirmed) {
                inviteReason = hasReferralCode ? null : "missing_code";
              } else if (!hasReferralCode) {
                inviteReason = "missing_code";
              } else {
                const attached = await attachReferralCodeForExistingUser(
                  client,
                  {
                    userId: user.id,
                    referralCode,
                  },
                );
                inviteReason = mapAttachStatusToInviteReason(attached.status);
                if (inviteReason == null) {
                  hasReferrer = true;
                  if (
                    attached.status === "attached" &&
                    attached.referral.code != null
                  ) {
                    referralSignupAttribution =
                      buildReferralSignupAttributionPayload({
                        userId: user.id,
                        referralCode: attached.referral.code,
                      });
                  }
                }
              }
            }

            if (
              effectiveAccessState === "required" &&
              !hasReferrer &&
              !inviteConfirmed
            ) {
              inviteReason = "missing_code";
            }

            if (effectiveAccessState === "required" && inviteReason) {
              await client.query("ROLLBACK");
            } else {
              if (effectiveAccessState === "prompt" && !hasReferrer) {
                invitePrompt = true;
                if (!inviteReason) {
                  inviteReason = "missing_code";
                }
              }
              await client.query("COMMIT");
            }
          } else {
            if (hasReferralCode) {
              try {
                const attached = await attachReferralCodeForExistingUser(
                  client,
                  {
                    userId: user.id,
                    referralCode,
                  },
                );
                if (
                  attached.status === "attached" &&
                  attached.referral.code != null
                ) {
                  referralSignupAttribution =
                    buildReferralSignupAttributionPayload({
                      userId: user.id,
                      referralCode: attached.referral.code,
                    });
                }
              } catch (error) {
                app.log.warn(
                  { error, userId: user.id },
                  "Failed to attach referral code",
                );
              }
            }
            await client.query("COMMIT");
          }
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }

        if (effectiveAccessState === "required" && inviteReason) {
          await AuthService.recordAuthAttempt(
            primaryWalletAddress,
            "privy-auth",
            false,
            clientIp,
            userAgent,
            `invite_required:${inviteReason}`,
          );
          reply.code(403);
          return reply.send({
            error: "invite_required",
            reason: inviteReason,
            inviteOnly: true,
            invitePolicyVersion: policyVersion,
          });
        }

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
          user: buildAuthUserPayload(user),
          session: {
            token: sessionToken,
            expiresAt: session.expiresAt.toISOString(),
            csrfToken: session.csrfToken,
          },
          walletAddresses,
          primaryWalletAddress,
          privyUserId: privyUser.id,
          invitePrompt: invitePrompt || undefined,
          inviteReason: invitePrompt ? (inviteReason ?? undefined) : undefined,
          invitePolicyVersion:
            invitePrompt && effectiveAccessState === "prompt"
              ? policyVersion
              : undefined,
          referralSignupAttribution: referralSignupAttribution ?? undefined,
        });
      } catch (error) {
        const authFailureMessage =
          error instanceof Error ? error.message : "Unknown error";

        if (error instanceof PrivyTelegramIdentityMismatchError) {
          app.log.warn({ error }, "Privy Telegram identity did not match");

          await AuthService.recordAuthAttempt(
            primaryWalletAddress,
            "privy-auth",
            false,
            clientIp,
            userAgent,
            authFailureMessage,
          );

          reply.code(409);
          return reply.send({
            error: "telegram_identity_mismatch",
            message: getPrivyTerminalAuthMessage("telegram_identity_mismatch"),
            actualTelegramUserId: error.actualTelegramUserId ?? undefined,
            expectedTelegramUserId: error.expectedTelegramUserId,
          });
        }

        if (error instanceof PrivyTerminalAuthError) {
          app.log.warn({ error }, "Privy authentication requires user action");

          await AuthService.recordAuthAttempt(
            primaryWalletAddress,
            "privy-auth",
            false,
            clientIp,
            userAgent,
            authFailureMessage,
          );

          reply.code(409);
          const terminalMessage =
            getPrivyTerminalAuthMessage(error.code) ||
            DEFAULT_PRIVY_TERMINAL_AUTH_MESSAGE;
          return reply.send({
            error: error.code,
            message: terminalMessage,
            actualTelegramUserId: error.details?.actualTelegramUserId,
            conflictTelegramUserId: error.details?.conflictTelegramUserId,
            conflictWalletAddress: error.details?.conflictWalletAddress,
            conflictWalletAddresses: error.details?.conflictWalletAddresses,
            expectedTelegramUserId: error.details?.expectedTelegramUserId,
          });
        }

        const authFailure = getPrivyAuthFailureResponse(error);
        const log = authFailure.status >= 500 ? app.log.error : app.log.warn;

        log({ error }, "Privy authentication failed");

        await AuthService.recordAuthAttempt(
          primaryWalletAddress,
          "privy-auth",
          false,
          clientIp,
          userAgent,
          authFailureMessage,
        );

        reply.code(authFailure.status);
        return reply.send(authFailure.body);
      }
    },
  );

  /**
   * POST /auth/logout
   * Logout user and invalidate session
   */
  z.post(
    "/auth/logout",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
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
        });
      }
    },
  );

  /**
   * GET /auth/me
   * Get current user information
   */
  z.get(
    "/auth/me",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        response: {
          200: authMeSuccessResponseSchema,
          401: authErrorResponseSchema,
          500: authErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const wallets = await AuthService.getUserWallets(user.id);
        let walletProfiles: PrivyWalletProfile[] | null = null;
        if (user.privyUserId) {
          try {
            const privyUser = await PrivyService.getUserById(user.privyUserId);
            walletProfiles = PrivyService.classifyWallets(privyUser);
          } catch (error) {
            app.log.warn(
              { error, userId: user.id, privyUserId: user.privyUserId },
              "Failed to enrich auth wallets with Privy wallet profiles",
            );
          }
        }
        const polymarketCreds = await AuthService.getVenueCredentialsInfo(
          user.id,
          "polymarket",
          walletAddress,
        );

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          user: buildAuthUserPayload(user),
          wallets: buildAuthWalletPayloads(wallets, walletProfiles),
          polymarketCredentials: polymarketCreds
            ? {
                id: polymarketCreds.id,
                walletAddress: polymarketCreds.walletAddress,
                isActive: polymarketCreds.isActive,
                createdAt: polymarketCreds.createdAt.toISOString(),
                lastUsedAt: polymarketCreds.lastUsedAt?.toISOString() ?? null,
              }
            : null,
          currentWallet: walletAddress,
        });
      } catch (error) {
        app.log.error({ error, userId: user.id }, "Get user info failed");
        reply.code(500);
        return reply.send({
          error: "Failed to get user information",
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

      try {
        const { apiKey, apiSecret, passphrase } =
          await requestPolymarketCredentials({
            walletAddress,
            signature: body.signature,
            timestamp: body.timestamp,
            nonce: body.nonce,
          });

        const validatedPolymarketFunder = body.funderAddress
          ? await validatePolymarketFunderSelection({
              signer: walletAddress,
              funderAddress: body.funderAddress,
              includeMagicProxy: true,
            })
          : { funderAddress: null };
        const additionalData: Record<string, unknown> = {
          passphrase,
          ...(validatedPolymarketFunder.funderAddress
            ? { funderAddress: validatedPolymarketFunder.funderAddress }
            : {}),
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
        const failure = getPolymarketConnectFailureResponse(error);
        if (failure.status < 500) {
          reply.code(failure.status);
          return reply.send(failure.body);
        }
        app.log.error(
          { error, userId: user.id, walletAddress },
          "Polymarket connect failed",
        );
        reply.code(failure.status);
        return reply.send(failure.body);
      }
    },
  );

  z.post(
    "/auth/polymarket/connect-embedded",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketEmbeddedConnectBodySchema },
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

      try {
        const context = await resolveEmbeddedPolymarketWalletContext({
          user,
          signer: walletAddress,
        });
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const nonce = crypto.randomInt(1_000_000_000);
        const connectRequest = buildEmbeddedPolymarketConnectRequest({
          context,
          timestamp,
          nonce,
        });
        const signature = await executeEmbeddedPolymarketConnectRequest({
          request: connectRequest,
          authorizationSignature: request.body.authorizationSignature,
        });
        const { apiKey, apiSecret, passphrase } =
          await requestPolymarketCredentials({
            walletAddress,
            signature,
            timestamp,
            nonce,
          });

        const validatedPolymarketFunder = request.body.funderAddress
          ? await validatePolymarketFunderSelection({
              signer: walletAddress,
              funderAddress: request.body.funderAddress,
              includeMagicProxy: true,
            })
          : { funderAddress: null };
        const additionalData: Record<string, unknown> = {
          passphrase,
          ...(validatedPolymarketFunder.funderAddress
            ? { funderAddress: validatedPolymarketFunder.funderAddress }
            : {}),
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
        return reply.send({
          ok: true,
          timestamp,
          nonce,
          funderAddress: validatedPolymarketFunder.funderAddress,
        });
      } catch (error) {
        const failure = getPolymarketConnectFailureResponse(error);
        if (failure.status < 500) {
          reply.code(failure.status);
          return reply.send(failure.body);
        }
        app.log.error(
          { error, userId: user.id, walletAddress },
          "Embedded Polymarket connect failed",
        );
        reply.code(failure.status);
        return reply.send(failure.body);
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
        const validatedPolymarketFunder =
          await validatePolymarketFunderSelection({
            signer: walletAddress,
            funderAddress: request.body.funderAddress,
            includeMagicProxy: true,
          });
        const updated = await AuthService.updateVenueFunderAddress(
          user.id,
          walletAddress,
          "polymarket",
          validatedPolymarketFunder.funderAddress,
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
        const message =
          error instanceof Error
            ? error.message
            : "Polymarket funder update failed";
        app.log.error(
          { error, userId: user.id, walletAddress },
          "Polymarket funder update failed",
        );
        reply.code(400);
        return reply.send({
          error: "Polymarket funder update failed",
          message,
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
   * Returns builder-HMAC auth headers for the Polymarket gasless relayer only.
   * CLOB V2 order builder attribution must use the order builder field instead.
   */
  z.post(
    "/auth/polymarket/relayer-sign",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: polymarketRelayerSignBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
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

      try {
        const wallets = await AuthService.getUserWallets(user.id);
        validatePolymarketRelayerSignRequestForLinkedWallets({
          method,
          path,
          body,
          walletAddresses: wallets.map((wallet) => wallet.walletAddress),
        });
      } catch (error) {
        reply.code(400);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Invalid Polymarket relayer signing request",
        });
      }

      try {
        const headers = createPolymarketRelayerHeaderPayload({
          key,
          secret,
          passphrase,
          method,
          path,
          body,
          timestamp,
        });

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
        let walletProfiles: PrivyWalletProfile[] | null = null;
        if (user.privyUserId) {
          try {
            const privyUser = await PrivyService.getUserById(user.privyUserId);
            walletProfiles = PrivyService.classifyWallets(privyUser);
          } catch (error) {
            app.log.warn(
              { error, userId: user.id, privyUserId: user.privyUserId },
              "Failed to enrich wallet list with Privy wallet profiles",
            );
          }
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          wallets: buildAuthWalletPayloads(wallets, walletProfiles),
        });
      } catch (error) {
        app.log.error({ error, userId: user.id }, "Failed to get user wallets");
        reply.code(500);
        return reply.send({
          error: "Failed to get user wallets",
        });
      }
    },
  );

  /**
   * POST /auth/wallets/nonce
   * Get a nonce and message to sign for manual wallet linking.
   */
  z.post(
    "/auth/wallets/nonce",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: walletNonceBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const body = request.body;
      const walletType = normalizeWalletType(body.walletType);
      const walletAddress = normalizeWalletAddressForType(
        walletType,
        body.walletAddress,
      );

      try {
        assertWalletAddress(walletType, walletAddress);
      } catch {
        reply.code(400);
        return reply.send({
          error: "Invalid wallet data",
        });
      }

      try {
        const rateLimit = await checkRateLimitForSecurityClientIp(request, {
          keyPrefix: "auth:wallet-nonce",
          maxRequests: 30,
          windowMs: 60_000,
          onError: "fail_closed",
        });
        if (!rateLimit.allowed) {
          reply.code(429);
          return reply.send({ error: "Rate limit exceeded" });
        }

        const existing = await AuthService.getUserWalletByAddress(
          user.id,
          walletAddress,
        );
        if (existing) {
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send({
            ok: true,
            alreadyLinked: true,
            walletAddress: existing.walletAddress,
            walletType: existing.walletType,
          });
        }

        const match =
          walletType === "ethereum"
            ? "lower(wallet_address) = lower($2)"
            : "wallet_address = $2";
        const conflict = await pool.query<{ user_id: string }>(
          `SELECT user_id
           FROM user_wallets
           WHERE wallet_type = $1
             AND ${match}
             AND user_id <> $3
           LIMIT 1`,
          [walletType, walletAddress, user.id],
        );
        if (conflict.rows.length > 0) {
          reply.code(409);
          return reply.send({ error: "Wallet address already exists" });
        }

        const nonceEntry = await AuthService.createWalletLinkNonce({
          userId: user.id,
          walletAddress,
          walletType,
        });
        const message = AuthService.buildWalletLinkMessage({
          walletAddress,
          nonce: nonceEntry.nonce,
          expiresAt: nonceEntry.expiresAt,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          walletAddress,
          walletType,
          nonce: nonceEntry.nonce,
          expiresAt: nonceEntry.expiresAt,
          message,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress },
          "Failed to create wallet nonce",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to create wallet nonce",
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

      const walletType = normalizeWalletType(body.walletType);
      const walletAddress = normalizeWalletAddressForType(
        walletType,
        body.walletAddress,
      );
      const verificationSignature = body.verificationSignature;
      const nonce = body.nonce;

      try {
        assertWalletAddress(walletType, walletAddress);
      } catch {
        reply.code(400);
        return reply.send({
          error: "Invalid wallet data",
        });
      }

      try {
        const rateLimit = await checkRateLimitForSecurityClientIp(request, {
          keyPrefix: "auth:add-wallet",
          maxRequests: 20,
          windowMs: 60_000,
          onError: "fail_closed",
        });
        if (!rateLimit.allowed) {
          reply.code(429);
          return reply.send({ error: "Rate limit exceeded" });
        }

        const nonceResult = await AuthService.consumeWalletLinkNonce({
          userId: user.id,
          walletAddress,
          walletType,
          nonce,
        });

        if (!nonceResult) {
          reply.code(400);
          return reply.send({ error: "Invalid or expired nonce" });
        }

        const message = AuthService.buildWalletLinkMessage({
          walletAddress,
          nonce,
          expiresAt: nonceResult.expiresAt,
        });

        if (walletType === "ethereum") {
          let recovered: string;
          try {
            recovered = ethers.verifyMessage(message, verificationSignature);
          } catch {
            reply.code(400);
            return reply.send({
              error: "Invalid wallet signature",
            });
          }

          if (recovered.toLowerCase() !== walletAddress.toLowerCase()) {
            reply.code(400);
            return reply.send({
              error: "Signature does not match wallet address",
            });
          }
        } else {
          const valid = verifySolanaSignature({
            walletAddress,
            message,
            signature: verificationSignature,
          });
          if (!valid) {
            reply.code(400);
            return reply.send({ error: "Invalid wallet signature" });
          }
        }

        const newWallet = await AuthService.addWallet(user.id, {
          walletAddress,
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
            name: newWallet.name,
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
        });
      }
    },
  );

  /**
   * PATCH /auth/wallets
   * Update linked wallet display name
   */
  z.patch(
    "/auth/wallets",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: updateWalletNameBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const body = request.body;
      const walletAddress = body.walletAddress.trim();
      let walletName: string | null;
      try {
        walletName = normalizeWalletNameInput(body.name);
      } catch (error) {
        reply.code(400);
        return reply.send({
          error: error instanceof Error ? error.message : "Invalid wallet name",
        });
      }

      try {
        const rateLimit = await checkRateLimitForSecurityClientIp(request, {
          keyPrefix: "auth:update-wallet-name",
          maxRequests: 40,
          windowMs: 60_000,
          onError: "fail_closed",
        });
        if (!rateLimit.allowed) {
          reply.code(429);
          return reply.send({ error: "Rate limit exceeded" });
        }

        const wallet = await AuthService.updateWalletName(
          user.id,
          walletAddress,
          walletName,
        );
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          wallet: {
            id: wallet.id,
            walletAddress: wallet.walletAddress,
            walletType: wallet.walletType,
            name: wallet.name,
            isPrimary: wallet.isPrimary,
            isVerified: wallet.isVerified,
            createdAt: wallet.createdAt,
            updatedAt: wallet.updatedAt,
          },
        });
      } catch (error) {
        if (error instanceof WalletNotFoundError) {
          reply.code(404);
          return reply.send({ error: "Wallet not found" });
        }
        app.log.error(
          { error, userId: user.id, walletAddress },
          "Failed to update wallet name",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to update wallet name",
        });
      }
    },
  );

  /**
   * DELETE /auth/wallets
   * Remove a wallet from the user account (no data transfer; use admin merge for that).
   */
  z.delete(
    "/auth/wallets",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: removeWalletBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const body = request.body;

      try {
        const rateLimit = await checkRateLimitForSecurityClientIp(request, {
          keyPrefix: "auth:remove-wallet",
          maxRequests: 20,
          windowMs: 60_000,
          onError: "fail_closed",
        });
        if (!rateLimit.allowed) {
          reply.code(429);
          return reply.send({ error: "Rate limit exceeded" });
        }

        let walletProfiles: PrivyWalletProfile[] | null = null;
        if (user.privyUserId) {
          try {
            const privyUser = await PrivyService.getUserById(user.privyUserId);
            walletProfiles = PrivyService.classifyWallets(privyUser);
          } catch (error) {
            app.log.warn(
              { error, userId: user.id, privyUserId: user.privyUserId },
              "Failed to verify Privy wallet profiles before wallet removal",
            );
            reply.code(503);
            return reply.send({
              error: "Unable to verify wallet sign-in methods",
            });
          }
        }

        const result = await AuthService.removeWallet(
          user.id,
          body.walletAddress,
          {
            userEmail: user.email ?? null,
            walletProfiles,
          },
        );

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          removed: result.removed.walletAddress,
          nextPrimaryWalletAddress: result.nextPrimaryWalletAddress,
          remainingWallets: buildAuthWalletPayloads(
            result.remainingWallets,
            walletProfiles,
          ),
        });
      } catch (error) {
        if (error instanceof WalletNotFoundError) {
          reply.code(404);
          return reply.send({ error: "Wallet not found" });
        }
        if (error instanceof WalletUnlinkNotAllowedError) {
          reply.code(400);
          return reply.send({ error: error.message });
        }

        app.log.error(
          { error, userId: user.id, walletAddress: body.walletAddress },
          "Failed to remove wallet",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to remove wallet",
        });
      }
    },
  );
};
