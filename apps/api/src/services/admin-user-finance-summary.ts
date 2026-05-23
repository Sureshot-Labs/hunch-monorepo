import type { DbQuery } from "../db.js";
import { normalizeRewardsChainId } from "../lib/rewards-chain.js";
import { parseUsdcToMicroFloor, usdcMicroToDecimalString } from "../lib/usdc.js";
import { getRewardsSummary } from "./rewards.js";

type AmountTotal = {
  amountUsdc: string;
  amountUsdcRaw: string;
};

type CountAmountTotal = AmountTotal & {
  count: number;
};

type UserRow = {
  id: string;
  email: string | null;
  username: string | null;
  display_name: string | null;
  primary_wallet_address: string | null;
  inbound_referral_code: string | null;
  inbound_referral_policy_type: "user" | "campaign" | null;
  inbound_referral_label: string | null;
  inbound_referral_multiplier_override: string | null;
  inbound_referral_owner_user_id: string | null;
  inbound_referral_referrer_user_id: string | null;
  inbound_referral_referrer_email: string | null;
  inbound_referral_referrer_username: string | null;
  inbound_referral_referrer_display_name: string | null;
  inbound_referral_referrer_wallet_address: string | null;
  inbound_referral_attached_at: Date | null;
};

type ClaimRollupRow = {
  chain_id: string | null;
  status: string;
  count: number;
  amount_usdc: string | null;
};

type FeeEventRollupRow = {
  venue: string;
  chain_id: string | null;
  status: string;
  source_type: string;
  count: number;
  fee_usd: string | null;
  fee_amount: string | null;
  cashback_earned_usdc: string | null;
  referral_generated_for_referrer_usdc: string | null;
};

type ReferralStatusRow = {
  status: string;
  count: number;
};

type ReferralCodeRow = {
  id: string;
  code: string;
  is_active: boolean;
  retired_at: Date | null;
  retired_reason: string | null;
  policy_id: string;
  policy_type: "user" | "campaign";
  label: string | null;
  multiplier_override: string | null;
  visible_drop_points: string;
  tier_drop_points: string;
  referral_count: number;
};

type ReferralRewardRollupRow = {
  chain_id: string | null;
  status: string;
  count: number;
  referral_earned_usdc: string | null;
};

type AccrualRollupRow = {
  venue: string;
  fee_program: string;
  chain_id: string | null;
  status: string;
  fee_asset: string;
  count: number;
  linked_fee_event_count: number;
  fee_amount: string | null;
};

type ContractReceivableRollupRow = {
  venue: string;
  fee_program: string;
  chain_id: string | null;
  status: string;
  count: number;
  linked_accrual_count: number;
  linked_fee_event_count: number;
  receivable_token_amount_raw: string | null;
  resolved_usdc_amount: string | null;
};

type BackfillRollupRow = {
  venue: string;
  fee_program: string;
  status: string;
  count: number;
};

const ZERO_AMOUNT: AmountTotal = {
  amountUsdc: "0.000000",
  amountUsdcRaw: "0",
};

function decimalToMicro(value: string | null | undefined): bigint {
  return parseUsdcToMicroFloor(value ?? "0") ?? 0n;
}

function amountFromMicro(amount: bigint): AmountTotal {
  return {
    amountUsdc: usdcMicroToDecimalString(amount),
    amountUsdcRaw: amount.toString(),
  };
}

function amountFromDecimal(value: string | null | undefined): AmountTotal {
  return amountFromMicro(decimalToMicro(value));
}

function emptyCountAmount(): CountAmountTotal {
  return { ...ZERO_AMOUNT, count: 0 };
}

function addCountAmount(
  current: CountAmountTotal | undefined,
  amount: bigint,
  count: number,
): CountAmountTotal {
  const existing = current ?? emptyCountAmount();
  return {
    ...amountFromMicro(BigInt(existing.amountUsdcRaw) + amount),
    count: existing.count + count,
  };
}

function canonicalChainId(chainId: string | null): string {
  return normalizeRewardsChainId(chainId) ?? chainId ?? "unknown";
}

function rawMicroTextToDecimal(raw: string | null | undefined): string {
  const normalized = (raw?.trim() ?? "0").replace(/\.0+$/, "");
  if (!/^\d+$/.test(normalized)) return "0.000000";
  return usdcMicroToDecimalString(BigInt(normalized));
}

