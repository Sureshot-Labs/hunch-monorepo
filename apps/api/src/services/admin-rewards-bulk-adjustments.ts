import type { DbQuery } from "../db.js";
import {
  buildPublicPointsContributionSql,
  buildTierPointsContributionSql,
  HIDDEN_MANUAL_VOLUME_SOURCE_PREFIX,
  VISIBLE_MANUAL_VOLUME_SOURCE_PREFIX,
} from "../repos/rewards.js";
import type {
  AdminRewardsBulkAdjustmentExecuteBody,
  AdminRewardsBulkAdjustmentPreviewBody,
} from "../schemas/admin.js";
import { getRewardsPolicy } from "./rewards.js";

const BULK_ADJUSTMENT_PREVIEW_LIMIT = 200;
const ADMIN_REWARDS_BULK_ADJUSTMENT_MAX_ATTEMPTS = 3;

type BulkAdjustmentBody =
  | AdminRewardsBulkAdjustmentPreviewBody
  | AdminRewardsBulkAdjustmentExecuteBody;

type BulkAdjustmentTargetBasis = "tier_points" | "public_points";

type BulkAdjustmentUserRow = {
  id: string;
  email: string | null;
  username: string | null;
  display_name: string | null;
  created_at: Date;
  wallet_address: string | null;
  public_points_basis: string | null;
  tier_points_basis: string | null;
  existing_source_id: string | null;
};

type BulkAdjustmentEntry = {
  userId: string;
  email: string | null;
  username: string | null;
  displayName: string | null;
  walletAddress: string | null;
  createdAt: Date;
  publicPoints: number;
  tierPoints: number;
  grantAmount: number;
  resultingPublicPoints: number;
  resultingTierPoints: number;
  sourceId: string;
  hiddenSourceId: string;
  visibleSourceId: string;
  existing: boolean;
  skippedReason: "at_or_above_target" | null;
};

export class AdminRewardsBulkAdjustmentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminRewardsBulkAdjustmentInputError";
  }
}

export class AdminRewardsBulkAdjustmentRetryExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminRewardsBulkAdjustmentRetryExhaustedError";
  }
}

function getPgErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function isTransientBulkAdjustmentWriteConflict(error: unknown): boolean {
  const code = getPgErrorCode(error);
  return code === "40001" || code === "40P01";
}

export async function retryAdminRewardsBulkAdjustmentExecute<T>(
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown = null;
  for (
    let attempt = 1;
    attempt <= ADMIN_REWARDS_BULK_ADJUSTMENT_MAX_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientBulkAdjustmentWriteConflict(error)) {
        throw error;
      }
      lastError = error;
    }
  }

  throw new AdminRewardsBulkAdjustmentRetryExhaustedError(
    lastError instanceof Error
      ? `Bulk adjustment conflicted after retries: ${lastError.message}`
      : "Bulk adjustment conflicted after retries",
  );
}

export type AdminRewardsBulkAdjustmentResult = {
  ok: true;
  runKey: string;
  mode: BulkAdjustmentBody["mode"];
  visibility: BulkAdjustmentBody["visibility"];
  targetBasis: BulkAdjustmentTargetBasis;
  targetPoints: number | null;
  targetTier: number | null;
  warnings: string[];
  summary: {
    matched: number;
    eligible: number;
    inserted: number;
    alreadyExisting: number;
    skipped: number;
    totalPoints: number;
    insertedPoints: number;
  };
  items: Array<{
    userId: string;
    email: string | null;
    username: string | null;
    displayName: string | null;
    walletAddress: string | null;
    createdAt: Date;
    publicPoints: number;
    tierPoints: number;
    grantAmount: number;
    resultingPublicPoints: number;
    resultingTierPoints: number;
    sourceId: string;
    existing: boolean;
    skippedReason: "at_or_above_target" | null;
  }>;
  itemLimit: number;
  hasMoreItems: boolean;
};

function buildBulkSourcePrefixes(runKey: string): {
  hidden: string;
  visible: string;
} {
  return {
    hidden: `${HIDDEN_MANUAL_VOLUME_SOURCE_PREFIX}bulk:${runKey}:`,
    visible: `${VISIBLE_MANUAL_VOLUME_SOURCE_PREFIX}bulk:${runKey}:`,
  };
}

