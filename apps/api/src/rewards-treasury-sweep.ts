#!/usr/bin/env tsx

import {
  getOrCreateAssociatedTokenAccount,
  transferChecked,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { ethers } from "ethers";
import { pathToFileURL } from "node:url";
import { pool } from "./db.js";
import { env } from "./env.js";
import {
  REWARDS_CHAIN_IDS,
  normalizeRewardsChainId,
  type RewardsChainId,
} from "./lib/rewards-chain.js";
import { withRewardsChainLocks } from "./lib/rewards-locks.js";
import { parseUsdcToMicro, usdcMicroToDecimalString } from "./lib/usdc.js";
import {
  capTreasurySweepAmountMicro,
  getRewardsTreasuryReport,
} from "./services/rewards-treasury.js";
import { waitForSolanaSignatureConfirmation } from "./services/solana-rpc.js";

export type RewardsTreasurySweepOptions = {
  execute: boolean;
  dryRun: boolean;
  chainId?: string;
  maxUsd?: string;
  maxMicro?: bigint;
};

export function parseRewardsTreasurySweepArgs(
  args: string[] = process.argv.slice(2),
): RewardsTreasurySweepOptions {
  const getValue = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx === -1) return undefined;
    const next = args[idx + 1];
    return next && !next.startsWith("--") ? next : undefined;
  };
  const hasFlag = (flag: string): boolean => args.includes(flag);

  const chainRaw = getValue("--chain");
  const maxUsdRaw = getValue("--max-usd");
  const parsedMaxMicro = maxUsdRaw ? parseUsdcToMicro(maxUsdRaw) : null;

  if (maxUsdRaw && (!parsedMaxMicro || parsedMaxMicro <= 0n)) {
    throw new Error(
      "--max-usd must be a positive USDC amount (up to 6 decimals)",
    );
  }

  return {
    execute: hasFlag("--execute"),
    dryRun: !hasFlag("--execute"),
    chainId: chainRaw?.trim(),
    maxUsd: maxUsdRaw?.trim(),
    maxMicro: parsedMaxMicro ?? undefined,
  };
}

type SweepRunStatus =
  | "started"
  | "completed"
  | "partial"
  | "failed"
  | "skipped";

async function upsertRunLedger(inputs: {
  mode: "dry_run" | "execute";
  status: SweepRunStatus;
  report: { liabilityMode: string };
  payload: unknown;
  error?: string | null;
}): Promise<string | null> {
  const regclass = await pool.query<{ table_name: string | null }>(
    `select to_regclass('public.reward_treasury_runs')::text as table_name`,
  );
  if (!regclass.rows[0]?.table_name) return null;

  const { rows } = await pool.query<{ id: string }>(
    `
      insert into reward_treasury_runs (
        id,
        mode,
        status,
        liability_mode,
        report,
        error,
        started_at,
        finished_at,
        created_at,
        updated_at
      )
      values (
        gen_random_uuid(),
        $1,
        $2,
        $3,
        $4::jsonb,
        $5,
        now(),
        now(),
        now(),
        now()
      )
      returning id
    `,
    [
      inputs.mode,
      inputs.status,
      inputs.report.liabilityMode,
      JSON.stringify(inputs.payload),
      inputs.error ?? null,
    ],
  );
  return rows[0]?.id ?? null;
}

const ERC20_SWEEP_ABI = [
  "function transfer(address to, uint256 value) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
];
const USDC_DECIMALS = 6;

type PlannedSweepAction = {
  chainId: string;
  amountMicro: bigint;
  amount: number;
  hotBalanceNow: string | null;
  hotBalanceLeftIfApplied: string | null;
  reserveFloorNow: string | null;
  sweepableNow: string | null;
  shouldSweep: boolean;
  reason: string | null;
  executed: boolean;
  txHash: string | null;
  hotAddress: string | null;
  coldAddress: string | null;
  preHotBalance: string | null;
  postHotBalance: string | null;
  preColdBalance: string | null;
  postColdBalance: string | null;
  error: string | null;
};

type EvmSweepConfig = {
  kind: "evm";
  chainId: "137" | "8453";
  rpcUrl: string;
  usdcAddress: string;
  privateKey: string;
  coldAddress: string;
};

type SolanaSweepConfig = {
  kind: "solana";
  chainId: "solana";
  rpcUrl: string;
  usdcMint: string;
  secretKey: string;
  coldAddress: string;
};

