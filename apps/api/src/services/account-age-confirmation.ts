import type { DbQuery } from "../db.js";

export const CONFIRM_ADULT_SQL = `update users
  set adult_confirmed_at = coalesce(adult_confirmed_at, now()), adult_confirmation_version = 1
  where id = $1 and is_active = true returning adult_confirmed_at`;

export async function confirmAdultAccount(
  db: DbQuery,
  userId: string,
): Promise<Date | null> {
  const result = await db.query<{ adult_confirmed_at: Date }>(
    CONFIRM_ADULT_SQL,
    [userId],
  );
  return result.rows[0]?.adult_confirmed_at ?? null;
}
