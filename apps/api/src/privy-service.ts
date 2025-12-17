import {
  PrivyClient,
  type AuthTokenClaims,
  type LinkedAccountWithMetadata,
  type User,
  type WalletWithMetadata,
} from "@privy-io/server-auth";
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

function normalizeWalletAddress(walletType: PrivyWalletType, address: string) {
  const trimmed = address.trim();
  if (walletType === "ethereum" && ETH_ADDRESS_RE.test(trimmed))
    return trimmed.toLowerCase();
  return trimmed;
}

function isWalletAccount(
  account: LinkedAccountWithMetadata,
): account is WalletWithMetadata {
  return account.type === "wallet";
}

export class PrivyService {
  /**
   * Verify a Privy access token and return the user claims
   */
  static async verifyAccessToken(accessToken: string): Promise<PrivyClaims> {
    try {
      return await privyClient.verifyAuthToken(accessToken);
    } catch (error) {
      throw new Error(
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
      throw new Error(
        `Failed to fetch user data from Privy: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  static extractWallets(privyUser: PrivyUser): PrivyWallet[] {
    const out: PrivyWallet[] = [];
    const seen = new Set<string>();

    for (const account of privyUser.linkedAccounts) {
      if (!isWalletAccount(account)) continue;
      const chainType = account.chainType;
      if (chainType !== "ethereum" && chainType !== "solana") continue;

      const normalized = normalizeWalletAddress(chainType, account.address);
      const key = `${chainType}:${normalized}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ address: normalized, walletType: chainType });
    }

    // Some Privy accounts expose a `user.wallet` (most recently linked wallet) which may not
    // be present in `linkedAccounts` under some configurations; include it as a fallback.
    const primary = privyUser.wallet;
    if (primary?.address && primary.chainType) {
      const chainType = primary.chainType;
      if (chainType === "ethereum" || chainType === "solana") {
        const normalized = normalizeWalletAddress(chainType, primary.address);
        const key = `${chainType}:${normalized}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.unshift({ address: normalized, walletType: chainType });
        }
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

  /**
   * Verify Privy token and get user data in one call
   */
  static async verifyTokenAndGetUser(accessToken: string): Promise<{
    claims: PrivyClaims;
    user: PrivyUser;
    walletAddresses: string[];
    primaryWalletAddress: string | null;
  }> {
    const claims = await this.verifyAccessToken(accessToken);
    const user = await this.getUserData(claims);
    const walletAddresses = this.extractWalletAddresses(user);
    const primaryWalletAddress = this.getPrimaryWalletAddress(user);

    return {
      claims,
      user,
      walletAddresses,
      primaryWalletAddress,
    };
  }
}
