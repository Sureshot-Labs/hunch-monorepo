#!/usr/bin/env tsx

import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { ethers } from "ethers";
import { pathToFileURL } from "node:url";
import { pool } from "./db.js";
import { env } from "./env.js";
import { normalizeRewardsChainId } from "./lib/rewards-chain.js";
import { withRewardsChainLocks } from "./lib/rewards-locks.js";
import { usdcDecimalStringHasValidScale } from "./lib/usdc.js";
import {
  buildRewardNotification,
  createNotificationSafe,
} from "./services/notifications.js";
import {
  fetchSolanaSignatureStatus,
  waitForSolanaSignatureConfirmation,
} from "./services/solana-rpc.js";

type ClaimRow = {
  id: string;
  user_id: string;
  wallet_address: string;
  chain_id: string;
  amount_usdc: string;
  status: string;
  tx_hash: string | null;
  created_at: Date;
};

async function notifyClaimStatus(
  claim: ClaimRow,
  status: "submitted" | "confirmed" | "failed",
) {
  const amountUsd = Number(claim.amount_usdc);
  if (!Number.isFinite(amountUsd)) return;
  await createNotificationSafe(
    pool,
    buildRewardNotification({
      userId: claim.user_id,
      status,
      amountUsd,
      chainId: claim.chain_id,
      claimId: claim.id,
      walletAddress: claim.wallet_address,
    }),
  );
}

export type RewardsPayoutOptions = {
  dryRun: boolean;
  limit: number;
  chainId?: string;
  confirmOnly: boolean;
  sendOnly: boolean;
  failPending: boolean;
};

type EvmChainConfig = {
  chainId: string;
  name: string;
  kind: "evm";
  rpcUrl: string;
  usdcAddress: string;
  decimals: number;
};

type SolanaChainConfig = {
  chainId: string;
  name: string;
  kind: "solana";
  rpcUrl: string;
  usdcMint: string;
  decimals: number;
};

type ChainConfig = EvmChainConfig | SolanaChainConfig;

const DEFAULT_LIMIT = 25;
const STALE_SUBMITTED_NO_TX_MIN_AGE_SEC = 300;

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
];

const POLYMARKET_COLLATERAL_ONRAMP_ABI = [
  "function wrap(address asset, address to, uint256 amount)",
];

export function parseRewardsPayoutArgs(
  args: string[] = process.argv.slice(2),
): RewardsPayoutOptions {
  const getValue = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx === -1) return undefined;
    const next = args[idx + 1];
    return next && !next.startsWith("--") ? next : undefined;
  };
  const hasFlag = (flag: string): boolean => args.includes(flag);

  const limitRaw = getValue("--limit");
  const chainRaw = getValue("--chain");

  const limit = limitRaw ? Math.max(1, Number(limitRaw)) : DEFAULT_LIMIT;

  return {
    dryRun: hasFlag("--dry-run"),
    confirmOnly: hasFlag("--confirm-only"),
    sendOnly: hasFlag("--send-only"),
    failPending: hasFlag("--fail-pending"),
    limit: Number.isFinite(limit) ? Math.trunc(limit) : DEFAULT_LIMIT,
    chainId: chainRaw?.trim(),
  };
}

function resolveChainAlias(chainId: string): string | null {
  return normalizeRewardsChainId(chainId);
}

function buildChainConfigs(): Record<string, ChainConfig> {
  const polygonUsdc =
    env.rewardsPayoutTokenAddressPolygon?.trim() || env.polymarketPusdAddress;
  const baseUsdc = env.rewardsUsdcBase?.trim() || env.limitlessUsdcAddress;

  return {
    "137": {
      chainId: "137",
      name: "polygon",
      kind: "evm",
      rpcUrl: env.polygonRpcUrl,
      usdcAddress: polygonUsdc,
      decimals: 6,
    },
    "8453": {
      chainId: "8453",
      name: "base",
      kind: "evm",
      rpcUrl: env.baseRpcUrl,
      usdcAddress: baseUsdc,
      decimals: 6,
    },
    solana: {
      chainId: "solana",
      name: "solana",
      kind: "solana",
      rpcUrl: env.solanaRpcUrl,
      usdcMint: env.solanaUsdcMint,
      decimals: 6,
    },
  };
}

