import {
  PrivyClient,
  type User,
  type VerifyAccessTokenResponse,
} from "@privy-io/node";
import bs58 from "bs58";
import { env } from "./env.js";

const privyClient = new PrivyClient({
  appId: env.privyAppId,
  appSecret: env.privyAppSecret,
});

export type PrivyUser = User & {
  email?: {
    address?: string | null;
  } | null;
};
export type PrivyClaims = {
  appId: string;
  issuer: string;
  issuedAt: number;
  expiration: number;
  sessionId: string;
  userId: string;
};
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
export type PrivyManagedWalletMetadata = {
  additionalSigners: Array<{
    overridePolicyIds: string[];
    signerId: string;
  }>;
  address: string;
  chainType: PrivyWalletType;
  id: string;
  policyIds: string[];
};
export type PrivyKeyQuorumMetadata = {
  authorizationPublicKeys: string[];
  authorizationThreshold: number | null;
  id: string;
  nestedKeyQuorumIds: string[];
  userIds: string[];
};
export type PrivyPolicyMetadata = {
  chainType: PrivyWalletType;
  id: string;
  rules: Array<Record<string, unknown>>;
};
export type PrivyTelegramAccount = {
  telegramUserId: string;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  photoUrl?: string | null;
};
export type PrivyWebhookHeaders = {
  id: string;
  timestamp: string;
  signature: string;
};
export type PrivyWalletApiRequestSignatureInput = {
  version: 1;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  body: Record<string, unknown>;
  headers: {
    "privy-app-id": string;
    "privy-idempotency-key"?: string;
    "privy-request-expiry"?: string;
  };
};

type PrivyAuthorizationContext = {
  authorization_private_keys?: string[];
  user_jwts?: string[];
  signatures?: string[];
  sign_fns?: Array<(payload: Uint8Array) => Promise<string>>;
};

type PrivyClientOptions = {
  walletAuthorizationKey?: string;
  userJwt?: string;
};

type PrivyTransactionQuantity = string | number;
type PrivyEthereumTransaction = {
  from?: string;
  to?: string;
  data?: string | null;
  value?: PrivyTransactionQuantity | null;
  gas?: PrivyTransactionQuantity | null;
  gas_limit?: PrivyTransactionQuantity | null;
};
type PrivyEthereumNormalizedTransaction = {
  from?: string;
  to?: string;
  data?: string;
  value?: PrivyTransactionQuantity;
  gas_limit?: PrivyTransactionQuantity;
};
type PrivyTypedDataField = { name: string; type: string };
type PrivyEthereumTypedData = {
  domain: Record<string, unknown>;
  types: Record<string, readonly PrivyTypedDataField[]>;
  message: Record<string, unknown>;
  primaryType: string;
};
type PrivyEthereumSendTransactionInput = {
  walletId?: string;
  address?: string;
  chainType?: "ethereum";
  caip2: string;
  sponsor?: boolean;
  referenceId?: string;
  transaction: PrivyEthereumTransaction;
};
type PrivyEthereumSignTypedDataInput = {
  walletId?: string;
  address?: string;
  chainType?: "ethereum";
  typedData: PrivyEthereumTypedData;
};
type PrivyEthereumSignMessageInput = {
  walletId?: string;
  address?: string;
  chainType?: "ethereum";
  message: string | Uint8Array;
};
type PrivySolanaSignAndSendTransactionInput = {
  walletId?: string;
  transaction: string | Uint8Array;
  caip2: string;
};
export type PrivyWalletApiClient = {
  walletApi: {
    ethereum: {
      sendTransaction(input: PrivyEthereumSendTransactionInput): Promise<{
        hash: string;
        referenceId: string | null;
        transactionId: string | null;
        userOperationHash: string | null;
      }>;
      signTypedData(
        input: PrivyEthereumSignTypedDataInput,
      ): Promise<{ signature: string }>;
      signMessage(
        input: PrivyEthereumSignMessageInput,
      ): Promise<{ signature: string }>;
    };
    solana: {
      signAndSendTransaction(
        input: PrivySolanaSignAndSendTransactionInput,
      ): Promise<{ hash: string }>;
    };
  };
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
  expectedRemovedTelegramUserId?: string | null;
  expectedTelegramUserId?: string | null;
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

function readStringOrNumber(
  record: UnknownRecord,
  camelKey: string,
  snakeKey?: string,
): string | null {
  const value = record[camelKey] ?? (snakeKey ? record[snakeKey] : undefined);
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value).toString();
  }
  return null;
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