function buildBulkSourcePrefix(input: BulkAdjustmentBody): string {
  const prefixes = buildBulkSourcePrefixes(input.runKey);
  return input.visibility === "visible" ? prefixes.visible : prefixes.hidden;
}

function buildBulkSourceIds(input: { runKey: string; userId: string }): {
  hidden: string;
  visible: string;
} {
  const prefixes = buildBulkSourcePrefixes(input.runKey);
  return {
    hidden: `${prefixes.hidden}${input.userId}`,
    visible: `${prefixes.visible}${input.userId}`,
  };
}

function roundPoints(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}

async function resolveBulkAdjustmentTarget(
  db: DbQuery,
  input: BulkAdjustmentBody,
): Promise<{
  targetBasis: BulkAdjustmentTargetBasis;
  targetPoints: number | null;
  targetTier: number | null;
}> {
  if (input.mode === "fixed_amount") {
    return {
      targetBasis: "tier_points",
      targetPoints: null,
      targetTier: null,
    };
  }

  if (input.mode === "top_up_to_points") {
    return {
      targetBasis: input.targetBasis ?? "tier_points",
      targetPoints: input.targetPoints ?? null,
      targetTier: null,
    };
  }

  const policy = await getRewardsPolicy(db);
  const target = policy.tiers.find((tier) => tier.tier === input.targetTier);
  if (!target) {
    throw new AdminRewardsBulkAdjustmentInputError(
      `Rewards tier ${input.targetTier} not found`,
    );
  }

  return {
    targetBasis: "tier_points",
    targetPoints: target.points,
    targetTier: target.tier,
  };
}

async function fetchBulkAdjustmentUsers(
  db: DbQuery,
  input: BulkAdjustmentBody,
): Promise<BulkAdjustmentUserRow[]> {
  const sourcePrefixes = buildBulkSourcePrefixes(input.runKey);
  const createdBefore = new Date(input.cohort.createdBefore);
  const params: unknown[] = [
    sourcePrefixes.hidden,
    sourcePrefixes.visible,
    createdBefore,
  ];
  const whereParts = ["u.created_at <= $3"];

  if (input.cohort.activeOnly) {
    whereParts.push("coalesce(u.is_active, true) = true");
  }

  if (input.cohort.excludeAdmins) {
    whereParts.push("coalesce(u.is_admin, false) = false");
  }

  if (input.cohort.requireWallet) {
    whereParts.push(`
      exists (
        select 1
        from user_wallets required_wallet
        where required_wallet.user_id = u.id
      )
    `);
  }

  const { rows } = await db.query<BulkAdjustmentUserRow>(
    `
      select
        u.id,
        u.email,
        u.username,
        u.display_name,
        u.created_at,
        primary_wallet.wallet_address,
        points.public_points_basis::text as public_points_basis,
        points.tier_points_basis::text as tier_points_basis,
        existing.source_id as existing_source_id
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
          coalesce(
            sum(
              case
                when ve.source_id not in (
                  ($1 || u.id::text),
                  ($2 || u.id::text)
                )
                  then ${buildPublicPointsContributionSql("ve")}
                else 0
              end
            ),
            0
          ) as public_points_basis,
          coalesce(
            sum(
              case
                when ve.source_id not in (
                  ($1 || u.id::text),
                  ($2 || u.id::text)
                )
                  then ${buildTierPointsContributionSql("ve")}
                else 0
              end
            ),
            0
          ) as tier_points_basis
        from volume_events ve
        where ve.user_id = u.id
      ) points on true
      left join lateral (
        select source_id
        from volume_events existing
        where existing.user_id = u.id
          and existing.source_type = 'execution'
          and existing.source_id in (
            ($1 || u.id::text),
            ($2 || u.id::text)
          )
        order by source_id asc
        limit 1
      ) existing on true
      where ${whereParts.join(" and ")}
      order by u.created_at asc, u.id asc
    `,
    params,
  );

  return rows;
}

