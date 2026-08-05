import { randomUUID } from "node:crypto";

const MENU_INPUT_KEY_PREFIX = "tg:signal_bot:v1:menu_input";
const MENU_INPUT_TTL_SEC = 10 * 60;
const MENU_RENDER_KEY_PREFIX = "tg:signal_bot:v1:menu_render";
const MENU_RENDER_TTL_SEC = 10 * 60;
const MENU_RENDER_LOCK_KEY_PREFIX = "tg:signal_bot:v1:menu_render_lock";
const MENU_RENDER_LOCK_TTL_MS = 30_000;
const MENU_RENDER_LOCK_WAIT_MS = 31_000;
const RELEASE_MENU_RENDER_LOCK_SCRIPT = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

type MenuStateRedis = {
  del(key: string): Promise<unknown>;
  eval(
    script: string,
    options: { arguments: string[]; keys: string[] },
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options?: { EX?: number; NX?: boolean; PX?: number },
  ): Promise<unknown>;
};

export type SignalBotMenuRenderLockResult<T> =
  | Readonly<{ status: "completed"; value: T }>
  | Readonly<{ status: "superseded" }>
  | Readonly<{ status: "unavailable" }>;

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

function menuRenderKey(chatId: string, messageId: number): string {
  return `${MENU_RENDER_KEY_PREFIX}:${chatId}:${messageId}`;
}

function menuRenderLockKey(chatId: string, messageId: number): string {
  return `${MENU_RENDER_LOCK_KEY_PREFIX}:${chatId}:${messageId}`;
}

export async function withSignalBotMenuRenderLock<T>(input: {
  chatId: string;
  deliver: () => Promise<T>;
  isCurrent: () => Promise<boolean>;
  messageId: number;
  redis: Pick<MenuStateRedis, "eval" | "set">;
  waitMs?: number;
}): Promise<SignalBotMenuRenderLockResult<T>> {
  const owner = randomUUID();
  const key = menuRenderLockKey(input.chatId, input.messageId);
  const deadline = Date.now() + (input.waitMs ?? MENU_RENDER_LOCK_WAIT_MS);
  while (Date.now() <= deadline) {
    try {
      if (!(await input.isCurrent())) return { status: "superseded" };
      const acquired = await input.redis.set(key, owner, {
        NX: true,
        PX: MENU_RENDER_LOCK_TTL_MS,
      });
      if (acquired === "OK" || acquired === true) {
        try {
          if (!(await input.isCurrent())) return { status: "superseded" };
          return { status: "completed", value: await input.deliver() };
        } finally {
          await input.redis
            .eval(RELEASE_MENU_RENDER_LOCK_SCRIPT, {
              arguments: [owner],
              keys: [key],
            })
            .catch(() => undefined);
        }
      }
    } catch {
      return { status: "unavailable" };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return { status: "unavailable" };
}

export async function claimSignalBotMenuRender(input: {
  chatId: string;
  messageId: number;
  redis: Pick<MenuStateRedis, "set">;
  renderToken: string;
}): Promise<void> {
  await input.redis.set(
    menuRenderKey(input.chatId, input.messageId),
    input.renderToken,
    { EX: MENU_RENDER_TTL_SEC },
  );
}

export async function isSignalBotMenuRenderCurrent(input: {
  chatId: string;
  messageId: number;
  redis: Pick<MenuStateRedis, "get">;
  renderToken: string;
}): Promise<boolean> {
  return (
    (await input.redis.get(menuRenderKey(input.chatId, input.messageId))) ===
    input.renderToken
  );
}

export function createSignalBotMenuRenderGuard(input: {
  chatId: string;
  messageId: number;
  redis: Pick<MenuStateRedis, "get">;
  renderToken: string;
}): () => Promise<boolean> {
  return () => isSignalBotMenuRenderCurrent(input);
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
