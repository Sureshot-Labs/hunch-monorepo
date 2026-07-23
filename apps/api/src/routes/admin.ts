import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  getEmbedStreamKey,
  INDEXER_STATS_KEYS,
  LIMITLESS_PRICE_REFRESH_HTTP_FALLBACK_QUEUE_KEY,
  PRICE_REFRESH_QUEUE_KEYS,
  tx,
  type RedisClientType,
} from "@hunch/infra";
import { Interface, ethers } from "ethers";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import type { PoolClient } from "pg";
import { AuthService, createAdminMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { abis } from "../lib/contracts.js";
import { normalizeRewardsChainId } from "../lib/rewards-chain.js";
import {
  parseUsdcToMicroFloor,
  usdcMicroToDecimalString,
} from "../lib/usdc.js";
import { withRewardsUserAdvisoryXactLock } from "../lib/rewards-user-lock.js";
import { getRedisStatus } from "../redis.js";
import {
  fetchActiveDebridgeConfig,
  insertDebridgeConfig,
} from "../repos/debridge-config.js";
import { fetchActiveFeePolicy, insertFeePolicy } from "../repos/fee-policy.js";
import { insertRuntimePolicy } from "../repos/runtime-policies.js";
import {
  buildPublicPointsContributionSql,
  buildQualificationPointsContributionSql,
  buildTierPointsContributionSql,
  deleteAdminManualVolumeEvent,
  deleteRewardsMultiplierOverride,
  fetchActiveRewardsMultiplierPolicy,
  fetchActiveRewardsPolicy,
  fetchAdminManualVolumeEvents,
  HIDDEN_MANUAL_VOLUME_SOURCE_PREFIX,
  insertExactManualVolumeEvent,
  insertRewardsMultiplierPolicy,
  listRewardsMultiplierOverrides,
  upsertRewardsMultiplierOverride,
  VISIBLE_MANUAL_VOLUME_SOURCE_PREFIX,
} from "../repos/rewards.js";
import { mergeUsersById } from "../admin-merge-user-core.js";
import {
  createAdminCampaignReferralCode,
  getAdminReferralCodeReferralsByCode,
  getRewardsPolicy,
  listAdminReferralCodes,
  setReferralCodeForUser,
  updateAdminReferralCodePolicy,
} from "../services/rewards.js";
import { getRewardsTreasuryReport } from "../services/rewards-treasury.js";
import {
  clearVenueLifecyclePolicyCache,
  getIntelPolicySchema,
  INTEL_POLICY_KEYS,
  resolveApiCacheWarmPolicy,
  resolveAllIntelPolicies,
  resolveIntelPolicy,
  resolvedVenueLifecyclePolicyRevision,
  type IntelPolicyKey,
} from "../services/runtime-policies.js";
import { clearSignalBotVenueLifecycleCache } from "../services/signal-bot-venue-lifecycle.js";
import { clearTelegramNotificationsPolicyCache } from "../services/telegram-notification-policy.js";
import {
  buildSignalPostCopyPolicyRevision,
  clearSignalPostCopyPolicyCache,
  signalPostCopyPolicySchema,
} from "../services/signal-post-copy-policy.js";
import { readApiCacheWarmStatus } from "../services/api-cache-warm.js";
import { registerAdminFundingRoutes } from "./admin-funding.js";
import { fetchLimitlessOnchainSnapshot } from "../services/limitless-onchain.js";
import { fetchPolymarketOnchainSnapshot } from "../services/polymarket-onchain.js";
import { fetchEvmMulticall } from "../services/polygon-rpc.js";
import {
  fetchSolanaBalanceLamports,
  fetchSolanaTokenBalanceByOwnerAndMint,
  fetchSolanaTokenAccountBalance,
  fetchSolanaTokenAccountInfo,
  formatUiAmount,
} from "../services/solana-rpc.js";
import {
  adminAnalyticsEventsQuerySchema,
  adminAnalyticsRangeQuerySchema,
  adminFeeLedgerDetailParamsSchema,
  adminFeeLedgerQuerySchema,
  adminFeePolicySchema,
  adminIntelPolicyBodySchema,
  adminIntelPolicyParamsSchema,
  adminMarketPresentationBodySchema,
  adminMarketPresentationParamsSchema,
  adminMarketPresentationSearchSchema,
  adminDebridgeConfigSchema,
  adminManualPointsParamsSchema,
  adminManualPointsQuerySchema,
  adminPointsSchema,
  adminRewardsBulkAdjustmentExecuteSchema,
  adminRewardsBulkAdjustmentPreviewSchema,
  adminRewardsMultiplierOverrideParamsSchema,
  adminRewardsMultiplierOverrideSchema,
  adminRewardsMultiplierOverridesQuerySchema,
  adminRewardsMultiplierPolicySchema,
  adminRewardsTreasuryQuerySchema,
  adminRewardsPolicySchema,
  adminReferralCodeCampaignCreateSchema,
  adminReferralCodeByCodeParamsSchema,
  adminReferralCodeFeeEventsQuerySchema,
  adminReferralCodeParamsSchema,
  adminReferralCodeReferralsQuerySchema,
  adminReferralCodesQuerySchema,
  adminReferralCodeUpdateSchema,
  adminUserActiveSchema,
  adminUserAdminSchema,
  adminUserAnalyticsQuerySchema,
  adminUserKalshiProofBypassSchema,
  adminUserOrderParamsSchema,
  adminUserOrdersQuerySchema,
  adminUserReferralCodeSchema,
  adminUserActivityQuerySchema,
  adminUserMergeSchema,
  adminUserPrivyBindGrantSchema,
  adminUserParamsSchema,
  adminUsersErrorResponseSchema,
  adminUsersQuerySchema,
  adminUsersResponseSchema,
} from "../schemas/admin.js";

import {
  fetchAnalyticsForwardingTelemetry,
  listCollectedAnalyticsEvents,
} from "../services/analytics-forwarding.js";
import {
  getAdminFeeLedgerAccrual,
  getAdminFeeLedgerBuilderSweep,
  getAdminFeeLedgerClaim,
  getAdminFeeLedgerContractReceivable,
  getAdminFeeLedgerEvent,
  getAdminFeeLedgerSummary,
  getAdminFeeLedgerTreasuryRun,
  getReferralCodeLedgerInfo,
  listAdminFeeLedgerAccruals,
  listAdminFeeLedgerBackfillAttempts,
  listAdminFeeLedgerBuilderSweeps,
  listAdminFeeLedgerClaims,
  listAdminFeeLedgerContractReceivables,
  listAdminFeeLedgerEvents,
  listAdminFeeLedgerTreasuryRuns,
} from "../services/admin-fee-ledger.js";
import { getAdminUserFinanceSummary } from "../services/admin-user-finance-summary.js";
import { listAdminUsers } from "../services/admin-users-list.js";
import {
  AdminRewardsBulkAdjustmentInputError,
  AdminRewardsBulkAdjustmentRetryExhaustedError,
  executeAdminRewardsBulkAdjustment,
  previewAdminRewardsBulkAdjustment,
  retryAdminRewardsBulkAdjustmentExecute,
} from "../services/admin-rewards-bulk-adjustments.js";
import {
  fetchUnifiedMarketIdsByEventId,
  fetchUnifiedOrderById,
  fetchUnifiedOrders,
  mapUnifiedOrder,
} from "../repos/unified-orders.js";
import {
  deleteAdminMarketPresentation,
  getAdminMarketPresentation,
  putAdminMarketPresentation,
  searchAdminMarketPresentations,
} from "../services/admin-market-presentations.js";

function resolvedAdminIntelPolicyRevision(input: {
  effective: unknown;
  effectiveAt: Date | string | null;
  invalidOverride: boolean;
  key: IntelPolicyKey;
  source: "db" | "default" | "env";
}): string | null {
  if (input.key === "venue_lifecycle") {
    return resolvedVenueLifecyclePolicyRevision(input);
  }
  if (input.key === "signal_post_copy") {
    const parsed = signalPostCopyPolicySchema.safeParse(input.effective);
    return parsed.success
      ? buildSignalPostCopyPolicyRevision(parsed.data)
      : null;
  }
  return null;
}

const MAX_FEE_SCALE = 10_000;
const MAX_FEE_BPS = 10_000;
async function executeAdminRewardsBulkAdjustmentWithRetry(
  body: Parameters<typeof executeAdminRewardsBulkAdjustment>[1],
) {
  return retryAdminRewardsBulkAdjustmentExecute(() =>
    tx(pool, async (client: PoolClient) =>
      executeAdminRewardsBulkAdjustment(client, body),
    ),
  );
}
const MAX_POLY_BUILDER_TAKER_FEE_BPS = 100;
const MAX_POLY_BUILDER_MAKER_FEE_BPS = 50;
const MAX_FEE_COLLECT_ATTEMPTS = 5;
const DEBRIDGE_CONFIG_TTL_MS = 30_000;
const ADMIN_USER_ANALYTICS_RANGE_MS = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
  "1y": 365 * 24 * 60 * 60 * 1000,
} as const;
const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const POLYGON_MULTICALL_ADDRESS =
  env.polygonMulticallAddress?.trim() ||
  "0xca11bde05977b3631167028862be2a173976ca11";
const EMBED_INDEX_MARKET = "idx:ai:embed:market";
const EMBED_INDEX_EVENT = "idx:ai:embed:event";
const EMBED_DLQ_KEY = "ai:embed:dead";
const SOLANA_LAMPORT_DECIMALS = 9;
const ADMIN_SYSTEM_VENUES = ["polymarket", "dflow", "limitless"] as const;
type AdminSystemVenue = (typeof ADMIN_SYSTEM_VENUES)[number];
const ADMIN_SYSTEM_HOT_KEYS: Record<AdminSystemVenue, string> = {
  polymarket: "hot:tokens:polymarket",
  dflow: "hot:tokens:dflow",
  limitless: "hot:tokens:limitless",
};
const ADMIN_SYSTEM_HOT_STREAM_KEYS: Record<AdminSystemVenue, string> = {
  polymarket: "hot:tokens:stream:polymarket",
  dflow: "hot:tokens:stream:dflow",
  limitless: "hot:tokens:stream:limitless",
};
const ADMIN_SYSTEM_QUERY_TEXT_LIMIT = 600;

const DEBRIDGE_CHAIN_META: Record<
  string,
  { label: string; kind: "evm" | "solana"; explorer: string }
> = {
  "137": {
    label: "Polygon",
    kind: "evm",
    explorer: "https://polygonscan.com/address/",
  },
  "8453": {
    label: "Base",
    kind: "evm",
    explorer: "https://basescan.org/address/",
  },
  "7565164": {
    label: "Solana",
    kind: "solana",
    explorer: "https://solscan.io/account/",
  },
};

type DebridgeConfig = {
  dlnBase: string;
  statsBase: string;
  affiliateFeePercent: number;
  affiliateFeeRecipients: Record<string, string>;
  referralCode: number;
  source: "env" | "db";
};

type RewardsMultiplierReferralRule = {
  minReferrals: number;
  multiplier: number;
};

type RewardsMultiplierTierRule = {
  minPoints: number;
  multiplier: number;
};

let cachedDebridgeConfig: { value: DebridgeConfig; expiresAt: number } | null =
  null;
let debridgeConfigInflight: Promise<DebridgeConfig> | null = null;

function isMissingTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "42P01";
}

function isUniqueViolationError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "23505";
}

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

function normalizePositiveNumber(input: unknown): number | null {
  const value = Number(input);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function normalizeNonNegativeNumber(input: unknown): number | null {
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

function normalizeMultiplierReferralRules(
  raw: unknown,
): RewardsMultiplierReferralRule[] {
  if (!Array.isArray(raw)) return [];
  const rules = raw
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const minReferrals = normalizeNonNegativeNumber(
        record.minReferrals ??
          record.minQualifiedReferrals ??
          record.min_referrals,
      );
      const multiplier = normalizePositiveNumber(record.multiplier);
      if (minReferrals == null || multiplier == null) return null;
      return { minReferrals, multiplier };
    })
    .filter(Boolean) as RewardsMultiplierReferralRule[];

  const deduped = new Map<number, RewardsMultiplierReferralRule>();
  for (const rule of rules) deduped.set(rule.minReferrals, rule);
  return [...deduped.values()].sort((a, b) => a.minReferrals - b.minReferrals);
}

function normalizeMultiplierTierRules(
  raw: unknown,
): RewardsMultiplierTierRule[] {
  if (!Array.isArray(raw)) return [];
  const rules = raw
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const minPoints = normalizeNonNegativeNumber(
        record.minPoints ?? record.min_points,
      );
      const multiplier = normalizePositiveNumber(record.multiplier);
      if (minPoints == null || multiplier == null) return null;
      return { minPoints, multiplier };
    })
    .filter(Boolean) as RewardsMultiplierTierRule[];

  const deduped = new Map<number, RewardsMultiplierTierRule>();
  for (const rule of rules) deduped.set(rule.minPoints, rule);
  return [...deduped.values()].sort((a, b) => a.minPoints - b.minPoints);
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
      affiliateFeeRecipients:
        row?.affiliate_fee_recipients ??
        parseAffiliateRecipientMap(env.debridgeAffiliateFeeRecipients || ""),
      referralCode:
        row?.referral_code != null
          ? Number(row.referral_code)
          : env.debridgeReferralCode,
      source: row ? "db" : "env",
    };
    cachedDebridgeConfig = {
      value: config,
      expiresAt: now + DEBRIDGE_CONFIG_TTL_MS,
    };
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

function microAmountToDisplay(value: bigint): string {
  return usdcMicroToDecimalString(value > 0n ? value : 0n);
}

function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function max0Bigint(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

function clampFeeBpsForMax(
  value: number | null | undefined,
  max: number,
): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), max);
}

function normalizePolymarketBuilderCode(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  const normalized = /^0x[0-9a-fA-F]{64}$/.test(trimmed)
    ? trimmed.toLowerCase()
    : null;
  return normalized === ZERO_BYTES32 ? null : normalized;
}

