import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import type { FastifyReply, FastifyRequest } from "fastify";
import { pool } from "./db.js";
import "./env.js";
import { PrivyService, PrivyUser, PrivyClaims } from "./privy-service.js";
import {
  decryptCredentialsString,
  encryptCredentialsString,
  getCredentialsEncryptionKey,
} from "./lib/credentials-encryption.js";
import { checkRateLimit } from "./lib/rate-limit.js";

// JWT secret - in production, this should be in environment variables
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable is required");
}
const JWT_EXPIRES_IN: SignOptions["expiresIn"] =
  (process.env.JWT_EXPIRES_IN as SignOptions["expiresIn"]) ?? "24h";

export interface User {
  id: string;
  privyUserId?: string;
  email?: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  isAdmin: boolean;
  kalshiProofBypass: boolean;
  isActive: boolean;
  isVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt?: Date;
}

type UserRow = {
  id: string;
  privy_user_id: string | null;
  email: string | null;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  is_admin: boolean | null;
  kalshi_proof_bypass: boolean | null;
  is_active: boolean;
  is_verified: boolean;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
};

function mapUserRow(row: UserRow): User {
  return {
    id: row.id,
    privyUserId: row.privy_user_id ?? undefined,
    email: row.email ?? undefined,
    username: row.username ?? undefined,
    displayName: row.display_name ?? undefined,
    avatarUrl: row.avatar_url ?? undefined,
    isAdmin: Boolean(row.is_admin),
    kalshiProofBypass: Boolean(row.kalshi_proof_bypass),
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
  constructor(message = "Wallet address already exists") {
    super(message);
  }
}

export class WalletNotFoundError extends Error {
  constructor(message = "Wallet not found") {
    super(message);
  }
}

export class WalletUnlinkNotAllowedError extends Error {
  constructor(message = "Cannot unlink the only wallet") {
    super(message);
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
  apiPassphrase?: string;
  funderAddress?: string;
  funderUpdatedAt?: Date;
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
  api_secret: string | null;
  api_secret_enc?: string | null;
  api_passphrase_enc?: string | null;
  funder_address?: string | null;
  funder_updated_at?: Date | null;
  additional_data: unknown | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date | null;
};

export interface VenueCredentialsInfo {
  id: string;
  userId: string;
  walletAddress: string;
  venue: "polymarket" | "kalshi" | "limitless";
  additionalData?: unknown;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt?: Date;
  funderAddress?: string;
  funderUpdatedAt?: Date;
}

type VenueCredentialsInfoRow = {
  id: string;
  user_id: string;
  wallet_address: string;
  venue: "polymarket" | "kalshi" | "limitless";
  additional_data: unknown | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date | null;
  funder_address?: string | null;
  funder_updated_at?: Date | null;
};

type VenueCredentialsDbFeatures = {
  hasEncryptedSecret: boolean;
  hasEncryptedPassphrase: boolean;
  hasFunderAddress: boolean;
};

let venueCredentialsDbFeaturesPromise: Promise<VenueCredentialsDbFeatures> | null =
  null;

async function getVenueCredentialsDbFeatures(): Promise<VenueCredentialsDbFeatures> {
  if (venueCredentialsDbFeaturesPromise)
    return venueCredentialsDbFeaturesPromise;

  venueCredentialsDbFeaturesPromise = (async () => {
    const result = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'user_venue_credentials'
         AND column_name = ANY($1::text[])`,
      [
        [
          "api_secret_enc",
          "api_passphrase_enc",
          "funder_address",
          "funder_updated_at",
        ],
      ],
    );

    const columns = new Set(result.rows.map((row) => row.column_name));
    return {
      hasEncryptedSecret: columns.has("api_secret_enc"),
      hasEncryptedPassphrase: columns.has("api_passphrase_enc"),
      hasFunderAddress:
        columns.has("funder_address") && columns.has("funder_updated_at"),
    };
  })();

  return venueCredentialsDbFeaturesPromise;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return false;
  return true;
}

function extractPassphrase(
  venue: VenueCredentials["venue"],
  additionalData: unknown,
): { passphrase?: string; additionalDataSanitized?: unknown } {
  if (venue !== "polymarket") {
    return { additionalDataSanitized: additionalData };
  }

  if (!isPlainRecord(additionalData)) {
    return { additionalDataSanitized: additionalData };
  }

  const passphraseRaw = additionalData.passphrase;
  const passphrase =
    typeof passphraseRaw === "string" && passphraseRaw.trim().length
      ? passphraseRaw.trim()
      : undefined;

  if (!Object.prototype.hasOwnProperty.call(additionalData, "passphrase")) {
    return { passphrase, additionalDataSanitized: additionalData };
  }

  const { passphrase: _removed, ...rest } = additionalData;
  return {
    passphrase,
    additionalDataSanitized: Object.keys(rest).length ? rest : undefined,
  };
}

function extractFunderAddress(
  venue: VenueCredentials["venue"],
  additionalData: unknown,
): { funderAddress?: string; additionalDataSanitized?: unknown } {
  if (venue !== "polymarket") {
    return { additionalDataSanitized: additionalData };
  }

  if (!isPlainRecord(additionalData)) {
    return { additionalDataSanitized: additionalData };
  }

  const raw =
    additionalData.funderAddress ??
    additionalData.funder_address ??
    additionalData.funder;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  const funderAddress = ETH_ADDRESS_RE.test(trimmed)
    ? normalizeWalletAddress(trimmed)
    : undefined;

  if (
    !Object.prototype.hasOwnProperty.call(additionalData, "funderAddress") &&
    !Object.prototype.hasOwnProperty.call(additionalData, "funder_address") &&
    !Object.prototype.hasOwnProperty.call(additionalData, "funder")
  ) {
    return { funderAddress, additionalDataSanitized: additionalData };
  }

  const {
    funderAddress: _f0,
    funder_address: _f1,
    funder: _f2,
    ...rest
  } = additionalData;
  return {
    funderAddress,
    additionalDataSanitized: Object.keys(rest).length ? rest : undefined,
  };
}

function redactAdditionalDataForResponse(value: unknown): unknown | undefined {
  if (!isPlainRecord(value)) return value ?? undefined;

  const redactedKeys = new Set([
    "passphrase",
    "apiSecret",
    "api_secret",
    "secret",
    "privateKey",
    "private_key",
  ]);

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (redactedKeys.has(key)) continue;
    output[key] = entry;
  }

  return Object.keys(output).length ? output : undefined;
}

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
  csrfToken: string;
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

  static buildWalletLinkMessage(params: {
    walletAddress: string;
    nonce: string;
    expiresAt: Date;
  }): string {
    return [
      "Hunch wallet verification",
      `Wallet: ${params.walletAddress}`,
      `Nonce: ${params.nonce}`,
      `Expires: ${params.expiresAt.toISOString()}`,
    ].join("\n");
  }

  static async createWalletLinkNonce(params: {
    userId: string;
    walletAddress: string;
    walletType: string;
    ttlMs?: number;
  }): Promise<{ nonce: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + (params.ttlMs ?? 10 * 60 * 1000));
    const nonce = AuthService.generateNonce();
    const normalized = normalizeWalletAddress(params.walletAddress);

    const { rows } = await pool.query<{
      nonce: string;
      expires_at: Date;
    }>(
      `INSERT INTO user_wallet_link_nonces (user_id, wallet_address, wallet_type, nonce, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, wallet_type, wallet_address)
       DO UPDATE SET nonce = excluded.nonce, expires_at = excluded.expires_at, created_at = now()
       RETURNING nonce, expires_at`,
      [params.userId, normalized, params.walletType, nonce, expiresAt],
    );

    return {
      nonce: rows[0].nonce,
      expiresAt: rows[0].expires_at,
    };
  }

  static async consumeWalletLinkNonce(params: {
    userId: string;
    walletAddress: string;
    walletType: string;
    nonce: string;
  }): Promise<{ expiresAt: Date } | null> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const normalized = normalizeWalletAddress(params.walletAddress);
      const result = await client.query<{
        id: string;
        nonce: string;
        expires_at: Date;
      }>(
        `SELECT id, nonce, expires_at
         FROM user_wallet_link_nonces
         WHERE user_id = $1 AND wallet_type = $2 AND wallet_address = $3
         FOR UPDATE`,
        [params.userId, params.walletType, normalized],
      );

      const row = result.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return null;
      }
      if (row.nonce !== params.nonce || row.expires_at <= new Date()) {
        await client.query("ROLLBACK");
        return null;
      }

      await client.query("DELETE FROM user_wallet_link_nonces WHERE id = $1", [
        row.id,
      ]);
      await client.query("COMMIT");
      return { expiresAt: row.expires_at };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
      const email = privyUser.email?.address?.trim() ?? null;
      const privyUserId = privyUser.id;
      const privyWallets = PrivyService.extractWallets(privyUser);
      const primaryWallet = privyWallets[0];
      if (!primaryWallet) {
        throw new Error("No wallet address found in Privy user data");
      }

      const primaryWalletAddress = primaryWallet.address;

      let userId: string | null = null;

      const userByPrivyId = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE privy_user_id = $1 LIMIT 1",
        [privyUserId],
      );
      userId = userByPrivyId.rows[0]?.id ?? null;

      // Backward-compatibility path:
      // if Privy user id changes (e.g. app migration) recover the account by linked wallet ownership.
      if (!userId) {
        const matchedUserIds = new Set<string>();
        for (const wallet of privyWallets) {
          const match = ETH_ADDRESS_RE.test(wallet.address)
            ? "lower(wallet_address) = lower($2)"
            : "wallet_address = $2";

          const owner = await client.query<{ user_id: string }>(
            `SELECT user_id
             FROM user_wallets
             WHERE wallet_type = $1
               AND ${match}
             LIMIT 2`,
            [wallet.walletType, wallet.address],
          );

          for (const row of owner.rows) matchedUserIds.add(row.user_id);
          if (matchedUserIds.size > 1) break;
        }

        if (matchedUserIds.size > 1) {
          throw new WalletAlreadyExistsError(
            "Privy wallets resolve to multiple users; merge users before login",
          );
        }

        if (matchedUserIds.size === 1) {
          userId = matchedUserIds.values().next().value ?? null;
        }
      }

      // Secondary recovery path:
      // if Privy DID changed and wallet matching is inconclusive, recover by email.
      if (!userId && email) {
        const userByEmail = await client.query<{ id: string }>(
          `SELECT id
             FROM users
            WHERE lower(email) = lower($1)
            LIMIT 2`,
          [email],
        );

        if (userByEmail.rows.length > 1) {
          throw new Error(
            "Multiple users share this email; merge users before login",
          );
        }

        userId = userByEmail.rows[0]?.id ?? null;
      }

      if (userId) {
        if (email) {
          const emailConflict = await client.query<{ id: string }>(
            `SELECT id
               FROM users
              WHERE lower(email) = lower($1)
                AND id <> $2
              LIMIT 1`,
            [email, userId],
          );

          if (emailConflict.rows.length > 0) {
            throw new Error("Email already linked to another account");
          }
        }

        for (const wallet of privyWallets) {
          const match =
            wallet.walletType === "ethereum"
              ? "lower(wallet_address) = lower($2)"
              : "wallet_address = $2";
          const conflict = await client.query<{ user_id: string }>(
            `SELECT user_id
             FROM user_wallets
             WHERE wallet_type = $1
               AND ${match}
               AND user_id <> $3
             LIMIT 1`,
            [wallet.walletType, wallet.address, userId],
          );

          if (conflict.rows.length > 0) {
            throw new WalletAlreadyExistsError(
              "Wallet address already linked to another account",
            );
          }
        }

        // Update user data (and persist Privy DID for stable identity).
        await client.query(
          `UPDATE users SET
           email = $1,
           privy_user_id = $2,
           last_login_at = now(),
           updated_at = now()
           WHERE id = $3`,
          [email, privyUserId, userId],
        );

        // Remove wallets that were unlinked in Privy (and dependent venue creds).
        const existingWallets = await client.query<{
          id: string;
          wallet_address: string;
        }>("SELECT id, wallet_address FROM user_wallets WHERE user_id = $1", [
          userId,
        ]);

        const linkedWalletSet = new Set(
          privyWallets.map((w) => normalizeWalletAddress(w.address)),
        );
        const walletIdsToDelete: string[] = [];
        for (const wallet of existingWallets.rows) {
          const normalized = normalizeWalletAddress(wallet.wallet_address);
          if (!linkedWalletSet.has(normalized))
            walletIdsToDelete.push(wallet.id);
        }

        if (walletIdsToDelete.length > 0) {
          await client.query(
            `DELETE FROM user_venue_credentials
             WHERE user_id = $1
               AND wallet_address IN (
                 SELECT wallet_address FROM user_wallets WHERE id = ANY($2::uuid[])
               )`,
            [userId, walletIdsToDelete],
          );

          await client.query(
            "DELETE FROM user_wallets WHERE user_id = $1 AND id = ANY($2::uuid[])",
            [userId, walletIdsToDelete],
          );
        }

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
          if (
            existing.wallet_type !== wallet.walletType ||
            !existing.is_verified
          ) {
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
          `INSERT INTO users (email, privy_user_id, last_login_at)
           VALUES ($1, $2, now())
           RETURNING id, privy_user_id, email, username, display_name, avatar_url, is_active, is_verified, created_at, updated_at, last_login_at`,
          [email, privyUserId],
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
        "SELECT id, privy_user_id, email, username, display_name, avatar_url, is_admin, kalshi_proof_bypass, is_active, is_verified, created_at, updated_at, last_login_at FROM users WHERE id = $1",
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
      const isEth = ETH_ADDRESS_RE.test(walletAddress);
      const walletMatch = isEth
        ? "lower(wallet_address) = lower($1)"
        : "wallet_address = $1";
      const walletResult = await client.query(
        `SELECT user_id FROM user_wallets WHERE ${walletMatch}`,
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
           RETURNING id, privy_user_id, email, username, display_name, avatar_url, is_active, is_verified, created_at, updated_at, last_login_at`,
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
        "SELECT id, privy_user_id, email, username, display_name, avatar_url, is_admin, kalshi_proof_bypass, is_active, is_verified, created_at, updated_at, last_login_at FROM users WHERE id = $1",
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
      "SELECT id, privy_user_id, email, username, display_name, avatar_url, is_admin, kalshi_proof_bypass, is_active, is_verified, created_at, updated_at, last_login_at FROM users WHERE id = $1",
      [userId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    return mapUserRow(result.rows[0]);
  }

  static async deleteUser(userId: string): Promise<void> {
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
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

      const isEth = ETH_ADDRESS_RE.test(input.walletAddress);
      const match = isEth
        ? "lower(wallet_address) = lower($2)"
        : "wallet_address = $2";
      const existingWallet = await client.query<{ id: string }>(
        `SELECT id FROM user_wallets WHERE wallet_type = $1 AND ${match}`,
        [input.walletType, input.walletAddress],
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

  static async removeWallet(
    userId: string,
    walletAddress: string,
  ): Promise<{
    removed: UserWallet;
    nextPrimaryWalletAddress: string | null;
    remainingWallets: UserWallet[];
  }> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const normalized = walletAddress.trim();
      const isEth = ETH_ADDRESS_RE.test(normalized);
      const match = isEth
        ? "lower(wallet_address) = lower($2)"
        : "wallet_address = $2";

      const targetResult = await client.query<UserWalletRow>(
        `SELECT id, user_id, wallet_address, wallet_type, is_primary, is_verified, created_at, updated_at
         FROM user_wallets
         WHERE user_id = $1 AND ${match}
         LIMIT 1`,
        [userId, normalized],
      );
      const target = targetResult.rows[0];
      if (!target) {
        throw new WalletNotFoundError();
      }

      const walletsResult = await client.query<UserWalletRow>(
        `SELECT id, user_id, wallet_address, wallet_type, is_primary, is_verified, created_at, updated_at
         FROM user_wallets
         WHERE user_id = $1
         ORDER BY is_primary DESC, created_at ASC`,
        [userId],
      );

      if (walletsResult.rows.length <= 1) {
        throw new WalletUnlinkNotAllowedError();
      }

      const remainingRows = walletsResult.rows.filter(
        (row) => row.id !== target.id,
      );
      let nextPrimary = remainingRows.find((row) => row.is_primary);
      if (!nextPrimary) {
        nextPrimary = remainingRows[0];
      }

      const hasPrimary = remainingRows.some((row) => row.is_primary);
      if (target.is_primary || !hasPrimary) {
        await client.query(
          "UPDATE user_wallets SET is_primary = false WHERE user_id = $1",
          [userId],
        );
        await client.query(
          "UPDATE user_wallets SET is_primary = true WHERE id = $1",
          [nextPrimary.id],
        );
      }

      await client.query(
        `DELETE FROM user_venue_credentials
         WHERE user_id = $1 AND wallet_address = $2`,
        [userId, target.wallet_address],
      );
      await client.query(
        "DELETE FROM user_wallets WHERE user_id = $1 AND id = $2",
        [userId, target.id],
      );
      await client.query(
        `UPDATE user_sessions
         SET wallet_address = $3
         WHERE user_id = $1 AND wallet_address = $2`,
        [userId, target.wallet_address, nextPrimary.wallet_address],
      );

      await client.query("COMMIT");

      const removed: UserWallet = {
        id: target.id,
        userId: target.user_id,
        walletAddress: target.wallet_address,
        walletType: target.wallet_type,
        isPrimary: target.is_primary,
        isVerified: target.is_verified,
        createdAt: target.created_at,
        updatedAt: target.updated_at,
      };

      const remainingWallets: UserWallet[] = remainingRows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        walletAddress: row.wallet_address,
        walletType: row.wallet_type,
        isPrimary: row.id === nextPrimary.id,
        isVerified: row.is_verified,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));

      return {
        removed,
        nextPrimaryWalletAddress: nextPrimary.wallet_address,
        remainingWallets,
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
    const { passphrase, additionalDataSanitized } = extractPassphrase(
      venue,
      additionalData,
    );
    const {
      funderAddress,
      additionalDataSanitized: additionalDataWithoutFunder,
    } = extractFunderAddress(venue, additionalDataSanitized);
    const additionalDataSafe = redactAdditionalDataForResponse(
      additionalDataWithoutFunder,
    );

    const dbFeatures = await getVenueCredentialsDbFeatures();
    if (
      !dbFeatures.hasEncryptedSecret ||
      !dbFeatures.hasEncryptedPassphrase ||
      !dbFeatures.hasFunderAddress
    ) {
      throw new Error(
        "Encrypted credential storage is not available: apply DB migration 0027_encrypt_venue_credentials_and_add_funder.sql",
      );
    }

    const encryptionKey = getCredentialsEncryptionKey();
    const secretEnc = encryptCredentialsString(apiSecret, encryptionKey);
    const passphraseEnc =
      dbFeatures.hasEncryptedPassphrase && passphrase
        ? encryptCredentialsString(passphrase, encryptionKey)
        : null;
    const funderAddressValue = funderAddress ?? null;

    const normalizedWallet = walletAddress.trim();
    const isEthWallet = ETH_ADDRESS_RE.test(normalizedWallet);
    let walletAddressKey = normalizedWallet;

    if (isEthWallet) {
      const existing = await pool.query<{ wallet_address: string }>(
        `
          select wallet_address
          from user_venue_credentials
          where user_id = $1
            and venue = $2
            and lower(wallet_address) = lower($3)
          order by
            last_used_at desc nulls last,
            updated_at desc,
            created_at desc
          limit 1
        `,
        [userId, venue, normalizedWallet],
      );
      walletAddressKey = existing.rows[0]?.wallet_address ?? normalizedWallet;
    }

    const result = await pool.query(
      `INSERT INTO user_venue_credentials (
          user_id,
          wallet_address,
          venue,
          api_key,
          api_secret,
          api_secret_enc,
          api_passphrase_enc,
          additional_data,
          funder_address,
          funder_updated_at
        )
       VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8::text, CASE WHEN $8::text IS NULL THEN NULL ELSE now() END)
       ON CONFLICT (user_id, wallet_address, venue)
       DO UPDATE SET
         api_key = $4,
         api_secret = NULL,
         api_secret_enc = $5,
         api_passphrase_enc = $6,
         additional_data = $7,
         funder_address = CASE WHEN $8::text IS NULL THEN user_venue_credentials.funder_address ELSE $8::text END,
         funder_updated_at = CASE WHEN $8::text IS NULL THEN user_venue_credentials.funder_updated_at ELSE now() END,
         updated_at = now(),
         last_used_at = now()
       RETURNING id, user_id, wallet_address, venue, api_key, additional_data, funder_address, funder_updated_at, is_active, created_at, updated_at, last_used_at`,
      [
        userId,
        walletAddressKey,
        venue,
        apiKey,
        secretEnc,
        passphraseEnc,
        additionalDataSafe ? JSON.stringify(additionalDataSafe) : null,
        funderAddressValue,
      ],
    );

    const row = result.rows[0];

    // Keep at most one active credential row for the same EVM wallet (case-insensitive),
    // while still allowing multiple different wallets per user+venue.
    if (isEthWallet && row?.id) {
      await pool.query(
        `
          update user_venue_credentials
          set is_active = false,
              updated_at = now()
          where user_id = $1
            and venue = $2
            and lower(wallet_address) = lower($3)
            and id <> $4
            and is_active = true
        `,
        [userId, venue, walletAddressKey, row.id],
      );
    }

    // Map snake_case to camelCase
    return {
      id: row.id,
      userId: row.user_id,
      walletAddress: row.wallet_address,
      venue: row.venue,
      apiKey: row.api_key,
      apiSecret,
      apiPassphrase: passphrase,
      funderAddress: row.funder_address ?? undefined,
      funderUpdatedAt: row.funder_updated_at ?? undefined,
      additionalData: row.additional_data,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at ?? undefined,
    };
  }

  static async updateVenueFunderAddress(
    userId: string,
    walletAddress: string,
    venue: "polymarket" | "kalshi" | "limitless",
    funderAddress: string | null,
  ): Promise<{ funderAddress: string | null; funderUpdatedAt: Date | null }> {
    const dbFeatures = await getVenueCredentialsDbFeatures();
    if (!dbFeatures.hasFunderAddress) {
      throw new Error(
        "Funder address storage is not available: apply DB migration 0027_encrypt_venue_credentials_and_add_funder.sql",
      );
    }

    const normalizedWallet = walletAddress.trim();
    const isEthWallet = ETH_ADDRESS_RE.test(normalizedWallet);
    const walletClause = isEthWallet
      ? "lower(wallet_address) = lower($2)"
      : "wallet_address = $2";
    const funderAddressValue = funderAddress ? funderAddress.trim() : null;

    const result = await pool.query<{
      funder_address: string | null;
      funder_updated_at: Date | null;
    }>(
      `
        update user_venue_credentials
        set funder_address = $4::text,
            funder_updated_at = case when $4::text is null then null else now() end,
            updated_at = now(),
            last_used_at = now()
        where user_id = $1
          and ${walletClause}
          and venue = $3
          and is_active = true
        returning funder_address, funder_updated_at
      `,
      [userId, normalizedWallet, venue, funderAddressValue],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(
        `No active ${venue} credentials found for this wallet (connect first).`,
      );
    }

    return {
      funderAddress: row.funder_address,
      funderUpdatedAt: row.funder_updated_at,
    };
  }

  static async deactivateVenueCredentials(
    userId: string,
    venue: "polymarket" | "kalshi" | "limitless",
    walletAddress: string,
  ): Promise<number> {
    const normalizedWallet = walletAddress.trim();
    const walletClause = ETH_ADDRESS_RE.test(normalizedWallet)
      ? "lower(wallet_address) = lower($3)"
      : "wallet_address = $3";
    const result = await pool.query(
      `
        update user_venue_credentials
        set is_active = false,
            updated_at = now()
        where user_id = $1
          and venue = $2
          and ${walletClause}
          and is_active = true
      `,
      [userId, venue, normalizedWallet],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Get venue credentials for user
   */
  static async getVenueCredentials(
    userId: string,
    venue: "polymarket" | "kalshi" | "limitless",
    walletAddress: string,
  ): Promise<VenueCredentials | null> {
    const dbFeatures = await getVenueCredentialsDbFeatures();
    const selectedColumns = [
      "id",
      "user_id",
      "wallet_address",
      "venue",
      "api_key",
      "api_secret",
      "additional_data",
      "is_active",
      "created_at",
      "updated_at",
      "last_used_at",
      ...(dbFeatures.hasEncryptedSecret ? ["api_secret_enc"] : []),
      ...(dbFeatures.hasEncryptedPassphrase ? ["api_passphrase_enc"] : []),
      ...(dbFeatures.hasFunderAddress
        ? ["funder_address", "funder_updated_at"]
        : []),
    ].join(", ");

    const normalizedWallet = walletAddress.trim();
    const walletClause = ETH_ADDRESS_RE.test(normalizedWallet)
      ? "lower(wallet_address) = lower($3)"
      : "wallet_address = $3";
    const result = await pool.query<VenueCredentialsRow>(
      `SELECT ${selectedColumns}
       FROM user_venue_credentials
       WHERE user_id = $1
         AND venue = $2
         AND ${walletClause}
         AND is_active = true
       ORDER BY
         last_used_at DESC NULLS LAST,
         updated_at DESC,
         created_at DESC
       LIMIT 1`,
      [userId, venue, normalizedWallet],
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];

    let apiSecret = row.api_secret ?? "";
    let apiPassphrase: string | undefined;
    let funderAddress: string | undefined;
    let funderUpdatedAt: Date | undefined;

    const additionalData = redactAdditionalDataForResponse(row.additional_data);

    if (dbFeatures.hasEncryptedSecret && row.api_secret_enc) {
      const encryptionKey = getCredentialsEncryptionKey();
      apiSecret = decryptCredentialsString(row.api_secret_enc, encryptionKey);
    }

    if (dbFeatures.hasEncryptedPassphrase && row.api_passphrase_enc) {
      const encryptionKey = getCredentialsEncryptionKey();
      apiPassphrase = decryptCredentialsString(
        row.api_passphrase_enc,
        encryptionKey,
      );
    }

    if (
      dbFeatures.hasFunderAddress &&
      row.funder_address &&
      row.funder_updated_at
    ) {
      funderAddress = row.funder_address;
      funderUpdatedAt = row.funder_updated_at;
    }

    // Map snake_case to camelCase
    return {
      id: row.id,
      userId: row.user_id,
      walletAddress: row.wallet_address,
      venue: row.venue,
      apiKey: row.api_key,
      apiSecret,
      apiPassphrase,
      funderAddress,
      funderUpdatedAt,
      additionalData,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at ?? undefined,
    };
  }

  /**
   * Get venue credentials metadata (no secrets)
   */
  static async getVenueCredentialsInfo(
    userId: string,
    venue: "polymarket" | "kalshi" | "limitless",
    walletAddress: string,
  ): Promise<VenueCredentialsInfo | null> {
    const dbFeatures = await getVenueCredentialsDbFeatures();
    const selectedColumns = [
      "id",
      "user_id",
      "wallet_address",
      "venue",
      "additional_data",
      "is_active",
      "created_at",
      "updated_at",
      "last_used_at",
      ...(dbFeatures.hasFunderAddress
        ? ["funder_address", "funder_updated_at"]
        : []),
    ].join(", ");

    const result = await pool.query<VenueCredentialsInfoRow>(
      `SELECT ${selectedColumns}
       FROM user_venue_credentials
       WHERE user_id = $1
         AND venue = $2
         AND wallet_address = $3
         AND is_active = true
       LIMIT 1`,
      [userId, venue, walletAddress],
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      id: row.id,
      userId: row.user_id,
      walletAddress: row.wallet_address,
      venue: row.venue,
      additionalData: redactAdditionalDataForResponse(row.additional_data),
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at ?? undefined,
      funderAddress: row.funder_address ?? undefined,
      funderUpdatedAt: row.funder_updated_at ?? undefined,
    };
  }

  /**
   * Get all venue credentials metadata for user + wallet (no secrets)
   */
  static async getAllVenueCredentialsInfo(
    userId: string,
    walletAddress: string,
  ): Promise<VenueCredentialsInfo[]> {
    const dbFeatures = await getVenueCredentialsDbFeatures();
    const selectedColumns = [
      "id",
      "user_id",
      "wallet_address",
      "venue",
      "additional_data",
      "is_active",
      "created_at",
      "updated_at",
      "last_used_at",
      ...(dbFeatures.hasFunderAddress
        ? ["funder_address", "funder_updated_at"]
        : []),
    ].join(", ");

    const result = await pool.query<VenueCredentialsInfoRow>(
      `SELECT ${selectedColumns}
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
      additionalData: redactAdditionalDataForResponse(row.additional_data),
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at ?? undefined,
      funderAddress: row.funder_address ?? undefined,
      funderUpdatedAt: row.funder_updated_at ?? undefined,
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
       RETURNING id, user_id, session_token, wallet_address, ip_address, user_agent, is_active, expires_at, created_at, last_accessed_at, csrf_token`,
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
      csrfToken: row.csrf_token,
    };
  }

  /**
   * Validate session
   */
  static async validateSession(
    sessionToken: string,
  ): Promise<AuthSession | null> {
    const result = await pool.query(
      `SELECT id, user_id, session_token, wallet_address, ip_address, user_agent, is_active, expires_at, created_at, last_accessed_at, csrf_token
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
      csrfToken: row.csrf_token,
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

function requiresCsrf(method: string): boolean {
  switch (method.toUpperCase()) {
    case "GET":
    case "HEAD":
    case "OPTIONS":
      return false;
    default:
      return true;
  }
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

    const requestAgent = readHeaderValue(request.headers, "user-agent");
    if (session.userAgent && requestAgent && session.userAgent !== requestAgent) {
      request.log.warn(
        { sessionAgent: session.userAgent, requestAgent },
        "Session user-agent mismatch",
      );
    }

    if (requiresCsrf(request.method)) {
      const csrfHeader = readHeaderValue(request.headers, "x-csrf-token");
      if (!csrfHeader || csrfHeader !== session.csrfToken) {
        reply.code(403);
        return reply.send({ error: "Invalid CSRF token" });
      }
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

export function createAdminMiddleware(options: AuthMiddlewareOptions = {}) {
  const auth = createAuthMiddleware(options);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await auth(request, reply);
    if (reply.sent) return;
    if (!request.user?.isAdmin) {
      reply.code(403);
      return reply.send({ error: "Admin access required" });
    }

    const rateLimitKey = `admin:${request.ip || "unknown"}`;
    const canProceed = await checkRateLimit(rateLimitKey, 120, 60_000);
    if (!canProceed) {
      reply.code(429);
      return reply.send({ error: "Rate limit exceeded" });
    }
  };
}
