import { tx, type Pool } from "@hunch/infra";
import type { PoolClient } from "pg";
import { AuthService, type UserWallet } from "../auth.js";
import { acquireRewardsUserAdvisoryXactLock } from "../lib/rewards-user-lock.js";
import {
  parseUsdcToMicro,
  usdcDecimalStringHasValidScale,
  usdcMicroToDecimalString,
} from "../lib/usdc.js";
import {
  createRewardClaim,
  getRewardsClaimableByChainMicro,
} from "./rewards.js";

export type CreateRewardsClaimInput = {
  userId: string;
  fallbackWalletAddress?: string | null;
  walletAddress?: string | null;
  chainId: string;
  amount?: string | null;
};

export type CreatedRewardsClaim = {
  claimId: string;
  amountUsd: string;
  walletAddress: string;
  chainId: string;
};

function errorWithStatus(message: string, statusCode = 400): Error {
  const error = new Error(message);
  (error as Error & { statusCode?: number }).statusCode = statusCode;
  return error;
}

function validateRewardsClaimWallet(
  wallet: UserWallet,
  chainId: string,
): void {
  const walletType = wallet.walletType?.toLowerCase() ?? "";
  const isSolanaChain = chainId === "solana";
  if (isSolanaChain && walletType !== "solana") {
    throw errorWithStatus("Solana payouts require a Solana wallet");
  }
  if (!isSolanaChain && walletType === "solana") {
    throw errorWithStatus("EVM payouts require an EVM wallet");
  }
}

async function createRewardsClaimInTx(
  client: PoolClient,
  input: {
    userId: string;
    walletAddress: string;
    chainId: string;
    amount?: string | null;
  },
): Promise<CreatedRewardsClaim> {
  await acquireRewardsUserAdvisoryXactLock(client, input.userId);

  const claimableByChain = await getRewardsClaimableByChainMicro(client, {
    userId: input.userId,
  });
  const claimableMicro = claimableByChain[input.chainId] ?? 0n;
  if (claimableMicro <= 0n) {
    throw errorWithStatus("No claimable cashback available");
  }

  if (input.amount && !usdcDecimalStringHasValidScale(input.amount)) {
    throw errorWithStatus("Claim amount supports up to 6 decimals");
  }

  const requestedAmountMicro = input.amount
    ? parseUsdcToMicro(input.amount)
    : claimableMicro;
  if (!requestedAmountMicro || requestedAmountMicro <= 0n) {
    throw errorWithStatus("Invalid claim amount");
  }

  if (requestedAmountMicro > claimableMicro) {
    throw errorWithStatus("Claim amount exceeds claimable balance");
  }

  const amountUsd = usdcMicroToDecimalString(requestedAmountMicro);
  const claim = await createRewardClaim(client, {
    userId: input.userId,
    walletAddress: input.walletAddress,
    chainId: input.chainId,
    amountUsd,
  });

  return {
    claimId: claim.claimId,
    amountUsd,
    walletAddress: input.walletAddress,
    chainId: input.chainId,
  };
}

export async function createRewardsClaimForUser(
  pool: Pool,
  input: CreateRewardsClaimInput,
): Promise<CreatedRewardsClaim> {
  const targetWallet =
    input.walletAddress?.trim() || input.fallbackWalletAddress?.trim();
  if (!targetWallet) {
    throw errorWithStatus("Missing wallet address");
  }

  const wallet = await AuthService.getUserWalletByAddress(
    input.userId,
    targetWallet,
  );
  if (!wallet) {
    throw errorWithStatus("Wallet is not linked to this user", 403);
  }
  validateRewardsClaimWallet(wallet, input.chainId);

  return tx(pool, (client) =>
    createRewardsClaimInTx(client, {
      userId: input.userId,
      walletAddress: targetWallet,
      chainId: input.chainId,
      amount: input.amount,
    }),
  );
}
