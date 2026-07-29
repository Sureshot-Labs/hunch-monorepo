import type { DbQuery } from "../db.js";
import { normalizeRewardsChainId } from "../lib/rewards-chain.js";
import {
  EFFECTIVE_PNL_SQL,
  POSITION_MARKET_JOIN_SQL,
  RESOLVED_MARKET_SQL,
  UNREALIZED_PNL_COMPONENT_SQL,
} from "../lib/pnl-sql.js";
import type { PgParams } from "../server-types.js";

export type RewardsPolicyRow = {
  id: string;
  effective_at: Date;
  tiers: unknown;
  referral_bonus: unknown;
  created_at: Date;
};

export type RewardsMultiplierPolicyRow = {
  id: string;
  effective_at: Date;
  global_multiplier: string;
  global_multiplier_label: string | null;
  referral_rules: unknown;
  tier_rules: unknown;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
};

export type RewardsMultiplierOverrideRow = {
  user_id: string;
  multiplier: string;
  label: string | null;
  reason: string | null;
  effective_at: Date;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  wallet_address: string | null;
  email: string | null;
  username: string | null;
  display_name: string | null;
};

export type ReferralRow = {
  id: string;
  referrer_user_id: string | null;
  referred_user_id: string;
  code: string;
  referral_code_id: string | null;
  status: string;
  qualified_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type InboundReferralRow = {
  referrer_user_id: string | null;
  code: string;
  referral_code_id: string | null;
  policy_type: ReferralCodePolicyType | null;
  policy_id: string | null;
  policy_label: string | null;
  policy_multiplier_override: string | null;
  policy_owner_user_id: string | null;
  status: string;
  linked_at: Date;
  qualified_at: Date | null;
  referrer_username: string | null;
  referrer_display_name: string | null;
};

export type UserTutorialDismissalRow = {
  user_id: string;
  tutorial_key: string;
  dismissed_at: Date;
  created_at: Date;
  updated_at: Date;
};

export type RewardsLeaderboardMetric = "points" | "volume" | "pnl";
export type RewardsLeaderboardInterval =
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "alltime";

export type RewardsReferralsSortBy = "bonus" | "points" | "createdAt";
export type RewardsReferralsSortDir = "asc" | "desc";

export type RewardsLeaderboardRow = {
  userId: string;
  rank: number;
  points: number;
  level: number | null;
  volumeUsd: number;
  pnlUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  displayName: string | null;
  username: string | null;
  walletAddress: string | null;
};

export type RewardsLeaderboardAggregateRow = Omit<
  RewardsLeaderboardRow,
  "level"
> & {
  tierPoints: number;
};

export type RewardsManualFilterMode =
  | "include_all"
  | "exclude_volume_only"
  | "exclude_all";

export type AdminManualVolumeEvent = {
  id: string;
  user_id: string;
  wallet_address: string | null;
  venue: string;
  source_type: string;
  source_id: string;
  notional_usd: string | null;
  points_awarded: string | null;
  visible: boolean;
  created_at: Date;
};

export type ReferralCodePolicyType = "user" | "campaign";

export type ReferralCodeLookupRow = {
  referral_code_id: string;
  code: string;
  is_active: boolean;
  retired_at: Date | null;
  retired_reason: string | null;
  max_uses: number | null;
  policy_id: string;
  policy_type: ReferralCodePolicyType;
  owner_user_id: string | null;
  label: string | null;
  multiplier_override: string | null;
  visible_drop_points: string;
  tier_drop_points: string;
  created_at: Date;
  updated_at: Date;
};

export type ReferralCodeListRow = ReferralCodeLookupRow & {
  owner_email: string | null;
  owner_username: string | null;
  owner_display_name: string | null;
  referral_count: string;
};

export type ReferralCodeUsageLimitFilter = "limited" | "unlimited";

export type ReferralCodeReferralUserRow = {
  id: string;
  referred_user_id: string;
  status: string;
  qualified_at: Date | null;
  attached_at: Date;
  email: string | null;
  username: string | null;
  display_name: string | null;
  primary_wallet: string | null;
  public_points: string | null;
  tier_points: string | null;
  qualification_points: string | null;
  referral_bonus: string | null;
};

export type ReferralCodeMultiplierContextRow = {
  code: string;
  label: string | null;
  policy_type: ReferralCodePolicyType;
  multiplier_override: string | null;
};

const USDC_MICRO_FACTOR = 1_000_000n;
export const HIDDEN_MANUAL_VOLUME_SOURCE_PREFIX = "manual:";
export const VISIBLE_MANUAL_VOLUME_SOURCE_PREFIX = "manual-visible:";
export const REFERRAL_CODE_VISIBLE_DROP_SOURCE_PREFIX =
  "referral-code-visible:";
export const REFERRAL_CODE_TIER_DROP_SOURCE_PREFIX = "referral-code-tier:";

export function isHiddenManualVolumeSourceId(sourceId: string): boolean {
  return sourceId.startsWith(HIDDEN_MANUAL_VOLUME_SOURCE_PREFIX);
}

function buildHiddenManualAdminVolumeEventPredicate(alias: string): string {
  return `${alias}.source_id like '${HIDDEN_MANUAL_VOLUME_SOURCE_PREFIX}%'`;
}

function buildAdminManualVolumeEventPredicate(alias: string): string {
  return `(${buildHiddenManualAdminVolumeEventPredicate(alias)} or ${alias}.source_id like '${VISIBLE_MANUAL_VOLUME_SOURCE_PREFIX}%')`;
}

function buildReferralCodeDropVolumeEventPredicate(alias: string): string {
  return `(${alias}.source_id like '${REFERRAL_CODE_VISIBLE_DROP_SOURCE_PREFIX}%' or ${alias}.source_id like '${REFERRAL_CODE_TIER_DROP_SOURCE_PREFIX}%')`;
}

function buildTierOnlyReferralCodeDropPredicate(alias: string): string {
  return `${alias}.source_id like '${REFERRAL_CODE_TIER_DROP_SOURCE_PREFIX}%'`;
}

function buildVolumeEventsCreatedAtClause(
  alias: string,
  createdAtParamIdx: number | null,
  prefix: "where" | "and" = "where",
): string {
  if (createdAtParamIdx == null) return "";
  return `${prefix} ${alias}.created_at >= $${createdAtParamIdx}`;
}

export function buildVolumeContributionSql(
  alias: string,
  manualMode: RewardsManualFilterMode = "exclude_volume_only",
): string {
  if (manualMode === "include_all") return `${alias}.notional_usd`;

  const excludedPredicates = [
    buildAdminManualVolumeEventPredicate(alias),
    buildReferralCodeDropVolumeEventPredicate(alias),
  ];
  return `case when not (${excludedPredicates.join(" or ")}) then ${alias}.notional_usd else 0 end`;
}

export function buildPublicPointsContributionSql(alias: string): string {
  return `case when not (${buildHiddenManualAdminVolumeEventPredicate(alias)} or ${buildTierOnlyReferralCodeDropPredicate(alias)}) then ${alias}.points_awarded else 0 end`;
}

export function buildTierPointsContributionSql(alias: string): string {
  return `${alias}.points_awarded`;
}

export function buildQualificationPointsContributionSql(alias: string): string {
  return `${alias}.points_awarded`;
}

function decimalToMicroFloor(value: string | null | undefined): bigint {
  const raw = value?.trim() ?? "0";
  if (!raw) return 0n;
  const normalized = raw.replace(/_/g, "");
  if (!/^\d+(\.\d+)?$/.test(normalized)) return 0n;
  const [whole, fraction = ""] = normalized.split(".");
  const wholeMicro = BigInt(whole) * USDC_MICRO_FACTOR;
  const fractionMicro = BigInt((fraction + "000000").slice(0, 6));
  return wholeMicro + fractionMicro;
}

function microToDecimalString(value: bigint): string {
  const whole = value / USDC_MICRO_FACTOR;
  const fraction = value % USDC_MICRO_FACTOR;
  return `${whole.toString()}.${fraction.toString().padStart(6, "0")}`;
}

export async function fetchActiveRewardsPolicy(
  pool: DbQuery,
): Promise<RewardsPolicyRow | null> {
  const { rows } = await pool.query<RewardsPolicyRow>(
    `
      select id, effective_at, tiers, referral_bonus, created_at
      from rewards_policy
      where effective_at <= now()
      order by effective_at desc
      limit 1
    `,
  );
  return rows[0] ?? null;
}

export async function fetchActiveRewardsMultiplierPolicy(
  pool: DbQuery,
  asOf: Date = new Date(),
): Promise<RewardsMultiplierPolicyRow | null> {
  const { rows } = await pool.query<RewardsMultiplierPolicyRow>(
    `
      select
        id,
        effective_at,
        global_multiplier::text as global_multiplier,
        global_multiplier_label,
        referral_rules,
        tier_rules,
        notes,
        created_at,
        updated_at
      from rewards_multiplier_policy
      where effective_at <= $1
      order by effective_at desc, created_at desc
      limit 1
    `,
    [asOf],
  );
  return rows[0] ?? null;
}

export async function insertRewardsMultiplierPolicy(
  pool: DbQuery,
  inputs: {
    effectiveAt: Date;
    globalMultiplier: number;
    globalMultiplierLabel?: string | null;
    referralRules: unknown;
    tierRules: unknown;
    notes?: string | null;
  },
): Promise<RewardsMultiplierPolicyRow> {
  const { rows } = await pool.query<RewardsMultiplierPolicyRow>(
    `
      insert into rewards_multiplier_policy (
        effective_at,
        global_multiplier,
        global_multiplier_label,
        referral_rules,
        tier_rules,
        notes
      )
      values ($1, $2, $3, $4, $5, $6)
      returning
        id,
        effective_at,
        global_multiplier::text as global_multiplier,
        global_multiplier_label,
        referral_rules,
        tier_rules,
        notes,
        created_at,
        updated_at
    `,
    [
      inputs.effectiveAt,
      inputs.globalMultiplier,
      inputs.globalMultiplierLabel?.trim() || null,
      JSON.stringify(inputs.referralRules),
      JSON.stringify(inputs.tierRules),
      inputs.notes ?? null,
    ],
  );
  return rows[0];
}

export async function listRewardsMultiplierOverrides(
  pool: DbQuery,
  inputs: { q?: string; limit: number; offset: number },
): Promise<{ total: number; rows: RewardsMultiplierOverrideRow[] }> {
  const params: PgParams = [];
  const whereParts: string[] = [];
  if (inputs.q?.trim()) {
    params.push(`%${inputs.q.trim()}%`);
    const placeholder = `$${params.length}`;
    whereParts.push(
      `(o.user_id::text ilike ${placeholder}
        or coalesce(o.label, '') ilike ${placeholder}
        or coalesce(u.email, '') ilike ${placeholder}
        or coalesce(u.username, '') ilike ${placeholder}
        or coalesce(u.display_name, '') ilike ${placeholder}
        or coalesce(w.wallet_address, '') ilike ${placeholder})`,
    );
  }
  const whereSql = whereParts.length ? `where ${whereParts.join(" and ")}` : "";

  const countSql = `
    select count(*)::text as total
    from rewards_multiplier_user_overrides o
    left join users u on u.id = o.user_id
    left join lateral (
      select wallet_address
      from user_wallets uw
      where uw.user_id = o.user_id
        and uw.is_primary = true
      order by uw.created_at asc
      limit 1
    ) w on true
    ${whereSql}
  `;
  const { rows: countRows } = await pool.query<{ total: string }>(
    countSql,
    params,
  );

  const dataParams: PgParams = [...params, inputs.limit, inputs.offset];
  const rowsSql = `
    select
      o.user_id,
      o.multiplier::text as multiplier,
      o.label,
      o.reason,
      o.effective_at,
      o.expires_at,
      o.created_at,
      o.updated_at,
      w.wallet_address,
      u.email,
      u.username,
      u.display_name
    from rewards_multiplier_user_overrides o
    left join users u on u.id = o.user_id
    left join lateral (
      select wallet_address
      from user_wallets uw
      where uw.user_id = o.user_id
        and uw.is_primary = true
      order by uw.created_at asc
      limit 1
    ) w on true
    ${whereSql}
    order by o.updated_at desc, o.user_id asc
    limit $${dataParams.length - 1}
    offset $${dataParams.length}
  `;
  const { rows } = await pool.query<RewardsMultiplierOverrideRow>(
    rowsSql,
    dataParams,
  );

  return { total: Number(countRows[0]?.total ?? 0), rows };
}

export async function upsertRewardsMultiplierOverride(
  pool: DbQuery,
  inputs: {
    userId: string;
    multiplier: number;
    label?: string | null;
    reason?: string | null;
    effectiveAt: Date;
    expiresAt?: Date | null;
  },
): Promise<RewardsMultiplierOverrideRow> {
  const { rows } = await pool.query<RewardsMultiplierOverrideRow>(
    `
      insert into rewards_multiplier_user_overrides (
        user_id,
        multiplier,
        label,
        reason,
        effective_at,
        expires_at
      )
      values ($1, $2, $3, $4, $5, $6)
      on conflict (user_id)
      do update set
        multiplier = excluded.multiplier,
        label = excluded.label,
        reason = excluded.reason,
        effective_at = excluded.effective_at,
        expires_at = excluded.expires_at,
        updated_at = now()
      returning
        user_id,
        multiplier::text as multiplier,
        label,
        reason,
        effective_at,
        expires_at,
        created_at,
        updated_at,
        (
          select wallet_address
          from user_wallets uw
          where uw.user_id = rewards_multiplier_user_overrides.user_id
            and uw.is_primary = true
          order by uw.created_at asc
          limit 1
        ) as wallet_address,
        (
          select email
          from users u
          where u.id = rewards_multiplier_user_overrides.user_id
        ) as email,
        (
          select username
          from users u
          where u.id = rewards_multiplier_user_overrides.user_id
        ) as username,
        (
          select display_name
          from users u
          where u.id = rewards_multiplier_user_overrides.user_id
        ) as display_name
    `,
    [
      inputs.userId,
      inputs.multiplier,
      inputs.label?.trim() || null,
      inputs.reason ?? null,
      inputs.effectiveAt,
      inputs.expiresAt ?? null,
    ],
  );
  return rows[0];
}

export async function deleteRewardsMultiplierOverride(
  pool: DbQuery,
  userId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `delete from rewards_multiplier_user_overrides where user_id = $1`,
    [userId],
  );
  return Number(rowCount ?? 0) > 0;
}

