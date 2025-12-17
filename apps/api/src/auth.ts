import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import type { FastifyReply, FastifyRequest } from "fastify";
import { pool } from "./db.js";
import "./env.js";
import { PrivyService, PrivyUser, PrivyClaims } from "./privy-service.js";

// JWT secret - in production, this should be in environment variables
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable is required");
}
const JWT_EXPIRES_IN: SignOptions["expiresIn"] =
  (process.env.JWT_EXPIRES_IN as SignOptions["expiresIn"]) ?? "24h";

export interface User {
  id: string;
  email?: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  isActive: boolean;
  isVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt?: Date;
}

type UserRow = {
  id: string;
  email: string | null;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  is_active: boolean;
  is_verified: boolean;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
};

function mapUserRow(row: UserRow): User {
  return {
    id: row.id,
    email: row.email ?? undefined,
    username: row.username ?? undefined,
    displayName: row.display_name ?? undefined,
    avatarUrl: row.avatar_url ?? undefined,
    isActive: row.is_active,
    isVerified: row.is_verified,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at ?? undefined,
  };
}

export interface UserWallet {
  id: string;
  userId: string;
  walletAddress: string;
  walletType: string;
  isPrimary: boolean;
  isVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export class WalletAlreadyExistsError extends Error {
  constructor() {
    super("Wallet address already exists");
  }
}

type UserWalletRow = {
  id: string;
  user_id: string;
  wallet_address: string;
  wallet_type: string;
  is_primary: boolean;
  is_verified: boolean;
  created_at: Date;
  updated_at: Date;
};

export interface VenueCredentials {
  id: string;
  userId: string;
  walletAddress: string;
  venue: "polymarket" | "kalshi" | "limitless";
  apiKey: string;
  apiSecret: string;
  additionalData?: unknown; // For venue-specific data
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt?: Date;
}

type VenueCredentialsRow = {
  id: string;
  user_id: string;
  wallet_address: string;
  venue: "polymarket" | "kalshi" | "limitless";
  api_key: string;
  api_secret: string;
  additional_data: unknown | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date | null;
};

// Backward compatibility
export type PolymarketCredentials = VenueCredentials;

export interface AuthSession {
  id: string;
  userId: string;
  sessionToken: string;
  walletAddress: string;
  ipAddress?: string;
  userAgent?: string;
  isActive: boolean;
  expiresAt: Date;
  createdAt: Date;
  lastAccessedAt: Date;
}

// Authentication utilities
export class AuthService {
  /**
   * Generate a JWT token for a user session
   */
  static generateToken(userId: string): string {
    const payload = {
      userId,
      iat: Math.floor(Date.now() / 1000),
      jti: crypto.randomBytes(16).toString("hex"), // Unique token identifier
    };

    return jwt.sign(payload, JWT_SECRET as string, {
      expiresIn: JWT_EXPIRES_IN,
    });
  }

  /**
   * Verify and decode a JWT token
   */
  static verifyToken(token: string): { userId: string } | null {
    try {
      const decoded = jwt.verify(token, JWT_SECRET as string);
      if (typeof decoded !== "object" || decoded === null) return null;
      const userId = (decoded as Record<string, unknown>).userId;
      if (typeof userId !== "string") return null;
      return { userId };
    } catch {
      return null;
    }
  }

  /**
   * Generate a nonce for wallet signature verification
   */
  static generateNonce(): string {
    return crypto.randomBytes(32).toString("hex");
  }

  /**
   * Verify wallet signature (simplified - in production, use proper signature verification)
   */
  static verifyWalletSignature(
    walletAddress: string,
    signature: string,
    message: string,
  ): boolean {
    // This is a simplified implementation
    // In production, you should use proper signature verification libraries
    // like ethers.js or web3.js to verify the signature against the wallet address
    return signature.length > 0 && message.length > 0;
  }

  /**
   * Create or update user from Privy authentication
   */
  static async createOrUpdateUserFromPrivy(
    privyUser: PrivyUser,
    _privyClaims: PrivyClaims,
  ): Promise<User> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Extract user data from Privy
      const email = privyUser.email?.address;
      const privyWallets = PrivyService.extractWallets(privyUser);
      const primaryWallet = privyWallets[0];
      if (!primaryWallet) {
        throw new Error("No wallet address found in Privy user data");
      }

      const walletAddresses = privyWallets.map((w) => w.address);
      const primaryWalletAddress = primaryWallet.address;

