import { tx } from "@hunch/infra";
import type { Pool, PoolClient } from "pg";
import { REWARDS_REFERRAL_QUALIFICATION_POINTS } from "../lib/rewards-referral-policy.js";
import { acquireRewardsUserAdvisoryXactLock } from "../lib/rewards-user-lock.js";
import {
  buildQualificationPointsContributionSql,
  buildTierPointsContributionSql,
  fetchReferralCodeMultiplierContextForUser,
} from "../repos/rewards.js";

type MultiplierQueryable = Pick<PoolClient, "query">;

export type RewardsMultiplierSource =
  | "global"
  | "user"
  | "referral"
  | "tier"
  | "referral_code";

type VolumeEventInsertInput = {
  userId: string;
  walletAddress: string | null;
  venue: string;
  sourceType: "order" | "execution";
  sourceId: string;
  notionalUsd: number;
  createdAt: Date;
};

export type ResolvedRewardsMultiplier = {
  multiplierApplied: number;
  multiplierSource: RewardsMultiplierSource;
  label?: string | null;
  referralCodeContext?: {
    code: string;
    label: string | null;
    policyType: "user" | "campaign";
  } | null;
};

type BatchInsertInput = {
  userId: string;
  walletAddress: string | null;
  venue: string;
  sourceType: "order" | "execution";
  events: Array<{
    sourceId: string;
    notionalUsd: number;
    createdAt: Date;
  }>;
};

function safePositiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseRuleMin(
  raw: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const value = raw[key];
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function parseRuleMultiplier(raw: Record<string, unknown>): number | null {
  const parsed = Number(raw.multiplier);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function resolveRulesMaxMultiplier(
  rawRules: unknown,
  value: number,
  minKeys: string[],
): number {
  if (!Array.isArray(rawRules)) return 1;
  let resolved = 1;
  for (const raw of rawRules) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const min = parseRuleMin(record, minKeys);
    const multiplier = parseRuleMultiplier(record);
    if (min == null || multiplier == null) continue;
    if (value >= min && multiplier > resolved) {
      resolved = multiplier;
    }
  }
  return resolved;
}

async function fetchTierPointsAtEvent(
  client: MultiplierQueryable,
  userId: string,
  eventTime: Date,
): Promise<number> {
  const { rows } = await client.query<{ total: string | null }>(
    `
      select coalesce(sum(${buildTierPointsContributionSql("ve")}), 0)::text as total
      from volume_events ve
      where ve.user_id = $1
        and ve.created_at <= $2
    `,
    [userId, eventTime],
  );
  return Number(rows[0]?.total ?? 0);
}

async function fetchQualificationPointsAtEvent(
  client: MultiplierQueryable,
  userId: string,
  eventTime: Date,
): Promise<number> {
  const { rows } = await client.query<{ total: string | null }>(
    `
      select coalesce(sum(${buildQualificationPointsContributionSql("ve")}), 0)::text as total
      from volume_events ve
      where ve.user_id = $1
        and ve.created_at <= $2
    `,
    [userId, eventTime],
  );
  return Number(rows[0]?.total ?? 0);
}

async function fetchQualifiedReferralCountAtEvent(
  client: MultiplierQueryable,
  userId: string,
  eventTime: Date,
  referrerQualificationPointsAtEvent: number,
): Promise<number> {
  if (
    referrerQualificationPointsAtEvent < REWARDS_REFERRAL_QUALIFICATION_POINTS
  ) {
    return 0;
  }

  const { rows } = await client.query<{ total: string | null }>(
    `
      with referred_points as (
        select
          ve.user_id,
          coalesce(sum(${buildQualificationPointsContributionSql("ve")}), 0)::numeric as points
        from volume_events ve
        where ve.created_at <= $2
        group by ve.user_id
      )
      select count(*)::text as total
      from referrals r
      left join referred_points rp
        on rp.user_id = r.referred_user_id
      where r.referrer_user_id = $1
        and r.created_at <= $2
        and r.status <> 'blocked'
        and coalesce(rp.points, 0) >= $3
    `,
    [userId, eventTime, REWARDS_REFERRAL_QUALIFICATION_POINTS],
  );
  return Number(rows[0]?.total ?? 0);
}

async function fetchUserOverrideMultiplier(
  client: MultiplierQueryable,
  userId: string,
  eventTime: Date,
): Promise<{ multiplier: number; label: string | null } | null> {
  const { rows } = await client.query<{
    multiplier: string | null;
    label: string | null;
  }>(
    `
      select
        multiplier::text as multiplier,
        label
      from rewards_multiplier_user_overrides
      where user_id = $1
        and effective_at <= $2
        and (expires_at is null or expires_at > $2)
      order by effective_at desc, created_at desc
      limit 1
    `,
    [userId, eventTime],
  );
  const raw = rows[0]?.multiplier;
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return {
    multiplier: parsed,
    label: rows[0]?.label?.trim() || null,
  };
}

export async function resolveRewardsMultiplierAtEvent(
  client: MultiplierQueryable,
  inputs: { userId: string; eventTime: Date },
): Promise<ResolvedRewardsMultiplier> {
  const overrideMultiplier = await fetchUserOverrideMultiplier(
    client,
    inputs.userId,
    inputs.eventTime,
  );
  if (overrideMultiplier != null) {
    return {
      multiplierApplied: overrideMultiplier.multiplier,
      multiplierSource: "user",
      label: overrideMultiplier.label,
    };
  }

  const policyRows = await client.query<{
    global_multiplier: string | null;
    global_multiplier_label: string | null;
    referral_rules: unknown;
    tier_rules: unknown;
  }>(
    `
      select
        global_multiplier::text as global_multiplier,
        global_multiplier_label,
        referral_rules,
        tier_rules
      from rewards_multiplier_policy
      where effective_at <= $1
      order by effective_at desc
      limit 1
    `,
    [inputs.eventTime],
  );

  const policy = policyRows.rows[0];
  const globalMultiplier = safePositiveNumber(policy?.global_multiplier, 1);
  const [tierPointsAtEvent, qualificationPointsAtEvent] = await Promise.all([
    fetchTierPointsAtEvent(client, inputs.userId, inputs.eventTime),
    fetchQualificationPointsAtEvent(client, inputs.userId, inputs.eventTime),
  ]);
  const qualifiedReferrals = await fetchQualifiedReferralCountAtEvent(
    client,
    inputs.userId,
    inputs.eventTime,
    qualificationPointsAtEvent,
  );

  const referralMultiplier = resolveRulesMaxMultiplier(
    policy?.referral_rules ?? [],
    qualifiedReferrals,
    [
      "minReferrals",
      "minQualifiedReferrals",
      "min_referrals",
      "min_qualified_referrals",
    ],
  );
  const tierMultiplier = resolveRulesMaxMultiplier(
    policy?.tier_rules ?? [],
    tierPointsAtEvent,
    ["minPoints", "min_points"],
  );
  const referralCodeContext = await fetchReferralCodeMultiplierContextForUser(
    client,
    {
      userId: inputs.userId,
      eventTime: inputs.eventTime,
    },
  );
  const referralCodeMultiplier =
    referralCodeContext?.multiplier_override == null
      ? null
      : safePositiveNumber(referralCodeContext.multiplier_override, 0);

  const isAllEqual =
    referralCodeMultiplier == null &&
    Math.abs(globalMultiplier - referralMultiplier) < 1e-12 &&
    Math.abs(globalMultiplier - tierMultiplier) < 1e-12;
  if (isAllEqual) {
    return {
      multiplierApplied: globalMultiplier,
      multiplierSource: "global",
      label: policy?.global_multiplier_label?.trim() || null,
    };
  }

  const maxMultiplier = Math.max(
    globalMultiplier,
    referralMultiplier,
    tierMultiplier,
    referralCodeMultiplier ?? 0,
  );
  if (
    referralCodeMultiplier != null &&
    Math.abs(referralCodeMultiplier - maxMultiplier) < 1e-12
  ) {
    const context = referralCodeContext;
    if (!context) {
      throw new Error("Missing referral code multiplier context");
    }
    return {
      multiplierApplied: referralCodeMultiplier,
      multiplierSource: "referral_code",
      label: context.label?.trim() || null,
      referralCodeContext: {
        code: context.code,
        label: context.label,
        policyType: context.policy_type,
      },
    };
  }
  if (Math.abs(referralMultiplier - maxMultiplier) < 1e-12) {
    return {
      multiplierApplied: referralMultiplier,
      multiplierSource: "referral",
      label: null,
    };
  }
  if (Math.abs(tierMultiplier - maxMultiplier) < 1e-12) {
    return {
      multiplierApplied: tierMultiplier,
      multiplierSource: "tier",
      label: null,
    };
  }
  return {
    multiplierApplied: globalMultiplier,
    multiplierSource: "global",
    label: policy?.global_multiplier_label?.trim() || null,
  };
}

async function insertOneVolumeEvent(
  client: PoolClient,
  input: VolumeEventInsertInput,
): Promise<string | null> {
  const multiplier = await resolveRewardsMultiplierAtEvent(client, {
    userId: input.userId,
    eventTime: input.createdAt,
  });
  const { rows } = await client.query<{ id: string }>(
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
        $1, $2, $3, $4, $5, $6, $7, null, $8, $9
      )
      on conflict (user_id, source_type, source_id) do nothing
      returning id
    `,
    [
      input.userId,
      input.walletAddress,
      input.venue,
      input.sourceType,
      input.sourceId,
      input.notionalUsd,
      multiplier.multiplierApplied,
      multiplier.multiplierSource,
      input.createdAt,
    ],
  );

  return rows[0]?.id ?? null;
}

export async function insertVolumeEventsWithMultiplier(
  pool: Pool,
  input: BatchInsertInput,
): Promise<{ inserted: number; ids: string[] }> {
  return tx(pool, async (client) =>
    insertVolumeEventsWithMultiplierInTx(client, input),
  );
}

export async function insertVolumeEventsWithMultiplierInTx(
  client: PoolClient,
  input: BatchInsertInput,
): Promise<{ inserted: number; ids: string[] }> {
  if (!input.events.length) return { inserted: 0, ids: [] };

  const sortedEvents = [...input.events].sort((a, b) => {
    const timeDelta = a.createdAt.getTime() - b.createdAt.getTime();
    if (timeDelta !== 0) return timeDelta;
    return a.sourceId.localeCompare(b.sourceId);
  });

  await acquireRewardsUserAdvisoryXactLock(client, input.userId);

  let inserted = 0;
  const ids: string[] = [];
  for (const event of sortedEvents) {
    if (!Number.isFinite(event.notionalUsd) || event.notionalUsd <= 0) {
      continue;
    }
    const insertedId = await insertOneVolumeEvent(client, {
      userId: input.userId,
      walletAddress: input.walletAddress,
      venue: input.venue,
      sourceType: input.sourceType,
      sourceId: event.sourceId,
      notionalUsd: event.notionalUsd,
      createdAt: event.createdAt,
    });
    if (insertedId) {
      inserted += 1;
      ids.push(insertedId);
    }
  }
  return { inserted, ids };
}