function mapUser(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    displayName: row.display_name,
    primaryWalletAddress: row.primary_wallet_address,
    inboundReferral: row.inbound_referral_code
      ? {
          code: row.inbound_referral_code,
          policyType: row.inbound_referral_policy_type,
          label: row.inbound_referral_label,
          multiplierOverride:
            row.inbound_referral_multiplier_override == null
              ? null
              : Number(row.inbound_referral_multiplier_override),
          ownerUserId: row.inbound_referral_owner_user_id,
          referrerUserId: row.inbound_referral_referrer_user_id,
          referrerEmail: row.inbound_referral_referrer_email,
          referrerUsername: row.inbound_referral_referrer_username,
          referrerDisplayName: row.inbound_referral_referrer_display_name,
          referrerWalletAddress: row.inbound_referral_referrer_wallet_address,
          attachedAt: row.inbound_referral_attached_at,
        }
      : null,
  };
}

function buildClaimsSummary(rows: ClaimRollupRow[]) {
  const byStatus: Record<string, CountAmountTotal> = {};
  const byChain: Record<string, Record<string, CountAmountTotal>> = {};
  let nonFailedAmount = 0n;
  let nonFailedCount = 0;

  for (const row of rows) {
    const amount = decimalToMicro(row.amount_usdc);
    const count = Number(row.count ?? 0);
    const chainId = canonicalChainId(row.chain_id);
    byStatus[row.status] = addCountAmount(byStatus[row.status], amount, count);
    byChain[chainId] = byChain[chainId] ?? {};
    byChain[chainId][row.status] = addCountAmount(
      byChain[chainId][row.status],
      amount,
      count,
    );
    if (row.status !== "failed") {
      nonFailedAmount += amount;
      nonFailedCount += count;
    }
  }

  return {
    byStatus,
    byChain,
    totals: {
      pending: byStatus.pending ?? emptyCountAmount(),
      submitted: byStatus.submitted ?? emptyCountAmount(),
      confirmed: byStatus.confirmed ?? emptyCountAmount(),
      failed: byStatus.failed ?? emptyCountAmount(),
      nonFailed: { ...amountFromMicro(nonFailedAmount), count: nonFailedCount },
    },
  };
}

function buildFeeEventsSummary(rows: FeeEventRollupRow[]) {
  const groups = rows.map((row) => ({
    venue: row.venue,
    chainId: canonicalChainId(row.chain_id),
    status: row.status,
    sourceType: row.source_type,
    count: Number(row.count ?? 0),
    feeUsd: amountFromDecimal(row.fee_usd),
    feeAmount: amountFromDecimal(row.fee_amount),
    cashbackEarned: amountFromDecimal(row.cashback_earned_usdc),
    referralGeneratedForReferrer: amountFromDecimal(
      row.referral_generated_for_referrer_usdc,
    ),
  }));

  const byStatus: Record<
    string,
    CountAmountTotal & {
      cashbackEarned: AmountTotal;
      referralGeneratedForReferrer: AmountTotal;
    }
  > = {};
  let totalFeeUsd = 0n;
  let totalCashback = 0n;
  let totalReferralGenerated = 0n;
  let totalCount = 0;

  for (const row of rows) {
    const fee = decimalToMicro(row.fee_usd);
    const cashback = decimalToMicro(row.cashback_earned_usdc);
    const referral = decimalToMicro(row.referral_generated_for_referrer_usdc);
    const count = Number(row.count ?? 0);
    const existing = byStatus[row.status] ?? {
      ...emptyCountAmount(),
      cashbackEarned: { ...ZERO_AMOUNT },
      referralGeneratedForReferrer: { ...ZERO_AMOUNT },
    };
    byStatus[row.status] = {
      ...addCountAmount(existing, fee, count),
      cashbackEarned: amountFromMicro(
        BigInt(existing.cashbackEarned.amountUsdcRaw) + cashback,
      ),
      referralGeneratedForReferrer: amountFromMicro(
        BigInt(existing.referralGeneratedForReferrer.amountUsdcRaw) + referral,
      ),
    };
    totalFeeUsd += fee;
    totalCashback += cashback;
    totalReferralGenerated += referral;
    totalCount += count;
  }

  return {
    groups,
    byStatus,
    totals: {
      count: totalCount,
      feeUsd: amountFromMicro(totalFeeUsd),
      cashbackEarned: amountFromMicro(totalCashback),
      referralGeneratedForReferrer: amountFromMicro(totalReferralGenerated),
    },
  };
}