      // Check if user exists with any of the wallet addresses
      let userId: string;
      const walletConditions: string[] = [];
      const walletValues: string[] = [];
      for (const wallet of walletAddresses) {
        const index = walletValues.length + 1;
        walletValues.push(wallet);
        walletConditions.push(
          ETH_ADDRESS_RE.test(wallet)
            ? `lower(wallet_address) = lower($${index})`
            : `wallet_address = $${index}`,
        );
      }

      const walletResult = await client.query<{ user_id: string }>(
        `SELECT user_id FROM user_wallets WHERE ${walletConditions.join(" OR ")} LIMIT 1`,
        walletValues,
      );

      if (walletResult.rows.length > 0) {
        userId = walletResult.rows[0].user_id;

        // Update user data
        await client.query(
          `UPDATE users SET 
           email = $1, 
           last_login_at = now(),
           updated_at = now()
           WHERE id = $2`,
          [email || null, userId],
        );

        // Add any new wallet addresses
        for (const wallet of privyWallets) {
          const match = ETH_ADDRESS_RE.test(wallet.address)
            ? "lower(wallet_address) = lower($2)"
            : "wallet_address = $2";

          const existingWallet = await client.query<{
            id: string;
            wallet_type: string;
            is_verified: boolean;
          }>(
            `SELECT id, wallet_type, is_verified FROM user_wallets WHERE user_id = $1 AND ${match} LIMIT 1`,
            [userId, wallet.address],
          );

          if (existingWallet.rows.length === 0) {
            await client.query(
              `INSERT INTO user_wallets (user_id, wallet_address, wallet_type, is_primary, is_verified) 
               VALUES ($1, $2, $3, false, true)`,
              [userId, wallet.address, wallet.walletType],
            );
            continue;
          }

          const existing = existingWallet.rows[0];
          if (existing.wallet_type !== wallet.walletType || !existing.is_verified) {
            await client.query(
              `UPDATE user_wallets
               SET wallet_type = $3, is_verified = true, updated_at = now()
               WHERE user_id = $1 AND ${match}`,
              [userId, wallet.address, wallet.walletType],
            );
          }
        }

        await client.query(
          "UPDATE user_wallets SET is_primary = false WHERE user_id = $1",
          [userId],
        );

        const primaryMatch = ETH_ADDRESS_RE.test(primaryWalletAddress)
          ? "lower(wallet_address) = lower($2)"
          : "wallet_address = $2";
        await client.query(
          `UPDATE user_wallets SET is_primary = true WHERE user_id = $1 AND ${primaryMatch}`,
          [userId, primaryWalletAddress],
        );
      } else {
        // Create new user
        const userResult = await client.query<UserRow>(
          `INSERT INTO users (email, last_login_at) 
           VALUES ($1, now()) 
           RETURNING id, email, username, display_name, avatar_url, is_active, is_verified, created_at, updated_at, last_login_at`,
          [email || null],
        );

        userId = userResult.rows[0].id;

        // Create wallet records
        for (const wallet of privyWallets) {
          await client.query(
            `INSERT INTO user_wallets (user_id, wallet_address, wallet_type, is_primary, is_verified) 
             VALUES ($1, $2, $3, $4, true)`,
            [
              userId,
              wallet.address,
              wallet.walletType,
              wallet.address === primaryWalletAddress,
            ],
          );
        }

        // Create trading preferences
        await client.query(
          `INSERT INTO user_trading_preferences (user_id) VALUES ($1)`,
          [userId],
        );

        // Create trading stats
        await client.query(
          `INSERT INTO user_trading_stats (user_id) VALUES ($1)`,
          [userId],
        );
      }

      // Get the user data
      const userResult = await client.query<UserRow>(
        "SELECT id, email, username, display_name, avatar_url, is_active, is_verified, created_at, updated_at, last_login_at FROM users WHERE id = $1",
        [userId],
      );

      await client.query("COMMIT");

