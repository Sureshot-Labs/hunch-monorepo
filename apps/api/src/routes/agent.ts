import type {
  FastifyBaseLogger,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ethers } from "ethers";
import {
  AuthService,
  createAuthMiddleware,
  type User,
  type UserWallet,
} from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { checkRateLimitForSecurityClientIp } from "../lib/request-ip.js";
import { MIN_POSITION_SIZE } from "../lib/positions-constants.js";
import { markHotTokens } from "../lib/hot-tokens.js";
import {
  fetchSolanaBalanceLamports,
  fetchSolanaTokenBalanceByOwnerAndMint,
  formatUiAmount,
} from "../services/solana-rpc.js";
import { fetchEvmBalance, fetchEvmCode } from "../services/polygon-rpc.js";
import {
  fetchPolymarketOnchainSnapshot,
  POLYGON_NATIVE_USDC_ADDRESS,
} from "../services/polymarket-onchain.js";
import { fetchLimitlessOnchainSnapshot } from "../services/limitless-onchain.js";
import { isLimitlessPartnerHmacConfigured } from "../services/limitless-client.js";
import {
  resolveLimitlessAuthContext,
  verifyLimitlessAuthContext,
} from "../services/limitless-auth.js";
import { verifyProofAddress } from "../services/proof-client.js";
import {
  buildAuthWalletPayloads,
  loadPrivyWalletProfilesForUser,
} from "../services/auth-wallet-payloads.js";
import {
  mapUnifiedOrder,
  OPEN_ORDER_STATUSES,
} from "../services/unified-order-presenter.js";
import {
  resolveWalletBalancesForWalletWithInflight,
  type WalletBalanceItem,
} from "./wallets.js";
import {
  fetchPositionPnlSummaryForUserWallet,
  fetchPositionsForUserWallet,
  fetchPositionsForUserWalletByTokenIds,
} from "../repos/positions-repo.js";
import {
  fetchUnifiedOrderById,
  fetchUnifiedOrders,
} from "../repos/unified-orders.js";
import { fetchNotifications } from "../repos/notifications-repo.js";
import {
  agentDepositTargetsQuerySchema,
  agentApprovalTokenParamsSchema,
  agentApproveBodySchema,
  agentAuditQuerySchema,
  agentDenyBodySchema,
  agentDeviceStartBodySchema,
  agentDeviceTokenBodySchema,
  agentGrantParamsSchema,
  agentOrdersQuerySchema,
  agentReadinessQuerySchema,
  agentVenueStatusQuerySchema,
  agentWalletBalancesQuerySchema,
} from "../schemas/agent.js";
import { notificationsQuerySchema } from "../schemas/notifications.js";
import {
  positionsPnlSummaryQuerySchema,
  positionsQuerySchema,
} from "../schemas/positions.js";
import { orderIdParamsSchema, orderIdQuerySchema } from "../schemas/orders.js";
import {
  AgentAuthError,
  AgentAuthService,
  createAgentAuthMiddleware,
  summarizeAgentGrant,
} from "../services/agent-auth.js";

function readRequestUserAgent(request: FastifyRequest): string | null {
  const raw = request.headers["user-agent"];
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0].trim();
  return null;
}

function handleAgentError(error: unknown, reply: FastifyReply) {
  if (error instanceof AgentAuthError) {
    reply.code(error.statusCode);
    return reply.send({ error: error.code, message: error.message });
  }
  throw error;
}

async function enforceAgentRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  suffix: string,
  maxRequests: number,
  windowMs: number,
): Promise<string | null> {
  const result = await checkRateLimitForSecurityClientIp(request, {
    keyPrefix: `agent:${suffix}`,
    maxRequests,
    windowMs,
    onError: "fail_closed",
  });
  if (result.allowed) return result.clientIp;
  reply.code(429);
  reply.send({ error: "rate_limit_exceeded" });
  return null;
}

async function requireAgentAuthEnabled(
  _request: FastifyRequest,
  reply: FastifyReply,
) {
  if (env.agentAuthEnabled) return;
  reply.code(503);
  return reply.send({
    error: "agent_auth_disabled",
    message: "Agent auth is disabled on this API instance.",
  });
}

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const KALSHI_LOW_SOL_BUFFER_LAMPORTS = 2_000_000n;
const EVM_NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";
const SOLANA_NATIVE_ADDRESS = "11111111111111111111111111111111";

type AgentGrantContext = NonNullable<FastifyRequest["agentGrant"]>;
type AgentWalletVenue = "polymarket" | "kalshi" | "limitless";
type AgentWalletMetadata = ReturnType<typeof buildAuthWalletPayloads>[number];
type AgentDepositAsset = {
  id: string;
  symbol: string;
  name: string;
  address: string | null;
  mint: string | null;
  decimals: number;
  chainId: string;
  chainName: string;
  isNative: boolean;
  preferred: boolean;
  purpose: "collateral" | "convertible" | "native_fee";
  aliases: string[];
};
type AgentBlocker =
  | "missing_wallet"
  | "wallet_not_in_grant"
  | "wallet_type_mismatch"
  | "missing_credentials"
  | "invalid_credentials"
  | "account_verification_required"
  | "account_verification_unavailable"
  | "geo_or_proof_blocked"
  | "approval_required"
  | "allowance_required"
  | "insufficient_balance"
  | "native_fee_required"
  | "low_native_balance"
  | "relayer_disabled"
  | "service_unavailable"
  | "market_not_accepting_orders"
  | "market_expired";

function normalizeWalletKey(address: string | null | undefined): string | null {
  const trimmed = address?.trim() ?? "";
  if (!trimmed) return null;
  if (EVM_ADDRESS_RE.test(trimmed)) return trimmed.toLowerCase();
  return trimmed;
}

function uniqueWalletKeys(wallets: readonly string[] | undefined): string[] {
  return Array.from(
    new Set(
      (wallets ?? [])
        .map((wallet) => normalizeWalletKey(wallet))
        .filter((wallet): wallet is string => Boolean(wallet)),
    ),
  );
}

function inferWalletType(wallet: UserWallet): "ethereum" | "solana" {
  if (wallet.walletType === "solana") return "solana";
  return "ethereum";
}

function venuesForWallet(wallet: UserWallet): AgentWalletVenue[] {
  return inferWalletType(wallet) === "solana"
    ? ["kalshi"]
    : ["polymarket", "limitless"];
}

function walletMetadataKey(wallet: {
  walletAddress: string;
  walletType?: string | null;
}): string | null {
  const address = normalizeWalletKey(wallet.walletAddress);
  if (!address) return null;
  const walletType = wallet.walletType?.trim().toLowerCase() || "ethereum";
  return `${walletType}:${address}`;
}

async function loadAgentWalletMetadataByKey(input: {
  user: Pick<User, "id" | "privyUserId">;
  wallets: UserWallet[];
  log: FastifyBaseLogger;
}): Promise<Map<string, AgentWalletMetadata>> {
  const profiles = await loadPrivyWalletProfilesForUser(input.user, input.log);
  return new Map(
    buildAuthWalletPayloads(input.wallets, profiles)
      .map((wallet) => [walletMetadataKey(wallet), wallet] as const)
      .filter((entry): entry is [string, AgentWalletMetadata] =>
        Boolean(entry[0]),
      ),
  );
}

function isSponsoredInternalWallet(
  metadata: AgentWalletMetadata | null | undefined,
): boolean {
  return Boolean(
    metadata?.isInternalWallet ||
    metadata?.isEmbeddedWallet ||
    metadata?.isSmartWallet ||
    metadata?.walletSource === "embedded" ||
    metadata?.walletSource === "smart",
  );
}

async function loadApprovedLinkedWallets(input: {
  userId: string;
  grant: AgentGrantContext;
}): Promise<UserWallet[]> {
  const approved = new Set(uniqueWalletKeys(input.grant.walletAddresses));
  if (approved.size === 0) return [];
  const linked = await AuthService.getUserWallets(input.userId);
  return linked.filter((wallet) => {
    const key = normalizeWalletKey(wallet.walletAddress);
    return Boolean(key && approved.has(key));
  });
}

