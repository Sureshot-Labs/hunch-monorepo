import {
  PrivyClient,
  type AuthTokenClaims,
  type LinkedAccountWithMetadata,
  type User,
  type WalletWithMetadata,
} from "@privy-io/server-auth";
import bs58 from "bs58";
import { env } from "./env.js";

// Initialize Privy client
const privyClient = new PrivyClient(env.privyAppId, env.privyAppSecret);

export type PrivyUser = User;
export type PrivyClaims = AuthTokenClaims;

export type PrivyWalletType = "ethereum" | "solana";
export type PrivyWallet = {
  address: string;
  walletType: PrivyWalletType;
};

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const PRIVY_USER_SYNC_MAX_ATTEMPTS = 6;
const PRIVY_USER_SYNC_RETRY_DELAY_MS = 250;

type CrossAppWalletRef = {
  address?: string | null;
};

type CrossAppAccount = LinkedAccountWithMetadata & {
  type: "cross_app";
  embeddedWallets?: CrossAppWalletRef[] | null;
  smartWallets?: CrossAppWalletRef[] | null;
};

function normalizeWalletAddress(walletType: PrivyWalletType, address: string) {
  const trimmed = address.trim();
  if (walletType === "ethereum" && ETH_ADDRESS_RE.test(trimmed))
    return trimmed.toLowerCase();
  return trimmed;
}