function computeGrantAmount(input: {
  body: BulkAdjustmentBody;
  publicPoints: number;
  targetBasis: BulkAdjustmentTargetBasis;
  targetPoints: number | null;
  tierPoints: number;
}): { amount: number; skippedReason: "at_or_above_target" | null } {
  if (input.body.mode === "fixed_amount") {
    return { amount: roundPoints(input.body.amount ?? 0), skippedReason: null };
  }

  const current =
    input.targetBasis === "public_points"
      ? input.publicPoints
      : input.tierPoints;
  const target = input.targetPoints ?? 0;
  const amount = roundPoints(Math.max(0, target - current));
  return {
    amount,
    skippedReason: amount > 0 ? null : "at_or_above_target",
  };
}

function buildWarnings(input: {
  body: BulkAdjustmentBody;
  targetBasis: BulkAdjustmentTargetBasis;
}): string[] {
  if (
    input.body.visibility === "visible" &&
    input.targetBasis === "tier_points"
  ) {
    return ["Visible tier-point grants also increase public points."];
  }
  return [];
}

function buildResult(input: {
  body: BulkAdjustmentBody;
  entries: BulkAdjustmentEntry[];
  inserted: number;
  insertedPoints: number;
  targetBasis: BulkAdjustmentTargetBasis;
  targetPoints: number | null;
  targetTier: number | null;
}): AdminRewardsBulkAdjustmentResult {
  const eligibleEntries = input.entries.filter(
    (entry) => entry.grantAmount > 0,
  );
  const alreadyExisting = eligibleEntries.filter((entry) => entry.existing);
  const totalPoints = roundPoints(
    eligibleEntries.reduce((total, entry) => total + entry.grantAmount, 0),
  );
  const items = input.entries
    .slice(0, BULK_ADJUSTMENT_PREVIEW_LIMIT)
    .map((entry) => ({
      userId: entry.userId,
      email: entry.email,
      username: entry.username,
      displayName: entry.displayName,
      walletAddress: entry.walletAddress,
      createdAt: entry.createdAt,
      publicPoints: entry.publicPoints,
      tierPoints: entry.tierPoints,
      grantAmount: entry.grantAmount,
      resultingPublicPoints: entry.resultingPublicPoints,
      resultingTierPoints: entry.resultingTierPoints,
      sourceId: entry.sourceId,
      existing: entry.existing,
      skippedReason: entry.skippedReason,
    }));

  return {
    ok: true,
    runKey: input.body.runKey,
    mode: input.body.mode,
    visibility: input.body.visibility,
    targetBasis: input.targetBasis,
    targetPoints: input.targetPoints,
    targetTier: input.targetTier,
    warnings: buildWarnings({
      body: input.body,
      targetBasis: input.targetBasis,
    }),
    summary: {
      matched: input.entries.length,
      eligible: eligibleEntries.length,
      inserted: input.inserted,
      alreadyExisting:
        input.inserted > 0
          ? Math.max(0, eligibleEntries.length - input.inserted)
          : alreadyExisting.length,
      skipped: input.entries.length - eligibleEntries.length,
      totalPoints,
      insertedPoints: roundPoints(input.insertedPoints),
    },
    items,
    itemLimit: BULK_ADJUSTMENT_PREVIEW_LIMIT,
    hasMoreItems: input.entries.length > BULK_ADJUSTMENT_PREVIEW_LIMIT,
  };
}