function resolveRequestedWalletKeys(input: {
  walletAddress?: string;
  wallets?: string[];
}): string[] {
  return uniqueWalletKeys([
    ...(input.walletAddress ? [input.walletAddress] : []),
    ...(input.wallets ?? []),
  ]);
}

async function resolveAgentWallets(input: {
  userId: string;
  grant: AgentGrantContext;
  walletAddress?: string;
  wallets?: string[];
}): Promise<UserWallet[]> {
  const approvedWallets = await loadApprovedLinkedWallets(input);
  const requested = resolveRequestedWalletKeys(input);
  if (requested.length === 0) return approvedWallets;

  const approvedByKey = new Map(
    approvedWallets
      .map(
        (wallet) => [normalizeWalletKey(wallet.walletAddress), wallet] as const,
      )
      .filter((entry): entry is [string, UserWallet] => Boolean(entry[0])),
  );
  const resolved: UserWallet[] = [];
  for (const key of requested) {
    const wallet = approvedByKey.get(key);
    if (!wallet) {
      throw new AgentAuthError(
        "wallet_not_in_grant",
        "Wallet is not approved for this agent grant",
        403,
      );
    }
    resolved.push(wallet);
  }
  return Array.from(
    new Map(resolved.map((wallet) => [wallet.walletAddress, wallet])).values(),
  );
}

async function resolveMarketIds(
  eventId: string | undefined,
): Promise<string[]> {
  if (!eventId) return [];
  const { rows } = await pool.query<{ id: string }>(
    `select id from unified_markets where event_id = $1`,
    [eventId],
  );
  return rows.map((row) => row.id);
}

async function resolveTokenIdsForFilter(
  marketId: string | undefined,
  eventId: string | undefined,
): Promise<string[] | null> {
  if (marketId) {
    const { rows } = await pool.query<{ token_id: string }>(
      `select token_id from unified_tokens where market_id = $1`,
      [marketId],
    );
    return rows.map((row) => row.token_id);
  }
  if (eventId) {
    const { rows } = await pool.query<{ token_id: string }>(
      `
        select ut.token_id
        from unified_tokens ut
        join unified_markets m on m.id = ut.market_id
        where m.event_id = $1
      `,
      [eventId],
    );
    return rows.map((row) => row.token_id);
  }
  return null;
}

function buildDepositPageUrl(input: {
  venue: AgentWalletVenue;
  targetAddress: string;
  asset?: AgentDepositAsset;
}): string {
  const url = new URL("/", env.agentAppBaseUrl);
  url.searchParams.set("deposit", "manual");
  url.searchParams.set("depositVenue", input.venue);
  url.searchParams.set("depositTarget", input.targetAddress);
  if (input.asset) {
    url.searchParams.set("depositAsset", input.asset.id);
    url.searchParams.set("depositChainId", input.asset.chainId);
    url.searchParams.set(
      "depositToken",
      input.asset.address ?? input.asset.mint ?? "",
    );
  }
  return url.toString();
}

function normalizeAssetLookup(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_.-]+/g, "");
}

function depositAssetsForVenue(venue: AgentWalletVenue): AgentDepositAsset[] {
  if (venue === "polymarket") {
    return [
      {
        id: "polymarket-pusd",
        symbol: "pUSD",
        name: "Polymarket collateral",
        address: env.polymarketUsdcAddress,
        mint: null,
        decimals: 6,
        chainId: "137",
        chainName: "Polygon",
        isNative: false,
        preferred: true,
        purpose: "collateral",
        aliases: ["pusd", "polymarket-usdc", "collateral"],
      },
      {
        id: "polygon-usdce",
        symbol: "USDC.e",
        name: "Bridged USDC",
        address: env.polymarketUsdceAddress,
        mint: null,
        decimals: 6,
        chainId: "137",
        chainName: "Polygon",
        isNative: false,
        preferred: false,
        purpose: "convertible",
        aliases: ["usdce", "usdc.e", "bridged-usdc"],
      },
      {
        id: "polygon-usdc",
        symbol: "USDC",
        name: "Native USDC",
        address: POLYGON_NATIVE_USDC_ADDRESS,
        mint: null,
        decimals: 6,
        chainId: "137",
        chainName: "Polygon",
        isNative: false,
        preferred: false,
        purpose: "convertible",
        aliases: ["usdc", "native-usdc", "polygon-usdc"],
      },
      {
        id: "polygon-pol",
        symbol: "POL",
        name: "Polygon native gas",
        address: EVM_NATIVE_ADDRESS,
        mint: null,
        decimals: 18,
        chainId: "137",
        chainName: "Polygon",
        isNative: true,
        preferred: false,
        purpose: "native_fee",
        aliases: ["pol", "matic", "gas"],
      },
    ];
  }

  if (venue === "limitless") {
    return [
      {
        id: "base-usdc",
        symbol: "USDC",
        name: "Base USDC",
        address: env.limitlessUsdcAddress,
        mint: null,
        decimals: 6,
        chainId: "8453",
        chainName: "Base",
        isNative: false,
        preferred: true,
        purpose: "collateral",
        aliases: ["usdc", "base-usdc"],
      },
      {
        id: "base-eth",
        symbol: "ETH",
        name: "Base native gas",
        address: EVM_NATIVE_ADDRESS,
        mint: null,
        decimals: 18,
        chainId: "8453",
        chainName: "Base",
        isNative: true,
        preferred: false,
        purpose: "native_fee",
        aliases: ["eth", "base-eth", "gas"],
      },
    ];
  }

  return [
    {
      id: "solana-usdc",
      symbol: "USDC",
      name: "Solana USDC",
      address: null,
      mint: env.solanaUsdcMint,
      decimals: 6,
      chainId: "7565164",
      chainName: "Solana",
      isNative: false,
      preferred: true,
      purpose: "collateral",
      aliases: ["usdc", "solana-usdc"],
    },
    {
      id: "solana-sol",
      symbol: "SOL",
      name: "Solana native fees",
      address: null,
      mint: SOLANA_NATIVE_ADDRESS,
      decimals: 9,
      chainId: "7565164",
      chainName: "Solana",
      isNative: true,
      preferred: false,
      purpose: "native_fee",
      aliases: ["sol", "gas"],
    },
  ];
}

function filterDepositAssets(
  venue: AgentWalletVenue,
  assetQuery: string | undefined,
): AgentDepositAsset[] {
  const assets = depositAssetsForVenue(venue);
  const normalizedQuery = normalizeAssetLookup(assetQuery);
  if (!normalizedQuery) return assets;
  return assets.filter((asset) => {
    const values = [
      asset.id,
      asset.symbol,
      asset.name,
      asset.address,
      asset.mint,
      ...asset.aliases,
    ];
    return values.some(
      (value) => normalizeAssetLookup(value) === normalizedQuery,
    );
  });
}

function baseBalance(
  chainId: string,
  address: string,
  symbol: string,
  balance: string | undefined,
  balanceRaw: string | undefined,
  decimals = 6,
  owner?: {
    ownerRole: "signer" | "funder" | "wallet";
    ownerAddress: string;
  },
):
  | (WalletBalanceItem & {
      ownerRole?: "signer" | "funder" | "wallet";
      ownerAddress?: string;
    })
  | null {
  if (balance == null || balanceRaw == null) return null;
  return {
    chainId,
    address,
    symbol,
    name: symbol,
    decimals,
    balance,
    balanceRaw,
    isNative: false,
    ...(owner ?? {}),
  };
}

function withBalanceOwner<T extends Record<string, unknown>>(
  status: T,
  ownerRole: "signer" | "funder" | "wallet",
  ownerAddress: string,
): T & { ownerRole: "signer" | "funder" | "wallet"; ownerAddress: string } {
  return { ...status, ownerRole, ownerAddress };
}