function buildReferralsSummary(params: {
  rewards: Awaited<ReturnType<typeof getRewardsSummary>>;
  statusRows: ReferralStatusRow[];
  codeRows: ReferralCodeRow[];
  rewardRows: ReferralRewardRollupRow[];
}) {
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of params.statusRows) {
    byStatus[row.status] = Number(row.count ?? 0);
    total += Number(row.count ?? 0);
  }

  const rewardsByStatus: Record<string, CountAmountTotal> = {};
  const rewardsByChain: Record<string, Record<string, CountAmountTotal>> = {};
  let pending = 0n;
  let collected = 0n;
  let rewardCount = 0;
  for (const row of params.rewardRows) {
    const amount = decimalToMicro(row.referral_earned_usdc);
    const count = Number(row.count ?? 0);
    const chainId = canonicalChainId(row.chain_id);
    rewardsByStatus[row.status] = addCountAmount(
      rewardsByStatus[row.status],
      amount,
      count,
    );
    rewardsByChain[chainId] = rewardsByChain[chainId] ?? {};
    rewardsByChain[chainId][row.status] = addCountAmount(
      rewardsByChain[chainId][row.status],
      amount,
      count,
    );
    if (row.status === "pending") pending += amount;
    if (row.status === "collected") collected += amount;
    rewardCount += count;
  }

  return {
    total,
    byStatus,
    qualifiedCount: params.rewards.referralBonus.qualifiedCount,
    bonusBps: params.rewards.referralBonus.bonusBps,
    codes: params.codeRows.map((row) => ({
      id: row.id,
      code: row.code,
      isActive: row.is_active,
      retiredAt: row.retired_at,
      retiredReason: row.retired_reason,
      referralCount: Number(row.referral_count ?? 0),
      policy: {
        id: row.policy_id,
        policyType: row.policy_type,
        label: row.label,
        multiplierOverride:
          row.multiplier_override == null
            ? null
            : Number(row.multiplier_override),
        visibleDropPoints: Number(row.visible_drop_points ?? 0),
        tierDropPoints: Number(row.tier_drop_points ?? 0),
      },
    })),
    rewardsFromReferredUsers: {
      byStatus: rewardsByStatus,
      byChain: rewardsByChain,
      totals: {
        count: rewardCount,
        pending: amountFromMicro(pending),
        collected: amountFromMicro(collected),
        earned: amountFromMicro(pending + collected),
      },
    },
  };
}

function buildLedgerSummary(params: {
  accrualRows: AccrualRollupRow[];
  contractRows: ContractReceivableRollupRow[];
  backfillRows: BackfillRollupRow[];
}) {
  const accruals = params.accrualRows.map((row) => ({
    venue: row.venue,
    feeProgram: row.fee_program,
    chainId: canonicalChainId(row.chain_id),
    status: row.status,
    feeAsset: row.fee_asset,
    count: Number(row.count ?? 0),
    linkedFeeEventCount: Number(row.linked_fee_event_count ?? 0),
    feeAmount: amountFromDecimal(row.fee_amount),
  }));

  const contractReceivables = params.contractRows.map((row) => ({
    venue: row.venue,
    feeProgram: row.fee_program,
    chainId: canonicalChainId(row.chain_id),
    status: row.status,
    count: Number(row.count ?? 0),
    linkedAccrualCount: Number(row.linked_accrual_count ?? 0),
    linkedFeeEventCount: Number(row.linked_fee_event_count ?? 0),
    receivableTokenAmountRaw: row.receivable_token_amount_raw ?? "0",
    receivableTokenAmount: rawMicroTextToDecimal(
      row.receivable_token_amount_raw,
    ),
    resolvedUsdcAmount: amountFromDecimal(row.resolved_usdc_amount),
  }));

  const backfillAttempts = params.backfillRows.map((row) => ({
    venue: row.venue,
    feeProgram: row.fee_program,
    status: row.status,
    count: Number(row.count ?? 0),
  }));

  return {
    accruals,
    contractReceivables,
    backfillAttempts,
    totals: {
      accrualCount: accruals.reduce((sum, row) => sum + row.count, 0),
      accrualFeeAmount: amountFromMicro(
        accruals.reduce(
          (sum, row) => sum + BigInt(row.feeAmount.amountUsdcRaw),
          0n,
        ),
      ),
      contractReceivableCount: contractReceivables.reduce(
        (sum, row) => sum + row.count,
        0,
      ),
      contractResolvedUsdcAmount: amountFromMicro(
        contractReceivables.reduce(
          (sum, row) => sum + BigInt(row.resolvedUsdcAmount.amountUsdcRaw),
          0n,
        ),
      ),
      backfillAttemptCount: backfillAttempts.reduce(
        (sum, row) => sum + row.count,
        0,
      ),
    },
  };
}