type SweepConfig = EvmSweepConfig | SolanaSweepConfig;

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message?.trim();
    const name = error.name?.trim();
    if (message && name && message !== name) return `${name}: ${message}`;
    if (message) return message;
    if (name) return name;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") return serialized;
  } catch {
    // ignore
  }
  return String(error);
}

function wrapSweepStage(stage: string, error: unknown): Error {
  const message = describeError(error);
  return new Error(`solana_${stage}: ${message}`);
}

function loadSolanaKeypair(secret: string): Keypair {
  const trimmed = secret.trim();
  if (!trimmed) throw new Error("Missing HUNCH_REWARDS_SOLANA_SECRET_KEY");
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(parsed));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

function resolveHotAddressForChain(chainId: RewardsChainId): string | null {
  try {
    if (chainId === "137") {
      const privateKey =
        env.rewardsPayoutPrivateKeyPolygon?.trim() ||
        env.rewardsPayoutPrivateKey?.trim();
      return privateKey ? new ethers.Wallet(privateKey).address : null;
    }
    if (chainId === "8453") {
      const privateKey =
        env.rewardsPayoutPrivateKeyBase?.trim() ||
        env.rewardsPayoutPrivateKey?.trim();
      return privateKey ? new ethers.Wallet(privateKey).address : null;
    }
    const secretKey = env.rewardsSolanaSecretKey?.trim();
    return secretKey ? loadSolanaKeypair(secretKey).publicKey.toBase58() : null;
  } catch {
    return null;
  }
}

function resolveColdAddressForChain(chainId: RewardsChainId): string | null {
  if (chainId === "137") {
    return env.rewardsTreasuryColdAddressPolygon?.trim() || null;
  }
  if (chainId === "8453") {
    return env.rewardsTreasuryColdAddressBase?.trim() || null;
  }
  return env.rewardsTreasuryColdAddressSolana?.trim() || null;
}

function resolveSweepConfig(chainId: RewardsChainId): {
  config: SweepConfig | null;
  error?: string;
} {
  if (chainId === "137") {
    const privateKey =
      env.rewardsPayoutPrivateKeyPolygon?.trim() ||
      env.rewardsPayoutPrivateKey?.trim();
    const coldAddress = env.rewardsTreasuryColdAddressPolygon?.trim();
    const usdcAddress =
      env.rewardsPayoutTokenAddressPolygon?.trim() || env.polymarketPusdAddress;
    if (!privateKey) {
      return { config: null, error: "missing polygon payout key" };
    }
    if (!coldAddress) {
      return {
        config: null,
        error: "missing HUNCH_REWARDS_TREASURY_COLD_ADDRESS_POLYGON",
      };
    }
    if (!ethers.isAddress(coldAddress)) {
      return { config: null, error: "invalid polygon cold address" };
    }
    if (!ethers.isAddress(usdcAddress)) {
      return { config: null, error: "invalid polygon usdc address" };
    }
    return {
      config: {
        kind: "evm",
        chainId: "137",
        rpcUrl: env.polygonRpcUrl,
        usdcAddress,
        privateKey,
        coldAddress: ethers.getAddress(coldAddress),
      },
    };
  }

  if (chainId === "8453") {
    const privateKey =
      env.rewardsPayoutPrivateKeyBase?.trim() ||
      env.rewardsPayoutPrivateKey?.trim();
    const coldAddress = env.rewardsTreasuryColdAddressBase?.trim();
    const usdcAddress = env.rewardsUsdcBase?.trim() || env.limitlessUsdcAddress;
    if (!privateKey) {
      return { config: null, error: "missing base payout key" };
    }
    if (!coldAddress) {
      return {
        config: null,
        error: "missing HUNCH_REWARDS_TREASURY_COLD_ADDRESS_BASE",
      };
    }
    if (!ethers.isAddress(coldAddress)) {
      return { config: null, error: "invalid base cold address" };
    }
    if (!ethers.isAddress(usdcAddress)) {
      return { config: null, error: "invalid base usdc address" };
    }
    return {
      config: {
        kind: "evm",
        chainId: "8453",
        rpcUrl: env.baseRpcUrl,
        usdcAddress,
        privateKey,
        coldAddress: ethers.getAddress(coldAddress),
      },
    };
  }

  const secretKey = env.rewardsSolanaSecretKey?.trim();
  const coldAddress = env.rewardsTreasuryColdAddressSolana?.trim();
  if (!secretKey) {
    return { config: null, error: "missing solana payout key" };
  }
  if (!coldAddress) {
    return {
      config: null,
      error: "missing HUNCH_REWARDS_TREASURY_COLD_ADDRESS_SOLANA",
    };
  }
  try {
    new PublicKey(coldAddress);
  } catch {
    return { config: null, error: "invalid solana cold address" };
  }
  return {
    config: {
      kind: "solana",
      chainId: "solana",
      rpcUrl: env.solanaRpcUrl,
      usdcMint: env.solanaUsdcMint,
      secretKey,
      coldAddress,
    },
  };
}