async function resolveAgentVenueStatusForWallet(input: {
  userId: string;
  userKalshiProofBypass: boolean;
  wallet: UserWallet;
  walletMetadata?: AgentWalletMetadata | null;
  refresh: boolean;
  log: FastifyBaseLogger;
}) {
  const walletAddress = input.wallet.walletAddress;
  const walletType = inferWalletType(input.wallet);
  const nativeFeesSponsored = isSponsoredInternalWallet(input.walletMetadata);
  const response: Record<string, unknown> = {
    walletAddress,
    walletType,
    isPrimary: input.wallet.isPrimary,
    walletSource: input.walletMetadata?.walletSource ?? "unknown",
    isInternalWallet: input.walletMetadata?.isInternalWallet ?? false,
  };

  if (walletType === "ethereum") {
    const relayerEnabled = Boolean(
      env.polymarketBuilderApiKey &&
      env.polymarketBuilderApiSecret &&
      env.polymarketBuilderApiPassphrase,
    );
    try {
      const [polymarketCreds, limitlessCreds] = await Promise.all([
        AuthService.getVenueCredentialsInfo(
          input.userId,
          "polymarket",
          walletAddress,
        ),
        AuthService.getVenueCredentialsInfo(
          input.userId,
          "limitless",
          walletAddress,
        ),
      ]);
      const funder = polymarketCreds?.funderAddress ?? walletAddress;
      const signerMatchesFunder =
        walletAddress.toLowerCase() === funder.toLowerCase();
      const feeCollectorAddress = env.feeCollectorAddress?.trim() || "";
      const negRiskAdapterAddress =
        env.polymarketNegRiskAdapterAddress?.trim() || "";

      const [polymarketStatus, limitlessStatus] = await Promise.allSettled([
        (async () => {
          const signerCodePromise = fetchEvmCode({
            rpcUrl: env.polygonRpcUrl,
            timeoutMs: env.polygonRpcTimeoutMs,
            address: walletAddress,
          });
          const funderCodePromise = signerMatchesFunder
            ? signerCodePromise
            : fetchEvmCode({
                rpcUrl: env.polygonRpcUrl,
                timeoutMs: env.polygonRpcTimeoutMs,
                address: funder,
              });
          const [
            signerCode,
            funderCode,
            snapshot,
            funderNativeBalance,
            signerNativeBalance,
          ] = await Promise.all([
            signerCodePromise,
            funderCodePromise,
            fetchPolymarketOnchainSnapshot({
              rpcUrl: env.polygonRpcUrl,
              timeoutMs: env.polygonRpcTimeoutMs,
              signer: walletAddress,
              funder,
              includeSignerUsdc: !signerMatchesFunder,
              negRiskAdapterAddress,
              feeCollectorAddress,
            }),
            fetchEvmBalance({
              rpcUrl: env.polygonRpcUrl,
              timeoutMs: env.polygonRpcTimeoutMs,
              address: funder,
            }),
            signerMatchesFunder
              ? Promise.resolve<bigint | null>(null)
              : fetchEvmBalance({
                  rpcUrl: env.polygonRpcUrl,
                  timeoutMs: env.polygonRpcTimeoutMs,
                  address: walletAddress,
                }),
          ]);
          const signerIsContract =
            typeof signerCode === "string" && signerCode.length > 2;
          const funderIsContract =
            typeof funderCode === "string" && funderCode.length > 2;
          const reasons: string[] = [];
          if (!polymarketCreds) reasons.push("missing_credentials");
          if (funderIsContract && !relayerEnabled)
            reasons.push("relayer_disabled");
          if (snapshot.pusdBalance <= 0n) reasons.push("insufficient_usdc");
          if (snapshot.allowanceExchange <= 0n)
            reasons.push("allowance_exchange");
          if (!snapshot.okExchange) reasons.push("approval_exchange");

          const negRiskReasons: string[] = [];
          if (!polymarketCreds) negRiskReasons.push("missing_credentials");
          if (funderIsContract && !relayerEnabled) {
            negRiskReasons.push("relayer_disabled");
          }
          if (snapshot.allowanceNegRisk <= 0n) {
            negRiskReasons.push("allowance_neg_risk");
          }
          if (!snapshot.okNegRisk) negRiskReasons.push("approval_neg_risk");
          if (negRiskAdapterAddress && !snapshot.okNegRiskAdapter) {
            negRiskReasons.push("approval_neg_risk_adapter");
          }
          if (
            negRiskAdapterAddress &&
            (snapshot.allowanceNegRiskAdapter ?? 0n) <= 0n
          ) {
            negRiskReasons.push("allowance_neg_risk_adapter");
          }

          const funderPusd = withBalanceOwner(
            {
              tokenAddress: env.polymarketUsdcAddress,
              decimals: 6,
              balance: ethers.formatUnits(snapshot.pusdBalance, 6),
              balanceRaw: snapshot.pusdBalance.toString(),
              allowance: {
                exchange: {
                  spender: env.polymarketExchangeAddress,
                  allowance: ethers.formatUnits(snapshot.allowanceExchange, 6),
                  allowanceRaw: snapshot.allowanceExchange.toString(),
                },
                negRiskExchange: {
                  spender: env.polymarketNegRiskExchangeAddress,
                  allowance: ethers.formatUnits(snapshot.allowanceNegRisk, 6),
                  allowanceRaw: snapshot.allowanceNegRisk.toString(),
                },
              },
            },
            "funder",
            funder,
          );
          const funderUsdce = withBalanceOwner(
            {
              tokenAddress: env.polymarketUsdceAddress,
              decimals: 6,
              balance: ethers.formatUnits(snapshot.usdceBalance, 6),
              balanceRaw: snapshot.usdceBalance.toString(),
            },
            "funder",
            funder,
          );
          const funderNativeUsdc = withBalanceOwner(
            {
              tokenAddress: POLYGON_NATIVE_USDC_ADDRESS,
              decimals: 6,
              balance: ethers.formatUnits(snapshot.nativeUsdcBalance, 6),
              balanceRaw: snapshot.nativeUsdcBalance.toString(),
            },
            "funder",
            funder,
          );
          const funderNative = withBalanceOwner(
            {
              symbol: "POL",
              decimals: 18,
              balance: ethers.formatUnits(funderNativeBalance, 18),
              balanceRaw: funderNativeBalance.toString(),
            },
            "funder",
            funder,
          );
          const signerPusdBalance =
            snapshot.signerPusdBalance ?? snapshot.pusdBalance;
          const signerUsdceBalance =
            snapshot.signerUsdceBalance ?? snapshot.usdceBalance;
          const signerNativeUsdcBalance =
            snapshot.signerNativeUsdcBalance ?? snapshot.nativeUsdcBalance;
          const signerNativeBalanceResolved =
            signerNativeBalance ?? funderNativeBalance;
          const signerPusd = withBalanceOwner(
            {
              tokenAddress: env.polymarketUsdcAddress,
              decimals: 6,
              balance: ethers.formatUnits(signerPusdBalance, 6),
              balanceRaw: signerPusdBalance.toString(),
            },
            "signer",
            walletAddress,
          );
          const signerUsdce = withBalanceOwner(
            {
              tokenAddress: env.polymarketUsdceAddress,
              decimals: 6,
              balance: ethers.formatUnits(signerUsdceBalance, 6),
              balanceRaw: signerUsdceBalance.toString(),
            },
            "signer",
            walletAddress,
          );
          const signerNativeUsdc = withBalanceOwner(
            {
              tokenAddress: POLYGON_NATIVE_USDC_ADDRESS,
              decimals: 6,
              balance: ethers.formatUnits(signerNativeUsdcBalance, 6),
              balanceRaw: signerNativeUsdcBalance.toString(),
            },
            "signer",
            walletAddress,
          );
          const signerNative = withBalanceOwner(
            {
              symbol: "POL",
              decimals: 18,
              balance: ethers.formatUnits(signerNativeBalanceResolved, 18),
              balanceRaw: signerNativeBalanceResolved.toString(),
            },
            "signer",
            walletAddress,
          );

          return {
            supported: true,
            ready: reasons.length === 0,
            readyNegRisk: negRiskReasons.length === 0,
            reasons,
            negRiskReasons,
            hasCredentials: Boolean(polymarketCreds),
            signerIsContract,
            signer: {
              address: walletAddress,
              isContract: signerIsContract,
              balances: {
                pusd: signerPusd,
                usdc: signerPusd,
                usdce: signerUsdce,
                nativeUsdc: signerNativeUsdc,
                native: signerNative,
              },
            },
            funder,
            funderSource: polymarketCreds?.funderAddress
              ? "credentials"
              : "signer",
            funderIsContract,
            signerMatchesFunder,
            tradingBalanceOwner: "funder",
            funderAccount: {
              address: funder,
              source: polymarketCreds?.funderAddress ? "credentials" : "signer",
              isContract: funderIsContract,
              balances: {
                pusd: funderPusd,
                usdc: funderPusd,
                usdce: funderUsdce,
                nativeUsdc: funderNativeUsdc,
                native: funderNative,
              },
            },
            relayerEnabled,
            pusd: funderPusd,
            usdc: funderPusd,
            usdce: funderUsdce,
            nativeUsdc: funderNativeUsdc,
            native: funderNative,
            conditionalTokens: {
              contractAddress: env.polymarketConditionalTokensAddress,
              isApprovedForAll: {
                exchange: snapshot.okExchange,
                negRiskExchange: snapshot.okNegRisk,
                ...(negRiskAdapterAddress
                  ? { negRiskAdapter: snapshot.okNegRiskAdapter }
                  : {}),
              },
            },
          };
        })(),
        (async () => {
          const snapshot = await fetchLimitlessOnchainSnapshot({
            rpcUrl: env.baseRpcUrl,
            timeoutMs: env.baseRpcTimeoutMs,
            owner: walletAddress,
          });
          if (!isLimitlessPartnerHmacConfigured()) {
            return {
              supported: false,
              ready: false,
              reasons: ["service_unavailable"],
              hasCredentials: false,
              error: "Limitless is temporarily unavailable.",
              chainId: 8453,
              usdc: {
                tokenAddress: env.limitlessUsdcAddress,
                decimals: 6,
                balance: ethers.formatUnits(snapshot.usdcBalance, 6),
                balanceRaw: snapshot.usdcBalance.toString(),
              },
            };
          }
          const authContext = limitlessCreds
            ? await resolveLimitlessAuthContext(input.userId, walletAddress)
            : null;
          const reasons: string[] = [];
          let hasCredentials = false;
          if (!limitlessCreds || !authContext) {
            reasons.push("missing_credentials");
          } else {
            const verification = await verifyLimitlessAuthContext({
              authContext,
              walletAddress,
            });
            hasCredentials = verification.ok;
            if (!verification.ok) reasons.push("invalid_credentials");
          }
          if (snapshot.usdcBalance <= 0n) reasons.push("insufficient_usdc");
          return {
            supported: true,
            ready: reasons.length === 0,
            reasons,
            hasCredentials,
            chainId: 8453,
            usdc: {
              tokenAddress: env.limitlessUsdcAddress,
              decimals: 6,
              balance: ethers.formatUnits(snapshot.usdcBalance, 6),
              balanceRaw: snapshot.usdcBalance.toString(),
            },
          };
        })(),
      ]);
      response.polymarket =
        polymarketStatus.status === "fulfilled"
          ? polymarketStatus.value
          : {
              supported: true,
              ready: false,
              error: "Polymarket status lookup failed",
            };
      response.limitless =
        limitlessStatus.status === "fulfilled"
          ? limitlessStatus.value
          : {
              supported: true,
              ready: false,
              error: "Limitless status lookup failed",
            };
    } catch (error) {
      input.log.warn({ error, walletAddress }, "Agent EVM venue status failed");
      response.polymarket = {
        supported: true,
        ready: false,
        error: "Polymarket status lookup failed",
      };
      response.limitless = {
        supported: true,
        ready: false,
        error: "Limitless status lookup failed",
      };
    }
    response.kalshi = {
      supported: false,
      ready: false,
      reasons: ["wallet_type_mismatch"],
    };
    return response;
  }

  if (walletType === "solana") {
    try {
      const creds = await AuthService.getVenueCredentialsInfo(
        input.userId,
        "kalshi",
        walletAddress,
      );
      const [solBalance, usdcBalance] = await Promise.all([
        fetchSolanaBalanceLamports({
          rpcUrls: env.solanaRpcUrls,
          owner: walletAddress,
          timeoutMs: env.solanaRpcTimeoutMs,
        }),
        fetchSolanaTokenBalanceByOwnerAndMint({
          rpcUrls: env.solanaRpcUrls,
          owner: walletAddress,
          mint: env.solanaUsdcMint,
          timeoutMs: env.solanaRpcTimeoutMs,
        }),
      ]);
      const usdcAmount = usdcBalance?.amount ?? 0n;
      const usdcDecimals = usdcBalance?.decimals ?? 6;
      const reasons: string[] = [];
      const hasLowSolBalance = solBalance < KALSHI_LOW_SOL_BUFFER_LAMPORTS;
      if (hasLowSolBalance && !nativeFeesSponsored) {
        reasons.push("low_sol_balance");
      }
      if (usdcAmount <= 0n) reasons.push("insufficient_usdc");
      const proofBypass = input.userKalshiProofBypass ? "user" : "none";
      let proofVerified = false;
      let proofRequiredForBuy = false;
      let proofReason:
        | "required"
        | "unavailable"
        | "disabled"
        | "bypassed"
        | undefined;
      if (!env.kalshiProofEnabled) {
        proofReason = "disabled";
      } else if (proofBypass !== "none") {
        proofReason = "bypassed";
      } else {
        const proofCheck = await verifyProofAddress({
          address: walletAddress,
          forceRefresh: input.refresh,
        });
        if (proofCheck.ok) {
          proofVerified = proofCheck.verified;
          if (!proofCheck.verified) {
            proofRequiredForBuy = true;
            proofReason = "required";
          }
        } else {
          proofRequiredForBuy = true;
          proofReason = "unavailable";
        }
      }
      response.kalshi = {
        supported: true,
        ready: reasons.length === 0,
        reasons,
        hasCredentials: Boolean(creds),
        proofVerified,
        proofRequiredForBuy,
        proofBypass,
        nativeFeesSponsored,
        feeSponsorship: nativeFeesSponsored
          ? {
              nativeFeesSponsored: true,
              provider: "privy",
              note: "Native Solana fees can be sponsored for this embedded trading wallet.",
            }
          : {
              nativeFeesSponsored: false,
            },
        notes: nativeFeesSponsored ? ["native_fees_sponsored"] : [],
        ...(proofReason ? { proofReason } : {}),
        sol: {
          balance: formatUiAmount(solBalance, 9),
          balanceRaw: solBalance.toString(),
          decimals: 9,
          symbol: "SOL",
        },
        usdc: {
          mint: env.solanaUsdcMint,
          balance: formatUiAmount(usdcAmount, usdcDecimals),
          balanceRaw: usdcAmount.toString(),
          decimals: usdcDecimals,
          symbol: "USDC",
        },
      };
    } catch (error) {
      input.log.warn({ error, walletAddress }, "Agent Kalshi status failed");
      response.kalshi = {
        supported: true,
        ready: false,
        error: "Kalshi status lookup failed",
      };
    }
    response.polymarket = {
      supported: false,
      ready: false,
      reasons: ["wallet_type_mismatch"],
    };
    response.limitless = {
      supported: false,
      ready: false,
      reasons: ["wallet_type_mismatch"],
    };
    return response;
  }

  response.polymarket = {
    supported: false,
    ready: false,
    reasons: ["wallet_type_mismatch"],
  };
  response.limitless = {
    supported: false,
    ready: false,
    reasons: ["wallet_type_mismatch"],
  };
  response.kalshi = {
    supported: false,
    ready: false,
    reasons: ["wallet_type_mismatch"],
  };
  return response;
}