function resolvePolymarketBuilderCodeForDisplay(
  value: string | null | undefined,
): string | null {
  return (
    normalizePolymarketBuilderCode(value) ??
    normalizePolymarketBuilderCode(env.polymarketBuilderCode)
  );
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

function isAnalyticsPayloadRecord(
  value: unknown,
): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readAnalyticsPayloadString(
  payload: unknown,
  key: string,
): string | null {
  if (!isAnalyticsPayloadRecord(payload)) return null;
  const value = payload[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readAnalyticsPayloadNumber(
  payload: unknown,
  key: string,
): number | null {
  if (!isAnalyticsPayloadRecord(payload)) return null;
  return toOptionalNumber(payload[key]);
}

type AdminUserAnalyticsRange =
  | keyof typeof ADMIN_USER_ANALYTICS_RANGE_MS
  | "all";

type AdminUserAnalyticsOutcome = "action" | "failure" | "success" | "timeout";
type AdminAnalyticsMonitorStatus =
  | "critical"
  | "healthy"
  | "no_data"
  | "warning";
type AdminAnalyticsMonitorRateMode = "attempt" | "event_count";

type AdminKeysetCursor = {
  createdAt: Date;
  id: string;
};

type AdminCursorRow = {
  created_at: Date;
  id: string;
};

const ADMIN_USER_ANALYTICS_OUTCOME_SQL = `
  case
    when lower(event_name) like '%no_terminal%'
      or lower(coalesce(status, '')) like '%timeout%' then 'timeout'
    when right(lower(event_name), 5) = '_fail'
      or right(lower(event_name), 6) = '_error'
      or lower(coalesce(status, '')) like '%fail%'
      or lower(coalesce(status, '')) like '%error%'
      or lower(coalesce(status, '')) like '%missing%'
      or lower(coalesce(status, '')) like '%unavailable%' then 'failure'
    when right(lower(event_name), 8) = '_success'
      or lower(event_name) like '%completed_funnel%'
      or lower(coalesce(status, '')) like '%success%'
      or lower(coalesce(status, '')) like '%completed%'
      or lower(coalesce(status, '')) like '%captured%' then 'success'
    else 'action'
  end
`;

type AdminAnalyticsEventMetadata = {
  alertSlaHours: number;
  domain: string;
  owner: string;
  tier: "core" | "supporting";
};

type AdminAnalyticsMonitorStep = {
  event: string;
  statuses?: readonly string[];
};

type AdminAnalyticsMonitorDefinition = {
  alertSlaHours: number;
  domain: string;
  failure?: AdminAnalyticsMonitorStep;
  id: string;
  involvedOwners: readonly string[];
  kind: "event_volume" | "funnel_rate" | "terminal_error_rate";
  owner: string;
  priority: "p1" | "p2";
  requiredDimensions: readonly string[];
  start: AdminAnalyticsMonitorStep;
  success?: AdminAnalyticsMonitorStep;
  thresholds: {
    expectedFailureRateMaxPct?: number;
    expectedSuccessRateMinPct?: number;
    expectedTimeoutRateMaxPct?: number;
    expectedVolumeMinPerWindow?: number;
  };
  timeout?: AdminAnalyticsMonitorStep;
  trackedEvents: readonly string[];
  windowMinutes: number;
};

const ADMIN_ANALYTICS_SCHEMA_VERSION_FILTER = "2026-04-06.p3c4a";
const ADMIN_ANALYTICS_COLLECTOR_WINDOW_DAYS = 30;
const ADMIN_ANALYTICS_EVENT_METADATA: Record<
  string,
  AdminAnalyticsEventMetadata
> = {
  hf_bridge_fail: {
    alertSlaHours: 24,
    domain: "trade_execution",
    owner: "deposit",
    tier: "core",
  },
  hf_bridge_submit: {
    alertSlaHours: 24,
    domain: "trade_execution",
    owner: "deposit",
    tier: "core",
  },
  hf_bridge_success: {
    alertSlaHours: 24,
    domain: "trade_execution",
    owner: "deposit",
    tier: "core",
  },
  hf_event_entry_open: {
    alertSlaHours: 168,
    domain: "market_navigation",
    owner: "analytics_platform",
    tier: "supporting",
  },
  hf_market_open: {
    alertSlaHours: 24,
    domain: "event_page",
    owner: "events",
    tier: "core",
  },
  hf_order_fail: {
    alertSlaHours: 24,
    domain: "trade_execution",
    owner: "trade",
    tier: "core",
  },
  hf_order_submit: {
    alertSlaHours: 24,
    domain: "trade_execution",
    owner: "trade",
    tier: "core",
  },
  hf_order_success: {
    alertSlaHours: 24,
    domain: "trade_execution",
    owner: "trade",
    tier: "core",
  },
  hf_portfolio_order_cancel: {
    alertSlaHours: 24,
    domain: "portfolio",
    owner: "portfolio",
    tier: "core",
  },
  hf_portfolio_share_action: {
    alertSlaHours: 168,
    domain: "portfolio",
    owner: "portfolio",
    tier: "supporting",
  },
  hf_referral_link_landing: {
    alertSlaHours: 168,
    domain: "onboarding",
    owner: "growth",
    tier: "supporting",
  },
  hf_redemption_action: {
    alertSlaHours: 168,
    domain: "portfolio",
    owner: "portfolio",
    tier: "supporting",
  },
  hf_rewards_claim_action: {
    alertSlaHours: 24,
    domain: "rewards",
    owner: "rewards",
    tier: "core",
  },
  hf_rewards_referral_action: {
    alertSlaHours: 168,
    domain: "rewards",
    owner: "rewards",
    tier: "supporting",
  },
  hf_trade_submit_no_terminal_2m: {
    alertSlaHours: 24,
    domain: "trade_execution",
    owner: "analytics_platform",
    tier: "core",
  },
  hf_wallet_connect_click: {
    alertSlaHours: 24,
    domain: "onboarding",
    owner: "growth",
    tier: "core",
  },
  hf_wallet_connect_completed_funnel: {
    alertSlaHours: 24,
    domain: "onboarding",
    owner: "analytics_platform",
    tier: "core",
  },
  hf_wallet_connect_error: {
    alertSlaHours: 24,
    domain: "onboarding",
    owner: "growth",
    tier: "core",
  },
  hf_wallet_connect_success: {
    alertSlaHours: 24,
    domain: "onboarding",
    owner: "growth",
    tier: "core",
  },
  hf_wallet_link_click: {
    alertSlaHours: 24,
    domain: "onboarding",
    owner: "deposit",
    tier: "core",
  },
  hf_wallet_link_completed_funnel: {
    alertSlaHours: 24,
    domain: "onboarding",
    owner: "analytics_platform",
    tier: "core",
  },
  hf_wallet_link_error: {
    alertSlaHours: 24,
    domain: "onboarding",
    owner: "deposit",
    tier: "core",
  },
  hf_wallet_link_success: {
    alertSlaHours: 24,
    domain: "onboarding",
    owner: "deposit",
    tier: "core",
  },
};

const ADMIN_ANALYTICS_MONITORS: readonly AdminAnalyticsMonitorDefinition[] = [
  {
    alertSlaHours: 24,
    domain: "trade_execution",
    failure: { event: "hf_bridge_fail" },
    id: "bridge_terminal_outcome",
    involvedOwners: ["deposit"],
    kind: "funnel_rate",
    owner: "deposit",
    priority: "p1",
    requiredDimensions: [
      "analytics_schema_version",
      "attempt_id",
      "dst_chain_id",
      "execution_mode",
      "src_chain_id",
    ],
    start: { event: "hf_bridge_submit" },
    success: { event: "hf_bridge_success" },
    thresholds: {
      expectedFailureRateMaxPct: 15,
      expectedSuccessRateMinPct: 80,
    },
    trackedEvents: ["hf_bridge_fail", "hf_bridge_submit", "hf_bridge_success"],
    windowMinutes: 120,
  },
  {
    alertSlaHours: 24,
    domain: "event_page",
    id: "event_page_open_volume",
    involvedOwners: ["events"],
    kind: "event_volume",
    owner: "events",
    priority: "p2",
    requiredDimensions: ["analytics_schema_version", "event_id"],
    start: { event: "hf_market_open" },
    thresholds: {
      expectedVolumeMinPerWindow: 1,
    },
    trackedEvents: ["hf_market_open"],
    windowMinutes: 60,
  },
  {
    alertSlaHours: 24,
    domain: "trade_execution",
    failure: { event: "hf_order_fail" },
    id: "order_terminal_outcome",
    involvedOwners: ["analytics_platform", "trade"],
    kind: "funnel_rate",
    owner: "trade",
    priority: "p1",
    requiredDimensions: [
      "analytics_schema_version",
      "attempt_id",
      "order_type",
      "side",
      "venue",
    ],
    start: { event: "hf_order_submit" },
    success: { event: "hf_order_success" },
    thresholds: {
      expectedFailureRateMaxPct: 20,
      expectedSuccessRateMinPct: 75,
      expectedTimeoutRateMaxPct: 5,
    },
    timeout: {
      event: "hf_trade_submit_no_terminal_2m",
      statuses: ["timeout_120s"],
    },
    trackedEvents: [
      "hf_order_fail",
      "hf_order_submit",
      "hf_order_success",
      "hf_trade_submit_no_terminal_2m",
    ],
    windowMinutes: 120,
  },
  {
    alertSlaHours: 24,
    domain: "portfolio",
    failure: {
      event: "hf_portfolio_order_cancel",
      statuses: ["cancel_error"],
    },
    id: "portfolio_cancel_terminal",
    involvedOwners: ["portfolio"],
    kind: "terminal_error_rate",
    owner: "portfolio",
    priority: "p1",
    requiredDimensions: [
      "analytics_schema_version",
      "attempt_id",
      "order_type",
      "source",
      "status",
      "venue",
    ],
    start: {
      event: "hf_portfolio_order_cancel",
      statuses: ["cancel_submit"],
    },
    success: {
      event: "hf_portfolio_order_cancel",
      statuses: ["cancel_success"],
    },
    thresholds: {
      expectedFailureRateMaxPct: 20,
      expectedSuccessRateMinPct: 70,
    },
    trackedEvents: ["hf_portfolio_order_cancel"],
    windowMinutes: 120,
  },
  {
    alertSlaHours: 24,
    domain: "rewards",
    failure: {
      event: "hf_rewards_claim_action",
      statuses: ["claim_error"],
    },
    id: "rewards_claim_terminal",
    involvedOwners: ["rewards"],
    kind: "terminal_error_rate",
    owner: "rewards",
    priority: "p1",
    requiredDimensions: [
      "analytics_schema_version",
      "attempt_id",
      "source",
      "status",
    ],
    start: {
      event: "hf_rewards_claim_action",
      statuses: ["claim_submit"],
    },
    success: {
      event: "hf_rewards_claim_action",
      statuses: ["claim_success"],
    },
    thresholds: {
      expectedFailureRateMaxPct: 20,
      expectedSuccessRateMinPct: 70,
    },
    trackedEvents: ["hf_rewards_claim_action"],
    windowMinutes: 240,
  },
  {
    alertSlaHours: 24,
    domain: "onboarding",
    failure: { event: "hf_wallet_connect_error" },
    id: "wallet_connect_completion",
    involvedOwners: ["analytics_platform", "growth"],
    kind: "funnel_rate",
    owner: "growth",
    priority: "p1",
    requiredDimensions: ["analytics_schema_version", "source"],
    start: { event: "hf_wallet_connect_click" },
    success: {
      event: "hf_wallet_connect_completed_funnel",
      statuses: ["completed"],
    },
    thresholds: {
      expectedFailureRateMaxPct: 20,
      expectedSuccessRateMinPct: 70,
    },
    trackedEvents: [
      "hf_wallet_connect_click",
      "hf_wallet_connect_completed_funnel",
      "hf_wallet_connect_error",
      "hf_wallet_connect_success",
    ],
    windowMinutes: 60,
  },
  {
    alertSlaHours: 24,
    domain: "onboarding",
    failure: { event: "hf_wallet_link_error" },
    id: "wallet_link_completion",
    involvedOwners: ["analytics_platform", "deposit"],
    kind: "funnel_rate",
    owner: "deposit",
    priority: "p1",
    requiredDimensions: ["analytics_schema_version", "source", "status"],
    start: { event: "hf_wallet_link_click" },
    success: {
      event: "hf_wallet_link_completed_funnel",
      statuses: ["completed"],
    },
    thresholds: {
      expectedFailureRateMaxPct: 20,
      expectedSuccessRateMinPct: 70,
    },
    trackedEvents: [
      "hf_wallet_link_click",
      "hf_wallet_link_completed_funnel",
      "hf_wallet_link_error",
      "hf_wallet_link_success",
    ],
    windowMinutes: 60,
  },
];

const ADMIN_ANALYTICS_EXPECTED_MONITOR_EVENTS = Array.from(
  new Set(ADMIN_ANALYTICS_MONITORS.flatMap((monitor) => monitor.trackedEvents)),
).sort((a, b) => a.localeCompare(b));

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const ADMIN_ANALYTICS_DOMAIN_SQL = `
  case
    ${Object.entries(ADMIN_ANALYTICS_EVENT_METADATA)
      .map(
        ([eventName, metadata]) =>
          `when event_name = ${sqlStringLiteral(eventName)} then ${sqlStringLiteral(metadata.domain)}`,
      )
      .join("\n    ")}
    else 'unknown'
  end
`;

function getAdminAnalyticsEventMetadata(eventName: string) {
  return (
    ADMIN_ANALYTICS_EVENT_METADATA[eventName] ?? {
      alertSlaHours: null,
      domain: "unknown",
      owner: null,
      tier: "unknown",
    }
  );
}

function getAdminAnalyticsEventsForDomain(domain: string): string[] {
  return Object.entries(ADMIN_ANALYTICS_EVENT_METADATA)
    .filter(([, metadata]) => metadata.domain === domain)
    .map(([eventName]) => eventName);
}

function resolveAdminUserAnalyticsRangeStart(
  range: AdminUserAnalyticsRange,
): Date | null {
  if (range === "all") return null;
  return new Date(Date.now() - ADMIN_USER_ANALYTICS_RANGE_MS[range]);
}

function resolveAdminAnalyticsWindow(range: AdminUserAnalyticsRange): {
  previousRangeEndAt: Date | null;
  previousRangeStartAt: Date | null;
  rangeEndAt: Date;
  rangeStartAt: Date | null;
} {
  const rangeEndAt = new Date();
  if (range === "all") {
    return {
      previousRangeEndAt: null,
      previousRangeStartAt: null,
      rangeEndAt,
      rangeStartAt: null,
    };
  }

  const durationMs = ADMIN_USER_ANALYTICS_RANGE_MS[range];
  const rangeStartAt = new Date(rangeEndAt.getTime() - durationMs);
  return {
    previousRangeEndAt: rangeStartAt,
    previousRangeStartAt: new Date(rangeStartAt.getTime() - durationMs),
    rangeEndAt,
    rangeStartAt,
  };
}

function resolveAdminUserAnalyticsTimelineGranularity(
  range: AdminUserAnalyticsRange,
) {
  if (range === "24h") return "hour";
  if (range === "90d") return "week";
  if (range === "1y") return "month";
  return "day";
}

function appendAdminAnalyticsRangeWhere(
  parts: string[],
  params: Array<string | Date | number | string[]>,
  window: { rangeEndAt: Date; rangeStartAt: Date | null },
  column = "created_at",
): void {
  if (window.rangeStartAt) {
    params.push(window.rangeStartAt);
    parts.push(`${column} >= $${params.length}`);
  }
  params.push(window.rangeEndAt);
  parts.push(`${column} < $${params.length}`);
}

function buildAdminAnalyticsStepCondition(
  params: Array<string | Date | number | string[]>,
  step: AdminAnalyticsMonitorStep,
): string {
  params.push(step.event);
  let condition = `event_name = $${params.length}`;
  if (step.statuses?.length) {
    params.push([...step.statuses]);
    condition += ` and status = any($${params.length}::text[])`;
  }
  return `(${condition})`;
}

function buildAdminAnalyticsWhere(parts: string[]): string {
  return parts.length ? parts.join(" and ") : "true";
}

function ratePct(count: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Number(((count / denominator) * 100).toFixed(2));
}

function resolveAdminAnalyticsTerminalRate(
  success: number,
  failure: number,
  timeout: number,
): number | null {
  return ratePct(success, success + failure + timeout);
}

function resolveAdminAnalyticsMonitorRateMode(
  monitor: AdminAnalyticsMonitorDefinition,
): AdminAnalyticsMonitorRateMode {
  return monitor.requiredDimensions.includes("attempt_id")
    ? "attempt"
    : "event_count";
}

function classifyAdminAnalyticsMonitor(inputs: {
  denominator: number;
  failureRatePct: number | null;
  missingAttemptEventCount: number;
  missingEvents: string[];
  observedCount: number;
  startCount: number;
  successRatePct: number | null;
  thresholds: AdminAnalyticsMonitorDefinition["thresholds"];
  timeoutRatePct: number | null;
}): { noDataReason: string | null; status: AdminAnalyticsMonitorStatus } {
  if (inputs.missingEvents.length > 0) {
    return { noDataReason: "missing_collection", status: "no_data" };
  }
  if (inputs.observedCount <= 0) {
    return { noDataReason: "no_observed_events", status: "no_data" };
  }

  const {
    expectedFailureRateMaxPct,
    expectedSuccessRateMinPct,
    expectedTimeoutRateMaxPct,
    expectedVolumeMinPerWindow,
  } = inputs.thresholds;

  if (
    expectedVolumeMinPerWindow != null &&
    inputs.startCount < expectedVolumeMinPerWindow
  ) {
    return { noDataReason: null, status: "critical" };
  }
  if (
    expectedSuccessRateMinPct != null &&
    inputs.successRatePct != null &&
    inputs.successRatePct < expectedSuccessRateMinPct
  ) {
    return { noDataReason: null, status: "critical" };
  }
  if (
    expectedFailureRateMaxPct != null &&
    inputs.failureRatePct != null &&
    inputs.failureRatePct > expectedFailureRateMaxPct
  ) {
    return { noDataReason: null, status: "critical" };
  }
  if (
    expectedTimeoutRateMaxPct != null &&
    inputs.timeoutRatePct != null &&
    inputs.timeoutRatePct > expectedTimeoutRateMaxPct
  ) {
    return { noDataReason: null, status: "critical" };
  }

  if (inputs.missingAttemptEventCount > 0) {
    return { noDataReason: null, status: "warning" };
  }

  if (
    expectedSuccessRateMinPct != null &&
    inputs.successRatePct != null &&
    inputs.successRatePct < expectedSuccessRateMinPct + 5
  ) {
    return { noDataReason: null, status: "warning" };
  }
  if (
    expectedFailureRateMaxPct != null &&
    inputs.failureRatePct != null &&
    inputs.failureRatePct > Math.max(0, expectedFailureRateMaxPct - 5)
  ) {
    return { noDataReason: null, status: "warning" };
  }
  if (
    expectedTimeoutRateMaxPct != null &&
    inputs.timeoutRatePct != null &&
    inputs.timeoutRatePct > Math.max(0, expectedTimeoutRateMaxPct - 2)
  ) {
    return { noDataReason: null, status: "warning" };
  }
  return { noDataReason: null, status: "healthy" };
}

function decodeAdminKeysetCursor(encoded: string | undefined): {
  cursor: AdminKeysetCursor | null;
  error: string | null;
} {
  if (!encoded) return { cursor: null, error: null };

  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { cursor: null, error: "Invalid cursor" };
    }

    const record = parsed as Record<string, unknown>;
    const createdAtValue = record.createdAt;
    const idValue = record.id;
    if (typeof createdAtValue !== "string" || typeof idValue !== "string") {
      return { cursor: null, error: "Invalid cursor" };
    }

    const createdAt = new Date(createdAtValue);
    if (!Number.isFinite(createdAt.getTime()) || !idValue.trim()) {
      return { cursor: null, error: "Invalid cursor" };
    }

    return { cursor: { createdAt, id: idValue }, error: null };
  } catch {
    return { cursor: null, error: "Invalid cursor" };
  }
}

function encodeAdminKeysetCursor(row: AdminCursorRow): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: row.created_at.toISOString(),
      id: row.id,
    }),
    "utf8",
  ).toString("base64url");
}

function buildAdminCursorPage<T extends AdminCursorRow>(
  rows: T[],
  limit: number,
) {
  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const nextCursor =
    hasMore && items.length
      ? encodeAdminKeysetCursor(items[items.length - 1])
      : null;
  return { hasMore, items, nextCursor };
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
  } catch {
    return {
      count: null,
      error: "Index count failed",
    };
  }
}

function truncateAdminText(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= ADMIN_SYSTEM_QUERY_TEXT_LIMIT) return normalized;
  return `${normalized.slice(0, ADMIN_SYSTEM_QUERY_TEXT_LIMIT)}…`;
}

async function readRedisNumber(
  redis: RedisClientType,
  command: string[],
): Promise<number | null> {
  const value = await redis.sendCommand(command);
  return toOptionalNumber(value);
}

function parseRedisZsetScore(raw: unknown): number | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  return toOptionalNumber(raw[1]);
}

function ageFromScore(nowMs: number, score: number | null): number | null {
  if (score == null) return null;
  return Math.max(0, nowMs - score);
}

async function readRedisZsetStats(
  redis: RedisClientType,
  key: string,
  freshTtlSec: number,
  nowMs: number,
) {
  const [total, fresh, oldestRaw, newestRaw] = await Promise.all([
    readRedisNumber(redis, ["ZCARD", key]),
    readRedisNumber(redis, [
      "ZCOUNT",
      key,
      String(nowMs - freshTtlSec * 1000),
      "+inf",
    ]),
    redis.sendCommand(["ZRANGE", key, "0", "0", "WITHSCORES"]),
    redis.sendCommand(["ZREVRANGE", key, "0", "0", "WITHSCORES"]),
  ]);
  const oldestScore = parseRedisZsetScore(oldestRaw);
  const newestScore = parseRedisZsetScore(newestRaw);
  return {
    key,
    total: total ?? 0,
    fresh: fresh ?? 0,
    oldestAgeMs: ageFromScore(nowMs, oldestScore),
    newestAgeMs: ageFromScore(nowMs, newestScore),
  };
}

async function readRedisPriceRefreshQueueStats(
  redis: RedisClientType,
  key: string,
  nowMs: number,
) {
  const [total, due, oldestDueRaw] = await Promise.all([
    readRedisNumber(redis, ["ZCARD", key]),
    readRedisNumber(redis, ["ZCOUNT", key, "-inf", String(nowMs)]),
    redis.sendCommand([
      "ZRANGEBYSCORE",
      key,
      "-inf",
      String(nowMs),
      "WITHSCORES",
      "LIMIT",
      "0",
      "1",
    ]),
  ]);
  const resolvedTotal = total ?? 0;
  const resolvedDue = due ?? 0;
  const oldestDueScore = parseRedisZsetScore(oldestDueRaw);
  return {
    key,
    total: resolvedTotal,
    due: resolvedDue,
    delayed: Math.max(0, resolvedTotal - resolvedDue),
    oldestDueAgeMs: ageFromScore(nowMs, oldestDueScore),
  };
}

async function readIndexerHeartbeat(
  redis: RedisClientType,
  venue: AdminSystemVenue,
) {
  const raw = await redis.get(INDEXER_STATS_KEYS[venue]);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return { parseError: true };
  }
}

async function buildAdminIndexerSystemStats() {
  const generatedAt = new Date().toISOString();
  const nowMs = Date.now();
  const { redis, status, error } = await getRedisStatus({ force: true });
  const base = {
    generatedAt,
    redis: {
      available: Boolean(redis),
      status,
      error: error ?? null,
    },
  };
  if (!redis) {
    return {
      ...base,
      venues: ADMIN_SYSTEM_VENUES.map((venue) => ({
        venue,
        hotTokens: null,
        streamHotTokens: null,
        priceRefreshQueue: null,
        priceRefreshHttpFallbackQueue: null,
        heartbeat: null,
        error: error ?? "Redis unavailable",
      })),
    };
  }

  const venues = await Promise.all(
    ADMIN_SYSTEM_VENUES.map(async (venue) => {
      try {
        const [
          hotTokens,
          streamHotTokens,
          priceRefreshQueue,
          priceRefreshHttpFallbackQueue,
          heartbeat,
        ] = await Promise.all([
          readRedisZsetStats(
            redis,
            ADMIN_SYSTEM_HOT_KEYS[venue],
            env.hotTokensTtlSec,
            nowMs,
          ),
          readRedisZsetStats(
            redis,
            ADMIN_SYSTEM_HOT_STREAM_KEYS[venue],
            env.hotStreamTokensTtlSec,
            nowMs,
          ),
          readRedisPriceRefreshQueueStats(
            redis,
            PRICE_REFRESH_QUEUE_KEYS[venue],
            nowMs,
          ),
          venue === "limitless"
            ? readRedisPriceRefreshQueueStats(
                redis,
                LIMITLESS_PRICE_REFRESH_HTTP_FALLBACK_QUEUE_KEY,
                nowMs,
              )
            : Promise.resolve(null),
          readIndexerHeartbeat(redis, venue),
        ]);
        return {
          venue,
          hotTokens,
          streamHotTokens,
          priceRefreshQueue,
          priceRefreshHttpFallbackQueue,
          heartbeat,
          error: null,
        };
      } catch (venueError) {
        return {
          venue,
          hotTokens: null,
          streamHotTokens: null,
          priceRefreshQueue: null,
          priceRefreshHttpFallbackQueue: null,
          heartbeat: null,
          error:
            venueError instanceof Error
              ? venueError.message
              : "Failed to load indexer stats",
        };
      }
    }),
  );

  return {
    ...base,
    venues,
  };
}

