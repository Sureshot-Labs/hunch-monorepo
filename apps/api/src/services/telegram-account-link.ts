import type { DbQuery } from "../db.js";

export type ActiveTelegramAccountLink = Readonly<{
  linkId: string;
  userId: string;
}>;

export async function resolveActiveTelegramAccountLink(input: {
  db: DbQuery;
  telegramUserId: string | number;
}): Promise<ActiveTelegramAccountLink | null> {
  const { rows } = await input.db.query<{
    id?: string;
    link_id: string;
    user_id: string;
  }>(
    `select uta.id::text as link_id, uta.user_id::text as user_id
       from user_telegram_accounts uta
       join users u on u.id = uta.user_id
      where uta.telegram_user_id = $1
        and coalesce(u.is_active, true) = true
      limit 2`,
    [String(input.telegramUserId)],
  );
  const row = rows[0];
  const linkId = row?.link_id ?? row?.id;
  if (rows.length !== 1 || !linkId || !row?.user_id) return null;
  return { linkId, userId: row.user_id };
}

export function sameActiveTelegramAccountLink(
  left: ActiveTelegramAccountLink | null,
  right: ActiveTelegramAccountLink | null,
): boolean {
  return (
    left != null &&
    right != null &&
    left.linkId === right.linkId &&
    left.userId === right.userId
  );
}
