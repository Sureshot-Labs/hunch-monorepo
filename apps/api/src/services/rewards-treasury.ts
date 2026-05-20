import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { ethers } from "ethers";
import type { DbQuery } from "../db.js";
import { env } from "../env.js";
import {
  REWARDS_CHAIN_IDS,
  normalizeRewardsChainId,
  type RewardsChainId,
} from "../lib/rewards-chain.js";
import { usdcMicroToDecimalString } from "../lib/usdc.js";

type ChainLiabilityRow = {
  chain_id: string | null;
  pending: string | null;
  collected: string | null;
  gross_collected_fees: string | null;
};

type ChainClaimsRow = {
  chain_id: string | null;
  confirmed: string | null;
  open_non_failed: string | null;
  non_failed: string | null;
};

const USDC_MICRO = 1_000_000n;
const ERC20_BALANCE_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
];

function decimalToMicroFloor(value: string | null | undefined): bigint {
  const raw = (value ?? "0").trim();
  if (!raw) return 0n;
  const normalized = raw.replace(/_/g, "");
  if (!/^\d+(\.\d+)?$/.test(normalized)) return 0n;
  const [whole, fraction = ""] = normalized.split(".");
  const wholeMicro = BigInt(whole) * USDC_MICRO;
  const fractionMicro = BigInt((fraction + "000000").slice(0, 6));
  return wholeMicro + fractionMicro;
}

function microToNumber(value: bigint): number {
  return Number(usdcMicroToDecimalString(value >= 0n ? value : 0n));
}

function numberToMicroCeil(value: number): bigint {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  return BigInt(Math.ceil(value * Number(USDC_MICRO)));
}

function max0Micro(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

function pctToMicroCeil(baseMicro: bigint, ratio: number): bigint {
  if (baseMicro <= 0n || !Number.isFinite(ratio) || ratio <= 0) return 0n;
  const ratioMicro = BigInt(Math.ceil(ratio * Number(USDC_MICRO)));
  return (baseMicro * ratioMicro + USDC_MICRO - 1n) / USDC_MICRO;
}

function resolveChainFilter(chainId?: string | null): string | null {
  if (!chainId) return null;
  return normalizeRewardsChainId(chainId);
}

function resolvePayoutAddress(chainId: string): string | null {
  if (chainId === "137") {
    return env.rewardsPayoutPrivateKeyPolygon?.trim()
      ? "configured"
      : env.rewardsPayoutPrivateKey?.trim()
        ? "configured"
        : null;
  }
  if (chainId === "8453") {
    return env.rewardsPayoutPrivateKeyBase?.trim()
      ? "configured"
      : env.rewardsPayoutPrivateKey?.trim()
        ? "configured"
        : null;
  }
  if (chainId === "solana") {
    return env.rewardsSolanaSecretKey?.trim() ? "configured" : null;
  }
  return null;
}

type HotBalanceResult = {
  available: boolean;
  balanceMicro: bigint;
  error?: string;
};

function loadSolanaKeypair(secret: string): Keypair {
  const trimmed = secret.trim();
  if (!trimmed) throw new Error("missing solana secret key");
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(parsed));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

async function fetchEvmHotBalanceMicro(params: {
  rpcUrl: string;
  usdcAddress: string;
  privateKey: string;
}): Promise<bigint> {
  const provider = new ethers.JsonRpcProvider(params.rpcUrl);
  const wallet = new ethers.Wallet(params.privateKey, provider);
  const token = new ethers.Contract(
    params.usdcAddress,
    ERC20_BALANCE_ABI,
    provider,
  );
  const balance = await token.balanceOf(await wallet.getAddress());
  return BigInt(balance as bigint);
}

async function fetchSolanaHotBalanceMicro(params: {
  rpcUrl: string;
  usdcMint: string;
  secretKey: string;
}): Promise<bigint> {
  const connection = new Connection(params.rpcUrl, "confirmed");
  const keypair = loadSolanaKeypair(params.secretKey);
  const mint = new PublicKey(params.usdcMint);
  const owner = keypair.publicKey;
  const ata = getAssociatedTokenAddressSync(mint, owner, false);
  try {
    const balance = await connection.getTokenAccountBalance(ata, "confirmed");
    return BigInt(balance.value.amount);
  } catch (error) {
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error);
    if (message.includes("could not find account")) return 0n;
    throw error;
  }
}