function mapPrivyClaims(claims: VerifyAccessTokenResponse): PrivyClaims {
  return {
    appId: claims.app_id,
    issuer: claims.issuer,
    issuedAt: claims.issued_at,
    expiration: claims.expiration,
    sessionId: claims.session_id,
    userId: claims.user_id,
  };
}

function buildAuthorizationContext(
  options?: PrivyClientOptions,
): PrivyAuthorizationContext | undefined {
  const authorization_private_keys = options?.walletAuthorizationKey
    ? [options.walletAuthorizationKey]
    : undefined;
  const user_jwts = options?.userJwt ? [options.userJwt] : undefined;
  if (!authorization_private_keys && !user_jwts) return undefined;
  return {
    ...(authorization_private_keys ? { authorization_private_keys } : {}),
    ...(user_jwts ? { user_jwts } : {}),
  };
}

function requireWalletId(walletId: string | null | undefined): string {
  const trimmed = walletId?.trim() ?? "";
  if (!trimmed) {
    throw new Error("Privy wallet id is required for wallet API requests.");
  }
  return trimmed;
}

function normalizePrivyTransaction(
  transaction: PrivyEthereumTransaction,
): PrivyEthereumNormalizedTransaction {
  const normalized: PrivyEthereumNormalizedTransaction = {};
  if (transaction.from !== undefined) normalized.from = transaction.from;
  if (transaction.to !== undefined) normalized.to = transaction.to;
  if (transaction.data !== null && transaction.data !== undefined)
    normalized.data = transaction.data;
  if (transaction.value !== null && transaction.value !== undefined)
    normalized.value = transaction.value;
  const gasLimit = transaction.gas_limit ?? transaction.gas;
  if (gasLimit !== null && gasLimit !== undefined)
    normalized.gas_limit = gasLimit;
  return normalized;
}

function normalizeTypedDataTypes(
  types: Record<string, readonly PrivyTypedDataField[]>,
): Record<string, PrivyTypedDataField[]> {
  return Object.fromEntries(
    Object.entries(types).map(([key, fields]) => [
      key,
      fields.map((field) => ({ name: field.name, type: field.type })),
    ]),
  );
}

function readWalletType(record: UnknownRecord): PrivyWalletType | null {
  const chainType = readString(record, "chainType", "chain_type");
  return chainType === "ethereum" || chainType === "solana" ? chainType : null;
}

function readLinkedAccounts(privyUser: PrivyUser): unknown[] {
  const record = privyUser as unknown as UnknownRecord;
  return readArray(record, "linkedAccounts", "linked_accounts");
}

function readPrimaryWallet(privyUser: PrivyUser): UnknownRecord | null {
  const wallet = (privyUser as unknown as UnknownRecord).wallet;
  return isRecord(wallet) ? wallet : null;
}

function readTopLevelEmail(privyUser: PrivyUser): string | null {
  const email = (privyUser as unknown as UnknownRecord).email;
  if (typeof email === "string") return email.trim() || null;
  if (!isRecord(email)) return null;
  return readString(email, "address");
}

function readTopLevelTelegram(privyUser: PrivyUser): UnknownRecord | null {
  const telegram = (privyUser as unknown as UnknownRecord).telegram;
  return isRecord(telegram) ? telegram : null;
}

