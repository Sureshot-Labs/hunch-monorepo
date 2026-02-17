import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { getEmbedStreamKey, type RedisClientType } from "@hunch/infra";
import { Interface, ethers } from "ethers";
import { AuthService, createAdminMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { abis } from "../lib/contracts.js";
import { normalizeRewardsChainId } from "../lib/rewards-chain.js";
import { getRedisStatus } from "../redis.js";
import { fetchActiveDebridgeConfig, insertDebridgeConfig } from "../repos/debridge-config.js";
import { fetchActiveFeePolicy, insertFeePolicy } from "../repos/fee-policy.js";
import { fetchActiveRewardsPolicy } from "../repos/rewards.js";
import { mergeUsersById } from "../admin-merge-user-core.js";
import { getRewardsPolicy } from "../services/rewards.js";
import { insertVolumeEventsWithMultiplier } from "../services/rewards-multiplier.js";
import { getRewardsTreasuryReport } from "../services/rewards-treasury.js";
import { fetchLimitlessOnchainSnapshot } from "../services/limitless-onchain.js";
import { fetchPolymarketOnchainSnapshot } from "../services/polymarket-onchain.js";
import {
  fetchEvmMulticall,
} from "../services/polygon-rpc.js";
import {
  fetchSolanaBalanceLamports,
  fetchSolanaTokenBalanceByOwnerAndMint,
  fetchSolanaTokenAccountBalance,
  fetchSolanaTokenAccountInfo,
  formatUiAmount,
} from "../services/solana-rpc.js";
import {
  adminFeePolicySchema,
  adminDebridgeConfigSchema,
  adminPointsSchema,
  adminRewardsTreasuryQuerySchema,
  adminRewardsPolicySchema,
  adminUserActiveSchema,
  adminUserAdminSchema,
  adminUserKalshiProofBypassSchema,
  adminUserActivityQuerySchema,
  adminUserMergeSchema,
  adminUserParamsSchema,
  adminUsersQuerySchema,
} from "../schemas/admin.js";

const MAX_FEE_SCALE = 10_000;
const MAX_FEE_BPS = 10_000;
const MAX_FEE_COLLECT_ATTEMPTS = 5;
const DEBRIDGE_CONFIG_TTL_MS = 30_000;
const POLYGON_MULTICALL_ADDRESS =
  env.polygonMulticallAddress?.trim() ||
  "0xca11bde05977b3631167028862be2a173976ca11";
const EMBED_INDEX_MARKET = "idx:ai:embed:market";
const EMBED_INDEX_EVENT = "idx:ai:embed:event";
const EMBED_DLQ_KEY = "ai:embed:dead";

const DEBRIDGE_CHAIN_META: Record<
  string,
  { label: string; kind: "evm" | "solana"; explorer: string }
> = {
  "137": { label: "Polygon", kind: "evm", explorer: "https://polygonscan.com/address/" },
  "8453": { label: "Base", kind: "evm", explorer: "https://basescan.org/address/" },
  "7565164": { label: "Solana", kind: "solana", explorer: "https://solscan.io/account/" },
};

type DebridgeConfig = {
  dlnBase: string;
  statsBase: string;
  affiliateFeePercent: number;
  affiliateFeeRecipients: Record<string, string>;
  referralCode: number;
  source: "env" | "db";
};

let cachedDebridgeConfig: { value: DebridgeConfig; expiresAt: number } | null =
  null;
let debridgeConfigInflight: Promise<DebridgeConfig> | null = null;

function parseAffiliateRecipientMap(raw: string): Record<string, string> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    if (trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object") {
        const map: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value !== "string") continue;
          const recipient = value.trim();
          if (!recipient) continue;
          map[String(key).trim()] = recipient;
        }
        return map;
      }
    }
  } catch {
    // fallback to text parsing
  }
  const map: Record<string, string> = {};
  for (const entry of trimmed.split(",")) {
    const [chainId, recipient] = entry.split(":");
    if (!chainId || !recipient) continue;
    const chainKey = chainId.trim();
    const address = recipient.trim();
    if (!chainKey || !address) continue;
    map[chainKey] = address;
  }
  return map;
}

async function getDebridgeConfig(): Promise<DebridgeConfig> {
  const now = Date.now();
  if (cachedDebridgeConfig && cachedDebridgeConfig.expiresAt > now) {
    return cachedDebridgeConfig.value;
  }
  if (debridgeConfigInflight) return debridgeConfigInflight;

  const load = async () => {
    const row = await fetchActiveDebridgeConfig(pool);
    const config: DebridgeConfig = {
      dlnBase: row?.dln_base?.trim() || env.debridgeDlnBase,
      statsBase: row?.stats_base?.trim() || env.debridgeStatsBase,
      affiliateFeePercent:
        row?.affiliate_fee_percent != null
          ? Number(row.affiliate_fee_percent)
          : env.debridgeAffiliateFeePercent,
      affiliateFeeRecipients: row?.affiliate_fee_recipients ?? parseAffiliateRecipientMap(env.debridgeAffiliateFeeRecipients || ""),
      referralCode:
        row?.referral_code != null
          ? Number(row.referral_code)
          : env.debridgeReferralCode,
      source: row ? "db" : "env",
    };
    cachedDebridgeConfig = { value: config, expiresAt: now + DEBRIDGE_CONFIG_TTL_MS };
    return config;
  };

  debridgeConfigInflight = load().finally(() => {
    debridgeConfigInflight = null;
  });
  return debridgeConfigInflight;
}

function clampFeeBps(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), MAX_FEE_BPS);
}

function clampFeeScale(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.min(Math.max(value, 0), MAX_FEE_SCALE);
}

function toOptionalNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function fetchIndexCount(
  redis: RedisClientType,
  indexName: string,
  query: string,
): Promise<{ count: number | null; error: string | null }> {
  try {
    const response = (await redis.sendCommand([
      "FT.SEARCH",
      indexName,
      query,
      "RETURN",
      "0",
      "LIMIT",
      "0",
      "0",
    ])) as unknown[];
    const count = toOptionalNumber(response?.[0]) ?? null;
    return { count, error: count == null ? "Invalid index count" : null };
  } catch (error) {
    return {
      count: null,
      error: error instanceof Error ? error.message : "Index count failed",
    };
  }
}

