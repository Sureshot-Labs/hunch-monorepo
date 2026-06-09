export const ADMIN_USERS_SORT_BY_VALUES = [
  "createdAt",
  "feeUsdCollected",
  "feeUsdTotal",
  "points",
  "rawPoints",
  "tierPoints",
  "qualificationPoints",
  "volumeUsd",
] as const;

export const ADMIN_USERS_SORT_DIR_VALUES = ["asc", "desc"] as const;

export type AdminUsersSortBy = (typeof ADMIN_USERS_SORT_BY_VALUES)[number];
export type AdminUsersSortDir = (typeof ADMIN_USERS_SORT_DIR_VALUES)[number];

export type AdminUsersSortPlan = {
  cursorKind: "createdAt" | "metric";
  cursorOperator: "<" | ">" | null;
  metricSql: string | null;
  orderBySql: string;
  supportsCursor: boolean;
};

const METRIC_SORT_SQL: Record<Exclude<AdminUsersSortBy, "createdAt">, string> =
  {
    feeUsdCollected: "fees.collected_fee_usd::numeric",
    feeUsdTotal: "fees.total_fee_usd::numeric",
    points: "points.public_points::numeric",
    rawPoints: "points.raw_points::numeric",
    tierPoints: "points.tier_points::numeric",
    qualificationPoints: "points.qualification_points::numeric",
    volumeUsd: "points.volume_usd::numeric",
  };

export function buildAdminUsersSortPlan(
  sortBy: AdminUsersSortBy,
  sortDir: AdminUsersSortDir,
): AdminUsersSortPlan {
  if (sortBy === "createdAt") {
    return {
      cursorKind: "createdAt",
      cursorOperator: sortDir === "asc" ? ">" : "<",
      metricSql: null,
      orderBySql: `u.created_at ${sortDir}, u.id ${sortDir}`,
      supportsCursor: true,
    };
  }

  const expression = METRIC_SORT_SQL[sortBy];
  return {
    cursorKind: "metric",
    cursorOperator: sortDir === "asc" ? ">" : "<",
    metricSql: expression,
    orderBySql: `${expression} ${sortDir} nulls last, u.id desc`,
    supportsCursor: true,
  };
}