async function readAdminPostgresSlowQueries() {
  try {
    const available = await pool.query<{ available: string | null }>(
      `select to_regclass('pg_stat_statements')::text as available`,
    );
    if (!available.rows[0]?.available) {
      return { available: false, error: null, items: [] };
    }
    const { rows } = await pool.query<{
      query: string;
      calls: string;
      total_ms: string;
      mean_ms: string;
      max_ms: string;
      rows_returned: string;
      shared_blks_hit: string;
      shared_blks_read: string;
      temp_blks_read: string;
      temp_blks_written: string;
    }>(
      `
        select
          query,
          calls::text,
          total_exec_time::text as total_ms,
          mean_exec_time::text as mean_ms,
          max_exec_time::text as max_ms,
          rows::text as rows_returned,
          shared_blks_hit::text,
          shared_blks_read::text,
          temp_blks_read::text,
          temp_blks_written::text
        from pg_stat_statements
        where dbid = (
          select oid
          from pg_database
          where datname = current_database()
        )
        order by total_exec_time desc
        limit 25
      `,
    );
    return {
      available: true,
      error: null,
      items: rows.map((row) => ({
        query: truncateAdminText(row.query),
        calls: Number(row.calls ?? 0),
        totalMs: Number(row.total_ms ?? 0),
        meanMs: Number(row.mean_ms ?? 0),
        maxMs: Number(row.max_ms ?? 0),
        rows: Number(row.rows_returned ?? 0),
        sharedBlksHit: Number(row.shared_blks_hit ?? 0),
        sharedBlksRead: Number(row.shared_blks_read ?? 0),
        tempBlksRead: Number(row.temp_blks_read ?? 0),
        tempBlksWritten: Number(row.temp_blks_written ?? 0),
      })),
    };
  } catch (error) {
    return {
      available: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to load pg_stat_statements",
      items: [],
    };
  }
}

async function buildAdminPostgresSystemStats() {
  const generatedAt = new Date().toISOString();
  const [
    dbRows,
    connectionRows,
    waitingRows,
    lockRows,
    blockerRows,
    tableRows,
    slowQueries,
  ] = await Promise.all([
    pool.query<{
      db_name: string;
      size_bytes: string;
      max_connections: string;
    }>(
      `
        select
          current_database() as db_name,
          pg_database_size(current_database())::text as size_bytes,
          current_setting('max_connections') as max_connections
      `,
    ),
    pool.query<{ state: string; count: string }>(
      `
        select coalesce(state, 'unknown') as state, count(*)::text as count
        from pg_stat_activity
        where datname = current_database()
        group by coalesce(state, 'unknown')
        order by count(*) desc
      `,
    ),
    pool.query<{ waiting: string }>(
      `
        select count(*)::text as waiting
        from pg_stat_activity
        where datname = current_database()
          and wait_event is not null
      `,
    ),
    pool.query<{ mode: string; granted: boolean; count: string }>(
      `
        select mode, granted, count(*)::text as count
        from pg_locks
        group by mode, granted
        order by count(*) desc, mode asc
        limit 30
      `,
    ),
    pool.query<{
      waiter_pid: number;
      blocker_pid: number;
      wait_event_type: string | null;
      wait_event: string | null;
      waiter_query: string | null;
      blocker_query: string | null;
    }>(
      `
        select
          blocked.pid as waiter_pid,
          blocking.pid as blocker_pid,
          blocked.wait_event_type,
          blocked.wait_event,
          blocked.query as waiter_query,
          blocking.query as blocker_query
        from pg_stat_activity blocked
        join lateral unnest(pg_blocking_pids(blocked.pid)) blocker_pid on true
        join pg_stat_activity blocking
          on blocking.pid = blocker_pid
        where blocked.datname = current_database()
        limit 20
      `,
    ),
    pool.query<{
      schemaname: string;
      relname: string;
      live_rows: string;
      dead_rows: string;
      seq_scan: string;
      idx_scan: string;
      last_vacuum: Date | null;
      last_autovacuum: Date | null;
      last_analyze: Date | null;
      last_autoanalyze: Date | null;
      total_bytes: string;
    }>(
      `
        select
          s.schemaname,
          s.relname,
          s.n_live_tup::text as live_rows,
          s.n_dead_tup::text as dead_rows,
          s.seq_scan::text,
          s.idx_scan::text,
          s.last_vacuum,
          s.last_autovacuum,
          s.last_analyze,
          s.last_autoanalyze,
          pg_total_relation_size(s.relid)::text as total_bytes
        from pg_stat_user_tables s
        order by pg_total_relation_size(s.relid) desc
        limit 25
      `,
    ),
    readAdminPostgresSlowQueries(),
  ]);

  const db = dbRows.rows[0];
  return {
    generatedAt,
    database: {
      name: db?.db_name ?? null,
      sizeBytes: Number(db?.size_bytes ?? 0),
      maxConnections: Number(db?.max_connections ?? 0),
    },
    connections: {
      byState: connectionRows.rows.map((row) => ({
        state: row.state,
        count: Number(row.count ?? 0),
      })),
      waiting: Number(waitingRows.rows[0]?.waiting ?? 0),
    },
    locks: {
      summary: lockRows.rows.map((row) => ({
        mode: row.mode,
        granted: row.granted,
        count: Number(row.count ?? 0),
      })),
      blockers: blockerRows.rows.map((row) => ({
        waiterPid: row.waiter_pid,
        blockerPid: row.blocker_pid,
        waitEventType: row.wait_event_type,
        waitEvent: row.wait_event,
        waiterQuery: truncateAdminText(row.waiter_query),
        blockerQuery: truncateAdminText(row.blocker_query),
      })),
    },
    slowQueries,
    tableHealth: tableRows.rows.map((row) => ({
      schema: row.schemaname,
      table: row.relname,
      liveRows: Number(row.live_rows ?? 0),
      deadRows: Number(row.dead_rows ?? 0),
      seqScan: Number(row.seq_scan ?? 0),
      idxScan: Number(row.idx_scan ?? 0),
      lastVacuum: row.last_vacuum,
      lastAutovacuum: row.last_autovacuum,
      lastAnalyze: row.last_analyze,
      lastAutoanalyze: row.last_autoanalyze,
      totalBytes: Number(row.total_bytes ?? 0),
    })),
  };
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

async function adminUserExists(userId: string): Promise<boolean> {
  const { rowCount } = await pool.query(`select 1 from users where id = $1`, [
    userId,
  ]);
  return (rowCount ?? 0) > 0;
}

function resolveAdminOrderWalletFilter(query: {
  wallet?: string;
  wallets?: string[];
}): string[] | undefined {
  const wallets = [...(query.wallets ?? []), query.wallet ?? ""]
    .map((wallet) => wallet.trim())
    .filter(Boolean);
  const unique = Array.from(new Set(wallets));
  return unique.length ? unique : undefined;
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
    includeSignerUsdc:
      funder.toLowerCase() !== inputs.walletAddress.toLowerCase(),
    negRiskAdapterAddress: env.polymarketNegRiskAdapterAddress,
    feeCollectorAddress: env.feeCollectorAddress,
  });
  return {
    funder,
    funderBalance: snapshot.usdcBalance,
    signerBalance: snapshot.signerUsdcBalance ?? null,
  };
}

