import type { DbQuery } from "../db.js";
import {
  buildPublicPointsContributionSql,
  buildQualificationPointsContributionSql,
  buildTierPointsContributionSql,
  buildVolumeContributionSql,
} from "../repos/rewards.js";
import type { AdminUsersQuery } from "../schemas/admin.js";
import {
  ADMIN_USERS_SORT_BY_VALUES,
  ADMIN_USERS_SORT_DIR_VALUES,
  buildAdminUsersSortPlan,
  type AdminUsersSortBy,
  type AdminUsersSortDir,
} from "./admin-users-sort.js";

type AdminKeysetCursor = {
  kind: "createdAt";
  createdAt: Date;
  id: string;
};

type AdminMetricCursor = {
  kind: "metric";
  sortBy: AdminUsersSortBy;
  sortDir: AdminUsersSortDir;
  value: number;
  id: string;
};

type AdminDecodedCursor = AdminKeysetCursor | AdminMetricCursor;

type AdminCursorRow = {
  id: string;
  created_at: Date;
};

type AdminUsersRow = AdminCursorRow & {
  email: string | null;
  username: string | null;
  display_name: string | null;
  is_admin: boolean | null;
  kalshi_proof_bypass: boolean | null;
  is_active: boolean | null;
  last_login_at: Date | null;
  referral_code: string | null;
  wallet_address: string | null;
  points: string | null;
  tier_points: string | null;
  qualification_points: string | null;
  raw_points: string | null;
  fee_usd_total: string | null;
  fee_usd_collected: string | null;
  volume_usd: string | null;
  referral_count: string | null;
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

type AdminUserListItem = {
  id: string;
  email: string | null;
  username: string | null;
  displayName: string | null;
  isAdmin: boolean;
  kalshiProofBypass: boolean;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  referralCode: string | null;
  walletAddress: string | null;
  points: number;
  tierPoints: number;
  qualificationPoints: number;
  rawPoints: number;
  feeUsdTotal: number;
  feeUsdCollected: number;
  volumeUsd: number;
  referralCount: number;
  inboundReferral: {
    code: string;
    policyType: "user" | "campaign" | null;
    label: string | null;
    multiplierOverride: number | null;
    ownerUserId: string | null;
    referrerUserId: string | null;
    referrerEmail: string | null;
    referrerUsername: string | null;
    referrerDisplayName: string | null;
    referrerWalletAddress: string | null;
    attachedAt: string | null;
  } | null;
};

export type AdminUsersListResult =
  | {
      ok: true;
      users: AdminUserListItem[];
      total: number;
      limit: number;
      offset: number;
      hasMore: boolean;
      nextCursor: string | null;
    }
  | {
      ok: false;
      statusCode: 400;
      error: string;
    };

function decodeAdminUsersCursor(encoded: string | undefined): {
  cursor: AdminDecodedCursor | null;
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
    if (typeof idValue !== "string" || !idValue.trim()) {
      return { cursor: null, error: "Invalid cursor" };
    }

    if (typeof createdAtValue === "string") {
      const createdAt = new Date(createdAtValue);
      if (!Number.isFinite(createdAt.getTime())) {
        return { cursor: null, error: "Invalid cursor" };
      }
      return {
        cursor: { kind: "createdAt", createdAt, id: idValue },
        error: null,
      };
    }

    const sortByValue = record.sortBy;
    const sortDirValue = record.sortDir;
    const metricValue = record.value;
    if (
      typeof sortByValue !== "string" ||
      typeof sortDirValue !== "string" ||
      typeof metricValue !== "number" ||
      !Number.isFinite(metricValue) ||
      !ADMIN_USERS_SORT_BY_VALUES.includes(sortByValue as AdminUsersSortBy) ||
      !ADMIN_USERS_SORT_DIR_VALUES.includes(sortDirValue as AdminUsersSortDir) ||
      sortByValue === "createdAt"
    ) {
      return { cursor: null, error: "Invalid cursor" };
    }

    return {
      cursor: {
        kind: "metric",
        sortBy: sortByValue as AdminUsersSortBy,
        sortDir: sortDirValue as AdminUsersSortDir,
        value: metricValue,
        id: idValue,
      },
      error: null,
    };
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

function adminMetricValue(row: AdminUsersRow, sortBy: AdminUsersSortBy): number {
  switch (sortBy) {
    case "feeUsdCollected":
      return Number(row.fee_usd_collected ?? 0);
    case "feeUsdTotal":
      return Number(row.fee_usd_total ?? 0);
    case "points":
      return Number(row.points ?? 0);
    case "rawPoints":
      return Number(row.raw_points ?? 0);
    case "tierPoints":
      return Number(row.tier_points ?? 0);
    case "qualificationPoints":
      return Number(row.qualification_points ?? 0);
    case "volumeUsd":
      return Number(row.volume_usd ?? 0);
    case "createdAt":
      return 0;
  }
}

function encodeAdminMetricCursor(
  row: AdminUsersRow,
  sortBy: AdminUsersSortBy,
  sortDir: AdminUsersSortDir,
): string {
  return Buffer.from(
    JSON.stringify({
      sortBy,
      sortDir,
      value: adminMetricValue(row, sortBy),
      id: row.id,
    }),
    "utf8",
  ).toString("base64url");
}

function buildAdminCursorPage<T extends AdminCursorRow>(
  rows: T[],
  limit: number,
  encodeCursor: (row: T) => string = encodeAdminKeysetCursor,
) {
  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const nextCursor =
    hasMore && items.length
      ? encodeCursor(items[items.length - 1])
      : null;
  return { hasMore, items, nextCursor };
}

function mapAdminUserRow(row: AdminUsersRow): AdminUserListItem {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    displayName: row.display_name,
    isAdmin: Boolean(row.is_admin),
    kalshiProofBypass: Boolean(row.kalshi_proof_bypass),
    isActive: row.is_active ?? true,
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    referralCode: row.referral_code,
    walletAddress: row.wallet_address ?? null,
    points: Number(row.points ?? 0),
    tierPoints: Number(row.tier_points ?? 0),
    qualificationPoints: Number(row.qualification_points ?? 0),
    rawPoints: Number(row.raw_points ?? 0),
    feeUsdTotal: Number(row.fee_usd_total ?? 0),
    feeUsdCollected: Number(row.fee_usd_collected ?? 0),
    volumeUsd: Number(row.volume_usd ?? 0),
    referralCount: Number(row.referral_count ?? 0),
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
          attachedAt: row.inbound_referral_attached_at?.toISOString() ?? null,
        }
      : null,
  };
}