async function resolveUserIdByWallet(walletAddress: string) {
  const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
  const trimmed = walletAddress.trim();
  const match = ETH_ADDRESS_RE.test(trimmed)
    ? "lower(wallet_address) = lower($1)"
    : "wallet_address = $1";
  const { rows } = await pool.query<{ user_id: string }>(
    `
      select user_id
      from user_wallets
      where ${match}
    `,
    [trimmed],
  );
  const unique = Array.from(new Set(rows.map((row) => row.user_id)));
  if (unique.length === 0) return null;
  if (unique.length > 1) {
    throw new Error("Multiple users found for wallet; specify userId");
  }
  return unique[0];
}

async function fetchPrimaryWallet(userId: string) {
  const { rows } = await pool.query<{ wallet_address: string | null }>(
    `
      select wallet_address
      from user_wallets
      where user_id = $1
      order by is_primary desc, created_at asc
      limit 1
    `,
    [userId.trim()],
  );
  return rows[0]?.wallet_address ?? null;
}

async function fetchPolymarketBalances(inputs: {
  userId: string;
  walletAddress: string;
}): Promise<{
  funder: string;
  funderBalance: bigint;
  signerBalance: bigint | null;
}> {
  const credsInfo = await AuthService.getVenueCredentialsInfo(
    inputs.userId,
    "polymarket",
    inputs.walletAddress,
  );
  const funder = credsInfo?.funderAddress ?? inputs.walletAddress;
  const snapshot = await fetchPolymarketOnchainSnapshot({
    rpcUrl: env.polygonRpcUrl,
    timeoutMs: env.polygonRpcTimeoutMs,
    signer: inputs.walletAddress,
    funder,
    includeSignerUsdc: funder.toLowerCase() !== inputs.walletAddress.toLowerCase(),
    negRiskAdapterAddress: env.polymarketNegRiskAdapterAddress,
    feeCollectorAddress: env.feeCollectorAddress,
  });
  return {
    funder,
    funderBalance: snapshot.usdcBalance,
    signerBalance: snapshot.signerUsdcBalance ?? null,
  };
}

async function fetchLimitlessBalance(
  walletAddress: string,
): Promise<bigint> {
  const snapshot = await fetchLimitlessOnchainSnapshot({
    rpcUrl: env.baseRpcUrl,
    timeoutMs: env.baseRpcTimeoutMs,
    owner: walletAddress,
  });
  return snapshot.usdcBalance;
}

async function fetchFeeCollectorConfig(address: string): Promise<{
  treasury: string;
  collateral: string;
} | null> {
  const collector = address.trim();
  if (!collector) return null;

  const iface = new Interface(abis.PolymarketFeeCollector);
  const calls = [
    {
      target: collector,
      callData: iface.encodeFunctionData("treasury"),
      allowFailure: false,
    },
    {
      target: collector,
      callData: iface.encodeFunctionData("COLLATERAL"),
      allowFailure: false,
    },
  ];

  const results = await fetchEvmMulticall({
    rpcUrl: env.polygonRpcUrl,
    timeoutMs: env.polygonRpcTimeoutMs,
    multicallAddress: POLYGON_MULTICALL_ADDRESS,
    calls,
  });

  const [treasuryResult, collateralResult] = results;
  if (!treasuryResult?.success || !collateralResult?.success) return null;

  const treasuryDecoded = iface.decodeFunctionResult(
    "treasury",
    treasuryResult.returnData,
  ) as unknown;
  const collateralDecoded = iface.decodeFunctionResult(
    "COLLATERAL",
    collateralResult.returnData,
  ) as unknown;

  const treasury = Array.isArray(treasuryDecoded)
    ? treasuryDecoded[0]
    : null;
  const collateral = Array.isArray(collateralDecoded)
    ? collateralDecoded[0]
    : null;

  if (typeof treasury !== "string" || typeof collateral !== "string")
    return null;

  return {
    treasury: ethers.getAddress(treasury),
    collateral: ethers.getAddress(collateral),
  };
}