export async function fetchUserReferralCode(
  pool: DbQuery,
  userId: string,
): Promise<string | null> {
  const { rows } = await pool.query<{ referral_code: string | null }>(
    `select referral_code from users where id = $1`,
    [userId],
  );
  return rows[0]?.referral_code ?? null;
}

export async function ensureUserReferralCodePolicy(
  pool: DbQuery,
  userId: string,
): Promise<{ id: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `
      insert into referral_code_policies (policy_type, owner_user_id)
      values ('user', $1)
      on conflict do nothing
      returning id
    `,
    [userId],
  );
  if (rows[0]) return rows[0];

  const existing = await pool.query<{ id: string }>(
    `
      select id
      from referral_code_policies
      where policy_type = 'user'
        and owner_user_id = $1
      limit 1
    `,
    [userId],
  );
  if (!existing.rows[0]) {
    throw new Error("Failed to resolve user referral code policy");
  }
  return existing.rows[0];
}

export async function findReferralCodeByCode(
  pool: DbQuery,
  referralCode: string,
): Promise<ReferralCodeLookupRow | null> {
  const { rows } = await pool.query<ReferralCodeLookupRow>(
    `
      select
        rc.id as referral_code_id,
        rc.code,
        rc.is_active,
        rc.retired_at,
        rc.retired_reason,
        rc.max_uses,
        p.id as policy_id,
        p.policy_type,
        p.owner_user_id,
        p.label,
        p.multiplier_override::text as multiplier_override,
        p.visible_drop_points::text as visible_drop_points,
        p.tier_drop_points::text as tier_drop_points,
        rc.created_at,
        rc.updated_at
      from referral_codes rc
      join referral_code_policies p
        on p.id = rc.policy_id
      where rc.code = upper($1)
      limit 1
    `,
    [referralCode],
  );
  return rows[0] ?? null;
}

export async function findActiveReferralCodeForAttach(
  pool: DbQuery,
  referralCode: string,
  inputs?: { lockForUpdate?: boolean },
): Promise<ReferralCodeLookupRow | null> {
  const { rows } = await pool.query<ReferralCodeLookupRow>(
    `
      select
        rc.id as referral_code_id,
        rc.code,
        rc.is_active,
        rc.retired_at,
        rc.retired_reason,
        rc.max_uses,
        p.id as policy_id,
        p.policy_type,
        p.owner_user_id,
        p.label,
        p.multiplier_override::text as multiplier_override,
        p.visible_drop_points::text as visible_drop_points,
        p.tier_drop_points::text as tier_drop_points,
        rc.created_at,
        rc.updated_at
      from referral_codes rc
      join referral_code_policies p
        on p.id = rc.policy_id
      where rc.code = upper($1)
        and rc.is_active = true
        and rc.retired_at is null
      limit 1
      ${inputs?.lockForUpdate ? "for update of rc" : ""}
    `,
    [referralCode],
  );
  return rows[0] ?? null;
}

export async function countReferralsForReferralCode(
  pool: DbQuery,
  referralCodeId: string,
): Promise<number> {
  const { rows } = await pool.query<{ total: string }>(
    `
      select count(*)::text as total
      from referrals
      where referral_code_id = $1
    `,
    [referralCodeId],
  );
  return Number(rows[0]?.total ?? 0);
}

export async function countReferralCodeReferrerMismatches(
  pool: DbQuery,
  inputs: { referralCodeId: string; referrerUserId: string },
): Promise<number> {
  const { rows } = await pool.query<{ total: string }>(
    `
      select count(*)::text as total
      from referrals
      where referral_code_id = $1
        and referrer_user_id is distinct from $2::uuid
    `,
    [inputs.referralCodeId, inputs.referrerUserId],
  );
  return Number(rows[0]?.total ?? 0);
}