async function buildBulkAdjustmentEntries(
  db: DbQuery,
  input: BulkAdjustmentBody,
): Promise<{
  entries: BulkAdjustmentEntry[];
  targetBasis: BulkAdjustmentTargetBasis;
  targetPoints: number | null;
  targetTier: number | null;
}> {
  const target = await resolveBulkAdjustmentTarget(db, input);
  const sourcePrefix = buildBulkSourcePrefix(input);
  const rows = await fetchBulkAdjustmentUsers(db, input);

  const entries = rows.map((row) => {
    const publicPoints = Number(row.public_points_basis ?? 0);
    const tierPoints = Number(row.tier_points_basis ?? 0);
    const grant = computeGrantAmount({
      body: input,
      publicPoints,
      targetBasis: target.targetBasis,
      targetPoints: target.targetPoints,
      tierPoints,
    });
    const sourceIds = buildBulkSourceIds({
      runKey: input.runKey,
      userId: row.id,
    });
    const sourceId = `${sourcePrefix}${row.id}`;
    return {
      userId: row.id,
      email: row.email,
      username: row.username,
      displayName: row.display_name,
      walletAddress: row.wallet_address,
      createdAt: row.created_at,
      publicPoints,
      tierPoints,
      grantAmount: grant.amount,
      resultingPublicPoints: roundPoints(
        publicPoints + (input.visibility === "visible" ? grant.amount : 0),
      ),
      resultingTierPoints: roundPoints(tierPoints + grant.amount),
      sourceId,
      hiddenSourceId: sourceIds.hidden,
      visibleSourceId: sourceIds.visible,
      existing: Boolean(row.existing_source_id),
      skippedReason: grant.skippedReason,
    };
  });

  return {
    entries,
    targetBasis: target.targetBasis,
    targetPoints: target.targetPoints,
    targetTier: target.targetTier,
  };
}

export async function previewAdminRewardsBulkAdjustment(
  db: DbQuery,
  input: AdminRewardsBulkAdjustmentPreviewBody,
): Promise<AdminRewardsBulkAdjustmentResult> {
  const built = await buildBulkAdjustmentEntries(db, input);
  return buildResult({
    body: input,
    entries: built.entries,
    inserted: 0,
    insertedPoints: 0,
    targetBasis: built.targetBasis,
    targetPoints: built.targetPoints,
    targetTier: built.targetTier,
  });
}

export async function executeAdminRewardsBulkAdjustment(
  db: DbQuery,
  input: AdminRewardsBulkAdjustmentExecuteBody,
): Promise<AdminRewardsBulkAdjustmentResult> {
  await db.query("set transaction isolation level serializable");
  await db.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
    `admin-rewards-bulk-adjustment:${input.runKey}`,
  ]);
  const built = await buildBulkAdjustmentEntries(db, input);
  const insertInputs = built.entries
    .filter((entry) => entry.grantAmount > 0)
    .map((entry) => ({
      user_id: entry.userId,
      wallet_address: entry.walletAddress,
      source_id: entry.sourceId,
      hidden_source_id: entry.hiddenSourceId,
      visible_source_id: entry.visibleSourceId,
      points: entry.grantAmount,
    }));

  let inserted = 0;
  let insertedPoints = 0;
  if (insertInputs.length > 0) {
    const { rows } = await db.query<{
      inserted: string | number;
      inserted_points: string | null;
    }>(
      `
        with input_rows as (
          select *
          from jsonb_to_recordset($1::jsonb) as x(
            user_id uuid,
            wallet_address text,
            source_id text,
            hidden_source_id text,
            visible_source_id text,
            points numeric
          )
        ),
        inserted_rows as (
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
          select
            gen_random_uuid(),
            input_rows.user_id,
            input_rows.wallet_address,
            'admin',
            'execution',
            input_rows.source_id,
            input_rows.points,
            1,
            input_rows.points,
            'user',
            now()
          from input_rows
          where not exists (
            select 1
            from volume_events existing
            where existing.user_id = input_rows.user_id
              and existing.source_type = 'execution'
              and existing.source_id in (
                input_rows.hidden_source_id,
                input_rows.visible_source_id
              )
          )
          on conflict (user_id, source_type, source_id) do nothing
          returning points_awarded
        )
        select
          count(*)::text as inserted,
          coalesce(sum(points_awarded), 0)::text as inserted_points
        from inserted_rows
      `,
      [JSON.stringify(insertInputs)],
    );
    inserted = Number(rows[0]?.inserted ?? 0);
    insertedPoints = Number(rows[0]?.inserted_points ?? 0);
  }

  return buildResult({
    body: input,
    entries: built.entries,
    inserted,
    insertedPoints,
    targetBasis: built.targetBasis,
    targetPoints: built.targetPoints,
    targetTier: built.targetTier,
  });
}
