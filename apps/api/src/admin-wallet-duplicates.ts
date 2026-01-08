#!/usr/bin/env tsx

import { pool } from "./db.js";
import { mergeUsersById } from "./admin-merge-user-core.js";

type ScriptOptions = {
  apply: boolean;
  dryRun: boolean;
  limit?: number;
};

type DuplicateGroup = {
  wallet_type: string;
  wallet_norm: string;
  user_ids: string[];
};

type UserStats = {
  id: string;
  is_admin: boolean;
  last_login_at: Date | null;
  orders: number;
  executions: number;
  positions: number;
  fee_events: number;
  volume_events: number;
  reward_claims: number;
  bridge_orders: number;
};

type MergePlan = {
  walletType: string;
  walletNorm: string;
  targetId: string;
  sourceIds: string[];
  users: Array<UserStats & { score: number }>;
};

function parseArgs(): ScriptOptions {
  const args = process.argv.slice(2);
  const getValue = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx === -1) return undefined;
    const next = args[idx + 1];
    return next && !next.startsWith("--") ? next : undefined;
  };
  const hasFlag = (flag: string): boolean => args.includes(flag);

  const limitRaw = getValue("--limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;

  return {
    apply: hasFlag("--apply"),
    dryRun: hasFlag("--dry-run"),
    limit: Number.isFinite(limit) ? limit : undefined,
  };
}

function scoreUser(row: UserStats): number {
  const base =
    row.orders +
    row.executions +
    row.positions +
    row.fee_events +
    row.volume_events +
    row.reward_claims +
    row.bridge_orders;
  return base + (row.is_admin ? 1_000_000 : 0);
}

async function fetchDuplicateGroups(limit?: number): Promise<DuplicateGroup[]> {
  const { rows } = await pool.query<DuplicateGroup>(
    `
      select
        wallet_type,
        case
          when wallet_type = 'solana' then wallet_address
          else lower(wallet_address)
        end as wallet_norm,
        array_agg(distinct user_id) as user_ids
      from user_wallets
      group by wallet_type, wallet_norm
      having count(distinct user_id) > 1
      order by wallet_type, wallet_norm
    `,
  );

  if (limit && limit > 0) return rows.slice(0, limit);
  return rows;
}

async function fetchUserStats(userIds: string[]): Promise<UserStats[]> {
  const { rows } = await pool.query<UserStats>(
    `
      select
        u.id,
        u.is_admin,
        u.last_login_at,
        (select count(*) from orders where user_id = u.id) as orders,
        (select count(*) from executions where user_id = u.id) as executions,
        (select count(*) from positions where user_id = u.id) as positions,
        (select count(*) from fee_events where user_id = u.id) as fee_events,
        (select count(*) from volume_events where user_id = u.id) as volume_events,
        (select count(*) from reward_claims where user_id = u.id) as reward_claims,
        (select count(*) from bridge_orders where user_id = u.id) as bridge_orders
      from users u
      where u.id = any($1::uuid[])
    `,
    [userIds],
  );
  return rows.map((row) => ({
    ...row,
    orders: Number(row.orders),
    executions: Number(row.executions),
    positions: Number(row.positions),
    fee_events: Number(row.fee_events),
    volume_events: Number(row.volume_events),
    reward_claims: Number(row.reward_claims),
    bridge_orders: Number(row.bridge_orders),
  }));
}

function pickTarget(users: Array<UserStats & { score: number }>): string {
  const sorted = [...users].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.is_admin !== b.is_admin) return a.is_admin ? -1 : 1;
    const aLogin = a.last_login_at?.getTime() ?? 0;
    const bLogin = b.last_login_at?.getTime() ?? 0;
    if (bLogin !== aLogin) return bLogin - aLogin;
    return a.id.localeCompare(b.id);
  });
  return sorted[0].id;
}

function validateMergePlan(plans: MergePlan[]) {
  const targetSet = new Set<string>();
  const sourceSet = new Set<string>();

  for (const plan of plans) {
    if (sourceSet.has(plan.targetId)) {
      throw new Error(
        `Merge conflict: target ${plan.targetId} is already a source in another group`,
      );
    }

    targetSet.add(plan.targetId);

    for (const sourceId of plan.sourceIds) {
      if (targetSet.has(sourceId)) {
        throw new Error(
          `Merge conflict: source ${sourceId} is already a target in another group`,
        );
      }
      sourceSet.add(sourceId);
    }
  }
}

async function main() {
  const options = parseArgs();
  const groups = await fetchDuplicateGroups(options.limit);

  if (groups.length === 0) {
    console.log(JSON.stringify({ ok: true, duplicates: 0 }, null, 2));
    return;
  }

  const plans: MergePlan[] = [];

  for (const group of groups) {
    const stats = await fetchUserStats(group.user_ids);
    const usersWithScore = stats.map((row) => ({
      ...row,
      score: scoreUser(row),
    }));
    const targetId = pickTarget(usersWithScore);
    const sourceIds = usersWithScore
      .map((row) => row.id)
      .filter((id) => id !== targetId);

    plans.push({
      walletType: group.wallet_type,
      walletNorm: group.wallet_norm,
      targetId,
      sourceIds,
      users: usersWithScore,
    });
  }

  validateMergePlan(plans);

  const results: Array<{
    sourceId: string;
    targetId: string;
    summary: unknown;
    dryRun: boolean;
  }> = [];

  if (options.apply) {
    for (const plan of plans) {
      for (const sourceId of plan.sourceIds) {
        const result = await mergeUsersById(sourceId, plan.targetId, {
          dryRun: options.dryRun,
          keepSource: false,
        });
        results.push({
          sourceId,
          targetId: plan.targetId,
          summary: result.summary,
          dryRun: result.dryRun,
        });
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        duplicates: plans.length,
        apply: options.apply,
        dryRun: options.dryRun,
        plans,
        results,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