      return mapUserRow(userResult.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Create or update user from wallet address (legacy method - kept for backward compatibility)
   */
  static async createOrUpdateUser(
    walletAddress: string,
    userData?: {
      email?: string;
      username?: string;
      displayName?: string;
      avatarUrl?: string;
    },
  ): Promise<User> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Check if user exists with this wallet
      const walletResult = await client.query(
        "SELECT user_id FROM user_wallets WHERE wallet_address = $1",
        [walletAddress],
      );

      let userId: string;

      if (walletResult.rows.length > 0) {
        userId = walletResult.rows[0].user_id;

        // Update user data if provided
        if (userData) {
          const updateFields = [];
          const updateValues = [];
          let paramIndex = 1;

          if (userData.email) {
            updateFields.push(`email = $${paramIndex++}`);
            updateValues.push(userData.email);
          }
          if (userData.username) {
            updateFields.push(`username = $${paramIndex++}`);
            updateValues.push(userData.username);
          }
          if (userData.displayName) {
            updateFields.push(`display_name = $${paramIndex++}`);
            updateValues.push(userData.displayName);
          }
          if (userData.avatarUrl) {
            updateFields.push(`avatar_url = $${paramIndex++}`);
            updateValues.push(userData.avatarUrl);
          }

          if (updateFields.length > 0) {
            updateFields.push(`last_login_at = now()`);
            updateValues.push(userId);

            await client.query(
              `UPDATE users SET ${updateFields.join(", ")} WHERE id = $${paramIndex}`,
              updateValues,
            );
          }
        }
      } else {
        // Create new user
        const userResult = await client.query(
          `INSERT INTO users (email, username, display_name, avatar_url, last_login_at) 
           VALUES ($1, $2, $3, $4, now()) 
           RETURNING id, email, username, display_name, avatar_url, is_active, is_verified, created_at, updated_at, last_login_at`,
          [
            userData?.email || null,
            userData?.username || null,
            userData?.displayName || null,
            userData?.avatarUrl || null,
          ],
        );

        userId = userResult.rows[0].id;

        // Create wallet record
        await client.query(
          `INSERT INTO user_wallets (user_id, wallet_address, wallet_type, is_primary, is_verified) 
           VALUES ($1, $2, 'ethereum', true, false)`,
          [userId, walletAddress],
        );

        // Create trading preferences
        await client.query(
          `INSERT INTO user_trading_preferences (user_id) VALUES ($1)`,
          [userId],
        );

        // Create trading stats
        await client.query(
          `INSERT INTO user_trading_stats (user_id) VALUES ($1)`,
          [userId],
        );
      }

      // Get the user data
      const userResult = await client.query<UserRow>(
        "SELECT id, email, username, display_name, avatar_url, is_active, is_verified, created_at, updated_at, last_login_at FROM users WHERE id = $1",
        [userId],
      );

      await client.query("COMMIT");

      return mapUserRow(userResult.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get user by ID
   */
  static async getUserById(userId: string): Promise<User | null> {
    const result = await pool.query<UserRow>(
      "SELECT id, email, username, display_name, avatar_url, is_active, is_verified, created_at, updated_at, last_login_at FROM users WHERE id = $1",
      [userId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    return mapUserRow(result.rows[0]);
  }

  /**
   * Get user wallets
   */
  static async getUserWallets(userId: string): Promise<UserWallet[]> {
    const result = await pool.query<UserWalletRow>(
      "SELECT id, user_id, wallet_address, wallet_type, is_primary, is_verified, created_at, updated_at FROM user_wallets WHERE user_id = $1 ORDER BY is_primary DESC, created_at ASC",
      [userId],
    );

    // Map snake_case to camelCase
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      walletAddress: row.wallet_address,
      walletType: row.wallet_type,
      isPrimary: row.is_primary,
      isVerified: row.is_verified,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  static async getUserWalletByAddress(
    userId: string,
    walletAddress: string,
  ): Promise<UserWallet | null> {
    const normalized = walletAddress.trim();
    const isEth = /^0x[a-fA-F0-9]{40}$/.test(normalized);

    const result = await pool.query<UserWalletRow>(
      `SELECT id, user_id, wallet_address, wallet_type, is_primary, is_verified, created_at, updated_at
       FROM user_wallets
       WHERE user_id = $1 AND ${
         isEth ? "lower(wallet_address) = lower($2)" : "wallet_address = $2"
       }
       LIMIT 1`,
      [userId, normalized],
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      id: row.id,
      userId: row.user_id,
      walletAddress: row.wallet_address,
      walletType: row.wallet_type,
      isPrimary: row.is_primary,
      isVerified: row.is_verified,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  static async addWallet(
    userId: string,
    input: {
      walletAddress: string;
      walletType: string;
      verificationSignature?: string;
    },
  ): Promise<UserWallet> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const existingWallet = await client.query<{ id: string }>(
        "SELECT id FROM user_wallets WHERE wallet_address = $1",
        [input.walletAddress],
      );

      if (existingWallet.rows.length > 0) {
        throw new WalletAlreadyExistsError();
      }

      const result = await client.query<UserWalletRow>(
        `INSERT INTO user_wallets (user_id, wallet_address, wallet_type, is_primary, is_verified, verification_signature)
         VALUES ($1, $2, $3, false, $4, $5)
         RETURNING id, user_id, wallet_address, wallet_type, is_primary, is_verified, created_at, updated_at`,
        [
          userId,
          input.walletAddress,
          input.walletType,
          !!input.verificationSignature,
          input.verificationSignature ?? null,
        ],
      );

      await client.query("COMMIT");

      const row = result.rows[0];
      return {
        id: row.id,
        userId: row.user_id,
        walletAddress: row.wallet_address,
        walletType: row.wallet_type,
        isPrimary: row.is_primary,
        isVerified: row.is_verified,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Create or update venue credentials (Polymarket, Kalshi, Limitless, etc.)
   */
  static async createOrUpdateVenueCredentials(
    userId: string,
    walletAddress: string,
    venue: "polymarket" | "kalshi" | "limitless",
    apiKey: string,
    apiSecret: string,
    additionalData?: unknown,
  ): Promise<VenueCredentials> {
    const result = await pool.query(
      `INSERT INTO user_venue_credentials (user_id, wallet_address, venue, api_key, api_secret, additional_data) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       ON CONFLICT (user_id, wallet_address, venue) 
       DO UPDATE SET api_key = $4, api_secret = $5, additional_data = $6, updated_at = now(), last_used_at = now()
       RETURNING id, user_id, wallet_address, venue, api_key, api_secret, additional_data, is_active, created_at, updated_at, last_used_at`,
      [
        userId,
        walletAddress,
        venue,
        apiKey,
        apiSecret,
        additionalData ? JSON.stringify(additionalData) : null,
      ],
    );

    const row = result.rows[0];

    // Map snake_case to camelCase
    return {
      id: row.id,
      userId: row.user_id,
      walletAddress: row.wallet_address,
      venue: row.venue,
      apiKey: row.api_key,
      apiSecret: row.api_secret,
      additionalData: row.additional_data,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at ?? undefined,
    };
  }

  /**
   * Get venue credentials for user
   */
  static async getVenueCredentials(
    userId: string,
    venue: "polymarket" | "kalshi" | "limitless",
    walletAddress: string,
  ): Promise<VenueCredentials | null> {
    const result = await pool.query<VenueCredentialsRow>(
      `SELECT id, user_id, wallet_address, venue, api_key, api_secret, additional_data, is_active, created_at, updated_at, last_used_at
       FROM user_venue_credentials
       WHERE user_id = $1
         AND venue = $2
         AND wallet_address = $3
         AND is_active = true
       LIMIT 1`,
      [userId, venue, walletAddress],
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];

    // Map snake_case to camelCase
    return {
      id: row.id,
      userId: row.user_id,
      walletAddress: row.wallet_address,
      venue: row.venue,
      apiKey: row.api_key,
      apiSecret: row.api_secret,
      additionalData: row.additional_data,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at ?? undefined,
    };
  }

  /**
   * Get all venue credentials for user
   */
  static async getAllVenueCredentials(
    userId: string,
    walletAddress: string,
  ): Promise<VenueCredentials[]> {
    const result = await pool.query<VenueCredentialsRow>(
      `SELECT id, user_id, wallet_address, venue, api_key, api_secret, additional_data, is_active, created_at, updated_at, last_used_at
       FROM user_venue_credentials
       WHERE user_id = $1
         AND wallet_address = $2
         AND is_active = true
       ORDER BY venue, last_used_at DESC NULLS LAST`,
      [userId, walletAddress],
    );

    // Map snake_case to camelCase
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      walletAddress: row.wallet_address,
      venue: row.venue,
      apiKey: row.api_key,
      apiSecret: row.api_secret,
      additionalData: row.additional_data,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at ?? undefined,
    }));
  }

  // Backward compatibility methods
  static async createOrUpdatePolymarketCredentials(
    userId: string,
    walletAddress: string,
    apiKey: string,
    apiSecret: string,
  ): Promise<PolymarketCredentials> {
    return this.createOrUpdateVenueCredentials(
      userId,
      walletAddress,
      "polymarket",
      apiKey,
      apiSecret,
    );
  }

  static async getPolymarketCredentials(
    userId: string,
    walletAddress: string,
  ): Promise<PolymarketCredentials | null> {
    return this.getVenueCredentials(userId, "polymarket", walletAddress);
  }

  /**
   * Create user session
   */
  static async createSession(
    userId: string,
    walletAddress: string,
    sessionToken: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthSession> {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    const result = await pool.query(
      `INSERT INTO user_sessions (user_id, session_token, wallet_address, ip_address, user_agent, expires_at) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING id, user_id, session_token, wallet_address, ip_address, user_agent, is_active, expires_at, created_at, last_accessed_at`,
      [userId, sessionToken, walletAddress, ipAddress, userAgent, expiresAt],
    );

    const row = result.rows[0];

    // Map snake_case to camelCase
    return {
      id: row.id,
      userId: row.user_id,
      sessionToken: row.session_token,
      walletAddress: row.wallet_address,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      isActive: row.is_active,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at,
    };
  }

  /**
   * Validate session
   */
  static async validateSession(
    sessionToken: string,
  ): Promise<AuthSession | null> {
    const result = await pool.query(
      `SELECT id, user_id, session_token, wallet_address, ip_address, user_agent, is_active, expires_at, created_at, last_accessed_at 
       FROM user_sessions 
       WHERE session_token = $1 AND is_active = true AND expires_at > now()`,
      [sessionToken],
    );

    if (result.rows.length === 0) {
      return null;
    }

    // Update last accessed time
    await pool.query(
      "UPDATE user_sessions SET last_accessed_at = now() WHERE session_token = $1",
      [sessionToken],
    );

    const row = result.rows[0];

    // Map snake_case to camelCase
    return {
      id: row.id,
      userId: row.user_id,
      sessionToken: row.session_token,
      walletAddress: row.wallet_address,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      isActive: row.is_active,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at,
    };
  }

  /**
   * Invalidate session
   */
  static async invalidateSession(sessionToken: string): Promise<void> {
    await pool.query(
      "UPDATE user_sessions SET is_active = false WHERE session_token = $1",
      [sessionToken],
    );
  }

  /**
   * Record authentication attempt
   */
  static async recordAuthAttempt(
    walletAddress: string,
    attemptType: string,
    success: boolean,
    ipAddress?: string,
    userAgent?: string,
    errorMessage?: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO user_auth_attempts (wallet_address, attempt_type, success, ip_address, user_agent, error_message) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [walletAddress, attemptType, success, ipAddress, userAgent, errorMessage],
    );
  }
}

// Authentication middleware for Fastify
type AuthMiddlewareOptions = {
  requireWallet?: boolean;
};

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function normalizeWalletAddress(input: string): string {
  const trimmed = input.trim();
  if (ETH_ADDRESS_RE.test(trimmed)) return trimmed.toLowerCase();
  return trimmed;
}

function readHeaderValue(
  headers: FastifyRequest["headers"],
  name: string,
): string | undefined {
  const key = name.toLowerCase();
  const raw = headers[key];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return undefined;
}

export function createAuthMiddleware(options: AuthMiddlewareOptions = {}) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      reply.code(401);
      return reply.send({ error: "Missing or invalid authorization header" });
    }

    const token = authHeader.substring(7);
    const decoded = AuthService.verifyToken(token);

    if (!decoded) {
      reply.code(401);
      return reply.send({ error: "Invalid or expired token" });
    }

    // Validate session
    const session = await AuthService.validateSession(token);
    if (!session) {
      reply.code(401);
      return reply.send({ error: "Invalid or expired session" });
    }

    // Get user data
    const user = await AuthService.getUserById(decoded.userId);
    if (!user || !user.isActive) {
      reply.code(401);
      return reply.send({ error: "User not found or inactive" });
    }

    // Default to the wallet captured on session creation (typically the Privy primary wallet).
    // Clients can override this per-request via `X-HUNCH-WALLET`.
    request.walletAddress = session.walletAddress;

    const requestedWallet = readHeaderValue(request.headers, "x-hunch-wallet");
    if (requestedWallet && requestedWallet.trim().length > 0) {
      const normalized = normalizeWalletAddress(requestedWallet);
      const wallet = await AuthService.getUserWalletByAddress(
        decoded.userId,
        normalized,
      );
      if (!wallet) {
        reply.code(403);
        return reply.send({
          error: "Wallet is not linked to the authenticated user",
        });
      }
      request.walletAddress = wallet.walletAddress;
    } else if (options.requireWallet) {
      reply.code(400);
      return reply.send({
        error: "Missing X-HUNCH-WALLET header",
      });
    }

    // Attach user data to request
    request.user = user;
    request.session = session;

    return;
  };
}
