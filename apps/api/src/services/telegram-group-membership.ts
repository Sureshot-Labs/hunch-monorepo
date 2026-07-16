import type { DbQuery } from "../db.js";

const CACHE_KEY_PREFIX = "tg:group_membership:v1";
const DEFAULT_CACHE_TTL_SECONDS = 60;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export type TelegramGroupMembershipState =
  | "member"
  | "not_member"
  | "telegram_not_linked"
  | "unavailable";

export type TelegramGroupMembershipUnavailableReason =
  | "database_error"
  | "invalid_configuration"
  | "invalid_telegram_identity"
  | "telegram_api_error"
  | "telegram_response_mismatch"
  | "telegram_timeout";

export type TelegramGroupMembershipResult = {
  cached: boolean;
  checkedAt: string;
  state: TelegramGroupMembershipState;
  unavailableReason?: TelegramGroupMembershipUnavailableReason;
};

export type TelegramGroupMembershipRedis = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
};

type TelegramChatMember = {
  is_member?: boolean;
  status?: string;
  user?: {
    id?: number | string;
  };
};

type TelegramApiResponse = {
  ok?: boolean;
  result?: TelegramChatMember;
};

type CachedMembership = {
  checkedAt: string;
  state: "member" | "not_member";
};

function unavailable(
  reason: TelegramGroupMembershipUnavailableReason,
  now: Date,
): TelegramGroupMembershipResult {
  return {
    cached: false,
    checkedAt: now.toISOString(),
    state: "unavailable",
    unavailableReason: reason,
  };
}

function isDigits(value: string): boolean {
  return /^\d+$/.test(value);
}

function readBotIdFromToken(token: string): string | null {
  const separatorIndex = token.indexOf(":");
  if (separatorIndex <= 0) return null;
  const botId = token.slice(0, separatorIndex);
  return isDigits(botId) ? botId : null;
}

function isValidChatId(chatId: string): boolean {
  return /^-\d+$/.test(chatId) || /^@[A-Za-z0-9_]{5,}$/.test(chatId);
}

function membershipCacheKey(chatId: string, telegramUserId: string): string {
  return `${CACHE_KEY_PREFIX}:${chatId}:${telegramUserId}`;
}

function parseCachedMembership(raw: string | null): CachedMembership | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedMembership>;
    if (parsed.state !== "member" && parsed.state !== "not_member") {
      return null;
    }
    if (
      typeof parsed.checkedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.checkedAt))
    ) {
      return null;
    }
    return {
      checkedAt: parsed.checkedAt,
      state: parsed.state,
    };
  } catch {
    return null;
  }
}

function normalizeTelegramUserId(value: unknown): string | null {
  if (typeof value === "string" && isDigits(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  return null;
}

export function normalizeTelegramChatMember(
  member: TelegramChatMember,
): "member" | "not_member" | null {
  switch (member.status) {
    case "creator":
    case "administrator":
    case "member":
      return "member";
    case "restricted":
      return typeof member.is_member === "boolean"
        ? member.is_member
          ? "member"
          : "not_member"
        : null;
    case "left":
    case "kicked":
      return "not_member";
    default:
      return null;
  }
}

async function readLinkedTelegramUserId(
  db: DbQuery,
  userId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ telegram_user_id: string }>(
    `SELECT telegram_user_id
       FROM user_telegram_accounts
      WHERE user_id = $1
      LIMIT 1`,
    [userId],
  );
  return rows[0]?.telegram_user_id?.trim() || null;
}

async function readCachedMembership(input: {
  chatId: string;
  redis: TelegramGroupMembershipRedis | null;
  telegramUserId: string;
}): Promise<CachedMembership | null> {
  if (!input.redis) return null;
  try {
    return parseCachedMembership(
      await input.redis.get(
        membershipCacheKey(input.chatId, input.telegramUserId),
      ),
    );
  } catch {
    return null;
  }
}

async function writeCachedMembership(input: {
  cacheTtlSeconds: number;
  chatId: string;
  membership: CachedMembership;
  redis: TelegramGroupMembershipRedis | null;
  telegramUserId: string;
}): Promise<void> {
  if (!input.redis) return;
  try {
    await input.redis.set(
      membershipCacheKey(input.chatId, input.telegramUserId),
      JSON.stringify(input.membership),
      { EX: input.cacheTtlSeconds },
    );
  } catch {
    // Membership remains available from Telegram when the cache is down.
  }
}

export async function checkTelegramGroupMembership(input: {
  botToken: string;
  cacheTtlSeconds?: number;
  chatId: string;
  db: DbQuery;
  expectedBotId: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  redis?: TelegramGroupMembershipRedis | null;
  requestTimeoutMs?: number;
  userId: string;
}): Promise<TelegramGroupMembershipResult> {
  const now = input.now ?? (() => new Date());

  let telegramUserId: string | null;
  try {
    telegramUserId = await readLinkedTelegramUserId(input.db, input.userId);
  } catch {
    return unavailable("database_error", now());
  }

  if (!telegramUserId) {
    return {
      cached: false,
      checkedAt: now().toISOString(),
      state: "telegram_not_linked",
    };
  }
  const telegramUserIdNumber = Number(telegramUserId);
  if (
    !isDigits(telegramUserId) ||
    !Number.isSafeInteger(telegramUserIdNumber) ||
    telegramUserIdNumber <= 0
  ) {
    return unavailable("invalid_telegram_identity", now());
  }

  const botToken = input.botToken.trim();
  const chatId = input.chatId.trim();
  const expectedBotId = input.expectedBotId.trim();
  if (
    !botToken ||
    !isValidChatId(chatId) ||
    !isDigits(expectedBotId) ||
    readBotIdFromToken(botToken) !== expectedBotId
  ) {
    return unavailable("invalid_configuration", now());
  }

  const redis = input.redis ?? null;
  const cached = await readCachedMembership({
    chatId,
    redis,
    telegramUserId,
  });
  if (cached) {
    return {
      cached: true,
      checkedAt: cached.checkedAt,
      state: cached.state,
    };
  }

  const controller = new AbortController();
  const requestTimeoutMs = Math.max(
    1,
    input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  let response: Response;
  let payload: TelegramApiResponse | null;
  try {
    response = await (input.fetchImpl ?? fetch)(
      `https://api.telegram.org/bot${botToken}/getChatMember`,
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          chat_id: chatId,
          user_id: telegramUserIdNumber,
        }),
        signal: controller.signal,
      },
    );
    payload = (await response
      .json()
      .catch(() => null)) as TelegramApiResponse | null;
  } catch {
    return unavailable(
      controller.signal.aborted ? "telegram_timeout" : "telegram_api_error",
      now(),
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok || payload?.ok !== true || !payload.result) {
    return unavailable("telegram_api_error", now());
  }

  const responseTelegramUserId = normalizeTelegramUserId(
    payload.result.user?.id,
  );
  if (responseTelegramUserId !== telegramUserId) {
    return unavailable("telegram_response_mismatch", now());
  }

  const state = normalizeTelegramChatMember(payload.result);
  if (!state) {
    return unavailable("telegram_response_mismatch", now());
  }

  const membership: CachedMembership = {
    checkedAt: now().toISOString(),
    state,
  };
  await writeCachedMembership({
    cacheTtlSeconds: Math.max(
      1,
      input.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS,
    ),
    chatId,
    membership,
    redis,
    telegramUserId,
  });
  return {
    cached: false,
    checkedAt: membership.checkedAt,
    state: membership.state,
  };
}