export async function moveReferralCodeAttribution(
  pool: DbQuery,
  inputs: {
    sourceReferralCodeId: string;
    sourceCode: string;
    replacementReferralCodeId: string;
    replacementCode: string;
    referrerUserId: string;
  },
): Promise<{ referralsMoved: number; firstTradeConversionsMoved: number }> {
  const { rows } = await pool.query<{
    referrals_moved: string;
    first_trade_conversions_moved: string;
  }>(
    `
      with moved_referrals as (
        update referrals r
        set code = $4,
            referral_code_id = $3,
            updated_at = now()
        where r.referral_code_id = $1
          and r.referrer_user_id = $5
        returning r.referred_user_id
      ),
      moved_first_trades as (
        update referral_first_trade_conversions c
        set code = $4,
            updated_at = now()
        from moved_referrals mr
        where c.referred_user_id = mr.referred_user_id
          and c.referrer_user_id = $5
          and upper(c.code) = upper($2)
        returning c.id
      )
      select
        (select count(*)::text from moved_referrals) as referrals_moved,
        (select count(*)::text from moved_first_trades) as first_trade_conversions_moved
    `,
    [
      inputs.sourceReferralCodeId,
      inputs.sourceCode,
      inputs.replacementReferralCodeId,
      inputs.replacementCode,
      inputs.referrerUserId,
    ],
  );
  return {
    referralsMoved: Number(rows[0]?.referrals_moved ?? 0),
    firstTradeConversionsMoved: Number(
      rows[0]?.first_trade_conversions_moved ?? 0,
    ),
  };
}

export async function retireReferralCodeForUsageLimit(
  pool: DbQuery,
  referralCodeId: string,
): Promise<void> {
  await pool.query(
    `
      update referral_codes
      set is_active = false,
          retired_at = coalesce(retired_at, now()),
          retired_reason = coalesce(retired_reason, 'usage_limit_reached')
      where id = $1
        and is_active = true
    `,
    [referralCodeId],
  );
}

export async function retireActiveUserReferralCodes(
  pool: DbQuery,
  userId: string,
  reason: string,
): Promise<void> {
  await pool.query(
    `
      update referral_codes rc
      set is_active = false,
          retired_at = coalesce(rc.retired_at, now()),
          retired_reason = coalesce(rc.retired_reason, $2)
      from referral_code_policies p
      where p.id = rc.policy_id
        and p.policy_type = 'user'
        and p.owner_user_id = $1
        and rc.is_active = true
    `,
    [userId, reason],
  );
}

export async function insertReferralCodeAlias(
  pool: DbQuery,
  inputs: {
    code: string;
    policyId: string;
    isActive: boolean;
    retiredReason?: string | null;
    maxUses?: number | null;
  },
): Promise<ReferralCodeLookupRow> {
  const { rows } = await pool.query<ReferralCodeLookupRow>(
    `
      with inserted as (
        insert into referral_codes (
          code,
          policy_id,
          is_active,
          retired_at,
          retired_reason,
          max_uses
        )
        values (
          upper($1),
          $2,
          $3,
          case when $3 then null else now() end,
          case when $3 then null else $4 end,
          $5
        )
        returning *
      )
      select
        i.id as referral_code_id,
        i.code,
        i.is_active,
        i.retired_at,
        i.retired_reason,
        i.max_uses,
        p.id as policy_id,
        p.policy_type,
        p.owner_user_id,
        p.label,
        p.multiplier_override::text as multiplier_override,
        p.visible_drop_points::text as visible_drop_points,
        p.tier_drop_points::text as tier_drop_points,
        i.created_at,
        i.updated_at
      from inserted i
      join referral_code_policies p
        on p.id = i.policy_id
    `,
    [
      inputs.code,
      inputs.policyId,
      inputs.isActive,
      inputs.retiredReason ?? null,
      inputs.maxUses ?? null,
    ],
  );
  return rows[0];
}

export async function insertExactReferralCodeDropEvent(
  pool: DbQuery,
  inputs: {
    userId: string;
    sourceId: string;
    points: number;
    createdAt?: Date | null;
  },
): Promise<boolean> {
  const { rows } = await pool.query<{ inserted: boolean }>(
    `
      insert into volume_events (
        id,
        user_id,
        wallet_address,
        venue,
        source_type,
        source_id,
        notional_usd,
        multiplier_applied,
        points_awarded,
        multiplier_source,
        created_at
      )
      values (
        gen_random_uuid(),
        $1,
        null,
        'referral',
        'execution',
        $2,
        $3,
        1,
        $3,
        'referral_code',
        coalesce($4::timestamptz, now())
      )
      on conflict (user_id, source_type, source_id) do nothing
      returning true as inserted
    `,
    [inputs.userId, inputs.sourceId, inputs.points, inputs.createdAt ?? null],
  );
  return Boolean(rows[0]?.inserted);
}

export async function insertExactManualVolumeEvent(
  pool: DbQuery,
  inputs: {
    userId: string;
    walletAddress: string | null;
    venue: string;
    sourceType: "order" | "execution";
    sourceId: string;
    points: number;
    createdAt?: Date | null;
  },
): Promise<{ inserted: boolean; id: string | null }> {
  const { rows } = await pool.query<{ id: string }>(
    `
      insert into volume_events (
        id,
        user_id,
        wallet_address,
        venue,
        source_type,
        source_id,
        notional_usd,
        multiplier_applied,
        points_awarded,
        multiplier_source,
        created_at
      )
      values (
        gen_random_uuid(),
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        1,
        $6,
        'user',
        coalesce($7::timestamptz, now())
      )
      on conflict (user_id, source_type, source_id) do nothing
      returning id
    `,
    [
      inputs.userId,
      inputs.walletAddress,
      inputs.venue,
      inputs.sourceType,
      inputs.sourceId,
      inputs.points,
      inputs.createdAt ?? null,
    ],
  );
  const id = rows[0]?.id ?? null;
  return { inserted: id != null, id };
}

export async function fetchReferralCodeMultiplierContextForUser(
  pool: DbQuery,
  inputs: { userId: string; eventTime: Date },
): Promise<ReferralCodeMultiplierContextRow | null> {
  const { rows } = await pool.query<ReferralCodeMultiplierContextRow>(
    `
      select
        rc.code,
        p.label,
        p.policy_type,
        p.multiplier_override::text as multiplier_override
      from referrals r
      join referral_codes rc
        on rc.id = r.referral_code_id
      join referral_code_policies p
        on p.id = rc.policy_id
      where r.referred_user_id = $1
        and r.created_at <= $2
        and p.multiplier_override is not null
        and p.multiplier_override > 0
      order by r.created_at desc
      limit 1
    `,
    [inputs.userId, inputs.eventTime],
  );
  return rows[0] ?? null;
}

export async function listReferralCodes(
  pool: DbQuery,
  inputs: {
    q?: string | null;
    policyType?: ReferralCodePolicyType | null;
    active?: boolean | null;
    usageLimit?: ReferralCodeUsageLimitFilter | null;
    limit: number;
    offset: number;
  },
): Promise<{ total: number; rows: ReferralCodeListRow[] }> {
  const params: PgParams = [];
  const whereParts: string[] = [];
  const search = inputs.q?.trim() || null;
  if (inputs.q?.trim()) {
    params.push(`%${inputs.q.trim()}%`);
    const qIdx = params.length;
    whereParts.push(`(
      rc.code ilike $${qIdx}
      or coalesce(p.label, '') ilike $${qIdx}
      or coalesce(u.email, '') ilike $${qIdx}
      or coalesce(u.username, '') ilike $${qIdx}
      or coalesce(u.display_name, '') ilike $${qIdx}
    )`);
  }
  if (inputs.policyType) {
    params.push(inputs.policyType);
    whereParts.push(`p.policy_type = $${params.length}`);
  }
  if (inputs.active != null) {
    params.push(inputs.active);
    whereParts.push(`rc.is_active = $${params.length}`);
  }
  if (inputs.usageLimit === "limited") {
    whereParts.push(`rc.max_uses is not null`);
  } else if (inputs.usageLimit === "unlimited") {
    whereParts.push(`rc.max_uses is null`);
  }
  const whereSql = whereParts.length ? `where ${whereParts.join(" and ")}` : "";

  const countRows = await pool.query<{ total: string }>(
    `
      select count(*)::text as total
      from referral_codes rc
      join referral_code_policies p
        on p.id = rc.policy_id
      left join users u
        on u.id = p.owner_user_id
      ${whereSql}
    `,
    params,
  );

  const dataParams = [...params];
  let orderBySql = "rc.is_active desc, rc.updated_at desc, rc.code asc";
  if (search) {
    dataParams.push(search.toUpperCase());
    const exactIdx = dataParams.length;
    dataParams.push(`${search.toUpperCase()}%`);
    const prefixIdx = dataParams.length;
    orderBySql = `
        case
          when rc.code = $${exactIdx} then 0
          when rc.code like $${prefixIdx} then 1
          else 2
        end asc,
        ${orderBySql}
      `;
  }
  dataParams.push(inputs.limit, inputs.offset);
  const { rows } = await pool.query<ReferralCodeListRow>(
    `
      select
        rc.id as referral_code_id,
        rc.code,
        rc.is_active,
        rc.retired_at,
        rc.retired_reason,
        rc.max_uses,
        p.id as policy_id,
        p.policy_type,
        p.owner_user_id,
        p.label,
        p.multiplier_override::text as multiplier_override,
        p.visible_drop_points::text as visible_drop_points,
        p.tier_drop_points::text as tier_drop_points,
        rc.created_at,
        rc.updated_at,
        u.email as owner_email,
        u.username as owner_username,
        u.display_name as owner_display_name,
        (
          select count(*)::text
          from referrals r
          where r.referral_code_id = rc.id
        ) as referral_count
      from referral_codes rc
      join referral_code_policies p
        on p.id = rc.policy_id
      left join users u
        on u.id = p.owner_user_id
      ${whereSql}
      order by ${orderBySql}
      limit $${dataParams.length - 1}
      offset $${dataParams.length}
    `,
    dataParams,
  );

  return {
    total: Number(countRows.rows[0]?.total ?? 0),
    rows,
  };
}