function mapTelegramAccount(
  account: UnknownRecord,
): PrivyTelegramAccount | null {
  const telegramUserId = readStringOrNumber(
    account,
    "telegramUserId",
    "telegram_user_id",
  );
  if (!telegramUserId) return null;

  return {
    telegramUserId,
    firstName: readString(account, "firstName", "first_name"),
    lastName: readString(account, "lastName", "last_name"),
    username: readString(account, "username"),
    photoUrl: readString(account, "photoUrl", "photo_url"),
  };
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

export class PrivyTelegramIdentityMismatchError extends Error {
  readonly actualTelegramUserId: string | null;
  readonly expectedTelegramUserId: string;

  constructor(input: {
    actualTelegramUserId: string | null;
    expectedTelegramUserId: string;
  }) {
    super("Privy Telegram account did not match expected Telegram user");
    this.actualTelegramUserId = input.actualTelegramUserId;
    this.expectedTelegramUserId = input.expectedTelegramUserId;
  }
}

export class PrivyTelegramUnlinkPendingError extends Error {
  readonly actualTelegramUserId: string;
  readonly expectedRemovedTelegramUserId: string;

  constructor(input: {
    actualTelegramUserId: string;
    expectedRemovedTelegramUserId: string;
  }) {
    super("Privy Telegram account unlink is still pending");
    this.actualTelegramUserId = input.actualTelegramUserId;
    this.expectedRemovedTelegramUserId = input.expectedRemovedTelegramUserId;
  }
}

export class PrivyService {
  static createClient(options?: PrivyClientOptions): PrivyWalletApiClient {
    const authorization_context = buildAuthorizationContext(options);
    return {
      walletApi: {
        ethereum: {
          async sendTransaction(input) {
            const result = await privyClient
              .wallets()
              .ethereum()
              .sendTransaction(requireWalletId(input.walletId), {
                address: input.address,
                caip2: input.caip2,
                sponsor: input.sponsor,
                ...(input.referenceId
                  ? { reference_id: input.referenceId }
                  : {}),
                params: {
                  transaction: normalizePrivyTransaction(input.transaction),
                },
                ...(authorization_context ? { authorization_context } : {}),
              });
            return {
              hash: result.hash,
              referenceId: result.reference_id ?? null,
              transactionId: result.transaction_id ?? null,
              userOperationHash: result.user_operation_hash ?? null,
            };
          },
          async signTypedData(input) {
            return await privyClient
              .wallets()
              .ethereum()
              .signTypedData(requireWalletId(input.walletId), {
                address: input.address,
                params: {
                  typed_data: {
                    domain: input.typedData.domain,
                    types: normalizeTypedDataTypes(input.typedData.types),
                    message: input.typedData.message,
                    primary_type: input.typedData.primaryType,
                  },
                },
                ...(authorization_context ? { authorization_context } : {}),
              });
          },
          async signMessage(input) {
            return await privyClient
              .wallets()
              .ethereum()
              .signMessage(requireWalletId(input.walletId), {
                address: input.address,
                message: input.message,
                ...(authorization_context ? { authorization_context } : {}),
              });
          },
        },
        solana: {
          async signAndSendTransaction(input) {
            return await privyClient
              .wallets()
              .solana()
              .signAndSendTransaction(requireWalletId(input.walletId), {
                transaction: input.transaction,
                caip2: input.caip2,
                ...(authorization_context ? { authorization_context } : {}),
              });
          },
        },
      },
    };
  }

  /**
   * Verify a Privy access token and return the user claims
   */
  static async verifyAccessToken(accessToken: string): Promise<PrivyClaims> {
    try {
      const claims = await privyClient
        .utils()
        .auth()
        .verifyAccessToken(accessToken);
      return mapPrivyClaims(claims);
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
      return privyClient.webhooks().verify({
        payload,
        headers: {
          "svix-id": headers.id,
          "svix-timestamp": headers.timestamp,
          "svix-signature": headers.signature,
        },
        signing_secret: signingKey,
      });
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
      return await privyClient.users()._get(privyClaims.userId);
    } catch (error) {
      throw new PrivyUpstreamError(
        `Failed to fetch user data from Privy: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  static async getUserById(privyUserId: string): Promise<PrivyUser> {
    try {
      return await privyClient.users()._get(privyUserId);
    } catch (error) {
      throw new PrivyUpstreamError(
        `Failed to fetch Privy user by id: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  static async getManagedWalletMetadata(
    walletId: string,
  ): Promise<PrivyManagedWalletMetadata> {
    try {
      const wallet = await privyClient.wallets().get(walletId);
      if (wallet.chain_type !== "ethereum" && wallet.chain_type !== "solana") {
        throw new Error(`Unsupported Privy wallet chain: ${wallet.chain_type}`);
      }
      return {
        additionalSigners: wallet.additional_signers.map((signer) => ({
          overridePolicyIds: [...(signer.override_policy_ids ?? [])],
          signerId: signer.signer_id,
        })),
        address: wallet.address,
        chainType: wallet.chain_type,
        id: wallet.id,
        policyIds: [...wallet.policy_ids],
      };
    } catch (error) {
      throw new PrivyUpstreamError(
        `Failed to fetch Privy wallet metadata: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  static async getKeyQuorumMetadata(
    keyQuorumId: string,
  ): Promise<PrivyKeyQuorumMetadata> {
    try {
      const quorum = await privyClient.keyQuorums().get(keyQuorumId);
      return {
        authorizationPublicKeys: quorum.authorization_keys.map(
          (key) => key.public_key,
        ),
        authorizationThreshold: quorum.authorization_threshold,
        id: quorum.id,
        nestedKeyQuorumIds: [...(quorum.key_quorum_ids ?? [])],
        userIds: [...(quorum.user_ids ?? [])],
      };
    } catch (error) {
      throw new PrivyUpstreamError(
        `Failed to fetch Privy key quorum metadata: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  static async getPolicyMetadata(
    policyId: string,
  ): Promise<PrivyPolicyMetadata> {
    try {
      const policy = await privyClient.policies().get(policyId);
      if (policy.chain_type !== "ethereum" && policy.chain_type !== "solana") {
        throw new Error(`Unsupported Privy policy chain: ${policy.chain_type}`);
      }
      return {
        chainType: policy.chain_type,
        id: policy.id,
        rules: policy.rules.map((rule) => ({
          action: rule.action,
          conditions: rule.conditions,
          id: rule.id,
          method: rule.method,
          name: rule.name,
        })),
      };
    } catch (error) {
      throw new PrivyUpstreamError(
        `Failed to fetch Privy policy metadata: ${error instanceof Error ? error.message : "Unknown error"}`,
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

  static getPrimaryEmailAddress(privyUser: PrivyUser): string | null {
    for (const accountRaw of readLinkedAccounts(privyUser)) {
      if (!isRecord(accountRaw)) continue;
      if (readString(accountRaw, "type") !== "email") continue;
      const address = readString(accountRaw, "address");
      if (address) return address;
    }
    return readTopLevelEmail(privyUser);
  }

  static extractTelegramAccount(
    privyUser: PrivyUser,
  ): PrivyTelegramAccount | null {
    for (const accountRaw of readLinkedAccounts(privyUser)) {
      if (!isRecord(accountRaw)) continue;
      if (readString(accountRaw, "type") !== "telegram") continue;
      const telegramAccount = mapTelegramAccount(accountRaw);
      if (telegramAccount) return telegramAccount;
    }

    const topLevelTelegram = readTopLevelTelegram(privyUser);
    return topLevelTelegram ? mapTelegramAccount(topLevelTelegram) : null;
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

  private static normalizeExpectedTelegramUserId(
    value: string | null | undefined,
  ): string | null {
    const trimmed = value?.trim() ?? "";
    return /^\d+$/.test(trimmed) ? trimmed : null;
  }

  private static getTelegramUserId(privyUser: PrivyUser): string | null {
    return (
      this.extractTelegramAccount(privyUser)?.telegramUserId.trim() || null
    );
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

  private static shouldRetryPrivyUserSync(
    privyUser: PrivyUser,
    walletAddresses: string[],
    options: {
      expectedAddedWalletAddresses: string[];
      expectedRemovedWalletAddresses: string[];
      expectedRemovedTelegramUserId: string | null;
      expectedTelegramUserId: string | null;
    },
  ): boolean {
    if (
      this.shouldRetryWalletSync(walletAddresses, {
        expectedAddedWalletAddresses: options.expectedAddedWalletAddresses,
        expectedRemovedWalletAddresses: options.expectedRemovedWalletAddresses,
      })
    ) {
      return true;
    }

    const actualTelegramUserId = this.getTelegramUserId(privyUser);
    if (
      options.expectedTelegramUserId !== null &&
      actualTelegramUserId !== options.expectedTelegramUserId
    ) {
      return true;
    }
    return (
      options.expectedRemovedTelegramUserId !== null &&
      actualTelegramUserId === options.expectedRemovedTelegramUserId
    );
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
    const expectedTelegramUserId = this.normalizeExpectedTelegramUserId(
      options?.expectedTelegramUserId,
    );
    const expectedRemovedTelegramUserId = this.normalizeExpectedTelegramUserId(
      options?.expectedRemovedTelegramUserId,
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
      this.shouldRetryPrivyUserSync(user, walletAddresses, {
        expectedAddedWalletAddresses,
        expectedRemovedWalletAddresses,
        expectedRemovedTelegramUserId,
        expectedTelegramUserId,
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
    const actualTelegramUserId = this.getTelegramUserId(user);
    if (
      expectedTelegramUserId !== null &&
      actualTelegramUserId !== expectedTelegramUserId
    ) {
      throw new PrivyTelegramIdentityMismatchError({
        actualTelegramUserId,
        expectedTelegramUserId,
      });
    }
    if (
      expectedRemovedTelegramUserId !== null &&
      actualTelegramUserId === expectedRemovedTelegramUserId
    ) {
      throw new PrivyTelegramUnlinkPendingError({
        actualTelegramUserId,
        expectedRemovedTelegramUserId,
      });
    }

    return {
      claims,
      user,
      walletAddresses,
      primaryWalletAddress,
    };
  }

  static async deleteUser(privyUserId: string): Promise<void> {
    try {
      await privyClient.users().delete(privyUserId);
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
    walletClient: PrivyWalletApiClient;
    authorizationKey: string;
    authorizationExpiresAt: number;
  }> {
    const claims = await this.verifyAccessToken(accessToken);
    const user = await this.getUserData(claims);
    const walletClient = this.createClient({
      userJwt: accessToken,
    });

    return {
      claims,
      user,
      walletProfiles: this.classifyWallets(user),
      walletClient,
      authorizationKey: "",
      authorizationExpiresAt: claims.expiration * 1000,
    };
  }

  static async createUserWalletClientWithFallback(tokens: {
    accessToken?: string | null;
    identityToken?: string | null;
  }): Promise<{
    claims: PrivyClaims | null;
    user: PrivyUser;
    walletProfiles: PrivyWalletProfile[];
    walletClient: PrivyWalletApiClient;
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

        const user = await privyClient.users().get({
          id_token: candidate.token,
        });
        const walletClient = this.createClient({
          userJwt: candidate.token,
        });

        return {
          claims: null,
          user,
          walletProfiles: this.classifyWallets(user),
          walletClient,
          authorizationKey: "",
          authorizationExpiresAt: 0,
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
