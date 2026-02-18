import type { PoolClient } from "pg";

const REWARDS_USER_LOCK_PREFIX = "lock:rewards:user:";

function normalizeUserLockKey(userId: string): string {
  return `${REWARDS_USER_LOCK_PREFIX}${userId.trim().toLowerCase()}`;
}

export async function acquireRewardsUserAdvisoryXactLock(
  client: PoolClient,
  userId: string,
): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [
    normalizeUserLockKey(userId),
  ]);
}

export async function withRewardsUserAdvisoryXactLock<T>(
  client: PoolClient,
  userId: string,
  run: () => Promise<T>,
): Promise<T> {
  await acquireRewardsUserAdvisoryXactLock(client, userId);
  return run();
}
