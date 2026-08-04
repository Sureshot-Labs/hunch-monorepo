import type { DbQuery } from "../db.js";
import { resolveActiveTelegramAccountLink } from "./telegram-account-link.js";

export type TelegramBotMenuAudience = "guest" | "linked" | "unavailable";

export async function resolveTelegramBotMenuAudience(input: {
  db?: DbQuery;
  telegramUserId: string | number | null | undefined;
}): Promise<TelegramBotMenuAudience> {
  if (!input.db || input.telegramUserId == null) return "unavailable";
  try {
    return (await resolveActiveTelegramAccountLink({
      db: input.db,
      telegramUserId: input.telegramUserId,
    }))
      ? "linked"
      : "guest";
  } catch {
    return "unavailable";
  }
}