export async function createCampaignReferralCode(
  pool: DbQuery,
  inputs: {
    code: string;
    label?: string | null;
    multiplierOverride?: number | null;
    visibleDropPoints?: number | null;
    tierDropPoints?: number | null;
    maxUses?: number | null;
  },
): Promise<ReferralCodeLookupRow> {
  const policyResult = await pool.query<{ id: string }>(
    `
      insert into referral_code_policies (
        policy_type,
        owner_user_id,
        label,
        multiplier_override,
        visible_drop_points,
        tier_drop_points
      )
      values ('campaign', null, $1, $2, $3, $4)
      returning id
    `,
    [
      inputs.label?.trim() || null,
      inputs.multiplierOverride ?? null,
      inputs.visibleDropPoints ?? 0,
      inputs.tierDropPoints ?? 0,
    ],
  );

  return insertReferralCodeAlias(pool, {
    code: inputs.code,
    policyId: policyResult.rows[0].id,
    isActive: true,
    maxUses: inputs.maxUses ?? null,
  });
}

export async function updateReferralCodePolicy(
  pool: DbQuery,
  inputs: {
    referralCodeId: string;
    label?: string | null;
    multiplierOverride?: number | null;
    visibleDropPoints?: number | null;
    tierDropPoints?: number | null;
    maxUses?: number | null;
    deactivateCampaign?: boolean;
    reactivateCampaign?: boolean;
  },
): Promise<ReferralCodeLookupRow | null> {
  const current = await pool.query<ReferralCodeLookupRow>(
    `
      select
        rc.id as referral_code_id,
        rc.code,
        rc.is_active,
        rc.retired_at,
        rc.retired_reason,
        rc.max_uses,
        p.id as policy_id,
        p.policy_type,
        p.owner_user_id,
        p.label,
        p.multiplier_override::text as multiplier_override,
        p.visible_drop_points::text as visible_drop_points,
        p.tier_drop_points::text as tier_drop_points,
        rc.created_at,
        rc.updated_at
      from referral_codes rc
      join referral_code_policies p
        on p.id = rc.policy_id
      where rc.id = $1
      for update
    `,
    [inputs.referralCodeId],
  );
  const row = current.rows[0];
  if (!row) return null;

  await pool.query(
    `
      update referral_code_policies
      set label = $2,
          multiplier_override = $3,
          visible_drop_points = $4,
          tier_drop_points = $5
      where id = $1
    `,
    [
      row.policy_id,
      inputs.label === undefined ? row.label : inputs.label?.trim() || null,
      inputs.multiplierOverride === undefined
        ? row.multiplier_override
        : inputs.multiplierOverride,
      inputs.visibleDropPoints === undefined
        ? row.visible_drop_points
        : inputs.visibleDropPoints,
      inputs.tierDropPoints === undefined
        ? row.tier_drop_points
        : inputs.tierDropPoints,
    ],
  );

  if (inputs.deactivateCampaign) {
    await pool.query(
      `
        update referral_codes rc
        set is_active = false,
            retired_at = coalesce(retired_at, now()),
            retired_reason = coalesce(retired_reason, 'campaign_deactivated')
        where rc.id = $1
          and rc.is_active = true
      `,
      [inputs.referralCodeId],
    );
  }

  if (inputs.maxUses !== undefined) {
    await pool.query(
      `
        update referral_codes
        set max_uses = $2
        where id = $1
      `,
      [inputs.referralCodeId, inputs.maxUses],
    );
  }

  if (inputs.reactivateCampaign) {
    await pool.query(
      `
        update referral_codes rc
        set is_active = true,
            retired_at = null,
            retired_reason = null
        where rc.id = $1
          and rc.is_active = false
      `,
      [inputs.referralCodeId],
    );
  }

  const updated = await findReferralCodeByCode(pool, row.code);
  return updated;
}

export async function setUserReferralCode(
  pool: DbQuery,
  userId: string,
  referralCode: string | null,
): Promise<void> {
  await pool.query(`update users set referral_code = $2 where id = $1`, [
    userId,
    referralCode,
  ]);
}

export async function clearUserReferralCodeIfMatches(
  pool: DbQuery,
  userId: string,
  referralCode: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `
      update users
      set referral_code = null
      where id = $1
        and upper(referral_code) = upper($2)
    `,
    [userId, referralCode],
  );
  return Number(rowCount ?? 0) > 0;
}

export async function fetchUserTutorialDismissal(
  pool: DbQuery,
  inputs: { userId: string; tutorialKey: string },
): Promise<UserTutorialDismissalRow | null> {
  const { rows } = await pool.query<UserTutorialDismissalRow>(
    `
      select user_id, tutorial_key, dismissed_at, created_at, updated_at
      from user_tutorial_dismissals
      where user_id = $1
        and tutorial_key = $2
      limit 1
    `,
    [inputs.userId, inputs.tutorialKey],
  );
  return rows[0] ?? null;
}

export async function upsertUserTutorialDismissal(
  pool: DbQuery,
  inputs: { userId: string; tutorialKey: string },
): Promise<UserTutorialDismissalRow> {
  const { rows } = await pool.query<UserTutorialDismissalRow>(
    `
      insert into user_tutorial_dismissals (
        user_id,
        tutorial_key,
        dismissed_at
      )
      values ($1, $2, now())
      on conflict (user_id, tutorial_key)
      do update
      set dismissed_at = user_tutorial_dismissals.dismissed_at
      returning user_id, tutorial_key, dismissed_at, created_at, updated_at
    `,
    [inputs.userId, inputs.tutorialKey],
  );
  return rows[0];
}

export async function lockUserReferralCodeByUserId(
  pool: DbQuery,
  userId: string,
): Promise<{ id: string; referral_code: string | null } | null> {
  const { rows } = await pool.query<{
    id: string;
    referral_code: string | null;
  }>(
    `
      select id, referral_code
      from users
      where id = $1
      for update
    `,
    [userId],
  );
  return rows[0] ?? null;
}

export async function findUserByReferralCode(
  pool: DbQuery,
  referralCode: string,
): Promise<{ id: string } | null> {
  const { rows } = await pool.query<{ id: string }>(
    `select id from users where upper(referral_code) = upper($1) limit 1`,
    [referralCode],
  );
  return rows[0] ?? null;
}

export async function insertReferral(
  pool: DbQuery,
  inputs: {
    referrerUserId: string | null;
    referredUserId: string;
    code: string;
    referralCodeId: string;
    status?: "pending" | "qualified" | "blocked";
    qualifiedAt?: Date | null;
  },
): Promise<{ inserted: boolean; id: string | null }> {
  const { rows } = await pool.query<{ id: string }>(
    `
      insert into referrals (
        referrer_user_id,
        referred_user_id,
        code,
        referral_code_id,
        status,
        qualified_at
      )
      values ($1, $2, $3, $4, $5, $6)
      on conflict (referred_user_id) do nothing
      returning id
    `,
    [
      inputs.referrerUserId,
      inputs.referredUserId,
      inputs.code,
      inputs.referralCodeId,
      inputs.status ?? "pending",
      inputs.qualifiedAt ?? null,
    ],
  );
  return { inserted: Boolean(rows[0]?.id), id: rows[0]?.id ?? null };
}

export async function fetchInboundReferralForUser(
  pool: DbQuery,
  userId: string,
): Promise<InboundReferralRow | null> {
  const { rows } = await pool.query<InboundReferralRow>(
    `
      select
        r.referrer_user_id,
        r.code,
        r.referral_code_id,
        p.policy_type,
        p.id as policy_id,
        p.label as policy_label,
        p.multiplier_override::text as policy_multiplier_override,
        p.owner_user_id as policy_owner_user_id,
        r.status,
        r.created_at as linked_at,
        r.qualified_at,
        u.username as referrer_username,
        u.display_name as referrer_display_name
      from referrals r
      left join referral_codes rc
        on rc.id = r.referral_code_id
      left join referral_code_policies p
        on p.id = rc.policy_id
      left join users u on u.id = r.referrer_user_id
      where r.referred_user_id = $1
      limit 1
    `,
    [userId],
  );
  return rows[0] ?? null;
}