function inferWalletTypeFromAddress(address: string): PrivyWalletType | null {
  const trimmed = address.trim();
  if (!trimmed) return null;
  if (ETH_ADDRESS_RE.test(trimmed)) return "ethereum";
  try {
    const decoded = bs58.decode(trimmed);
    if (decoded.length === 32) return "solana";
  } catch {
    return null;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type VerifyTokenAndGetUserOptions = {
  expectedAddedWalletAddresses?: string[];
  expectedRemovedWalletAddresses?: string[];
  maxSyncAttempts?: number;
  syncRetryDelayMs?: number;
};

function isWalletAccount(
  account: LinkedAccountWithMetadata,
): account is WalletWithMetadata {
  return account.type === "wallet";
}

function isCrossAppAccount(
  account: LinkedAccountWithMetadata,
): account is CrossAppAccount {
  return account.type === "cross_app";
}

function addWallet(
  out: PrivyWallet[],
  seen: Set<string>,
  walletType: PrivyWalletType,
  address: string,
  options?: { prepend?: boolean },
) {
  const normalized = normalizeWalletAddress(walletType, address);
  const key = `${walletType}:${normalized}`;
  if (seen.has(key)) return;
  seen.add(key);
  const wallet = { address: normalized, walletType };
  if (options?.prepend) {
    out.unshift(wallet);
    return;
  }
  out.push(wallet);
}

export class PrivyAccessTokenError extends Error {
  constructor(message = "Invalid Privy access token") {
    super(message);
  }
}

export class PrivyUpstreamError extends Error {
  constructor(message = "Privy service is unavailable") {
    super(message);
  }
}

export class PrivyService {
  /**
   * Verify a Privy access token and return the user claims
   */
  static async verifyAccessToken(accessToken: string): Promise<PrivyClaims> {
    try {
      return await privyClient.verifyAuthToken(accessToken);
    } catch (error) {
      throw new PrivyAccessTokenError(
        `Invalid Privy access token: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Get user data from Privy using the verified claims
   */
  static async getUserData(privyClaims: PrivyClaims): Promise<PrivyUser> {
    try {
      return await privyClient.getUser(privyClaims.userId);
    } catch (error) {
      throw new PrivyUpstreamError(
        `Failed to fetch user data from Privy: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  static extractWallets(privyUser: PrivyUser): PrivyWallet[] {
    const out: PrivyWallet[] = [];
    const seen = new Set<string>();

    for (const account of privyUser.linkedAccounts) {
      if (isWalletAccount(account)) {
        const chainType = account.chainType;
        if (chainType !== "ethereum" && chainType !== "solana") continue;
        addWallet(out, seen, chainType, account.address);
        continue;
      }

      if (!isCrossAppAccount(account)) continue;

      for (const wallet of account.embeddedWallets ?? []) {
        if (typeof wallet.address !== "string") continue;
        const walletType = inferWalletTypeFromAddress(wallet.address);
        if (!walletType) continue;
        addWallet(out, seen, walletType, wallet.address);
      }

      for (const wallet of account.smartWallets ?? []) {
        if (typeof wallet.address !== "string") continue;
        const walletType = inferWalletTypeFromAddress(wallet.address);
        if (!walletType) continue;
        addWallet(out, seen, walletType, wallet.address);
      }
    }

    // Some Privy accounts expose a `user.wallet` (most recently linked wallet) which may not
    // be present in `linkedAccounts` under some configurations; include it as a fallback.
    const primary = privyUser.wallet;
    if (primary?.address && primary.chainType) {
      const chainType = primary.chainType;
      if (chainType === "ethereum" || chainType === "solana") {
        addWallet(out, seen, chainType, primary.address, { prepend: true });
      }
    }

    return out;
  }

  /**
   * Extract wallet addresses from Privy user data
   */
  static extractWalletAddresses(privyUser: PrivyUser): string[] {
    return this.extractWallets(privyUser).map((w) => w.address);
  }

  /**
   * Get the primary wallet address from Privy user data
   */
  static getPrimaryWalletAddress(privyUser: PrivyUser): string | null {
    const wallets = this.extractWallets(privyUser);
    return wallets[0]?.address ?? null;
  }

  private static normalizeExpectedWalletAddresses(
    expectedWalletAddresses?: string[],
  ): string[] {
    const seen = new Set<string>();
    const out: string[] = [];

    for (const rawAddress of expectedWalletAddresses ?? []) {
      const trimmed = rawAddress.trim();
      if (!trimmed) continue;
      const walletType: PrivyWalletType = ETH_ADDRESS_RE.test(trimmed)
        ? "ethereum"
        : "solana";
      const normalized = normalizeWalletAddress(walletType, trimmed);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }

    return out;
  }

  private static hasExpectedWalletDelta(
    walletAddresses: string[],
    options: {
      expectedAddedWalletAddresses: string[];
      expectedRemovedWalletAddresses: string[];
    },
  ): boolean {
    const actual = new Set(walletAddresses);
    for (const address of options.expectedAddedWalletAddresses) {
      if (!actual.has(address)) return false;
    }
    for (const address of options.expectedRemovedWalletAddresses) {
      if (actual.has(address)) return false;
    }
    return true;
  }

  private static shouldRetryWalletSync(
    walletAddresses: string[],
    options: {
      expectedAddedWalletAddresses: string[];
      expectedRemovedWalletAddresses: string[];
    },
  ): boolean {
    if (walletAddresses.length === 0) return true;
    return !this.hasExpectedWalletDelta(walletAddresses, options);
  }

  /**
   * Verify Privy token and get user data in one call
   */
  static async verifyTokenAndGetUser(
    accessToken: string,
    options?: VerifyTokenAndGetUserOptions,
  ): Promise<{
    claims: PrivyClaims;
    user: PrivyUser;
    walletAddresses: string[];
    primaryWalletAddress: string | null;
  }> {
    const claims = await this.verifyAccessToken(accessToken);
    const expectedAddedWalletAddresses = this.normalizeExpectedWalletAddresses(
      options?.expectedAddedWalletAddresses,
    );
    const expectedRemovedWalletAddresses = this.normalizeExpectedWalletAddresses(
      options?.expectedRemovedWalletAddresses,
    );
    const maxSyncAttempts = Math.max(
      1,
      options?.maxSyncAttempts ?? PRIVY_USER_SYNC_MAX_ATTEMPTS,
    );
    const syncRetryDelayMs = Math.max(
      0,
      options?.syncRetryDelayMs ?? PRIVY_USER_SYNC_RETRY_DELAY_MS,
    );

    let user = await this.getUserData(claims);
    let walletAddresses = this.extractWalletAddresses(user);

    for (
      let attempt = 1;
      attempt < maxSyncAttempts &&
      this.shouldRetryWalletSync(walletAddresses, {
        expectedAddedWalletAddresses,
        expectedRemovedWalletAddresses,
      });
      attempt += 1
    ) {
      if (syncRetryDelayMs > 0) {
        await sleep(syncRetryDelayMs);
      }
      user = await this.getUserData(claims);
      walletAddresses = this.extractWalletAddresses(user);
    }

    const primaryWalletAddress = this.getPrimaryWalletAddress(user);

    return {
      claims,
      user,
      walletAddresses,
      primaryWalletAddress,
    };
  }

  static async deleteUser(privyUserId: string): Promise<void> {
    try {
      await privyClient.deleteUser(privyUserId);
    } catch (error) {
      throw new Error(
        `Failed to delete Privy user: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }
}
