export const SOLANA_SPONSOR_BUDGET_PREFIX = "funding:{relay-svm-sponsor}:v1:";
export const USER_SPONSORED_ACTIONS_PER_24H = 20;
export const APP_SPONSORED_ACTIONS_PER_24H = 1000;

/** Read-only eligibility hint. Execution still atomically reserves the budget. */
export async function solanaSponsorBudgetAvailable(
  redis: { get(key: string): Promise<string | null> } | null,
  userId: string,
) {
  if (!redis) return false;
  const [user, app] = await Promise.all([
    redis.get(`${SOLANA_SPONSOR_BUDGET_PREFIX}user:${userId}`),
    redis.get(`${SOLANA_SPONSOR_BUDGET_PREFIX}app`),
  ]);
  return (
    (user === null || /^\d+$/.test(user)) &&
    (app === null || /^\d+$/.test(app)) &&
    Number(user ?? 0) < USER_SPONSORED_ACTIONS_PER_24H &&
    Number(app ?? 0) < APP_SPONSORED_ACTIONS_PER_24H
  );
}
