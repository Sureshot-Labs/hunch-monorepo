import { PrivyClient } from "@privy-io/server-auth";
import { env } from "./env.js";

// Initialize Privy client
const privyClient = new PrivyClient(env.privyAppId, env.privyAppSecret);

export interface PrivyUser {
  id: string;
  email?: {
    address: string;
    verified: boolean;
  };
  wallet?: {
    address: string;
    walletType: string;
    verifiedAt?: string;
  };
  wallets?: Array<{
    address: string;
    walletType: string;
    verifiedAt?: string;
  }>;
  createdAt: Date;
  lastActiveAt?: Date;
}

export interface PrivyClaims {
  appId: string;
  userId: string;
  issuer: string;
  issuedAt: number;
  expiration: number;
  sessionId: string;
}

export class PrivyService {
  /**
   * Verify a Privy access token and return the user claims
   */
  static async verifyAccessToken(accessToken: string): Promise<PrivyClaims> {
    try {
      const verifiedClaims = await privyClient.verifyAuthToken(accessToken);
      return verifiedClaims as PrivyClaims;
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
      const user = await privyClient.getUser(privyClaims.userId);
      return user as unknown as PrivyUser;
    } catch (error) {
      throw new Error(
        `Failed to fetch user data from Privy: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Extract wallet addresses from Privy user data
   */
  static extractWalletAddresses(privyUser: PrivyUser): string[] {
    const addresses: string[] = [];

    // Add primary wallet if exists
    if (privyUser.wallet?.address) {
      addresses.push(privyUser.wallet.address);
    }

    // Add additional wallets if they exist
    if (privyUser.wallets && Array.isArray(privyUser.wallets)) {
      for (const wallet of privyUser.wallets) {
        if (wallet.address && !addresses.includes(wallet.address)) {
          addresses.push(wallet.address);
        }
      }
    }

    return addresses;
  }

  /**
   * Get the primary wallet address from Privy user data
   */
  static getPrimaryWalletAddress(privyUser: PrivyUser): string | null {
    // Return primary wallet if exists
    if (privyUser.wallet?.address) {
      return privyUser.wallet.address;
    }

    // Return first wallet if no primary wallet
    if (privyUser.wallets && privyUser.wallets.length > 0) {
      return privyUser.wallets[0].address;
    }

    return null;
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