async function executeEvmSweep(
  config: EvmSweepConfig,
  amountMicro: bigint,
): Promise<{
  txHash: string;
  hotAddress: string;
  coldAddress: string;
  preHotBalance: bigint;
  postHotBalance: bigint;
  preColdBalance: bigint;
  postColdBalance: bigint;
}> {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const wallet = new ethers.Wallet(config.privateKey, provider);
  const token = new ethers.Contract(
    config.usdcAddress,
    ERC20_SWEEP_ABI,
    wallet,
  );
  const hotAddress = await wallet.getAddress();
  const coldAddress = config.coldAddress;

  const preHotBalance = BigInt(await token.balanceOf(hotAddress));
  const preColdBalance = BigInt(await token.balanceOf(coldAddress));
  if (preHotBalance < amountMicro) {
    throw new Error(
      `insufficient hot balance: have=${usdcMicroToDecimalString(preHotBalance)} need=${usdcMicroToDecimalString(amountMicro)}`,
    );
  }

  const tx = await token.transfer(coldAddress, amountMicro);
  const receipt = await tx.wait();
  if (receipt?.status !== 1) {
    throw new Error("transfer reverted");
  }

  const postHotBalance = BigInt(await token.balanceOf(hotAddress));
  const postColdBalance = BigInt(await token.balanceOf(coldAddress));
  if (preHotBalance - postHotBalance < amountMicro) {
    throw new Error(
      "post-check failed: hot balance did not decrease by amount",
    );
  }
  if (postColdBalance - preColdBalance < amountMicro) {
    throw new Error(
      "post-check failed: cold balance did not increase by amount",
    );
  }

  return {
    txHash: tx.hash,
    hotAddress,
    coldAddress,
    preHotBalance,
    postHotBalance,
    preColdBalance,
    postColdBalance,
  };
}

async function executeSolanaSweep(
  config: SolanaSweepConfig,
  amountMicro: bigint,
): Promise<{
  txHash: string;
  hotAddress: string;
  coldAddress: string;
  preHotBalance: bigint;
  postHotBalance: bigint;
  preColdBalance: bigint;
  postColdBalance: bigint;
}> {
  const connection = new Connection(config.rpcUrl, "confirmed");
  const keypair = loadSolanaKeypair(config.secretKey);
  const mint = new PublicKey(config.usdcMint);
  const coldOwner = new PublicKey(config.coldAddress);

  let sourceAccount;
  try {
    sourceAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      keypair,
      mint,
      keypair.publicKey,
    );
  } catch (error) {
    throw wrapSweepStage("source_ata", error);
  }

  let destinationAccount;
  try {
    destinationAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      keypair,
      mint,
      coldOwner,
    );
  } catch (error) {
    throw wrapSweepStage("destination_ata", error);
  }

  let preHotBalance: bigint;
  let preColdBalance: bigint;
  try {
    preHotBalance = BigInt(
      (
        await connection.getTokenAccountBalance(
          sourceAccount.address,
          "confirmed",
        )
      ).value.amount,
    );
    preColdBalance = BigInt(
      (
        await connection.getTokenAccountBalance(
          destinationAccount.address,
          "confirmed",
        )
      ).value.amount,
    );
  } catch (error) {
    throw wrapSweepStage("pre_balance", error);
  }
  if (preHotBalance < amountMicro) {
    throw new Error(
      `insufficient hot balance: have=${usdcMicroToDecimalString(preHotBalance)} need=${usdcMicroToDecimalString(amountMicro)}`,
    );
  }

  let signature: string;
  try {
    signature = await transferChecked(
      connection,
      keypair,
      sourceAccount.address,
      mint,
      destinationAccount.address,
      keypair.publicKey,
      amountMicro,
      USDC_DECIMALS,
    );
  } catch (error) {
    throw wrapSweepStage("transfer", error);
  }

  try {
    const confirmation = await waitForSolanaSignatureConfirmation({
      rpcUrls: env.solanaRpcUrls,
      signature,
      timeoutMs: env.solanaRpcTimeoutMs,
      commitment: "confirmed",
    });
    if (confirmation.status === "failed") {
      throw new Error("transfer failed");
    }
    if (confirmation.status !== "fulfilled") {
      throw new Error("transfer confirmation timed out");
    }
  } catch (error) {
    throw wrapSweepStage("confirm", error);
  }

  let postHotBalance: bigint;
  let postColdBalance: bigint;
  try {
    postHotBalance = BigInt(
      (
        await connection.getTokenAccountBalance(
          sourceAccount.address,
          "confirmed",
        )
      ).value.amount,
    );
    postColdBalance = BigInt(
      (
        await connection.getTokenAccountBalance(
          destinationAccount.address,
          "confirmed",
        )
      ).value.amount,
    );
  } catch (error) {
    throw wrapSweepStage("post_balance", error);
  }
  if (preHotBalance - postHotBalance < amountMicro) {
    throw new Error(
      "post-check failed: hot balance did not decrease by amount",
    );
  }
  if (postColdBalance - preColdBalance < amountMicro) {
    throw new Error(
      "post-check failed: cold balance did not increase by amount",
    );
  }

  return {
    txHash: signature,
    hotAddress: keypair.publicKey.toBase58(),
    coldAddress: coldOwner.toBase58(),
    preHotBalance,
    postHotBalance,
    preColdBalance,
    postColdBalance,
  };
}