function parseAmount(value: string, decimals: number): bigint {
  return ethers.parseUnits(value, decimals);
}

function formatAmount(value: bigint, decimals: number): string {
  return ethers.formatUnits(value, decimals);
}

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string") return BigInt(value);
  if (value && typeof value === "object" && "toString" in value) {
    return BigInt(String(value));
  }
  throw new Error("Unable to parse bigint value");
}

function isSameEvmAddress(left: string, right: string): boolean {
  try {
    return ethers.getAddress(left) === ethers.getAddress(right);
  } catch {
    return false;
  }
}

function sumValidClaimAmounts(claims: ClaimRow[], decimals: number): bigint {
  let total = 0n;
  for (const claim of claims) {
    if (!isValidClaimAmount(claim.amount_usdc)) continue;
    const amountRaw = parseAmount(claim.amount_usdc, decimals);
    if (amountRaw > 0n) total += amountRaw;
  }
  return total;
}

function isValidClaimAmount(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (!usdcDecimalStringHasValidScale(trimmed)) return false;
  return Number.isFinite(Number(trimmed));
}

function buildProvider(config: EvmChainConfig): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(config.rpcUrl);
}

function buildSolanaConnection(config: SolanaChainConfig): Connection {
  return new Connection(config.rpcUrl, "confirmed");
}

function loadSolanaKeypair(): Keypair {
  const raw = env.rewardsSolanaSecretKey?.trim();
  if (!raw) {
    throw new Error("Missing HUNCH_REWARDS_SOLANA_SECRET_KEY");
  }
  if (raw.startsWith("[")) {
    const parsed = JSON.parse(raw) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(parsed));
  }
  return Keypair.fromSecretKey(bs58.decode(raw));
}

async function fetchSubmittedClaims(
  chainIds: string[],
  limit: number,
): Promise<ClaimRow[]> {
  const { rows } = await pool.query<ClaimRow>(
    `
      select
        id,
        user_id,
        wallet_address,
        chain_id,
        amount_usdc::text as amount_usdc,
        status,
        tx_hash,
        created_at
      from reward_claims
      where status = 'submitted'
        and tx_hash is not null
        and chain_id = any($1::text[])
      order by created_at asc
      limit $2
    `,
    [chainIds, limit],
  );
  return rows;
}

async function fetchPendingClaims(
  chainIds: string[],
  limit: number,
): Promise<ClaimRow[]> {
  const { rows } = await pool.query<ClaimRow>(
    `
      select
        id,
        user_id,
        wallet_address,
        chain_id,
        amount_usdc::text as amount_usdc,
        status,
        tx_hash,
        created_at
      from reward_claims
      where status = 'pending'
        and chain_id = any($1::text[])
      order by created_at asc
      limit $2
    `,
    [chainIds, limit],
  );
  return rows;
}

async function fetchClaimById(id: string): Promise<ClaimRow | null> {
  const { rows } = await pool.query<ClaimRow>(
    `
      select
        id,
        user_id,
        wallet_address,
        chain_id,
        amount_usdc::text as amount_usdc,
        status,
        tx_hash,
        created_at
      from reward_claims
      where id = $1
      limit 1
    `,
    [id],
  );
  return rows[0] ?? null;
}

async function failPendingClaims(
  chainIds: string[],
  limit: number,
): Promise<ClaimRow[]> {
  const { rows } = await pool.query<ClaimRow>(
    `
      with next as (
        select id
        from reward_claims
        where status = 'pending'
          and chain_id = any($1::text[])
        order by created_at asc
        limit $2
        for update skip locked
      )
      update reward_claims r
      set status = 'failed',
          updated_at = now()
      from next
      where r.id = next.id
      returning
        r.id,
        r.user_id,
        r.wallet_address,
        r.chain_id,
        r.amount_usdc::text as amount_usdc,
        r.status,
        r.tx_hash,
        r.created_at
    `,
    [chainIds, limit],
  );
  return rows;
}