function mapVenueReasonsToBlockers(
  status: Record<string, unknown>,
): AgentBlocker[] {
  const reasons = [
    ...(((status.reasons as string[] | undefined) ?? []) as string[]),
    ...(((status.negRiskReasons as string[] | undefined) ?? []) as string[]),
  ];
  const blockers = new Set<AgentBlocker>();
  for (const reason of reasons) {
    if (reason === "missing_credentials") blockers.add("missing_credentials");
    else if (reason === "invalid_credentials")
      blockers.add("invalid_credentials");
    else if (reason === "insufficient_usdc")
      blockers.add("insufficient_balance");
    else if (reason === "low_sol_balance") blockers.add("low_native_balance");
    else if (reason === "relayer_disabled") blockers.add("relayer_disabled");
    else if (reason.includes("allowance")) blockers.add("allowance_required");
    else if (reason.includes("approval")) blockers.add("approval_required");
    else if (reason === "service_unavailable")
      blockers.add("service_unavailable");
    else if (reason === "wallet_type_mismatch")
      blockers.add("wallet_type_mismatch");
  }
  if (status.error) blockers.add("service_unavailable");
  if (status.proofRequiredForBuy === true)
    blockers.add("account_verification_required");
  if (status.proofReason === "unavailable") {
    blockers.add("account_verification_unavailable");
  }
  return Array.from(blockers);
}

