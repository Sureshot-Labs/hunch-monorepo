const MENU_INPUT_KEY_PREFIX = "tg:signal_bot:v1:menu_input";
const MENU_INPUT_TTL_SEC = 10 * 60;

type MenuStateRedis = {
  del(key: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
};

export type SignalBotMenuInputState = {
  kind: "awaiting_market_query";
  menuMessageId: number | null;
};

function menuInputKey(chatId: string, telegramUserId: number): string {
  return `${MENU_INPUT_KEY_PREFIX}:${chatId}:${telegramUserId}`;
}

export async function clearSignalBotMenuInput(input: {
  chatId: string;
  redis: Pick<MenuStateRedis, "del">;
  telegramUserId: number | null | undefined;
}): Promise<void> {
  if (!input.telegramUserId) return;
  await input.redis.del(menuInputKey(input.chatId, input.telegramUserId));
}

export async function readSignalBotMenuInput(input: {
  chatId: string;
  redis: Pick<MenuStateRedis, "get">;
  telegramUserId: number;
}): Promise<SignalBotMenuInputState | null> {
  const raw = await input.redis.get(
    menuInputKey(input.chatId, input.telegramUserId),
  );
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SignalBotMenuInputState>;
    if (parsed.kind !== "awaiting_market_query") return null;
    return {
      kind: parsed.kind,
      menuMessageId:
        typeof parsed.menuMessageId === "number" ? parsed.menuMessageId : null,
    };
  } catch {
    return null;
  }
}

export async function writeSignalBotMenuInput(input: {
  chatId: string;
  menuMessageId: number | null;
  redis: Pick<MenuStateRedis, "set">;
  telegramUserId: number;
}): Promise<void> {
  const state: SignalBotMenuInputState = {
    kind: "awaiting_market_query",
    menuMessageId: input.menuMessageId,
  };
  await input.redis.set(
    menuInputKey(input.chatId, input.telegramUserId),
    JSON.stringify(state),
    { EX: MENU_INPUT_TTL_SEC },
  );
}