export async function fetchUserPoints(
  pool: DbQuery,
  userId: string,
): Promise<number> {
  const { rows } = await pool.query<{ total: string | null }>(
    `
      select coalesce(sum(${buildPublicPointsContributionSql("ve")}), 0)::text as total
      from volume_events ve
      where ve.user_id = $1
    `,
    [userId],
  );
  return Number(rows[0]?.total ?? 0);
}

export async function fetchUserTierPoints(
  pool: DbQuery,
  userId: string,
): Promise<number> {
  const { rows } = await pool.query<{ total: string | null }>(
    `
      select coalesce(sum(${buildTierPointsContributionSql("ve")}), 0)::text as total
      from volume_events ve
      where ve.user_id = $1
    `,
    [userId],
  );
  return Number(rows[0]?.total ?? 0);
}

export async function fetchUserQualificationPoints(
  pool: DbQuery,
  userId: string,
): Promise<number> {
  const { rows } = await pool.query<{ total: string | null }>(
    `
      select coalesce(sum(${buildQualificationPointsContributionSql("ve")}), 0)::text as total
      from volume_events ve
      where ve.user_id = $1
    `,
    [userId],
  );
  return Number(rows[0]?.total ?? 0);
}

export async function fetchUserVolume(
  pool: DbQuery,
  userId: string,
): Promise<number> {
  const { rows } = await pool.query<{ total: string | null }>(
    `
      select coalesce(sum(${buildVolumeContributionSql("ve", "exclude_volume_only")}), 0)::text as total
      from volume_events ve
      where ve.user_id = $1
    `,
    [userId],
  );
  return Number(rows[0]?.total ?? 0);
}

export async function fetchFeeTotals(
  pool: DbQuery,
  inputs: { userId: string },
): Promise<{ pending: number; collected: number }> {
  const { rows } = await pool.query<{
    pending: string | null;
    collected: string | null;
  }>(
    `
      select
        coalesce(
          sum(
            case
              when status = 'pending'
                then cashback_earned_usdc
              else 0
            end
          ),
          0
        )::text as pending,
        coalesce(
          sum(
            case
              when status = 'collected'
                then cashback_earned_usdc
              else 0
            end
          ),
          0
        )::text as collected
      from fee_events
      where user_id = $1
        and liability_snapshot_source = 'event_time_frozen'
    `,
    [inputs.userId],
  );
  const row = rows[0];
  return {
    pending: Number(row?.pending ?? 0),
    collected: Number(row?.collected ?? 0),
  };
}

export async function fetchFeeTotalsByChain(
  pool: DbQuery,
  inputs: { userId: string },
): Promise<Record<string, { pending: string; collected: string }>> {
  const { rows } = await pool.query<{
    chain_id: string | null;
    pending: string | null;
    collected: string | null;
  }>(
    `
      select
        coalesce(chain_id, 'unknown') as chain_id,
        coalesce(
          sum(
            case
              when status = 'pending'
                then cashback_earned_usdc
              else 0
            end
          ),
          0
        )::text as pending,
        coalesce(
          sum(
            case
              when status = 'collected'
                then cashback_earned_usdc
              else 0
            end
          ),
          0
        )::text as collected
      from fee_events
      where user_id = $1
        and liability_snapshot_source = 'event_time_frozen'
      group by chain_id
    `,
    [inputs.userId],
  );
  const totals: Record<string, { pending: string; collected: string }> = {};
  for (const row of rows) {
    const canonicalChainId = normalizeRewardsChainId(row.chain_id);
    if (!canonicalChainId) continue;
    const existing = totals[canonicalChainId] ?? {
      pending: "0",
      collected: "0",
    };
    const pendingMicro =
      decimalToMicroFloor(existing.pending) + decimalToMicroFloor(row.pending);
    const collectedMicro =
      decimalToMicroFloor(existing.collected) +
      decimalToMicroFloor(row.collected);
    totals[canonicalChainId] = {
      pending: microToDecimalString(pendingMicro),
      collected: microToDecimalString(collectedMicro),
    };
  }
  return totals;
}

export async function fetchReferralFeeTotals(
  pool: DbQuery,
  inputs: { userId: string },
): Promise<{ pending: number; collected: number }> {
  const { rows } = await pool.query<{
    pending: string | null;
    collected: string | null;
  }>(
    `
      select
        coalesce(
          sum(
            case
              when fe.status = 'pending'
                then fe.referral_earned_usdc
              else 0
            end
          ),
          0
        )::text as pending,
        coalesce(
          sum(
            case
              when fe.status = 'collected'
                then fe.referral_earned_usdc
              else 0
            end
          ),
          0
        )::text as collected
      from fee_events fe
      join referrals r on r.referred_user_id = fe.user_id
      where r.referrer_user_id = $1
        and fe.liability_snapshot_source = 'event_time_frozen'
    `,
    [inputs.userId],
  );
  const row = rows[0];
  return {
    pending: Number(row?.pending ?? 0),
    collected: Number(row?.collected ?? 0),
  };
}

export async function fetchReferralFeeTotalsByChain(
  pool: DbQuery,
  inputs: { userId: string },
): Promise<Record<string, { pending: string; collected: string }>> {
  const { rows } = await pool.query<{
    chain_id: string | null;
    pending: string | null;
    collected: string | null;
  }>(
    `
      select
        coalesce(fe.chain_id, 'unknown') as chain_id,
        coalesce(
          sum(
            case
              when fe.status = 'pending'
                then fe.referral_earned_usdc
              else 0
            end
          ),
          0
        )::text as pending,
        coalesce(
          sum(
            case
              when fe.status = 'collected'
                then fe.referral_earned_usdc
              else 0
            end
          ),
          0
        )::text as collected
      from fee_events fe
      join referrals r on r.referred_user_id = fe.user_id
      where r.referrer_user_id = $1
        and fe.liability_snapshot_source = 'event_time_frozen'
      group by fe.chain_id
    `,
    [inputs.userId],
  );
  const totals: Record<string, { pending: string; collected: string }> = {};
  for (const row of rows) {
    const canonicalChainId = normalizeRewardsChainId(row.chain_id);
    if (!canonicalChainId) continue;
    const existing = totals[canonicalChainId] ?? {
      pending: "0",
      collected: "0",
    };
    const pendingMicro =
      decimalToMicroFloor(existing.pending) + decimalToMicroFloor(row.pending);
    const collectedMicro =
      decimalToMicroFloor(existing.collected) +
      decimalToMicroFloor(row.collected);
    totals[canonicalChainId] = {
      pending: microToDecimalString(pendingMicro),
      collected: microToDecimalString(collectedMicro),
    };
  }
  return totals;
}

export async function fetchQualifiedReferralCount(
  pool: DbQuery,
  inputs: { userId: string; threshold: number },
): Promise<number> {
  const { rows } = await pool.query<{ total: string }>(
    `
      with points as (
        select
          ve.user_id,
          coalesce(sum(${buildQualificationPointsContributionSql("ve")}), 0) as points
        from volume_events ve
        group by ve.user_id
      )
      select count(*)::text as total
      from referrals r
      left join points pref
        on pref.user_id = r.referrer_user_id
      left join points prefed
        on prefed.user_id = r.referred_user_id
      where r.referrer_user_id = $1
        and r.status <> 'blocked'
        and coalesce(pref.points, 0) >= $2
        and coalesce(prefed.points, 0) >= $2
    `,
    [inputs.userId, inputs.threshold],
  );
  return Number(rows[0]?.total ?? 0);
}

export async function countReferralsForUser(
  pool: DbQuery,
  userId: string,
): Promise<number> {
  const { rows } = await pool.query<{ total: string }>(
    `
      select count(*)::text as total
      from referrals
      where referrer_user_id = $1
    `,
    [userId],
  );
  return Number(rows[0]?.total ?? 0);
}

export async function fetchClaimedTotalsByChain(
  pool: DbQuery,
  inputs: { userId: string },
): Promise<Record<string, string>> {
  const { rows } = await pool.query<{
    chain_id: string | null;
    total: string | null;
  }>(
    `
      select
        coalesce(chain_id, 'unknown') as chain_id,
        coalesce(sum(amount_usdc), 0)::text as total
      from reward_claims
      where user_id = $1
        and status <> 'failed'
      group by chain_id
    `,
    [inputs.userId],
  );
  const totals: Record<string, string> = {};
  for (const row of rows) {
    const canonicalChainId = normalizeRewardsChainId(row.chain_id);
    if (!canonicalChainId) continue;
    const existingMicro = decimalToMicroFloor(totals[canonicalChainId]);
    const currentMicro = decimalToMicroFloor(row.total);
    totals[canonicalChainId] = microToDecimalString(
      existingMicro + currentMicro,
    );
  }
  return totals;
}