export async function listAdminUsers(
  db: DbQuery,
  query: AdminUsersQuery,
): Promise<AdminUsersListResult> {
  const q = query.q?.trim();
  const limit = query.limit ?? 25;
  const offset = query.offset ?? 0;
  const sortBy = (query.sortBy ?? "createdAt") as AdminUsersSortBy;
  const sortDir = (query.sortDir ?? "desc") as AdminUsersSortDir;
  const sortPlan = buildAdminUsersSortPlan(sortBy, sortDir);
  const decodedCursor = decodeAdminUsersCursor(query.cursor);
  if (decodedCursor.error) {
    return {
      ok: false,
      statusCode: 400,
      error: decodedCursor.error,
    };
  }
  const cursor = decodedCursor.cursor;
  if (cursor?.kind === "createdAt" && sortBy !== "createdAt") {
    return {
      ok: false,
      statusCode: 400,
      error: "Cursor sort does not match request sort",
    };
  }
  if (
    cursor?.kind === "metric" &&
    (cursor.sortBy !== sortBy || cursor.sortDir !== sortDir)
  ) {
    return {
      ok: false,
      statusCode: 400,
      error: "Cursor sort does not match request sort",
    };
  }

  const filterConditions: string[] = [];
  const filterParams: Array<string | number> = [];

  if (q) {
    filterParams.push(q);
    const idx = filterParams.length;
    const walletSubstringPredicate =
      q.length >= 6
        ? `
                  or wq.wallet_address ilike '%' || $${idx} || '%'
                `
        : "";
    const venueCredentialSubstringPredicate =
      q.length >= 6
        ? `
                    or vcq.wallet_address ilike '%' || $${idx} || '%'
                    or vcq.funder_address ilike '%' || $${idx} || '%'
                `
        : "";
    filterConditions.push(
      `
            (
              u.id::text = $${idx}
              or u.email ilike '%' || $${idx} || '%'
              or u.username ilike '%' || $${idx} || '%'
              or u.display_name ilike '%' || $${idx} || '%'
              or u.referral_code ilike '%' || $${idx} || '%'
              or exists (
                select 1
                from referral_codes rcq
                join referral_code_policies pq
                  on pq.id = rcq.policy_id
                where pq.owner_user_id = u.id
                  and (
                    rcq.code ilike '%' || $${idx} || '%'
                    or pq.label ilike '%' || $${idx} || '%'
                  )
              )
              or exists (
                select 1
                from user_wallets wq
                where wq.user_id = u.id
                  and (
                    lower(wq.wallet_address) = lower($${idx})
                    or wq.wallet_address = $${idx}
                    ${walletSubstringPredicate}
                  )
              )
              or exists (
                select 1
                from user_venue_credentials vcq
                where vcq.user_id = u.id
                  and (
                    lower(vcq.wallet_address) = lower($${idx})
                    or lower(vcq.funder_address) = lower($${idx})
                    ${venueCredentialSubstringPredicate}
                  )
              )
            )
          `,
    );
  }

  const countWhereClause = filterConditions.length
    ? `where ${filterConditions.join(" and ")}`
    : "";

  const { rows: countRows } = await db.query<{ total: string }>(
    `
          select count(*)::text as total
          from users u
          ${countWhereClause}
        `,
    filterParams,
  );

  const dataConditions = [...filterConditions];
  const params: Array<string | number | Date> = [...filterParams];
  if (cursor?.kind === "createdAt") {
    params.push(cursor.createdAt);
    const cursorCreatedAtIdx = params.length;
    params.push(cursor.id);
    const cursorIdIdx = params.length;
    const cursorOperator = sortPlan.cursorOperator ?? "<";
    dataConditions.push(
      `(u.created_at, u.id) ${cursorOperator} ($${cursorCreatedAtIdx}, $${cursorIdIdx})`,
    );
  } else if (cursor?.kind === "metric" && sortPlan.metricSql) {
    params.push(cursor.value);
    const cursorValueIdx = params.length;
    params.push(cursor.id);
    const cursorIdIdx = params.length;
    const cursorOperator = sortPlan.cursorOperator ?? "<";
    dataConditions.push(
      `(${sortPlan.metricSql} ${cursorOperator} $${cursorValueIdx} or (${sortPlan.metricSql} = $${cursorValueIdx} and u.id < $${cursorIdIdx}))`,
    );
  }

  const whereClause = dataConditions.length
    ? `where ${dataConditions.join(" and ")}`
    : "";

  params.push(limit + 1);
  const limitIdx = params.length;
  let offsetSql = "";
  if (!cursor) {
    params.push(offset);
    const offsetIdx = params.length;
    offsetSql = `offset $${offsetIdx}`;
  }

  const { rows } = await db.query<AdminUsersRow>(
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
            u.referral_code,
            primary_wallet.wallet_address,
            points.public_points as points,
            points.tier_points,
            points.qualification_points,
            points.raw_points,
            fees.total_fee_usd as fee_usd_total,
            fees.collected_fee_usd as fee_usd_collected,
            points.volume_usd,
            refs.referral_count,
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
              coalesce(sum(${buildPublicPointsContributionSql("ve")}), 0)::text as public_points,
              coalesce(sum(${buildTierPointsContributionSql("ve")}), 0)::text as tier_points,
              coalesce(sum(${buildQualificationPointsContributionSql("ve")}), 0)::text as qualification_points,
              coalesce(sum(ve.points_awarded), 0)::text as raw_points,
              coalesce(sum(${buildVolumeContributionSql("ve")}), 0)::text as volume_usd
            from volume_events ve
            where ve.user_id = u.id
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
          ${whereClause}
          order by ${sortPlan.orderBySql}
          limit $${limitIdx}
          ${offsetSql}
        `,
    params,
  );
  const page = buildAdminCursorPage(rows, limit, (row) =>
    sortBy === "createdAt"
      ? encodeAdminKeysetCursor(row)
      : encodeAdminMetricCursor(row, sortBy, sortDir),
  );

  return {
    ok: true,
    users: page.items.map(mapAdminUserRow),
    total: Number(countRows[0]?.total ?? 0),
    limit,
    offset,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
  };
}
