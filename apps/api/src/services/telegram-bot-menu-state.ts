import { randomUUID } from "node:crypto";

const MENU_INPUT_KEY_PREFIX = "tg:signal_bot:v1:menu_input";
const MENU_INPUT_TTL_SEC = 10 * 60;
const MENU_RENDER_KEY_PREFIX = "tg:signal_bot:v1:menu_render";
const MENU_RENDER_TTL_SEC = 10 * 60;
const MENU_RENDER_LOCK_KEY_PREFIX = "tg:signal_bot:v1:menu_render_lock";
const MENU_RENDER_LOCK_TTL_MS = 30_000;
const MENU_RENDER_LOCK_WAIT_MS = 31_000;
const EXACT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELEASE_MENU_RENDER_LOCK_SCRIPT = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;
const CLEAR_CURRENT_MENU_INPUT_SCRIPT = `
  local raw = redis.call('GET', KEYS[1])
  if not raw then return 0 end
  local ok, state = pcall(cjson.decode, raw)
  if ok and state['stateToken'] == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

export type SignalBotMenuStateRedis = {
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

type MenuStateRedis = SignalBotMenuStateRedis;

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
    }
  | {
      action: "buy" | "sell";
      contextId: string;
      expiresAt: string;
      kind: "awaiting_custom_buy_amount" | "awaiting_custom_sell_amount";
      menuMessageId: number | null;
      stateToken: string;
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

export async function clearSignalBotMenuInputIfCurrent(input: {
  chatId: string;
  redis: Pick<MenuStateRedis, "eval">;
  stateToken: string;
  telegramUserId: number;
}): Promise<boolean> {
  const cleared = await input.redis.eval(CLEAR_CURRENT_MENU_INPUT_SCRIPT, {
    arguments: [input.stateToken],
    keys: [menuInputKey(input.chatId, input.telegramUserId)],
  });
  return cleared === 1 || cleared === "1";
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
      "awaiting_custom_buy_amount",
      "awaiting_custom_sell_amount",
    ];
    if (!validKinds.includes(parsed.kind as SignalBotMenuInputState["kind"])) {
      return null;
    }
    const isConfirmation =
      parsed.kind === "confirming_rewards_code_attach" ||
      parsed.kind === "confirming_rewards_code_change";
    const isTradeInput =
      parsed.kind === "awaiting_custom_buy_amount" ||
      parsed.kind === "awaiting_custom_sell_amount";
    if (
      isConfirmation &&
      (typeof (parsed as { code?: unknown }).code !== "string" ||
        !(parsed as { code: string }).code)
    ) {
      return null;
    }
    if (
      isTradeInput &&
      (typeof (parsed as { contextId?: unknown }).contextId !== "string" ||
        typeof (parsed as { stateToken?: unknown }).stateToken !== "string" ||
        !EXACT_UUID_RE.test((parsed as { contextId: string }).contextId) ||
        !EXACT_UUID_RE.test((parsed as { stateToken: string }).stateToken) ||
        typeof (parsed as { expiresAt?: unknown }).expiresAt !== "string" ||
        !Number.isFinite(
          Date.parse((parsed as { expiresAt: string }).expiresAt),
        ) ||
        Date.parse((parsed as { expiresAt: string }).expiresAt) <= Date.now())
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
      ...(isTradeInput
        ? {
            action:
              parsed.kind === "awaiting_custom_sell_amount" ? "sell" : "buy",
            contextId: (parsed as { contextId: string }).contextId,
            expiresAt: (parsed as { expiresAt: string }).expiresAt,
            stateToken: (parsed as { stateToken: string }).stateToken,
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

export async function writeSignalBotTradeMenuInput(input: {
  action: "buy" | "sell";
  chatId: string;
  contextId: string;
  expiresAt: string;
  menuMessageId: number;
  redis: Pick<MenuStateRedis, "set">;
  telegramUserId: number;
}): Promise<{ stateToken: string } | null> {
  const ttlSec = Math.ceil((Date.parse(input.expiresAt) - Date.now()) / 1_000);
  if (ttlSec <= 0) return null;
  const stateToken = randomUUID();
  const state: SignalBotMenuInputState = {
    action: input.action,
    contextId: input.contextId,
    expiresAt: input.expiresAt,
    kind:
      input.action === "sell"
        ? "awaiting_custom_sell_amount"
        : "awaiting_custom_buy_amount",
    menuMessageId: input.menuMessageId,
    stateToken,
  };
  await input.redis.set(
    menuInputKey(input.chatId, input.telegramUserId),
    JSON.stringify(state),
    { EX: Math.min(MENU_INPUT_TTL_SEC, ttlSec) },
  );
  return { stateToken };
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