async function fetchErc20Balance(inputs: {
  tokenAddress: string;
  owner: string;
  rpcUrl: string;
  multicallAddress: string;
}): Promise<bigint> {
  const iface = new Interface([
    "function balanceOf(address owner) view returns (uint256)",
  ]);

  const [result] = await fetchEvmMulticall({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: env.polygonRpcTimeoutMs,
    multicallAddress: inputs.multicallAddress,
    calls: [
      {
        target: inputs.tokenAddress,
        callData: iface.encodeFunctionData("balanceOf", [inputs.owner]),
        allowFailure: false,
      },
    ],
  });

  if (!result?.success) return 0n;
  const decoded = iface.decodeFunctionResult(
    "balanceOf",
    result.returnData,
  ) as unknown;
  const value = Array.isArray(decoded) ? decoded[0] : null;
  return typeof value === "bigint" ? value : 0n;
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  z.get(
    "/admin/overview",
    { preHandler: createAdminMiddleware() },
    async (_request, reply) => {
      const feeCollectorAddress = env.feeCollectorAddress?.trim() || "";
      const feeCollectorPrivateKey = env.feeCollectorPrivateKey?.trim() || "";
      const dflowFeeAccount = env.dflowFeeAccount?.trim() || "";
      let feeCollectorError: string | null = null;
      let feeCollectorTreasury: string | null = null;
      let feeCollectorCollateral: string | null = null;
      let feeCollectorTreasuryBalance: bigint | null = null;
      let feeCollectorSignerAddress: string | null = null;
      let feeCollectorSignerBalance: bigint | null = null;
      let feeCollectorSignerError: string | null = null;
      let dflowFeeBalance: bigint | null = null;
      let dflowFeeError: string | null = null;
      let dflowFeeOwner: string | null = null;
      let dflowFeeMint: string | null = null;

      const debridgeConfig = await getDebridgeConfig();
      const debridgeRecipients = Object.entries(
        debridgeConfig.affiliateFeeRecipients,
      );
      const debridgeRecipientBalances = await Promise.all(
        debridgeRecipients.map(async ([chainId, address]) => {
          const meta = DEBRIDGE_CHAIN_META[chainId] ?? {
            label: chainId,
            kind: "evm" as const,
            explorer: "",
          };
          try {
            if (meta.kind === "solana") {
              const usdc = await fetchSolanaTokenBalanceByOwnerAndMint({
                rpcUrls: env.solanaRpcUrls,
                timeoutMs: env.solanaRpcTimeoutMs,
                owner: address,
                mint: env.solanaUsdcMint,
              });
              const amount = usdc?.amount ?? 0n;
              const decimals = usdc?.decimals ?? 6;
              return {
                chainId,
                chainLabel: meta.label,
                address,
                asset: "USDC",
                balance: formatUiAmount(amount, decimals),
                balanceRaw: amount.toString(),
                mint: env.solanaUsdcMint,
                explorer: meta.explorer,
              };
            }

            const isBase = chainId === "8453";
            const tokenAddress = isBase
              ? env.limitlessUsdcAddress
              : env.polymarketUsdcAddress;
            const rpcUrl = isBase ? env.baseRpcUrl : env.polygonRpcUrl;
            const multicallAddress = isBase
              ? env.baseMulticallAddress
              : POLYGON_MULTICALL_ADDRESS;
            const balance = await fetchErc20Balance({
              tokenAddress,
              owner: address,
              rpcUrl,
              multicallAddress,
            });
            return {
              chainId,
              chainLabel: meta.label,
              address,
              asset: "USDC",
              balance: ethers.formatUnits(balance, 6),
              balanceRaw: balance.toString(),
              tokenAddress,
              explorer: meta.explorer,
            };
          } catch (error) {
            return {
              chainId,
              chainLabel: meta.label,
              address,
              asset: "USDC",
              balance: null,
              balanceRaw: null,
              explorer: meta.explorer,
              error:
                error instanceof Error
                  ? error.message
                  : "Balance fetch failed",
            };
          }
        }),
      );

      if (feeCollectorAddress) {
        try {
          const config = await fetchFeeCollectorConfig(feeCollectorAddress);
          feeCollectorTreasury = config?.treasury ?? null;
          feeCollectorCollateral = config?.collateral ?? null;
          if (feeCollectorTreasury && feeCollectorCollateral) {
            feeCollectorTreasuryBalance = await fetchErc20Balance({
              tokenAddress: feeCollectorCollateral,
              owner: feeCollectorTreasury,
              rpcUrl: env.polygonRpcUrl,
              multicallAddress: POLYGON_MULTICALL_ADDRESS,
            });
          }
        } catch (error) {
          feeCollectorError =
            error instanceof Error ? error.message : "Fee collector fetch failed";
        }
      }

      if (feeCollectorPrivateKey) {
        try {
          const signer = new ethers.Wallet(feeCollectorPrivateKey);
          feeCollectorSignerAddress = signer.address;
          const provider = new ethers.JsonRpcProvider(env.polygonRpcUrl);
          feeCollectorSignerBalance = await provider.getBalance(signer.address);
        } catch (error) {
          feeCollectorSignerError =
            error instanceof Error
              ? error.message
              : "Fee collector signer fetch failed";
        }
      }

      if (dflowFeeAccount) {
        try {
          const info = await fetchSolanaTokenAccountInfo({
            rpcUrls: env.solanaRpcUrls,
            timeoutMs: env.solanaRpcTimeoutMs,
            account: dflowFeeAccount,
          });
          dflowFeeOwner = info?.owner ?? null;
          dflowFeeMint = info?.mint ?? null;
          const usdc = await fetchSolanaTokenAccountBalance({
            rpcUrls: env.solanaRpcUrls,
            timeoutMs: env.solanaRpcTimeoutMs,
            account: dflowFeeAccount,
          });
          dflowFeeBalance = usdc ? usdc.amount : null;
        } catch (error) {
          dflowFeeError =
            error instanceof Error ? error.message : "Balance fetch failed";
        }
      }

      const pendingFeeParams: Array<string | number> = [
        MAX_FEE_COLLECT_ATTEMPTS,
      ];
      let pendingFeeWhere = `
        where venue = 'polymarket'
          and order_hash is not null
          and fee_auth is not null
          and fee_auth_sig is not null
          and order_payload is not null
          and fee_collected_at is null
          and fee_collect_error is null
          and coalesce(fee_collect_attempts, 0) < $1
      `;
      if (feeCollectorAddress) {
        pendingFeeParams.push(feeCollectorAddress.toLowerCase());
        pendingFeeWhere += ` and (fee_collector_address is null or lower(fee_collector_address) = $${pendingFeeParams.length})`;
      }

      const { rows: pendingFeeRows } = await pool.query<{ count: string }>(
        `
          select count(*)::text as count
          from orders
          ${pendingFeeWhere}
        `,
        pendingFeeParams,
      );

      const { rows: pendingClaimsRows } = await pool.query<{ count: string }>(
        `
          select count(*)::text as count
          from reward_claims
          where status = 'pending'
        `,
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        feeCollector: {
          address: feeCollectorAddress || null,
          treasuryAddress: feeCollectorTreasury,
          collateralAddress: feeCollectorCollateral,
          configured: Boolean(feeCollectorAddress),
          hasPrivateKey: Boolean(feeCollectorPrivateKey),
          chainId: 137,
          tokenAddress: feeCollectorCollateral ?? env.polymarketUsdcAddress,
          balance:
            feeCollectorTreasuryBalance !== null
              ? ethers.formatUnits(feeCollectorTreasuryBalance, 6)
              : null,
          balanceRaw: feeCollectorTreasuryBalance?.toString() ?? null,
          signerAddress: feeCollectorSignerAddress,
          signerBalance:
            feeCollectorSignerBalance !== null
              ? ethers.formatEther(feeCollectorSignerBalance)
              : null,
          signerBalanceRaw: feeCollectorSignerBalance?.toString() ?? null,
          error: feeCollectorError,
          signerError: feeCollectorSignerError,
        },
        dflowFeeAccount: {
          address: dflowFeeAccount || null,
          ownerAddress: dflowFeeOwner,
          configured: Boolean(dflowFeeAccount),
          chainId: "solana",
          mint: dflowFeeMint ?? env.solanaUsdcMint,
          balance:
            dflowFeeBalance !== null
              ? formatUiAmount(dflowFeeBalance, 6)
              : null,
          balanceRaw: dflowFeeBalance?.toString() ?? null,
          error: dflowFeeError,
        },
        pending: {
          feeOrders: Number(pendingFeeRows[0]?.count ?? 0),
          rewardClaims: Number(pendingClaimsRows[0]?.count ?? 0),
        },
        debridge: {
          dlnBase: debridgeConfig.dlnBase,
          statsBase: debridgeConfig.statsBase,
          affiliateFeePercent: debridgeConfig.affiliateFeePercent,
          affiliateFeeRecipients: JSON.stringify(
            debridgeConfig.affiliateFeeRecipients,
          ),
          referralCode: debridgeConfig.referralCode,
          recipients: debridgeRecipientBalances,
          source: debridgeConfig.source,
        },
      });
    },
  );

  z.get(
    "/admin/vector",
    { preHandler: createAdminMiddleware() },
    async (_request, reply) => {
      const streamKey = getEmbedStreamKey();
      const groupName = process.env.AI_EMBED_GROUP ?? "ai-embedder";
      const generatedAt = new Date().toISOString();

      const [{ rows: eventRows }, { rows: marketRows }] = await Promise.all([
        pool.query<{ total: string; active: string }>(
          `
            select
              count(*)::text as total,
              count(*) filter (where status = 'ACTIVE')::text as active
            from unified_events
          `,
        ),
        pool.query<{ total: string; active: string }>(
          `
            select
              count(*)::text as total,
              count(*) filter (where status = 'ACTIVE')::text as active
            from unified_markets
          `,
        ),
      ]);

      const eventDbTotal = Number(eventRows[0]?.total ?? 0);
      const eventDbActive = Number(eventRows[0]?.active ?? 0);
      const marketDbTotal = Number(marketRows[0]?.total ?? 0);
      const marketDbActive = Number(marketRows[0]?.active ?? 0);

      const { redis, status, error: redisError } = await getRedisStatus();
      const redisStats: {
        available: boolean;
        error: string | null;
        stream: {
          key: string;
          length: number | null;
          group: string;
          lag: number | null;
          pending: number | null;
          consumers: number | null;
        };
        dlq: { key: string; length: number | null };
        indexes: {
          event: { total: number | null; active: number | null; error: string | null };
          market: { total: number | null; active: number | null; error: string | null };
        };
      } = {
        available: false,
        error:
          status === "loading"
            ? "Redis loading"
            : status === "error"
              ? redisError ?? "Redis unavailable"
              : "Redis not configured",
        stream: {
          key: streamKey,
          length: null,
          group: groupName,
          lag: null,
          pending: null,
          consumers: null,
        },
        dlq: { key: EMBED_DLQ_KEY, length: null },
        indexes: {
          event: { total: null, active: null, error: null },
          market: { total: null, active: null, error: null },
        },
      };

      if (redis) {
        redisStats.available = true;
        redisStats.error = null;

        const [eventTotal, eventActive, marketTotal, marketActive] =
          await Promise.all([
            fetchIndexCount(redis, EMBED_INDEX_EVENT, "*"),
            fetchIndexCount(redis, EMBED_INDEX_EVENT, "@status:{ACTIVE}"),
            fetchIndexCount(redis, EMBED_INDEX_MARKET, "*"),
            fetchIndexCount(redis, EMBED_INDEX_MARKET, "@status:{ACTIVE}"),
          ]);

        redisStats.indexes.event = {
          total: eventTotal.count,
          active: eventActive.count,
          error: eventTotal.error ?? eventActive.error,
        };
        redisStats.indexes.market = {
          total: marketTotal.count,
          active: marketActive.count,
          error: marketTotal.error ?? marketActive.error,
        };

        try {
          const [streamLength, dlqLength] = await Promise.all([
            redis.xLen(streamKey),
            redis.xLen(EMBED_DLQ_KEY),
          ]);
          redisStats.stream.length = streamLength;
          redisStats.dlq.length = dlqLength;
        } catch (error) {
          redisStats.error =
            error instanceof Error ? error.message : "Redis stream lookup failed";
        }

        try {
          const groups = await redis.xInfoGroups(streamKey);
          const group = groups.find((entry) => entry.name === groupName);
          if (group) {
            redisStats.stream.lag = toOptionalNumber(group.lag);
            redisStats.stream.pending = toOptionalNumber(group.pending);
            redisStats.stream.consumers = toOptionalNumber(group.consumers);
          }
        } catch (error) {
          redisStats.error =
            redisStats.error ??
            (error instanceof Error
              ? error.message
              : "Redis consumer info failed");
        }
      }

      const buildCoverage = (options: {
        dbTotal: number;
        dbActive: number;
        embeddedTotal: number | null;
        embeddedActive: number | null;
      }) => {
        const embeddedInactive =
          options.embeddedTotal != null && options.embeddedActive != null
            ? Math.max(options.embeddedTotal - options.embeddedActive, 0)
            : null;
        const coverageActive =
          options.embeddedActive != null && options.dbActive > 0
            ? options.embeddedActive / options.dbActive
            : null;
        return {
          dbTotal: options.dbTotal,
          dbActive: options.dbActive,
          embeddedTotal: options.embeddedTotal,
          embeddedActive: options.embeddedActive,
          embeddedInactive,
          coverageActive,
        };
      };

      return reply.send({
        ok: true,
        generatedAt,
        coverage: {
          events: buildCoverage({
            dbTotal: eventDbTotal,
            dbActive: eventDbActive,
            embeddedTotal: redisStats.indexes.event.total,
            embeddedActive: redisStats.indexes.event.active,
          }),
          markets: buildCoverage({
            dbTotal: marketDbTotal,
            dbActive: marketDbActive,
            embeddedTotal: redisStats.indexes.market.total,
            embeddedActive: redisStats.indexes.market.active,
          }),
        },
        redis: redisStats,
      });
    },
  );

  z.get(
    "/admin/users",
    {
      preHandler: createAdminMiddleware(),
      schema: { querystring: adminUsersQuerySchema },
    },
    async (request, reply) => {
      const query = request.query;
      const q = query.q?.trim();
      const limit = query.limit ?? 25;
      const offset = query.offset ?? 0;

      const conditions: string[] = [];
      const params: Array<string | number> = [];

      if (q) {
        params.push(q);
        const idx = params.length;
        conditions.push(
          `
            (
              u.id::text = $${idx}
              or u.email ilike '%' || $${idx} || '%'
              or u.username ilike '%' || $${idx} || '%'
              or u.display_name ilike '%' || $${idx} || '%'
              or exists (
                select 1
                from user_wallets wq
                where wq.user_id = u.id
                  and (lower(wq.wallet_address) = lower($${idx}) or wq.wallet_address = $${idx})
              )
            )
          `,
        );
      }

      const whereClause = conditions.length
        ? `where ${conditions.join(" and ")}`
        : "";

      const countParams = [...params];
      const { rows: countRows } = await pool.query<{ total: string }>(
        `
          select count(*)::text as total
          from users u
          ${whereClause}
        `,
        countParams,
      );

      params.push(limit);
      const limitIdx = params.length;
      params.push(offset);
      const offsetIdx = params.length;

      const { rows } = await pool.query<{
        id: string;
        email: string | null;
        username: string | null;
        display_name: string | null;
        is_admin: boolean | null;
        kalshi_proof_bypass: boolean | null;
        is_active: boolean | null;
        last_login_at: Date | null;
        created_at: Date;
        wallet_address: string | null;
        points: string | null;
        fee_usd_total: string | null;
        fee_usd_collected: string | null;
        referral_count: string | null;
      }>(
        `
          select
            u.id,
            u.email,
            u.username,
            u.display_name,
            u.is_admin,
            u.kalshi_proof_bypass,
            u.is_active,
            u.last_login_at,
            u.created_at,
            primary_wallet.wallet_address,
            points.total as points,
            fees.total_fee_usd as fee_usd_total,
            fees.collected_fee_usd as fee_usd_collected,
            refs.referral_count
          from users u
          left join lateral (
            select wallet_address
            from user_wallets
            where user_id = u.id
            order by is_primary desc, created_at asc
            limit 1
          ) primary_wallet on true
          left join lateral (
            select coalesce(sum(points_awarded), 0)::text as total
            from volume_events
            where user_id = u.id
          ) points on true
          left join lateral (
            select
              coalesce(sum(fee_usd), 0)::text as total_fee_usd,
              coalesce(sum(case when status = 'collected' then fee_usd else 0 end), 0)::text as collected_fee_usd
            from fee_events
            where user_id = u.id
          ) fees on true
          left join lateral (
            select count(*)::text as referral_count
            from referrals
            where referrer_user_id = u.id
          ) refs on true
          ${whereClause}
          order by u.created_at desc
          limit $${limitIdx} offset $${offsetIdx}
        `,
        params,
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        users: rows.map((row) => ({
          id: row.id,
          email: row.email,
          username: row.username,
          displayName: row.display_name,
          isAdmin: Boolean(row.is_admin),
          kalshiProofBypass: Boolean(row.kalshi_proof_bypass),
          isActive: row.is_active ?? true,
          lastLoginAt: row.last_login_at,
          createdAt: row.created_at,
          walletAddress: row.wallet_address ?? null,
          points: Number(row.points ?? 0),
          feeUsdTotal: Number(row.fee_usd_total ?? 0),
          feeUsdCollected: Number(row.fee_usd_collected ?? 0),
          referralCount: Number(row.referral_count ?? 0),
        })),
        total: Number(countRows[0]?.total ?? 0),
        limit,
        offset,
      });
    },
  );

  z.get(
    "/admin/users/:id",
    {
      preHandler: createAdminMiddleware(),
      schema: { params: adminUserParamsSchema },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { rows: userRows } = await pool.query<{
        id: string;
        email: string | null;
        username: string | null;
        display_name: string | null;
        is_admin: boolean | null;
        kalshi_proof_bypass: boolean | null;
        is_active: boolean | null;
        last_login_at: Date | null;
        created_at: Date;
      }>(
        `
          select id, email, username, display_name, is_admin, kalshi_proof_bypass, is_active, last_login_at, created_at
          from users
          where id = $1
          limit 1
        `,
        [id],
      );

      const user = userRows[0];
      if (!user) {
        reply.code(404);
        return reply.send({ error: "User not found" });
      }

      const { rows: walletRows } = await pool.query<{
        id: string;
        wallet_address: string;
        wallet_type: string;
        is_primary: boolean;
        is_verified: boolean;
        created_at: Date;
        updated_at: Date;
        polymarket_funder_address: string | null;
        polymarket_funder_updated_at: Date | null;
      }>(
        `
          select
            w.id,
            w.wallet_address,
            w.wallet_type,
            w.is_primary,
            w.is_verified,
            w.created_at,
            w.updated_at,
            v.funder_address as polymarket_funder_address,
            v.funder_updated_at as polymarket_funder_updated_at
          from user_wallets w
          left join user_venue_credentials v
            on v.user_id = w.user_id
            and v.wallet_address = w.wallet_address
            and v.venue = 'polymarket'
            and v.is_active = true
          where w.user_id = $1
          order by w.is_primary desc, w.created_at asc
        `,
        [id],
      );

      const { rows: pointsRows } = await pool.query<{ total: string | null }>(
        `select coalesce(sum(points_awarded), 0)::text as total from volume_events where user_id = $1`,
        [id],
      );

      const { rows: feeRows } = await pool.query<{
        total_fee_usd: string | null;
        collected_fee_usd: string | null;
      }>(
        `
          select
            coalesce(sum(fee_usd), 0)::text as total_fee_usd,
            coalesce(sum(case when status = 'collected' then fee_usd else 0 end), 0)::text as collected_fee_usd
          from fee_events
          where user_id = $1
        `,
        [id],
      );

      const { rows: referralRows } = await pool.query<{ count: string }>(
        `select count(*)::text as count from referrals where referrer_user_id = $1`,
        [id],
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          displayName: user.display_name,
          isAdmin: Boolean(user.is_admin),
          kalshiProofBypass: Boolean(user.kalshi_proof_bypass),
          isActive: user.is_active ?? true,
          lastLoginAt: user.last_login_at,
          createdAt: user.created_at,
        },
        wallets: walletRows.map((row) => ({
          id: row.id,
          walletAddress: row.wallet_address,
          walletType: row.wallet_type,
          isPrimary: row.is_primary,
          isVerified: row.is_verified,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          polymarketFunderAddress: row.polymarket_funder_address,
          polymarketFunderUpdatedAt: row.polymarket_funder_updated_at,
        })),
        stats: {
          points: Number(pointsRows[0]?.total ?? 0),
          feeUsdTotal: Number(feeRows[0]?.total_fee_usd ?? 0),
          feeUsdCollected: Number(feeRows[0]?.collected_fee_usd ?? 0),
          referralCount: Number(referralRows[0]?.count ?? 0),
        },
      });
    },
  );

  z.get(
    "/admin/users/:id/balances",
    {
      preHandler: createAdminMiddleware(),
      schema: { params: adminUserParamsSchema },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { rows: userRows } = await pool.query<{ id: string }>(
        `select id from users where id = $1 limit 1`,
        [id],
      );
      if (!userRows.length) {
        reply.code(404);
        return reply.send({ error: "User not found" });
      }

      const { rows: walletRows } = await pool.query<{
        wallet_address: string;
        wallet_type: string;
      }>(
        `
          select wallet_address, wallet_type
          from user_wallets
          where user_id = $1
          order by is_primary desc, created_at asc
        `,
        [id],
      );

      const wallets = await Promise.all(
        walletRows.map(async (wallet) => {
          const balances: Array<{
            venue: string;
            chainId: string | number;
            asset: string;
            balance: string | null;
            balanceRaw: string | null;
            tokenAddress?: string;
            mint?: string;
            error?: string;
          }> = [];

          if (wallet.wallet_type === "ethereum") {
            const polymarketEntries = await (async () => {
              try {
                const data = await fetchPolymarketBalances({
                  userId: id,
                  walletAddress: wallet.wallet_address,
                });
                const entries = [
                  {
                    venue: "polymarket",
                    chainId: 137,
                    asset: "USDC",
                    balance: ethers.formatUnits(data.funderBalance, 6),
                    balanceRaw: data.funderBalance.toString(),
                    tokenAddress: env.polymarketUsdcAddress,
                    accountAddress: data.funder,
                    accountLabel:
                      data.funder.toLowerCase() ===
                      wallet.wallet_address.toLowerCase()
                        ? "wallet"
                        : "funder",
                  },
                ];
                if (
                  data.signerBalance !== null &&
                  data.funder.toLowerCase() !==
                    wallet.wallet_address.toLowerCase()
                ) {
                  entries.push({
                    venue: "polymarket",
                    chainId: 137,
                    asset: "USDC",
                    balance: ethers.formatUnits(data.signerBalance, 6),
                    balanceRaw: data.signerBalance.toString(),
                    tokenAddress: env.polymarketUsdcAddress,
                    accountAddress: wallet.wallet_address,
                    accountLabel: "signer",
                  });
                }
                return entries;
              } catch (error) {
                return [
                  {
                    venue: "polymarket",
                    chainId: 137,
                    asset: "USDC",
                    balance: null,
                    balanceRaw: null,
                    tokenAddress: env.polymarketUsdcAddress,
                    accountAddress: wallet.wallet_address,
                    accountLabel: "wallet",
                    error:
                      error instanceof Error
                        ? error.message
                        : "Balance fetch failed",
                  },
                ];
              }
            })();
            balances.push(...polymarketEntries);

            const limitless = await (async () => {
              try {
                const balance = await fetchLimitlessBalance(
                  wallet.wallet_address,
                );
                return {
                  venue: "limitless",
                  chainId: 8453,
                  asset: "USDC",
                  balance: ethers.formatUnits(balance, 6),
                  balanceRaw: balance.toString(),
                  tokenAddress: env.limitlessUsdcAddress,
                  accountAddress: wallet.wallet_address,
                };
              } catch (error) {
                return {
                  venue: "limitless",
                  chainId: 8453,
                  asset: "USDC",
                  balance: null,
                  balanceRaw: null,
                  tokenAddress: env.limitlessUsdcAddress,
                  accountAddress: wallet.wallet_address,
                  error:
                    error instanceof Error
                      ? error.message
                      : "Balance fetch failed",
                };
              }
            })();
            balances.push(limitless);
          }

          if (wallet.wallet_type === "solana") {
            const solana = await (async () => {
              try {
                const [solLamports, usdc] = await Promise.all([
                  fetchSolanaBalanceLamports({
                    rpcUrls: env.solanaRpcUrls,
                    timeoutMs: env.solanaRpcTimeoutMs,
                    owner: wallet.wallet_address,
                  }),
                  fetchSolanaTokenBalanceByOwnerAndMint({
                    rpcUrls: env.solanaRpcUrls,
                    timeoutMs: env.solanaRpcTimeoutMs,
                    owner: wallet.wallet_address,
                    mint: env.solanaUsdcMint,
                  }),
                ]);

                const usdcDecimals = usdc?.decimals ?? 6;
                const usdcAmount = usdc?.amount ?? 0n;

                return [
                  {
                    venue: "kalshi",
                    chainId: "solana",
                    asset: "SOL",
                    balance: formatUiAmount(solLamports, 9),
                    balanceRaw: solLamports.toString(),
                  },
                  {
                    venue: "kalshi",
                    chainId: "solana",
                    asset: "USDC",
                    balance: formatUiAmount(usdcAmount, usdcDecimals),
                    balanceRaw: usdcAmount.toString(),
                    mint: env.solanaUsdcMint,
                  },
                ];
              } catch (error) {
                const message =
                  error instanceof Error
                    ? error.message
                    : "Balance fetch failed";
                return [
                  {
                    venue: "kalshi",
                    chainId: "solana",
                    asset: "SOL",
                    balance: null,
                    balanceRaw: null,
                    error: message,
                  },
                  {
                    venue: "kalshi",
                    chainId: "solana",
                    asset: "USDC",
                    balance: null,
                    balanceRaw: null,
                    mint: env.solanaUsdcMint,
                    error: message,
                  },
                ];
              }
            })();
            balances.push(...solana);
          }

          return {
            walletAddress: wallet.wallet_address,
            walletType: wallet.wallet_type,
            balances,
          };
        }),
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        wallets,
      });
    },
  );

  z.get(
    "/admin/users/:id/activity",
    {
      preHandler: createAdminMiddleware(),
      schema: { params: adminUserParamsSchema, querystring: adminUserActivityQuerySchema },
    },
    async (request, reply) => {
      const { id } = request.params;
      const limit = request.query.limit ?? 20;
      const polymarketUsdc = env.polymarketUsdcAddress;
      const limitlessUsdc = env.limitlessUsdcAddress;
      const solanaUsdc = env.solanaUsdcMint;

      const { rows: userRows } = await pool.query<{ id: string }>(
        `select id from users where id = $1 limit 1`,
        [id],
      );
      if (!userRows.length) {
        reply.code(404);
        return reply.send({ error: "User not found" });
      }

      const { rows } = await pool.query<{
        id: string;
        type: string;
        venue: string;
        side: string | null;
        status: string | null;
        wallet_address: string | null;
        created_at: Date;
        amount_usd: string | null;
        ref: string | null;
      }>(
        `
          select *
          from (
            select
              o.id::text as id,
              'order' as type,
              o.venue as venue,
              o.side as side,
              o.status as status,
              o.wallet_address as wallet_address,
              coalesce(o.posted_at, o.last_update) as created_at,
              (coalesce(o.filled_size, o.size) * coalesce(o.average_fill_price, o.price))::numeric as amount_usd,
              coalesce(o.venue_order_id, o.token_id) as ref
            from orders o
            where o.user_id = $1

            union all

            select
              e.id::text as id,
              'execution' as type,
              e.venue as venue,
              e.side as side,
              e.status as status,
              e.wallet_address as wallet_address,
              e.created_at as created_at,
              case
                when e.input_mint is not null and lower(e.input_mint) = lower($3) then (e.amount_in / 1000000)
                when e.output_mint is not null and lower(e.output_mint) = lower($3) then (e.amount_out / 1000000)
                when e.input_mint is not null and lower(e.input_mint) = lower($4) then (e.amount_in / 1000000)
                when e.output_mint is not null and lower(e.output_mint) = lower($4) then (e.amount_out / 1000000)
                when e.input_mint = $5 then (e.amount_in / 1000000)
                when e.output_mint = $5 then (e.amount_out / 1000000)
                else null
              end as amount_usd,
              coalesce(e.tx_signature, e.venue_order_id) as ref
            from executions e
            where e.user_id = $1

            union all

            select
              c.id::text as id,
              'claim' as type,
              'rewards' as venue,
              null as side,
              c.status as status,
              c.wallet_address as wallet_address,
              c.created_at as created_at,
              c.amount_usdc as amount_usd,
              c.tx_hash as ref
            from reward_claims c
            where c.user_id = $1
          ) activity
          order by created_at desc
          limit $2
        `,
        [id, limit, polymarketUsdc, limitlessUsdc, solanaUsdc],
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        items: rows.map((row) => ({
          id: row.id,
          type: row.type,
          venue: row.venue,
          side: row.side,
          status: row.status,
          walletAddress: row.wallet_address,
          createdAt: row.created_at,
          amountUsd: row.amount_usd != null ? Number(row.amount_usd) : null,
          ref: row.ref,
        })),
      });
    },
  );

  z.post(
    "/admin/users/merge",
    {
      preHandler: createAdminMiddleware(),
      schema: { body: adminUserMergeSchema },
    },
    async (request, reply) => {
      const body = request.body;
      let sourceId = body.sourceId ?? null;
      let targetId = body.targetId ?? null;

      if (!sourceId && body.sourceWallet) {
        sourceId = await resolveUserIdByWallet(body.sourceWallet);
      }
      if (!targetId && body.targetWallet) {
        targetId = await resolveUserIdByWallet(body.targetWallet);
      }

      if (!sourceId || !targetId) {
        reply.code(400);
        return reply.send({
          error: "Resolve source/target user failed",
        });
      }

      const result = await mergeUsersById(sourceId, targetId, {
        dryRun: Boolean(body.dryRun),
        keepSource: Boolean(body.keepSource),
      });

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        dryRun: result.dryRun,
        summary: result.summary,
      });
    },
  );

  z.post(
    "/admin/users/:id/admin",
    {
      preHandler: createAdminMiddleware(),
      schema: { params: adminUserParamsSchema, body: adminUserAdminSchema },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;

      const { rows } = await pool.query<{ is_admin: boolean }>(
        `
          update users
          set is_admin = $2
          where id = $1
          returning is_admin
        `,
        [id, body.isAdmin],
      );

      if (!rows.length) {
        reply.code(404);
        return reply.send({ error: "User not found" });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, isAdmin: rows[0].is_admin });
    },
  );

  z.post(
    "/admin/users/:id/active",
    {
      preHandler: createAdminMiddleware(),
      schema: { params: adminUserParamsSchema, body: adminUserActiveSchema },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;

      const { rows } = await pool.query<{ is_active: boolean }>(
        `
          update users
          set is_active = $2
          where id = $1
          returning is_active
        `,
        [id, body.isActive],
      );

      if (!rows.length) {
        reply.code(404);
        return reply.send({ error: "User not found" });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, isActive: rows[0].is_active });
    },
  );

  z.post(
    "/admin/users/:id/kalshi-proof-bypass",
    {
      preHandler: createAdminMiddleware(),
      schema: {
        params: adminUserParamsSchema,
        body: adminUserKalshiProofBypassSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;

      const { rows } = await pool.query<{ kalshi_proof_bypass: boolean }>(
        `
          update users
          set kalshi_proof_bypass = $2
          where id = $1
          returning kalshi_proof_bypass
        `,
        [id, body.kalshiProofBypass],
      );

      if (!rows.length) {
        reply.code(404);
        return reply.send({ error: "User not found" });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        kalshiProofBypass: rows[0].kalshi_proof_bypass,
      });
    },
  );

  z.get(
    "/admin/fees/policy",
    { preHandler: createAdminMiddleware() },
    async (_request, reply) => {
      const [poly, kalshi] = await Promise.all([
        fetchActiveFeePolicy(pool, "polymarket"),
        fetchActiveFeePolicy(pool, "kalshi"),
      ]);

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        fees: {
          polymarket: {
            feeBps: clampFeeBps(poly?.fee_bps ?? env.feeBpsPolymarket),
            feeScale: null,
            effectiveAt: poly?.effective_at ?? null,
            source: poly ? "db" : "env",
          },
          kalshi: {
            feeBps: clampFeeBps(kalshi?.fee_bps ?? env.feeBpsKalshi),
            feeScale: clampFeeScale(kalshi?.fee_scale ?? env.feeScaleKalshi),
            effectiveAt: kalshi?.effective_at ?? null,
            source: kalshi ? "db" : "env",
          },
        },
      });
    },
  );

  z.post(
    "/admin/fees/policy",
    {
      preHandler: createAdminMiddleware(),
      schema: { body: adminFeePolicySchema },
    },
    async (request, reply) => {
      const body = request.body;
      const effectiveAt = body.effectiveAt
        ? new Date(body.effectiveAt)
        : new Date();
      const feeScale =
        body.venue === "kalshi" ? clampFeeScale(body.feeScale) : null;

      const row = await insertFeePolicy(pool, {
        venue: body.venue,
        feeBps: clampFeeBps(body.feeBps),
        feeScale,
        effectiveAt,
      });

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        policy: {
          venue: row.venue,
          feeBps: row.fee_bps,
          feeScale: row.fee_scale,
          effectiveAt: row.effective_at,
          createdAt: row.created_at,
        },
      });
    },
  );

  z.get(
    "/admin/fees/debridge",
    { preHandler: createAdminMiddleware() },
    async (_request, reply) => {
      const row = await fetchActiveDebridgeConfig(pool);
      const recipients =
        row?.affiliate_fee_recipients ??
        parseAffiliateRecipientMap(env.debridgeAffiliateFeeRecipients || "");

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        config: {
          dlnBase: row?.dln_base?.trim() || env.debridgeDlnBase,
          statsBase: row?.stats_base?.trim() || env.debridgeStatsBase,
          affiliateFeePercent:
            row?.affiliate_fee_percent != null
              ? Number(row.affiliate_fee_percent)
              : env.debridgeAffiliateFeePercent,
          affiliateFeeRecipients: JSON.stringify(recipients),
          referralCode:
            row?.referral_code != null
              ? Number(row.referral_code)
              : env.debridgeReferralCode,
          effectiveAt: row?.effective_at ?? null,
          source: row ? "db" : "env",
        },
      });
    },
  );

  z.post(
    "/admin/fees/debridge",
    {
      preHandler: createAdminMiddleware(),
      schema: { body: adminDebridgeConfigSchema },
    },
    async (request, reply) => {
      const body = request.body;
      const effectiveAt = body.effectiveAt
        ? new Date(body.effectiveAt)
        : new Date();
      const recipients = body.affiliateFeeRecipients
        ? parseAffiliateRecipientMap(body.affiliateFeeRecipients)
        : null;

      const row = await insertDebridgeConfig(pool, {
        effectiveAt,
        dlnBase: body.dlnBase?.trim() || null,
        statsBase: body.statsBase?.trim() || null,
        affiliateFeePercent:
          body.affiliateFeePercent != null
            ? Number(body.affiliateFeePercent)
            : null,
        affiliateFeeRecipients: recipients && Object.keys(recipients).length
          ? recipients
          : null,
        referralCode:
          body.referralCode != null ? Number(body.referralCode) : null,
      });

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        config: {
          dlnBase: row.dln_base,
          statsBase: row.stats_base,
          affiliateFeePercent: row.affiliate_fee_percent,
          affiliateFeeRecipients: row.affiliate_fee_recipients,
          referralCode: row.referral_code,
          effectiveAt: row.effective_at,
          createdAt: row.created_at,
        },
      });
    },
  );

  z.get(
    "/admin/rewards/policy",
    { preHandler: createAdminMiddleware() },
    async (_request, reply) => {
      const active = await fetchActiveRewardsPolicy(pool);
      const policy = await getRewardsPolicy(pool);
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        policy,
        active: active
          ? {
              effectiveAt: active.effective_at,
              tiers: active.tiers,
              referralBonus: active.referral_bonus,
              createdAt: active.created_at,
            }
          : null,
      });
    },
  );

  z.get(
    "/admin/rewards/treasury",
    {
      preHandler: createAdminMiddleware(),
      schema: { querystring: adminRewardsTreasuryQuerySchema },
    },
    async (request, reply) => {
      const query = request.query;
      if (query.chainId && !normalizeRewardsChainId(query.chainId)) {
        reply.code(400);
        return reply.send({
          error: "Unsupported chainId. Allowed: 137, 8453, solana",
        });
      }
      const report = await getRewardsTreasuryReport(pool, {
        chainId: query.chainId ?? null,
      });
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        report,
      });
    },
  );

  z.post(
    "/admin/rewards/policy",
    {
      preHandler: createAdminMiddleware(),
      schema: { body: adminRewardsPolicySchema },
    },
    async (request, reply) => {
      const body = request.body;
      const effectiveAt = body.effectiveAt
        ? new Date(body.effectiveAt)
        : new Date();

      const { rows } = await pool.query<{
        effective_at: Date;
        created_at: Date;
      }>(
        `
          insert into rewards_policy (effective_at, tiers, referral_bonus)
          values ($1, $2, $3)
          returning effective_at, created_at
        `,
        [effectiveAt, JSON.stringify(body.tiers), JSON.stringify(body.referralBonus)],
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        policy: {
          effectiveAt: rows[0]?.effective_at ?? effectiveAt,
          createdAt: rows[0]?.created_at ?? effectiveAt,
        },
      });
    },
  );

  z.post(
    "/admin/rewards/points",
    {
      preHandler: createAdminMiddleware(),
      schema: { body: adminPointsSchema },
    },
    async (request, reply) => {
      const body = request.body;
      const walletInput = body.walletAddress?.trim();
      let userId = body.userId?.trim() ?? null;
      if (!userId && walletInput) {
        try {
          userId = await resolveUserIdByWallet(walletInput);
        } catch (error) {
          reply.code(400);
          return reply.send({
            error: error instanceof Error ? error.message : "Wallet lookup failed",
          });
        }
      }

      if (!userId) {
        reply.code(404);
        return reply.send({ error: "User not found" });
      }

      const walletAddress =
        walletInput ?? (await fetchPrimaryWallet(userId)) ?? null;
      const sourceType = body.sourceType ?? "execution";
      const sourceId = body.sourceId?.trim() ?? `manual:${randomUUID()}`;
      const venue = body.venue?.trim() ?? "admin";

      const inserted = await insertVolumeEventsWithMultiplier(pool, {
        userId,
        walletAddress,
        venue,
        sourceType,
        events: [
          {
            sourceId,
            notionalUsd: body.amount,
            createdAt: new Date(),
          },
        ],
      });

      if (!inserted.inserted) {
        reply.code(409);
        return reply.send({
          error: "Volume event already exists",
          sourceId,
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        event: {
          id: inserted.ids[0] ?? null,
          userId,
          walletAddress,
          venue,
          sourceType,
          sourceId,
          amount: body.amount,
        },
      });
    },
  );
};
