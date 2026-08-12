import type { PoolClient } from "@hunch/infra";

function lifecycleLockKey(userId: string): string {
  return `telegram-funding-link-lifecycle:${userId}`;
}

export async function lockTelegramFundingLinkLifecycle(
  client: Pick<PoolClient, "query">,
  userId: string,
): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    lifecycleLockKey(userId),
  ]);
}