export async function fetchClaimedTotal(
  pool: DbQuery,
  inputs: { userId: string; chainId?: string | null },
): Promise<number> {
  const params: PgParams = [inputs.userId];
  let whereClause = "where user_id = $1 and status <> 'failed'";
  if (inputs.chainId) {
    params.push(inputs.chainId);
    whereClause += ` and chain_id = $${params.length}`;
  }

  const { rows } = await pool.query<{ total: string | null }>(
    `select coalesce(sum(amount_usdc), 0)::text as total from reward_claims ${whereClause}`,
    params,
  );
  return Number(rows[0]?.total ?? 0);
}

export async function fetchReferralsForUser(
  pool: DbQuery,
  inputs: {
    userId: string;
    sortBy: RewardsReferralsSortBy;
    sortDir: RewardsReferralsSortDir;
    limit: number;
    offset: number;
  },
): Promise<
  Array<{
    id: string;
    referred_user_id: string;
    status: string;
    qualified_at: Date | null;
    created_at: Date;
    wallet_address: string | null;
    points: number;
    tierPoints: number;
    bonus: number;
    qualificationPoints: number;
  }>
> {
  const orderByClause = resolveRewardsReferralsOrderBy(inputs);
  const { rows } = await pool.query<{
    id: string;
    referred_user_id: string;
    status: string;
    qualified_at: Date | null;
    created_at: Date;
    wallet_address: string | null;
    points: string | null;
    tier_points: string | null;
    qualification_points: string | null;
    bonus: string | null;
  }>(
    `
      with referral_rows as (
        select
          r.id,
          r.referred_user_id,
          r.status,
          r.qualified_at,
          r.created_at
        from referrals r
        where r.referrer_user_id = $1
      ),
      points as (
        select
          ve.user_id,
          coalesce(sum(${buildPublicPointsContributionSql("ve")}), 0) as points
        from volume_events ve
        join referral_rows rr
          on rr.referred_user_id = ve.user_id
        group by ve.user_id
      ),
      qualification_points as (
        select
          ve.user_id,
          coalesce(sum(${buildQualificationPointsContributionSql("ve")}), 0) as points
        from volume_events ve
        join referral_rows rr
          on rr.referred_user_id = ve.user_id
        group by ve.user_id
      ),
      tier_points as (
        select
          ve.user_id,
          coalesce(sum(${buildTierPointsContributionSql("ve")}), 0) as points
        from volume_events ve
        join referral_rows rr
          on rr.referred_user_id = ve.user_id
        group by ve.user_id
      ),
      referral_bonus as (
        select
          fe.user_id,
          coalesce(sum(fe.referral_earned_usdc), 0) as total_bonus
        from fee_events fe
        join referral_rows rr
          on rr.referred_user_id = fe.user_id
        where fe.liability_snapshot_source = 'event_time_frozen'
          and fe.status <> 'failed'
        group by fe.user_id
      )
      select
        rr.id,
        rr.referred_user_id,
        rr.status,
        rr.qualified_at,
        rr.created_at,
        w.wallet_address,
        coalesce(p.points, 0)::text as points,
        coalesce(tp.points, 0)::text as tier_points,
        coalesce(qp.points, 0)::text as qualification_points,
        coalesce(rb.total_bonus, 0)::text as bonus
      from referral_rows rr
      left join user_wallets w
        on w.user_id = rr.referred_user_id
       and w.is_primary = true
      left join points p
        on p.user_id = rr.referred_user_id
      left join qualification_points qp
        on qp.user_id = rr.referred_user_id
      left join tier_points tp
        on tp.user_id = rr.referred_user_id
      left join referral_bonus rb
        on rb.user_id = rr.referred_user_id
      order by ${orderByClause}
      limit $2 offset $3
    `,
    [inputs.userId, inputs.limit, inputs.offset],
  );

  return rows.map((row) => ({
    id: row.id,
    referred_user_id: row.referred_user_id,
    status: row.status,
    qualified_at: row.qualified_at,
    created_at: row.created_at,
    wallet_address: row.wallet_address ?? null,
    points: Number(row.points ?? 0),
    tierPoints: Number(row.tier_points ?? 0),
    qualificationPoints: Number(row.qualification_points ?? 0),
    bonus: Number(row.bonus ?? 0),
  }));
}

export async function fetchReferralsForReferralCode(
  pool: DbQuery,
  inputs: {
    referralCodeId: string;
    limit: number;
    offset: number;
  },
): Promise<ReferralCodeReferralUserRow[]> {
  const { rows } = await pool.query<ReferralCodeReferralUserRow>(
    `
      with referral_rows as (
        select
          r.id,
          r.referred_user_id,
          r.status,
          r.qualified_at,
          r.created_at as attached_at
        from referrals r
        where r.referral_code_id = $1
        order by r.created_at desc, r.id desc
        limit $2 offset $3
      ),
      public_points as (
        select
          ve.user_id,
          coalesce(sum(${buildPublicPointsContributionSql("ve")}), 0) as points
        from volume_events ve
        join referral_rows rr
          on rr.referred_user_id = ve.user_id
        group by ve.user_id
      ),
      tier_points as (
        select
          ve.user_id,
          coalesce(sum(${buildTierPointsContributionSql("ve")}), 0) as points
        from volume_events ve
        join referral_rows rr
          on rr.referred_user_id = ve.user_id
        group by ve.user_id
      ),
      qualification_points as (
        select
          ve.user_id,
          coalesce(sum(${buildQualificationPointsContributionSql("ve")}), 0) as points
        from volume_events ve
        join referral_rows rr
          on rr.referred_user_id = ve.user_id
        group by ve.user_id
      ),
      referral_bonus as (
        select
          fe.user_id,
          coalesce(sum(fe.referral_earned_usdc), 0) as total_bonus
        from fee_events fe
        join referral_rows rr
          on rr.referred_user_id = fe.user_id
        where fe.liability_snapshot_source = 'event_time_frozen'
          and fe.status <> 'failed'
        group by fe.user_id
      )
      select
        rr.id,
        rr.referred_user_id,
        rr.status,
        rr.qualified_at,
        rr.attached_at,
        u.email,
        u.username,
        u.display_name,
        w.wallet_address as primary_wallet,
        coalesce(pp.points, 0)::text as public_points,
        coalesce(tp.points, 0)::text as tier_points,
        coalesce(qp.points, 0)::text as qualification_points,
        coalesce(rb.total_bonus, 0)::text as referral_bonus
      from referral_rows rr
      join users u
        on u.id = rr.referred_user_id
      left join user_wallets w
        on w.user_id = rr.referred_user_id
       and w.is_primary = true
      left join public_points pp
        on pp.user_id = rr.referred_user_id
      left join tier_points tp
        on tp.user_id = rr.referred_user_id
      left join qualification_points qp
        on qp.user_id = rr.referred_user_id
      left join referral_bonus rb
        on rb.user_id = rr.referred_user_id
      order by rr.attached_at desc, rr.id desc
    `,
    [inputs.referralCodeId, inputs.limit, inputs.offset],
  );
  return rows;
}

export function resolveRewardsReferralsOrderBy(inputs: {
  sortBy: RewardsReferralsSortBy;
  sortDir: RewardsReferralsSortDir;
}): string {
  const direction = inputs.sortDir === "asc" ? "asc" : "desc";

  switch (inputs.sortBy) {
    case "bonus":
      return `coalesce(rb.total_bonus, 0) ${direction}, coalesce(p.points, 0) ${direction}, rr.created_at ${direction}, rr.id ${direction}`;
    case "points":
      return `coalesce(p.points, 0) ${direction}, rr.created_at ${direction}, rr.id ${direction}`;
    case "createdAt":
      return `rr.created_at ${direction}, rr.id ${direction}`;
    default:
      return `coalesce(rb.total_bonus, 0) desc, coalesce(p.points, 0) desc, rr.created_at desc, rr.id desc`;
  }
}