async function reservePendingClaims(
  chainIds: string[],
  limit: number,
): Promise<ClaimRow[]> {
  const { rows } = await pool.query<ClaimRow>(
    `
      with next as (
        select id
        from reward_claims
        where status = 'pending'
          and chain_id = any($1::text[])
        order by created_at asc
        limit $2
        for update skip locked
      )
      update reward_claims r
      set status = 'submitted',
          updated_at = now()
      from next
      where r.id = next.id
      returning
        r.id,
        r.user_id,
        r.wallet_address,
        r.chain_id,
        r.amount_usdc::text as amount_usdc,
        r.status,
        r.tx_hash,
        r.created_at
    `,
    [chainIds, limit],
  );
  return rows;
}

async function fetchStaleSubmittedWithoutTxClaims(
  chainIds: string[],
  limit: number,
  minAgeSec: number,
): Promise<ClaimRow[]> {
  const { rows } = await pool.query<ClaimRow>(
    `
      select
        id,
        user_id,
        wallet_address,
        chain_id,
        amount_usdc::text as amount_usdc,
        status,
        tx_hash,
        created_at
      from reward_claims
      where status = 'submitted'
        and tx_hash is null
        and chain_id = any($1::text[])
        and updated_at <= now() - ($3::int * interval '1 second')
      order by updated_at asc
      limit $2
    `,
    [chainIds, limit, minAgeSec],
  );
  return rows;
}

async function failStaleSubmittedWithoutTxClaims(
  chainIds: string[],
  limit: number,
  minAgeSec: number,
): Promise<ClaimRow[]> {
  const { rows } = await pool.query<ClaimRow>(
    `
      with next as (
        select id
        from reward_claims
        where status = 'submitted'
          and tx_hash is null
          and chain_id = any($1::text[])
          and updated_at <= now() - ($3::int * interval '1 second')
        order by updated_at asc
        limit $2
        for update skip locked
      )
      update reward_claims r
      set status = 'failed',
          updated_at = now()
      from next
      where r.id = next.id
      returning
        r.id,
        r.user_id,
        r.wallet_address,
        r.chain_id,
        r.amount_usdc::text as amount_usdc,
        r.status,
        r.tx_hash,
        r.created_at
    `,
    [chainIds, limit, minAgeSec],
  );
  return rows;
}

async function markClaimStatus(inputs: {
  id: string;
  status: "submitted" | "confirmed" | "failed";
  txHash?: string | null;
}) {
  const { rows } = await pool.query<ClaimRow>(
    `
      update reward_claims
      set status = $2,
          tx_hash = coalesce($3, tx_hash),
          updated_at = now()
      where id = $1
      returning
        id,
        user_id,
        wallet_address,
        chain_id,
        amount_usdc::text as amount_usdc,
        status,
        tx_hash,
        created_at
    `,
    [inputs.id, inputs.status, inputs.txHash ?? null],
  );

  const row = rows[0];
  if (row) {
    await notifyClaimStatus(row, inputs.status);
  }
}

async function confirmEvmClaim(
  claim: ClaimRow,
  provider: ethers.JsonRpcProvider,
) {
  if (!claim.tx_hash) return;
  const receipt = await provider.getTransactionReceipt(claim.tx_hash);
  if (!receipt) return;
  if (receipt.status === 1) {
    await markClaimStatus({ id: claim.id, status: "confirmed" });
    return;
  }
  if (receipt.status === 0) {
    await markClaimStatus({ id: claim.id, status: "failed" });
  }
}

async function confirmSolanaClaim(claim: ClaimRow, connection: Connection) {
  if (!claim.tx_hash) return;
  const status = await connection.getSignatureStatus(claim.tx_hash, {
    searchTransactionHistory: true,
  });
  const value = status.value;
  if (!value) return;
  if (value.err) {
    await markClaimStatus({ id: claim.id, status: "failed" });
    return;
  }
  if (
    value.confirmationStatus === "confirmed" ||
    value.confirmationStatus === "finalized"
  ) {
    await markClaimStatus({ id: claim.id, status: "confirmed" });
  }
}