function readStringField(
  object: Record<string, unknown>,
  key: string,
): string | null {
  const value = object[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readRecordField(
  object: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  const value = object?.[key];
  return typeof value === "object" && value != null
    ? (value as Record<string, unknown>)
    : null;
}

function readBalanceRecord(
  object: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, string> | undefined {
  const value = object?.[key];
  return typeof value === "object" && value != null
    ? (value as Record<string, string>)
    : undefined;
}

function buildPolymarketReadinessBalances(input: {
  walletAddress: string;
  venueStatus: Record<string, unknown>;
}): Array<
  WalletBalanceItem & {
    ownerRole?: "signer" | "funder" | "wallet";
    ownerAddress?: string;
  }
> {
  const funderAddress =
    readStringField(input.venueStatus, "funder") ?? input.walletAddress;
  const signer = readRecordField(input.venueStatus, "signer");
  const signerAddress =
    readStringField(signer ?? {}, "address") ?? input.walletAddress;
  const funderAccount = readRecordField(input.venueStatus, "funderAccount");
  const signerBalances = readRecordField(signer, "balances");
  const funderBalances = readRecordField(funderAccount, "balances");
  const signerMatchesFunder =
    input.venueStatus.signerMatchesFunder === true ||
    signerAddress.toLowerCase() === funderAddress.toLowerCase();

  const funderPusd =
    readBalanceRecord(funderBalances, "pusd") ??
    readBalanceRecord(input.venueStatus, "pusd") ??
    readBalanceRecord(input.venueStatus, "usdc");
  const funderUsdce =
    readBalanceRecord(funderBalances, "usdce") ??
    readBalanceRecord(input.venueStatus, "usdce");
  const funderNativeUsdc =
    readBalanceRecord(funderBalances, "nativeUsdc") ??
    readBalanceRecord(input.venueStatus, "nativeUsdc");
  const signerPusd =
    readBalanceRecord(signerBalances, "pusd") ??
    readBalanceRecord(input.venueStatus, "signerPusd") ??
    readBalanceRecord(input.venueStatus, "signerUsdc");
  const signerUsdce =
    readBalanceRecord(signerBalances, "usdce") ??
    readBalanceRecord(input.venueStatus, "signerUsdce");
  const signerNativeUsdc =
    readBalanceRecord(signerBalances, "nativeUsdc") ??
    readBalanceRecord(input.venueStatus, "signerNativeUsdc");

  return [
    baseBalance(
      "137",
      env.polymarketUsdcAddress,
      "pUSD",
      funderPusd?.balance,
      funderPusd?.balanceRaw,
      6,
      { ownerRole: "funder", ownerAddress: funderAddress },
    ),
    baseBalance(
      "137",
      env.polymarketUsdceAddress,
      "USDC.e",
      funderUsdce?.balance,
      funderUsdce?.balanceRaw,
      6,
      { ownerRole: "funder", ownerAddress: funderAddress },
    ),
    baseBalance(
      "137",
      POLYGON_NATIVE_USDC_ADDRESS,
      "USDC",
      funderNativeUsdc?.balance,
      funderNativeUsdc?.balanceRaw,
      6,
      { ownerRole: "funder", ownerAddress: funderAddress },
    ),
    signerMatchesFunder
      ? null
      : baseBalance(
          "137",
          env.polymarketUsdcAddress,
          "pUSD",
          signerPusd?.balance,
          signerPusd?.balanceRaw,
          6,
          { ownerRole: "signer", ownerAddress: signerAddress },
        ),
    signerMatchesFunder
      ? null
      : baseBalance(
          "137",
          env.polymarketUsdceAddress,
          "USDC.e",
          signerUsdce?.balance,
          signerUsdce?.balanceRaw,
          6,
          { ownerRole: "signer", ownerAddress: signerAddress },
        ),
    signerMatchesFunder
      ? null
      : baseBalance(
          "137",
          POLYGON_NATIVE_USDC_ADDRESS,
          "USDC",
          signerNativeUsdc?.balance,
          signerNativeUsdc?.balanceRaw,
          6,
          { ownerRole: "signer", ownerAddress: signerAddress },
        ),
  ].filter(
    (
      item,
    ): item is WalletBalanceItem & {
      ownerRole?: "signer" | "funder" | "wallet";
      ownerAddress?: string;
    } => Boolean(item),
  );
}

function buildReadinessNextActions(input: {
  blockers: AgentBlocker[];
  venue: AgentWalletVenue;
  walletAddress: string;
  venueStatus: Record<string, unknown>;
}) {
  return input.blockers.map((code) => {
    const action: {
      code: AgentBlocker;
      label: string;
      href?: string;
    } = {
      code,
      label: code.replace(/_/g, " "),
    };
    if (code === "insufficient_balance") {
      const targetAddress =
        input.venue === "polymarket"
          ? (readStringField(input.venueStatus, "funder") ??
            input.walletAddress)
          : input.walletAddress;
      action.href = buildDepositPageUrl({
        venue: input.venue,
        targetAddress,
      });
    }
    return action;
  });
}

async function loadMarketReadinessBlockers(input: {
  marketId?: string;
  eventId?: string;
  venue?: string;
}): Promise<AgentBlocker[]> {
  if (!input.marketId && !input.eventId) return [];
  const params: unknown[] = [];
  let where = "";
  if (input.marketId) {
    params.push(input.marketId);
    where = `id = $1`;
  } else {
    params.push(input.eventId);
    where = `event_id = $1`;
  }
  if (input.venue) {
    params.push(input.venue);
    where += ` and venue = $${params.length}`;
  }
  const { rows } = await pool.query<{
    status: string;
    close_time: Date | null;
    expiration_time: Date | null;
  }>(
    `
      select status::text, close_time, expiration_time
      from unified_markets
      where ${where}
      limit 25
    `,
    params,
  );
  if (rows.length === 0) return [];
  const now = Date.now();
  const anyOpen = rows.some((row) => {
    const expiry = row.expiration_time ?? row.close_time;
    return row.status === "ACTIVE" && (!expiry || expiry.getTime() > now);
  });
  if (anyOpen) return [];
  const anyExpired = rows.some((row) => {
    const expiry = row.expiration_time ?? row.close_time;
    return expiry && expiry.getTime() <= now;
  });
  return [anyExpired ? "market_expired" : "market_not_accepting_orders"];
}

export const agentRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const browserAuth = createAuthMiddleware();
  const agentAccountAuth = createAgentAuthMiddleware({
    requiredScopes: ["read:account"],
  });
  const agentNotificationsAuth = createAgentAuthMiddleware({
    requiredScopes: ["read:notifications"],
  });
  const agentWalletsAuth = createAgentAuthMiddleware({
    requiredScopes: ["read:wallets"],
  });
  const agentPositionsAuth = createAgentAuthMiddleware({
    requiredScopes: ["read:positions"],
  });
  const agentOrdersAuth = createAgentAuthMiddleware({
    requiredScopes: ["read:orders"],
  });
  const agentFundingAuth = createAgentAuthMiddleware({
    requiredScopes: ["read:funding"],
  });

  r.get("/agent/capabilities", async (_request, reply) => {
    reply.header("Content-Type", "application/json; charset=utf-8");
    return reply.send({
      ok: true,
      enabled: env.agentAuthEnabled,
      scopes: AgentAuthService.allowedReadScopes(),
      approvalTtlMs: env.agentAuthApprovalTtlMs,
      defaultGrantTtlMs: env.agentGrantDefaultTtlMs,
      maxReadGrantTtlMs: env.agentGrantMaxReadTtlMs,
      pollIntervalSec: Math.ceil(env.agentAuthPollIntervalMs / 1000),
    });
  });

  r.post(
    "/agent/device/start",
    {
      preHandler: requireAgentAuthEnabled,
      schema: { body: agentDeviceStartBodySchema },
    },
    async (request, reply) => {
      const clientIp = await enforceAgentRateLimit(
        request,
        reply,
        "device-start",
        20,
        60_000,
      );
      if (!clientIp) return;

      try {
        const body = request.body;
        const result = await AgentAuthService.startDeviceAuthorization({
          requestedScopes: body.requestedScopes,
          requestedWalletAddresses: body.requestedWalletAddresses,
          requestedVenues: body.requestedVenues,
          requestedLimits: body.requestedLimits,
          clientName: body.clientName,
          clientVersion: body.clientVersion,
          clientKind: body.clientKind,
          profileLabel: body.profileLabel,
          grantName: body.grantName,
          ipAddress: clientIp,
          userAgent: readRequestUserAgent(request),
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          deviceCode: result.deviceCode,
          approvalUrl: result.approvalUrl,
          expiresAt: result.expiresAt.toISOString(),
          pollIntervalSec: result.pollIntervalSec,
        });
      } catch (error) {
        return handleAgentError(error, reply);
      }
    },
  );

  r.post(
    "/agent/device/token",
    {
      preHandler: requireAgentAuthEnabled,
      schema: { body: agentDeviceTokenBodySchema },
    },
    async (request, reply) => {
      const clientIp = await enforceAgentRateLimit(
        request,
        reply,
        "device-token",
        120,
        60_000,
      );
      if (!clientIp) return;

      try {
        const result = await AgentAuthService.pollDeviceToken(
          request.body.deviceCode,
        );
        reply.header("Content-Type", "application/json; charset=utf-8");
        if (!result.ok) return reply.send(result);
        return reply.send({
          ok: true,
          token: result.token,
          tokenType: "Bearer",
          grant: result.grant,
          expiresAt: result.expiresAt,
        });
      } catch (error) {
        return handleAgentError(error, reply);
      }
    },
  );

  r.get(
    "/agent/device/approval/:approvalToken",
    {
      preHandler: [requireAgentAuthEnabled, browserAuth],
      schema: { params: agentApprovalTokenParamsSchema },
    },
    async (request, reply) => {
      const auth = await AgentAuthService.getApprovalByToken(
        request.params.approvalToken,
      );
      if (!auth) {
        reply.code(404);
        return reply.send({ error: "authorization_not_found" });
      }
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        authorization: {
          id: auth.id,
          status: auth.status,
          requestedScopes: auth.requestedScopes,
          requestedWalletAddresses: auth.requestedWalletAddresses,
          requestedVenues: auth.requestedVenues,
          requestedLimits: auth.requestedLimits,
          clientName: auth.clientName,
          clientVersion: auth.clientVersion,
          clientKind: auth.clientKind,
          expiresAt: auth.expiresAt.toISOString(),
        },
      });
    },
  );

  r.post(
    "/agent/device/approve",
    {
      preHandler: [requireAgentAuthEnabled, browserAuth],
      schema: { body: agentApproveBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      const clientIp = await enforceAgentRateLimit(
        request,
        reply,
        "device-approve",
        30,
        60_000,
      );
      if (!clientIp) return;

      try {
        const body = request.body;
        await AgentAuthService.approveDeviceAuthorization({
          approvalToken: body.approvalToken,
          userId: user.id,
          scopes: body.scopes,
          walletAddresses: body.walletAddresses,
          venues: body.venues,
          limits: body.limits,
          expiresInDays: body.expiresInDays,
          grantName: body.grantName,
          ipAddress: clientIp,
          userAgent: readRequestUserAgent(request),
        });
        return reply.send({ ok: true, status: "approved" });
      } catch (error) {
        return handleAgentError(error, reply);
      }
    },
  );

  r.post(
    "/agent/device/deny",
    {
      preHandler: [requireAgentAuthEnabled, browserAuth],
      schema: { body: agentDenyBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      const clientIp = await enforceAgentRateLimit(
        request,
        reply,
        "device-deny",
        30,
        60_000,
      );
      if (!clientIp) return;

      try {
        await AgentAuthService.denyDeviceAuthorization({
          approvalToken: request.body.approvalToken,
          userId: user.id,
          ipAddress: clientIp,
          userAgent: readRequestUserAgent(request),
        });
        return reply.send({ ok: true, status: "denied" });
      } catch (error) {
        return handleAgentError(error, reply);
      }
    },
  );

  r.get(
    "/agent/grants",
    { preHandler: [requireAgentAuthEnabled, browserAuth] },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      const grants = await AgentAuthService.listGrants(user.id);
      return reply.send({
        ok: true,
        items: grants.map(summarizeAgentGrant),
      });
    },
  );

  r.delete(
    "/agent/grants/:id",
    {
      preHandler: [requireAgentAuthEnabled, browserAuth],
      schema: { params: agentGrantParamsSchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      const revoked = await AgentAuthService.revokeGrant({
        userId: user.id,
        grantId: request.params.id,
        userAgent: readRequestUserAgent(request),
      });
      if (!revoked) {
        reply.code(404);
        return reply.send({ error: "Grant not found" });
      }
      return reply.send({ ok: true, revoked: true });
    },
  );

  r.get(
    "/agent/audit",
    {
      preHandler: [requireAgentAuthEnabled, browserAuth],
      schema: { querystring: agentAuditQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }
      const items = await AgentAuthService.listAuditEvents(
        user.id,
        request.query.limit,
      );
      return reply.send({ ok: true, items });
    },
  );

  r.get(
    "/agent/me",
    { preHandler: agentAccountAuth },
    async (request, reply) => {
      const user = request.user;
      const grant = request.agentGrant;
      if (!user || !grant) {
        reply.code(401);
        return reply.send({ error: "agent_auth_required" });
      }
      return reply.send({
        ok: true,
        user: {
          id: user.id,
          email: user.email ?? null,
        },
        grant: summarizeAgentGrant(grant),
      });
    },
  );

  r.get(
    "/agent/notifications",
    {
      preHandler: agentNotificationsAuth,
      schema: { querystring: notificationsQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "agent_auth_required" });
      }
      const query = request.query;
      const result = await fetchNotifications(pool, {
        userId: user.id,
        limit: query.limit,
        cursor: query.cursor,
        unreadOnly: query.unreadOnly ?? false,
      });

      return reply.send({
        ok: true,
        items: result.rows.map((row) => ({
          id: row.id,
          type: row.type,
          title: row.title,
          body: row.body,
          severity: row.severity,
          data: row.data ?? null,
          readAt: row.read_at ? row.read_at.toISOString() : null,
          createdAt: row.created_at.toISOString(),
        })),
        nextCursor: result.nextCursor,
      });
    },
  );

  r.get(
    "/agent/wallets",
    { preHandler: agentWalletsAuth },
    async (request, reply) => {
      const user = request.user;
      const grant = request.agentGrant;
      if (!user || !grant) {
        reply.code(401);
        return reply.send({ error: "agent_auth_required" });
      }
      const wallets = await loadApprovedLinkedWallets({
        userId: user.id,
        grant,
      });
      const metadataByKey = await loadAgentWalletMetadataByKey({
        user,
        wallets,
        log: app.log,
      });
      const payloads = wallets.map((linkedWallet) => {
        const metadata =
          metadataByKey.get(walletMetadataKey(linkedWallet) ?? "") ?? null;
        return {
          ...(metadata ?? {
            id: linkedWallet.id,
            walletAddress: linkedWallet.walletAddress,
            walletType: linkedWallet.walletType,
            walletSource: "unknown",
            isEmbeddedWallet: false,
            isSmartWallet: false,
            isInternalWallet: false,
            name: linkedWallet.name,
            isPrimary: linkedWallet.isPrimary,
            isVerified: linkedWallet.isVerified,
            createdAt: linkedWallet.createdAt.toISOString(),
            updatedAt: linkedWallet.updatedAt.toISOString(),
          }),
          displayName: metadata?.name ?? linkedWallet.name ?? null,
          venues: venuesForWallet(linkedWallet),
        };
      });
      return reply.send({ ok: true, items: payloads });
    },
  );

  r.get(
    "/agent/wallet-balances",
    {
      preHandler: agentWalletsAuth,
      schema: { querystring: agentWalletBalancesQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const grant = request.agentGrant;
      if (!user || !grant) {
        reply.code(401);
        return reply.send({ error: "agent_auth_required" });
      }
      const query = request.query;
      if (!query.tokens?.length && !query.chains?.length) {
        reply.code(400);
        return reply.send({ error: "tokens or chains must be provided" });
      }
      try {
        const wallets = await resolveAgentWallets({
          userId: user.id,
          grant,
          walletAddress: query.walletAddress,
          wallets: query.wallets,
        });
        const results = await Promise.all(
          wallets.map(async (wallet) => {
            try {
              const resolved = await resolveWalletBalancesForWalletWithInflight(
                {
                  walletAddress: wallet.walletAddress,
                  walletType: wallet.walletType,
                  tokens: query.tokens ?? [],
                  chains: query.chains ?? [],
                },
              );
              return {
                walletAddress: wallet.walletAddress,
                walletType: wallet.walletType,
                balances: resolved.balances,
                warnings: resolved.warnings,
              };
            } catch (error) {
              app.log.warn(
                { error, userId: user.id, walletAddress: wallet.walletAddress },
                "Agent wallet balance lookup failed",
              );
              return {
                walletAddress: wallet.walletAddress,
                walletType: wallet.walletType,
                balances: [] as WalletBalanceItem[],
                warnings: [] as string[],
                error: "Balance lookup failed",
              };
            }
          }),
        );
        return reply.send({ ok: true, wallets: results });
      } catch (error) {
        return handleAgentError(error, reply);
      }
    },
  );

  r.get(
    "/agent/positions",
    {
      preHandler: agentPositionsAuth,
      schema: { querystring: positionsQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const grant = request.agentGrant;
      if (!user || !grant) {
        reply.code(401);
        return reply.send({ error: "agent_auth_required" });
      }
      const query = request.query;
      try {
        const wallets = await resolveAgentWallets({
          userId: user.id,
          grant,
          wallets: query.wallets,
        });
        const walletAddresses = wallets.map((wallet) => wallet.walletAddress);
        if (walletAddresses.length === 0) {
          return reply.send({ ok: true, positions: [] });
        }
        const tokenIds = await resolveTokenIdsForFilter(
          query.marketId,
          query.eventId,
        );
        const effectiveMinSize = query.minSize ?? MIN_POSITION_SIZE;
        const positions =
          tokenIds != null
            ? tokenIds.length === 0
              ? []
              : await fetchPositionsForUserWalletByTokenIds(pool, {
                  userId: user.id,
                  walletAddresses,
                  tokenIds,
                  venue: query.venue,
                  venues: query.venues,
                  includeHidden: query.includeHidden,
                  minSize: effectiveMinSize,
                })
            : await fetchPositionsForUserWallet(pool, {
                userId: user.id,
                walletAddresses,
                venue: query.venue,
                venues: query.venues,
                includeHidden: query.includeHidden,
                minSize: effectiveMinSize,
              });
        if (positions.length) {
          void markHotTokens({
            tokenIds: positions.map((position) => position.tokenId),
          });
        }
        return reply.send({ ok: true, positions });
      } catch (error) {
        return handleAgentError(error, reply);
      }
    },
  );

  r.get(
    "/agent/positions/pnl",
    {
      preHandler: agentPositionsAuth,
      schema: { querystring: positionsPnlSummaryQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const grant = request.agentGrant;
      if (!user || !grant) {
        reply.code(401);
        return reply.send({ error: "agent_auth_required" });
      }
      const query = request.query;
      try {
        const wallets = await resolveAgentWallets({
          userId: user.id,
          grant,
          wallets: query.wallets,
        });
        if (wallets.length === 0) {
          return reply.send({
            ok: true,
            summary: {
              openPositionsCount: 0,
              positionsCount: 0,
              realizedPnlAllTime: 0,
              unrealizedCostBasisCurrent: 0,
              unrealizedPnlCurrent: 0,
              unrealizedPnlPercentCurrent: null,
            },
          });
        }
        const summary = await fetchPositionPnlSummaryForUserWallet(pool, {
          userId: user.id,
          walletAddresses: wallets.map((wallet) => wallet.walletAddress),
          venue: query.venue,
          venues: query.venues,
        });
        return reply.send({ ok: true, summary });
      } catch (error) {
        return handleAgentError(error, reply);
      }
    },
  );

  r.get(
    "/agent/orders",
    {
      preHandler: agentOrdersAuth,
      schema: { querystring: agentOrdersQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const grant = request.agentGrant;
      if (!user || !grant) {
        reply.code(401);
        return reply.send({ error: "agent_auth_required" });
      }
      const query = request.query;
      try {
        const wallets = await resolveAgentWallets({
          userId: user.id,
          grant,
          wallets: query.wallets,
        });
        const walletAddresses = wallets.map((wallet) => wallet.walletAddress);
        if (walletAddresses.length === 0) {
          return reply.send({
            ok: true,
            orders: [],
            pagination: {
              total: 0,
              limit: query.limit,
              offset: query.offset,
              hasMore: false,
            },
          });
        }
        const marketIds =
          query.marketId || !query.eventId
            ? []
            : await resolveMarketIds(query.eventId);
        if (query.eventId && !query.marketId && marketIds.length === 0) {
          return reply.send({
            ok: true,
            orders: [],
            pagination: {
              total: 0,
              limit: query.limit,
              offset: query.offset,
              hasMore: false,
            },
          });
        }
        const result = await fetchUnifiedOrders(pool, {
          userId: user.id,
          walletAddresses,
          venue: query.venue,
          marketId: query.marketId,
          marketIds: marketIds.length ? marketIds : undefined,
          tokenId: query.tokenId,
          status: query.openOnly ? OPEN_ORDER_STATUSES : query.status,
          openOnly: query.openOnly,
          type: query.openOnly ? "order" : query.type,
          limit: query.limit,
          offset: query.offset,
        });
        return reply.send({
          ok: true,
          orders: result.rows.map(mapUnifiedOrder),
          pagination: {
            total: result.total,
            limit: query.limit,
            offset: query.offset,
            hasMore: query.offset + query.limit < result.total,
          },
        });
      } catch (error) {
        return handleAgentError(error, reply);
      }
    },
  );

  r.get(
    "/agent/orders/:id",
    {
      preHandler: agentOrdersAuth,
      schema: { params: orderIdParamsSchema, querystring: orderIdQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const grant = request.agentGrant;
      if (!user || !grant) {
        reply.code(401);
        return reply.send({ error: "agent_auth_required" });
      }
      try {
        const wallets = await resolveAgentWallets({
          userId: user.id,
          grant,
          wallets: request.query.wallets,
        });
        if (wallets.length === 0) {
          reply.code(404);
          return reply.send({ error: "Order not found" });
        }
        const row = await fetchUnifiedOrderById(pool, {
          userId: user.id,
          walletAddresses: wallets.map((wallet) => wallet.walletAddress),
          id: request.params.id,
        });
        if (!row) {
          reply.code(404);
          return reply.send({ error: "Order not found" });
        }
        return reply.send({ ok: true, order: mapUnifiedOrder(row) });
      } catch (error) {
        return handleAgentError(error, reply);
      }
    },
  );

  r.get(
    "/agent/venue-status",
    {
      preHandler: agentFundingAuth,
      schema: { querystring: agentVenueStatusQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const grant = request.agentGrant;
      if (!user || !grant) {
        reply.code(401);
        return reply.send({ error: "agent_auth_required" });
      }
      const query = request.query;
      try {
        const wallets = await resolveAgentWallets({
          userId: user.id,
          grant,
          walletAddress: query.walletAddress,
          wallets: query.wallets,
        });
        const metadataByKey = await loadAgentWalletMetadataByKey({
          user,
          wallets,
          log: app.log,
        });
        const results = await Promise.all(
          wallets.map((wallet) =>
            resolveAgentVenueStatusForWallet({
              userId: user.id,
              userKalshiProofBypass: user.kalshiProofBypass,
              wallet,
              walletMetadata:
                metadataByKey.get(walletMetadataKey(wallet) ?? "") ?? null,
              refresh: query.refresh ?? false,
              log: app.log,
            }),
          ),
        );
        return reply.send({ ok: true, wallets: results });
      } catch (error) {
        return handleAgentError(error, reply);
      }
    },
  );

  r.get(
    "/agent/readiness",
    {
      preHandler: agentFundingAuth,
      schema: { querystring: agentReadinessQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const grant = request.agentGrant;
      if (!user || !grant) {
        reply.code(401);
        return reply.send({ error: "agent_auth_required" });
      }
      const query = request.query;
      try {
        const wallets = await resolveAgentWallets({
          userId: user.id,
          grant,
          walletAddress: query.walletAddress,
          wallets: query.wallets,
        });
        const marketBlockers = await loadMarketReadinessBlockers({
          marketId: query.marketId,
          eventId: query.eventId,
          venue: query.venue,
        });
        const metadataByKey = await loadAgentWalletMetadataByKey({
          user,
          wallets,
          log: app.log,
        });
        const statusRows = await Promise.all(
          wallets.map((wallet) =>
            resolveAgentVenueStatusForWallet({
              userId: user.id,
              userKalshiProofBypass: user.kalshiProofBypass,
              wallet,
              walletMetadata:
                metadataByKey.get(walletMetadataKey(wallet) ?? "") ?? null,
              refresh: query.refresh ?? false,
              log: app.log,
            }),
          ),
        );
        const requestedVenue = query.venue;
        const readiness = statusRows.map((row) => {
          const walletAddress = String(row.walletAddress ?? "");
          const walletType = String(row.walletType ?? "");
          const venueNames: AgentWalletVenue[] = requestedVenue
            ? [requestedVenue]
            : ["polymarket", "limitless", "kalshi"];
          return {
            walletAddress,
            walletType,
            venues: venueNames.map((venue) => {
              const venueStatus = (row[venue] ?? {}) as Record<string, unknown>;
              const blockers = [
                ...mapVenueReasonsToBlockers(venueStatus),
                ...marketBlockers,
              ];
              const uniqueBlockers = Array.from(new Set(blockers));
              const supported = venueStatus.supported !== false;
              return {
                venue,
                supported,
                ready: supported && uniqueBlockers.length === 0,
                blockers: uniqueBlockers,
                warnings: [] as string[],
                notes: Array.isArray(venueStatus.notes)
                  ? venueStatus.notes.filter(
                      (note): note is string => typeof note === "string",
                    )
                  : [],
                sponsorship:
                  typeof venueStatus.feeSponsorship === "object" &&
                  venueStatus.feeSponsorship != null
                    ? venueStatus.feeSponsorship
                    : null,
                walletAddress,
                walletType,
                walletSource: row.walletSource ?? "unknown",
                isInternalWallet: row.isInternalWallet === true,
                chainId:
                  venue === "kalshi"
                    ? "7565164"
                    : venue === "limitless"
                      ? "8453"
                      : "137",
                account: {
                  hasCredentials:
                    typeof venueStatus.hasCredentials === "boolean"
                      ? venueStatus.hasCredentials
                      : undefined,
                  credentialsValid:
                    venueStatus.hasCredentials === false
                      ? false
                      : venueStatus.hasCredentials === true
                        ? true
                        : null,
                  verificationRequired:
                    venueStatus.proofRequiredForBuy === true,
                  verificationStatus:
                    venueStatus.proofReason === "required"
                      ? "required"
                      : venueStatus.proofReason === "unavailable"
                        ? "unavailable"
                        : venueStatus.proofReason === "disabled"
                          ? "disabled"
                          : venueStatus.proofReason === "bypassed"
                            ? "bypassed"
                            : venueStatus.proofVerified === true
                              ? "verified"
                              : undefined,
                },
                balances:
                  venue === "polymarket"
                    ? buildPolymarketReadinessBalances({
                        walletAddress,
                        venueStatus,
                      })
                    : [
                        venue === "limitless"
                          ? baseBalance(
                              "8453",
                              env.limitlessUsdcAddress,
                              "USDC",
                              (
                                venueStatus.usdc as
                                  | Record<string, string>
                                  | undefined
                              )?.balance,
                              (
                                venueStatus.usdc as
                                  | Record<string, string>
                                  | undefined
                              )?.balanceRaw,
                              6,
                              {
                                ownerRole: "wallet",
                                ownerAddress: walletAddress,
                              },
                            )
                          : baseBalance(
                              "7565164",
                              env.solanaUsdcMint,
                              "USDC",
                              (
                                venueStatus.usdc as
                                  | Record<string, string>
                                  | undefined
                              )?.balance,
                              (
                                venueStatus.usdc as
                                  | Record<string, string>
                                  | undefined
                              )?.balanceRaw,
                              6,
                              {
                                ownerRole: "wallet",
                                ownerAddress: walletAddress,
                              },
                            ),
                      ].filter(
                        (
                          item,
                        ): item is WalletBalanceItem & {
                          ownerRole?: "signer" | "funder" | "wallet";
                          ownerAddress?: string;
                        } => Boolean(item),
                      ),
                nextActions: buildReadinessNextActions({
                  blockers: uniqueBlockers,
                  venue,
                  walletAddress,
                  venueStatus,
                }),
              };
            }),
          };
        });
        return reply.send({ ok: true, wallets: readiness });
      } catch (error) {
        return handleAgentError(error, reply);
      }
    },
  );

  r.get(
    "/agent/deposit-targets",
    {
      preHandler: agentFundingAuth,
      schema: { querystring: agentDepositTargetsQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const grant = request.agentGrant;
      if (!user || !grant) {
        reply.code(401);
        return reply.send({ error: "agent_auth_required" });
      }
      const query = request.query;
      try {
        const wallets = await resolveAgentWallets({
          userId: user.id,
          grant,
          walletAddress: query.walletAddress,
          wallets: query.wallets,
        });
        const requestedVenue = query.venue;
        const items = (
          await Promise.all(
            wallets.flatMap((wallet) => {
              const walletType = inferWalletType(wallet);
              const venues =
                requestedVenue != null
                  ? [requestedVenue]
                  : venuesForWallet(wallet);
              return venues.flatMap((venue) => {
                if (venue === "kalshi" && walletType !== "solana") return null;
                if (venue !== "kalshi" && walletType !== "ethereum")
                  return null;
                return filterDepositAssets(venue, query.asset).map(
                  async (asset) => {
                    let targetAddress = wallet.walletAddress;
                    let targetKind: "trading_wallet" | "venue_funder" =
                      "trading_wallet";
                    if (venue === "polymarket") {
                      const creds = await AuthService.getVenueCredentialsInfo(
                        user.id,
                        "polymarket",
                        wallet.walletAddress,
                      );
                      if (creds?.funderAddress) {
                        targetAddress = creds.funderAddress;
                        targetKind = "venue_funder";
                      }
                    }
                    return {
                      venue,
                      walletAddress: wallet.walletAddress,
                      walletType,
                      targetAddress,
                      targetKind,
                      chainId: asset.chainId,
                      chainName: asset.chainName,
                      asset: {
                        id: asset.id,
                        symbol: asset.symbol,
                        name: asset.name,
                        address: asset.address,
                        mint: asset.mint,
                        decimals: asset.decimals,
                        isNative: asset.isNative,
                        preferred: asset.preferred,
                        purpose: asset.purpose,
                      },
                      depositUri: null,
                      qrPayload: targetAddress,
                      depositPageUrl: buildDepositPageUrl({
                        venue,
                        targetAddress,
                        asset,
                      }),
                      warnings:
                        asset.purpose === "convertible"
                          ? [
                              "This asset may need conversion before it can be used as venue collateral.",
                            ]
                          : [],
                    };
                  },
                );
              });
            }),
          )
        ).filter((item): item is NonNullable<typeof item> => Boolean(item));
        return reply.send({
          ok: true,
          items,
          warnings:
            query.asset && items.length === 0
              ? [`No deposit target supports asset '${query.asset}'.`]
              : [],
        });
      } catch (error) {
        return handleAgentError(error, reply);
      }
    },
  );
};