async function fetchLimitlessBalance(walletAddress: string): Promise<bigint> {
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

  const treasury = Array.isArray(treasuryDecoded) ? treasuryDecoded[0] : null;
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

function resolvePolygonTokenSymbol(address: string | null | undefined): string {
  if (!address) return "USDC";
  try {
    const normalized = ethers.getAddress(address);
    if (normalized === ethers.getAddress(env.polymarketPusdAddress)) {
      return "pUSD";
    }
    if (normalized === ethers.getAddress(env.polymarketUsdceAddress)) {
      return "USDC.e";
    }
  } catch {
    return "USDC";
  }
  return "USDC";
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

function loadSolanaKeypair(secret: string): Keypair {
  const trimmed = secret.trim();
  if (!trimmed) {
    throw new Error("Missing HUNCH_REWARDS_SOLANA_SECRET_KEY");
  }
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(parsed));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  registerAdminFundingRoutes(app, {
    db: pool,
    authorize: (permission) =>
      createAdminMiddleware({ requiredAdminPermission: permission }),
    transact: (work) => tx(pool, (client: PoolClient) => work(client)),
  });

  z.get(
    "/admin/overview",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "finance:read",
      }),
    },
    async (_request, reply) => {
      const feeCollectorAddress = env.feeCollectorAddress?.trim() || "";
      const feeCollectorPrivateKey = env.feeCollectorPrivateKey?.trim() || "";
      const polymarketBuilderAddress =
        env.polymarketBuilderAddress?.trim() || "";
      const dflowFeeAccount = env.dflowFeeAccount?.trim() || "";
      let feeCollectorError: string | null = null;
      let feeCollectorTreasury: string | null = null;
      let feeCollectorCollateral: string | null = null;
      let feeCollectorTreasuryBalance: bigint | null = null;
      let feeCollectorSignerAddress: string | null = null;
      let feeCollectorSignerBalance: bigint | null = null;
      let feeCollectorSignerError: string | null = null;
      let polymarketBuilderChecksumAddress: string | null = null;
      let polymarketBuilderPusdBalance: bigint | null = null;
      let polymarketBuilderNativeBalance: bigint | null = null;
      let polymarketBuilderError: string | null = null;
      let dflowFeeBalance: bigint | null = null;
      let dflowFeeError: string | null = null;
      let dflowFeeOwner: string | null = null;
      let dflowFeeMint: string | null = null;
      type RewardsTreasuryAdminSummary = {
        claimableNow: string;
        claimableNowMicro: string;
        sweepableNow: string;
        sweepableNowMicro: string;
        deficitNow: string;
        deficitNowMicro: string;
        reserveFloor: string;
        reserveFloorMicro: string;
        liabilityPending: string;
        liabilityPendingMicro: string;
        liabilityCollected: string;
        liabilityCollectedMicro: string;
        outstandingCollectedPayable: string;
        outstandingCollectedPayableMicro: string;
        feeAccrued?: string;
        feeAccruedMicro?: string;
        feeVerified?: string;
        feeVerifiedMicro?: string;
        feeUnlockableNow?: string;
        feeUnlockableNowMicro?: string;
        feeReserveGap?: string;
        feeReserveGapMicro?: string;
      };
      const emptyTreasurySummary: RewardsTreasuryAdminSummary = {
        claimableNow: "0.000000",
        claimableNowMicro: "0",
        sweepableNow: "0.000000",
        sweepableNowMicro: "0",
        deficitNow: "0.000000",
        deficitNowMicro: "0",
        reserveFloor: "0.000000",
        reserveFloorMicro: "0",
        liabilityPending: "0.000000",
        liabilityPendingMicro: "0",
        liabilityCollected: "0.000000",
        liabilityCollectedMicro: "0",
        outstandingCollectedPayable: "0.000000",
        outstandingCollectedPayableMicro: "0",
      };
      const rewardsHotWallets: {
        polygon: {
          chainId: "137";
          chainLabel: "Polygon";
          nativeAsset: "POL";
          address: string | null;
          configured: boolean;
          nativeBalance: string | null;
          nativeBalanceRaw: string | null;
          usdcBalance: string | null;
          usdcBalanceRaw: string | null;
          usdceBalance: string | null;
          usdceBalanceRaw: string | null;
          payoutAsset: string;
          payoutTokenAddress: string;
          coldAddress: string | null;
          coldNativeBalance: string | null;
          coldNativeBalanceRaw: string | null;
          coldUsdcBalance: string | null;
          coldUsdcBalanceRaw: string | null;
          coldUsdceBalance: string | null;
          coldUsdceBalanceRaw: string | null;
          coldError: string | null;
          treasury: RewardsTreasuryAdminSummary;
          error: string | null;
        };
        base: {
          chainId: "8453";
          chainLabel: "Base";
          nativeAsset: "ETH";
          address: string | null;
          configured: boolean;
          nativeBalance: string | null;
          nativeBalanceRaw: string | null;
          usdcBalance: string | null;
          usdcBalanceRaw: string | null;
          payoutAsset: string;
          payoutTokenAddress: string;
          coldAddress: string | null;
          coldNativeBalance: string | null;
          coldNativeBalanceRaw: string | null;
          coldUsdcBalance: string | null;
          coldUsdcBalanceRaw: string | null;
          coldError: string | null;
          treasury: RewardsTreasuryAdminSummary;
          error: string | null;
        };
        solana: {
          chainId: "solana";
          chainLabel: "Solana";
          nativeAsset: "SOL";
          address: string | null;
          configured: boolean;
          nativeBalance: string | null;
          nativeBalanceRaw: string | null;
          usdcBalance: string | null;
          usdcBalanceRaw: string | null;
          payoutAsset: string;
          payoutTokenAddress: string;
          coldAddress: string | null;
          coldNativeBalance: string | null;
          coldNativeBalanceRaw: string | null;
          coldUsdcBalance: string | null;
          coldUsdcBalanceRaw: string | null;
          coldError: string | null;
          treasury: RewardsTreasuryAdminSummary;
          error: string | null;
        };
      } = {
        polygon: {
          chainId: "137",
          chainLabel: "Polygon",
          nativeAsset: "POL",
          address: null,
          configured: false,
          nativeBalance: null,
          nativeBalanceRaw: null,
          usdcBalance: null,
          usdcBalanceRaw: null,
          usdceBalance: null,
          usdceBalanceRaw: null,
          payoutAsset: resolvePolygonTokenSymbol(
            env.rewardsPayoutTokenAddressPolygon?.trim() ||
              env.polymarketPusdAddress,
          ),
          payoutTokenAddress:
            env.rewardsPayoutTokenAddressPolygon?.trim() ||
            env.polymarketPusdAddress,
          coldAddress: env.rewardsTreasuryColdAddressPolygon || null,
          coldNativeBalance: null,
          coldNativeBalanceRaw: null,
          coldUsdcBalance: null,
          coldUsdcBalanceRaw: null,
          coldUsdceBalance: null,
          coldUsdceBalanceRaw: null,
          coldError: null,
          treasury: { ...emptyTreasurySummary },
          error: null,
        },
        base: {
          chainId: "8453",
          chainLabel: "Base",
          nativeAsset: "ETH",
          address: null,
          configured: false,
          nativeBalance: null,
          nativeBalanceRaw: null,
          usdcBalance: null,
          usdcBalanceRaw: null,
          payoutAsset: "USDC",
          payoutTokenAddress:
            env.rewardsUsdcAddressBase || env.limitlessUsdcAddress,
          coldAddress: env.rewardsTreasuryColdAddressBase || null,
          coldNativeBalance: null,
          coldNativeBalanceRaw: null,
          coldUsdcBalance: null,
          coldUsdcBalanceRaw: null,
          coldError: null,
          treasury: { ...emptyTreasurySummary },
          error: null,
        },
        solana: {
          chainId: "solana",
          chainLabel: "Solana",
          nativeAsset: "SOL",
          address: null,
          configured: false,
          nativeBalance: null,
          nativeBalanceRaw: null,
          usdcBalance: null,
          usdcBalanceRaw: null,
          payoutAsset: "USDC",
          payoutTokenAddress: env.solanaUsdcMint,
          coldAddress: env.rewardsTreasuryColdAddressSolana || null,
          coldNativeBalance: null,
          coldNativeBalanceRaw: null,
          coldUsdcBalance: null,
          coldUsdcBalanceRaw: null,
          coldError: null,
          treasury: { ...emptyTreasurySummary },
          error: null,
        },
      };

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
          const isBase = chainId === "8453";
          const asset =
            meta.kind === "solana"
              ? "USDC"
              : isBase
                ? "USDC"
                : resolvePolygonTokenSymbol(env.polymarketUsdcAddress);
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
                asset,
                balance: formatUiAmount(amount, decimals),
                balanceRaw: amount.toString(),
                mint: env.solanaUsdcMint,
                explorer: meta.explorer,
              };
            }

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
              asset,
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
              asset,
              balance: null,
              balanceRaw: null,
              explorer: meta.explorer,
              error:
                error instanceof Error ? error.message : "Balance fetch failed",
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
            error instanceof Error
              ? error.message
              : "Fee collector fetch failed";
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

      if (polymarketBuilderAddress) {
        try {
          polymarketBuilderChecksumAddress = ethers.getAddress(
            polymarketBuilderAddress,
          );
          const provider = new ethers.JsonRpcProvider(env.polygonRpcUrl);
          const [pusdBalance, nativeBalance] = await Promise.all([
            fetchErc20Balance({
              tokenAddress: env.polymarketPusdAddress,
              owner: polymarketBuilderChecksumAddress,
              rpcUrl: env.polygonRpcUrl,
              multicallAddress: POLYGON_MULTICALL_ADDRESS,
            }),
            provider.getBalance(polymarketBuilderChecksumAddress),
          ]);
          polymarketBuilderPusdBalance = pusdBalance;
          polymarketBuilderNativeBalance = nativeBalance;
        } catch (error) {
          polymarketBuilderError =
            error instanceof Error
              ? error.message
              : "Polymarket builder balance fetch failed";
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

      const rewardsPayoutKeyPolygon =
        env.rewardsPayoutPrivateKeyPolygon?.trim() ||
        env.rewardsPayoutPrivateKey?.trim() ||
        "";
      if (rewardsPayoutKeyPolygon) {
        rewardsHotWallets.polygon.configured = true;
        try {
          const provider = new ethers.JsonRpcProvider(env.polygonRpcUrl);
          const wallet = new ethers.Wallet(rewardsPayoutKeyPolygon, provider);
          const usdcAddress =
            env.rewardsPayoutTokenAddressPolygon?.trim() ||
            env.polymarketPusdAddress;
          const [nativeBalance, usdcBalance, usdceBalance] = await Promise.all([
            provider.getBalance(wallet.address),
            fetchErc20Balance({
              tokenAddress: usdcAddress,
              owner: wallet.address,
              rpcUrl: env.polygonRpcUrl,
              multicallAddress: POLYGON_MULTICALL_ADDRESS,
            }),
            fetchErc20Balance({
              tokenAddress: env.polymarketUsdceAddress,
              owner: wallet.address,
              rpcUrl: env.polygonRpcUrl,
              multicallAddress: POLYGON_MULTICALL_ADDRESS,
            }),
          ]);

          rewardsHotWallets.polygon.address = wallet.address;
          rewardsHotWallets.polygon.nativeBalance =
            ethers.formatEther(nativeBalance);
          rewardsHotWallets.polygon.nativeBalanceRaw = nativeBalance.toString();
          rewardsHotWallets.polygon.usdcBalance = ethers.formatUnits(
            usdcBalance,
            6,
          );
          rewardsHotWallets.polygon.usdcBalanceRaw = usdcBalance.toString();
          rewardsHotWallets.polygon.usdceBalance = ethers.formatUnits(
            usdceBalance,
            6,
          );
          rewardsHotWallets.polygon.usdceBalanceRaw = usdceBalance.toString();
        } catch (error) {
          rewardsHotWallets.polygon.error =
            error instanceof Error
              ? error.message
              : "Rewards Polygon wallet fetch failed";
        }
      }

      const rewardsPayoutKeyBase =
        env.rewardsPayoutPrivateKeyBase?.trim() ||
        env.rewardsPayoutPrivateKey?.trim() ||
        "";
      if (rewardsPayoutKeyBase) {
        rewardsHotWallets.base.configured = true;
        try {
          const provider = new ethers.JsonRpcProvider(env.baseRpcUrl);
          const wallet = new ethers.Wallet(rewardsPayoutKeyBase, provider);
          const usdcAddress =
            env.rewardsUsdcAddressBase?.trim() || env.limitlessUsdcAddress;
          const [nativeBalance, usdcBalance] = await Promise.all([
            provider.getBalance(wallet.address),
            fetchErc20Balance({
              tokenAddress: usdcAddress,
              owner: wallet.address,
              rpcUrl: env.baseRpcUrl,
              multicallAddress: env.baseMulticallAddress,
            }),
          ]);

          rewardsHotWallets.base.address = wallet.address;
          rewardsHotWallets.base.nativeBalance =
            ethers.formatEther(nativeBalance);
          rewardsHotWallets.base.nativeBalanceRaw = nativeBalance.toString();
          rewardsHotWallets.base.usdcBalance = ethers.formatUnits(
            usdcBalance,
            6,
          );
          rewardsHotWallets.base.usdcBalanceRaw = usdcBalance.toString();
        } catch (error) {
          rewardsHotWallets.base.error =
            error instanceof Error
              ? error.message
              : "Rewards Base wallet fetch failed";
        }
      }

      const rewardsPayoutSolanaSecret =
        env.rewardsSolanaSecretKey?.trim() || "";
      if (rewardsPayoutSolanaSecret) {
        rewardsHotWallets.solana.configured = true;
        try {
          const keypair = loadSolanaKeypair(rewardsPayoutSolanaSecret);
          const ownerAddress = keypair.publicKey.toBase58();
          const [nativeBalance, usdcBalance] = await Promise.all([
            fetchSolanaBalanceLamports({
              rpcUrls: env.solanaRpcUrls,
              timeoutMs: env.solanaRpcTimeoutMs,
              owner: ownerAddress,
            }),
            fetchSolanaTokenBalanceByOwnerAndMint({
              rpcUrls: env.solanaRpcUrls,
              timeoutMs: env.solanaRpcTimeoutMs,
              owner: ownerAddress,
              mint: env.solanaUsdcMint,
            }),
          ]);

          rewardsHotWallets.solana.address = ownerAddress;
          rewardsHotWallets.solana.nativeBalance = formatUiAmount(
            nativeBalance,
            SOLANA_LAMPORT_DECIMALS,
          );
          rewardsHotWallets.solana.nativeBalanceRaw = nativeBalance.toString();
          rewardsHotWallets.solana.usdcBalance =
            usdcBalance?.uiAmountString ?? "0";
          rewardsHotWallets.solana.usdcBalanceRaw =
            usdcBalance?.amount.toString() ?? "0";
        } catch (error) {
          rewardsHotWallets.solana.error =
            error instanceof Error
              ? error.message
              : "Rewards Solana wallet fetch failed";
        }
      }

      await Promise.all([
        (async () => {
          if (!rewardsHotWallets.polygon.coldAddress) return;
          try {
            const provider = new ethers.JsonRpcProvider(env.polygonRpcUrl);
            const usdcAddress =
              env.rewardsPayoutTokenAddressPolygon?.trim() ||
              env.polymarketPusdAddress;
            const [nativeBalance, usdcBalance, usdceBalance] =
              await Promise.all([
                provider.getBalance(rewardsHotWallets.polygon.coldAddress),
                fetchErc20Balance({
                  tokenAddress: usdcAddress,
                  owner: rewardsHotWallets.polygon.coldAddress,
                  rpcUrl: env.polygonRpcUrl,
                  multicallAddress: POLYGON_MULTICALL_ADDRESS,
                }),
                fetchErc20Balance({
                  tokenAddress: env.polymarketUsdceAddress,
                  owner: rewardsHotWallets.polygon.coldAddress,
                  rpcUrl: env.polygonRpcUrl,
                  multicallAddress: POLYGON_MULTICALL_ADDRESS,
                }),
              ]);
            rewardsHotWallets.polygon.coldNativeBalance =
              ethers.formatEther(nativeBalance);
            rewardsHotWallets.polygon.coldNativeBalanceRaw =
              nativeBalance.toString();
            rewardsHotWallets.polygon.coldUsdcBalance = ethers.formatUnits(
              usdcBalance,
              6,
            );
            rewardsHotWallets.polygon.coldUsdcBalanceRaw =
              usdcBalance.toString();
            rewardsHotWallets.polygon.coldUsdceBalance = ethers.formatUnits(
              usdceBalance,
              6,
            );
            rewardsHotWallets.polygon.coldUsdceBalanceRaw =
              usdceBalance.toString();
          } catch (error) {
            rewardsHotWallets.polygon.coldError =
              error instanceof Error
                ? error.message
                : "Rewards Polygon cold wallet fetch failed";
          }
        })(),
        (async () => {
          if (!rewardsHotWallets.base.coldAddress) return;
          try {
            const provider = new ethers.JsonRpcProvider(env.baseRpcUrl);
            const usdcAddress =
              env.rewardsUsdcAddressBase?.trim() || env.limitlessUsdcAddress;
            const [nativeBalance, usdcBalance] = await Promise.all([
              provider.getBalance(rewardsHotWallets.base.coldAddress),
              fetchErc20Balance({
                tokenAddress: usdcAddress,
                owner: rewardsHotWallets.base.coldAddress,
                rpcUrl: env.baseRpcUrl,
                multicallAddress: env.baseMulticallAddress,
              }),
            ]);
            rewardsHotWallets.base.coldNativeBalance =
              ethers.formatEther(nativeBalance);
            rewardsHotWallets.base.coldNativeBalanceRaw =
              nativeBalance.toString();
            rewardsHotWallets.base.coldUsdcBalance = ethers.formatUnits(
              usdcBalance,
              6,
            );
            rewardsHotWallets.base.coldUsdcBalanceRaw = usdcBalance.toString();
          } catch (error) {
            rewardsHotWallets.base.coldError =
              error instanceof Error
                ? error.message
                : "Rewards Base cold wallet fetch failed";
          }
        })(),
        (async () => {
          if (!rewardsHotWallets.solana.coldAddress) return;
          try {
            const [nativeBalance, usdcBalance] = await Promise.all([
              fetchSolanaBalanceLamports({
                rpcUrls: env.solanaRpcUrls,
                timeoutMs: env.solanaRpcTimeoutMs,
                owner: rewardsHotWallets.solana.coldAddress,
              }),
              fetchSolanaTokenBalanceByOwnerAndMint({
                rpcUrls: env.solanaRpcUrls,
                timeoutMs: env.solanaRpcTimeoutMs,
                owner: rewardsHotWallets.solana.coldAddress,
                mint: env.solanaUsdcMint,
              }),
            ]);
            rewardsHotWallets.solana.coldNativeBalance = formatUiAmount(
              nativeBalance,
              SOLANA_LAMPORT_DECIMALS,
            );
            rewardsHotWallets.solana.coldNativeBalanceRaw =
              nativeBalance.toString();
            rewardsHotWallets.solana.coldUsdcBalance =
              usdcBalance?.uiAmountString ?? "0";
            rewardsHotWallets.solana.coldUsdcBalanceRaw =
              usdcBalance?.amount.toString() ?? "0";
          } catch (error) {
            rewardsHotWallets.solana.coldError =
              error instanceof Error
                ? error.message
                : "Rewards Solana cold wallet fetch failed";
          }
        })(),
      ]);

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

      const [rewardsTreasuryReport, feeAccrualRows] = await Promise.all([
        getRewardsTreasuryReport(pool),
        pool.query<{
          chain_id: string | null;
          status: string;
          amount: string | null;
          count: string;
        }>(
          `
            select chain_id,
                   status,
                   coalesce(sum(fee_amount), 0)::text as amount,
                   count(*)::text as count
            from venue_fee_accruals
            where status in ('accrued', 'verified')
              and fee_event_id is null
            group by chain_id, status
          `,
        ),
      ]);

      const feeAccrualMicroByChain = new Map<
        string,
        { accrued: bigint; verified: bigint }
      >();
      for (const row of feeAccrualRows.rows) {
        const chainId = row.chain_id ?? "unknown";
        const current = feeAccrualMicroByChain.get(chainId) ?? {
          accrued: 0n,
          verified: 0n,
        };
        const amount = parseUsdcToMicroFloor(row.amount ?? "0") ?? 0n;
        if (row.status === "accrued") current.accrued += amount;
        if (row.status === "verified") current.verified += amount;
        feeAccrualMicroByChain.set(chainId, current);
      }

      const applyTreasurySummary = (
        chainId: "137" | "8453" | "solana",
        wallet: { treasury: RewardsTreasuryAdminSummary },
      ) => {
        const chain = rewardsTreasuryReport.chains.find(
          (entry) => entry.chainId === chainId,
        );
        if (!chain) return;
        const sweepableNowMicro = BigInt(chain.sweepableNowMicro);
        const feeAccrual = feeAccrualMicroByChain.get(chainId) ?? {
          accrued: 0n,
          verified: 0n,
        };
        const feeUnlockableNowMicro = minBigint(
          feeAccrual.verified,
          sweepableNowMicro,
        );
        const feeReserveGapMicro = max0Bigint(
          feeAccrual.verified - sweepableNowMicro,
        );
        wallet.treasury = {
          claimableNow: chain.claimableNow.toString(),
          claimableNowMicro: chain.claimableNowMicro,
          sweepableNow: chain.sweepableNow.toString(),
          sweepableNowMicro: chain.sweepableNowMicro,
          deficitNow: chain.deficitNow.toString(),
          deficitNowMicro: chain.deficitNowMicro,
          reserveFloor: chain.reserveFloor.toString(),
          reserveFloorMicro: chain.reserveFloorMicro,
          liabilityPending: chain.liabilityPending.toString(),
          liabilityPendingMicro: chain.liabilityPendingMicro,
          liabilityCollected: chain.liabilityCollected.toString(),
          liabilityCollectedMicro: chain.liabilityCollectedMicro,
          outstandingCollectedPayable:
            chain.outstandingCollectedPayable.toString(),
          outstandingCollectedPayableMicro:
            chain.outstandingCollectedPayableMicro,
          feeAccrued: microAmountToDisplay(feeAccrual.accrued),
          feeAccruedMicro: feeAccrual.accrued.toString(),
          feeVerified: microAmountToDisplay(feeAccrual.verified),
          feeVerifiedMicro: feeAccrual.verified.toString(),
          feeUnlockableNow: microAmountToDisplay(feeUnlockableNowMicro),
          feeUnlockableNowMicro: feeUnlockableNowMicro.toString(),
          feeReserveGap: microAmountToDisplay(feeReserveGapMicro),
          feeReserveGapMicro: feeReserveGapMicro.toString(),
        };
      };

      applyTreasurySummary("137", rewardsHotWallets.polygon);
      applyTreasurySummary("8453", rewardsHotWallets.base);
      applyTreasurySummary("solana", rewardsHotWallets.solana);

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
          tokenSymbol: resolvePolygonTokenSymbol(
            feeCollectorCollateral ?? env.polymarketUsdcAddress,
          ),
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
        polymarketBuilder: {
          address: polymarketBuilderChecksumAddress,
          configured: Boolean(polymarketBuilderAddress),
          chainId: 137,
          tokenAddress: env.polymarketPusdAddress,
          tokenSymbol: resolvePolygonTokenSymbol(env.polymarketPusdAddress),
          balance:
            polymarketBuilderPusdBalance !== null
              ? ethers.formatUnits(polymarketBuilderPusdBalance, 6)
              : null,
          balanceRaw: polymarketBuilderPusdBalance?.toString() ?? null,
          nativeSymbol: "POL",
          nativeBalance:
            polymarketBuilderNativeBalance !== null
              ? ethers.formatEther(polymarketBuilderNativeBalance)
              : null,
          nativeBalanceRaw: polymarketBuilderNativeBalance?.toString() ?? null,
          error: polymarketBuilderError,
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
        rewardsHotWallets,
      });
    },
  );

  z.get(
    "/admin/api-cache-warm/status",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "analytics:read",
      }),
    },
    async (_request, reply) => {
      const policy = await resolveApiCacheWarmPolicy(pool);
      const { redis, status, error } = await getRedisStatus();
      let runner = {
        lastRunAt: null as string | null,
        lastCompletedAt: null as string | null,
        lastResult: null as string | null,
        durationMs: null as number | null,
        targetsAttempted: 0,
        targetsSucceeded: 0,
        targetsFailed: 0,
        baseUrl: null as string | null,
        error: null as string | null,
      };
      let targets: Awaited<
        ReturnType<typeof readApiCacheWarmStatus>
      >["targets"] = [];
      let redisError = redis ? null : (error ?? null);

      if (redis) {
        try {
          const snapshot = await readApiCacheWarmStatus(redis);
          runner = snapshot.runner;
          targets = snapshot.targets;
        } catch (readError) {
          redisError =
            readError instanceof Error
              ? readError.message
              : "Failed to load API cache warm status";
        }
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        policy: {
          source: policy.source,
          effectiveAt: policy.effectiveAt,
          createdAt: policy.createdAt,
          effective: policy.effective,
        },
        redis: {
          available: Boolean(redis),
          status,
          error: redisError,
        },
        runner,
        targets,
      });
    },
  );

  z.get(
    "/admin/system/postgres",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "analytics:read",
      }),
    },
    async (_request, reply) => {
      const stats = await buildAdminPostgresSystemStats();
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, ...stats });
    },
  );

  z.get(
    "/admin/system/indexers",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "analytics:read",
      }),
    },
    async (_request, reply) => {
      const stats = await buildAdminIndexerSystemStats();
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, ...stats });
    },
  );

  z.get(
    "/admin/vector",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "analytics:read",
      }),
    },
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
          event: {
            total: number | null;
            active: number | null;
            error: string | null;
          };
          market: {
            total: number | null;
            active: number | null;
            error: string | null;
          };
        };
      } = {
        available: false,
        error:
          status === "loading"
            ? "Redis loading"
            : status === "error"
              ? (redisError ?? "Redis unavailable")
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
            error instanceof Error
              ? error.message
              : "Redis stream lookup failed";
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
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "users:read",
      }),
      schema: {
        querystring: adminUsersQuerySchema,
        response: {
          200: adminUsersResponseSchema,
          400: adminUsersErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await listAdminUsers(pool, request.query);
      if (!result.ok) {
        reply.code(result.statusCode);
        return reply.send({ error: result.error });
      }
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(result);
    },
  );

  z.get(
    "/admin/users/:id",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "users:read",
      }),
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
        referral_code: string | null;
      }>(
        `
          select id, email, username, display_name, is_admin, kalshi_proof_bypass, is_active, last_login_at, created_at, referral_code
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

      const { rows: pointsRows } = await pool.query<{
        public_points: string | null;
        tier_points: string | null;
        qualification_points: string | null;
        raw_points: string | null;
      }>(
        `
          select
            coalesce(sum(${buildPublicPointsContributionSql("ve")}), 0)::text as public_points,
            coalesce(sum(${buildTierPointsContributionSql("ve")}), 0)::text as tier_points,
            coalesce(sum(${buildQualificationPointsContributionSql("ve")}), 0)::text as qualification_points,
            coalesce(sum(ve.points_awarded), 0)::text as raw_points
          from volume_events ve
          where ve.user_id = $1
        `,
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

      const { rows: inboundReferralRows } = await pool.query<{
        code: string;
        policy_type: "user" | "campaign" | null;
        label: string | null;
        multiplier_override: string | null;
        owner_user_id: string | null;
        referrer_user_id: string | null;
        referrer_email: string | null;
        referrer_username: string | null;
        referrer_display_name: string | null;
        referrer_wallet_address: string | null;
        attached_at: Date;
      }>(
        `
          select
            r.code,
            p.policy_type,
            p.label,
            p.multiplier_override::text as multiplier_override,
            p.owner_user_id,
            r.referrer_user_id,
            referrer.email as referrer_email,
            referrer.username as referrer_username,
            referrer.display_name as referrer_display_name,
            referrer_wallet.wallet_address as referrer_wallet_address,
            r.created_at as attached_at
          from referrals r
          left join referral_codes rc
            on rc.id = r.referral_code_id
          left join referral_code_policies p
            on p.id = rc.policy_id
          left join users referrer
            on referrer.id = r.referrer_user_id
          left join lateral (
            select wallet_address
            from user_wallets
            where user_id = r.referrer_user_id
            order by is_primary desc, created_at asc
            limit 1
          ) referrer_wallet on true
          where r.referred_user_id = $1
          order by r.created_at desc
          limit 1
        `,
        [id],
      );
      const inboundReferral = inboundReferralRows[0] ?? null;

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
          referralCode: user.referral_code,
          inboundReferral: inboundReferral
            ? {
                code: inboundReferral.code,
                policyType: inboundReferral.policy_type,
                label: inboundReferral.label,
                multiplierOverride:
                  inboundReferral.multiplier_override == null
                    ? null
                    : Number(inboundReferral.multiplier_override),
                ownerUserId: inboundReferral.owner_user_id,
                referrerUserId: inboundReferral.referrer_user_id,
                referrerEmail: inboundReferral.referrer_email,
                referrerUsername: inboundReferral.referrer_username,
                referrerDisplayName: inboundReferral.referrer_display_name,
                referrerWalletAddress: inboundReferral.referrer_wallet_address,
                attachedAt: inboundReferral.attached_at,
              }
            : null,
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
          points: Number(pointsRows[0]?.public_points ?? 0),
          tierPoints: Number(pointsRows[0]?.tier_points ?? 0),
          qualificationPoints: Number(pointsRows[0]?.qualification_points ?? 0),
          rawPoints: Number(pointsRows[0]?.raw_points ?? 0),
          feeUsdTotal: Number(feeRows[0]?.total_fee_usd ?? 0),
          feeUsdCollected: Number(feeRows[0]?.collected_fee_usd ?? 0),
          referralCount: Number(referralRows[0]?.count ?? 0),
        },
      });
    },
  );

  z.get(
    "/admin/users/:id/finance-summary",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermissions: [
          "users:read",
          "finance:read",
          "rewards:read",
        ],
      }),
      schema: { params: adminUserParamsSchema },
    },
    async (request, reply) => {
      const summary = await getAdminUserFinanceSummary(pool, {
        userId: request.params.id,
      });
      if (!summary) {
        reply.code(404);
        return reply.send({ error: "User not found" });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        summary,
      });
    },
  );

  z.get(
    "/admin/users/:id/balances",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "users:read",
      }),
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
              const polymarketAsset = resolvePolygonTokenSymbol(
                env.polymarketUsdcAddress,
              );
              try {
                const data = await fetchPolymarketBalances({
                  userId: id,
                  walletAddress: wallet.wallet_address,
                });
                const entries = [
                  {
                    venue: "polymarket",
                    chainId: 137,
                    asset: polymarketAsset,
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
                    asset: polymarketAsset,
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
                    asset: polymarketAsset,
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
    "/admin/users/:id/orders",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "users:read",
      }),
      schema: {
        params: adminUserParamsSchema,
        querystring: adminUserOrdersQuerySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const query = request.query;
      const limit = query.limit ?? 50;
      const offset = query.offset ?? 0;

      if (!(await adminUserExists(id))) {
        reply.code(404);
        return reply.send({ error: "User not found" });
      }

      const marketIds =
        query.marketId || !query.eventId
          ? []
          : await fetchUnifiedMarketIdsByEventId(pool, query.eventId);
      if (query.eventId && !query.marketId && marketIds.length === 0) {
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          orders: [],
          pagination: {
            total: 0,
            limit,
            offset,
            hasMore: false,
          },
        });
      }

      const result = await fetchUnifiedOrders(pool, {
        userId: id,
        walletAddresses: resolveAdminOrderWalletFilter(query),
        venue: query.venue,
        marketId: query.marketId,
        marketIds: marketIds.length ? marketIds : undefined,
        tokenId: query.tokenId,
        status: query.status,
        type: query.type,
        from: query.from,
        to: query.to,
        limit,
        offset,
      });

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        orders: result.rows.map(mapUnifiedOrder),
        pagination: {
          total: result.total,
          limit,
          offset,
          hasMore: offset + limit < result.total,
        },
      });
    },
  );

  z.get(
    "/admin/users/:id/orders/:orderId",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "users:read",
      }),
      schema: {
        params: adminUserOrderParamsSchema,
      },
    },
    async (request, reply) => {
      const { id, orderId } = request.params;

      const row = await fetchUnifiedOrderById(pool, {
        userId: id,
        id: orderId,
      });

      if (!row) {
        reply.code(404);
        return reply.send({ error: "Order not found" });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        order: mapUnifiedOrder(row),
      });
    },
  );

  z.get(
    "/admin/users/:id/activity",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "users:read",
      }),
      schema: {
        params: adminUserParamsSchema,
        querystring: adminUserActivityQuerySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const limit = request.query.limit ?? 20;
      const decodedCursor = decodeAdminKeysetCursor(request.query.cursor);
      if (decodedCursor.error) {
        reply.code(400);
        return reply.send({ error: decodedCursor.error });
      }
      const cursor = decodedCursor.cursor;
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

      const params: Array<string | number | Date> = [
        id,
        polymarketUsdc,
        limitlessUsdc,
        solanaUsdc,
      ];
      let cursorSql = "";
      if (cursor) {
        params.push(cursor.createdAt);
        const cursorCreatedAtIdx = params.length;
        params.push(cursor.id);
        const cursorIdIdx = params.length;
        cursorSql = `where (activity.created_at, activity.id) < ($${cursorCreatedAtIdx}, $${cursorIdIdx})`;
      }
      params.push(limit + 1);
      const limitIdx = params.length;

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
                when e.input_mint is not null and lower(e.input_mint) = lower($2) then (e.amount_in / 1000000)
                when e.output_mint is not null and lower(e.output_mint) = lower($2) then (e.amount_out / 1000000)
                when e.input_mint is not null and lower(e.input_mint) = lower($3) then (e.amount_in / 1000000)
                when e.output_mint is not null and lower(e.output_mint) = lower($3) then (e.amount_out / 1000000)
                when e.input_mint = $4 then (e.amount_in / 1000000)
                when e.output_mint = $4 then (e.amount_out / 1000000)
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
          ${cursorSql}
          order by created_at desc, id desc
          limit $${limitIdx}
        `,
        params,
      );
      const page = buildAdminCursorPage(rows, limit);

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        items: page.items.map((row) => ({
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
        hasMore: page.hasMore,
        limit,
        nextCursor: page.nextCursor,
      });
    },
  );

  z.get(
    "/admin/analytics/collector",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "analytics:read",
      }),
    },
    async (_request, reply) => {
      const telemetry = await fetchAnalyticsForwardingTelemetry(pool, {
        breakdownWindowDays: ADMIN_ANALYTICS_COLLECTOR_WINDOW_DAYS,
      });
      const collectedEvents = new Set(listCollectedAnalyticsEvents());
      const [
        { rows: lastStoredRows },
        { rows: oldestStoredRows },
        { rows: expectedRows },
      ] = await Promise.all([
        pool.query<{ created_at: Date | null }>(
          `
            select created_at
            from analytics_server_events
            order by created_at desc
            limit 1
          `,
        ),
        pool.query<{ created_at: Date | null }>(
          `
            select created_at
            from analytics_server_events
            order by created_at asc
            limit 1
          `,
        ),
        pool.query<{
          count: string;
          event_name: string;
          last_seen_at: Date | null;
        }>(
          `
            select
              event_name,
              count(*)::text as count,
              max(created_at) as last_seen_at
            from analytics_server_events
            where event_name = any($1::text[])
              and created_at >= now() - make_interval(days => $2::int)
            group by event_name
          `,
          [
            ADMIN_ANALYTICS_EXPECTED_MONITOR_EVENTS,
            ADMIN_ANALYTICS_COLLECTOR_WINDOW_DAYS,
          ],
        ),
      ]);
      const expectedByEvent = new Map(
        expectedRows.map((row) => [
          row.event_name,
          {
            count: Number(row.count),
            lastSeenAt: row.last_seen_at,
          },
        ]),
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        enabled: env.analyticsServerForwardingEnabled,
        ...telemetry,
        collector: {
          ...telemetry.collector,
          coverageWindowDays: ADMIN_ANALYTICS_COLLECTOR_WINDOW_DAYS,
          lastStoredAt: lastStoredRows[0]?.created_at ?? null,
          oldestStoredAt: oldestStoredRows[0]?.created_at ?? null,
        },
        coverage: ADMIN_ANALYTICS_EXPECTED_MONITOR_EVENTS.map((eventName) => {
          const metadata = getAdminAnalyticsEventMetadata(eventName);
          const observed = expectedByEvent.get(eventName);
          return {
            eventName,
            supported: collectedEvents.has(eventName),
            storedEvents: observed?.count ?? 0,
            lastSeenAt: observed?.lastSeenAt ?? null,
            domain: metadata.domain,
            owner: metadata.owner,
            tier: metadata.tier,
          };
        }),
      });
    },
  );

  z.get(
    "/admin/analytics/overview",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "analytics:read",
      }),
      schema: {
        querystring: adminAnalyticsRangeQuerySchema,
      },
    },
    async (request, reply) => {
      const range = request.query.range ?? "7d";
      const window = resolveAdminAnalyticsWindow(range);
      const whereParts: string[] = [];
      const whereParams: Array<string | Date | number | string[]> = [];
      appendAdminAnalyticsRangeWhere(whereParts, whereParams, window);
      const whereSql = buildAdminAnalyticsWhere(whereParts);
      const timelineGranularity =
        resolveAdminUserAnalyticsTimelineGranularity(range);

      const previousParams: Array<string | Date | number | string[]> = [];
      const previousParts: string[] = [];
      if (window.previousRangeStartAt && window.previousRangeEndAt) {
        appendAdminAnalyticsRangeWhere(previousParts, previousParams, {
          rangeEndAt: window.previousRangeEndAt,
          rangeStartAt: window.previousRangeStartAt,
        });
      }
      const previousWhereSql =
        previousParts.length > 0
          ? buildAdminAnalyticsWhere(previousParts)
          : null;

      const [
        { rows: summaryRows },
        { rows: outcomeRows },
        { rows: timelineRows },
        { rows: byEventRows },
        { rows: byDomainRows },
        { rows: byVenueRows },
        { rows: bySourceRows },
        { rows: byOriginRows },
        { rows: bySchemaVersionRows },
        previousOutcomeResult,
        previousSummaryResult,
      ] = await Promise.all([
        pool.query<{
          active_users: string;
          distinct_event_count: string;
          first_seen_at: Date | null;
          last_seen_at: Date | null;
          total_events: string;
        }>(
          `
            select
              count(*)::text as total_events,
              count(distinct user_id) filter (where user_id is not null)::text as active_users,
              count(distinct event_name)::text as distinct_event_count,
              min(created_at) as first_seen_at,
              max(created_at) as last_seen_at
            from analytics_server_events
            where ${whereSql}
          `,
          whereParams,
        ),
        pool.query<{ count: string; outcome: AdminUserAnalyticsOutcome }>(
          `
            select outcome, count(*)::text as count
            from (
              select ${ADMIN_USER_ANALYTICS_OUTCOME_SQL} as outcome
              from analytics_server_events
              where ${whereSql}
            ) scoped
            group by outcome
          `,
          whereParams,
        ),
        pool.query<{
          bucket_start_at: Date;
          count: string;
          outcome: AdminUserAnalyticsOutcome;
        }>(
          `
            select
              date_trunc('${timelineGranularity}', created_at) as bucket_start_at,
              ${ADMIN_USER_ANALYTICS_OUTCOME_SQL} as outcome,
              count(*)::text as count
            from analytics_server_events
            where ${whereSql}
            group by 1, 2
            order by bucket_start_at asc
          `,
          whereParams,
        ),
        pool.query<{ count: string; event_name: string }>(
          `
            select event_name, count(*)::text as count
            from analytics_server_events
            where ${whereSql}
            group by event_name
            order by count(*) desc, event_name asc
            limit 30
          `,
          whereParams,
        ),
        pool.query<{ count: string; domain: string }>(
          `
            select ${ADMIN_ANALYTICS_DOMAIN_SQL} as domain, count(*)::text as count
            from analytics_server_events
            where ${whereSql}
            group by 1
            order by count(*) desc, domain asc
          `,
          whereParams,
        ),
        pool.query<{ count: string; venue: string }>(
          `
            select venue, count(*)::text as count
            from analytics_server_events
            where ${whereSql} and venue is not null
            group by venue
            order by count(*) desc, venue asc
            limit 20
          `,
          whereParams,
        ),
        pool.query<{ count: string; source: string }>(
          `
            select source, count(*)::text as count
            from analytics_server_events
            where ${whereSql} and source is not null
            group by source
            order by count(*) desc, source asc
            limit 20
          `,
          whereParams,
        ),
        pool.query<{ count: string; origin: "backend" | "browser" }>(
          `
            select origin, count(*)::text as count
            from analytics_server_events
            where ${whereSql}
            group by origin
            order by count(*) desc, origin asc
          `,
          whereParams,
        ),
        pool.query<{ count: string; version: string }>(
          `
            select analytics_schema_version as version, count(*)::text as count
            from analytics_server_events
            where ${whereSql}
            group by analytics_schema_version
            order by count(*) desc, analytics_schema_version desc
            limit 20
          `,
          whereParams,
        ),
        previousWhereSql
          ? pool.query<{ count: string; outcome: AdminUserAnalyticsOutcome }>(
              `
                select outcome, count(*)::text as count
                from (
                  select ${ADMIN_USER_ANALYTICS_OUTCOME_SQL} as outcome
                  from analytics_server_events
                  where ${previousWhereSql}
                ) scoped
                group by outcome
              `,
              previousParams,
            )
          : Promise.resolve({ rows: [] }),
        previousWhereSql
          ? pool.query<{
              active_users: string;
              distinct_event_count: string;
              total_events: string;
            }>(
              `
                select
                  count(*)::text as total_events,
                  count(distinct user_id) filter (where user_id is not null)::text as active_users,
                  count(distinct event_name)::text as distinct_event_count
                from analytics_server_events
                where ${previousWhereSql}
              `,
              previousParams,
            )
          : Promise.resolve({ rows: [] }),
      ]);

      const outcomeTotals = {
        action: 0,
        failure: 0,
        success: 0,
        timeout: 0,
      };
      for (const row of outcomeRows) {
        outcomeTotals[row.outcome] = Number(row.count);
      }
      const previousOutcomeTotals = {
        action: 0,
        failure: 0,
        success: 0,
        timeout: 0,
      };
      for (const row of previousOutcomeResult.rows) {
        previousOutcomeTotals[row.outcome] = Number(row.count);
      }

      const timelineByBucket = new Map<
        string,
        {
          action: number;
          bucketStartAt: Date;
          failure: number;
          success: number;
          timeout: number;
          total: number;
        }
      >();
      for (const row of timelineRows) {
        const key = row.bucket_start_at.toISOString();
        const bucket =
          timelineByBucket.get(key) ??
          ({
            action: 0,
            bucketStartAt: row.bucket_start_at,
            failure: 0,
            success: 0,
            timeout: 0,
            total: 0,
          } satisfies {
            action: number;
            bucketStartAt: Date;
            failure: number;
            success: number;
            timeout: number;
            total: number;
          });
        const count = Number(row.count);
        bucket[row.outcome] += count;
        bucket.total += count;
        timelineByBucket.set(key, bucket);
      }

      const summary = summaryRows[0];
      const terminalSuccessRatePct = resolveAdminAnalyticsTerminalRate(
        outcomeTotals.success,
        outcomeTotals.failure,
        outcomeTotals.timeout,
      );
      const previousTerminalSuccessRatePct = resolveAdminAnalyticsTerminalRate(
        previousOutcomeTotals.success,
        previousOutcomeTotals.failure,
        previousOutcomeTotals.timeout,
      );
      const previousSummary = previousSummaryResult.rows[0];

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        range,
        rangeStartAt: window.rangeStartAt,
        rangeEndAt: window.rangeEndAt,
        previousRange:
          window.previousRangeStartAt && window.previousRangeEndAt
            ? {
                rangeStartAt: window.previousRangeStartAt,
                rangeEndAt: window.previousRangeEndAt,
                activeUsers: Number(previousSummary?.active_users ?? 0),
                distinctEvents: Number(
                  previousSummary?.distinct_event_count ?? 0,
                ),
                outcomeTotals: previousOutcomeTotals,
                problemCount:
                  previousOutcomeTotals.failure + previousOutcomeTotals.timeout,
                terminalSuccessRatePct: previousTerminalSuccessRatePct,
                totalEvents: Number(previousSummary?.total_events ?? 0),
              }
            : null,
        summary: {
          activeUsers: Number(summary?.active_users ?? 0),
          distinctEvents: Number(summary?.distinct_event_count ?? 0),
          firstSeenAt: summary?.first_seen_at ?? null,
          lastSeenAt: summary?.last_seen_at ?? null,
          outcomeTotals,
          problemCount: outcomeTotals.failure + outcomeTotals.timeout,
          terminalSuccessRatePct,
          totalEvents: Number(summary?.total_events ?? 0),
        },
        breakdowns: {
          byDomain: byDomainRows.map((row) => ({
            domain: row.domain,
            count: Number(row.count),
          })),
          byEvent: byEventRows.map((row) => {
            const metadata = getAdminAnalyticsEventMetadata(row.event_name);
            return {
              eventName: row.event_name,
              count: Number(row.count),
              domain: metadata.domain,
              owner: metadata.owner,
              tier: metadata.tier,
            };
          }),
          byOrigin: byOriginRows.map((row) => ({
            origin: row.origin,
            count: Number(row.count),
          })),
          bySchemaVersion: bySchemaVersionRows.map((row) => ({
            version: row.version,
            count: Number(row.count),
          })),
          bySource: bySourceRows.map((row) => ({
            source: row.source,
            count: Number(row.count),
          })),
          byVenue: byVenueRows.map((row) => ({
            venue: row.venue,
            count: Number(row.count),
          })),
          timeline: [...timelineByBucket.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, bucket]) => ({
              bucketStartAt: bucket.bucketStartAt,
              action: bucket.action,
              failure: bucket.failure,
              success: bucket.success,
              timeout: bucket.timeout,
              total: bucket.total,
            })),
        },
      });
    },
  );

  z.get(
    "/admin/analytics/events",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermissions: ["analytics:read", "users:read"],
      }),
      schema: {
        querystring: adminAnalyticsEventsQuerySchema,
      },
    },
    async (request, reply) => {
      const limit = request.query.limit ?? 50;
      const decodedCursor = decodeAdminKeysetCursor(request.query.cursor);
      if (decodedCursor.error) {
        reply.code(400);
        return reply.send({ error: decodedCursor.error });
      }

      const range = request.query.range ?? "7d";
      const window = resolveAdminAnalyticsWindow(range);
      const whereParts: string[] = [];
      const params: Array<string | Date | number | string[]> = [];
      appendAdminAnalyticsRangeWhere(
        whereParts,
        params,
        window,
        "e.created_at",
      );

      if (request.query.eventName) {
        params.push(request.query.eventName);
        whereParts.push(`e.event_name = $${params.length}`);
      }
      if (request.query.domain) {
        const eventsForDomain = getAdminAnalyticsEventsForDomain(
          request.query.domain,
        );
        if (eventsForDomain.length === 0) {
          whereParts.push("false");
        } else {
          params.push(eventsForDomain);
          whereParts.push(`e.event_name = any($${params.length}::text[])`);
        }
      }
      if (request.query.outcome) {
        params.push(request.query.outcome);
        whereParts.push(
          `(${ADMIN_USER_ANALYTICS_OUTCOME_SQL}) = $${params.length}`,
        );
      }
      if (request.query.venue) {
        params.push(request.query.venue);
        whereParts.push(`e.venue = $${params.length}`);
      }
      if (request.query.source) {
        params.push(request.query.source);
        whereParts.push(`e.source = $${params.length}`);
      }
      if (request.query.status) {
        params.push(request.query.status);
        whereParts.push(`e.status = $${params.length}`);
      }
      if (request.query.origin) {
        params.push(request.query.origin);
        whereParts.push(`e.origin = $${params.length}`);
      }
      if (request.query.userId) {
        params.push(request.query.userId);
        whereParts.push(`e.user_id = $${params.length}`);
      }
      if (request.query.q) {
        params.push(request.query.q);
        const qIdx = params.length;
        whereParts.push(`(
          e.event_name = $${qIdx}
          or e.event_slug = $${qIdx}
          or e.source = $${qIdx}
          or e.status = $${qIdx}
          or e.venue = $${qIdx}
          or e.attempt_id = $${qIdx}
          or e.payload->>'market_slug' = $${qIdx}
          or e.payload->>'tx_hash' = $${qIdx}
          or e.payload->>'error_message' = $${qIdx}
        )`);
      }

      const cursor = decodedCursor.cursor;
      if (cursor) {
        params.push(cursor.createdAt);
        const cursorCreatedAtIdx = params.length;
        params.push(cursor.id);
        const cursorIdIdx = params.length;
        whereParts.push(
          `(e.created_at, e.id) < ($${cursorCreatedAtIdx}, $${cursorIdIdx})`,
        );
      }

      params.push(limit + 1);
      const limitPlaceholder = `$${params.length}`;
      const whereSql = buildAdminAnalyticsWhere(whereParts);
      const { rows } = await pool.query<{
        analytics_schema_version: string;
        attempt_id: string | null;
        created_at: Date;
        email: string | null;
        event_name: string;
        event_slug: string | null;
        id: string;
        origin: "backend" | "browser";
        payload: unknown;
        primary_wallet: string | null;
        referral_code: string | null;
        referred_user_key: string | null;
        source: string | null;
        status: string | null;
        user_id: string | null;
        venue: string | null;
      }>(
        `
          select
            e.id::text,
            e.user_id::text,
            e.event_name,
            e.event_slug,
            e.source,
            e.status,
            e.venue,
            e.referred_user_key,
            e.attempt_id,
            e.analytics_schema_version,
            e.origin,
            e.payload,
            e.created_at,
            u.email,
            u.referral_code,
            w.wallet_address as primary_wallet
          from analytics_server_events e
          left join users u on u.id = e.user_id
          left join lateral (
            select wallet_address
            from user_wallets
            where user_id = e.user_id
            order by is_primary desc, created_at asc
            limit 1
          ) w on true
          where ${whereSql}
          order by e.created_at desc, e.id desc
          limit ${limitPlaceholder}
        `,
        params,
      );
      const page = buildAdminCursorPage(rows, limit);

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        range,
        rangeStartAt: window.rangeStartAt,
        rangeEndAt: window.rangeEndAt,
        items: page.items.map((row) => {
          const metadata = getAdminAnalyticsEventMetadata(row.event_name);
          return {
            id: row.id,
            userId: row.user_id,
            user: row.user_id
              ? {
                  id: row.user_id,
                  email: row.email,
                  primaryWallet: row.primary_wallet,
                  referralCode: row.referral_code,
                }
              : null,
            eventName: row.event_name,
            eventSlug: row.event_slug,
            domain: metadata.domain,
            owner: metadata.owner,
            tier: metadata.tier,
            outcome:
              row.event_name.toLowerCase().includes("no_terminal") ||
              row.status?.toLowerCase().includes("timeout")
                ? "timeout"
                : row.event_name.toLowerCase().endsWith("_fail") ||
                    row.event_name.toLowerCase().endsWith("_error") ||
                    row.status?.toLowerCase().includes("fail") ||
                    row.status?.toLowerCase().includes("error") ||
                    row.status?.toLowerCase().includes("missing") ||
                    row.status?.toLowerCase().includes("unavailable")
                  ? "failure"
                  : row.event_name.toLowerCase().endsWith("_success") ||
                      row.event_name
                        .toLowerCase()
                        .includes("completed_funnel") ||
                      row.status?.toLowerCase().includes("success") ||
                      row.status?.toLowerCase().includes("completed") ||
                      row.status?.toLowerCase().includes("captured")
                    ? "success"
                    : "action",
            source: row.source,
            status: row.status,
            venue: row.venue,
            referredUserKey: row.referred_user_key,
            attemptId: row.attempt_id,
            analyticsSchemaVersion: row.analytics_schema_version,
            origin: row.origin,
            createdAt: row.created_at,
            page: readAnalyticsPayloadString(row.payload, "page"),
            marketSlug: readAnalyticsPayloadString(row.payload, "market_slug"),
            eventId: readAnalyticsPayloadString(row.payload, "event_id"),
            amountUsd: readAnalyticsPayloadNumber(row.payload, "amount_usd"),
            shares: readAnalyticsPayloadNumber(row.payload, "shares"),
            price: readAnalyticsPayloadNumber(row.payload, "price"),
            errorMessage: readAnalyticsPayloadString(
              row.payload,
              "error_message",
            ),
            txHash: readAnalyticsPayloadString(row.payload, "tx_hash"),
            walletType: readAnalyticsPayloadString(row.payload, "wallet_type"),
            chainId: readAnalyticsPayloadString(row.payload, "chain_id"),
            payload: row.payload,
          };
        }),
        hasMore: page.hasMore,
        limit,
        nextCursor: page.nextCursor,
      });
    },
  );

  z.get(
    "/admin/analytics/referrals",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "analytics:read",
      }),
      schema: {
        querystring: adminAnalyticsRangeQuerySchema,
      },
    },
    async (request, reply) => {
      const range = request.query.range ?? "30d";
      const window = resolveAdminAnalyticsWindow(range);
      const boundsParams = [window.rangeStartAt, window.rangeEndAt];
      const previousBoundsParams =
        window.previousRangeStartAt && window.previousRangeEndAt
          ? [window.previousRangeStartAt, window.previousRangeEndAt]
          : null;
      const rangePredicate = (alias: string) =>
        `${alias}.created_at < b.range_end_at and (b.range_start_at is null or ${alias}.created_at >= b.range_start_at)`;
      const totalsSql = `
        with b as (
          select $1::timestamptz as range_start_at, $2::timestamptz as range_end_at
        )
        select
          (
            select count(*)::text
            from analytics_server_events e, b
            where ${rangePredicate("e")}
              and e.event_name in ('hf_portfolio_share_action', 'hf_rewards_referral_action')
          ) as share_count,
          (
            select count(*)::text
            from analytics_server_events e, b
            where ${rangePredicate("e")}
              and e.event_name = 'hf_referral_link_landing'
          ) as landing_count,
          (
            select count(*)::text
            from referrals r, b
            where ${rangePredicate("r")}
          ) as signup_count,
          (
            select count(*)::text
            from referral_first_trade_conversions c, b
            where ${rangePredicate("c")}
          ) as first_trade_count
      `;

      const [
        { rows: totalRows },
        previousTotalResult,
        { rows: topCodeRows },
        { rows: topVenueRows },
        { rows: topSourceRows },
        { rows: topStatusRows },
      ] = await Promise.all([
        pool.query<{
          first_trade_count: string;
          landing_count: string;
          share_count: string;
          signup_count: string;
        }>(totalsSql, boundsParams),
        previousBoundsParams
          ? pool.query<{
              first_trade_count: string;
              landing_count: string;
              share_count: string;
              signup_count: string;
            }>(totalsSql, previousBoundsParams)
          : Promise.resolve({ rows: [] }),
        pool.query<{
          first_trade_count: string;
          landing_count: string;
          referral_code: string;
          share_count: string;
          signup_count: string;
        }>(
          `
            with b as (
              select $1::timestamptz as range_start_at, $2::timestamptz as range_end_at
            ),
            referral_codes as (
              select distinct e.event_slug as referral_code
              from analytics_server_events e, b
              where ${rangePredicate("e")}
                and e.event_slug is not null
                and e.event_name in (
                  'hf_portfolio_share_action',
                  'hf_rewards_referral_action',
                  'hf_referral_link_landing'
                )

              union

              select distinct r.code as referral_code
              from referrals r, b
              where ${rangePredicate("r")}
                and r.code is not null

              union

              select distinct c.code as referral_code
              from referral_first_trade_conversions c, b
              where ${rangePredicate("c")}
                and c.code is not null
            ),
            share_counts as (
              select e.event_slug as referral_code, count(*)::bigint as share_count
              from analytics_server_events e, b
              where ${rangePredicate("e")}
                and e.event_slug is not null
                and e.event_name in ('hf_portfolio_share_action', 'hf_rewards_referral_action')
              group by e.event_slug
            ),
            landing_counts as (
              select e.event_slug as referral_code, count(*)::bigint as landing_count
              from analytics_server_events e, b
              where ${rangePredicate("e")}
                and e.event_slug is not null
                and e.event_name = 'hf_referral_link_landing'
              group by e.event_slug
            ),
            signup_counts as (
              select r.code as referral_code, count(*)::bigint as signup_count
              from referrals r, b
              where ${rangePredicate("r")}
                and r.code is not null
              group by r.code
            ),
            first_trade_counts as (
              select c.code as referral_code, count(*)::bigint as first_trade_count
              from referral_first_trade_conversions c, b
              where ${rangePredicate("c")}
                and c.code is not null
              group by c.code
            )
            select
              rc.referral_code,
              coalesce(sc.share_count, 0)::text as share_count,
              coalesce(lc.landing_count, 0)::text as landing_count,
              coalesce(suc.signup_count, 0)::text as signup_count,
              coalesce(ftc.first_trade_count, 0)::text as first_trade_count
            from referral_codes rc
            left join share_counts sc on sc.referral_code = rc.referral_code
            left join landing_counts lc on lc.referral_code = rc.referral_code
            left join signup_counts suc on suc.referral_code = rc.referral_code
            left join first_trade_counts ftc on ftc.referral_code = rc.referral_code
            order by
              coalesce(ftc.first_trade_count, 0) desc,
              coalesce(suc.signup_count, 0) desc,
              coalesce(lc.landing_count, 0) desc,
              coalesce(sc.share_count, 0) desc,
              rc.referral_code asc
            limit 25
          `,
          boundsParams,
        ),
        pool.query<{ count: string; venue: string }>(
          `
            with b as (
              select $1::timestamptz as range_start_at, $2::timestamptz as range_end_at
            )
            select venue, count(*)::text as count
            from referral_first_trade_conversions c, b
            where ${rangePredicate("c")}
              and c.venue is not null
            group by venue
            order by count(*) desc, venue asc
            limit 20
          `,
          boundsParams,
        ),
        pool.query<{ count: string; source: string }>(
          `
            with b as (
              select $1::timestamptz as range_start_at, $2::timestamptz as range_end_at
            )
            select source, count(*)::text as count
            from analytics_server_events e, b
            where ${rangePredicate("e")}
              and e.event_name in (
                'hf_portfolio_share_action',
                'hf_rewards_referral_action',
                'hf_referral_link_landing'
              )
              and e.source is not null
            group by source
            order by count(*) desc, source asc
            limit 20
          `,
          boundsParams,
        ),
        pool.query<{ count: string; status: string }>(
          `
            with b as (
              select $1::timestamptz as range_start_at, $2::timestamptz as range_end_at
            )
            select status, count(*)::text as count
            from (
              select e.status
              from analytics_server_events e, b
              where ${rangePredicate("e")}
                and e.event_name in (
                  'hf_portfolio_share_action',
                  'hf_rewards_referral_action',
                  'hf_referral_link_landing'
                )
                and e.status is not null

              union all

              select c.status
              from referral_first_trade_conversions c, b
              where ${rangePredicate("c")}
                and c.status is not null
            ) statuses
            group by status
            order by count(*) desc, status asc
            limit 20
          `,
          boundsParams,
        ),
      ]);

      const totals = {
        firstTradeCount: Number(totalRows[0]?.first_trade_count ?? 0),
        landingCount: Number(totalRows[0]?.landing_count ?? 0),
        shareCount: Number(totalRows[0]?.share_count ?? 0),
        signupCount: Number(totalRows[0]?.signup_count ?? 0),
      };
      const previousTotals = previousTotalResult.rows[0]
        ? {
            firstTradeCount: Number(
              previousTotalResult.rows[0].first_trade_count ?? 0,
            ),
            landingCount: Number(
              previousTotalResult.rows[0].landing_count ?? 0,
            ),
            shareCount: Number(previousTotalResult.rows[0].share_count ?? 0),
            signupCount: Number(previousTotalResult.rows[0].signup_count ?? 0),
          }
        : null;

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        range,
        rangeStartAt: window.rangeStartAt,
        rangeEndAt: window.rangeEndAt,
        totals: {
          ...totals,
          landingToSignupConversionPct: ratePct(
            totals.signupCount,
            totals.landingCount,
          ),
          signupToFirstTradeConversionPct: ratePct(
            totals.firstTradeCount,
            totals.signupCount,
          ),
        },
        previousRange:
          previousTotals &&
          window.previousRangeStartAt &&
          window.previousRangeEndAt
            ? {
                rangeStartAt: window.previousRangeStartAt,
                rangeEndAt: window.previousRangeEndAt,
                totals: {
                  ...previousTotals,
                  landingToSignupConversionPct: ratePct(
                    previousTotals.signupCount,
                    previousTotals.landingCount,
                  ),
                  signupToFirstTradeConversionPct: ratePct(
                    previousTotals.firstTradeCount,
                    previousTotals.signupCount,
                  ),
                },
              }
            : null,
        topReferralCodes: topCodeRows.map((row) => ({
          referralCode: row.referral_code,
          shareCount: Number(row.share_count),
          landingCount: Number(row.landing_count),
          signupCount: Number(row.signup_count),
          firstTradeCount: Number(row.first_trade_count),
          landingToSignupConversionPct: ratePct(
            Number(row.signup_count),
            Number(row.landing_count),
          ),
          signupToFirstTradeConversionPct: ratePct(
            Number(row.first_trade_count),
            Number(row.signup_count),
          ),
        })),
        topVenues: topVenueRows.map((row) => ({
          venue: row.venue,
          count: Number(row.count),
        })),
        topSources: topSourceRows.map((row) => ({
          source: row.source,
          count: Number(row.count),
        })),
        topStatuses: topStatusRows.map((row) => ({
          status: row.status,
          count: Number(row.count),
        })),
      });
    },
  );

  z.get(
    "/admin/analytics/monitors",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "analytics:read",
      }),
      schema: {
        querystring: adminAnalyticsRangeQuerySchema,
      },
    },
    async (request, reply) => {
      const range = request.query.range ?? "7d";
      const window = resolveAdminAnalyticsWindow(range);
      const collectedEvents = new Set(listCollectedAnalyticsEvents());
      const whereParts: string[] = [];
      const params: Array<string | Date | number | string[]> = [];
      appendAdminAnalyticsRangeWhere(whereParts, params, window);
      params.push(ADMIN_ANALYTICS_EXPECTED_MONITOR_EVENTS);
      whereParts.push(`event_name = any($${params.length}::text[])`);
      params.push(ADMIN_ANALYTICS_SCHEMA_VERSION_FILTER);
      whereParts.push(`analytics_schema_version = $${params.length}`);
      const whereSql = buildAdminAnalyticsWhere(whereParts);

      const { rows: countRows } = await pool.query<{
        attempt_count: string;
        event_name: string;
        event_count: string;
        missing_attempt_count: string;
        status: string | null;
      }>(
        `
          select
            event_name,
            status,
            count(*)::text as event_count,
            (
              count(distinct attempt_id) filter (where attempt_id is not null)
              + count(*) filter (where attempt_id is null)
            )::text as attempt_count,
            count(*) filter (where attempt_id is null)::text as missing_attempt_count
          from analytics_server_events
          where ${whereSql}
          group by event_name, status
        `,
        params,
      );

      const counts = countRows.map((row) => ({
        eventName: row.event_name,
        status: row.status,
        attemptCount: Number(row.attempt_count),
        eventCount: Number(row.event_count),
        missingAttemptCount: Number(row.missing_attempt_count),
      }));
      const countStep = (
        step: AdminAnalyticsMonitorStep | undefined,
        rateMode: AdminAnalyticsMonitorRateMode,
      ) => {
        if (!step) return 0;
        const statuses = step.statuses ? new Set(step.statuses) : null;
        return counts
          .filter((row) => {
            if (row.eventName !== step.event) return false;
            if (!statuses) return true;
            return row.status != null && statuses.has(row.status);
          })
          .reduce(
            (sum, row) =>
              sum +
              (rateMode === "attempt" ? row.attemptCount : row.eventCount),
            0,
          );
      };

      const monitors = await Promise.all(
        ADMIN_ANALYTICS_MONITORS.map(async (monitor) => {
          const rateMode = resolveAdminAnalyticsMonitorRateMode(monitor);
          const startCount = countStep(monitor.start, rateMode);
          const successCount = countStep(monitor.success, rateMode);
          const failureCount = countStep(monitor.failure, rateMode);
          const timeoutCount = countStep(monitor.timeout, rateMode);
          const observedCount = counts
            .filter((row) => monitor.trackedEvents.includes(row.eventName))
            .reduce(
              (sum, row) =>
                sum +
                (rateMode === "attempt" ? row.attemptCount : row.eventCount),
              0,
            );
          const missingAttemptEventCount =
            rateMode === "attempt"
              ? counts
                  .filter((row) =>
                    monitor.trackedEvents.includes(row.eventName),
                  )
                  .reduce((sum, row) => sum + row.missingAttemptCount, 0)
              : 0;
          const denominator =
            monitor.kind === "event_volume"
              ? startCount
              : Math.max(
                  startCount,
                  successCount + failureCount + timeoutCount,
                );
          const successRatePct = ratePct(successCount, denominator);
          const failureRatePct = ratePct(failureCount, denominator);
          const timeoutRatePct = ratePct(timeoutCount, denominator);
          const missingEvents = monitor.trackedEvents.filter(
            (eventName) => !collectedEvents.has(eventName),
          );
          const classification = classifyAdminAnalyticsMonitor({
            denominator,
            failureRatePct,
            missingAttemptEventCount,
            missingEvents,
            observedCount,
            startCount,
            successRatePct,
            thresholds: monitor.thresholds,
            timeoutRatePct,
          });

          const badSteps = [monitor.failure, monitor.timeout].filter(
            Boolean,
          ) as AdminAnalyticsMonitorStep[];
          let topBadDimensions: Array<{
            count: number;
            errorMessage: string | null;
            eventName: string;
            source: string | null;
            status: string | null;
            venue: string | null;
          }> = [];
          let topAffectedUsers: Array<{
            count: number;
            lastEventAt: Date;
            userId: string;
          }> = [];

          if (badSteps.length > 0) {
            const badParams: Array<string | Date | number | string[]> = [];
            const badWhereParts: string[] = [];
            appendAdminAnalyticsRangeWhere(badWhereParts, badParams, window);
            badParams.push(ADMIN_ANALYTICS_SCHEMA_VERSION_FILTER);
            badWhereParts.push(
              `analytics_schema_version = $${badParams.length}`,
            );
            const stepSql = badSteps
              .map((step) => buildAdminAnalyticsStepCondition(badParams, step))
              .join(" or ");
            badWhereParts.push(`(${stepSql})`);
            const badWhereSql = buildAdminAnalyticsWhere(badWhereParts);
            const [{ rows: dimensionRows }, { rows: userRows }] =
              await Promise.all([
                pool.query<{
                  count: string;
                  error_message: string | null;
                  event_name: string;
                  source: string | null;
                  status: string | null;
                  venue: string | null;
                }>(
                  `
                    select
                      event_name,
                      venue,
                      source,
                      status,
                      payload->>'error_message' as error_message,
                      count(*)::text as count
                    from analytics_server_events
                    where ${badWhereSql}
                    group by event_name, venue, source, status, payload->>'error_message'
                    order by count(*) desc, event_name asc
                    limit 10
                  `,
                  badParams,
                ),
                pool.query<{
                  count: string;
                  last_event_at: Date;
                  user_id: string;
                }>(
                  `
                    select
                      user_id::text,
                      count(*)::text as count,
                      max(created_at) as last_event_at
                    from analytics_server_events
                    where ${badWhereSql}
                      and user_id is not null
                    group by user_id
                    order by count(*) desc, max(created_at) desc
                    limit 10
                  `,
                  badParams,
                ),
              ]);
            topBadDimensions = dimensionRows.map((row) => ({
              eventName: row.event_name,
              venue: row.venue,
              source: row.source,
              status: row.status,
              errorMessage: row.error_message,
              count: Number(row.count),
            }));
            topAffectedUsers = userRows.map((row) => ({
              userId: row.user_id,
              count: Number(row.count),
              lastEventAt: row.last_event_at,
            }));
          }

          return {
            id: monitor.id,
            title: monitor.id
              .split("_")
              .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
              .join(" "),
            domain: monitor.domain,
            owner: monitor.owner,
            involvedOwners: monitor.involvedOwners,
            priority: monitor.priority,
            alertSlaHours: monitor.alertSlaHours,
            windowMinutes: monitor.windowMinutes,
            thresholds: monitor.thresholds,
            requiredDimensions: monitor.requiredDimensions,
            trackedEvents: monitor.trackedEvents,
            requiredFilters: {
              analytics_schema_version: ADMIN_ANALYTICS_SCHEMA_VERSION_FILTER,
            },
            startCount,
            successCount,
            failureCount,
            timeoutCount,
            observedCount,
            denominator,
            rateMode,
            missingAttemptEventCount,
            successRatePct,
            failureRatePct,
            timeoutRatePct,
            status: classification.status,
            noDataReason: classification.noDataReason,
            missingEvents,
            topBadDimensions,
            topAffectedUsers,
          };
        }),
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        range,
        rangeStartAt: window.rangeStartAt,
        rangeEndAt: window.rangeEndAt,
        monitors,
      });
    },
  );

  z.get(
    "/admin/users/:id/analytics",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermissions: ["users:read", "analytics:read"],
      }),
      schema: {
        params: adminUserParamsSchema,
        querystring: adminUserAnalyticsQuerySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const limit = request.query.limit ?? 50;
      const decodedCursor = decodeAdminKeysetCursor(request.query.cursor);
      if (decodedCursor.error) {
        reply.code(400);
        return reply.send({ error: decodedCursor.error });
      }
      const cursor = decodedCursor.cursor;
      const range = request.query.range ?? "all";
      const rangeStart = resolveAdminUserAnalyticsRangeStart(range);
      const whereSql = rangeStart
        ? "user_id = $1 and created_at >= $2"
        : "user_id = $1";
      const whereParams = rangeStart ? [id, rangeStart] : [id];
      const eventParams: Array<string | Date | number> = [...whereParams];
      let eventWhereSql = whereSql;
      if (cursor) {
        eventParams.push(cursor.createdAt);
        const cursorCreatedAtIdx = eventParams.length;
        eventParams.push(cursor.id);
        const cursorIdIdx = eventParams.length;
        eventWhereSql += ` and (created_at, id) < ($${cursorCreatedAtIdx}, $${cursorIdIdx})`;
      }
      eventParams.push(limit + 1);
      const eventLimitPlaceholder = `$${eventParams.length}`;
      const timelineGranularity =
        resolveAdminUserAnalyticsTimelineGranularity(range);

      const { rows: userRows } = await pool.query<{ id: string }>(
        `select id from users where id = $1 limit 1`,
        [id],
      );
      if (!userRows.length) {
        reply.code(404);
        return reply.send({ error: "User not found" });
      }

      const [
        { rows: summaryRows },
        { rows: eventRows },
        { rows: byEventRows },
        { rows: byVenueRows },
        { rows: bySourceRows },
        { rows: byStatusRows },
        { rows: timelineRows },
      ] = await Promise.all([
        pool.query<{
          distinct_event_count: string;
          first_seen_at: Date | null;
          last_seen_at: Date | null;
          total_events: string;
        }>(
          `
            select
              count(*)::text as total_events,
              count(distinct event_name)::text as distinct_event_count,
              min(created_at) as first_seen_at,
              max(created_at) as last_seen_at
            from analytics_server_events
            where ${whereSql}
          `,
          whereParams,
        ),
        pool.query<{
          analytics_schema_version: string;
          attempt_id: string | null;
          created_at: Date;
          event_name: string;
          event_slug: string | null;
          id: string;
          origin: "backend" | "browser";
          payload: unknown;
          referred_user_key: string | null;
          source: string | null;
          status: string | null;
          venue: string | null;
        }>(
          `
            select
              id::text,
              event_name,
              event_slug,
              source,
              status,
              venue,
              referred_user_key,
              attempt_id,
              analytics_schema_version,
              origin,
              payload,
              created_at
            from analytics_server_events
            where ${eventWhereSql}
            order by created_at desc, id desc
            limit ${eventLimitPlaceholder}
          `,
          eventParams,
        ),
        pool.query<{ count: string; event_name: string }>(
          `
            select event_name, count(*)::text as count
            from analytics_server_events
            where ${whereSql}
            group by event_name
            order by count(*) desc, event_name asc
            limit 30
          `,
          whereParams,
        ),
        pool.query<{ count: string; venue: string }>(
          `
            select venue, count(*)::text as count
            from analytics_server_events
            where ${whereSql} and venue is not null
            group by venue
            order by count(*) desc, venue asc
            limit 20
          `,
          whereParams,
        ),
        pool.query<{ count: string; source: string }>(
          `
            select source, count(*)::text as count
            from analytics_server_events
            where ${whereSql} and source is not null
            group by source
            order by count(*) desc, source asc
            limit 20
          `,
          whereParams,
        ),
        pool.query<{ count: string; event_name: string; status: string }>(
          `
            select event_name, status, count(*)::text as count
            from analytics_server_events
            where ${whereSql} and status is not null
            group by event_name, status
            order by count(*) desc, event_name asc, status asc
            limit 30
          `,
          whereParams,
        ),
        pool.query<{
          bucket_start_at: Date;
          count: string;
          outcome: AdminUserAnalyticsOutcome;
        }>(
          `
            select
              date_trunc('${timelineGranularity}', created_at) as bucket_start_at,
              ${ADMIN_USER_ANALYTICS_OUTCOME_SQL} as outcome,
              count(*)::text as count
            from analytics_server_events
            where ${whereSql}
            group by 1, 2
            order by bucket_start_at asc
          `,
          whereParams,
        ),
      ]);

      const summary = summaryRows[0];
      const timelineByBucket = new Map<
        string,
        {
          action: number;
          bucketStartAt: Date;
          failure: number;
          success: number;
          timeout: number;
          total: number;
        }
      >();
      for (const row of timelineRows) {
        const key = row.bucket_start_at.toISOString();
        const bucket =
          timelineByBucket.get(key) ??
          ({
            action: 0,
            bucketStartAt: row.bucket_start_at,
            failure: 0,
            success: 0,
            timeout: 0,
            total: 0,
          } satisfies {
            action: number;
            bucketStartAt: Date;
            failure: number;
            success: number;
            timeout: number;
            total: number;
          });
        const count = Number(row.count);
        bucket[row.outcome] += count;
        bucket.total += count;
        timelineByBucket.set(key, bucket);
      }
      const eventsPage = buildAdminCursorPage(eventRows, limit);

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        range,
        rangeStartAt: rangeStart,
        summary: {
          totalEvents: Number(summary?.total_events ?? 0),
          distinctEvents: Number(summary?.distinct_event_count ?? 0),
          firstSeenAt: summary?.first_seen_at ?? null,
          lastSeenAt: summary?.last_seen_at ?? null,
        },
        breakdowns: {
          byEvent: byEventRows.map((row) => ({
            eventName: row.event_name,
            count: Number(row.count),
          })),
          byVenue: byVenueRows.map((row) => ({
            venue: row.venue,
            count: Number(row.count),
          })),
          byStatus: byStatusRows.map((row) => ({
            eventName: row.event_name,
            status: row.status,
            count: Number(row.count),
          })),
          bySource: bySourceRows.map((row) => ({
            source: row.source,
            count: Number(row.count),
          })),
          timeline: [...timelineByBucket.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, bucket]) => ({
              bucketStartAt: bucket.bucketStartAt,
              action: bucket.action,
              failure: bucket.failure,
              success: bucket.success,
              timeout: bucket.timeout,
              total: bucket.total,
            })),
        },
        events: eventsPage.items.map((row) => ({
          id: row.id,
          eventName: row.event_name,
          eventSlug: row.event_slug,
          source: row.source,
          status: row.status,
          venue: row.venue,
          referredUserKey: row.referred_user_key,
          attemptId: row.attempt_id,
          analyticsSchemaVersion: row.analytics_schema_version,
          origin: row.origin,
          createdAt: row.created_at,
          page: readAnalyticsPayloadString(row.payload, "page"),
          marketSlug: readAnalyticsPayloadString(row.payload, "market_slug"),
          eventId: readAnalyticsPayloadString(row.payload, "event_id"),
          amountUsd: readAnalyticsPayloadNumber(row.payload, "amount_usd"),
          shares: readAnalyticsPayloadNumber(row.payload, "shares"),
          price: readAnalyticsPayloadNumber(row.payload, "price"),
          errorMessage: readAnalyticsPayloadString(
            row.payload,
            "error_message",
          ),
          txHash: readAnalyticsPayloadString(row.payload, "tx_hash"),
          walletType: readAnalyticsPayloadString(row.payload, "wallet_type"),
          chainId: readAnalyticsPayloadString(row.payload, "chain_id"),
          payload: row.payload,
        })),
        eventsPage: {
          hasMore: eventsPage.hasMore,
          limit,
          nextCursor: eventsPage.nextCursor,
        },
      });
    },
  );

  z.post(
    "/admin/users/merge",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "users:write",
      }),
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
    "/admin/users/privy-bind-grant",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "users:write",
      }),
      schema: { body: adminUserPrivyBindGrantSchema },
    },
    async (request, reply) => {
      const body = request.body;
      let userId = body.userId ?? null;

      if (!userId && body.walletAddress) {
        userId = await resolveUserIdByWallet(body.walletAddress);
      }

      if (!userId) {
        reply.code(400);
        return reply.send({ error: "Resolve user failed" });
      }

      const note = body.note?.trim() || null;
      const clear = Boolean(body.clear);
      const expiresInHours = clear ? null : Number(body.expiresInHours ?? 24);

      const { rows } = await pool.query<{
        id: string;
        privy_bind_grant_expires_at: Date | null;
        privy_bind_grant_note: string | null;
      }>(
        `
          update users
          set privy_bind_grant_expires_at =
                case
                  when $2::boolean then null
                  else now() + ($3::int * interval '1 hour')
                end,
              privy_bind_grant_note =
                case
                  when $2::boolean then null
                  else $4
                end,
              updated_at = now()
          where id = $1
          returning id, privy_bind_grant_expires_at, privy_bind_grant_note
        `,
        [userId, clear, expiresInHours, note],
      );

      if (!rows.length) {
        reply.code(404);
        return reply.send({ error: "User not found" });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        userId: rows[0].id,
        expiresAt: rows[0].privy_bind_grant_expires_at?.toISOString() ?? null,
        note: rows[0].privy_bind_grant_note ?? null,
      });
    },
  );

  z.post(
    "/admin/users/:id/admin",
    {
      preHandler: createAdminMiddleware({ minAdminRole: "sadmin" }),
      schema: { params: adminUserParamsSchema, body: adminUserAdminSchema },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;
      const actorUserId = request.user?.id;

      if (!body.isAdmin && actorUserId && actorUserId === id) {
        reply.code(400);
        return reply.send({ error: "Cannot revoke admin from yourself" });
      }

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
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "users:write",
      }),
      schema: { params: adminUserParamsSchema, body: adminUserActiveSchema },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;
      const actorUserId = request.user?.id;

      if (!body.isActive) {
        if (actorUserId && actorUserId === id) {
          reply.code(400);
          return reply.send({ error: "Cannot deactivate yourself" });
        }

        const { rows: targetRows } = await pool.query<{
          is_admin: boolean;
          is_active: boolean;
        }>(
          `
            select is_admin, is_active
            from users
            where id = $1
          `,
          [id],
        );

        if (!targetRows.length) {
          reply.code(404);
          return reply.send({ error: "User not found" });
        }

        const target = targetRows[0];
        if (target.is_admin && target.is_active) {
          const { rows: adminRows } = await pool.query<{ count: string }>(
            `
              select count(*)::text as count
              from users
              where is_admin = true
                and is_active = true
                and id <> $1
            `,
            [id],
          );
          const otherActiveAdmins = Number(adminRows[0]?.count ?? 0);
          if (otherActiveAdmins === 0) {
            reply.code(400);
            return reply.send({
              error: "Cannot deactivate the last active admin",
            });
          }
        }
      }

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
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "users:write",
      }),
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

  z.post(
    "/admin/users/:id/referral-code",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "users:write",
      }),
      schema: {
        params: adminUserParamsSchema,
        body: adminUserReferralCodeSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;

      try {
        const result = await tx(pool, async (client: PoolClient) => {
          return withRewardsUserAdvisoryXactLock(client, id, async () =>
            setReferralCodeForUser(client, {
              userId: id,
              referralCode: body.code,
              forceTransfer: Boolean(body.forceTransfer),
            }),
          );
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          code: result.code,
          transferredFromUserId: result.transferredFromUserId,
        });
      } catch (error) {
        const statusCode =
          typeof error === "object" &&
          error !== null &&
          "statusCode" in error &&
          typeof (error as { statusCode?: unknown }).statusCode === "number"
            ? (error as { statusCode: number }).statusCode
            : 500;
        reply.code(statusCode);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to update referral code",
        });
      }
    },
  );

  z.get(
    "/admin/fees/policy",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "finance:read",
      }),
    },
    async (_request, reply) => {
      const [poly, kalshi, limitless] = await Promise.all([
        fetchActiveFeePolicy(pool, "polymarket"),
        fetchActiveFeePolicy(pool, "kalshi"),
        fetchActiveFeePolicy(pool, "limitless"),
      ]);

      reply.header("Content-Type", "application/json; charset=utf-8");
      const polyFeeBps = clampFeeBps(poly?.fee_bps ?? env.feeBpsPolymarket);
      const polyBuilderCode = resolvePolymarketBuilderCodeForDisplay(
        poly?.polymarket_builder_code,
      );
      const polyBuilderTakerFeeBps = clampFeeBpsForMax(
        poly?.polymarket_builder_taker_fee_bps ??
          env.polymarketBuilderTakerFeeBps,
        MAX_POLY_BUILDER_TAKER_FEE_BPS,
      );
      const polyBuilderMakerFeeBps = clampFeeBpsForMax(
        poly?.polymarket_builder_maker_fee_bps ??
          env.polymarketBuilderMakerFeeBps,
        MAX_POLY_BUILDER_MAKER_FEE_BPS,
      );
      const polyBuilderActive = Boolean(polyBuilderCode);
      return reply.send({
        ok: true,
        fees: {
          polymarket: {
            feeBps: polyFeeBps,
            feeScale: null,
            builderCode: polyBuilderCode,
            builderTakerFeeBps: polyBuilderTakerFeeBps,
            builderMakerFeeBps: polyBuilderMakerFeeBps,
            builderActive: polyBuilderActive,
            collectionMode: polyBuilderActive ? "builder" : "none",
            effectiveAt: poly?.effective_at ?? null,
            source: poly ? "db" : "env",
          },
          kalshi: {
            feeBps: clampFeeBps(kalshi?.fee_bps ?? env.feeBpsKalshi),
            feeScale: clampFeeScale(kalshi?.fee_scale ?? env.feeScaleKalshi),
            effectiveAt: kalshi?.effective_at ?? null,
            source: kalshi ? "db" : "env",
          },
          limitless: {
            feeBps: 0,
            feeScale: null,
            venueFeeShareBps: clampFeeBps(
              limitless?.limitless_fee_share_bps ?? env.limitlessFeeShareBps,
            ),
            collectionMode:
              clampFeeBps(
                limitless?.limitless_fee_share_bps ?? env.limitlessFeeShareBps,
              ) > 0
                ? "venue_share"
                : "none",
            effectiveAt: limitless?.effective_at ?? null,
            source: limitless ? "db" : "env",
          },
        },
      });
    },
  );

  z.get(
    "/admin/fees/ledger/summary",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "finance:read",
      }),
      schema: { querystring: adminFeeLedgerQuerySchema },
    },
    async (request, reply) => {
      const summary = await getAdminFeeLedgerSummary(pool, request.query);

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, summary });
    },
  );

  z.get(
    "/admin/fees/ledger/accruals",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "finance:read",
      }),
      schema: { querystring: adminFeeLedgerQuerySchema },
    },
    async (request, reply) => {
      const result = await listAdminFeeLedgerAccruals(pool, request.query);

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        items: result.items,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      });
    },
  );

  z.get(
    "/admin/fees/ledger/events",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "finance:read",
      }),
      schema: { querystring: adminFeeLedgerQuerySchema },
    },
    async (request, reply) => {
      const result = await listAdminFeeLedgerEvents(pool, request.query);

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        items: result.items,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      });
    },
  );

  z.get(
    "/admin/fees/ledger/claims",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "finance:read",
      }),
      schema: { querystring: adminFeeLedgerQuerySchema },
    },
    async (request, reply) => {
      const result = await listAdminFeeLedgerClaims(pool, request.query);

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        items: result.items,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      });
    },
  );

  z.get(
    "/admin/fees/ledger/backfill-attempts",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "finance:read",
      }),
      schema: { querystring: adminFeeLedgerQuerySchema },
    },
    async (request, reply) => {
      const result = await listAdminFeeLedgerBackfillAttempts(
        pool,
        request.query,
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        items: result.items,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      });
    },
  );

  z.get(
    "/admin/fees/ledger/contract-receivables",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "finance:read",
      }),
      schema: { querystring: adminFeeLedgerQuerySchema },
    },
    async (request, reply) => {
      const result = await listAdminFeeLedgerContractReceivables(
        pool,
        request.query,
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        items: result.items,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      });
    },
  );

  z.get(
    "/admin/fees/ledger/treasury-runs",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "finance:read",
      }),
      schema: { querystring: adminFeeLedgerQuerySchema },
    },
    async (request, reply) => {
      const result = await listAdminFeeLedgerTreasuryRuns(pool, request.query);

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        items: result.items,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      });
    },
  );

  z.get(
    "/admin/fees/ledger/builder-sweeps",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "finance:read",
      }),
      schema: { querystring: adminFeeLedgerQuerySchema },
    },
    async (request, reply) => {
      const result = await listAdminFeeLedgerBuilderSweeps(pool, request.query);

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        items: result.items,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      });
    },
  );

  z.get(
    "/admin/fees/ledger/accruals/:id",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "finance:read",
      }),
      schema: { params: adminFeeLedgerDetailParamsSchema },
    },
    async (request, reply) => {
      const item = await getAdminFeeLedgerAccrual(pool, request.params.id);
      if (!item) {
        reply.code(404);
        return reply.send({ error: "Fee accrual not found" });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, item });
    },
  );

  z.get(
    "/admin/fees/ledger/events/:id",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "finance:read",
      }),
      schema: { params: adminFeeLedgerDetailParamsSchema },
    },
    async (request, reply) => {
      const item = await getAdminFeeLedgerEvent(pool, request.params.id);
      if (!item) {
        reply.code(404);
        return reply.send({ error: "Fee event not found" });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, item });
    },
  );

  z.get(
    "/admin/fees/ledger/claims/:id",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "finance:read",
      }),
      schema: { params: adminFeeLedgerDetailParamsSchema },
    },
    async (request, reply) => {
      const item = await getAdminFeeLedgerClaim(pool, request.params.id);
      if (!item) {
        reply.code(404);
        return reply.send({ error: "Reward claim not found" });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, item });
    },
  );

  z.get(
    "/admin/fees/ledger/contract-receivables/:id",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "finance:read",
      }),
      schema: { params: adminFeeLedgerDetailParamsSchema },
    },
    async (request, reply) => {
      const item = await getAdminFeeLedgerContractReceivable(
        pool,
        request.params.id,
      );
      if (!item) {
        reply.code(404);
        return reply.send({ error: "Contract fee receivable not found" });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, item });
    },
  );

  z.get(
    "/admin/fees/ledger/treasury-runs/:id",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "finance:read",
      }),
      schema: { params: adminFeeLedgerDetailParamsSchema },
    },
    async (request, reply) => {
      const item = await getAdminFeeLedgerTreasuryRun(pool, request.params.id);
      if (!item) {
        reply.code(404);
        return reply.send({ error: "Treasury run not found" });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, item });
    },
  );

  z.get(
    "/admin/fees/ledger/builder-sweeps/:id",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "finance:read",
      }),
      schema: { params: adminFeeLedgerDetailParamsSchema },
    },
    async (request, reply) => {
      const item = await getAdminFeeLedgerBuilderSweep(pool, request.params.id);
      if (!item) {
        reply.code(404);
        return reply.send({ error: "Builder sweep not found" });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, item });
    },
  );

  z.post(
    "/admin/fees/policy",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "finance:write",
      }),
      schema: { body: adminFeePolicySchema },
    },
    async (request, reply) => {
      const body = request.body;
      const effectiveAt = body.effectiveAt
        ? new Date(body.effectiveAt)
        : new Date();
      const feeScale =
        body.venue === "kalshi" ? clampFeeScale(body.feeScale) : null;
      const currentPolymarket =
        body.venue === "polymarket"
          ? await fetchActiveFeePolicy(pool, "polymarket")
          : null;
      const polymarketBuilderCode =
        body.venue === "polymarket"
          ? body.polymarketBuilderCode !== undefined
            ? normalizePolymarketBuilderCode(body.polymarketBuilderCode)
            : normalizePolymarketBuilderCode(
                resolvePolymarketBuilderCodeForDisplay(
                  currentPolymarket?.polymarket_builder_code,
                ),
              )
          : null;
      const polymarketBuilderTakerFeeBps =
        body.venue === "polymarket"
          ? clampFeeBpsForMax(
              body.polymarketBuilderTakerFeeBps ??
                currentPolymarket?.polymarket_builder_taker_fee_bps ??
                env.polymarketBuilderTakerFeeBps,
              MAX_POLY_BUILDER_TAKER_FEE_BPS,
            )
          : null;
      const polymarketBuilderMakerFeeBps =
        body.venue === "polymarket"
          ? clampFeeBpsForMax(
              body.polymarketBuilderMakerFeeBps ??
                currentPolymarket?.polymarket_builder_maker_fee_bps ??
                env.polymarketBuilderMakerFeeBps,
              MAX_POLY_BUILDER_MAKER_FEE_BPS,
            )
          : null;
      const limitlessFeeShareBps =
        body.venue === "limitless"
          ? clampFeeBps(body.limitlessFeeShareBps ?? env.limitlessFeeShareBps)
          : null;

      const row = await insertFeePolicy(pool, {
        venue: body.venue,
        feeBps: clampFeeBps(body.feeBps),
        feeScale,
        polymarketBuilderCode,
        polymarketBuilderTakerFeeBps,
        polymarketBuilderMakerFeeBps,
        limitlessFeeShareBps,
        effectiveAt,
      });

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        policy: {
          venue: row.venue,
          feeBps: row.fee_bps,
          feeScale: row.fee_scale,
          builderCode: row.polymarket_builder_code,
          builderTakerFeeBps: row.polymarket_builder_taker_fee_bps,
          builderMakerFeeBps: row.polymarket_builder_maker_fee_bps,
          venueFeeShareBps: row.limitless_fee_share_bps,
          effectiveAt: row.effective_at,
          createdAt: row.created_at,
        },
      });
    },
  );

  z.get(
    "/admin/fees/debridge",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "finance:read",
      }),
    },
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
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "finance:write",
      }),
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
        affiliateFeeRecipients:
          recipients && Object.keys(recipients).length ? recipients : null,
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
    "/admin/intel/market-presentations/search",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "intel:read",
      }),
      schema: { querystring: adminMarketPresentationSearchSchema },
    },
    async (request, reply) => {
      const items = await searchAdminMarketPresentations(pool, request.query.q);
      return reply.send({ ok: true, items });
    },
  );

  z.get(
    "/admin/intel/market-presentations/:marketId",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "intel:read",
      }),
      schema: { params: adminMarketPresentationParamsSchema },
    },
    async (request, reply) => {
      const item = await getAdminMarketPresentation(
        pool,
        request.params.marketId,
      );
      if (!item) return reply.code(404).send({ error: "Market not found" });
      return reply.send({ ok: true, item });
    },
  );

  z.put(
    "/admin/intel/market-presentations/:marketId",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "intel:write",
      }),
      schema: {
        params: adminMarketPresentationParamsSchema,
        body: adminMarketPresentationBodySchema,
      },
    },
    async (request, reply) => {
      const reviewedBy = request.user?.id;
      if (!reviewedBy) {
        return reply.code(401).send({ error: "Admin identity is required" });
      }
      const item = await putAdminMarketPresentation({
        db: pool,
        marketId: request.params.marketId,
        override: request.body,
        reviewedBy,
      });
      if (!item) return reply.code(404).send({ error: "Market not found" });
      return reply.send({ ok: true, item });
    },
  );

  z.delete(
    "/admin/intel/market-presentations/:marketId",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "intel:write",
      }),
      schema: { params: adminMarketPresentationParamsSchema },
    },
    async (request, reply) => {
      const item = await deleteAdminMarketPresentation(
        pool,
        request.params.marketId,
      );
      if (!item) return reply.code(404).send({ error: "Market not found" });
      return reply.send({ ok: true, item });
    },
  );

  z.get(
    "/admin/intel/policies",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "intel:read",
      }),
    },
    async (_request, reply) => {
      const resolved = await resolveAllIntelPolicies(pool);
      const items = INTEL_POLICY_KEYS.map((key) => {
        const item = resolved[key];
        return {
          key,
          source: item.source,
          effectiveAt: item.effectiveAt,
          createdAt: item.createdAt,
          defaults: item.defaults,
          override: item.override,
          effective: item.effective,
          invalidOverride: item.invalidOverride,
          revision: resolvedAdminIntelPolicyRevision(item),
        };
      });
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        items,
      });
    },
  );

  z.get(
    "/admin/intel/policies/:key",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "intel:read",
      }),
      schema: { params: adminIntelPolicyParamsSchema },
    },
    async (request, reply) => {
      const key = request.params.key as IntelPolicyKey;
      const item = await resolveIntelPolicy(pool, key);
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        key,
        source: item.source,
        effectiveAt: item.effectiveAt,
        createdAt: item.createdAt,
        defaults: item.defaults,
        override: item.override,
        effective: item.effective,
        invalidOverride: item.invalidOverride,
        revision: resolvedAdminIntelPolicyRevision(item),
      });
    },
  );

  z.post(
    "/admin/intel/policies/:key",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "intel:write",
      }),
      schema: {
        params: adminIntelPolicyParamsSchema,
        body: adminIntelPolicyBodySchema,
      },
    },
    async (request, reply) => {
      const key = request.params.key as IntelPolicyKey;
      const body = request.body;
      const schema = getIntelPolicySchema(key);
      const parsed = schema.safeParse(body.payload);
      if (!parsed.success) {
        reply.code(400);
        return reply.send({
          error: "Invalid policy payload",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        });
      }

      const effectiveAt = body.effectiveAt
        ? new Date(body.effectiveAt)
        : new Date();
      const actorId = request.user?.id ?? null;
      try {
        const row = await insertRuntimePolicy(pool, {
          policyKey: key,
          effectiveAt,
          payload: parsed.data,
          createdBy: actorId,
        });
        if (key === "venue_lifecycle") {
          clearVenueLifecyclePolicyCache(pool);
          clearSignalBotVenueLifecycleCache(pool);
        }
        if (key === "telegram_notifications") {
          clearTelegramNotificationsPolicyCache(pool);
        }
        if (key === "signal_post_copy") {
          clearSignalPostCopyPolicyCache(pool);
        }
        const resolved = await resolveIntelPolicy(pool, key);

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          policy: {
            id: row.id,
            key: row.policy_key,
            effectiveAt: row.effective_at,
            createdAt: row.created_at,
            createdBy: row.created_by,
            payload: row.payload,
          },
          resolved: {
            source: resolved.source,
            effectiveAt: resolved.effectiveAt,
            createdAt: resolved.createdAt,
            defaults: resolved.defaults,
            override: resolved.override,
            effective: resolved.effective,
            invalidOverride: resolved.invalidOverride,
            revision: resolvedAdminIntelPolicyRevision(resolved),
          },
        });
      } catch (error) {
        if (isMissingTableError(error)) {
          reply.code(503);
          return reply.send({
            error:
              "runtime_policies table is missing. Apply migrations before publishing policy overrides.",
          });
        }
        if (isUniqueViolationError(error)) {
          reply.code(409);
          return reply.send({
            error:
              "A policy override already exists for this key and effectiveAt. Use a different effectiveAt.",
          });
        }
        throw error;
      }
    },
  );

  z.get(
    "/admin/rewards/referral-codes",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "rewards:read",
      }),
      schema: { querystring: adminReferralCodesQuerySchema },
    },
    async (request, reply) => {
      const limit = request.query.limit ?? 50;
      const offset = request.query.offset ?? 0;
      const result = await listAdminReferralCodes(pool, {
        q: request.query.q,
        policyType: request.query.policyType ?? null,
        active: request.query.active ?? null,
        usageLimit: request.query.usageLimit ?? null,
        limit,
        offset,
      });

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        items: result.items,
        total: result.total,
        limit,
        offset,
      });
    },
  );

  z.get(
    "/admin/rewards/referral-codes/by-code/:code/referrals",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermissions: ["rewards:read", "users:read"],
      }),
      schema: {
        params: adminReferralCodeByCodeParamsSchema,
        querystring: adminReferralCodeReferralsQuerySchema,
      },
    },
    async (request, reply) => {
      try {
        const limit = request.query.limit ?? 50;
        const offset = request.query.offset ?? 0;
        const result = await getAdminReferralCodeReferralsByCode(pool, {
          code: request.params.code,
          limit,
          offset,
        });
        if (!result) {
          reply.code(404);
          return reply.send({ error: "Referral code not found" });
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          code: result.code,
          referrals: result.referrals,
          total: result.total,
          limit,
          offset,
        });
      } catch (error) {
        const statusCode =
          typeof error === "object" &&
          error !== null &&
          "statusCode" in error &&
          typeof (error as { statusCode?: unknown }).statusCode === "number"
            ? (error as { statusCode: number }).statusCode
            : 500;
        reply.code(statusCode);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to load referral code referrals",
        });
      }
    },
  );

  z.get(
    "/admin/rewards/referral-codes/by-code/:code/fee-events",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermissions: ["rewards:read", "finance:read"],
      }),
      schema: {
        params: adminReferralCodeByCodeParamsSchema,
        querystring: adminReferralCodeFeeEventsQuerySchema,
      },
    },
    async (request, reply) => {
      const code = await getReferralCodeLedgerInfo(pool, request.params.code);
      if (!code) {
        reply.code(404);
        return reply.send({ error: "Referral code not found" });
      }

      const result = await listAdminFeeLedgerEvents(pool, {
        ...request.query,
        referralCode: request.params.code,
      });

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        code,
        items: result.items,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      });
    },
  );

  z.post(
    "/admin/rewards/referral-codes/campaigns",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "rewards:write",
      }),
      schema: { body: adminReferralCodeCampaignCreateSchema },
    },
    async (request, reply) => {
      try {
        const item = await tx(pool, async (client: PoolClient) =>
          createAdminCampaignReferralCode(client, {
            code: request.body.code,
            label: request.body.label,
            multiplierOverride: request.body.multiplierOverride,
            visibleDropPoints: request.body.visibleDropPoints,
            tierDropPoints: request.body.tierDropPoints,
            maxUses: request.body.maxUses,
          }),
        );

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ ok: true, item });
      } catch (error) {
        const statusCode =
          typeof error === "object" &&
          error !== null &&
          "statusCode" in error &&
          typeof (error as { statusCode?: unknown }).statusCode === "number"
            ? (error as { statusCode: number }).statusCode
            : isUniqueViolationError(error)
              ? 409
              : 500;
        reply.code(statusCode);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to create campaign referral code",
        });
      }
    },
  );

  z.patch(
    "/admin/rewards/referral-codes/:id",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "rewards:write",
      }),
      schema: {
        params: adminReferralCodeParamsSchema,
        body: adminReferralCodeUpdateSchema,
      },
    },
    async (request, reply) => {
      try {
        const item = await tx(pool, async (client: PoolClient) =>
          updateAdminReferralCodePolicy(client, {
            referralCodeId: request.params.id,
            label: request.body.label,
            multiplierOverride: request.body.multiplierOverride,
            visibleDropPoints: request.body.visibleDropPoints,
            tierDropPoints: request.body.tierDropPoints,
            maxUses: request.body.maxUses,
            deactivate: request.body.deactivate,
            reactivate: request.body.reactivate,
          }),
        );

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ ok: true, item });
      } catch (error) {
        const statusCode =
          typeof error === "object" &&
          error !== null &&
          "statusCode" in error &&
          typeof (error as { statusCode?: unknown }).statusCode === "number"
            ? (error as { statusCode: number }).statusCode
            : 500;
        reply.code(statusCode);
        return reply.send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to update referral code policy",
        });
      }
    },
  );

  z.get(
    "/admin/rewards/multiplier-policy",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "rewards:read",
      }),
    },
    async (_request, reply) => {
      const active = await fetchActiveRewardsMultiplierPolicy(pool);
      const fallbackEffectiveAt = active?.effective_at ?? null;
      const fallbackCreatedAt = active?.created_at ?? null;
      const fallbackUpdatedAt = active?.updated_at ?? null;
      const globalMultiplier = Number(active?.global_multiplier ?? 1);
      const globalMultiplierLabel = active?.global_multiplier_label ?? null;
      const referralRules = normalizeMultiplierReferralRules(
        active?.referral_rules ?? [],
      );
      const tierRules = normalizeMultiplierTierRules(active?.tier_rules ?? []);
      const notes = active?.notes ?? null;

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        policy: {
          effectiveAt: fallbackEffectiveAt,
          globalMultiplier,
          globalMultiplierLabel,
          referralRules,
          tierRules,
          notes,
        },
        active: active
          ? {
              id: active.id,
              effectiveAt: fallbackEffectiveAt,
              globalMultiplier,
              globalMultiplierLabel,
              referralRules,
              tierRules,
              notes,
              createdAt: fallbackCreatedAt,
              updatedAt: fallbackUpdatedAt,
            }
          : null,
      });
    },
  );

  z.post(
    "/admin/rewards/multiplier-policy",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "rewards:write",
      }),
      schema: { body: adminRewardsMultiplierPolicySchema },
    },
    async (request, reply) => {
      const body = request.body;
      const inserted = await insertRewardsMultiplierPolicy(pool, {
        effectiveAt: body.effectiveAt ? new Date(body.effectiveAt) : new Date(),
        globalMultiplier: Number(body.globalMultiplier),
        globalMultiplierLabel: body.globalMultiplierLabel?.trim() || null,
        referralRules: body.referralRules,
        tierRules: body.tierRules,
        notes: body.notes?.trim() || null,
      });

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        policy: {
          id: inserted.id,
          effectiveAt: inserted.effective_at,
          globalMultiplier: Number(inserted.global_multiplier),
          globalMultiplierLabel: inserted.global_multiplier_label ?? null,
          referralRules: normalizeMultiplierReferralRules(
            inserted.referral_rules,
          ),
          tierRules: normalizeMultiplierTierRules(inserted.tier_rules),
          notes: inserted.notes ?? null,
          createdAt: inserted.created_at,
          updatedAt: inserted.updated_at,
        },
      });
    },
  );

  z.get(
    "/admin/rewards/multiplier-overrides",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "rewards:read",
      }),
      schema: { querystring: adminRewardsMultiplierOverridesQuerySchema },
    },
    async (request, reply) => {
      const limit = request.query.limit ?? 50;
      const offset = request.query.offset ?? 0;
      const result = await listRewardsMultiplierOverrides(pool, {
        q: request.query.q,
        limit,
        offset,
      });

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        items: result.rows.map((row) => ({
          userId: row.user_id,
          walletAddress: row.wallet_address,
          email: row.email,
          username: row.username,
          displayName: row.display_name,
          multiplier: Number(row.multiplier),
          label: row.label,
          reason: row.reason,
          effectiveAt: row.effective_at,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
        total: result.total,
        limit,
        offset,
      });
    },
  );

  z.post(
    "/admin/rewards/multiplier-overrides",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "rewards:write",
      }),
      schema: { body: adminRewardsMultiplierOverrideSchema },
    },
    async (request, reply) => {
      const body = request.body;
      let userId = body.userId ?? null;
      if (!userId && body.walletAddress) {
        try {
          userId = await resolveUserIdByWallet(body.walletAddress);
        } catch {
          reply.code(400);
          return reply.send({
            error: "Wallet lookup failed",
          });
        }
      }
      if (!userId) {
        reply.code(404);
        return reply.send({ error: "User not found" });
      }

      const effectiveAt = body.effectiveAt
        ? new Date(body.effectiveAt)
        : new Date();
      const expiresAt =
        body.expiresAt === null
          ? null
          : body.expiresAt
            ? new Date(body.expiresAt)
            : null;
      const row = await tx(pool, async (client: PoolClient) => {
        return withRewardsUserAdvisoryXactLock(client, userId, () =>
          upsertRewardsMultiplierOverride(client, {
            userId,
            multiplier: Number(body.multiplier),
            label: body.label?.trim() || null,
            reason: body.reason?.trim() || null,
            effectiveAt,
            expiresAt,
          }),
        );
      });

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        override: {
          userId: row.user_id,
          walletAddress: row.wallet_address,
          email: row.email,
          username: row.username,
          displayName: row.display_name,
          multiplier: Number(row.multiplier),
          label: row.label,
          reason: row.reason,
          effectiveAt: row.effective_at,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
      });
    },
  );

  z.delete(
    "/admin/rewards/multiplier-overrides/:userId",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "rewards:write",
      }),
      schema: { params: adminRewardsMultiplierOverrideParamsSchema },
    },
    async (request, reply) => {
      const removed = await tx(pool, async (client: PoolClient) =>
        withRewardsUserAdvisoryXactLock(client, request.params.userId, () =>
          deleteRewardsMultiplierOverride(client, request.params.userId),
        ),
      );
      if (!removed) {
        reply.code(404);
        return reply.send({ error: "Override not found" });
      }
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true });
    },
  );

  z.get(
    "/admin/rewards/policy",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "rewards:read",
      }),
    },
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
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "rewards:read",
      }),
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
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "rewards:write",
      }),
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
        [
          effectiveAt,
          JSON.stringify(body.tiers),
          JSON.stringify(body.referralBonus),
        ],
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
    "/admin/rewards/bulk-adjustments/preview",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "rewards:write",
      }),
      schema: { body: adminRewardsBulkAdjustmentPreviewSchema },
    },
    async (request, reply) => {
      try {
        const result = await previewAdminRewardsBulkAdjustment(
          pool,
          request.body,
        );
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(result);
      } catch (error) {
        if (error instanceof AdminRewardsBulkAdjustmentInputError) {
          reply.code(400);
          return reply.send({ error: error.message });
        }
        throw error;
      }
    },
  );

  z.post(
    "/admin/rewards/bulk-adjustments/execute",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "rewards:write",
      }),
      schema: { body: adminRewardsBulkAdjustmentExecuteSchema },
    },
    async (request, reply) => {
      try {
        const result = await executeAdminRewardsBulkAdjustmentWithRetry(
          request.body,
        );
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(result);
      } catch (error) {
        if (error instanceof AdminRewardsBulkAdjustmentInputError) {
          reply.code(400);
          return reply.send({ error: error.message });
        }
        if (error instanceof AdminRewardsBulkAdjustmentRetryExhaustedError) {
          reply.code(409);
          return reply.send({ error: error.message });
        }
        throw error;
      }
    },
  );

  z.post(
    "/admin/rewards/points",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "rewards:write",
      }),
      schema: { body: adminPointsSchema },
    },
    async (request, reply) => {
      const body = request.body;
      const walletInput = body.walletAddress?.trim();
      let userId = body.userId?.trim() ?? null;
      if (!userId && walletInput) {
        try {
          userId = await resolveUserIdByWallet(walletInput);
        } catch {
          reply.code(400);
          return reply.send({
            error: "Wallet lookup failed",
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
      const visible = body.visible ?? false;
      const sourceId = `${visible ? VISIBLE_MANUAL_VOLUME_SOURCE_PREFIX : HIDDEN_MANUAL_VOLUME_SOURCE_PREFIX}${randomUUID()}`;
      const venue = body.venue?.trim() ?? "admin";

      const inserted = await insertExactManualVolumeEvent(pool, {
        userId,
        walletAddress,
        venue,
        sourceType,
        sourceId,
        points: body.amount,
        createdAt: new Date(),
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
          id: inserted.id,
          userId,
          walletAddress,
          venue,
          sourceType,
          sourceId,
          amount: body.amount,
          visible,
        },
      });
    },
  );

  z.get(
    "/admin/points/manual-events",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "rewards:read",
      }),
      schema: { querystring: adminManualPointsQuerySchema },
    },
    async (request, reply) => {
      const query = request.query;
      const decodedCursor = decodeAdminKeysetCursor(query.cursor);
      if (decodedCursor.error) {
        reply.code(400);
        return reply.send({ error: decodedCursor.error });
      }
      const cursor = decodedCursor.cursor;
      const limit = query.limit ?? 25;
      const result = await fetchAdminManualVolumeEvents(pool, {
        cursor,
        userId: query.userId ?? null,
        walletAddress: query.walletAddress?.trim() ?? null,
        limit: limit + 1,
        offset: query.offset ?? 0,
      });
      const page = buildAdminCursorPage(result.items, limit);

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        items: page.items.map((item) => ({
          id: item.id,
          userId: item.user_id,
          walletAddress: item.wallet_address ?? null,
          venue: item.venue,
          sourceType: item.source_type,
          sourceId: item.source_id,
          amount: Number(item.notional_usd ?? 0),
          pointsAwarded: Number(item.points_awarded ?? 0),
          visible: item.visible,
          createdAt: item.created_at,
        })),
        hasMore: page.hasMore,
        total: result.total,
        limit,
        nextCursor: page.nextCursor,
        offset: query.offset ?? 0,
      });
    },
  );

  z.delete(
    "/admin/points/manual-events/:id",
    {
      preHandler: createAdminMiddleware({
        requiredAdminPermission: "rewards:write",
      }),
      schema: { params: adminManualPointsParamsSchema },
    },
    async (request, reply) => {
      const deleted = await deleteAdminManualVolumeEvent(
        pool,
        request.params.id,
      );
      if (!deleted) {
        reply.code(404);
        return reply.send({ error: "Manual admin points event not found" });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        event: {
          id: deleted.id,
          userId: deleted.user_id,
          walletAddress: deleted.wallet_address ?? null,
          venue: deleted.venue,
          sourceType: deleted.source_type,
          sourceId: deleted.source_id,
          amount: Number(deleted.notional_usd ?? 0),
          pointsAwarded: Number(deleted.points_awarded ?? 0),
          visible: deleted.visible,
          createdAt: deleted.created_at,
        },
      });
    },
  );
};
