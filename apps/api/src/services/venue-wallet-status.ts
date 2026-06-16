import { AuthService, type User } from "../auth.js";
import { env } from "../env.js";
import { addLockedCollateralFields } from "./locked-balance.js";
import { verifyProofAddress, type ProofVerifyResult } from "./proof-client.js";
import {
  fetchSolanaBalanceLamports,
  fetchSolanaTokenBalanceByOwnerAndMint,
  formatUiAmount,
} from "./solana-rpc.js";

export const POLYGON_CHAIN_ID = "137";
export const BASE_CHAIN_ID = "8453";
export const SOLANA_CHAIN_ID = "7565164";
export const SOLANA_NATIVE_ADDRESS = "11111111111111111111111111111111";
export const SOLANA_DECIMALS = 9;
export const KALSHI_LOW_SOL_BUFFER_LAMPORTS = 2_000_000n;

export type VenueTokenBalanceStatus = {
  tokenAddress?: string | null;
  mint?: string | null;
  decimals?: number | null;
  symbol?: string | null;
  balance?: string | null;
  balanceRaw?: string | null;
  locked?: string | null;
  lockedRaw?: string | null;
  availableAfterLocked?: string | null;
  availableAfterLockedRaw?: string | null;
};

export type KalshiProofReason =
  | "required"
  | "unavailable"
  | "disabled"
  | "bypassed";

export type KalshiVenueWalletStatus = {
  supported: true;
  ready: boolean;
  reasons: string[];
  hasCredentials: boolean;
  proofVerified: boolean;
  proofRequiredForBuy: boolean;
  proofBypass: "none" | "user";
  proofReason?: KalshiProofReason;
  sol: VenueTokenBalanceStatus;
  usdc: VenueTokenBalanceStatus;
};

export type VenueWalletStatus = {
  walletAddress: string;
  walletType: string;
  polymarket?: {
    hasCredentials?: boolean;
    funder?: string | null;
    pusd?: VenueTokenBalanceStatus | null;
    usdc?: VenueTokenBalanceStatus | null;
  } | null;
  limitless?: {
    hasCredentials?: boolean;
    usdc?: VenueTokenBalanceStatus | null;
  } | null;
  kalshi?: (Partial<KalshiVenueWalletStatus> & { hasCredentials?: boolean }) | null;
};

export type KalshiAccountBalances = {
  solLamports: bigint;
  usdcAmount: bigint;
  usdcDecimals: number;
};

type VenueCredentialsInfo = Awaited<
  ReturnType<typeof AuthService.getVenueCredentialsInfo>
>;

type BuildKalshiVenueStatusDeps = {
  getUserById?: (userId: string) => Promise<Pick<User, "kalshiProofBypass"> | null>;
  getVenueCredentialsInfo?: (
    userId: string,
    venue: "kalshi",
    walletAddress: string,
  ) => Promise<VenueCredentialsInfo | null>;
  fetchKalshiAccountBalances?: (inputs: {
    walletAddress: string;
    usdcMint?: string;
  }) => Promise<KalshiAccountBalances>;
  verifyProofAddress?: (args: {
    address: string;
    forceRefresh?: boolean;
  }) => Promise<ProofVerifyResult>;
  kalshiProofEnabled?: boolean;
  solanaUsdcMint?: string;
};

export async function fetchKalshiAccountBalances(input: {
  walletAddress: string;
  usdcMint?: string;
}): Promise<KalshiAccountBalances> {
  const usdcMint = input.usdcMint ?? env.solanaUsdcMint;
  const [solLamports, usdc] = await Promise.all([
    fetchSolanaBalanceLamports({
      rpcUrls: env.solanaRpcUrls,
      timeoutMs: env.solanaRpcTimeoutMs,
      owner: input.walletAddress,
    }),
    fetchSolanaTokenBalanceByOwnerAndMint({
      rpcUrls: env.solanaRpcUrls,
      timeoutMs: env.solanaRpcTimeoutMs,
      owner: input.walletAddress,
      mint: usdcMint,
    }),
  ]);

  return {
    solLamports,
    usdcAmount: usdc?.amount ?? 0n,
    usdcDecimals: usdc?.decimals ?? 6,
  };
}

export async function buildKalshiVenueStatus(
  input: {
    userId: string;
    walletAddress: string;
    user?: Pick<User, "kalshiProofBypass"> | null;
    refresh?: boolean;
  },
  deps: BuildKalshiVenueStatusDeps = {},
): Promise<KalshiVenueWalletStatus> {
  const getUserById =
    deps.getUserById ??
    ((userId: string) => AuthService.getUserById(userId));
  const getVenueCredentialsInfo =
    deps.getVenueCredentialsInfo ??
    ((userId: string, venue: "kalshi", walletAddress: string) =>
      AuthService.getVenueCredentialsInfo(userId, venue, walletAddress));
  const fetchBalances =
    deps.fetchKalshiAccountBalances ?? fetchKalshiAccountBalances;
  const verifyProof = deps.verifyProofAddress ?? verifyProofAddress;
  const kalshiProofEnabled =
    deps.kalshiProofEnabled ?? env.kalshiProofEnabled;
  const solanaUsdcMint = deps.solanaUsdcMint ?? env.solanaUsdcMint;

  const [user, creds, balances] = await Promise.all([
    input.user === undefined
      ? getUserById(input.userId)
      : Promise.resolve(input.user),
    getVenueCredentialsInfo(input.userId, "kalshi", input.walletAddress),
    fetchBalances({
      walletAddress: input.walletAddress,
      usdcMint: solanaUsdcMint,
    }),
  ]);

  const reasons: string[] = [];
  if (balances.solLamports < KALSHI_LOW_SOL_BUFFER_LAMPORTS) {
    reasons.push("low_sol_balance");
  }
  if (balances.usdcAmount <= 0n) reasons.push("insufficient_usdc");

  const proofBypass = user?.kalshiProofBypass ? "user" : "none";
  let proofVerified = false;
  let proofRequiredForBuy = false;
  let proofReason: KalshiProofReason | undefined;

  if (!kalshiProofEnabled) {
    proofReason = "disabled";
  } else if (proofBypass !== "none") {
    proofReason = "bypassed";
  } else {
    const proofCheck = await verifyProof({
      address: input.walletAddress,
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

  const sol = addLockedCollateralFields(
    {
      tokenAddress: SOLANA_NATIVE_ADDRESS,
      decimals: SOLANA_DECIMALS,
      symbol: "SOL",
      balance: formatUiAmount(balances.solLamports, SOLANA_DECIMALS),
      balanceRaw: balances.solLamports.toString(),
    },
    0n,
  );
  const usdc = addLockedCollateralFields(
    {
      tokenAddress: solanaUsdcMint,
      mint: solanaUsdcMint,
      decimals: balances.usdcDecimals,
      symbol: "USDC",
      balance: formatUiAmount(balances.usdcAmount, balances.usdcDecimals),
      balanceRaw: balances.usdcAmount.toString(),
    },
    0n,
  );

  return {
    supported: true,
    ready: reasons.length === 0,
    reasons,
    hasCredentials: Boolean(creds),
    proofVerified,
    proofRequiredForBuy,
    proofBypass,
    ...(proofReason ? { proofReason } : {}),
    sol,
    usdc,
  };
}