async function ensurePolygonPayoutLiquidity(
  claims: ClaimRow[],
  config: EvmChainConfig,
  wallet: ethers.Wallet,
) {
  if (config.chainId !== "137") return;
  if (!env.rewardsAutoWrapUsdcePolygon) return;

  const required = sumValidClaimAmounts(claims, config.decimals);
  if (required <= 0n) return;

  if (!isSameEvmAddress(config.usdcAddress, env.polymarketPusdAddress)) {
    throw new Error(
      "Polygon rewards payout token must be pUSD when USDC.e auto-wrap is enabled. Set HUNCH_REWARDS_PAYOUT_TOKEN_ADDRESS_POLYGON to pUSD or disable HUNCH_REWARDS_AUTO_WRAP_USDCE_POLYGON.",
    );
  }

  const onrampAddress = env.polymarketCollateralOnrampAddress.trim();
  const usdceAddress = env.polymarketUsdceAddress.trim();
  if (!ethers.isAddress(onrampAddress)) {
    throw new Error("Invalid POLYMARKET_COLLATERAL_ONRAMP_ADDRESS");
  }
  if (!ethers.isAddress(usdceAddress)) {
    throw new Error("Invalid POLYMARKET_USDCE_ADDRESS");
  }

  const payoutToken = new ethers.Contract(
    config.usdcAddress,
    ERC20_ABI,
    wallet,
  );
  const payoutBalance = toBigInt(await payoutToken.balanceOf(wallet.address));
  if (payoutBalance >= required) return;

  const shortfall = required - payoutBalance;
  const usdceToken = new ethers.Contract(usdceAddress, ERC20_ABI, wallet);
  const usdceBalance = toBigInt(await usdceToken.balanceOf(wallet.address));
  if (usdceBalance < shortfall) {
    throw new Error(
      `Insufficient Polygon rewards liquidity: need ${formatAmount(required, config.decimals)} pUSD, have ${formatAmount(payoutBalance, config.decimals)} pUSD and ${formatAmount(usdceBalance, config.decimals)} USDC.e`,
    );
  }

  const allowance = toBigInt(
    await usdceToken.allowance(wallet.address, onrampAddress),
  );
  if (allowance < shortfall) {
    console.log(
      `Approving ${formatAmount(shortfall, config.decimals)} USDC.e for Polymarket collateral onramp`,
    );
    const approveTx = await usdceToken.approve(onrampAddress, shortfall);
    const approveReceipt = await approveTx.wait();
    if (approveReceipt?.status !== 1) {
      throw new Error(
        "USDC.e approval for Polymarket collateral onramp failed",
      );
    }
  }

  console.log(
    `Wrapping ${formatAmount(shortfall, config.decimals)} USDC.e to pUSD for Polygon rewards payout`,
  );
  const onramp = new ethers.Contract(
    onrampAddress,
    POLYMARKET_COLLATERAL_ONRAMP_ABI,
    wallet,
  );
  const wrapTx = await onramp.wrap(usdceAddress, wallet.address, shortfall);
  const wrapReceipt = await wrapTx.wait();
  if (wrapReceipt?.status !== 1) {
    throw new Error("USDC.e to pUSD wrap failed");
  }

  const refreshedPayoutBalance = toBigInt(
    await payoutToken.balanceOf(wallet.address),
  );
  if (refreshedPayoutBalance < required) {
    throw new Error(
      `Polygon rewards pUSD balance is still insufficient after wrap: need ${formatAmount(required, config.decimals)}, have ${formatAmount(refreshedPayoutBalance, config.decimals)}`,
    );
  }
}

async function sendEvmClaim(
  claim: ClaimRow,
  config: EvmChainConfig,
  wallet: ethers.Wallet,
) {
  if (!isValidClaimAmount(claim.amount_usdc)) {
    await markClaimStatus({ id: claim.id, status: "failed" });
    return;
  }
  const amountRaw = parseAmount(claim.amount_usdc, config.decimals);
  if (amountRaw <= 0n) {
    await markClaimStatus({ id: claim.id, status: "failed" });
    return;
  }

  const token = new ethers.Contract(config.usdcAddress, ERC20_ABI, wallet);
  const tx = await token.transfer(claim.wallet_address, amountRaw);
  await markClaimStatus({ id: claim.id, status: "submitted", txHash: tx.hash });
  const receipt = await tx.wait();
  if (receipt?.status === 1) {
    await markClaimStatus({ id: claim.id, status: "confirmed" });
  } else if (receipt?.status === 0) {
    await markClaimStatus({ id: claim.id, status: "failed" });
  }
}