function deriveRunStatus(actions: PlannedSweepAction[]): SweepRunStatus {
  const attempted = actions.filter((action) => action.shouldSweep);
  if (!attempted.length) return "skipped";
  const failures = attempted.filter((action) => action.error != null);
  if (!failures.length) return "completed";
  if (failures.length === attempted.length) return "failed";
  return "partial";
}

export async function runRewardsTreasurySweep(
  options: RewardsTreasurySweepOptions,
) {
  const normalizedChainId = options.chainId
    ? normalizeRewardsChainId(options.chainId)
    : null;
  if (options.chainId && !normalizedChainId) {
    throw new Error("Unsupported chain. Allowed: 137, 8453, solana");
  }

  const lockTargets = normalizedChainId
    ? [normalizedChainId]
    : REWARDS_CHAIN_IDS;
  return withRewardsChainLocks(pool, lockTargets, async () => {
    const report = await getRewardsTreasuryReport(pool, {
      chainId: normalizedChainId,
    });
    if (!report.chains.length) {
      console.log("No chains available for treasury sweep.");
      return;
    }

    const minSweepMicro = env.rewardsTreasuryMinSweepMicro;

    const actions: PlannedSweepAction[] = report.chains.map((chain) => {
      const sweepableNowMicro = BigInt(chain.sweepableNowMicro);
      const reserveFloorMicro = BigInt(chain.reserveFloorMicro);
      const hotBalanceNowMicro = BigInt(chain.controlledHotBalanceMicro);
      const amountMicro = capTreasurySweepAmountMicro(
        sweepableNowMicro,
        options.maxMicro,
      );
      const hotBalanceLeftIfAppliedMicro =
        hotBalanceNowMicro > amountMicro
          ? hotBalanceNowMicro - amountMicro
          : 0n;
      const amount = Number(usdcMicroToDecimalString(amountMicro));
      const shouldSweep = amountMicro > 0n && amountMicro >= minSweepMicro;
      let reason: string | null = null;
      if (!shouldSweep) {
        if (!chain.hotBalanceAvailable) {
          reason = `hot_balance_unavailable:${chain.hotBalanceError ?? "unknown"}`;
        } else if (amountMicro === 0n) {
          reason = "no_surplus";
        } else {
          reason = "below_min_sweep";
        }
      }
      let hotAddress: string | null = null;
      let coldAddress: string | null = null;
      const chainId = normalizeRewardsChainId(chain.chainId);
      if (chainId) {
        hotAddress = resolveHotAddressForChain(chainId);
        coldAddress = resolveColdAddressForChain(chainId);
      }
      return {
        chainId: chain.chainId,
        amountMicro,
        amount,
        hotBalanceNow: usdcMicroToDecimalString(hotBalanceNowMicro),
        hotBalanceLeftIfApplied: usdcMicroToDecimalString(
          hotBalanceLeftIfAppliedMicro,
        ),
        reserveFloorNow: usdcMicroToDecimalString(reserveFloorMicro),
        sweepableNow: usdcMicroToDecimalString(sweepableNowMicro),
        shouldSweep,
        reason,
        executed: false,
        txHash: null,
        hotAddress,
        coldAddress,
        preHotBalance: null,
        postHotBalance: null,
        preColdBalance: null,
        postColdBalance: null,
        error: null,
      };
    });

    if (options.execute) {
      for (const action of actions) {
        if (!action.shouldSweep || action.amountMicro <= 0n) continue;
        const actionChainId = normalizeRewardsChainId(action.chainId);
        if (!actionChainId) {
          action.error = `unsupported_chain:${action.chainId}`;
          continue;
        }
        const resolved = resolveSweepConfig(actionChainId);
        if (!resolved.config) {
          action.error = resolved.error ?? "missing sweep config";
          continue;
        }
        try {
          const result =
            resolved.config.kind === "evm"
              ? await executeEvmSweep(resolved.config, action.amountMicro)
              : await executeSolanaSweep(resolved.config, action.amountMicro);
          action.executed = true;
          action.txHash = result.txHash;
          action.hotAddress = result.hotAddress;
          action.coldAddress = result.coldAddress;
          action.preHotBalance = usdcMicroToDecimalString(result.preHotBalance);
          action.postHotBalance = usdcMicroToDecimalString(
            result.postHotBalance,
          );
          action.preColdBalance = usdcMicroToDecimalString(
            result.preColdBalance,
          );
          action.postColdBalance = usdcMicroToDecimalString(
            result.postColdBalance,
          );
        } catch (error) {
          action.error = describeError(error);
        }
      }
    }

    let status = deriveRunStatus(actions);
    const failedCount = actions.filter(
      (action) => action.shouldSweep && action.error != null,
    ).length;
    const attemptedCount = actions.filter(
      (action) => action.shouldSweep,
    ).length;
    const unavailableHotBalanceCount = actions.filter((action) =>
      (action.reason ?? "").startsWith("hot_balance_unavailable:"),
    ).length;
    if (
      options.execute &&
      status === "skipped" &&
      unavailableHotBalanceCount > 0
    ) {
      status = "failed";
    }

    console.log(
      JSON.stringify(
        {
          dryRun: options.dryRun,
          execute: options.execute,
          status,
          liabilityMode: report.liabilityMode,
          includePending: report.includePending,
          minSweepUsd: usdcMicroToDecimalString(minSweepMicro),
          actions: actions.map((action) => ({
            ...action,
            amountMicro: action.amountMicro.toString(),
          })),
        },
        null,
        2,
      ),
    );

    const runId = await upsertRunLedger({
      mode: options.execute ? "execute" : "dry_run",
      status,
      report,
      payload: {
        report,
        actions: actions.map((action) => ({
          ...action,
          amountMicro: action.amountMicro.toString(),
        })),
      },
      error:
        failedCount > 0
          ? `${failedCount}/${attemptedCount} sweep action(s) failed`
          : unavailableHotBalanceCount > 0 && options.execute
            ? `${unavailableHotBalanceCount} chain(s) missing hot-balance prerequisites`
            : null,
    });
    if (runId) {
      console.log(`Treasury run recorded: ${runId}`);
    }

    const result = {
      report,
      actions: actions.map((action) => ({
        ...action,
        amountMicro: action.amountMicro.toString(),
      })),
      status,
      runId,
    };

    if (options.execute && (status === "failed" || status === "partial")) {
      const failureMessage =
        failedCount > 0
          ? `${failedCount}/${attemptedCount} action(s) failed`
          : `${unavailableHotBalanceCount} chain(s) missing hot-balance prerequisites`;
      throw new Error(`Treasury sweep ${status}: ${failureMessage}`);
    }

    return result;
  });
}

function isDirectExecution(metaUrl: string): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  return pathToFileURL(entrypoint).href === metaUrl;
}

if (isDirectExecution(import.meta.url)) {
  runRewardsTreasurySweep(parseRewardsTreasurySweepArgs())
    .then(async () => {
      await pool.end();
    })
    .catch(async (error) => {
      console.error("[rewards-treasury-sweep]", error);
      process.exitCode = 1;
      await pool.end();
    });
}
