#!/usr/bin/env tsx

import { getOrCreateAssociatedTokenAccount, transferChecked } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { ethers } from "ethers";
import { pool } from "./db.js";
import { env } from "./env.js";

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

type ScriptOptions = {
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

const ERC20_ABI = [
  "function transfer(address to, uint256 value) returns (bool)",
];

function parseArgs(): ScriptOptions {
  const args = process.argv.slice(2);
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

function resolveChainAlias(chainId: string): string {
  const normalized = chainId.trim().toLowerCase();
  if (normalized === "polygon") return "137";
  if (normalized === "base") return "8453";
  if (normalized === "solana" || normalized === "sol") return "solana";
  return chainId.trim();
}

function buildChainConfigs(): Record<string, ChainConfig> {
  const polygonUsdc =
    env.rewardsUsdcPolygon?.trim() || env.polymarketUsdcAddress;
  const baseUsdc =
    env.rewardsUsdcBase?.trim() || env.limitlessUsdcAddress;

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

async function markClaimStatus(inputs: {
  id: string;
  status: "submitted" | "confirmed" | "failed";
  txHash?: string | null;
}) {
  await pool.query(
    `
      update reward_claims
      set status = $2,
          tx_hash = coalesce($3, tx_hash),
          updated_at = now()
      where id = $1
    `,
    [inputs.id, inputs.status, inputs.txHash ?? null],
  );
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

async function confirmSolanaClaim(
  claim: ClaimRow,
  connection: Connection,
) {
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
  if (value.confirmationStatus === "confirmed" || value.confirmationStatus === "finalized") {
    await markClaimStatus({ id: claim.id, status: "confirmed" });
  }
}

async function sendEvmClaim(
  claim: ClaimRow,
  config: EvmChainConfig,
  wallet: ethers.Wallet,
) {
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
  const amountRaw = parseAmount(claim.amount_usdc, config.decimals);
  if (amountRaw <= 0n) {
    await markClaimStatus({ id: claim.id, status: "failed" });
    return;
  }

  const mint = new PublicKey(config.usdcMint);
  const recipient = new PublicKey(claim.wallet_address);
  const sourceAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    keypair,
    mint,
    keypair.publicKey,
  );
  const destinationAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    keypair,
    mint,
    recipient,
  );
  const signature = await transferChecked(
    connection,
    keypair,
    sourceAccount.address,
    mint,
    destinationAccount.address,
    keypair.publicKey,
    amountRaw,
    config.decimals,
  );
  await markClaimStatus({
    id: claim.id,
    status: "submitted",
    txHash: signature,
  });
  const confirmation = await connection.confirmTransaction(
    signature,
    "confirmed",
  );
  if (confirmation.value.err) {
    await markClaimStatus({ id: claim.id, status: "failed" });
  } else {
    await markClaimStatus({ id: claim.id, status: "confirmed" });
  }
}

async function main() {
  const options = parseArgs();
  const chainConfigs = buildChainConfigs();
  const supportedChains = Object.keys(chainConfigs);
  const chainId = options.chainId ? resolveChainAlias(options.chainId) : null;

  if (chainId && !supportedChains.includes(chainId)) {
    throw new Error(`Unsupported chain: ${chainId}`);
  }

  const chainFilter = chainId ? [chainId] : supportedChains;
  if (options.failPending) {
    const pending = await fetchPendingClaims(chainFilter, options.limit);
    if (options.dryRun) {
      console.log(`Dry run: ${pending.length} pending claims`);
      pending.forEach((claim) => {
        console.log(`${claim.id} ${claim.chain_id} ${claim.amount_usdc} -> ${claim.wallet_address}`);
      });
      return;
    }

    const failed = await failPendingClaims(chainFilter, options.limit);
    console.log(`Failed ${failed.length} pending claims`);
    failed.forEach((claim) => {
      console.log(`${claim.id} ${claim.chain_id} ${claim.amount_usdc} -> ${claim.wallet_address}`);
    });
    return;
  }

  const needsEvm = chainFilter.some(
    (id) => chainConfigs[id]?.kind === "evm",
  );
  const needsSolana = chainFilter.some(
    (id) => chainConfigs[id]?.kind === "solana",
  );
  const payoutKey = env.rewardsPayoutPrivateKey?.trim();
  if (!options.confirmOnly && !options.dryRun) {
    if (needsEvm && !payoutKey) {
      throw new Error("Missing HUNCH_REWARDS_PAYOUT_PRIVATE_KEY");
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

  if (!options.sendOnly) {
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
      console.log(`${claim.id} ${claim.chain_id} ${claim.amount_usdc} -> ${claim.wallet_address}`);
    });
    return;
  }

  const walletByChain = new Map<string, ethers.Wallet>();
  if (needsEvm && payoutKey) {
    for (const [id, provider] of providerByChain.entries()) {
      walletByChain.set(id, new ethers.Wallet(payoutKey, provider));
    }
  }
  const solanaKeypair = needsSolana ? loadSolanaKeypair() : null;

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
      await markClaimStatus({ id: claim.id, status: "failed" });
    }
  }
}

main()
  .then(async () => {
    await pool.end();
  })
  .catch(async (error) => {
    console.error(error);
    process.exitCode = 1;
    await pool.end();
  });
