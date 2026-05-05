import { tx } from "@hunch/infra";
import type { Pool, PoolClient } from "pg";
import { acquireRewardsUserAdvisoryXactLock } from "../lib/rewards-user-lock.js";

type MultiplierQueryable = Pick<PoolClient, "query">;

export type RewardsMultiplierSource = "global" | "user" | "referral" | "tier";

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

const OBSERVER_THRESHOLD = 500;

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

async function fetchPointsAtEvent(
  client: MultiplierQueryable,
  userId: string,
  eventTime: Date,
): Promise<number> {
  const { rows } = await client.query<{ total: string | null }>(
    `
      select coalesce(sum(points_awarded), 0)::text as total
      from volume_events
      where user_id = $1
        and created_at <= $2
    `,
    [userId, eventTime],
  );
  return Number(rows[0]?.total ?? 0);
}

async function fetchQualifiedReferralCountAtEvent(
  client: MultiplierQueryable,
  userId: string,
  eventTime: Date,
  referrerPointsAtEvent: number,
): Promise<number> {
  if (referrerPointsAtEvent < OBSERVER_THRESHOLD) {
    return 0;
  }

  const { rows } = await client.query<{ total: string | null }>(
    `
      with referred_points as (
        select
          user_id,
          coalesce(sum(points_awarded), 0)::numeric as points
        from volume_events
        where created_at <= $2
        group by user_id
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
    [userId, eventTime, OBSERVER_THRESHOLD],
  );
  return Number(rows[0]?.total ?? 0);
}

async function fetchUserOverrideMultiplier(
  client: MultiplierQueryable,
  userId: string,
  eventTime: Date,
): Promise<number | null> {
  const { rows } = await client.query<{ multiplier: string | null }>(
    `
      select multiplier::text as multiplier
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
  return parsed;
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
      multiplierApplied: overrideMultiplier,
      multiplierSource: "user",
    };
  }

  const policyRows = await client.query<{
    global_multiplier: string | null;
    referral_rules: unknown;
    tier_rules: unknown;
  }>(
    `
      select
        global_multiplier::text as global_multiplier,
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
  const pointsAtEvent = await fetchPointsAtEvent(
    client,
    inputs.userId,
    inputs.eventTime,
  );
  const qualifiedReferrals = await fetchQualifiedReferralCountAtEvent(
    client,
    inputs.userId,
    inputs.eventTime,
    pointsAtEvent,
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
    pointsAtEvent,
    ["minPoints", "min_points"],
  );

  const isAllEqual =
    Math.abs(globalMultiplier - referralMultiplier) < 1e-12 &&
    Math.abs(globalMultiplier - tierMultiplier) < 1e-12;
  if (isAllEqual) {
    return {
      multiplierApplied: globalMultiplier,
      multiplierSource: "global",
    };
  }

  const maxMultiplier = Math.max(
    globalMultiplier,
    referralMultiplier,
    tierMultiplier,
  );
  if (Math.abs(referralMultiplier - maxMultiplier) < 1e-12) {
    return {
      multiplierApplied: referralMultiplier,
      multiplierSource: "referral",
    };
  }
  if (Math.abs(tierMultiplier - maxMultiplier) < 1e-12) {
    return {
      multiplierApplied: tierMultiplier,
      multiplierSource: "tier",
    };
  }
  return {
    multiplierApplied: globalMultiplier,
    multiplierSource: "global",
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
  if (!input.events.length) return { inserted: 0, ids: [] };

  const sortedEvents = [...input.events].sort((a, b) => {
    const timeDelta = a.createdAt.getTime() - b.createdAt.getTime();
    if (timeDelta !== 0) return timeDelta;
    return a.sourceId.localeCompare(b.sourceId);
  });

  return tx(pool, async (client) => {
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
  });
}