async function sendSolanaClaim(
  claim: ClaimRow,
  config: SolanaChainConfig,
  connection: Connection,
  keypair: Keypair,
) {
  if (!isValidClaimAmount(claim.amount_usdc)) {
    await markClaimStatus({ id: claim.id, status: "failed" });
    return;
  }
  const amountRaw = parseAmount(claim.amount_usdc, config.decimals);
  if (amountRaw <= 0n) {
    await markClaimStatus({ id: claim.id, status: "failed" });
    return;
  }

  const mint = new PublicKey(config.usdcMint);
  const recipient = new PublicKey(claim.wallet_address);
  const sourceAccount = getAssociatedTokenAddressSync(mint, keypair.publicKey);
  const destinationAccount = getAssociatedTokenAddressSync(mint, recipient);
  const transaction = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      keypair.publicKey,
      sourceAccount,
      keypair.publicKey,
      mint,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      keypair.publicKey,
      destinationAccount,
      recipient,
      mint,
    ),
    createTransferCheckedInstruction(
      sourceAccount,
      mint,
      destinationAccount,
      keypair.publicKey,
      amountRaw,
      config.decimals,
    ),
  );
  const signature = await connection.sendTransaction(transaction, [keypair], {
    preflightCommitment: "confirmed",
    skipPreflight: false,
  });
  await markClaimStatus({
    id: claim.id,
    status: "submitted",
    txHash: signature,
  });

  let confirmation: { status: "fulfilled" | "failed" | "submitted" };
  try {
    confirmation = await waitForSolanaSignatureConfirmation({
      rpcUrls: env.solanaRpcUrls,
      signature,
      timeoutMs: env.solanaRpcTimeoutMs,
      commitment: "confirmed",
    });
  } catch (error) {
    console.warn(
      "Solana claim confirmation check failed after broadcast",
      claim.id,
      signature,
      error instanceof Error ? error.message : error,
    );
    return;
  }

  if (confirmation.status === "failed") {
    await markClaimStatus({ id: claim.id, status: "failed" });
  } else if (confirmation.status !== "fulfilled") {
    await markClaimStatus({ id: claim.id, status: "submitted" });
  } else {
    await markClaimStatus({ id: claim.id, status: "confirmed" });
  }
}

async function markSolanaClaimAfterPayoutError(claim: ClaimRow) {
  const current = await fetchClaimById(claim.id);
  const txHash = current?.tx_hash;
  if (!txHash) {
    await markClaimStatus({ id: claim.id, status: "failed" });
    return;
  }

  let status: { status: "submitted" | "fulfilled" | "failed" } | null = null;
  try {
    status = await fetchSolanaSignatureStatus({
      rpcUrls: env.solanaRpcUrls,
      signature: txHash,
      timeoutMs: env.solanaRpcTimeoutMs,
    });
  } catch (error) {
    console.warn(
      "Solana claim status check failed after payout error",
      claim.id,
      txHash,
      error instanceof Error ? error.message : error,
    );
  }

  if (status?.status === "fulfilled") {
    await markClaimStatus({ id: claim.id, status: "confirmed" });
    return;
  }
  if (status?.status === "failed") {
    await markClaimStatus({ id: claim.id, status: "failed" });
    return;
  }
  if (current?.status !== "submitted") {
    await markClaimStatus({ id: claim.id, status: "submitted", txHash });
  }
}

async function markEvmClaimAfterPayoutError(
  claim: ClaimRow,
  provider: ethers.JsonRpcProvider,
) {
  const current = await fetchClaimById(claim.id);
  const txHash = current?.tx_hash;
  if (!txHash) {
    await markClaimStatus({ id: claim.id, status: "failed" });
    return;
  }

  let receipt: ethers.TransactionReceipt | null = null;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (error) {
    console.warn(
      "EVM claim receipt check failed after payout error",
      claim.id,
      txHash,
      error instanceof Error ? error.message : error,
    );
  }

  if (receipt?.status === 1) {
    await markClaimStatus({ id: claim.id, status: "confirmed" });
    return;
  }
  if (receipt?.status === 0) {
    await markClaimStatus({ id: claim.id, status: "failed" });
    return;
  }
  if (current?.status !== "submitted") {
    await markClaimStatus({ id: claim.id, status: "submitted", txHash });
  }
}

