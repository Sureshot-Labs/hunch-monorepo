import type { Pool, PoolClient } from "@hunch/infra";

const REWARDS_CHAIN_LOCK_PREFIX = "lock:rewards:chain:";

function normalizeLockTargets(chainIds: string[]): string[] {
  const unique = new Set<string>();
  for (const chainId of chainIds) {
    const normalized = chainId.trim().toLowerCase();
    if (!normalized) continue;
    unique.add(normalized);
  }
  return [...unique].sort((a, b) => a.localeCompare(b));
}

async function tryAcquireLock(
  client: PoolClient,
  lockKey: string,
): Promise<void> {
  const { rows } = await client.query<{ locked: boolean }>(
    "select pg_try_advisory_lock(hashtext($1)::bigint) as locked",
    [lockKey],
  );
  if (rows[0]?.locked) return;
  throw new Error(`failed to acquire advisory lock: ${lockKey}`);
}

async function releaseLock(client: PoolClient, lockKey: string): Promise<void> {
  await client.query("select pg_advisory_unlock(hashtext($1)::bigint)", [
    lockKey,
  ]);
}

export async function withRewardsChainLocks<T>(
  pool: Pool,
  chainIds: string[],
  run: () => Promise<T>,
): Promise<T> {
  const targets = normalizeLockTargets(chainIds);
  if (!targets.length) return run();

  const client = await pool.connect();
  const lockKeys = targets.map(
    (chainId) => `${REWARDS_CHAIN_LOCK_PREFIX}${chainId}`,
  );
  try {
    for (const lockKey of lockKeys) {
      await tryAcquireLock(client, lockKey);
    }
    return await run();
  } finally {
    for (const lockKey of [...lockKeys].reverse()) {
      try {
        await releaseLock(client, lockKey);
      } catch (error) {
        console.error("[rewards-lock] unlock failed", { lockKey, error });
      }
    }
    client.release();
  }
}