export async function fetchAdminManualVolumeEvents(
  pool: DbQuery,
  inputs: {
    cursor?: { createdAt: Date; id: string } | null;
    userId?: string | null;
    walletAddress?: string | null;
    limit: number;
    offset: number;
  },
): Promise<{ total: number; items: AdminManualVolumeEvent[] }> {
  const params: PgParams = [];
  const whereParts = [buildAdminManualVolumeEventPredicate("ve")];

  if (inputs.userId?.trim()) {
    params.push(inputs.userId.trim());
    whereParts.push(`ve.user_id = $${params.length}`);
  }

  if (inputs.walletAddress?.trim()) {
    params.push(inputs.walletAddress.trim());
    whereParts.push(`ve.wallet_address = $${params.length}`);
  }

  const countWhereSql = `where ${whereParts.join(" and ")}`;
  const countParams = [...params];

  if (inputs.cursor) {
    params.push(inputs.cursor.createdAt);
    const cursorCreatedAtIdx = params.length;
    params.push(inputs.cursor.id);
    const cursorIdIdx = params.length;
    whereParts.push(
      `(ve.created_at, ve.id) < ($${cursorCreatedAtIdx}, $${cursorIdIdx})`,
    );
  }

  const whereSql = `where ${whereParts.join(" and ")}`;

  const countResult = await pool.query<{ total: string | null }>(
    `
      select count(*)::text as total
      from volume_events ve
      ${countWhereSql}
    `,
    countParams,
  );

  params.push(inputs.limit);
  const limitIdx = params.length;
  let offsetSql = "";
  if (!inputs.cursor) {
    params.push(inputs.offset);
    const offsetIdx = params.length;
    offsetSql = `offset $${offsetIdx}`;
  }

  const { rows } = await pool.query<AdminManualVolumeEvent>(
    `
      select
        ve.id,
        ve.user_id,
        ve.wallet_address,
        ve.venue,
        ve.source_type,
        ve.source_id,
        ve.notional_usd::text as notional_usd,
        ve.points_awarded::text as points_awarded,
        not (${buildHiddenManualAdminVolumeEventPredicate("ve")}) as visible,
        ve.created_at
      from volume_events ve
      ${whereSql}
      order by ve.created_at desc, ve.id desc
      limit $${limitIdx}
      ${offsetSql}
    `,
    params,
  );

  return {
    total: Number(countResult.rows[0]?.total ?? 0),
    items: rows,
  };
}

export async function deleteAdminManualVolumeEvent(
  pool: DbQuery,
  id: string,
): Promise<AdminManualVolumeEvent | null> {
  const { rows } = await pool.query<AdminManualVolumeEvent>(
    `
      delete from volume_events ve
      where ve.id = $1
        and ${buildAdminManualVolumeEventPredicate("ve")}
      returning
        ve.id,
        ve.user_id,
        ve.wallet_address,
        ve.venue,
        ve.source_type,
        ve.source_id,
        ve.notional_usd::text as notional_usd,
        ve.points_awarded::text as points_awarded,
        not (${buildHiddenManualAdminVolumeEventPredicate("ve")}) as visible,
        ve.created_at
    `,
    [id],
  );

  return rows[0] ?? null;
}

export async function markQualifiedReferralsForUser(
  pool: DbQuery,
  inputs: { userId: string; threshold: number },
): Promise<void> {
  await pool.query(
    `
      with points as (
        select
          ve.user_id,
          coalesce(sum(${buildQualificationPointsContributionSql("ve")}), 0) as points
        from volume_events ve
        group by ve.user_id
      )
      update referrals r
      set status = 'qualified',
          qualified_at = coalesce(r.qualified_at, now())
      from points pref, points prefed
      where r.status = 'pending'
        and r.referrer_user_id = $1
        and pref.user_id = r.referrer_user_id
        and pref.points >= $2
        and prefed.user_id = r.referred_user_id
        and prefed.points >= $2
    `,
    [inputs.userId, inputs.threshold],
  );
}

export async function insertRewardClaim(
  pool: DbQuery,
  inputs: {
    userId: string;
    walletAddress: string;
    chainId: string;
    amountUsd: string;
    status: "pending" | "submitted" | "confirmed" | "failed";
    txHash?: string | null;
  },
): Promise<{ id: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `
      insert into reward_claims (
        id,
        user_id,
        wallet_address,
        chain_id,
        amount_usdc,
        tx_hash,
        status,
        created_at,
        updated_at
      )
      values (
        gen_random_uuid(),
        $1, $2, $3, $4, $5, $6,
        now(), now()
      )
      returning id
    `,
    [
      inputs.userId,
      inputs.walletAddress,
      inputs.chainId,
      inputs.amountUsd,
      inputs.txHash ?? null,
      inputs.status,
    ],
  );
  return { id: rows[0].id };
}

type RewardsLeaderboardRowDb = {
  user_id: string;
  rank: number;
  points: string | null;
  tier_points: string | null;
  volume_usd: string | null;
  pnl_usd: string | null;
  realized_pnl_usd: string | null;
  unrealized_pnl_usd: string | null;
  display_name: string | null;
  username: string | null;
  wallet_address: string | null;
};

function mapLeaderboardRow(
  row: RewardsLeaderboardRowDb,
): RewardsLeaderboardAggregateRow {
  return {
    userId: row.user_id,
    rank: Number(row.rank ?? 0),
    points: Number(row.points ?? 0),
    tierPoints: Number(row.tier_points ?? 0),
    volumeUsd: Number(row.volume_usd ?? 0),
    pnlUsd: Number(row.pnl_usd ?? 0),
    realizedPnlUsd: Number(row.realized_pnl_usd ?? 0),
    unrealizedPnlUsd: Number(row.unrealized_pnl_usd ?? 0),
    displayName: row.display_name ?? null,
    username: row.username ?? null,
    walletAddress: row.wallet_address ?? null,
  };
}

function buildConnectedWalletScopeSql(userIdPlaceholder?: string): string {
  const userWhere = userIdPlaceholder
    ? `where uw.user_id = ${userIdPlaceholder}`
    : "";
  const userAnd = userIdPlaceholder
    ? `and uvc.user_id = ${userIdPlaceholder}`
    : "";
  const userAndOrders = userIdPlaceholder
    ? `and o.user_id = ${userIdPlaceholder}`
    : "";

  return `
    wallet_scope_candidates as (
      select
        uw.user_id,
        uw.wallet_address,
        case
          when uw.wallet_address ~* '^0x[0-9a-f]{40}$' then lower(uw.wallet_address)
          else uw.wallet_address
        end as wallet_key,
        10 as priority
      from user_wallets uw
      ${userWhere}
      union all
      select
        uvc.user_id,
        uvc.funder_address as wallet_address,
        lower(uvc.funder_address) as wallet_key,
        20 as priority
      from user_venue_credentials uvc
      join user_wallets uw
        on uw.user_id = uvc.user_id
       and lower(uw.wallet_address) = lower(uvc.wallet_address)
      where uvc.venue = 'polymarket'
        and uvc.is_active = true
        and uvc.funder_address is not null
        and uvc.funder_address <> ''
        ${userAnd}
      union all
      select
        o.user_id,
        o.wallet_address,
        lower(o.wallet_address) as wallet_key,
        30 as priority
      from orders o
      join user_wallets uw
        on uw.user_id = o.user_id
       and lower(uw.wallet_address) = lower(o.signer_address)
      where o.venue = 'polymarket'
        and o.wallet_address is not null
        and o.wallet_address <> ''
        ${userAndOrders}
    ),
    wallet_scope as (
      select distinct on (user_id, wallet_key)
        user_id,
        wallet_address,
        wallet_key
      from wallet_scope_candidates
      where wallet_address is not null
        and wallet_address <> ''
        and wallet_key is not null
        and wallet_key <> ''
      order by
        user_id,
        wallet_key,
        priority desc,
        wallet_address desc
    )
  `;
}

function buildPnlCteSql(userIdPlaceholder?: string): string {
  const userFilter = userIdPlaceholder
    ? `and p.user_id = ${userIdPlaceholder}`
    : "";
  return `
    ${buildConnectedWalletScopeSql(userIdPlaceholder)},
    position_pnl as (
      select
        p.user_id,
        (${EFFECTIVE_PNL_SQL})::numeric as effective_pnl_usd,
        (case
          when p.side <> 'FLAT'
            and p.size > 0
            and not (${RESOLVED_MARKET_SQL})
            then (${UNREALIZED_PNL_COMPONENT_SQL})
          else 0
        end)::numeric as unresolved_unrealized_pnl_usd
      from positions p
      join wallet_scope ws
        on ws.user_id = p.user_id
       and ws.wallet_address = p.wallet_address
      ${POSITION_MARKET_JOIN_SQL}
      where p.position_scope = 'own'
        ${userFilter}
    ),
    pnl as (
      select
        user_id,
        coalesce(sum(effective_pnl_usd), 0)::numeric as pnl_usd,
        coalesce(
          sum(effective_pnl_usd - unresolved_unrealized_pnl_usd),
          0
        )::numeric as realized_pnl_usd,
        coalesce(sum(unresolved_unrealized_pnl_usd), 0)::numeric as unrealized_pnl_usd
      from position_pnl
      group by user_id
    )
  `;
}

async function fetchVolumeRank(
  pool: DbQuery,
  inputs: {
    value: number;
    startAt: Date | null;
    manualMode: RewardsManualFilterMode;
  },
): Promise<number> {
  const params: PgParams = [inputs.value];
  if (inputs.startAt) {
    params.push(inputs.startAt);
  }
  const createdAtParamIdx = inputs.startAt ? params.length : null;
  const whereClause = buildVolumeEventsCreatedAtClause("ve", createdAtParamIdx);

  const { rows } = await pool.query<{ higher: string | null }>(
    `
      with totals as (
        select
          ve.user_id,
          coalesce(sum(${buildVolumeContributionSql("ve", inputs.manualMode)}), 0)::numeric as volume_usd
        from volume_events ve
        ${whereClause}
        group by ve.user_id
      )
      select count(*)::text as higher
      from totals
      where volume_usd > $1
    `,
    params,
  );

  return Number(rows[0]?.higher ?? 0) + 1;
}