export async function getAdminUserFinanceSummary(
  pool: DbQuery,
  inputs: { userId: string },
) {
  const { rows: userRows } = await pool.query<UserRow>(
    `
      select
        u.id,
        u.email,
        u.username,
        u.display_name,
        primary_wallet.wallet_address as primary_wallet_address,
        inbound.code as inbound_referral_code,
        inbound.policy_type as inbound_referral_policy_type,
        inbound.label as inbound_referral_label,
        inbound.multiplier_override as inbound_referral_multiplier_override,
        inbound.owner_user_id as inbound_referral_owner_user_id,
        inbound.referrer_user_id as inbound_referral_referrer_user_id,
        inbound.referrer_email as inbound_referral_referrer_email,
        inbound.referrer_username as inbound_referral_referrer_username,
        inbound.referrer_display_name as inbound_referral_referrer_display_name,
        inbound.referrer_wallet_address as inbound_referral_referrer_wallet_address,
        inbound.attached_at as inbound_referral_attached_at
      from users u
      left join lateral (
        select wallet_address
        from user_wallets
        where user_id = u.id
        order by is_primary desc, created_at asc
        limit 1
      ) primary_wallet on true
      left join lateral (
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
        where r.referred_user_id = u.id
        order by r.created_at desc
        limit 1
      ) inbound on true
      where u.id = $1
      limit 1
    `,
    [inputs.userId],
  );

  const user = userRows[0];
  if (!user) return null;

  const [
    rewards,
    claimRows,
    feeEventRows,
    referralStatusRows,
    referralCodeRows,
    referralRewardRows,
    accrualRows,
    contractRows,
    backfillRows,
  ] = await Promise.all([
    getRewardsSummary(pool, { userId: inputs.userId }),
    pool.query<ClaimRollupRow>(
      `
        select
          coalesce(chain_id, 'unknown') as chain_id,
          status,
          count(*)::int as count,
          coalesce(sum(amount_usdc), 0)::text as amount_usdc
        from reward_claims
        where user_id = $1
        group by chain_id, status
        order by chain_id, status
      `,
      [inputs.userId],
    ),
    pool.query<FeeEventRollupRow>(
      `
        select
          venue,
          coalesce(chain_id, 'unknown') as chain_id,
          status,
          source_type,
          count(*)::int as count,
          coalesce(sum(fee_usd), 0)::text as fee_usd,
          coalesce(sum(fee_amount), 0)::text as fee_amount,
          coalesce(sum(cashback_earned_usdc), 0)::text as cashback_earned_usdc,
          coalesce(sum(referral_earned_usdc), 0)::text as referral_generated_for_referrer_usdc
        from fee_events
        where user_id = $1
        group by venue, chain_id, status, source_type
        order by venue, chain_id, status, source_type
      `,
      [inputs.userId],
    ),
    pool.query<ReferralStatusRow>(
      `
        select status, count(*)::int as count
        from referrals
        where referrer_user_id = $1
        group by status
        order by status
      `,
      [inputs.userId],
    ),
    pool.query<ReferralCodeRow>(
      `
        select
          rc.id,
          rc.code,
          rc.is_active,
          rc.retired_at,
          rc.retired_reason,
          p.id as policy_id,
          p.policy_type,
          p.label,
          p.multiplier_override::text as multiplier_override,
          p.visible_drop_points::text as visible_drop_points,
          p.tier_drop_points::text as tier_drop_points,
          count(r.id)::int as referral_count
        from referral_code_policies p
        join referral_codes rc
          on rc.policy_id = p.id
        left join referrals r
          on r.referral_code_id = rc.id
        where p.owner_user_id = $1
        group by rc.id, p.id
        order by rc.is_active desc, rc.created_at desc
      `,
      [inputs.userId],
    ),
    pool.query<ReferralRewardRollupRow>(
      `
        select
          coalesce(fe.chain_id, 'unknown') as chain_id,
          fe.status,
          count(*)::int as count,
          coalesce(sum(fe.referral_earned_usdc), 0)::text as referral_earned_usdc
        from referrals r
        join fee_events fe
          on fe.user_id = r.referred_user_id
        where r.referrer_user_id = $1
          and fe.liability_snapshot_source = 'event_time_frozen'
        group by fe.chain_id, fe.status
        order by fe.chain_id, fe.status
      `,
      [inputs.userId],
    ),
    pool.query<AccrualRollupRow>(
      `
        select
          venue,
          fee_program,
          coalesce(chain_id, 'unknown') as chain_id,
          status,
          fee_asset,
          count(*)::int as count,
          count(fee_event_id)::int as linked_fee_event_count,
          coalesce(sum(fee_amount), 0)::text as fee_amount
        from venue_fee_accruals
        where user_id = $1
        group by venue, fee_program, chain_id, status, fee_asset
        order by venue, fee_program, chain_id, status, fee_asset
      `,
      [inputs.userId],
    ),
    pool.query<ContractReceivableRollupRow>(
      `
        select
          venue,
          fee_program,
          coalesce(chain_id, 'unknown') as chain_id,
          status,
          count(*)::int as count,
          count(accrual_id)::int as linked_accrual_count,
          count(fee_event_id)::int as linked_fee_event_count,
          coalesce(sum(receivable_token_amount_raw::numeric), 0)::text as receivable_token_amount_raw,
          coalesce(sum(resolved_usdc_amount), 0)::text as resolved_usdc_amount
        from limitless_contract_fee_receivables
        where user_id = $1
        group by venue, fee_program, chain_id, status
        order by venue, fee_program, chain_id, status
      `,
      [inputs.userId],
    ),
    pool.query<BackfillRollupRow>(
      `
        select
          b.venue,
          b.fee_program,
          b.status,
          count(*)::int as count
        from venue_fee_backfill_attempts b
        join orders o
          on o.id = b.order_id
        where o.user_id = $1
        group by b.venue, b.fee_program, b.status
        order by b.venue, b.fee_program, b.status
      `,
      [inputs.userId],
    ),
  ]);

  const feeEvents = buildFeeEventsSummary(feeEventRows.rows);
  const referrals = buildReferralsSummary({
    rewards,
    statusRows: referralStatusRows.rows,
    codeRows: referralCodeRows.rows,
    rewardRows: referralRewardRows.rows,
  });
  const ownCashbackEarnedMicro = feeEventRows.rows.reduce((sum, row) => {
    if (row.status !== "pending" && row.status !== "collected") return sum;
    return sum + decimalToMicro(row.cashback_earned_usdc);
  }, 0n);
  const referralEarnedMicro =
    BigInt(referrals.rewardsFromReferredUsers.totals.earned.amountUsdcRaw);

  return {
    user: mapUser(user),
    rewards: {
      ...rewards,
      totals: {
        userRewardEarned: amountFromMicro(
          ownCashbackEarnedMicro + referralEarnedMicro,
        ),
        ownCashbackEarned: amountFromMicro(ownCashbackEarnedMicro),
        referralEarned: amountFromMicro(referralEarnedMicro),
        claimable: amountFromDecimal(String(rewards.cashback.claimable)),
      },
    },
    claims: buildClaimsSummary(claimRows.rows),
    feeEvents,
    referrals,
    ledger: buildLedgerSummary({
      accrualRows: accrualRows.rows,
      contractRows: contractRows.rows,
      backfillRows: backfillRows.rows,
    }),
  };
}
