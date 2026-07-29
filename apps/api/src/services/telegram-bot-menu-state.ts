const MENU_INPUT_KEY_PREFIX = "tg:signal_bot:v1:menu_input";
const MENU_INPUT_TTL_SEC = 10 * 60;

type MenuStateRedis = {
  del(key: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
};

export type SignalBotMenuInputState =
  | {
      kind: "awaiting_market_query";
      menuMessageId: number | null;
    }
  | {
      kind: "awaiting_rewards_code_attach" | "awaiting_rewards_code_change";
      menuMessageId: number | null;
    }
  | {
      code: string;
      currentCode: string | null;
      kind: "confirming_rewards_code_attach" | "confirming_rewards_code_change";
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
    const validKinds: SignalBotMenuInputState["kind"][] = [
      "awaiting_market_query",
      "awaiting_rewards_code_attach",
      "awaiting_rewards_code_change",
      "confirming_rewards_code_attach",
      "confirming_rewards_code_change",
    ];
    if (!validKinds.includes(parsed.kind as SignalBotMenuInputState["kind"])) {
      return null;
    }
    const isConfirmation =
      parsed.kind === "confirming_rewards_code_attach" ||
      parsed.kind === "confirming_rewards_code_change";
    if (
      isConfirmation &&
      (typeof (parsed as { code?: unknown }).code !== "string" ||
        !(parsed as { code: string }).code)
    ) {
      return null;
    }
    return {
      ...(isConfirmation
        ? {
            code: (parsed as { code: string }).code,
            currentCode:
              typeof (parsed as { currentCode?: unknown }).currentCode ===
              "string"
                ? (parsed as { currentCode: string }).currentCode
                : null,
          }
        : {}),
      kind: parsed.kind as SignalBotMenuInputState["kind"],
      menuMessageId:
        typeof parsed.menuMessageId === "number" ? parsed.menuMessageId : null,
    } as SignalBotMenuInputState;
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

export async function writeSignalBotRewardsMenuInput(input: {
  chatId: string;
  state:
    | {
        action: "attach" | "change";
        kind: "awaiting";
        menuMessageId: number | null;
      }
    | {
        action: "attach" | "change";
        code: string;
        currentCode?: string | null;
        kind: "confirming";
        menuMessageId: number | null;
      };
  redis: Pick<MenuStateRedis, "set">;
  telegramUserId: number;
}): Promise<void> {
  const state: SignalBotMenuInputState =
    input.state.kind === "awaiting"
      ? {
          kind:
            input.state.action === "change"
              ? "awaiting_rewards_code_change"
              : "awaiting_rewards_code_attach",
          menuMessageId: input.state.menuMessageId,
        }
      : {
          code: input.state.code,
          currentCode: input.state.currentCode ?? null,
          kind:
            input.state.action === "change"
              ? "confirming_rewards_code_change"
              : "confirming_rewards_code_attach",
          menuMessageId: input.state.menuMessageId,
        };
  await input.redis.set(
    menuInputKey(input.chatId, input.telegramUserId),
    JSON.stringify(state),
    { EX: MENU_INPUT_TTL_SEC },
  );
}