export async function runRewardsPayout(options: RewardsPayoutOptions) {
  const chainConfigs = buildChainConfigs();
  const supportedChains = Object.keys(chainConfigs);
  const chainId = options.chainId ? resolveChainAlias(options.chainId) : null;

  if (options.chainId && !chainId) {
    throw new Error(
      `Unsupported chain: ${options.chainId}. Allowed: 137, 8453, solana`,
    );
  }
  if (chainId && !supportedChains.includes(chainId)) {
    throw new Error(`Unsupported chain: ${chainId}`);
  }

  const chainFilter = chainId ? [chainId] : supportedChains;
  return withRewardsChainLocks(pool, chainFilter, async () => {
    const staleMinAgeSec = STALE_SUBMITTED_NO_TX_MIN_AGE_SEC;
    if (options.dryRun) {
      const stale = await fetchStaleSubmittedWithoutTxClaims(
        chainFilter,
        options.limit,
        staleMinAgeSec,
      );
      if (stale.length) {
        console.log(
          `Dry run: ${stale.length} stale submitted claims without tx hash (>${staleMinAgeSec}s old) would be failed`,
        );
        stale.forEach((claim) => {
          console.log(
            `${claim.id} ${claim.chain_id} ${claim.amount_usdc} -> ${claim.wallet_address}`,
          );
        });
      }
    } else {
      const failedStale = await failStaleSubmittedWithoutTxClaims(
        chainFilter,
        options.limit,
        staleMinAgeSec,
      );
      if (failedStale.length) {
        console.warn(
          `Failed ${failedStale.length} stale submitted claims without tx hash (>${staleMinAgeSec}s old)`,
        );
        failedStale.forEach((claim) => {
          console.warn(
            `${claim.id} ${claim.chain_id} ${claim.amount_usdc} -> ${claim.wallet_address}`,
          );
        });
        for (const claim of failedStale) {
          await notifyClaimStatus(claim, "failed");
        }
      }
    }

    if (options.failPending) {
      const pending = await fetchPendingClaims(chainFilter, options.limit);
      if (options.dryRun) {
        console.log(`Dry run: ${pending.length} pending claims`);
        pending.forEach((claim) => {
          console.log(
            `${claim.id} ${claim.chain_id} ${claim.amount_usdc} -> ${claim.wallet_address}`,
          );
        });
        return;
      }

      const failed = await failPendingClaims(chainFilter, options.limit);
      console.log(`Failed ${failed.length} pending claims`);
      failed.forEach((claim) => {
        console.log(
          `${claim.id} ${claim.chain_id} ${claim.amount_usdc} -> ${claim.wallet_address}`,
        );
      });
      for (const claim of failed) {
        await notifyClaimStatus(claim, "failed");
      }
      return;
    }

    const needsEvm = chainFilter.some((id) => chainConfigs[id]?.kind === "evm");
    const needsSolana = chainFilter.some(
      (id) => chainConfigs[id]?.kind === "solana",
    );
    const evmPayoutKeyByChain = new Map<string, string>();
    if (chainFilter.includes("137")) {
      const key =
        env.rewardsPayoutPrivateKeyPolygon?.trim() ||
        env.rewardsPayoutPrivateKey?.trim();
      if (key) evmPayoutKeyByChain.set("137", key);
    }
    if (chainFilter.includes("8453")) {
      const key =
        env.rewardsPayoutPrivateKeyBase?.trim() ||
        env.rewardsPayoutPrivateKey?.trim();
      if (key) evmPayoutKeyByChain.set("8453", key);
    }
    if (!options.confirmOnly && !options.dryRun) {
      if (needsEvm) {
        const missingEvmChains = chainFilter.filter(
          (id) =>
            chainConfigs[id]?.kind === "evm" && !evmPayoutKeyByChain.get(id),
        );
        if (missingEvmChains.length) {
          throw new Error(
            `Missing EVM payout key for chains: ${missingEvmChains.join(",")}`,
          );
        }
      }
      if (needsSolana && !env.rewardsSolanaSecretKey?.trim()) {
        throw new Error("Missing HUNCH_REWARDS_SOLANA_SECRET_KEY");
      }
    }

    const providerByChain = new Map<string, ethers.JsonRpcProvider>();
    const connectionByChain = new Map<string, Connection>();
    for (const id of chainFilter) {
      const config = chainConfigs[id];
      if (!config) continue;
      if (config.kind === "evm") {
        providerByChain.set(id, buildProvider(config));
      } else {
        connectionByChain.set(id, buildSolanaConnection(config));
      }
    }

    if (!options.sendOnly && !options.dryRun) {
      const submitted = await fetchSubmittedClaims(chainFilter, options.limit);
      for (const claim of submitted) {
        const config = chainConfigs[claim.chain_id];
        if (!config) continue;
        if (config.kind === "evm") {
          const provider = providerByChain.get(claim.chain_id);
          if (!provider) continue;
          await confirmEvmClaim(claim, provider);
        } else {
          const connection = connectionByChain.get(claim.chain_id);
          if (!connection) continue;
          await confirmSolanaClaim(claim, connection);
        }
      }
    }

    if (options.confirmOnly) return;

    if (options.dryRun) {
      const pending = await pool.query<ClaimRow>(
        `
          select
            id,
            user_id,
            wallet_address,
            chain_id,
            amount_usdc::text as amount_usdc,
            status,
            tx_hash,
            created_at
          from reward_claims
          where status = 'pending'
            and chain_id = any($1::text[])
          order by created_at asc
          limit $2
        `,
        [chainFilter, options.limit],
      );
      console.log(`Dry run: ${pending.rows.length} pending claims`);
      pending.rows.forEach((claim) => {
        console.log(
          `${claim.id} ${claim.chain_id} ${claim.amount_usdc} -> ${claim.wallet_address}`,
        );
      });
      return;
    }

    const walletByChain = new Map<string, ethers.Wallet>();
    if (needsEvm) {
      for (const [id, provider] of providerByChain.entries()) {
        const key = evmPayoutKeyByChain.get(id);
        if (!key) continue;
        walletByChain.set(id, new ethers.Wallet(key, provider));
      }
    }
    const solanaKeypair = needsSolana ? loadSolanaKeypair() : null;

    const pendingBeforeReserve = await fetchPendingClaims(
      chainFilter,
      options.limit,
    );
    const polygonPending = pendingBeforeReserve.filter(
      (claim) => claim.chain_id === "137",
    );
    if (polygonPending.length) {
      const polygonConfig = chainConfigs["137"];
      const polygonWallet = walletByChain.get("137");
      if (polygonConfig?.kind === "evm" && polygonWallet) {
        await ensurePolygonPayoutLiquidity(
          polygonPending,
          polygonConfig,
          polygonWallet,
        );
      }
    }

    const reserved = await reservePendingClaims(chainFilter, options.limit);
    for (const claim of reserved) {
      const config = chainConfigs[claim.chain_id];
      if (!config) {
        await markClaimStatus({ id: claim.id, status: "failed" });
        continue;
      }

      try {
        if (config.kind === "evm") {
          const wallet = walletByChain.get(claim.chain_id);
          if (!wallet) {
            await markClaimStatus({ id: claim.id, status: "failed" });
            continue;
          }
          await sendEvmClaim(claim, config, wallet);
        } else {
          const connection = connectionByChain.get(claim.chain_id);
          if (!connection || !solanaKeypair) {
            await markClaimStatus({ id: claim.id, status: "failed" });
            continue;
          }
          await sendSolanaClaim(claim, config, connection, solanaKeypair);
        }
      } catch (error) {
        console.error(
          "Claim payout failed",
          claim.id,
          claim.chain_id,
          error instanceof Error ? error.message : error,
        );
        if (config.kind === "solana") {
          await markSolanaClaimAfterPayoutError(claim);
          continue;
        }
        const provider = providerByChain.get(claim.chain_id);
        if (provider) {
          await markEvmClaimAfterPayoutError(claim, provider);
          continue;
        }
        await markClaimStatus({ id: claim.id, status: "failed" });
      }
    }
  });
}

function isDirectExecution(metaUrl: string): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  return pathToFileURL(entrypoint).href === metaUrl;
}

if (isDirectExecution(import.meta.url)) {
  runRewardsPayout(parseRewardsPayoutArgs())
    .then(async () => {
      await pool.end();
    })
    .catch(async (error) => {
      console.error(error);
      process.exitCode = 1;
      await pool.end();
    });
}