async function fetchControlledHotBalance(
  chainId: RewardsChainId,
): Promise<HotBalanceResult> {
  try {
    if (chainId === "137") {
      const privateKey =
        env.rewardsPayoutPrivateKeyPolygon?.trim() ||
        env.rewardsPayoutPrivateKey?.trim();
      const usdcAddress =
        env.rewardsPayoutTokenAddressPolygon?.trim() ||
        env.polymarketPusdAddress;
      if (!privateKey) {
        return {
          available: false,
          balanceMicro: 0n,
          error: "missing payout signer key",
        };
      }
      if (!ethers.isAddress(usdcAddress)) {
        return {
          available: false,
          balanceMicro: 0n,
          error: "invalid polygon usdc address",
        };
      }
      const balanceMicro = await fetchEvmHotBalanceMicro({
        rpcUrl: env.polygonRpcUrl,
        usdcAddress,
        privateKey,
      });
      return { available: true, balanceMicro };
    }

    if (chainId === "8453") {
      const privateKey =
        env.rewardsPayoutPrivateKeyBase?.trim() ||
        env.rewardsPayoutPrivateKey?.trim();
      const usdcAddress =
        env.rewardsUsdcBase?.trim() || env.limitlessUsdcAddress;
      if (!privateKey) {
        return {
          available: false,
          balanceMicro: 0n,
          error: "missing payout signer key",
        };
      }
      if (!ethers.isAddress(usdcAddress)) {
        return {
          available: false,
          balanceMicro: 0n,
          error: "invalid base usdc address",
        };
      }
      const balanceMicro = await fetchEvmHotBalanceMicro({
        rpcUrl: env.baseRpcUrl,
        usdcAddress,
        privateKey,
      });
      return { available: true, balanceMicro };
    }

    const secretKey = env.rewardsSolanaSecretKey?.trim();
    if (!secretKey) {
      return {
        available: false,
        balanceMicro: 0n,
        error: "missing solana signer key",
      };
    }
    const balanceMicro = await fetchSolanaHotBalanceMicro({
      rpcUrl: env.solanaRpcUrl,
      usdcMint: env.solanaUsdcMint,
      secretKey,
    });
    return { available: true, balanceMicro };
  } catch (error) {
    return {
      available: false,
      balanceMicro: 0n,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchLiabilityByChain(
  pool: DbQuery,
  chainId?: string | null,
): Promise<Record<string, ChainLiabilityRow>> {
  const params: Array<string> = [];
  let chainClause = "";
  if (chainId) {
    params.push(chainId);
    chainClause = `and chain_id = $${params.length}`;
  }

  const { rows } = await pool.query<ChainLiabilityRow>(
    `
      select
        coalesce(chain_id, 'unknown') as chain_id,
        coalesce(
          sum(
            case
              when status = 'pending'
                then coalesce(cashback_earned_usdc, 0) + coalesce(referral_earned_usdc, 0)
              else 0
            end
          ),
          0
        )::text as pending,
        coalesce(
          sum(
            case
              when status = 'collected'
                then coalesce(cashback_earned_usdc, 0) + coalesce(referral_earned_usdc, 0)
              else 0
            end
          ),
          0
        )::text as collected,
        coalesce(sum(case when status = 'collected' then fee_usd else 0 end), 0)::text as gross_collected_fees
      from fee_events
      where liability_snapshot_source = 'event_time_frozen'
        ${chainClause}
      group by chain_id
    `,
    params,
  );

  const out: Record<string, ChainLiabilityRow> = {};
  for (const row of rows) {
    out[row.chain_id ?? "unknown"] = row;
  }
  return out;
}

async function fetchClaimsByChain(
  pool: DbQuery,
  chainId?: string | null,
): Promise<Record<string, ChainClaimsRow>> {
  const params: Array<string> = [];
  let chainClause = "";
  if (chainId) {
    params.push(chainId);
    chainClause = `where chain_id = $${params.length}`;
  }
  const { rows } = await pool.query<ChainClaimsRow>(
    `
      select
        coalesce(chain_id, 'unknown') as chain_id,
        coalesce(sum(case when status = 'confirmed' then amount_usdc else 0 end), 0)::text as confirmed,
        coalesce(sum(case when status in ('pending', 'submitted') then amount_usdc else 0 end), 0)::text as open_non_failed,
        coalesce(sum(case when status <> 'failed' then amount_usdc else 0 end), 0)::text as non_failed
      from reward_claims
      ${chainClause}
      group by chain_id
    `,
    params,
  );
  const out: Record<string, ChainClaimsRow> = {};
  for (const row of rows) {
    out[row.chain_id ?? "unknown"] = row;
  }
  return out;
}

export type TreasuryChainMathInput = {
  liabilityCollectedMicro: bigint;
  liabilityPendingMicro: bigint;
  claimedConfirmedMicro: bigint;
  claimedNonFailedMicro: bigint;
  includePending: boolean;
  bufferUsd: number;
  bufferPct: number;
  controlledHotBalanceMicro: bigint;
  protocolReceivableBalanceMicro: bigint;
};

export type TreasuryChainMathOutput = {
  claimableNowMicro: bigint;
  outstandingCollectedPayableMicro: bigint;
  reserveFloorMicro: bigint;
  bufferAppliedMicro: bigint;
  deficitNowMicro: bigint;
  economicSurplusMicro: bigint;
  sweepableNowMicro: bigint;
};

export function computeTreasuryChainMath(
  input: TreasuryChainMathInput,
): TreasuryChainMathOutput {
  const claimableNowMicro = max0Micro(
    input.liabilityCollectedMicro - input.claimedNonFailedMicro,
  );
  const outstandingCollectedPayableMicro = max0Micro(
    input.liabilityCollectedMicro - input.claimedConfirmedMicro,
  );
  const reserveBaseMicro =
    outstandingCollectedPayableMicro +
    (input.includePending ? input.liabilityPendingMicro : 0n);
  const bufferAppliedMicro = [
    numberToMicroCeil(input.bufferUsd),
    pctToMicroCeil(reserveBaseMicro, input.bufferPct),
  ].reduce((max, value) => (value > max ? value : max), 0n);
  const reserveFloorMicro = reserveBaseMicro + bufferAppliedMicro;
  const deficitNowMicro = max0Micro(
    reserveFloorMicro - input.controlledHotBalanceMicro,
  );
  const sweepableNowMicro =
    deficitNowMicro > 0n
      ? 0n
      : max0Micro(input.controlledHotBalanceMicro - reserveFloorMicro);
  const economicSurplusMicro = max0Micro(
    input.controlledHotBalanceMicro +
      input.protocolReceivableBalanceMicro -
      reserveFloorMicro,
  );

  return {
    claimableNowMicro,
    outstandingCollectedPayableMicro,
    reserveFloorMicro,
    bufferAppliedMicro,
    deficitNowMicro,
    economicSurplusMicro,
    sweepableNowMicro,
  };
}

export function capTreasurySweepAmountMicro(
  sweepableNowMicro: bigint,
  maxMicro?: bigint,
): bigint {
  if (sweepableNowMicro <= 0n) return 0n;
  if (!maxMicro || maxMicro <= 0n) return sweepableNowMicro;
  return sweepableNowMicro > maxMicro ? maxMicro : sweepableNowMicro;
}

export function reserveTreasurySweepAmountMicro(
  sweepableNowMicro: bigint,
  reserveMicro: bigint,
): bigint {
  if (sweepableNowMicro <= 0n) return 0n;
  if (reserveMicro <= 0n) return sweepableNowMicro;
  return max0Micro(sweepableNowMicro - reserveMicro);
}

export type RewardsTreasuryReport = {
  liabilityMode: "event_time_frozen";
  includePending: boolean;
  sources: {
    rewardsLiabilityVenues: string[];
    excludedFeeStreams: string[];
  };
  chains: Array<{
    chainId: string;
    grossCollectedFeesMicro: string;
    grossCollectedFees: number;
    liabilityCollectedMicro: string;
    liabilityCollected: number;
    liabilityPendingMicro: string;
    liabilityPending: number;
    claimedConfirmedMicro: string;
    claimedConfirmed: number;
    claimedOpenNonFailedMicro: string;
    claimedOpenNonFailed: number;
    claimedNonFailedMicro: string;
    claimedNonFailed: number;
    claimableNowMicro: string;
    claimableNow: number;
    outstandingCollectedPayableMicro: string;
    outstandingCollectedPayable: number;
    safetyBuffer: {
      bufferUsdMicro: string;
      bufferUsd: number;
      bufferPct: number;
      bufferAppliedMicro: string;
      bufferApplied: number;
    };
    reserveFloorMicro: string;
    reserveFloor: number;
    controlledHotBalanceMicro: string;
    controlledHotBalance: number;
    protocolReceivableBalanceMicro: string;
    protocolReceivableBalance: number;
    deficitNowMicro: string;
    deficitNow: number;
    economicSurplusMicro: string;
    economicSurplus: number;
    sweepableNowMicro: string;
    sweepableNow: number;
    payoutAddressConfigured: boolean;
    hotBalanceAvailable: boolean;
    hotBalanceError: string | null;
  }>;
};

export async function getRewardsTreasuryReport(
  pool: DbQuery,
  inputs?: { chainId?: string | null },
): Promise<RewardsTreasuryReport> {
  const chainFilter = resolveChainFilter(inputs?.chainId);
  const [liabilityByChain, claimsByChain] = await Promise.all([
    fetchLiabilityByChain(pool, chainFilter),
    fetchClaimsByChain(pool, chainFilter),
  ]);

  const chainIds = new Set<string>([
    ...Object.keys(liabilityByChain),
    ...Object.keys(claimsByChain),
  ]);
  if (chainFilter) {
    chainIds.add(chainFilter);
  } else {
    for (const chainId of REWARDS_CHAIN_IDS) {
      chainIds.add(chainId);
    }
  }

  const includePending = env.rewardsTreasuryIncludePending;
  const chains: RewardsTreasuryReport["chains"] = [];
  for (const chainId of Array.from(chainIds).sort((a, b) =>
    a.localeCompare(b),
  )) {
    const liability = liabilityByChain[chainId];
    const claims = claimsByChain[chainId];
    const grossCollectedFeesMicro = decimalToMicroFloor(
      liability?.gross_collected_fees,
    );
    const liabilityCollectedMicro = decimalToMicroFloor(liability?.collected);
    const liabilityPendingMicro = decimalToMicroFloor(liability?.pending);
    const claimedConfirmedMicro = decimalToMicroFloor(claims?.confirmed);
    const claimedOpenNonFailedMicro = decimalToMicroFloor(
      claims?.open_non_failed,
    );
    const claimedNonFailedMicro = decimalToMicroFloor(claims?.non_failed);

    const normalizedChainId = normalizeRewardsChainId(chainId);
    const hotBalance =
      normalizedChainId != null
        ? await fetchControlledHotBalance(normalizedChainId)
        : {
            available: false,
            balanceMicro: 0n,
            error: "unsupported chain id",
          };
    const controlledHotBalanceMicro = hotBalance.balanceMicro;
    const protocolReceivableBalanceMicro = 0n;
    const computed = computeTreasuryChainMath({
      liabilityCollectedMicro,
      liabilityPendingMicro,
      claimedConfirmedMicro,
      claimedNonFailedMicro,
      includePending,
      bufferUsd: env.rewardsTreasuryBufferUsd,
      bufferPct: env.rewardsTreasuryBufferPct,
      controlledHotBalanceMicro,
      protocolReceivableBalanceMicro,
    });

    chains.push({
      chainId,
      grossCollectedFeesMicro: grossCollectedFeesMicro.toString(),
      grossCollectedFees: microToNumber(grossCollectedFeesMicro),
      liabilityCollectedMicro: liabilityCollectedMicro.toString(),
      liabilityCollected: microToNumber(liabilityCollectedMicro),
      liabilityPendingMicro: liabilityPendingMicro.toString(),
      liabilityPending: microToNumber(liabilityPendingMicro),
      claimedConfirmedMicro: claimedConfirmedMicro.toString(),
      claimedConfirmed: microToNumber(claimedConfirmedMicro),
      claimedOpenNonFailedMicro: claimedOpenNonFailedMicro.toString(),
      claimedOpenNonFailed: microToNumber(claimedOpenNonFailedMicro),
      claimedNonFailedMicro: claimedNonFailedMicro.toString(),
      claimedNonFailed: microToNumber(claimedNonFailedMicro),
      claimableNowMicro: computed.claimableNowMicro.toString(),
      claimableNow: microToNumber(computed.claimableNowMicro),
      outstandingCollectedPayableMicro:
        computed.outstandingCollectedPayableMicro.toString(),
      outstandingCollectedPayable: microToNumber(
        computed.outstandingCollectedPayableMicro,
      ),
      safetyBuffer: {
        bufferUsdMicro: numberToMicroCeil(
          env.rewardsTreasuryBufferUsd,
        ).toString(),
        bufferUsd: microToNumber(
          numberToMicroCeil(env.rewardsTreasuryBufferUsd),
        ),
        bufferPct: env.rewardsTreasuryBufferPct,
        bufferAppliedMicro: computed.bufferAppliedMicro.toString(),
        bufferApplied: microToNumber(computed.bufferAppliedMicro),
      },
      reserveFloorMicro: computed.reserveFloorMicro.toString(),
      reserveFloor: microToNumber(computed.reserveFloorMicro),
      controlledHotBalanceMicro: controlledHotBalanceMicro.toString(),
      controlledHotBalance: microToNumber(controlledHotBalanceMicro),
      protocolReceivableBalanceMicro: protocolReceivableBalanceMicro.toString(),
      protocolReceivableBalance: microToNumber(protocolReceivableBalanceMicro),
      deficitNowMicro: computed.deficitNowMicro.toString(),
      deficitNow: microToNumber(computed.deficitNowMicro),
      economicSurplusMicro: computed.economicSurplusMicro.toString(),
      economicSurplus: microToNumber(computed.economicSurplusMicro),
      sweepableNowMicro: computed.sweepableNowMicro.toString(),
      sweepableNow: microToNumber(computed.sweepableNowMicro),
      payoutAddressConfigured: Boolean(resolvePayoutAddress(chainId)),
      hotBalanceAvailable: hotBalance.available,
      hotBalanceError: hotBalance.error ?? null,
    });
  }

  return {
    liabilityMode: "event_time_frozen",
    includePending,
    sources: {
      rewardsLiabilityVenues: ["polymarket", "kalshi", "limitless"],
      excludedFeeStreams: ["bridge"],
    },
    chains,
  };
}
