import type { DbQuery } from "../db.js";

export type TelegramBotMenuAudience = "guest" | "linked" | "unavailable";

export async function resolveTelegramBotMenuAudience(input: {
  db?: DbQuery;
  telegramUserId: string | number | null | undefined;
}): Promise<TelegramBotMenuAudience> {
  if (!input.db || input.telegramUserId == null) return "unavailable";
  try {
    const { rows } = await input.db.query<{ linked: boolean }>(
      `select exists (
         select 1
           from user_telegram_accounts uta
           join users u on u.id = uta.user_id
          where uta.telegram_user_id = $1
            and coalesce(u.is_active, true) = true
       ) as linked`,
      [String(input.telegramUserId)],
    );
    return rows[0]?.linked === true ? "linked" : "guest";
  } catch {
    return "unavailable";
  }
}
