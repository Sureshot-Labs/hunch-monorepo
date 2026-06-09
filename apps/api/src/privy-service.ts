import {
  PrivyClient,
  type AuthTokenClaims,
  type User,
} from "@privy-io/server-auth";
import bs58 from "bs58";
import { env } from "./env.js";

// Initialize Privy client
const privyClient = new PrivyClient(env.privyAppId, env.privyAppSecret);

export type PrivyUser = User;
export type PrivyClaims = AuthTokenClaims;
export type PrivyTokenKind = "access" | "identity";

export type PrivyWalletType = "ethereum" | "solana";
export type PrivyWallet = {
  address: string;
  walletType: PrivyWalletType;
};
export type PrivyWalletSource = "embedded" | "smart" | "external" | "unknown";
export type PrivyWalletProfile = PrivyWallet & {
  source: PrivyWalletSource;
  isInternalWallet: boolean;
  walletId?: string | null;
};
export type PrivyWebhookHeaders = {
  id: string;
  timestamp: string;
  signature: string;
};

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const PRIVY_USER_SYNC_MAX_ATTEMPTS = 6;
const PRIVY_USER_SYNC_RETRY_DELAY_MS = 250;

type UnknownRecord = Record<string, unknown>;

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

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  record: UnknownRecord,
  camelKey: string,
  snakeKey?: string,
): string | null {
  const value = record[camelKey] ?? (snakeKey ? record[snakeKey] : undefined);
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readBoolean(
  record: UnknownRecord,
  camelKey: string,
  snakeKey?: string,
): boolean | null {
  const value = record[camelKey] ?? (snakeKey ? record[snakeKey] : undefined);
  return typeof value === "boolean" ? value : null;
}

function readArray(
  record: UnknownRecord,
  camelKey: string,
  snakeKey?: string,
): unknown[] {
  const value = record[camelKey] ?? (snakeKey ? record[snakeKey] : undefined);
  return Array.isArray(value) ? value : [];
}

function readWalletType(record: UnknownRecord): PrivyWalletType | null {
  const chainType = readString(record, "chainType", "chain_type");
  return chainType === "ethereum" || chainType === "solana"
    ? chainType
    : null;
}

function readLinkedAccounts(privyUser: PrivyUser): unknown[] {
  const record = privyUser as unknown as UnknownRecord;
  return readArray(record, "linkedAccounts", "linked_accounts");
}

function readPrimaryWallet(privyUser: PrivyUser): UnknownRecord | null {
  const wallet = (privyUser as unknown as UnknownRecord).wallet;
  return isRecord(wallet) ? wallet : null;
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

function addWalletProfile(
  out: PrivyWalletProfile[],
  seen: Set<string>,
  input: {
    address: string;
    walletType: PrivyWalletType;
    source: PrivyWalletSource;
    walletId?: string | null;
    prepend?: boolean;
  },
) {
  const normalized = normalizeWalletAddress(input.walletType, input.address);
  const key = `${input.walletType}:${normalized}`;
  if (seen.has(key)) return;
  seen.add(key);
  const wallet: PrivyWalletProfile = {
    address: normalized,
    walletType: input.walletType,
    source: input.source,
    isInternalWallet: input.source === "embedded" || input.source === "smart",
    walletId: input.walletId ?? undefined,
  };
  if (input.prepend) {
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
  static createClient(options?: { walletAuthorizationKey?: string }) {
    return new PrivyClient(env.privyAppId, env.privyAppSecret, {
      ...(options?.walletAuthorizationKey
        ? {
            walletApi: {
              authorizationPrivateKey: options.walletAuthorizationKey,
            },
          }
        : {}),
    });
  }

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

  static async verifyWebhook(
    payload: object,
    headers: PrivyWebhookHeaders,
    signingKey: string,
  ): Promise<unknown> {
    try {
      return await privyClient.verifyWebhook(payload, headers, signingKey);
    } catch (error) {
      throw new PrivyAccessTokenError(
        `Invalid Privy webhook signature: ${error instanceof Error ? error.message : "Unknown error"}`,
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

  static async getUserById(privyUserId: string): Promise<PrivyUser> {
    try {
      return await privyClient.getUser(privyUserId);
    } catch (error) {
      throw new PrivyUpstreamError(
        `Failed to fetch Privy user by id: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  static extractWallets(privyUser: PrivyUser): PrivyWallet[] {
    const out: PrivyWallet[] = [];
    const seen = new Set<string>();

    for (const accountRaw of readLinkedAccounts(privyUser)) {
      if (!isRecord(accountRaw)) continue;
      const accountType = readString(accountRaw, "type");
      if (accountType === "wallet") {
        const chainType = readWalletType(accountRaw);
        const address = readString(accountRaw, "address");
        if (!chainType || !address) continue;
        addWallet(out, seen, chainType, address);
        continue;
      }

      if (accountType !== "cross_app") continue;

      for (const wallet of readArray(
        accountRaw,
        "embeddedWallets",
        "embedded_wallets",
      )) {
        if (!isRecord(wallet)) continue;
        const address = readString(wallet, "address");
        if (!address) continue;
        const walletType = inferWalletTypeFromAddress(address);
        if (!walletType) continue;
        addWallet(out, seen, walletType, address);
      }

      for (const wallet of readArray(
        accountRaw,
        "smartWallets",
        "smart_wallets",
      )) {
        if (!isRecord(wallet)) continue;
        const address = readString(wallet, "address");
        if (!address) continue;
        const walletType = inferWalletTypeFromAddress(address);
        if (!walletType) continue;
        addWallet(out, seen, walletType, address);
      }
    }

    // Some Privy accounts expose a `user.wallet` (most recently linked wallet) which may not
    // be present in `linkedAccounts` under some configurations; include it as a fallback.
    const primary = readPrimaryWallet(privyUser);
    if (primary) {
      const chainType = readWalletType(primary);
      const address = readString(primary, "address");
      if (chainType && address)
        addWallet(out, seen, chainType, address, { prepend: true });
    }

    return out;
  }

  /**
   * Extract wallet addresses from Privy user data
   */
  static extractWalletAddresses(privyUser: PrivyUser): string[] {
    return this.extractWallets(privyUser).map((w) => w.address);
  }

  static classifyWallets(privyUser: PrivyUser): PrivyWalletProfile[] {
    const out: PrivyWalletProfile[] = [];
    const seen = new Set<string>();

    for (const accountRaw of readLinkedAccounts(privyUser)) {
      if (!isRecord(accountRaw)) continue;
      const accountType = readString(accountRaw, "type");
      if (accountType === "wallet") {
        const chainType = readWalletType(accountRaw);
        const address = readString(accountRaw, "address");
        if (!chainType || !address) continue;
        const walletClientType = readString(
          accountRaw,
          "walletClientType",
          "wallet_client_type",
        );
        const connectorType = readString(
          accountRaw,
          "connectorType",
          "connector_type",
        );
        const imported = readBoolean(accountRaw, "imported");
        const source: PrivyWalletSource =
          walletClientType === "privy" &&
          connectorType === "embedded" &&
          imported !== true
            ? "embedded"
            : "external";
        addWalletProfile(out, seen, {
          address,
          walletType: chainType,
          source,
          walletId: readString(accountRaw, "id") ?? undefined,
        });
        continue;
      }

      if (accountType !== "cross_app") continue;

      for (const wallet of readArray(
        accountRaw,
        "embeddedWallets",
        "embedded_wallets",
      )) {
        if (!isRecord(wallet)) continue;
        const address = readString(wallet, "address");
        if (!address) continue;
        const walletType = inferWalletTypeFromAddress(address);
        if (!walletType) continue;
        addWalletProfile(out, seen, {
          address,
          walletType,
          source: "embedded",
        });
      }

      for (const wallet of readArray(
        accountRaw,
        "smartWallets",
        "smart_wallets",
      )) {
        if (!isRecord(wallet)) continue;
        const address = readString(wallet, "address");
        if (!address) continue;
        const walletType = inferWalletTypeFromAddress(address);
        if (!walletType) continue;
        addWalletProfile(out, seen, {
          address,
          walletType,
          source: "smart",
        });
      }
    }

    const primary = readPrimaryWallet(privyUser);
    if (primary) {
      const chainType = readWalletType(primary);
      const address = readString(primary, "address");
      if (chainType && address)
        addWalletProfile(out, seen, {
          address,
          walletType: chainType,
          source: "unknown",
          prepend: true,
        });
    }

    return out;
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
    const expectedRemovedWalletAddresses =
      this.normalizeExpectedWalletAddresses(
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

  static async createUserWalletClient(accessToken: string): Promise<{
    claims: PrivyClaims;
    user: PrivyUser;
    walletProfiles: PrivyWalletProfile[];
    walletClient: PrivyClient;
    authorizationKey: string;
    authorizationExpiresAt: number;
  }> {
    const claims = await this.verifyAccessToken(accessToken);
    const user = await this.getUserData(claims);
    const userSigner = await privyClient.walletApi.generateUserSigner({
      userJwt: accessToken,
    });
    const walletClient = this.createClient({
      walletAuthorizationKey: userSigner.authorizationKey,
    });

    return {
      claims,
      user,
      walletProfiles: this.classifyWallets(user),
      walletClient,
      authorizationKey: userSigner.authorizationKey,
      authorizationExpiresAt:
        userSigner.expiresAt instanceof Date
          ? userSigner.expiresAt.getTime()
          : userSigner.expiresAt,
    };
  }

  static async createUserWalletClientWithFallback(tokens: {
    accessToken?: string | null;
    identityToken?: string | null;
  }): Promise<{
    claims: PrivyClaims | null;
    user: PrivyUser;
    walletProfiles: PrivyWalletProfile[];
    walletClient: PrivyClient;
    authorizationKey: string;
    authorizationExpiresAt: number;
    authUserId: string;
    tokenKind: PrivyTokenKind;
  }> {
    const candidates: Array<{
      token: string;
      kind: PrivyTokenKind;
    }> = [];
    const seen = new Set<string>();

    const pushCandidate = (
      kind: PrivyTokenKind,
      token: string | null | undefined,
    ) => {
      const trimmed = token?.trim() ?? "";
      if (!trimmed || seen.has(trimmed)) return;
      seen.add(trimmed);
      candidates.push({ token: trimmed, kind });
    };

    pushCandidate("access", tokens.accessToken);
    pushCandidate("identity", tokens.identityToken);

    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        if (candidate.kind === "access") {
          const result = await this.createUserWalletClient(candidate.token);
          return {
            ...result,
            claims: result.claims,
            authUserId: result.claims.userId,
            tokenKind: "access",
          };
        }

        const user = await privyClient.getUser({ idToken: candidate.token });
        const userSigner = await privyClient.walletApi.generateUserSigner({
          userJwt: candidate.token,
        });
        const walletClient = this.createClient({
          walletAuthorizationKey: userSigner.authorizationKey,
        });

        return {
          claims: null,
          user,
          walletProfiles: this.classifyWallets(user),
          walletClient,
          authorizationKey: userSigner.authorizationKey,
          authorizationExpiresAt:
            userSigner.expiresAt instanceof Date
              ? userSigner.expiresAt.getTime()
              : userSigner.expiresAt,
          authUserId: user.id,
          tokenKind: "identity",
        };
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) {
      throw lastError;
    }
    throw new Error("Missing Privy user authorization token.");
  }
}