async function fetchPointsRank(
  pool: DbQuery,
  inputs: {
    value: number;
    startAt: Date | null;
    manualMode: RewardsManualFilterMode;
  },
): Promise<number> {
  const params: PgParams = [inputs.value];
  if (inputs.startAt) {
    params.push(inputs.startAt);
  }
  const createdAtParamIdx = inputs.startAt ? params.length : null;
  const whereClause = buildVolumeEventsCreatedAtClause("ve", createdAtParamIdx);

  const { rows } = await pool.query<{ higher: string | null }>(
    `
      with totals as (
        select
          ve.user_id,
          coalesce(sum(${buildPublicPointsContributionSql("ve")}), 0)::numeric as points
        from volume_events ve
        ${whereClause}
        group by ve.user_id
      )
      select count(*)::text as higher
      from totals
      where points > $1
    `,
    params,
  );

  return Number(rows[0]?.higher ?? 0) + 1;
}

async function fetchPnlRank(
  pool: DbQuery,
  inputs: { value: number },
): Promise<number> {
  const { rows } = await pool.query<{ higher: string | null }>(
    `
      with ${buildPnlCteSql()},
      totals as (
        select
          user_id,
          pnl_usd
        from pnl
      )
      select count(*)::text as higher
      from totals
      where pnl_usd > $1
    `,
    [inputs.value],
  );

  return Number(rows[0]?.higher ?? 0) + 1;
}

export async function fetchRewardsLeaderboardRows(
  pool: DbQuery,
  inputs: {
    metric: RewardsLeaderboardMetric;
    startAt: Date | null;
    limit: number;
    offset: number;
    manualMode: RewardsManualFilterMode;
  },
): Promise<RewardsLeaderboardAggregateRow[]> {
  if (inputs.metric === "pnl") {
    const params: PgParams = [inputs.limit, inputs.offset];
    const limitIdx = 1;
    const offsetIdx = 2;

    const { rows } = await pool.query<RewardsLeaderboardRowDb>(
      `
        with ${buildPnlCteSql()},
        totals as (
          select user_id,
                 coalesce(sum(${buildVolumeContributionSql("ve", inputs.manualMode)}), 0)::numeric as volume_usd,
                 coalesce(sum(${buildPublicPointsContributionSql("ve")}), 0)::numeric as points
          from volume_events ve
          group by user_id
        ),
        ranked as (
          select
            user_id,
            pnl_usd,
            realized_pnl_usd,
            unrealized_pnl_usd,
            dense_rank() over (order by pnl_usd desc) as rank
          from pnl
        ),
        page as (
          select *
          from ranked
          order by pnl_usd desc, user_id
          limit $${limitIdx} offset $${offsetIdx}
        )
        select
          r.user_id,
          r.rank,
          coalesce(t.volume_usd, 0)::text as volume_usd,
          coalesce(t.points, 0)::text as points,
          coalesce(tier_points.points, 0)::text as tier_points,
          r.pnl_usd::text as pnl_usd,
          r.realized_pnl_usd::text as realized_pnl_usd,
          r.unrealized_pnl_usd::text as unrealized_pnl_usd,
          u.display_name,
          u.username,
          primary_wallet.wallet_address
        from page r
        join users u on u.id = r.user_id
        left join totals t on t.user_id = r.user_id
        left join lateral (
          select coalesce(sum(${buildTierPointsContributionSql("ve")}), 0)::numeric as points
          from volume_events ve
          where ve.user_id = r.user_id
        ) tier_points on true
        left join lateral (
          select wallet_address
          from user_wallets
          where user_id = u.id
          order by is_primary desc, created_at asc
          limit 1
        ) primary_wallet on true
        order by r.pnl_usd desc, r.user_id
      `,
      params,
    );
    return rows.map(mapLeaderboardRow);
  }

  const metricColumn = inputs.metric === "points" ? "points" : "volume_usd";
  const params: PgParams = [];
  if (inputs.startAt) {
    params.push(inputs.startAt);
  }
  const createdAtParamIdx = inputs.startAt ? params.length : null;
  const whereClause = buildVolumeEventsCreatedAtClause("ve", createdAtParamIdx);
  params.push(inputs.limit);
  const limitIdx = params.length;
  params.push(inputs.offset);
  const offsetIdx = params.length;

  const { rows } = await pool.query<RewardsLeaderboardRowDb>(
    `
      with totals as (
        select ve.user_id,
               coalesce(sum(${buildVolumeContributionSql("ve", inputs.manualMode)}), 0)::numeric as volume_usd,
               coalesce(sum(${buildPublicPointsContributionSql("ve")}), 0)::numeric as points
        from volume_events ve
        ${whereClause}
        group by ve.user_id
      ),
      ${buildPnlCteSql()},
      ranked as (
        select
          user_id,
          volume_usd,
          points,
          dense_rank() over (order by ${metricColumn} desc) as rank
        from totals
      ),
      page as (
        select *
        from ranked
        order by ${metricColumn} desc, user_id
        limit $${limitIdx} offset $${offsetIdx}
      )
      select
        r.user_id,
        r.rank,
        r.volume_usd::text as volume_usd,
        r.points::text as points,
        coalesce(tier_points.points, 0)::text as tier_points,
        coalesce(p.pnl_usd, 0)::text as pnl_usd,
        coalesce(p.realized_pnl_usd, 0)::text as realized_pnl_usd,
        coalesce(p.unrealized_pnl_usd, 0)::text as unrealized_pnl_usd,
        u.display_name,
        u.username,
        primary_wallet.wallet_address
      from page r
      join users u on u.id = r.user_id
      left join lateral (
        select coalesce(sum(${buildTierPointsContributionSql("ve")}), 0)::numeric as points
        from volume_events ve
        where ve.user_id = r.user_id
      ) tier_points on true
      left join pnl p on p.user_id = r.user_id
      left join lateral (
        select wallet_address
        from user_wallets
        where user_id = u.id
        order by is_primary desc, created_at asc
        limit 1
        ) primary_wallet on true
      order by r.${metricColumn} desc, r.user_id
    `,
    params,
  );
  return rows.map(mapLeaderboardRow);
}

export async function fetchRewardsLeaderboardMe(
  pool: DbQuery,
  inputs: {
    userId: string;
    metric: RewardsLeaderboardMetric;
    startAt: Date | null;
    manualMode: RewardsManualFilterMode;
  },
): Promise<RewardsLeaderboardAggregateRow | null> {
  const params: PgParams = [inputs.userId];
  if (inputs.startAt) {
    params.push(inputs.startAt);
  }
  const createdAtParamIdx = inputs.startAt ? params.length : null;
  const totalsWhereClause = buildVolumeEventsCreatedAtClause(
    "ve",
    createdAtParamIdx,
    "and",
  );

  const { rows } = await pool.query<RewardsLeaderboardRowDb>(
    `
      with totals as (
        select ve.user_id,
               coalesce(sum(${buildVolumeContributionSql("ve", inputs.manualMode)}), 0)::numeric as volume_usd,
               coalesce(sum(${buildPublicPointsContributionSql("ve")}), 0)::numeric as points
        from volume_events ve
        where ve.user_id = $1
        ${totalsWhereClause}
        group by ve.user_id
      ),
      tier_totals as (
        select
          ve.user_id,
          coalesce(sum(${buildTierPointsContributionSql("ve")}), 0)::numeric as tier_points
        from volume_events ve
        where ve.user_id = $1
        group by ve.user_id
      ),
      ${buildPnlCteSql("$1")}
      select
        u.id as user_id,
        0 as rank,
        coalesce(t.volume_usd, 0)::text as volume_usd,
        coalesce(t.points, 0)::text as points,
        coalesce(tt.tier_points, 0)::text as tier_points,
        coalesce(p.pnl_usd, 0)::text as pnl_usd,
        coalesce(p.realized_pnl_usd, 0)::text as realized_pnl_usd,
        coalesce(p.unrealized_pnl_usd, 0)::text as unrealized_pnl_usd,
        u.display_name,
        u.username,
        primary_wallet.wallet_address
      from users u
      left join totals t on t.user_id = u.id
      left join tier_totals tt on tt.user_id = u.id
      left join pnl p on p.user_id = u.id
      left join lateral (
        select wallet_address
        from user_wallets
        where user_id = u.id
        order by is_primary desc, created_at asc
        limit 1
      ) primary_wallet on true
      where u.id = $1
      limit 1
    `,
    params,
  );

  const row = rows[0];
  if (!row) return null;

  const mapped = mapLeaderboardRow(row);
  const rank = await (async () => {
    if (inputs.metric === "pnl") {
      return fetchPnlRank(pool, { value: mapped.pnlUsd });
    }
    if (inputs.metric === "points") {
      return fetchPointsRank(pool, {
        value: mapped.points,
        startAt: inputs.startAt,
        manualMode: inputs.manualMode,
      });
    }
    return fetchVolumeRank(pool, {
      value: mapped.volumeUsd,
      startAt: inputs.startAt,
      manualMode: inputs.manualMode,
    });
  })();

  return { ...mapped, rank };
}
